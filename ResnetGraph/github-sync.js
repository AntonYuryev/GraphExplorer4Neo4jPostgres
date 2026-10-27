/**
 * github-sync.js — sync ResnetGraph/ElsevierAPI with the ElsevierAPI folder of
 *   https://github.com/AntonYuryev/ElsevierAPI_Project  (branch main)
 *
 * Run from inside the ResnetGraph folder (token is read from the environment,
 * never stored in this file):
 *
 *   GITHUB_TOKEN=ghp_xxx node github-sync.js upload   [--dry-run]
 *   GITHUB_TOKEN=ghp_xxx node github-sync.js download [--dry-run] [--all] [--missing] [--force] [file ...]
 *
 *   e.g. fetch just two modules you're missing, without touching anything else:
 *   node github-sync.js download --missing api/ResnetAPI/RefStats.py api/ResnetAPI/rnef2sbgn.py
 *
 *   (PowerShell:  $env:GITHUB_TOKEN="ghp_xxx"; node github-sync.js upload)
 *
 * upload    Pushes every file under ./ElsevierAPI to ElsevierAPI/<same path> in
 *           the repo. Files whose content already matches GitHub are skipped
 *           (compared by git blob SHA), so only real changes become commits.
 *
 * download  Pulls files from GitHub into ./ElsevierAPI, overwriting local copies.
 *           By default ONLY files that already exist locally are refreshed (the
 *           local folder is a deliberate subset of the full project); --missing creates
 *           ONLY the files that don't exist locally yet (e.g. a module your code imports
 *           but you haven't downloaded) and never overwrites or even touches existing
 *           files, so it is safe to run with uncommitted changes; --all also
 *           brings down every other file under ElsevierAPI/ in the repo.
 *           Refuses to run while ./ElsevierAPI has uncommitted changes in the
 *           local git repo (commit them first with GIT_FAST commit "msg"), unless
 *           --force is given — otherwise the download would silently overwrite
 *           unsaved work.
 *
 * Override target with env vars: GH_OWNER, GH_REPO, GH_BRANCH, GH_REMOTE_DIR.
 * Files never synced: __pycache__, *.pyc/*.pyo/*.pyd, .git, .DS_Store, Thumbs.db.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const OWNER      = process.env.GH_OWNER      || 'AntonYuryev';
const REPO       = process.env.GH_REPO       || 'ElsevierAPI_Project';
const BRANCH     = process.env.GH_BRANCH     || 'main';
const REMOTE_DIR = (process.env.GH_REMOTE_DIR || 'ElsevierAPI').replace(/^\/+|\/+$/g, '');
const LOCAL_DIR  = path.join(__dirname, 'ElsevierAPI');

const mode    = process.argv[2];
const flags   = new Set(process.argv.slice(3));
const DRY_RUN = flags.has('--dry-run');
const ALL     = flags.has('--all');
const ONLY    = new Set(process.argv.slice(3).filter(a => !a.startsWith('--')).map(a => a.split('\\').join('/').replace(/^ElsevierAPI\//, '')));  // optional explicit file list (paths relative to ElsevierAPI/)
const MISSING = flags.has('--missing');   // create files that don't exist locally; never overwrite anything
const FORCE   = flags.has('--force');
// Token: GITHUB_TOKEN environment variable, else the one-line file GithubToken.txt (gitignored) — never stored in this file.
function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  for (const dir of [__dirname, path.join(__dirname, '..')]) {
    try { const t = fs.readFileSync(path.join(dir, 'GithubToken.txt'), 'utf8').trim(); if (t) return t; } catch (e) { /* try the next folder */ }
  }
  return '';
}
const TOKEN = readToken();

if (mode !== 'upload' && mode !== 'download') {
  console.error('Usage: node github-sync.js <upload|download> [--dry-run] [--all] [--missing] [--force]');
  process.exit(1);
}
if (!TOKEN && !(DRY_RUN && mode === 'upload')) {
  console.error('No GitHub token found: set GITHUB_TOKEN or put the token in GithubToken.txt (in this folder or its parent).');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const SKIP_DIRS  = new Set(['__pycache__', '.git', 'node_modules', '.ipynb_checkpoints']);
const SKIP_FILES = /(\.py[cod]|\.pyo|\.pyd|^\.DS_Store|^Thumbs\.db)$/i;

function listLocalFiles(dir, rel = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...listLocalFiles(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name));
    } else if (!SKIP_FILES.test(e.name)) {
      out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return out;
}

// Local files are CRLF on Windows (git autocrlf=true) while GitHub stores LF.
// Compare/upload the LF form so identical files aren't reported as changed and
// an upload never rewrites a file's line endings in the repo; downloads are
// converted back to CRLF when the local copy uses it. Binary data is untouched.
function isBinary(buf) { return buf.includes(0); }
function toLF(buf) {
  return isBinary(buf) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}
function toCRLF(buf) {
  return isBinary(buf) ? buf : Buffer.from(buf.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
}
function usesCRLF(buf) { return !isBinary(buf) && buf.includes(Buffer.from('\r\n')); }

// git's blob object id: sha1("blob <size>\0" + bytes) — lets us tell whether a
// local file already equals the one on GitHub without downloading it.
function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: apiPath, method,
      headers: {
        'Authorization': `token ${TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ResnetGraph-GitHub-Sync',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// path -> blob sha for every file under REMOTE_DIR/ on the branch.
async function fetchRemoteTree() {
  const res = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${encodeURIComponent(BRANCH)}?recursive=1`);
  if (res.status !== 200) {
    throw new Error(`Cannot read ${OWNER}/${REPO}@${BRANCH} (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  if (res.body.truncated) console.warn('WARNING: repo tree listing was truncated by GitHub — some remote files may be missing from this run.');
  const prefix = REMOTE_DIR + '/';
  const map = new Map();
  for (const n of res.body.tree) {
    if (n.type === 'blob' && n.path.startsWith(prefix)) map.set(n.path.slice(prefix.length), n.sha);
  }
  return map;
}

// ── upload ────────────────────────────────────────────────────────────────────
async function upload() {
  const files = listLocalFiles(LOCAL_DIR);
  console.log(`Local files under ElsevierAPI: ${files.length}`);
  let remote = new Map();
  if (TOKEN) remote = await fetchRemoteTree();
  else console.log('(no token — dry run only lists local files)');

  let uploaded = 0, skipped = 0, failed = 0;
  for (const rel of files) {
    const buf = toLF(fs.readFileSync(path.join(LOCAL_DIR, rel)));
    const localSha = gitBlobSha(buf);
    const remoteSha = remote.get(rel);
    if (remoteSha === localSha) { skipped++; continue; }

    const action = remoteSha ? 'update' : 'add';
    if (DRY_RUN) { console.log(`  [dry-run] would ${action} ${rel}`); uploaded++; continue; }

    const res = await api('PUT',
      `/repos/${OWNER}/${REPO}/contents/${REMOTE_DIR}/${rel.split('/').map(encodeURIComponent).join('/')}`,
      { message: `${action === 'add' ? 'Add' : 'Update'} ${REMOTE_DIR}/${rel}`,
        content: buf.toString('base64'), branch: BRANCH, ...(remoteSha ? { sha: remoteSha } : {}) });
    if (res.status === 200 || res.status === 201) { console.log(`  ✓ ${action} ${rel}`); uploaded++; }
    else { console.error(`  ✗ ${rel}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`); failed++; }
  }
  console.log(`\nDone: ${uploaded} ${DRY_RUN ? 'would change' : 'uploaded'}, ${skipped} unchanged, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

// ── download ──────────────────────────────────────────────────────────────────
function localTreeIsDirty() {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', 'ElsevierAPI'],
      { cwd: __dirname, encoding: 'utf8' });
    return out.trim() ? out.trim().split('\n') : [];
  } catch (e) {
    return [];   // no git / not a repo — nothing to protect
  }
}

async function download() {
  const dirty = localTreeIsDirty();
  if (dirty.length && !FORCE && !DRY_RUN && !MISSING) {
    console.error('Refusing to download: ElsevierAPI has uncommitted local changes that would be overwritten:\n');
    dirty.slice(0, 15).forEach(l => console.error('  ' + l));
    if (dirty.length > 15) console.error(`  … and ${dirty.length - 15} more`);
    console.error('\nCommit them first (GIT_FAST commit "message"), or re-run with --force to overwrite anyway.');
    process.exit(2);
  }

  const remote = await fetchRemoteTree();
  const localSet = new Set(listLocalFiles(LOCAL_DIR));
  const targets = [...remote.keys()].filter(rel => {
    if (SKIP_FILES.test(path.basename(rel))) return false;
    if (ONLY.size) return ONLY.has(rel) && (!MISSING || !localSet.has(rel));   // explicit files only
    if (MISSING) return !localSet.has(rel);        // create-only
    return ALL || localSet.has(rel);
  });
  const missingRemote = [...localSet].filter(rel => !remote.has(rel));
  console.log(`Remote files: ${remote.size}; to consider: ${targets.length}${ALL ? ' (--all)' : ' (files that exist locally)'}`);
  if (missingRemote.length) console.log(`Local-only files (not on GitHub, left untouched): ${missingRemote.length}`);

  let downloaded = 0, skipped = 0, failed = 0;
  for (const rel of targets) {
    const dest = path.join(LOCAL_DIR, rel);
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    if (existing && gitBlobSha(toLF(existing)) === remote.get(rel)) { skipped++; continue; }
    if (DRY_RUN) { console.log(`  [dry-run] would ${fs.existsSync(dest) ? 'overwrite' : 'create'} ${rel}`); downloaded++; continue; }

    const res = await api('GET', `/repos/${OWNER}/${REPO}/git/blobs/${remote.get(rel)}`);
    if (res.status !== 200 || !res.body.content) {
      console.error(`  ✗ ${rel}: HTTP ${res.status}`); failed++; continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let outBuf = Buffer.from(res.body.content, 'base64');
    // keep the local convention: CRLF if the file it replaces used CRLF (or, for a
    // new file, on Windows where git autocrlf would check it out that way)
    if (existing ? usesCRLF(existing) : process.platform === 'win32') outBuf = toCRLF(outBuf);
    fs.writeFileSync(dest, outBuf);
    console.log(`  ✓ ${rel}`); downloaded++;
  }
  console.log(`\nDone: ${downloaded} ${DRY_RUN ? 'would change' : 'downloaded'}, ${skipped} already up to date, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

(mode === 'upload' ? upload() : download()).catch(err => { console.error('Fatal:', err.message); process.exit(1); });
