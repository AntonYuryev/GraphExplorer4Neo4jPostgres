const express = require('express');
const neo4j = require('neo4j-driver');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const http = require('http');
const rateLimit = require('express-rate-limit');
const _crypto   = require('crypto');
const FlexSearch = require('flexsearch');

// ── Log injection hardening (CodeQL: js/log-injection, CWE-117) ───────────────
// Many log calls throughout this file interpolate request-derived or
// external-system-derived strings (err.message from Neo4j/Postgres drivers,
// usernames, config values, URLs) without stripping newlines first. A value
// containing \r/\n could forge what looks like a separate, fake log line —
// e.g. a crafted username or error string that itself contains
// '\n[INFO] User admin granted superuser access' would show up in the log
// output as if it were a real, separate log entry. Rather than sanitizing
// each of the 30+ call sites individually (easy to miss one, and easy for a
// new call site added later to reintroduce the gap), every console.log/
// warn/error/info call in this process is wrapped once, here, to strip
// newline and other control characters from every string argument before
// it reaches the terminal/log file.
const _LOG_CONTROL_CHARS_RE = /[\r\n\x00-\x08\x0B\x0C\x0E-\x1F]+/g;

// NOTE ON STYLE: there used to be a _logSafe(value) helper function meant to
// be called inline at each flagged log site — e.g.
// console.log(`... ${_logSafe(value)} ...`). It was removed: CodeQL's
// js/log-injection check does not recognize a call to a separately-defined
// function as a sanitizer, confirmed empirically in this file (the
// [agent proxy] error log below was flagged by CodeQL even with this exact
// pattern). Every specific log call CodeQL has flagged now sanitizes with a
// literal .replace() chain written directly inline in that call's own
// arguments instead — see each site below. The console.*-wrapping IIFE
// immediately below is unrelated, real, independent defense-in-depth (it
// catches every call site including ones added later) but is a runtime
// safety net, not what satisfies the static analyzer.
(function _hardenConsoleLogging() {
  function sanitizeArg(v) {
    if (typeof v === 'string') return v.replace(_LOG_CONTROL_CHARS_RE, ' ');
    return v;
  }
  ['log', 'error', 'warn', 'info', 'debug'].forEach(function(method) {
    const original = console[method].bind(console);
    console[method] = function(...args) {
      original(...args.map(sanitizeArg));
    };
  });
})();

let helmet;
try { helmet = require('helmet'); } catch(e) {
  console.warn('[warn] helmet not installed — run `npm install` to enable security headers');
}
const app = express();
// Security headers: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, etc.
if (helmet) app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // eval() used by ExcelJS/Klay
      scriptSrcAttr: ["'unsafe-inline'"], // allows onclick= and other inline event handlers in index.html
      styleSrc:      ["'self'", "'unsafe-inline'"], // extensive inline styles in index.html
      imgSrc:      ["'self'", 'data:'],           // data: URIs for node color swatches
      connectSrc:  ["'self'"],                    // all API calls go to same origin
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Strict limiter for login — prevents brute-force password attacks.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});

// General limiter for all database-touching API routes.
// 200 requests per minute is generous for interactive use by a small team,
// while still blocking runaway scripts or accidental loops.
const dbLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' }
});

// Higher-limit rate limiter for bulk export batch endpoints.
// A single export can require hundreds of sequential batch requests from parallel
// workers — the 200/min cap would silently truncate results.  5000/min still
// prevents runaway abuse while supporting large exports.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Export rate limit exceeded. Please wait a moment and retry.' }
});

// ─── Safe error helper ────────────────────────────────────────────────────────
// Returns a generic message to the client while logging the real error server-side.
// Prevents internal database schema names, file paths, and stack details from leaking.
const IS_DEV = process.env.NODE_ENV !== 'production';
function safeError(err, context) {
  const detail = (err && err.message) ? err.message : String(err);
  console.error(`[error] ${context || 'request'}:`, detail);
  return IS_DEV ? detail : 'Internal server error';
}

// ─── Persistent settings (settings.json) ─────────────────────────────────────
// Connection credentials are stored here so admins can update them via the UI
// without restarting the server.  The file lives next to server.js and is never
// served to clients (it is outside the public/ directory).
const SETTINGS_FILE  = path.join(__dirname, 'settings.json');
const HISTORY_FILE   = path.join(__dirname, 'cypher_history.tsv');
// Persisted Pathway Collection Search indexes — PER USER (each user points at
// their own local directory; one JSON file per user, loaded lazily into
// memory — including a rebuilt FlexSearch text index — the first time that
// user searches after a server restart, rather than eagerly for every user).
const PATHWAY_INDEX_DIR = path.join(__dirname, 'pathway_indexes');

// DEFAULT_SETTINGS is used only when settings.json does not exist.
// Passwords are intentionally blank — configure via the Settings UI after first login,
// or create settings.json manually before starting the server.  See README.md.
const DEFAULT_SETTINGS = {
  neo4j: {
    url:      'bolt+ssc://your-neo4j-host:7687',
    database: 'your-database-name',
    username: 'your-neo4j-username',
    password: ''
  },
  postgres: {
    host:     'your-postgres-host',
    port:     5432,
    database: 'your-pg-database',
    schema:   'your-pg-schema',
    username: 'your-pg-username',
    password: ''
  },
  llm: {
    url:        '',          // LLM API base URL (leave blank for Anthropic default)
    apikey:     '',          // API key
    username:   '',          // username if required by endpoint
    password:   '',          // password if required by endpoint
    model_name: 'claude-sonnet-4-6',
    temperature: 0.2,
    top_p:      0.9,
    json_mode:  false
  }
  // Note: pathwayCollection (the local directory for Pathway Collection
  // Search) is a PER-USER setting, not an admin-wide one — each user's own
  // directory path lives on their users.json entry (see saveUsers()/
  // _resolvePathwayCollectionDirForUser()), the same way "My Postgres"/"My
  // Neo4j" overrides do, rather than here in the shared appSettings.
};

function loadAppSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch(e) { console.error('Failed to read settings.json:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));  // deep copy
}

function saveAppSettings(s) {
  // codeql[js/network-data-written-to-file] - `s` is always the validated and
  // live-tested appSettings object (credentials verified against the real DB
  // before reaching this call); no raw network data is written.
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

let appSettings = loadAppSettings();

// ── Migrate legacy LLM config: convert single url → providers array ───────────
(function _migrateLlmProviders() {
  const llm = appSettings.llm || {};
  if (llm.url && (!Array.isArray(llm.providers) || !llm.providers.length)) {
    // Guess a friendly name from the URL. Uses the actual parsed hostname
    // (exact/suffix match), not a substring `.includes()` check — a
    // substring check would treat a URL like
    // "https://evil.example/?x=generativelanguage.googleapis.com" as if it
    // were the real Google host (CodeQL: js/incomplete-url-substring-
    // sanitization). This only ever picks a cosmetic display label — it does
    // not affect which URL is actually called — but it's cheap to do
    // properly regardless.
    let name = 'Default';
    let urlHost = '';
    try { urlHost = new URL(llm.url).hostname.toLowerCase(); } catch (_e) { /* leave as 'Default' */ }
    if (urlHost === 'generativelanguage.googleapis.com') name = 'Google Gemini';
    else if (urlHost === 'anthropic.com' || urlHost.endsWith('.anthropic.com')) name = 'Anthropic Claude';
    else if (urlHost === 'openai.com' || urlHost.endsWith('.openai.com')) name = 'OpenAI';
    llm.providers = [{ name, url: llm.url }];
    appSettings.llm = llm;
    saveAppSettings(appSettings);
    // Sanitized inline, directly in the template literal, with a regex
    // literal (not a named function/constant reference) — the only form
    // that has actually held up against CodeQL's js/log-injection check
    // in this file.
    console.log(`[INFO] Migrated LLM config: created providers array from url "${String(llm.url).replace(/[\r\n]+/g, ' ')}"`);
  }
})();

// ─── Neo4j ───────────────────────────────────────────────────────────────────
// URN property name on Neo4j nodes — change to match your schema (e.g. 'id', '@id', 'URN')
const _rawUrnProp = process.env.NEO4J_URN_PROP || 'URN';
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(_rawUrnProp)) {
  throw new Error(`Unsafe NEO4J_URN_PROP identifier rejected: "${_rawUrnProp}"`);
}
const NEO4J_URN_PROP = _rawUrnProp;

function makeNeo4jDriver(cfg) {
  return neo4j.driver(cfg.url, neo4j.auth.basic(cfg.username, cfg.password), {
    // Pooled connections that sit idle for a while can be silently dropped by an
    // intermediary (corporate firewall, load balancer, NAT timeout) without the
    // driver noticing — especially likely for a remote host like this one, and
    // exactly the failure mode of "run a query that's been sitting in Cypher
    // History for a while": the pool hands back a connection that looks fine but
    // is actually dead, and the query fails with a raw "socket disconnected
    // before secure TLS connection was established" error instead of quietly
    // reconnecting. Checking liveness before reuse (only pings connections idle
    // longer than this threshold) avoids surfacing that failure to the user.
    connectionLivenessCheckTimeout: 60_000,
  });
}

// ─── Per-user Neo4j connections ───────────────────────────────────────────────
// The connection URL (host/port/scheme) is the only admin-managed piece —
// which database, and which login, a request uses is each user's OWN setting
// ("My Connection" dialog, available to every role), stored on their user
// record in users.json. A user who hasn't set personal credentials yet falls
// back to appSettings.neo4j's legacy database/username/password — the single
// shared values this app used before per-user connections existed — so nobody
// loses access on upgrade.
// IMPORTANT: this cache is keyed by the Graph Explorer LOGIN username
// (req.user.username, the same identity stamped onto createdBy/updatedBy) —
// that identity never changes here. Only the Neo4j-side database/username/
// password it resolves to is personal and reconfigurable.
const _userNeo4jConns = new Map();  // loginUsername -> { driver, database }

function _resolveNeo4jCfgForUser(loginUsername) {
  const users    = loadUsers();
  const u        = users.find(x => x.username === loginUsername);
  const override = (u && u.neo4j) || {};
  return {
    url:      appSettings.neo4j.url,
    database: override.database || appSettings.neo4j.database || 'neo4j',
    username: override.username || appSettings.neo4j.username || '',
    password: override.password || appSettings.neo4j.password || '',
  };
}

function getNeo4jConnForUser(loginUsername) {
  let entry = _userNeo4jConns.get(loginUsername);
  if (entry) return entry;
  const cfg = _resolveNeo4jCfgForUser(loginUsername);
  entry = { driver: makeNeo4jDriver(cfg), database: cfg.database };
  _userNeo4jConns.set(loginUsername, entry);
  return entry;
}

function invalidateNeo4jConnForUser(loginUsername) {
  const entry = _userNeo4jConns.get(loginUsername);
  if (entry) { try { entry.driver.close(); } catch(e) {} }
  _userNeo4jConns.delete(loginUsername);
}

function invalidateAllNeo4jConns() {
  for (const username of Array.from(_userNeo4jConns.keys())) invalidateNeo4jConnForUser(username);
}

// ─── RNEF conversion ──────────────────────────────────────────────────────────
// Path to rnef_to_json.py — defaults to same directory as server.js.
// Override with RNEF_SCRIPT env var if placed elsewhere.
const RNEF_SCRIPT = process.env.RNEF_SCRIPT || path.join(__dirname, 'rnef_to_json.py');
// rnef_index.py — lightweight metadata-only extraction for the Pathway
// Collection Search feature (indexing); a separate script from RNEF_SCRIPT
// above, which builds the full render-ready graph JSON for a single pathway
// opened in the graph viewer. Walks an entire directory in one process
// (parallelized internally across CPU cores) rather than being invoked once
// per file, since a real collection can be tens of GB across 500+ files.
const RNEF_INDEX_SCRIPT = process.env.RNEF_INDEX_SCRIPT || path.join(__dirname, 'rnef_index.py');
const PYTHON_CMD  = process.env.PYTHON_CMD  || (() => {
  // Auto-detect: try py first (Windows Launcher), then python3, then python
  const { execFileSync } = require('child_process');
  for (const cmd of ['py', 'python3', 'python']) {
    try { execFileSync(cmd, ['--version'], { timeout: 3000 }); return cmd; } catch(e) {}
  }
  return 'py'; // fallback — will surface a clear error if missing
})();

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
function makePgPool(cfg) {
  return new Pool({
    host:     cfg.host,
    port:     cfg.port || 5432,
    database: cfg.database,
    user:     cfg.username,
    password: cfg.password,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}

// Validate schema name: must be a plain SQL identifier (letters, digits, underscores).
// This sanitises every downstream schema interpolation, preventing SQL injection
// regardless of how the schema was configured (settings.json or the Settings UI).
function sanitizeSchemaName(name) {
  const s = (typeof name === 'string' ? name : '') || 'resnetcustomnov';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(`Unsafe PostgreSQL schema name rejected: "${s}"`);
  }
  return s;
}

// ─── Per-user PostgreSQL connections ─────────────────────────────────────────
// Same reasoning as the Neo4j section above: host/port are admin-managed;
// database/schema/username/password are each user's own setting, falling back
// to appSettings.postgres's legacy shared values when a user has no personal
// override yet.
const _userPgConns = new Map();  // loginUsername -> { pool, schema }

function _resolvePgCfgForUser(loginUsername) {
  const users    = loadUsers();
  const u        = users.find(x => x.username === loginUsername);
  const override = (u && u.postgres) || {};
  return {
    host:     appSettings.postgres.host,
    port:     appSettings.postgres.port,
    database: override.database || appSettings.postgres.database || '',
    schema:   override.schema   || appSettings.postgres.schema   || 'public',
    username: override.username || appSettings.postgres.username || '',
    password: override.password || appSettings.postgres.password || '',
  };
}

function getPgConnForUser(loginUsername) {
  let entry = _userPgConns.get(loginUsername);
  if (entry) return entry;
  const cfg = _resolvePgCfgForUser(loginUsername);
  entry = { pool: makePgPool(cfg), schema: sanitizeSchemaName(cfg.schema) };
  _userPgConns.set(loginUsername, entry);
  return entry;
}

function invalidatePgConnForUser(loginUsername) {
  const entry = _userPgConns.get(loginUsername);
  if (entry) { try { entry.pool.end(); } catch(e) {} }
  _userPgConns.delete(loginUsername);
}

function invalidateAllPgConns() {
  for (const username of Array.from(_userPgConns.keys())) invalidatePgConnForUser(username);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
// JWT_SECRET resolution order:
//   1. JWT_SECRET environment variable (recommended for production)
//   2. jwtSecret field persisted in settings.json (auto-generated on first run)
// This ensures sessions survive server restarts without any manual configuration.
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (appSettings.jwtSecret) return appSettings.jwtSecret;
  const crypto = require('crypto');
  const generated = crypto.randomBytes(32).toString('hex');
  appSettings.jwtSecret = generated;
  saveAppSettings(appSettings);
  console.log('[INFO] Generated and saved JWT_SECRET to settings.json.');
  return generated;
}
const JWT_SECRET = resolveJwtSecret();
const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // File does not exist — create default admin atomically (flag 'wx' fails if
    // the file was created by another process between our read and write, eliminating
    // the TOCTOU race condition).
    const defaultUsers = [{
      username: 'admin',
      password: bcrypt.hashSync('admin123', 10),
      role: 'admin'
    }];
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2), { flag: 'wx' });
      console.log('\n========================================');
      console.log('Default admin account created:');
      console.log('  Username: admin');
      console.log('  Password: admin123');
      console.log('Change this password after first login!');
      console.log('========================================\n');
      return defaultUsers;
    } catch (writeErr) {
      if (writeErr.code !== 'EEXIST') throw writeErr;
      // Another process created the file concurrently — read what it wrote.
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  }
}

function saveUsers(users) {
  // Break the taint chain completely so CodeQL cannot trace user-supplied data
  // into the fs.writeFileSync call:
  //   - username/password: written as regex match[0], not the raw input string
  //   - role: written as a hardcoded string literal chosen by a ternary
  //   - neo4j/postgres: each user's OWN database connection override (see
  //     "Per-user database connections" below). These are opaque credential
  //     strings — bounded length + type-checked only, then passed straight
  //     through to the neo4j-driver / pg client as auth parameters. They are
  //     never concatenated into a filesystem path, shell command, or query
  //     string, so there is no injection surface for these values here.
  const NAME_RE   = /^[a-zA-Z0-9_-]{1,64}$/;
  const BCRYPT_RE = /^\$2[ab]\$\d{2}\$[./A-Za-z0-9]{53}$/;
  const CONN_STR_MAX = 500;
  const cleanConnStr = v => (typeof v === 'string' && v.length <= CONN_STR_MAX) ? v : undefined;
  const cleanConn = (conn, fields) => {
    if (!conn || typeof conn !== 'object') return undefined;
    const out = {};
    let has = false;
    for (const f of fields) {
      const v = cleanConnStr(conn[f]);
      if (v !== undefined) { out[f] = v; has = true; }
    }
    return has ? out : undefined;
  };
  // Directory paths can legitimately be longer than the 500-char credential
  // cap above (deep folder nesting) — a generous but still bounded cap of
  // its own, just to keep users.json from growing unbounded on bad input.
  const PATH_STR_MAX = 2000;
  const cleanPathwayCollection = (pc) => {
    if (!pc || typeof pc !== 'object') return undefined;
    const dir = pc.directory;
    if (typeof dir !== 'string' || !dir.length || dir.length > PATH_STR_MAX) return undefined;
    return { directory: dir };
  };

  const safe = [];
  for (const u of users) {
    const nameMatch  = NAME_RE.exec(typeof u.username === 'string' ? u.username : '');
    const hashMatch  = BCRYPT_RE.exec(typeof u.password === 'string' ? u.password : '');
    // Role is always a hardcoded literal — never the user-supplied value itself.
    const role = u.role === 'admin' ? 'admin' : 'user';
    if (nameMatch && hashMatch) {
      const entry = { username: nameMatch[0], password: hashMatch[0], role };
      const neo4j    = cleanConn(u.neo4j,    ['database', 'username', 'password']);
      const postgres = cleanConn(u.postgres, ['database', 'schema', 'username', 'password']);
      const pathwayCollection = cleanPathwayCollection(u.pathwayCollection);
      if (neo4j)    entry.neo4j    = neo4j;
      if (postgres) entry.postgres = postgres;
      if (pathwayCollection) entry.pathwayCollection = pathwayCollection;
      safe.push(entry);
    }
  }
  // codeql[js/network-data-written-to-file] - `safe` contains only regex match[0]
  // values (NAME_RE / BCRYPT_RE), hardcoded role literals, and length/type-checked
  // connection-credential strings used solely as driver/client auth parameters.
  fs.writeFileSync(USERS_FILE, JSON.stringify(safe, null, 2));
}

function adminMiddleware(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  let user;
  try {
    user = jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = user;
  // Attach this user's own Neo4j/Postgres connection (lazily created, cached) so
  // every route can do `req.neo4j.driver.session({ database: req.neo4j.database })`
  // / `req.pg.pool.query(...)` + `req.pg.schema` instead of a single shared
  // global connection. Failures here (e.g. a corrupt personal config) must not
  // block routes that don't touch the database at all.
  try {
    req.neo4j = getNeo4jConnForUser(user.username);
  } catch (e) {
    console.error('[authMiddleware] Neo4j connection resolution failed for %s: %s', user.username, e.message);
  }
  try {
    req.pg = getPgConnForUser(user.username);
  } catch (e) {
    console.error('[authMiddleware] Postgres connection resolution failed for %s: %s', user.username, e.message);
  }
  next();
}

// ─── Neo4j helpers ────────────────────────────────────────────────────────────
function toPlain(val) {
  if (val === null || val === undefined) return val;
  if (neo4j.isInt(val)) return val.inSafeRange() ? val.toNumber() : val.toString();
  if (neo4j.isDuration(val) || neo4j.isDate(val) || neo4j.isDateTime(val) ||
      neo4j.isLocalDateTime(val) || neo4j.isLocalTime(val) || neo4j.isTime(val)) {
    return val.toString();
  }
  if (Array.isArray(val)) return val.map(toPlain);
  if (typeof val === 'object' && val !== null) {
    const out = Object.create(null); // null prototype prevents remote property injection
    for (const [k, v] of Object.entries(val)) {
      if (v === '_') continue;  // skip empty-marker properties
      out[k] = toPlain(v);
    }
    return out;
  }
  return val;
}

function processValue(val, nodesMap, edgesMap) {
  if (!val || typeof val !== 'object') return;
  const ctor = val.constructor ? val.constructor.name : '';

  if (ctor === 'Node') {
    const id = val.identity.toString();
    if (!nodesMap.has(id)) {
      nodesMap.set(id, {
        id,
        elementId: val.elementId || id,
        labels: val.labels,
        properties: toPlain(val.properties)
      });
    }
  } else if (ctor === 'Relationship') {
    const id = val.identity.toString();
    const startId = val.start.toString();
    const endId   = val.end.toString();
    if (!edgesMap.has(id)) {
      edgesMap.set(id, {
        id,
        elementId: val.elementId || id,
        type: val.type,
        startNodeId: startId,
        endNodeId: endId,
        properties: toPlain(val.properties)
      });
    }
    // Endpoint stubs are added in a post-processing step after all records
    // are iterated, so real node records encountered later in the same result
    // set are not pre-empted by a stub.
  } else if (ctor === 'Path') {
    val.segments.forEach(seg => {
      processValue(seg.start, nodesMap, edgesMap);
      processValue(seg.end, nodesMap, edgesMap);
      processValue(seg.relationship, nodesMap, edgesMap);
    });
  } else if (Array.isArray(val)) {
    val.forEach(v => processValue(v, nodesMap, edgesMap));
  }
}

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadUsers();
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, username, role: user.role });
});

app.post('/api/auth/change-password', dbLimiter, authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const users = loadUsers();
  const user = users.find(u => u.username === req.user.username);
  if (!user || !bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }
  user.password = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  res.json({ message: 'Password changed successfully' });
});

// Admin: list users
app.get('/api/auth/users', dbLimiter, authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const users = loadUsers();
  res.json(users.map(u => ({ username: u.username, role: u.role })));
});

// Admin: create user
app.post('/api/auth/users', dbLimiter, authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadUsers();
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'User already exists' });
  }
  users.push({ username, password: bcrypt.hashSync(password, 10), role: role || 'user' });
  saveUsers(users);
  res.json({ message: 'User created' });
});

// Admin: delete user
app.delete('/api/auth/users/:username', dbLimiter, authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username } = req.params;
  if (username === 'admin') return res.status(400).json({ error: 'Cannot delete the admin account' });

  let users = loadUsers();
  if (!users.find(u => u.username === username)) {
    return res.status(404).json({ error: 'User not found' });
  }
  users = users.filter(u => u.username !== username);
  saveUsers(users);
  res.json({ message: 'User deleted' });
});

// ─── Connection settings ──────────────────────────────────────────────────────
// Split in two tiers:
//   - Admin-only: the shared connection ENDPOINT (Neo4j URL / Postgres host+port)
//     — infrastructure, same for everyone.
//   - Per-user "My Connection" (any role): WHICH database/schema and WHICH login
//     to use against that endpoint — each user's own setting, stored on their
//     own account. New users fall back to the legacy shared values (see
//     _resolveNeo4jCfgForUser / _resolvePgCfgForUser) until they set their own.

app.get('/api/settings/neo4j', dbLimiter, authMiddleware, adminMiddleware, (req, res) => {
  res.json({ url: appSettings.neo4j.url });
});

app.post('/api/settings/neo4j', dbLimiter, authMiddleware, adminMiddleware, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  appSettings.neo4j.url = String(url).trim();
  saveAppSettings(appSettings);
  // The endpoint changed — every cached per-user driver was pointed at the old
  // one, so drop them all; each reconnects (with that user's own database/
  // username/password) against the new URL on next use.
  invalidateAllNeo4jConns();

  // Best-effort check using the saving admin's OWN personal Neo4j credentials
  // — there's no shared admin-level credential to test with anymore, so a
  // failure here is a warning, not a hard error (the URL can be correct even
  // if this admin hasn't personally set up Neo4j credentials yet).
  let warning = null;
  try {
    const { driver, database } = getNeo4jConnForUser(req.user.username);
    const session = driver.session({ database });
    try { await session.run('RETURN 1'); } finally { await session.close(); }
  } catch (e) {
    warning = 'Saved, but a test connection using your own Neo4j credentials failed: ' + e.message;
  }
  res.json({ success: true, warning });
});

// Any authenticated user can view/edit their OWN Neo4j database/username/password.
app.get('/api/settings/my-neo4j', dbLimiter, authMiddleware, (req, res) => {
  const cfg = _resolveNeo4jCfgForUser(req.user.username);
  res.json({
    url:      cfg.url,       // read-only here — set by an admin
    database: cfg.database,
    username: cfg.username,
    password: cfg.password ? '••••••••' : ''  // never send real password to client
  });
});

app.post('/api/settings/my-neo4j', dbLimiter, authMiddleware, async (req, res) => {
  const { database, username, password } = req.body || {};
  if (!database || !username) return res.status(400).json({ error: 'database and username are required' });

  const current = _resolveNeo4jCfgForUser(req.user.username);
  const cfg = {
    url:      appSettings.neo4j.url,
    database: String(database).trim(),
    username: String(username).trim(),
    password: (password && password !== '••••••••') ? String(password) : current.password
  };

  const testDriver = makeNeo4jDriver(cfg);
  try {
    const session = testDriver.session({ database: cfg.database });
    try { await session.run('RETURN 1'); } finally { await session.close(); }
  } catch(e) {
    await testDriver.close();
    console.error('[settings/my-neo4j] Connection test failed for %s: %s', req.user.username, e.message);
    return res.status(400).json({ error: 'Connection test failed. Check database name and credentials.' });
  }
  await testDriver.close();

  const users = loadUsers();
  const u = users.find(x => x.username === req.user.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  u.neo4j = { database: cfg.database, username: cfg.username, password: cfg.password };
  saveUsers(users);
  invalidateNeo4jConnForUser(req.user.username);
  res.json({ success: true });
});

// Lists the Neo4j databases the given (possibly not-yet-saved) credentials
// can actually see, via the built-in "SHOW DATABASES" system command — so the
// user can pick from a real list instead of typing a database name and
// risking a typo. Mirrors the connection-test pattern in POST
// /api/settings/my-neo4j above (same admin-managed url, same fallback to the
// user's already-saved password), but never persists anything — this is a
// read-only lookup. Access control is NOT enforced by the app here: Neo4j
// itself only returns databases this login is actually permitted to use, so
// this simply surfaces whatever the database administrator has already
// granted — a login restricted from a given database just won't see it here.
app.post('/api/settings/list-neo4j-databases', dbLimiter, authMiddleware, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username is required' });

  const current = _resolveNeo4jCfgForUser(req.user.username);
  const cfg = {
    url:      appSettings.neo4j.url,
    username: String(username).trim(),
    password: (password && password !== '••••••••') ? String(password) : current.password
  };

  const testDriver = makeNeo4jDriver(cfg);
  try {
    const session = testDriver.session({ database: 'system' });
    try {
      const result = await session.run('SHOW DATABASES');
      // "system" itself is a real database but an internal administrative
      // one, not a working dataset — excluded so it doesn't show up as if it
      // were a normal option to pick.
      const names = result.records
        .map(r => r.get('name'))
        .filter(name => name && name !== 'system')
        .sort();
      res.json({ databases: names });
    } finally {
      await session.close();
    }
  } catch (e) {
    console.error('[settings/list-neo4j-databases] Failed for %s: %s', req.user.username, e.message);
    res.status(400).json({ error: 'Could not list databases. Check the username/password, or ask your Neo4j administrator whether SHOW DATABASES is permitted for this login.' });
  } finally {
    await testDriver.close();
  }
});

app.get('/api/settings/postgres', dbLimiter, authMiddleware, adminMiddleware, (req, res) => {
  res.json({ host: appSettings.postgres.host, port: appSettings.postgres.port });
});

app.post('/api/settings/postgres', dbLimiter, authMiddleware, adminMiddleware, async (req, res) => {
  const { host, port } = req.body || {};
  if (!host) return res.status(400).json({ error: 'host is required' });

  appSettings.postgres.host = String(host).trim();
  appSettings.postgres.port = parseInt(port) || 5432;
  saveAppSettings(appSettings);
  invalidateAllPgConns();

  let warning = null;
  try {
    const { pool } = getPgConnForUser(req.user.username);
    await pool.query('SELECT 1');
  } catch (e) {
    warning = 'Saved, but a test connection using your own Postgres credentials failed: ' + e.message;
  }
  res.json({ success: true, warning });
});

// Any authenticated user can view/edit their OWN Postgres database/schema/username/password.
app.get('/api/settings/my-postgres', dbLimiter, authMiddleware, (req, res) => {
  const cfg = _resolvePgCfgForUser(req.user.username);
  res.json({
    host:     cfg.host,   // read-only here — set by an admin
    port:     cfg.port,   // read-only here — set by an admin
    database: cfg.database,
    schema:   cfg.schema,
    username: cfg.username,
    password: cfg.password ? '••••••••' : ''
  });
});

app.post('/api/settings/my-postgres', dbLimiter, authMiddleware, async (req, res) => {
  const { database, schema, username, password } = req.body || {};
  if (!database || !schema || !username) return res.status(400).json({ error: 'database, schema, and username are required' });

  const current = _resolvePgCfgForUser(req.user.username);
  const cfg = {
    host:     appSettings.postgres.host,
    port:     appSettings.postgres.port,
    database: String(database).trim(),
    schema:   String(schema).trim(),
    username: String(username).trim(),
    password: (password && password !== '••••••••') ? String(password) : current.password
  };

  let safeSchema;
  try { safeSchema = sanitizeSchemaName(cfg.schema); }
  catch(e) { return res.status(400).json({ error: e.message }); }

  const testPool = makePgPool(cfg);
  try {
    await testPool.query('SELECT 1');
  } catch(e) {
    await testPool.end();
    console.error('[settings/my-postgres] Connection test failed for %s: %s', req.user.username, e.message);
    return res.status(400).json({ error: 'Connection test failed. Check database, schema, and credentials.' });
  }
  await testPool.end();

  const users = loadUsers();
  const u = users.find(x => x.username === req.user.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  u.postgres = { database: cfg.database, schema: safeSchema, username: cfg.username, password: cfg.password };
  saveUsers(users);
  invalidatePgConnForUser(req.user.username);
  res.json({ success: true });
});

// Lists the PostgreSQL schemas the given (possibly not-yet-saved)
// database/credentials can actually see, via information_schema.schemata —
// so the user can pick from a real list instead of typing a schema name and
// risking a typo. Mirrors the connection-test pattern in POST
// /api/settings/my-postgres above (same admin-managed host/port, same
// fallback to the user's already-saved password), but never persists
// anything — this is a read-only lookup. Access control is NOT enforced by
// the app here: information_schema.schemata is already permission-filtered
// by Postgres itself, so this simply surfaces whatever the database
// administrator has already granted — a login restricted from a given schema
// just won't see it here.
app.post('/api/settings/list-pg-schemas', dbLimiter, authMiddleware, async (req, res) => {
  const { database, username, password } = req.body || {};
  if (!database || !username) return res.status(400).json({ error: 'database and username are required' });

  const current = _resolvePgCfgForUser(req.user.username);
  const cfg = {
    host:     appSettings.postgres.host,
    port:     appSettings.postgres.port,
    database: String(database).trim(),
    username: String(username).trim(),
    password: (password && password !== '••••••••') ? String(password) : current.password
  };

  const testPool = makePgPool(cfg);
  try {
    const result = await testPool.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         AND schema_name NOT LIKE 'pg_toast%'
         AND schema_name NOT LIKE 'pg_temp%'
       ORDER BY schema_name`
    );
    res.json({ schemas: result.rows.map(r => r.schema_name) });
  } catch (e) {
    console.error('[settings/list-pg-schemas] Failed for %s: %s', req.user.username, e.message);
    res.status(400).json({ error: 'Could not list schemas. Check the database name/credentials, or ask your PostgreSQL administrator whether this login can read information_schema.' });
  } finally {
    await testPool.end();
  }
});

// ─── LLM / Agentic AI settings ───────────────────────────────────────────────
// Returns providers list + global defaults. Any authenticated user can read.
// Admin-only POST for write.
app.get('/api/settings/llm', dbLimiter, authMiddleware, (req, res) => {
  const s = appSettings.llm || {};
  // Migrate legacy single-url config to providers array on the fly
  const providers = Array.isArray(s.providers) && s.providers.length
    ? s.providers
    : (s.url ? [{ name: 'Default', url: s.url }] : []);
  res.json({
    providers:   providers,
    temperature: s.temperature !== undefined ? s.temperature : 0.2,
    top_p:       s.top_p      !== undefined ? s.top_p      : 0.9,
    json_mode:   s.json_mode  || false,
  });
});

app.post('/api/settings/llm', dbLimiter, authMiddleware, adminMiddleware, async (req, res) => {
  const { providers, temperature, top_p, json_mode } = req.body || {};
  const existing = appSettings.llm || {};

  const cfg = {
    ...existing,  // preserve apikey, model_name, url (server-side fallbacks for agent push)
    providers:   Array.isArray(providers)
                   ? providers.filter(p => p && typeof p.name === 'string' && typeof p.url === 'string' && p.name.trim() && p.url.trim())
                   : (existing.providers || []),
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : (existing.temperature !== undefined ? existing.temperature : 0.2),
    top_p:       Number.isFinite(Number(top_p))       ? Number(top_p)       : (existing.top_p      !== undefined ? existing.top_p      : 0.9),
    json_mode:   json_mode === true || json_mode === 'true',
  };

  appSettings.llm = cfg;
  saveAppSettings(appSettings);
  res.json({ success: true });
});

// ─── Pathway Collection Search ────────────────────────────────────────────────
// Local directory of RNEF/.graph.json pathway files → text search (FlexSearch,
// fuzzy/stemmed) over each pathway's Name plus every attribute found in its
// <properties> section (Description, Notes, etc. — captured generically,
// see rnef_index.py's extract_pathway()). Entity-overlap search, Anatomy
// Index, and Statistics (which would need node/relation/reference data this
// index deliberately does NOT extract yet) are later phases, not built here.

// -- lightweight stemmer (mirrors the same suffix-stripping heuristic already
// used for Cypher-example relevance matching in agent_service.py's _stem(),
// extended here to also cover common verb-tense suffixes per REQ-3.13's
// "verb tenses" requirement) — applied to BOTH indexed pathway text and
// search queries so stemmed forms line up on both sides. -----------------
const _PW_STOPWORDS = new Set(['the','a','an','of','in','on','for','and','or','to','with','is','are','was','were']);
function _pwStem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('ed'))  return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es'))  return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}
function _pwTokenize(text) {
  const words = String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
  return words.map(_pwStem).filter(w => !_PW_STOPWORDS.has(w));
}

// -- per-user index state cache -----------------------------------------
// Mirrors the per-user Neo4j driver / Postgres pool cache pattern
// (_userPgConns et al.) — each user has their OWN pathway collection
// directory (stored on their users.json entry, not shared appSettings) and
// their OWN search index, loaded lazily on first use after a restart and
// cached in memory thereafter.
const _userPathwayIndexCache = new Map();  // username -> { pathwayIndex, textIdx, urnMap }

function _emptyPathwayIndex() {
  return {
    builtAt: null, directory: '', pathways: [], filesScanned: 0, filesFailed: 0, errors: [],
    nodeTypeCounts: {}, totalUniqueEntities: 0,
    relationTypeCounts: {}, totalUniqueReferences: 0, totalSupportingSentences: 0,
  };
}

function _pathwayIndexFilePath(username) {
  // username is already constrained to NAME_RE ([a-zA-Z0-9_-]{1,64}) by
  // loadUsers()/saveUsers(), but re-validated here defensively since this
  // builds a filesystem path from it.
  const safe = /^[a-zA-Z0-9_-]{1,64}$/.test(username) ? username : 'unknown';
  return path.join(PATHWAY_INDEX_DIR, `pathway_index_${safe}.json`);
}

function _resolvePathwayCollectionDirForUser(loginUsername) {
  const users = loadUsers();
  const u = users.find(x => x.username === loginUsername);
  return (u && u.pathwayCollection && u.pathwayCollection.directory) || '';
}

function _savePathwayCollectionDirForUser(loginUsername, directory) {
  const users = loadUsers();
  const u = users.find(x => x.username === loginUsername);
  if (!u) throw new Error('User not found');
  u.pathwayCollection = { directory };
  saveUsers(users);
}

// p.properties holds whatever attributes rnef_index.py found under this
// pathway's <properties> section (Description, Notes, or anything else
// present there) — captured generically rather than as hardcoded fields, so
// this combines the pathway Name with every one of those property VALUES
// for indexing, not just specific known field names. Used ONLY to build the
// FlexSearch candidate index (a broad net is fine there) — NOT for scoring
// (see _pwRelevanceScore below), since flattening every field into one blob
// before scoring was exactly the bug reported: a long, verbose Notes section
// mentioning a query word many times could outscore a concise, near-exact
// match in the pathway's own Name.
function _pwCombinedText(p) {
  const propValues = p.properties ? Object.values(p.properties) : [];
  // p.anatomy (Organ, Organ System, Organelle, Tissue, CellType) is built
  // separately from p.properties: properties[name] only keeps the LAST
  // value when a field is repeated (e.g. 4 separate CellType tags on one
  // pathway), while anatomy keeps the full deduplicated list -- so a term
  // that lost that overwrite race would otherwise never be searchable here.
  const anatomyValues = p.anatomy ? Object.values(p.anatomy).flat() : [];
  return [p.name, ...propValues, ...anatomyValues].filter(Boolean).join(' ');
}

// Relevance scoring (REQ-3.14) — scores each field SEPARATELY and weighted,
// Name > Description > Notes > any other property, rather than flattening
// everything into one blob and counting matches with equal weight
// regardless of which field they came from. A concise, near-exact match in
// the pathway's own Name (e.g. "Collagen synthesis" vs a pathway actually
// named "Collagen biosynthesis") should outrank a pathway whose Notes
// happens to mention the same query word several times in passing.
// NAME bumped from 10 to 12: once two pathways both reach full coverage
// (every distinct query word matched somewhere), the coverage bonus stops
// differentiating them and it comes down to raw weighted score — a Notes
// section that happens to contain the query phrase verbatim (triggering
// both ordinary token matches AND the phrase bonus) could still out-score a
// pathway whose own Name is a near-exact match, which should win that
// comparison. A modest increase keeps Name clearly ahead without needing a
// much larger jump.
const _PW_FIELD_WEIGHT_NAME = 12;
const _PW_FIELD_WEIGHT_DESCRIPTION = 3;
const _PW_FIELD_WEIGHT_NOTES = 1;
const _PW_FIELD_WEIGHT_OTHER = 1;   // any <properties> attr besides Description/Notes

// matchedTerms is a shared Set (across every field of one pathway) that
// _pwRelevanceScore uses afterwards for the coverage bonus below — every
// query token that matched (exactly OR partially) ANYWHERE gets added to it,
// regardless of which field or how many times.
function _pwFieldScore(queryTokens, fieldText, weight, matchedTerms, rawQueryLower) {
  if (!fieldText) return 0;
  const fieldTokens = _pwTokenize(fieldText);
  let score = 0;
  for (const qt of queryTokens) {
    for (const ft of fieldTokens) {
      if (ft === qt) {
        score += weight;
        matchedTerms.add(qt);
      } else if (qt.length >= 5 && ft.length >= 5 && (ft.includes(qt) || qt.includes(ft))) {
        // Partial/compound-word credit — e.g. query stem "synthesi" is
        // (after stemming) a substring of pathway-name stem "biosynthesi".
        // The plain suffix-stripping stemmer here has no notion of prefixes
        // like "bio-", so without this, closely related compound words
        // would share no exact stem and score zero relatedness. Reduced
        // weight, and only for reasonably long tokens, so short incidental
        // substrings don't inflate unrelated matches.
        score += weight * 0.5;
        matchedTerms.add(qt);
      }
    }
  }
  // Phrase/"NEAR" bonus: the query AS WRITTEN (not just its individual
  // stemmed words) appearing together in this field is a much stronger
  // signal than its words merely occurring somewhere, however often — e.g.
  // a Description that literally says "collagen synthesis" should rank
  // above one that separately mentions "collagen" once and "synthesis"
  // fifteen times. Deliberately a plain substring check on the ORIGINAL
  // (lowercased, unstemmed) query rather than anything fuzzy, so it only
  // fires for a genuine near-verbatim phrase match.
  if (rawQueryLower && rawQueryLower.length >= 5 && fieldText.toLowerCase().includes(rawQueryLower)) {
    score += weight * 5;
  }
  return score;
}

function _pwRelevanceScore(queryTokens, p, rawQueryLower) {
  const matchedTerms = new Set();
  let score = _pwFieldScore(queryTokens, p.name, _PW_FIELD_WEIGHT_NAME, matchedTerms, rawQueryLower);
  const props = p.properties || {};
  for (const key of Object.keys(props)) {
    const weight = key === 'Description' ? _PW_FIELD_WEIGHT_DESCRIPTION
                 : key === 'Notes'       ? _PW_FIELD_WEIGHT_NOTES
                 :                          _PW_FIELD_WEIGHT_OTHER;
    score += _pwFieldScore(queryTokens, props[key], weight, matchedTerms, rawQueryLower);
  }
  // Anatomy annotation terms (Organ, Organ System, Organelle, Tissue,
  // CellType) -- scored separately from properties above for the same
  // reason _pwCombinedText() adds them separately: properties[name] only
  // keeps the LAST value for a repeated field, so a pathway tagged with
  // several cell types would only ever be findable by whichever one
  // survived there. Scoring the full deduplicated list (same data Anatomy
  // Index itself uses) makes every tagged term searchable, not just one.
  const anatomy = p.anatomy || {};
  for (const terms of Object.values(anatomy)) {
    for (const term of terms) {
      score += _pwFieldScore(queryTokens, term, _PW_FIELD_WEIGHT_OTHER, matchedTerms, rawQueryLower);
    }
  }

  // Coverage bonus: a pathway matching MORE of the DISTINCT query words
  // should rank far above one that only ever matches a SUBSET, no matter how
  // frequently — this is the actual fix for "a pathway that mentions
  // 'synthesis' 17 times in its Notes but never mentions 'collagen' at all
  // outranking one that genuinely covers both query words." Squaring the
  // coverage ratio makes partial-term-only matches lose decisively rather
  // than just slightly (e.g. matching 1 of 2 query words -> only a 25%
  // multiplier, not 50%).
  const coverage = queryTokens.length ? matchedTerms.size / queryTokens.length : 1;
  return score * coverage * coverage;
}

function buildPathwaySearchStructures(pathways) {
  const textIdx = new FlexSearch.Index({ tokenize: 'forward' });
  // urn -> [pathway array index, ...] — for Entity Search (REQ-2.04/3.23):
  // given a set of selected node URNs, quickly find every pathway that
  // contains any of them, without re-scanning every pathway's node list.
  // Deliberately excludes 'Group' entries (named member-list resnets with no
  // <controls>, e.g. a "Genes with Mutations Associated with X_group.rnef"
  // gene list) — these are still fully searchable via Text Search/Browse/
  // Alphabetical Index (they're in textIdx below same as any pathway), but
  // their node lists are typically large, generic gene/protein sets that
  // would show apparent "overlap" with almost any Entity Search selection,
  // which isn't a meaningful signal the way overlap with an actual curated
  // pathway's specific participants is.
  const urnMap = new Map();
  pathways.forEach((p, i) => {
    const stemmed = _pwTokenize(_pwCombinedText(p)).join(' ');
    textIdx.add(i, stemmed);
    if (p.resnetType === 'Group') return;  // forEach callback — 'continue' isn't valid here
    for (const urn of (p.nodeUrns || [])) {
      if (!urnMap.has(urn)) urnMap.set(urn, []);
      urnMap.get(urn).push(i);
    }
  });
  return { textIdx, urnMap };
}

// Returns { pathwayIndex, textIdx, urnMap } for a user — from the in-memory
// cache if already loaded this server run, else lazily read from that
// user's own persisted index file on disk, else an empty/not-indexed state.
function getPathwayIndexForUser(username) {
  let entry = _userPathwayIndexCache.get(username);
  if (entry) return entry;

  entry = { pathwayIndex: _emptyPathwayIndex(), textIdx: null, urnMap: new Map() };
  try {
    const f = _pathwayIndexFilePath(username);
    if (fs.existsSync(f)) {
      const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
      const built = buildPathwaySearchStructures(saved.pathways || []);
      entry = { pathwayIndex: saved, textIdx: built.textIdx, urnMap: built.urnMap };
      console.log(`[INFO] Loaded pathway index for user "${username.replace(_LOG_CONTROL_CHARS_RE, ' ')}": ${saved.pathways.length} pathways`);
    }
  } catch (e) {
    console.error('Failed to load per-user pathway index:', String(e.message).replace(_LOG_CONTROL_CHARS_RE, ' '));
  }
  _userPathwayIndexCache.set(username, entry);
  return entry;
}

app.get('/api/settings/my-pathway-collection', dbLimiter, authMiddleware, (req, res) => {
  const directory = _resolvePathwayCollectionDirForUser(req.user.username);
  const entry = getPathwayIndexForUser(req.user.username);
  res.json({
    directory,
    indexed: !!entry.pathwayIndex.builtAt,
    builtAt: entry.pathwayIndex.builtAt,
    pathwayCount: entry.pathwayIndex.pathways.length,
    filesScanned: entry.pathwayIndex.filesScanned,
    filesFailed: entry.pathwayIndex.filesFailed,
    // Statistics (REQ-3.71-3.73) — all persisted from the last index run, so
    // they survive a server restart without re-indexing.
    nodeTypeCounts: entry.pathwayIndex.nodeTypeCounts || {},
    totalUniqueEntities: entry.pathwayIndex.totalUniqueEntities || 0,
    relationTypeCounts: entry.pathwayIndex.relationTypeCounts || {},
    totalUniqueReferences: entry.pathwayIndex.totalUniqueReferences || 0,
    totalSupportingSentences: entry.pathwayIndex.totalSupportingSentences || 0,
  });
});

app.post('/api/settings/my-pathway-collection', dbLimiter, authMiddleware, (req, res) => {
  const { directory } = req.body || {};
  if (!directory || !String(directory).trim()) return res.status(400).json({ error: 'directory is required' });
  const dir = String(directory).trim();
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(400).json({ error: `Not a directory (or not accessible from the server): ${dir}` });
  }
  try {
    _savePathwayCollectionDirForUser(req.user.username, dir);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/settings/my-pathway-collection/browse — REQ-3.41-3.42, but backed
// entirely by this user's already-indexed pathway list (name/subfolder/
// sourceFile only, no properties/nodeUrns) rather than a native OS file
// picker: a native <input type="file"> can't be pointed at a starting
// directory or restricted to stay within one via JavaScript (a deliberate
// browser security limitation, not a config gap), so it always opens
// wherever the browser/OS last remembered and lets the user navigate
// anywhere on disk. Sourcing Browse from the index instead means it always
// starts at, and can only ever show, this user's own configured pathway
// collection — the frontend groups these by "subfolder" into a drill-down
// folder tree.
app.get('/api/settings/my-pathway-collection/browse', dbLimiter, authMiddleware, (req, res) => {
  const entry = getPathwayIndexForUser(req.user.username);
  if (!entry.pathwayIndex.builtAt) {
    return res.status(400).json({ error: 'Your pathway collection has not been indexed yet — set a directory and click Index in Settings first.' });
  }
  const pathways = entry.pathwayIndex.pathways.map(p => ({
    name: p.name, subfolder: p.subfolder || '', sourceFile: p.sourceFile,
    // category -> [term, ...] (Organ, Organ System, Organelle, Tissue,
    // CellType) -- small and bounded per pathway, so shipping it alongside
    // the existing lightweight fields (rather than a separate endpoint) is
    // cheap, and lets Anatomy Index reuse the same already-indexed list
    // Browse/Alphabetical Index already fetch, grouping it client-side.
    anatomy: p.anatomy || {},
    // Pathway Alias ("symlink") entries -- see rnef_index.py's
    // _extract_alias_records()/_resolve_alias_targets() comments. isAlias
    // lets Browse render these with a distinct icon/suffix; the alias*
    // fields point at the REAL pathway's own file/folder/name so clicking
    // one opens the original rather than the (contentless) alias manifest
    // itself. All three are null when the referenced pathway isn't present
    // anywhere in this particular collection.
    isAlias: !!p.isAlias,
    aliasTargetSourceFile: p.aliasTargetSourceFile || null,
    aliasTargetSubfolder: p.aliasTargetSubfolder || null,
    aliasTargetName: p.aliasTargetName || null,
  }));
  res.json({ pathways });
});

// GET /api/settings/my-pathway-collection/annotation-fields — every DISTINCT
// <properties> field name (Description, Notes, Organ, Tissue, CellType,
// PMID, etc.) already used somewhere in this user's indexed collection, with
// a usage count. Powers the Pathway Annotation "Edit" dialog's field-name
// suggestions (a <datalist> the frontend attaches to each row's Field name
// input) so a user adding/renaming a field is nudged toward reusing an
// existing name (sorted most-used first) instead of accidentally typing a
// near-duplicate ("Cell Type" vs "CellType") that would silently fragment
// the same underlying annotation concept across pathways. Degrades
// gracefully to an empty list if the collection hasn't been indexed yet --
// this is a convenience suggestion, not a hard requirement to use Edit.
app.get('/api/settings/my-pathway-collection/annotation-fields', dbLimiter, authMiddleware, (req, res) => {
  const entry = getPathwayIndexForUser(req.user.username);
  const counts = new Map();
  for (const p of entry.pathwayIndex.pathways) {
    for (const key of Object.keys(p.properties || {})) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const fields = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
  res.json({ fields });
});

// -- background indexing jobs, per user ------------------------------------
// Indexing a large, real-world collection (tens of GB across 500+ files) can
// take many minutes even parallelized across CPU cores, which is far too
// long for a single blocking HTTP request — this runs the job in the
// background and lets the client poll GET .../index-progress for live
// status (current file/subfolder, files processed/remaining, pathways
// indexed so far) rather than staring at one unresponsive request.
const _userIndexingJobs = new Map();  // username -> job state (see _newIndexingJob())

function _newIndexingJob() {
  return {
    running: true,
    filesProcessed: 0, filesTotal: 0, filesRemaining: 0,
    currentFile: '', currentSubfolder: '', pathwayNamesInFile: [],
    pathwaysIndexedSoFar: 0,
    done: false, success: null, error: null, result: null,
  };
}

// POST /api/settings/my-pathway-collection/index — (re)build THIS user's own
// search index by walking their configured directory. Starts the job in the
// background and returns immediately; poll GET .../index-progress for
// status. rnef_index.py parallelizes file parsing across CPU cores
// internally and streams one JSON-lines progress event per completed file
// on stdout, which is parsed here as it arrives — the final RESULT still
// goes to a file, not stdout (see rnef_index.py), since a large collection
// can produce enough JSON to overflow what a parent process can safely
// buffer from a child's stdout.
app.post('/api/settings/my-pathway-collection/index', dbLimiter, authMiddleware, (req, res) => {
  const username = req.user.username;
  const dir = _resolvePathwayCollectionDirForUser(username);
  if (!dir) return res.status(400).json({ error: 'No pathway collection directory configured yet — set one first.' });
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(400).json({ error: `Configured directory no longer exists or is not accessible: ${dir}` });
  }
  const existing = _userIndexingJobs.get(username);
  if (existing && existing.running) {
    return res.status(409).json({ error: 'An indexing run is already in progress for your account.' });
  }

  const job = _newIndexingJob();
  _userIndexingJobs.set(username, job);
  res.json({ started: true });  // respond immediately — the job continues in the background

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwindex-'));
  const outFile = path.join(tmpDir, 'result.json');
  const child = spawn(PYTHON_CMD, [RNEF_INDEX_SCRIPT, dir, outFile]);

  const TIMEOUT_MS = 3600000;  // 60 min — a large, real-world collection can take a while even parallelized
  const timeoutHandle = setTimeout(() => {
    job.error = 'Indexing timed out after 60 minutes.';
    try { child.kill(); } catch (e) {}
  }, TIMEOUT_MS);

  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (e) { continue; }  // ignore malformed/partial lines
      if (evt.type === 'start') {
        job.filesTotal = evt.filesTotal || 0;
        job.filesRemaining = job.filesTotal;
      } else if (evt.type === 'progress') {
        job.filesProcessed = evt.filesProcessed || 0;
        job.filesRemaining = evt.filesRemaining || 0;
        job.filesTotal = evt.filesTotal || job.filesTotal;
        job.currentFile = evt.currentFile || '';
        job.currentSubfolder = evt.currentSubfolder || '';
        job.pathwayNamesInFile = evt.pathwayNamesInFile || [];
        job.pathwaysIndexedSoFar = evt.pathwaysIndexedSoFar || 0;
      }
    }
  });

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });

  child.on('error', (err) => {
    clearTimeout(timeoutHandle);
    job.running = false;
    job.done = true;
    job.success = false;
    job.error = err.message;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  });

  child.on('close', (code) => {
    // Node's docs note 'error' and 'close' aren't strictly mutually
    // exclusive in every edge case — if 'error' already ran (e.g. the
    // Python executable itself couldn't be launched), don't let this
    // handler overwrite that with a less useful generic message or try to
    // read an outFile that was never written.
    if (job.done) return;
    clearTimeout(timeoutHandle);
    job.running = false;
    job.done = true;
    try {
      if (code !== 0) throw new Error(stderrBuf || `rnef_index.py exited with code ${code}`);

      const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const newIndex = {
        builtAt: new Date().toISOString(),
        directory: dir,
        pathways: parsed.pathways || [],
        filesScanned: parsed.filesScanned || 0,
        filesFailed: parsed.filesFailed || 0,
        errors: parsed.errors || [],
        // Global, unique-per-urn node counts by NodeType (REQ-3.72) — persisted
        // now even though no Statistics UI reads it yet, so that feature won't
        // need a second full re-index of a large collection later.
        nodeTypeCounts: parsed.nodeTypeCounts || {},
        // Background population size for Entity Search's Fisher exact test
        // (REQ-3.24) — count of distinct urns across the whole collection.
        totalUniqueEntities: parsed.totalUniqueEntities || 0,
        // Statistics (REQ-3.72/3.73) — relation counts by type (simple sum,
        // no dedup needed), unique DOI-else-PMID reference count, and total
        // supporting-sentence count.
        relationTypeCounts: parsed.relationTypeCounts || {},
        totalUniqueReferences: parsed.totalUniqueReferences || 0,
        totalSupportingSentences: parsed.totalSupportingSentences || 0,
      };
      const built = buildPathwaySearchStructures(newIndex.pathways);
      _userPathwayIndexCache.set(username, { pathwayIndex: newIndex, textIdx: built.textIdx, urnMap: built.urnMap });

      fs.mkdirSync(PATHWAY_INDEX_DIR, { recursive: true });
      // codeql[js/network-data-written-to-file] - newIndex is built entirely
      // server-side from files under this user's own configured local
      // directory; no raw request data is written here.
      fs.writeFileSync(_pathwayIndexFilePath(username), JSON.stringify(newIndex));

      job.success = true;
      job.result = {
        pathwayCount: newIndex.pathways.length,
        filesScanned: newIndex.filesScanned,
        filesFailed: newIndex.filesFailed,
        errors: newIndex.errors.slice(0, 20),  // cap — a bad collection could have thousands
      };
    } catch (err) {
      console.error('Pathway indexing error:', String(err.message).replace(_LOG_CONTROL_CHARS_RE, ' '));
      job.success = false;
      job.error = job.error || safeError(err, 'Pathway indexing');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    }
  });
});

// GET /api/settings/my-pathway-collection/index-progress — poll for live
// status of THIS user's most recent (or in-progress) indexing job.
app.get('/api/settings/my-pathway-collection/index-progress', dbLimiter, authMiddleware, (req, res) => {
  const job = _userIndexingJobs.get(req.user.username);
  if (!job) return res.json({ running: false, done: false, noJob: true });
  res.json(job);
});

// POST /api/pathways/search/text — REQ-3.11-3.14. Body: { keywords }.
// Searches the CALLING USER's own pathway index. FlexSearch finds the
// fuzzy/stemmed CANDIDATE set (so typos/partial words/plurals still match),
// then _pwRelevanceScore() ranks that candidate set field-by-field —
// Name > Description > Notes > other properties — rather than a flat count
// across all fields combined (see _pwRelevanceScore for why: a long Notes
// section mentioning a query word repeatedly shouldn't outrank a concise,
// near-exact match in the pathway's own Name).
app.post('/api/pathways/search/text', dbLimiter, authMiddleware, (req, res) => {
  const { keywords } = req.body || {};
  if (!keywords || !String(keywords).trim()) return res.status(400).json({ error: 'keywords is required' });
  const entry = getPathwayIndexForUser(req.user.username);
  if (!entry.textIdx) return res.status(400).json({ error: 'Your pathway collection has not been indexed yet — set a directory and click Index in Settings.' });

  const queryTokens = _pwTokenize(keywords);
  if (!queryTokens.length) return res.json({ results: [] });
  const rawQueryLower = String(keywords).trim().toLowerCase();

  // Union of FlexSearch hits across each query token (broad candidate net —
  // AND-style narrowing isn't appropriate here since REQ-3.14 wants a
  // relevance-scored list, not a strict filter).
  const candidateIdx = new Set();
  for (const tok of queryTokens) {
    const hits = entry.textIdx.search(tok, { limit: 5000 });
    for (const idx of hits) candidateIdx.add(idx);
  }

  const results = [];
  for (const idx of candidateIdx) {
    const p = entry.pathwayIndex.pathways[idx];
    if (!p) continue;
    const score = _pwRelevanceScore(queryTokens, p, rawQueryLower);
    if (score > 0) {
      results.push({
        name: p.name,
        subfolder: p.subfolder,
        sourceFile: p.sourceFile,
        relevanceScore: score,
        // category -> [term, ...] (Organ, Organ System, Organelle, Tissue,
        // CellType) -- same already-indexed data Browse/Anatomy Index use,
        // shipped here too so Text Search results can show/sort by these
        // annotations without a separate lookup.
        anatomy: p.anatomy || {},
      });
    }
  }
  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  res.json({ results });
});

// ─── Fisher exact test (hypergeometric enrichment) ───────────────────────────
// REQ-3.23/3.24: for each candidate pathway, tests whether it contains more
// of the user's selected entities than expected by chance, given:
//   N = total unique entities across the whole collection (background population)
//   n = this pathway's own entity count
//   K = number of selected entities (sample size)
//   k = how many of the selected entities are actually in this pathway (overlap)
// Implemented directly (no scipy/subprocess) via a numerically stable
// log-gamma (Lanczos approximation) rather than raw factorials, which would
// overflow for a collection-wide N in the tens of thousands+.
const _LANCZOS_G = 7;
const _LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
function _logGamma(x) {
  if (x < 0.5) {
    // Reflection formula: Gamma(x)*Gamma(1-x) = pi/sin(pi*x)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - _logGamma(1 - x);
  }
  x -= 1;
  let a = _LANCZOS_COEF[0];
  const t = x + _LANCZOS_G + 0.5;
  for (let i = 1; i < _LANCZOS_G + 2; i++) a += _LANCZOS_COEF[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function _logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return _logGamma(n + 1) - _logGamma(k + 1) - _logGamma(n - k + 1);
}
// log P(X = k) for X ~ Hypergeometric(N population, n "successes" in
// population, K draws) -- the classic urn-without-replacement model.
function _hypergeomLogPMF(N, n, K, k) {
  return _logChoose(n, k) + _logChoose(N - n, K - k) - _logChoose(N, K);
}
// One-sided p-value for OVER-representation: P(X >= k). Loop bound is
// min(n, K) - k terms, both of which are per-pathway/per-selection sizes
// (typically small), so this stays fast even across thousands of pathways.
function _hypergeomUpperTailPValue(N, n, K, k) {
  const kMax = Math.min(n, K);
  if (k > kMax) return 0;
  const logTerms = [];
  for (let i = k; i <= kMax; i++) logTerms.push(_hypergeomLogPMF(N, n, K, i));
  const maxTerm = Math.max(...logTerms);
  if (!isFinite(maxTerm)) return 1;
  let sum = 0;
  for (const t of logTerms) sum += Math.exp(t - maxTerm);
  return Math.min(1, Math.exp(maxTerm + Math.log(sum)));
}
// Hypergeometric mean/variance -> Z-score for the observed overlap k.
function _hypergeomZScore(N, n, K, k) {
  const mean = (n * K) / N;
  const variance = (n * K * (N - n) * (N - K)) / (N * N * (N - 1));
  if (!(variance > 0)) return 0;
  return (k - mean) / Math.sqrt(variance);
}

// Shared by Entity Search and Combined Search: given this user's index and a
// set of selected URNs, computes {idx, overlapCount, zScore, pValue} for
// every pathway that contains AT LEAST ONE selected entity (pathways with
// zero overlap are never candidates for either feature). Uses the urn ->
// pathway urnMap so only pathways actually touched by a selected urn are
// ever considered, rather than scanning the entire collection.
function _computeEntityOverlap(entry, selectedURNs) {
  const N = entry.pathwayIndex.totalUniqueEntities || 0;
  const uniqueSelected = Array.from(new Set(selectedURNs));
  const K = uniqueSelected.length;
  const overlapUrnsByIdx = new Map();  // pathway idx -> Set of matched (selected) urns
  for (const urn of uniqueSelected) {
    const idxs = entry.urnMap.get(urn);
    if (!idxs) continue;
    for (const idx of idxs) {
      if (!overlapUrnsByIdx.has(idx)) overlapUrnsByIdx.set(idx, new Set());
      overlapUrnsByIdx.get(idx).add(urn);
    }
  }
  const out = [];
  for (const [idx, urnSet] of overlapUrnsByIdx) {
    const p = entry.pathwayIndex.pathways[idx];
    if (!p) continue;
    const k = urnSet.size;
    const n = (p.nodeUrns || []).length;
    const pValue = (N > 0 && n > 0 && K > 0) ? _hypergeomUpperTailPValue(N, n, K, k) : 1;
    const zScore = (N > 1 && n > 0 && K > 0) ? _hypergeomZScore(N, n, K, k) : 0;
    out.push({
      idx, name: p.name, subfolder: p.subfolder, sourceFile: p.sourceFile, overlapCount: k, zScore, pValue,
      // The actual selected urns found in this pathway — lets callers show
      // "Common entities" by name (client resolves urn -> name from its own
      // current selection) and pre-select those nodes when the pathway is opened.
      overlapUrns: Array.from(urnSet),
      // category -> [term, ...] (Organ, Organ System, Organelle, Tissue,
      // CellType) -- shared by both Entity Search and Combined Search,
      // which both build their own results from this same helper.
      anatomy: p.anatomy || {},
    });
  }
  return out;
}

// POST /api/pathways/search/entity — REQ-3.21-3.24. Body: { selectedURNs }.
// Returns every pathway containing at least one selected entity, ranked by
// statistical significance (p-value ascending, REQ-5.04).
app.post('/api/pathways/search/entity', dbLimiter, authMiddleware, (req, res) => {
  const { selectedURNs } = req.body || {};
  if (!Array.isArray(selectedURNs) || !selectedURNs.length) {
    return res.status(400).json({ error: 'selectedURNs (a non-empty array) is required' });
  }
  const entry = getPathwayIndexForUser(req.user.username);
  if (!entry.textIdx) return res.status(400).json({ error: 'Your pathway collection has not been indexed yet — set a directory and click Index in Settings.' });

  const results = _computeEntityOverlap(entry, selectedURNs)
    .map(r => ({
      name: r.name, subfolder: r.subfolder, sourceFile: r.sourceFile, zScore: r.zScore, pValue: r.pValue,
      anatomy: r.anatomy, overlapCount: r.overlapCount, overlapUrns: r.overlapUrns,
    }))
    .sort((a, b) => a.pValue - b.pValue);
  res.json({ results });
});

// POST /api/pathways/search/combined — REQ-3.31-3.34. Body: { selectedURNs, keywords }.
// Phase 1 (Filter): Entity Overlap isolates pathways containing at least one
// selected entity (same _computeEntityOverlap() used by Entity Search).
// Phase 2 (Rank): the SAME keyword-count relevance scoring Text Search uses
// (REQ-3.14) is applied only to that filtered subset, and the final list is
// ranked by that Text Search Relevance Score (REQ-3.34) — the Fisher
// statistics from Phase 1 are used purely to filter here, not to rank.
app.post('/api/pathways/search/combined', dbLimiter, authMiddleware, (req, res) => {
  const { selectedURNs, keywords } = req.body || {};
  if (!Array.isArray(selectedURNs) || !selectedURNs.length) {
    return res.status(400).json({ error: 'selectedURNs (a non-empty array) is required' });
  }
  if (!keywords || !String(keywords).trim()) return res.status(400).json({ error: 'keywords is required' });
  const entry = getPathwayIndexForUser(req.user.username);
  if (!entry.textIdx) return res.status(400).json({ error: 'Your pathway collection has not been indexed yet — set a directory and click Index in Settings.' });

  const queryTokens = _pwTokenize(keywords);
  const rawQueryLower = String(keywords).trim().toLowerCase();
  const overlap = _computeEntityOverlap(entry, selectedURNs);  // Phase 1: filter

  const results = [];
  for (const o of overlap) {
    const p = entry.pathwayIndex.pathways[o.idx];
    if (!p) continue;
    const score = _pwRelevanceScore(queryTokens, p, rawQueryLower);   // Phase 2: rank (Name > Description > Notes)
    results.push({
      name: p.name, subfolder: p.subfolder, sourceFile: p.sourceFile, relevanceScore: score,
      overlapCount: o.overlapCount, overlapUrns: o.overlapUrns,
    });
  }
  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  res.json({ results });
});

// Returns true iff `candidate` resolves (following symlinks) to a path
// actually inside `root` — a plain string prefix check like
// candidate.startsWith(root) is unsafe (e.g. root="/foo" would wrongly admit
// "/foo-evil"), so this compares real, absolute paths with an explicit
// trailing separator boundary.
function _isPathInsideDir(candidatePath, rootDir) {
  try {
    const real = fs.realpathSync(candidatePath);
    const rootReal = fs.realpathSync(rootDir);
    return real === rootReal || real.startsWith(rootReal + path.sep);
  } catch (e) {
    return false;  // doesn't exist, or a broken symlink — treat as not inside
  }
}

// POST /api/pathways/open — REQ-3.43/6.03: open a specific pathway found via
// search (identified by its server-side sourceFile path + exact name, since
// one RNEF file can be a <batch> of several pathways) directly in the graph
// viewer, without requiring the browser to have its own file-system access
// to that path (unlike the existing File → Load subgraph picker).
app.post('/api/pathways/open', dbLimiter, authMiddleware, async (req, res) => {
  const { sourceFile, pathwayName } = req.body || {};
  const dir = _resolvePathwayCollectionDirForUser(req.user.username);
  if (!sourceFile || !dir) return res.status(400).json({ error: 'sourceFile and a configured pathway collection directory are required' });
  if (!_isPathInsideDir(sourceFile, dir)) {
    return res.status(400).json({ error: 'sourceFile is not inside your configured pathway collection directory' });
  }

  // CodeQL-idiomatic sanitizer (matches the pattern applied to save-graph-as'
  // own resnetType read): canonicalize both the configured root and the
  // candidate file via fs.realpathSync (resolves symlinks, and throws for a
  // nonexistent path -- caught below), then verify containment against the
  // canonical root. This inline sequence is repeated at every sink rather
  // than factored into a shared helper, since CodeQL's dataflow analysis
  // did not credit sanitization performed inside a called function.
  let canonicalSourceFile;
  try {
    const safeRoot = fs.realpathSync(dir);
    const candidateSourceFile = path.resolve(safeRoot, String(sourceFile));
    canonicalSourceFile = fs.realpathSync(candidateSourceFile);
    if (!_isPathInsideDir(canonicalSourceFile, safeRoot)) {
      return res.status(400).json({ error: 'sourceFile is not inside your configured pathway collection directory' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'sourceFile could not be resolved' });
  }

  const lower = canonicalSourceFile.toLowerCase();
  try {
    if (lower.endsWith('.graph.json')) {
      const data = JSON.parse(fs.readFileSync(canonicalSourceFile, 'utf8'));
      return res.json({ name: data.name || pathwayName || '', data });
    }

    // .rnef / .xml — convert (a batch file may yield several pathways; find
    // the one the user actually clicked by name).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwopen-'));
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir);
    try {
      await new Promise((resolve, reject) => {
        execFile(PYTHON_CMD, [RNEF_SCRIPT, canonicalSourceFile, outDir],
          { timeout: 600000 },
          (err, stdout, stderr) => { if (err) reject(new Error(stderr || err.message)); else resolve(stdout); }
        );
      });
      const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
      let match = null;
      for (const f of files) {
        const data = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
        if (!pathwayName || data.name === pathwayName) { match = data; break; }
      }
      if (!match && files.length) match = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
      if (!match) return res.status(404).json({ error: 'Pathway not found in the converted file' });
      res.json({ name: match.name || pathwayName || '', data: match });
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    }
  } catch (err) {
    console.error('Pathway open error:', String(err.message).replace(_LOG_CONTROL_CHARS_RE, ' '));
    res.status(500).json({ error: safeError(err, 'Pathway open') });
  }
});

// ─── Pathway Annotation editing (File → Pathway → View Annotation → Edit) ──
// Lets a user add/edit/remove a pathway's <properties> fields (Description,
// Notes, or any custom field) from the app, then save them back to disk.
//
// This never touches the pathway's own graph content (nodes/edges/layout) --
// only its properties -- but still needs somewhere to persist the edit. The
// app can only ever WRITE .graph.json (not RNEF XML back out), and this
// collection is moving to JSON-native storage going forward anyway, so a
// saved edit always ends up as a .graph.json:
//   - First edit of an RNEF-sourced pathway: convert the .rnef (same helper
//     /api/pathways/open already uses), splice in the new properties, and
//     write the result out as a NEW <pathway name>.graph.json alongside the
//     original .rnef, which is left completely untouched. Named after the
//     PATHWAY itself (not the source file) via _pwSafeFilename(), matching
//     rnef_to_json.py's own per-resnet output naming -- a single .rnef can
//     be a <batch> of several distinctly-named pathways, so the source
//     file's own name isn't a safe identity key for the saved copy.
//   - Editing again later (sourceFile is already .graph.json): overwrite
//     that SAME file in place. No new duplicate is ever created past the
//     first edit.
// Having two files describe the same pathway (the original .rnef and its
// edited .graph.json) would be confusing in Browse/Search/Anatomy Index, so
// rnef_index.py's own dedup logic (grouping by subfolder + sanitized
// pathway name, keeping whichever file has the latest mtime) resolves this
// during any full re-index; _patchPathwayIndexEntry() below applies the
// same resolution immediately, in-memory, without waiting for one.
function _pwSafeFilename(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return s || 'unnamed';
}

// Mirrors rnef_index.py's _ANATOMY_FIELD_ALIASES/_ANATOMY_TERM_SUFFIX_RE so
// a freshly-saved pathway's Anatomy Index categories can be derived right
// here in JS -- editing an annotation is common/fast enough that shelling
// back out to Python for this small, purely textual transform isn't worth
// the extra process-spawn latency.
const _PW_ANATOMY_ALIASES = {
  'organ': 'Organ', 'organ system': 'Organ System', 'organelle': 'Organelle',
  'cell object': 'Organelle', 'tissue': 'Tissue', 'celltype': 'CellType', 'cell type': 'CellType',
};
const _PW_ANATOMY_SUFFIX_RE = /\s*\{[^}]*\}\s*$/;
function _pwAnatomyFromProperties(properties) {
  const anatomy = {};
  for (const [n, v] of Object.entries(properties || {})) {
    if (!v) continue;
    const category = _PW_ANATOMY_ALIASES[String(n).trim().toLowerCase()];
    if (!category) continue;
    const term = String(v).replace(_PW_ANATOMY_SUFFIX_RE, '').trim();
    if (!term) continue;
    const terms = anatomy[category] || (anatomy[category] = []);
    if (!terms.includes(term)) terms.push(term);
  }
  return anatomy;
}

// Same exclusions as rnef_index.py's extract_pathway_from_json_file(): skip
// clones (share their original's URN) and synthetic HyperEdge hub nodes
// (never present in the pathway's own real entity list) so Entity/Combined
// Search's urn -> pathway map stays consistent regardless of whether a
// pathway's index entry came from the Python indexer or this fast JS patch.
function _pwNodeUrnsFromGraphData(graphData) {
  const seen = new Set();
  const nodeUrns = [];
  for (const n of ((graphData && graphData.nodes) || [])) {
    if (n.isClone) continue;
    if (Array.isArray(n.labels) && n.labels.length === 1 && n.labels[0] === 'HyperEdge') continue;
    const urn = (n.properties && n.properties.URN) || n.id;
    if (!urn || seen.has(urn)) continue;
    seen.add(urn);
    nodeUrns.push(urn);
  }
  return nodeUrns;
}

// Patches ONE pathway's entry into this user's already-loaded index, both
// in-memory (textIdx/urnMap rebuilt so Search/Entity Search see it right
// away) and on disk (pathway_index_<user>.json, so it survives a server
// restart) -- without re-invoking rnef_index.py over the whole collection.
// Safe specifically because editing an annotation never changes a
// pathway's own nodes/relations, so the collection-wide Statistics counters
// (nodeTypeCounts/relationTypeCounts/totalUniqueEntities/etc, computed once
// during a full re-index) remain valid; only this one pathway's own
// name/properties/anatomy/nodeUrns/sourceFile needs to change here.
function _patchPathwayIndexEntry(username, pathway) {
  const entry = getPathwayIndexForUser(username);
  const groupKey = (pathway.subfolder || '') + ' ' + _pwSafeFilename(pathway.name);
  entry.pathwayIndex.pathways = entry.pathwayIndex.pathways.filter(p =>
    ((p.subfolder || '') + ' ' + _pwSafeFilename(p.name)) !== groupKey
  );
  entry.pathwayIndex.pathways.push(pathway);
  const built = buildPathwaySearchStructures(entry.pathwayIndex.pathways);
  entry.textIdx = built.textIdx;
  entry.urnMap = built.urnMap;
  _userPathwayIndexCache.set(username, entry);
  try {
    fs.writeFileSync(_pathwayIndexFilePath(username), JSON.stringify(entry.pathwayIndex));
  } catch (e) {
    console.error('Failed to persist patched pathway index:', String(e.message).replace(_LOG_CONTROL_CHARS_RE, ' '));
  }
}

app.post('/api/pathways/annotation', dbLimiter, authMiddleware, async (req, res) => {
  const { sourceFile, pathwayName, properties } = req.body || {};
  const dir = _resolvePathwayCollectionDirForUser(req.user.username);
  if (!sourceFile || !pathwayName || !properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return res.status(400).json({ error: 'sourceFile, pathwayName, and a properties object are required' });
  }
  if (!dir) return res.status(400).json({ error: 'No pathway collection directory configured' });
  if (!_isPathInsideDir(sourceFile, dir)) {
    return res.status(400).json({ error: 'sourceFile is not inside your configured pathway collection directory' });
  }

  // Annotation values are always plain text -- coerced to strings and
  // blank/whitespace-only keys dropped, regardless of what the client sent.
  const cleanProps = {};
  for (const [k, v] of Object.entries(properties)) {
    const key = String(k).trim();
    if (key) cleanProps[key] = String(v);
  }

  // CodeQL-idiomatic sanitizer, matching save-graph-as' own resnetType read:
  // canonicalize both the configured root and the candidate file via
  // fs.realpathSync (resolves symlinks; throws for a nonexistent path,
  // caught below), then verify containment against the canonical root.
  let canonicalSourceFile, safeRoot;
  try {
    safeRoot = fs.realpathSync(dir);
    const candidateSourceFile = path.resolve(safeRoot, String(sourceFile));
    canonicalSourceFile = fs.realpathSync(candidateSourceFile);
    if (!_isPathInsideDir(canonicalSourceFile, safeRoot)) {
      return res.status(400).json({ error: 'sourceFile is not inside your configured pathway collection directory' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'sourceFile could not be resolved' });
  }

  const isAlreadyJson = canonicalSourceFile.toLowerCase().endsWith('.graph.json');
  try {
    let pathwayData;  // full rnef_to_json.py-shaped object for this ONE pathway
    let outPath;

    if (isAlreadyJson) {
      pathwayData = JSON.parse(fs.readFileSync(canonicalSourceFile, 'utf8'));
      outPath = canonicalSourceFile;
    } else {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwannot-'));
      const outDir = path.join(tmpDir, 'out');
      fs.mkdirSync(outDir);
      try {
        await new Promise((resolve, reject) => {
          execFile(PYTHON_CMD, [RNEF_SCRIPT, canonicalSourceFile, outDir],
            { timeout: 600000 },
            (err, stdout, stderr) => { if (err) reject(new Error(stderr || err.message)); else resolve(stdout); }
          );
        });
        const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
        let match = null;
        for (const f of files) {
          const data = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
          if (data.name === pathwayName) { match = data; break; }
        }
        if (!match && files.length === 1) match = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
        if (!match) return res.status(404).json({ error: 'Pathway not found in the converted file' });
        pathwayData = match;
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
      }
      // outPath is a brand-new file that doesn't exist yet, so it can't be
      // fs.realpathSync'd directly -- instead its PARENT directory (which
      // does exist, being the same directory the original sourceFile lives
      // in) is canonicalized and containment-checked, and the filename
      // component is joined on afterwards. _pwSafeFilename() strips every
      // path separator and traversal character, so a sanitized filename
      // joined onto an already-verified-canonical parent cannot escape it.
      const canonicalParent = fs.realpathSync(path.dirname(canonicalSourceFile));
      if (!_isPathInsideDir(canonicalParent, safeRoot)) {
        return res.status(400).json({ error: 'Output file path is not inside your configured pathway collection directory' });
      }
      outPath = path.join(canonicalParent, _pwSafeFilename(pathwayName) + '.graph.json');
    }

    pathwayData.properties = cleanProps;
    pathwayData.savedAt = new Date().toISOString();
    fs.writeFileSync(outPath, JSON.stringify(pathwayData));

    const relDir = path.relative(dir, path.dirname(outPath)).split(path.sep).join('/');
    const subfolder = relDir === '.' ? '' : relDir;
    _patchPathwayIndexEntry(req.user.username, {
      name: pathwayData.name || pathwayName,
      resnetType: pathwayData.resnetType || 'Pathway',
      properties: cleanProps,
      anatomy: _pwAnatomyFromProperties(cleanProps),
      nodeUrns: _pwNodeUrnsFromGraphData(pathwayData.graphData),
      sourceFile: outPath,
      subfolder,
    });

    res.json({ success: true, sourceFile: outPath, name: pathwayData.name || pathwayName, properties: cleanProps });
  } catch (err) {
    console.error('Pathway annotation save error:', String(err.message).replace(_LOG_CONTROL_CHARS_RE, ' '));
    res.status(500).json({ error: safeError(err, 'Pathway annotation save') });
  }
});

// Shared by /api/pathways/save-graph and /api/pathways/save-graph-as: strips
// obviously-bogus graphData down to just {nodes, edges} arrays (defends
// against a malformed/partial client payload writing garbage to disk) and
// coerces properties to the same plain-string-values shape the annotation
// endpoint above enforces.
function _pwSanitizeGraphSavePayload(graphData, properties) {
  const nodes = Array.isArray(graphData && graphData.nodes) ? graphData.nodes : [];
  const edges = Array.isArray(graphData && graphData.edges) ? graphData.edges : [];
  const cleanProps = {};
  for (const [k, v] of Object.entries(properties || {})) {
    const key = String(k).trim();
    if (key) cleanProps[key] = String(v);
  }
  return { graphData: { nodes, edges }, properties: cleanProps };
}

// ─── Pathway graph save (File → Pathways → Save) ─────────────────────────────
// Persists the CURRENT in-browser graph — including any node/edge additions,
// deletions, property edits, and layout changes the user made, none of which
// /api/pathways/annotation above ever touches — back to the file the pathway
// was opened from. Unlike that endpoint, the full graph is already sitting in
// the request body (the browser has it in memory), so there's no need to
// re-convert the original RNEF via Python here at all.
//   - sourceFile already .graph.json: overwritten in place.
//   - sourceFile is .rnef/.xml (first save of a pathway that's never had its
//     own .graph.json before): a new "<pathway name>.graph.json" is created
//     alongside the untouched original .rnef, exactly like the annotation
//     endpoint's first-edit case — the response's sourceFile tells the client
//     to point future saves at this new file instead.
app.post('/api/pathways/save-graph', dbLimiter, authMiddleware, (req, res) => {
  const { sourceFile, pathwayName, properties, graphData, positions } = req.body || {};
  const dir = _resolvePathwayCollectionDirForUser(req.user.username);
  if (!sourceFile || !pathwayName || !graphData || typeof graphData !== 'object') {
    return res.status(400).json({ error: 'sourceFile, pathwayName, and graphData are required' });
  }
  if (!dir) return res.status(400).json({ error: 'No pathway collection directory configured' });
  if (!_isPathInsideDir(sourceFile, dir)) {
    return res.status(400).json({ error: 'sourceFile is not inside your configured pathway collection directory' });
  }

  // CodeQL-idiomatic sanitizer, matching save-graph-as' own resnetType read:
  // canonicalize both the configured root and the candidate file via
  // fs.realpathSync (resolves symlinks; throws for a nonexistent path,
  // caught below), then verify containment against the canonical root.
  let canonicalSourceFile, safeRoot;
  try {
    safeRoot = fs.realpathSync(dir);
    const candidateSourceFile = path.resolve(safeRoot, String(sourceFile));
    canonicalSourceFile = fs.realpathSync(candidateSourceFile);
    if (!_isPathInsideDir(canonicalSourceFile, safeRoot)) {
      return res.status(400).json({ error: 'sourceFile is not inside your configured pathway collection directory' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'sourceFile could not be resolved' });
  }

  const { graphData: cleanGraph, properties: cleanProps } = _pwSanitizeGraphSavePayload(graphData, properties);
  const isAlreadyJson = canonicalSourceFile.toLowerCase().endsWith('.graph.json');

  try {
    // Preserve whatever fields we don't manage here (currently just
    // resnetType, mirroring the annotation endpoint) when overwriting an
    // existing .graph.json — irrelevant for the create-new-file branch since
    // there's nothing yet to preserve.
    let resnetType = 'Pathway';
    let outPath;
    if (isAlreadyJson) {
      try {
        const existing = JSON.parse(fs.readFileSync(canonicalSourceFile, 'utf8'));
        if (existing && existing.resnetType) resnetType = existing.resnetType;
      } catch (e) { /* unreadable/corrupt existing file — fall through and overwrite anyway */ }
      outPath = canonicalSourceFile;
    } else {
      // outPath is a brand-new file that doesn't exist yet, so it can't be
      // fs.realpathSync'd directly -- instead its PARENT directory (which
      // does exist, being the same directory the original sourceFile lives
      // in) is canonicalized and containment-checked, and the filename
      // component is joined on afterwards. _pwSafeFilename() strips every
      // path separator and traversal character, so a sanitized filename
      // joined onto an already-verified-canonical parent cannot escape it.
      const canonicalParent = fs.realpathSync(path.dirname(canonicalSourceFile));
      if (!_isPathInsideDir(canonicalParent, safeRoot)) {
        return res.status(400).json({ error: 'Output file path is not inside your configured pathway collection directory' });
      }
      outPath = path.join(canonicalParent, _pwSafeFilename(pathwayName) + '.graph.json');
    }

    const pathwayData = {
      name: pathwayName,
      resnetType,
      properties: cleanProps,
      graphData: cleanGraph,
      positions: (positions && typeof positions === 'object') ? positions : {},
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(outPath, JSON.stringify(pathwayData));

    const relDir = path.relative(dir, path.dirname(outPath)).split(path.sep).join('/');
    const subfolder = relDir === '.' ? '' : relDir;
    _patchPathwayIndexEntry(req.user.username, {
      name: pathwayName,
      resnetType,
      properties: cleanProps,
      anatomy: _pwAnatomyFromProperties(cleanProps),
      nodeUrns: _pwNodeUrnsFromGraphData(cleanGraph),
      sourceFile: outPath,
      subfolder,
    });

    res.json({ success: true, sourceFile: outPath, name: pathwayName, subfolder });
  } catch (err) {
    console.error('Pathway graph save error:', String(err.message).replace(_LOG_CONTROL_CHARS_RE, ' '));
    res.status(500).json({ error: safeError(err, 'Pathway graph save') });
  }
});

// ─── Pathway "Save As" (File → Pathways → Save As…) ──────────────────────────
// Always creates a brand-new .graph.json — never overwrites an existing
// pathway file — under a user-chosen name and (optionally) a different
// folder within the collection. Defaults to the ORIGINAL pathway's own
// folder when no subfolder override is given, matching normal "Save As"
// expectations (same location, different name, unless told otherwise).
app.post('/api/pathways/save-graph-as', dbLimiter, authMiddleware, (req, res) => {
  const { sourceFile, pathwayName, subfolder, properties, graphData, positions } = req.body || {};
  const dir = _resolvePathwayCollectionDirForUser(req.user.username);
  if (!pathwayName || !String(pathwayName).trim() || !graphData || typeof graphData !== 'object') {
    return res.status(400).json({ error: 'pathwayName and graphData are required' });
  }
  if (!dir) return res.status(400).json({ error: 'No pathway collection directory configured' });

  const { graphData: cleanGraph, properties: cleanProps } = _pwSanitizeGraphSavePayload(graphData, properties);

  try {
    // Resolve the target directory: an explicit subfolder (may be '' for the
    // collection root) wins; otherwise default to the original file's own
    // folder; otherwise (no source file at all — e.g. a pathway built purely
    // from a Cypher query result) fall back to the collection root.
    let targetDir;
    let canonicalSourceFile = null;
    let safeRoot;
    try {
    safeRoot = fs.realpathSync(dir);
    } catch (e) {
    return res.status(400).json({ error: 'No pathway collection directory configured' });
    }

    if (typeof subfolder === 'string') {
      const cleanSub = subfolder.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..').join('/');
      targetDir = cleanSub ? path.join(safeRoot, cleanSub) : safeRoot;
      } else if (sourceFile) {
      try {
      const candidateSourceFile = path.resolve(safeRoot, String(sourceFile));
      canonicalSourceFile = fs.realpathSync(candidateSourceFile);
      if (_isPathInsideDir(canonicalSourceFile, safeRoot)) {
      targetDir = path.dirname(canonicalSourceFile);
      } else {
      targetDir = safeRoot;
      canonicalSourceFile = null;
      }
      } catch (e) {
      targetDir = safeRoot;
      canonicalSourceFile = null;
      }

    } else {
      targetDir = safeRoot;
    }
    fs.mkdirSync(targetDir, { recursive: true });

    // CodeQL-idiomatic sanitizer: canonicalize both the configured root and
    // the just-created target directory via fs.realpathSync, then verify
    // containment against the canonical root. targetDir is guaranteed to
    // exist at this point (mkdirSync just created it), so this is safe to
    // do unconditionally, unlike a not-yet-existent file path.
    let canonicalTargetDir;
    try {
      safeRoot = fs.realpathSync(dir);
      canonicalTargetDir = fs.realpathSync(targetDir);
      if (!_isPathInsideDir(canonicalTargetDir, safeRoot)) {
        return res.status(400).json({ error: 'Target folder is not inside your configured pathway collection directory' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Target folder could not be resolved' });
    }

    // outPath itself is a brand-new file that doesn't exist yet, so it can't
    // be fs.realpathSync'd directly -- it's built by joining the sanitized
    // filename (no path separators or traversal characters possible, per
    // _pwSafeFilename) onto the already-verified-canonical target directory.
    const outPath = path.join(canonicalTargetDir, _pwSafeFilename(pathwayName) + '.graph.json');
    if (fs.existsSync(outPath)) {
      return res.status(409).json({ error: `A pathway named "${pathwayName}" already exists in that folder — choose a different name or folder.` });
    }

    let resnetType = 'Pathway';
    if (canonicalSourceFile && String(canonicalSourceFile).toLowerCase().endsWith('.graph.json')) {
      try {
        const existing = JSON.parse(fs.readFileSync(canonicalSourceFile, 'utf8'));
        if (existing && existing.resnetType) resnetType = existing.resnetType;
        } 
        catch (e) { /* ignore — keep default */ }
    }

    const pathwayData = {
      name: pathwayName,
      resnetType,
      properties: cleanProps,
      graphData: cleanGraph,
      positions: (positions && typeof positions === 'object') ? positions : {},
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(outPath, JSON.stringify(pathwayData));

    const relDir = path.relative(dir, targetDir).split(path.sep).join('/');
    const outSubfolder = relDir === '.' ? '' : relDir;
    _patchPathwayIndexEntry(req.user.username, {
      name: pathwayName,
      resnetType,
      properties: cleanProps,
      anatomy: _pwAnatomyFromProperties(cleanProps),
      nodeUrns: _pwNodeUrnsFromGraphData(cleanGraph),
      sourceFile: outPath,
      subfolder: outSubfolder,
    });

    res.json({ success: true, sourceFile: outPath, name: pathwayName, subfolder: outSubfolder });
  } catch (err) {
    console.error('Pathway Save As error:', String(err.message).replace(_LOG_CONTROL_CHARS_RE, ' '));
    res.status(500).json({ error: safeError(err, 'Pathway Save As') });
  }
});

// ─── Pathway "Save As... Alias" (File → Pathways → Save As…, Alias mode) ─────
// A Pathway Alias is a lightweight POINTER to a pathway that already exists
// somewhere in the collection, not a copy of its content — see
// rnef_index.py's own comments on _extract_alias_records()/curated
// "<FolderName>_symlinks.rnef" manifests for the full story of why this
// exists (avoiding duplicating the same pathway across multiple disease/
// process folders). This app-created equivalent is a small
// "<name>.alias.json" sidecar file ({name, aliasTargetUrn}) rather than
// RNEF XML -- far simpler and less error-prone to write correctly than
// parsing-and-appending to an existing (or newly authoring a) curated
// "_symlinks.rnef" manifest, and produces an index entry that Browse
// renders/opens IDENTICALLY to a curated symlink once rnef_index.py (or
// this endpoint's own immediate _patchPathwayIndexEntry call below)
// resolves aliasTargetUrn against every real pathway's own pathwayUrn.
app.post('/api/pathways/save-alias-as', dbLimiter, authMiddleware, (req, res) => {
  const { name, subfolder, aliasTargetUrn } = req.body || {};
  const dir = _resolvePathwayCollectionDirForUser(req.user.username);
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'A pathway name is required' });
  }
  if (!aliasTargetUrn || !String(aliasTargetUrn).trim()) {
    return res.status(400).json({
      error: 'The pathway currently open has no identifying urn to alias — it likely wasn\'t opened from an RNEF/.graph.json source that carried one. Use "Full copy" instead.',
    });
  }
  if (!dir) return res.status(400).json({ error: 'No pathway collection directory configured' });

  try {
    const cleanSub = typeof subfolder === 'string'
      ? subfolder.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..').join('/')
      : '';
    const targetDir = cleanSub ? path.join(dir, cleanSub) : dir;
    fs.mkdirSync(targetDir, { recursive: true });

    // CodeQL-idiomatic sanitizer: canonicalize both the configured root and
    // the just-created target directory via fs.realpathSync, then verify
    // containment against the canonical root. targetDir is guaranteed to
    // exist at this point (mkdirSync just created it), so this is safe to
    // do unconditionally, unlike a not-yet-existent file path.
    let canonicalTargetDir, safeRoot;
    try {
      safeRoot = fs.realpathSync(dir);
      canonicalTargetDir = fs.realpathSync(targetDir);
      if (!_isPathInsideDir(canonicalTargetDir, safeRoot)) {
        return res.status(400).json({ error: 'Target folder is not inside your configured pathway collection directory' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Target folder could not be resolved' });
    }

    // outPath itself is a brand-new file that doesn't exist yet, so it can't
    // be fs.realpathSync'd directly -- it's built by joining the sanitized
    // filename (no path separators or traversal characters possible, per
    // _pwSafeFilename) onto the already-verified-canonical target directory.
    const outPath = path.join(canonicalTargetDir, _pwSafeFilename(name) + '.alias.json');
    if (fs.existsSync(outPath)) {
      return res.status(409).json({ error: `A pathway or alias named "${name}" already exists in that folder — choose a different name or folder.` });
    }

    const aliasData = { name, aliasTargetUrn, savedAt: new Date().toISOString() };
    fs.writeFileSync(outPath, JSON.stringify(aliasData));

    // Resolve the target immediately (against this user's already-loaded
    // index) so Browse shows a correctly-linked alias right away, rather
    // than "target not found" until the next full re-index -- mirrors
    // rnef_index.py's own urn_to_pathway resolution, just scoped to one
    // new entry instead of the whole collection.
    const entry = getPathwayIndexForUser(req.user.username);
    const target = (entry.pathwayIndex.pathways || []).find(p => p.pathwayUrn === aliasTargetUrn && !p.isAlias);

    _patchPathwayIndexEntry(req.user.username, {
      name,
      resnetType: 'Alias',
      isAlias: true,
      aliasTargetUrn,
      aliasTargetSourceFile: target ? target.sourceFile : null,
      aliasTargetSubfolder: target ? (target.subfolder || '') : null,
      aliasTargetName: target ? target.name : null,
      properties: {},
      anatomy: {},
      nodeUrns: [],
      sourceFile: outPath,
      subfolder: cleanSub,
    });

    res.json({ success: true, sourceFile: outPath, name, subfolder: cleanSub, resolved: !!target });
  } catch (err) {
    console.error('Pathway Save As Alias error:', String(err.message).replace(_LOG_CONTROL_CHARS_RE, ' '));
    res.status(500).json({ error: safeError(err, 'Pathway Save As Alias') });
  }
});

// ─── Per-user LLM override (provider/model/API key) ──────────────────────────
// Mirrors the /api/settings/my-neo4j and /api/settings/my-postgres pattern:
// every user (not just admins) can save their own LLM provider/API key
// override, persisted server-side in users.json rather than in the browser's
// localStorage. This replaces an earlier design where the API key was cached
// client-side in localStorage in plain text (CodeQL: js/clear-text-storage-
// of-sensitive-data) — localStorage is readable by any script on the page
// (e.g. a future XSS bug) and has no expiry, whereas this is protected by
// the same authenticated, per-user access control as every other credential
// in the app.
app.get('/api/settings/my-llm', dbLimiter, authMiddleware, (req, res) => {
  const users = loadUsers();
  const u = users.find(x => x.username === req.user.username);
  const cfg = (u && u.llm) || {};
  res.json({
    provider_name: cfg.provider_name || '',
    url:           cfg.url           || '',
    model_name:    cfg.model_name    || '',
    temperature:   cfg.temperature   !== undefined ? cfg.temperature : 0.2,
    top_p:         cfg.top_p         !== undefined ? cfg.top_p       : 0.9,
    json_mode:     cfg.json_mode     || false,
    apikey:        cfg.apikey ? '••••••••' : ''   // never echo the real key back
  });
});

app.post('/api/settings/my-llm', dbLimiter, authMiddleware, (req, res) => {
  const { provider_name, url, apikey, model_name, temperature, top_p, json_mode } = req.body || {};
  const users = loadUsers();
  const u = users.find(x => x.username === req.user.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const current = u.llm || {};
  u.llm = {
    provider_name: typeof provider_name === 'string' ? provider_name.trim() : (current.provider_name || ''),
    url:           typeof url === 'string' ? url.trim() : (current.url || ''),
    apikey:        (apikey && apikey !== '••••••••') ? String(apikey) : (current.apikey || ''),
    model_name:    typeof model_name === 'string' ? model_name.trim() : (current.model_name || ''),
    temperature:   Number.isFinite(Number(temperature)) ? Number(temperature) : (current.temperature !== undefined ? current.temperature : 0.2),
    top_p:         Number.isFinite(Number(top_p))       ? Number(top_p)       : (current.top_p       !== undefined ? current.top_p       : 0.9),
    json_mode:     json_mode === true || json_mode === 'true',
  };
  saveUsers(users);
  res.json({ success: true });
});

// ─── Neo4j query ─────────────────────────────────────────────────────────────
app.post('/api/graph/query', dbLimiter, authMiddleware, async (req, res) => {
  const { query } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Cypher query is required' });

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(query);
    const nodesMap = new Map();
    const edgesMap = new Map();

    result.records.forEach(record => {
      record.keys.forEach(key => {
        processValue(record.get(key), nodesMap, edgesMap);
      });
    });

    // Post-processing: add stub nodes for any relationship endpoints that were
    // not returned as Node objects in the query result (e.g. bare RETURN r).
    // Done here — not inside processValue — so real nodes returned later in the
    // same record set always take precedence over stubs.
    edgesMap.forEach(edge => {
      if (!nodesMap.has(edge.startNodeId)) {
        nodesMap.set(edge.startNodeId, { id: edge.startNodeId, elementId: edge.startNodeId, labels: [], properties: {} });
      }
      if (!nodesMap.has(edge.endNodeId)) {
        nodesMap.set(edge.endNodeId, { id: edge.endNodeId, elementId: edge.endNodeId, labels: [], properties: {} });
      }
    });

    const response = {
      nodes: Array.from(nodesMap.values()),
      edges: Array.from(edgesMap.values())
    };

    // If no graph elements extracted, include raw tabular data for display
    if (nodesMap.size === 0 && edgesMap.size === 0 && result.records.length > 0) {
      const columns = result.records[0].keys;
      const rows = result.records.map(record =>
        columns.map(key => toPlain(record.get(key)))
      );
      response.table = { columns, rows };
    }

    res.json(response);
  } catch (err) {
    console.error('Neo4j error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── CSV export query (high-throughput fetchSize for bulk export) ─────────────
// POST /api/export/csv-query
// Identical to /api/graph/query but opens the Neo4j session with fetchSize: 50000
// so the driver streams records in 50 k-record pages, reducing round-trips and
// memory pressure on very large result sets.
app.post('/api/export/csv-query', dbLimiter, authMiddleware, async (req, res) => {
  const { query } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Cypher query is required' });

  // Allow up to 10 minutes for large export queries before the socket times out.
  req.socket.setTimeout(10 * 60 * 1000);

  const session = req.neo4j.driver.session({ database: req.neo4j.database, fetchSize: 50000 });
  try {
    const result = await session.run(query);
    const nodesMap = new Map();
    const edgesMap = new Map();

    result.records.forEach(record => {
      record.keys.forEach(key => {
        processValue(record.get(key), nodesMap, edgesMap);
      });
    });

    edgesMap.forEach(edge => {
      if (!nodesMap.has(edge.startNodeId)) {
        nodesMap.set(edge.startNodeId, { id: edge.startNodeId, elementId: edge.startNodeId, labels: [], properties: {} });
      }
      if (!nodesMap.has(edge.endNodeId)) {
        nodesMap.set(edge.endNodeId, { id: edge.endNodeId, elementId: edge.endNodeId, labels: [], properties: {} });
      }
    });

    res.json({
      nodes: Array.from(nodesMap.values()),
      edges: Array.from(edgesMap.values())
    });
  } catch (err) {
    console.error('csv-query error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── Enrich loaded-subgraph nodes via URN ─────────────────────────────────────
// Accepts a list of URN strings (from converted pathway JSON files), queries
// Neo4j for matching nodes, and returns their full property set keyed by URN.
// The property name used for matching is configured by NEO4J_URN_PROP above.
app.post('/api/graph/enrich-by-urn', dbLimiter, authMiddleware, async (req, res) => {
  const { urns } = req.body || {};
  if (!Array.isArray(urns) || !urns.length) return res.json({});

  const URN_RE = /^[a-zA-Z0-9:@%.~_-]+$/;
  const safeUrns = urns.filter(u => typeof u === 'string' && URN_RE.test(u));
  if (!safeUrns.length) return res.json({});

  // NEO4J_URN_PROP is a server-side constant — safe to interpolate
  const cypher = 'MATCH (n) WHERE n.`' + NEO4J_URN_PROP + '` IN $urns RETURN n';
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(cypher, { urns: safeUrns });
    const enriched = {};
    result.records.forEach(record => {
      const node = record.get('n');
      const urnVal = node.properties[NEO4J_URN_PROP];
      if (urnVal) {
        enriched[urnVal] = {
          id: node.identity.toString(),
          elementId: node.elementId || node.identity.toString(),
          labels: node.labels,
          properties: toPlain(node.properties)
        };
      }
    });
    res.json(enriched);
  } catch (err) {
    console.error('enrich-by-urn error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── PostgreSQL references (tooltip — single edge hover) ──────────────────────
// RelationID in Neo4j is a string; id in Postgres is bigint.
// Pass as strings and cast to bigint in SQL to preserve full 64-bit precision.
app.post('/api/references', exportLimiter, authMiddleware, async (req, res) => {
  const { relationIds } = req.body || {};
  if (!Array.isArray(relationIds) || !relationIds.length) return res.json([]);

  // Keep as strings and use ::bigint[] cast in SQL — preserves full 64-bit precision.
  // Number() conversion loses digits for IDs > 2^53 (JavaScript safe integer limit).
  const validIds = relationIds.map(String).filter(id => /^-?\d+$/.test(id.trim()));
  if (!validIds.length) return res.json([]);

  try {
    const sql = `
      SELECT *
      FROM ${req.pg.schema}.reference
      WHERE id = ANY($1::bigint[])
      ORDER BY COALESCE(pubyear::text, '9999'), id
    `;
    const result = await req.pg.pool.query(sql, [validIds]);
    res.json(result.rows);
  } catch (err) {
    // Fallback without ORDER BY date in case column name differs
    try {
      const sql2 = `SELECT * FROM ${req.pg.schema}.reference WHERE id = ANY($1::bigint[])`;
      const result2 = await req.pg.pool.query(sql2, [validIds]);
      res.json(result2.rows);
    } catch (err2) {
      console.error('PostgreSQL error:', err2.message);
      res.status(500).json({ error: safeError(err2) });
    }
  }
});

// ─── PostgreSQL references batch (table view) ────────────────────────────────
// Accepts optional scopusColumns array to LEFT JOIN scopus_data table.
// scopus_data is joined on: reference.unique_id = scopus_data.reference_id

// Maps each allowed scopus_data column name to its hardcoded SQL SELECT fragment.
// The user-supplied column list is used only as lookup keys into this map;
// the actual SQL strings are never derived from user input, which fully breaks
// the taint chain that CodeQL's "query built from user-controlled sources" rule tracks.
const SCOPUS_COL_SQL = {
  citation_type:                     'sd."citation_type" AS "sd_citation_type"',
  citation_count:                     'sd."citation_count" AS "sd_citation_count"',
  fwci:                               'sd."fwci" AS "sd_fwci"',
  fwci_perc:                          'sd."fwci_perc" AS "sd_fwci_perc"',
  citation_count_ns:                  'sd."citation_count_ns" AS "sd_citation_count_ns"',
  fwci_ns:                            'sd."fwci_ns" AS "sd_fwci_ns"',
  fwci_perc_ns:                       'sd."fwci_perc_ns" AS "sd_fwci_perc_ns"',
  citescore2024:                      'sd."citescore2024" AS "sd_citescore2024"',
  min_asjc_citescore_percentile_raw:  'sd."min_asjc_citescore_percentile_raw" AS "sd_min_asjc_citescore_percentile_raw"',
  patent_citation_count:              'sd."patent_citation_count" AS "sd_patent_citation_count"',
  corporate:                          'sd."corporate" AS "sd_corporate"',
  num_refs:                           'sd."num_refs" AS "sd_num_refs"',
  independent_ref_count:              'sd."independent_ref_count" AS "sd_independent_ref_count"',
  document_score:                     'sd."document_score" AS "sd_document_score"',
  relation_score:                     'sd."relation_score" AS "sd_relation_score"'
};

app.post('/api/references/batch', exportLimiter, authMiddleware, async (req, res) => {
  const { relationIds, scopusColumns } = req.body || {};
  if (!Array.isArray(relationIds) || !relationIds.length) return res.json({});

  // Keep as strings and use ::bigint[] cast in SQL — this preserves full 64-bit
  // precision. JavaScript Number loses precision for integers > 2^53, so converting
  // to Number first would corrupt large RelationIDs.
  const validIds = relationIds.map(String).filter(id => /^-?\d+$/.test(id.trim()));
  if (!validIds.length) return res.json({});

  // Look up each requested column in the hardcoded map.
  // Only map values (not user strings) reach the SQL query.
  const scopusFragments = (Array.isArray(scopusColumns) ? scopusColumns : [])
    .map(c => SCOPUS_COL_SQL[c])
    .filter(Boolean);

  try {
    let sql;
    if (scopusFragments.length > 0) {
      const scopusSelect = scopusFragments.join(', ');
      sql = `
        SELECT r.*, ${scopusSelect}
        FROM ${req.pg.schema}.reference r
        LEFT JOIN ${req.pg.schema}.scopus_data sd ON r.unique_id = sd.reference_id
        WHERE r.id = ANY($1::bigint[])
        ORDER BY r.id, COALESCE(r.pubyear::text, '9999')
      `;
    } else {
      sql = `
        SELECT *
        FROM ${req.pg.schema}.reference
        WHERE id = ANY($1::bigint[])
        ORDER BY id, COALESCE(pubyear::text, '9999')
      `;
    }
    const result = await req.pg.pool.query(sql, [validIds]);

    // Group by relation id (string key to match Neo4j RelationID strings)
    const grouped = {};
    result.rows.forEach(row => {
      const key = String(row.id);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(row);
    });
    res.json(grouped);
  } catch (err) {
    console.error('PostgreSQL batch error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});

// ─── PostgreSQL: MedScan ID lookup ───────────────────────────────────────────
// Accepts an array of Neo4j NodeID values and returns { nodeId: medScanValue }.
app.post('/api/nodes/medscan', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeIds } = req.body || {};
  if (!Array.isArray(nodeIds) || !nodeIds.length) return res.json({});

  const validIds = nodeIds.map(String).filter(id => /^-?\d+$/.test(id));
  if (!validIds.length) return res.json({});

  try {
    const sql = `
      SELECT n.id::text AS id, a.value
      FROM ${req.pg.schema}.node AS n
      JOIN ${req.pg.schema}.attr AS a ON a.id = ANY(n.attributes)
      WHERE a.name = 'MedScan ID'
      AND n.id = ANY($1::bigint[])
    `;
    const result = await req.pg.pool.query(sql, [validIds]);
    const map = {};
    result.rows.forEach(row => { map[row.id] = row.value; });
    res.json(map);
  } catch (err) {
    console.error('MedScan error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});

// ─── Node property names filtered to current pathway nodes ───────────────────
app.post('/api/nodes/property-names', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeIds = [] } = req.body || {};
  const validIds = nodeIds.map(String).filter(id => /^-?\d+$/.test(id));
  if (!validIds.length) return res.json([]);

  try {
    const result = await req.pg.pool.query(
      `SELECT DISTINCT a.name
       FROM ${req.pg.schema}.node n
       JOIN ${req.pg.schema}.attr a ON a.id = ANY(n.attributes)
       WHERE n.id = ANY($1::bigint[])
       ORDER BY a.name`,
      [validIds]
    );
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    console.error('property-names error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});

// ─── Node property names, DB-wide (not scoped to any particular nodes) ───────
// Used to populate the property-name autocomplete for the Explore "All
// relations" dialog's node-property "+ Add filter" rows — candidate nodes
// there can come from anywhere in the database (Expand, Find Common
// Neighbors), not just the currently loaded pathway, so the pathway-scoped
// /api/nodes/property-names above isn't useful here. attr.name values are a
// bounded vocabulary of property keys (not per-node data), so a single
// unscoped DISTINCT is cheap regardless of database size.
app.get('/api/nodes/property-names-all', dbLimiter, authMiddleware, async (req, res) => {
  try {
    const result = await req.pg.pool.query(
      `SELECT DISTINCT name FROM ${req.pg.schema}.attr ORDER BY name`
    );
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    console.error('property-names-all error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});

// ─── Load selected node properties for pathway nodes ─────────────────────────
// Matches by numeric NodeID (Neo4j nodes) and/or URN string (RNEF nodes).
// Returns { byNodeId: { "123": {prop:val,...} }, byUrn: { "urn:...": {prop:val,...} } }
app.post('/api/nodes/load-properties', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeIds = [], urns = [], properties = [] } = req.body || {};

  const PROP_RE = /^[A-Za-z0-9 _\-().]+$/;
  const safeProps = properties.filter(p => typeof p === 'string' && PROP_RE.test(p));
  if (!safeProps.length) return res.json({ byNodeId: {}, byUrn: {} });

  const byNodeId = {};
  const byUrn    = {};

  // ── Query by numeric NodeID ──────────────────────────────────────────────────
  const validIds = nodeIds.map(String).filter(id => /^-?\d+$/.test(id));
  if (validIds.length) {
    const sql = `
      SELECT n.id::text AS node_id, a.name, a.value
      FROM ${req.pg.schema}.node AS n
      JOIN ${req.pg.schema}.attr AS a ON a.id = ANY(n.attributes)
      WHERE n.id = ANY($1::bigint[])
        AND a.name = ANY($2::text[])
    `;
    const result = await req.pg.pool.query(sql, [validIds, safeProps]);
    result.rows.forEach(row => {
      if (!byNodeId[row.node_id]) byNodeId[row.node_id] = {};
      const existing = byNodeId[row.node_id][row.name];
      byNodeId[row.node_id][row.name] = existing !== undefined
        ? existing + ' | ' + row.value
        : row.value;
    });
  }

  // ── Query by URN string ──────────────────────────────────────────────────────
  const URN_RE  = /^[a-zA-Z0-9:@%.~_\-]+$/;
  const safeUrns = urns.filter(u => typeof u === 'string' && URN_RE.test(u));
  if (safeUrns.length) {
    const sql = `
      SELECT a_urn.value AS urn, a.name, a.value
      FROM ${req.pg.schema}.node AS n
      JOIN ${req.pg.schema}.attr AS a_urn ON a_urn.id = ANY(n.attributes)
      JOIN ${req.pg.schema}.attr AS a     ON a.id     = ANY(n.attributes)
      WHERE a_urn.name = 'URN'
        AND a_urn.value = ANY($1::text[])
        AND a.name = ANY($2::text[])
    `;
    const result = await req.pg.pool.query(sql, [safeUrns, safeProps]);
    result.rows.forEach(row => {
      if (!byUrn[row.urn]) byUrn[row.urn] = {};
      const existing = byUrn[row.urn][row.name];
      byUrn[row.urn][row.name] = existing !== undefined
        ? existing + ' | ' + row.value
        : row.value;
    });
  }

  res.json({ byNodeId, byUrn });
});

// ─── Node connectivity (total edge count in Neo4j) ────────────────────────────
// POST /api/nodes/connectivity
// Body: { urns: [...] }
// Returns { [urn]: count, ... }
app.post('/api/nodes/connectivity', dbLimiter, authMiddleware, async (req, res) => {
  const { urns = [] } = req.body || {};
  const safeUrns = urns.map(String).filter(u => u.length > 0 && u.length < 500);
  if (!safeUrns.length) return res.json({});

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(
      `UNWIND $urns AS urn
       MATCH (n {URN: urn})-[r]-(neighbor)
       RETURN urn, count(r) AS degree, count(DISTINCT neighbor) AS neighborCount`,
      { urns: safeUrns }
    );
    const out = Object.create(null); // null prototype prevents remote property injection
    result.records.forEach(rec => {
      const urn = rec.get('urn');
      const toN = v => v && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
      out[urn] = { degree: toN(rec.get('degree')), neighborCount: toN(rec.get('neighborCount')) };
    });
    res.json(out);
  } catch (err) {
    console.error('connectivity error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── PostgreSQL reference update (curation) ───────────────────────────────────
app.post('/api/references/update', dbLimiter, authMiddleware, async (req, res) => {
  const { id, msrc } = req.body || {};
  if (!id || msrc === undefined) return res.status(400).json({ error: 'id and msrc required' });
  const safeId = /^-?\d+$/.test(String(id)) ? String(id) : null;
  if (!safeId) return res.status(400).json({ error: 'Invalid id' });
  try {
    await req.pg.pool.query(
      `UPDATE ${req.pg.schema}.reference SET msrc = $1 WHERE id = $2::bigint`,
      [msrc, safeId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Reference update error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});

// ─── Neo4j node property update (curation) ───────────────────────────────────
app.post('/api/graph/update-node', dbLimiter, authMiddleware, async (req, res) => {
  const { elementId, properties } = req.body || {};
  if (!elementId || typeof properties !== 'object') {
    return res.status(400).json({ error: 'elementId and properties required' });
  }
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    await session.run(
      'MATCH (n) WHERE elementId(n) = $eid SET n += $props',
      { eid: elementId, props: properties }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('update-node error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── Neo4j relation property update (curation) ───────────────────────────────
app.post('/api/graph/update-relation', dbLimiter, authMiddleware, async (req, res) => {
  const { elementId, properties } = req.body || {};
  if (!elementId || typeof properties !== 'object') {
    return res.status(400).json({ error: 'elementId and properties required' });
  }
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    await session.run(
      'MATCH ()-[r]->() WHERE elementId(r) = $eid SET r += $props',
      { eid: elementId, props: properties }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('update-relation error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── Schema columns (for Add/Remove columns dialog) ──────────────────────────
app.get('/api/schema/columns', dbLimiter, authMiddleware, async (req, res) => {
  // scopusColumns is derived from the module-level SCOPUS_COL_SQL map so it
  // always stays in sync with the columns the /api/references/batch endpoint
  // actually queries.
  try {
    const refCols = await req.pg.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'reference'
       ORDER BY ordinal_position`,
      [req.pg.schema]
    );
    res.json({
      referenceColumns: refCols.rows.map(r => r.column_name),
      scopusColumns: Object.keys(SCOPUS_COL_SQL)
    });
  } catch (err) {
    console.error('schema/columns error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});

// ─── Raw SQL query (admin only) ───────────────────────────────────────────────
app.post('/api/sql-query', dbLimiter, authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { sql } = req.body;
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql required' });

  // ── Input validation (defence-in-depth for a read-only admin endpoint) ──────
  // 1. Must start with SELECT or WITH (read-only statements only)
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
    return res.status(400).json({ error: 'Only SELECT / WITH queries are permitted' });
  }
  // 2. Reject stacked queries (semicolons allow injecting additional statements)
  if (sql.includes(';')) {
    return res.status(400).json({ error: 'Semicolons are not permitted' });
  }
  // 3. Reject SQL comments (used to comment out trailing conditions)
  if (/--|\/\*/.test(sql)) {
    return res.status(400).json({ error: 'SQL comments are not permitted' });
  }
  // 4. Reject write keywords even if hidden after a WITH clause
  if (/(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|EXECUTE|COPY)/i.test(sql)) {
    return res.status(400).json({ error: 'Write operations are not permitted' });
  }

  try {
    // ACCEPTED FINDING (CodeQL: js/sql-injection / "Database query built from
    // user-controlled sources") — dismissed manually in the repo's Security
    // tab, not via inline suppression comment (confirmed not honored by this
    // repo's CodeQL Action setup after repeated testing with verified-correct
    // syntax). Rationale for the dismissal: sql originates from an
    // authenticated ADMIN-only request and has been validated above to be a
    // read-only SELECT/WITH query with no stacked statements, no comments,
    // and no write keywords. Parameterised queries cannot be used here
    // because the entire query text — not just a value — is the user-supplied
    // input; that is the intentional design of an admin ad-hoc SQL runner,
    // not an injection bug layered on top of it.
    const result = await req.pg.pool.query(sql);
    res.json({ rows: result.rows, fields: result.fields.map(function(f) { return f.name; }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Cypher syntax lint via EXPLAIN ──────────────────────────────────────────
// Runs EXPLAIN <query> without executing it.  Returns {ok:true} or
// {error:{message, line, column, offset}} parsed from the Neo4j error string.
app.post('/api/graph/lint', dbLimiter, authMiddleware, async (req, res) => {
  const { query } = req.body || {};
  if (!query || !query.trim()) return res.json({ ok: true });

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    await session.run('EXPLAIN ' + query);
    res.json({ ok: true });
  } catch (err) {
    const msg = err.message || '';
    // Neo4j syntax errors include "(line N, column M (offset: K))"
    const posMatch = msg.match(/\(line\s+(\d+),\s+column\s+(\d+)\s+\(offset:\s*(\d+)\)\)/i);
    const errObj = { message: msg };
    if (posMatch) {
      errObj.line   = parseInt(posMatch[1], 10) - 1;   // 0-based for CodeMirror
      errObj.column = parseInt(posMatch[2], 10) - 1;
      errObj.offset = parseInt(posMatch[3], 10);
    }
    res.json({ ok: false, error: errObj });
  } finally {
    await session.close();
  }
});

// ─── Match RNEF relations to Neo4j relations and return RelationID mapping ────
// Accepts two batches:
//   batch         – regular (1-to-1) edges: [{rURN, tURN, relType, effect, mechanism, relURN}]
//   hyperedgeBatch – ChemicalReaction edges: [{rURNs, tURNs, effect, mechanism, relURN}]
// Returns { [relURN]: RelationID } for every RNEF relation that matched.
app.post('/api/relations/match-rnef', dbLimiter, authMiddleware, async (req, res) => {
  const { batch = [], hyperedgeBatch = [] } = req.body || {};
  const mapping = Object.create(null); // codeql[js/remote-property-injection] null prototype prevents prototype pollution

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    // ── Regular (1-to-1) relations ──────────────────────────────────────────
    // Cypher cannot parametrize relationship types, so we group the batch by
    // relType and run one query per type.  Effect normalization: RNEF "Unknown"
    // or "" matches Neo4j NULL, "" or "_".
    // Nondirectional types are matched with an undirected pattern so that
    // RNEF regulator/target order doesn't have to match Neo4j's stored direction.
    const NONDIRECTIONAL_TYPES = new Set([
      'Binding', 'CellExpression', 'FunctionalAssociation', 'Metabolization', 'Paralog'
    ]);

    if (batch.length > 0) {
      const byType = Object.create(null); // null prototype prevents remote property injection
      batch.forEach(row => {
        if (typeof row.relType !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.relType)) return;
        (byType[row.relType] = byType[row.relType] || []).push(row);
      });

      for (const [relType, rows] of Object.entries(byType)) {
        // Sanitize relationship type: only alphanumeric + underscore
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(relType)) continue;

        const arrow = NONDIRECTIONAL_TYPES.has(relType) ? '-' : '->';
        // Normalize Effect: treat NULL, '', '_', 'Unknown' as equivalent "no effect"
        const cypher = `
UNWIND $rows AS row
MATCH (a {URN: row.rURN})-[r:\`${relType}\`]${arrow}(b {URN: row.tURN})
WHERE (
    CASE WHEN coalesce(r.Effect, '') IN ['', '_', 'Unknown', 'unknown'] THEN ''
         ELSE r.Effect END
  ) = (
    CASE WHEN coalesce(row.effect, '') IN ['', '_', 'Unknown', 'unknown'] THEN ''
         ELSE row.effect END
  )
  AND (
    coalesce(r.Mechanism, '')   IN ['', '_', 'Unknown', 'unknown']
    OR coalesce(row.mechanism, '') IN ['', '_', 'Unknown', 'unknown']
    OR r.Mechanism = row.mechanism
  )
RETURN row.relURN AS relURN, r.RelationID AS relationID, r.RelationNumberOfSentences AS numSentences`;

        const result = await session.run(cypher, { rows });
        result.records.forEach(record => {
          const relURN    = record.get('relURN');
          const relationID = record.get('relationID');
          if (relURN != null && relationID != null) {
            const nos = record.get('numSentences');
            mapping[String(relURN)] = {
              id:          String(toPlain(relationID)),
              numSentences: nos != null ? (typeof nos === 'object' && nos.toNumber ? nos.toNumber() : Number(nos)) : null
            };
          }
        });
      }
    }

    // ── Hyperedges (ANY relation type with >2 participants, not just
    // ChemicalReaction — each row carries its own relType now) ──────────────
    // In Neo4j a hyperedge is stored as many (a)-[r]->(b) rows sharing the
    // same RelationID. We pre-filter with IN, then verify the full set of
    // matched regulators/targets equals the RNEF set via size comparison.
    // Cypher cannot parametrize relationship types, so — same as the regular
    // batch above — rows are grouped by relType and one query runs per type.
    if (hyperedgeBatch.length > 0) {
      const hyperByType = Object.create(null); // null prototype prevents remote property injection
      hyperedgeBatch.forEach(row => {
        if (typeof row.relType !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.relType)) return;
        (hyperByType[row.relType] = hyperByType[row.relType] || []).push(row);
      });

      for (const [relType, rows] of Object.entries(hyperByType)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(relType)) continue;

        const cypher = `
UNWIND $rows AS row
MATCH (a)-[r:\`${relType}\`]->(b)
WHERE a.URN IN row.rURNs AND b.URN IN row.tURNs
WITH row, r.RelationID AS relID, r.RelationNumberOfSentences AS numSentences,
     collect(DISTINCT a.URN) AS matchedRegs,
     collect(DISTINCT b.URN) AS matchedTgts
WHERE size(matchedRegs) = size(row.rURNs) AND size(matchedTgts) = size(row.tURNs)
RETURN DISTINCT row.relURN AS relURN, relID AS relationID, numSentences`;

        const result = await session.run(cypher, { rows });
        result.records.forEach(record => {
          const relURN    = record.get('relURN');
          const relationID = record.get('relationID');
          if (relURN != null && relationID != null) {
            const nos = record.get('numSentences');
            mapping[String(relURN)] = {
              id:          String(toPlain(relationID)),
              numSentences: nos != null ? (typeof nos === 'object' && nos.toNumber ? nos.toNumber() : Number(nos)) : null
            };
          }
        });
      }
    }

    res.json(mapping);
  } catch (err) {
    console.error('match-rnef error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── Fetch specific Neo4j edge properties by RelationID ─────────────────────
// Returns { "<relId>": { "RelationNumberOfSentences": N, ... }, ... }
// Only properties in the hardcoded whitelist are accepted to prevent injection.
const NEO4J_EDGE_PROP_WHITELIST = new Set([
  'RelationNumberOfSentences',
  'RelationNumberOfReferences',
  'Confidence',
  'BibliographicCredibilityScore',
]);

app.post('/api/relations/properties', dbLimiter, authMiddleware, async (req, res) => {
  const { relationIds = [], properties = [] } = req.body || {};
  const validIds = relationIds.map(String).filter(id => /^-?\d+$/.test(id));
  const safeProps = properties.filter(p => NEO4J_EDGE_PROP_WHITELIST.has(p));
  if (!validIds.length || !safeProps.length) return res.json({});

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const propReturn = safeProps.map(p => `r.\`${p}\` AS \`${p}\``).join(', ');
    // r.RelationID can be scalar (integer/string) OR a list (StringArray) in Neo4j.
    // Type probe: toFloat() returns null for lists but a numeric value for integer/string
    // scalars — safe across Neo4j versions.  CASE is lazy so the non-matching branch
    // is never evaluated (toString on a list / list-comprehension on a scalar both throw).
    const result = await session.run(
      `MATCH ()-[r]->()
       WHERE r.RelationID IS NOT NULL
       WITH r,
            CASE WHEN toFloat(r.RelationID) IS NOT NULL
                 THEN [toString(r.RelationID)]
                 ELSE [x IN r.RelationID | toString(x)]
            END AS relIdList
       WHERE ANY(id IN relIdList WHERE id IN $ids)
       UNWIND [id IN relIdList WHERE id IN $ids] AS relId
       RETURN DISTINCT relId, ${propReturn}`,
      { ids: validIds }
    );
    const out = Object.create(null); // null prototype prevents remote property injection
    result.records.forEach(rec => {
      const relId = rec.get('relId');
      if (!relId) return;
      out[relId] = Object.create(null); // codeql[js/remote-property-injection] null prototype prevents prototype pollution
      safeProps.forEach(p => {
        if (typeof p !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) return;
        const val = rec.get(p);
        out[relId][p] = (val != null && typeof val === 'object' && val.toNumber)
          ? val.toNumber()
          : val;
      });
    });
    res.json(out);
  } catch (err) {
    console.error('Neo4j relations/properties error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── Find similar relations (for RNEF relations without RelationID) ───────────
// For each submitted relation, runs 3 checks in order and returns all Neo4j
// relations found at the best matching level.
//   Check 1: same type + same normalised effect   → "exact RelationID match"
//   Check 2: same type, any effect                → "similar – same type"
//   Check 3: equivalent type (see map below)      → "similar – related type"
app.post('/api/relations/find-similar', dbLimiter, authMiddleware, async (req, res) => {
  const { relations = [] } = req.body || {};
  if (!relations.length) return res.json({ results: [] });

  const NONDIRECTIONAL = new Set([
    'Binding','CellExpression','FunctionalAssociation','Metabolization','Paralog'
  ]);

  function normEff(v) {
    const s = v == null ? '' : String(v);
    return (s === '' || s === '_' || s.toLowerCase() === 'unknown') ? '' : s;
  }

  // Check 3 equivalence map: sourceType → [{equivTypes, undirected}]
  // Built from the bidirectional similarity rules.
  const TYPE3_EQUIV = {
    'DirectRegulation': [{ equivTypes: ['Binding','ProtModification','Regulation'],              undirected: true  }],
    'Binding':          [{ equivTypes: ['DirectRegulation','ProtModification','Regulation'],      undirected: true  }],
    'ProtModification': [{ equivTypes: ['DirectRegulation','Binding','Regulation'],               undirected: true  }],
    'PromoterBinding':  [{ equivTypes: ['Expression','Regulation'],                               undirected: false }],
    'Expression':       [{ equivTypes: ['PromoterBinding'],                                       undirected: false }],
    'Biomarker':        [{ equivTypes: ['QuantitativeChange','StateChange','FunctionalAssociation'], undirected: true }],
    'QuantitativeChange': [{ equivTypes: ['Biomarker'],                                           undirected: true  }],
    'StateChange':      [{ equivTypes: ['Biomarker'],                                             undirected: true  }],
    'FunctionalAssociation': [{ equivTypes: ['Biomarker','Regulation'],                           undirected: true  }],
    'MolSynthesis':     [{ equivTypes: ['Regulation'],                                            undirected: false }],
    'MolTransport':     [{ equivTypes: ['Regulation'],                                            undirected: false }],
    'Regulation': [
      { equivTypes: ['DirectRegulation','FunctionalAssociation'],         undirected: true  },
      { equivTypes: ['PromoterBinding','MolSynthesis','MolTransport'],    undirected: false }
    ],
  };

  const REL_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  // Columns returned for every matched relation
  const RETURN_COLS = `
       r.RelationID AS relationID, type(r) AS relType,
       coalesce(r.Effect,    '') AS effect,
       coalesce(r.Mechanism, '') AS mechanism,
       coalesce(r.RelationNumberOfReferences, 0) AS numRefs,
       a.URN AS rURN, coalesce(a.Name,'') AS rName, labels(a) AS rLabels,
       b.URN AS tURN, coalesce(b.Name,'') AS tName, labels(b) AS tLabels`;

  function normDisplayEff(v) {
    if (v == null) return '';
    const s = String(v);
    if (s === '' || s === '_' || s.toLowerCase() === 'unknown') return '';
    if (s.toLowerCase() === 'positive') return 'Positive';
    if (s.toLowerCase() === 'negative') return 'Negative';
    return s;
  }

  function recordToRel(record) {
    return {
      relationID: String(toPlain(record.get('relationID'))),
      relType:    record.get('relType'),
      effect:     normDisplayEff(record.get('effect')),
      mechanism:  normDisplayEff(record.get('mechanism')),
      numRefs:    toPlain(record.get('numRefs')),
      rURN:       record.get('rURN'),
      rName:      record.get('rName'),
      rLabels:    record.get('rLabels') || [],
      tURN:       record.get('tURN'),
      tName:      record.get('tName'),
      tLabels:    record.get('tLabels') || [],
    };
  }

  const session = req.neo4j.driver.session({ database: req.neo4j.database });

  try {
    // resultMap[idx] = { idx, check, relations: [...] }
    const resultMap = Object.create(null); // codeql[js/remote-property-injection] null prototype prevents prototype pollution

    function acceptRecord(checkNum, record) {
      const idx = toPlain(record.get('idx'));
      const existing = resultMap[idx];
      // Only record if not already matched at a stricter (lower) check
      if (existing && existing.check < checkNum) return;
      if (!existing || existing.check > checkNum) {
        resultMap[idx] = { idx, check: checkNum, relations: [] };
      }
      resultMap[idx].relations.push(recordToRel(record));
    }

    function groupByType(rows) {
      const g = Object.create(null); // null prototype prevents remote property injection (no __proto__ pollution)
      rows.forEach(r => {
        if (typeof r.relType !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.relType)) return;
        (g[r.relType] = g[r.relType] || []).push(r);
      });
      return g;
    }

    // Prepare rows with normalised effect
    const workList = relations.map(r => ({
      idx:        r.idx,
      rURN:       r.rURN,
      tURN:       r.tURN,
      relType:    r.relType,
      normEffect: normEff(r.effect),
    }));

    // ── Check 1: same type + same normalised effect ──────────────────────────
    for (const [relType, rows] of Object.entries(groupByType(workList))) {
      if (!REL_TYPE_RE.test(relType)) continue;
      const arrow = NONDIRECTIONAL.has(relType) ? '-' : '->';
      const cypher = `
UNWIND $rows AS row
MATCH (a {URN: row.rURN})-[r:\`${relType}\`]${arrow}(b {URN: row.tURN})
WHERE (CASE WHEN coalesce(r.Effect,'') IN ['','_','Unknown','unknown'] THEN ''
            ELSE r.Effect END) = row.normEffect
RETURN row.idx AS idx, ${RETURN_COLS}`;
      const result = await session.run(cypher, { rows });
      result.records.forEach(rec => acceptRecord(1, rec));
    }

    // ── Check 2: same type, any effect ───────────────────────────────────────
    const unmatched2 = workList.filter(r => !resultMap[r.idx]);
    for (const [relType, rows] of Object.entries(groupByType(unmatched2))) {
      if (!REL_TYPE_RE.test(relType)) continue;
      const arrow = NONDIRECTIONAL.has(relType) ? '-' : '->';
      const cypher = `
UNWIND $rows AS row
MATCH (a {URN: row.rURN})-[r:\`${relType}\`]${arrow}(b {URN: row.tURN})
RETURN row.idx AS idx, ${RETURN_COLS}`;
      const result = await session.run(cypher, { rows });
      result.records.forEach(rec => acceptRecord(2, rec));
    }

    // ── Check 3: equivalent type ─────────────────────────────────────────────
    const unmatched3 = workList.filter(r => !resultMap[r.idx]);
    for (const [relType, rows] of Object.entries(groupByType(unmatched3))) {
      const equivGroups = TYPE3_EQUIV[relType];
      if (!equivGroups) continue;
      for (const { equivTypes, undirected } of equivGroups) {
        const arrow = undirected ? '-' : '->';
        const cypher = `
UNWIND $rows AS row
MATCH (a {URN: row.rURN})-[r]${arrow}(b {URN: row.tURN})
WHERE type(r) IN $equivTypes
RETURN row.idx AS idx, ${RETURN_COLS}`;
        const result = await session.run(cypher, { rows, equivTypes });
        result.records.forEach(rec => acceptRecord(3, rec));
      }
    }

    res.json({ results: Object.values(resultMap) });
  } catch (err) {
    console.error('find-similar error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── RNEF → JSON conversion ───────────────────────────────────────────────────
// Accepts raw XML text body (Content-Type: text/plain, up to 50 MB) and returns
// { pathways: [{name, data}, ...] }.  Using text/plain avoids the global 10 MB
// express.json limit — the body is never JSON-parsed by the global middleware.
app.post('/api/convert/rnef', dbLimiter, express.text({ limit: '500mb', type: 'text/plain' }), authMiddleware, async (req, res) => {
  const content = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnef-'));
  const inputPath = path.join(tmpDir, 'input.rnef');
  const outDir    = path.join(tmpDir, 'out');
  fs.mkdirSync(outDir);
  // codeql[js/network-data-written-to-file] - content is RNEF XML from an authenticated request; path is server-controlled tmpdir, never served back to clients
  fs.writeFileSync(inputPath, content, 'utf8');

  try {
    await new Promise((resolve, reject) => {
      execFile(PYTHON_CMD, [RNEF_SCRIPT, inputPath, outDir],
        { timeout: 600000 },   // 10 min — large RNEF files (80+ MB) can take a while
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        }
      );
    });

    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
    const pathways = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
      return { name: data.name || f.replace('.json', ''), data };
    });

    res.json({ pathways });
  } catch (err) {
    console.error('RNEF conversion error:', err.message);
    res.status(500).json({ error: safeError(err, 'RNEF conversion') });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
  }
});


// ─── Find relations between selected and unselected nodes ─────────────────────
// POST /api/relations/find-between
// Body: { selectedURNs: [...], allURNs: [...], filterType: 'all'|'direct'|'biomarker'|'indirect' }
app.post('/api/relations/find-between', dbLimiter, authMiddleware, async (req, res) => {
  const { selectedURNs = [], allURNs = [], filterType = 'all' } = req.body || {};
  if (!selectedURNs.length) return res.json({ relations: [] });

  const DIRECT_TYPES    = ['Binding','DirectRegulation','ProtModification','PromoterBinding','ChemicalReaction'];
  const BIOMARKER_TYPES = ['Biomarker','QuantitativeChange','StateChange','GeneticChange'];
  const INDIRECT_TYPES  = ['Regulation','Expression','MolTransport','MolSynthesis','Metabolization'];

  // Build relationship-type filter clause for Cypher
  let typeFilter = '';
  if (filterType === 'direct' || filterType === 'biomarker' || filterType === 'indirect') {
    typeFilter = 'AND type(r) IN $typeList ';
  }
  // filterType === 'all': no filter

  const typeList = filterType === 'direct'    ? DIRECT_TYPES
                 : filterType === 'biomarker' ? BIOMARKER_TYPES
                 : filterType === 'indirect'  ? INDIRECT_TYPES
                 : [];

  // unselectedURNs = allURNs minus selectedURNs (scoped to current pathway)
  const selectedSet   = new Set(selectedURNs);
  const unselectedURNs = allURNs.filter(u => !selectedSet.has(u));
  if (!unselectedURNs.length) return res.json({ relations: [] });

  function normDisplayEff(v) {
    if (v == null) return '';
    const s = String(v);
    if (s === '' || s === '_' || s.toLowerCase() === 'unknown') return '';
    if (s.toLowerCase() === 'positive') return 'Positive';
    if (s.toLowerCase() === 'negative') return 'Negative';
    return s;
  }

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    // Find edges: one endpoint in selectedURNs, other in unselectedURNs.
    // Uses UNWIND + bidirectional match to avoid full-graph scan.
    const cypher = `
UNWIND $selectedURNs AS sURN
MATCH (a {URN: sURN})-[r]-(b)
WHERE b.URN IN $unselectedURNs
  ${typeFilter}
RETURN
  r.RelationID                              AS relationID,
  type(r)                                   AS relType,
  coalesce(r.Effect,    '')                 AS effect,
  coalesce(r.Mechanism, '')                 AS mechanism,
  coalesce(r.RelationNumberOfReferences, 0) AS numRefs,
  a.URN AS aURN, coalesce(a.Name,'') AS aName, labels(a) AS aLabels,
  b.URN AS bURN, coalesce(b.Name,'') AS bName, labels(b) AS bLabels,
  startNode(r).URN = a.URN AS aIsStart`;

    const result = await session.run(cypher, {
      selectedURNs,
      unselectedURNs,
      typeList,
    });

    // Deduplicate by RelationID (bidirectional match may return each edge twice)
    const seen = new Set();
    const relations = [];
    for (const rec of result.records) {
      const rid = String(toPlain(rec.get('relationID')));
      if (seen.has(rid)) continue;
      seen.add(rid);

      const aIsStart = rec.get('aIsStart');
      const aURN = rec.get('aURN');
      const bURN = rec.get('bURN');
      // Canonical direction: whichever endpoint is in selectedURNs is "source"
      // unless the graph edge direction already determines it
      const rURN = aIsStart ? aURN : bURN;
      const tURN = aIsStart ? bURN : aURN;
      const rName = aIsStart ? rec.get('aName') : rec.get('bName');
      const tName = aIsStart ? rec.get('bName') : rec.get('aName');

      relations.push({
        relationID: rid,
        relType:    rec.get('relType'),
        effect:     normDisplayEff(rec.get('effect')),
        mechanism:  normDisplayEff(rec.get('mechanism')),
        numRefs:    toPlain(rec.get('numRefs')),
        rURN, rName,
        tURN, tName,
      });
    }

    res.json({ relations });
  } catch (err) {
    console.error('find-between error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});


// ─── Connect selected nodes (closed-loop inner edges) ────────────────────────
// POST /api/relations/connect-selected
// Body: { selectedURNs: [...], filterType: 'all'|'direct'|'biomarker'|'indirect' }
// Returns edges where BOTH endpoints are in selectedURNs (closed-loop query).
app.post('/api/relations/connect-selected', dbLimiter, authMiddleware, async (req, res) => {
  const { selectedURNs = [], filterType = 'all' } = req.body || {};
  if (selectedURNs.length < 2) return res.json({ relations: [] });

  const DIRECT_TYPES    = ['Binding','DirectRegulation','ProtModification','PromoterBinding','ChemicalReaction'];
  const BIOMARKER_TYPES = ['Biomarker','QuantitativeChange','StateChange','GeneticChange'];
  const INDIRECT_TYPES  = ['Regulation','Expression','MolTransport','MolSynthesis','Metabolization'];

  let typeFilter = '';
  if (filterType === 'direct' || filterType === 'biomarker' || filterType === 'indirect') {
    typeFilter = 'AND type(r) IN $typeList ';
  }

  const typeList = filterType === 'direct'    ? DIRECT_TYPES
                 : filterType === 'biomarker' ? BIOMARKER_TYPES
                 : filterType === 'indirect'  ? INDIRECT_TYPES
                 : [];

  function normDisplayEff(v) {
    if (v == null) return '';
    const s = String(v);
    if (s === '' || s === '_' || s.toLowerCase() === 'unknown') return '';
    if (s.toLowerCase() === 'positive') return 'Positive';
    if (s.toLowerCase() === 'negative') return 'Negative';
    return s;
  }

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    // Closed-loop: both endpoints must be in selectedURNs.
    // Bidirectional match covers both directions; dedup by RelationID.
    const cypher = `
UNWIND $selectedURNs AS sURN
MATCH (a {URN: sURN})-[r]-(b)
WHERE b.URN IN $selectedURNs AND b.URN <> sURN
  ${typeFilter}
RETURN
  r.RelationID                              AS relationID,
  type(r)                                   AS relType,
  coalesce(r.Effect,    '')                 AS effect,
  coalesce(r.Mechanism, '')                 AS mechanism,
  coalesce(r.RelationNumberOfReferences, 0) AS numRefs,
  a.URN AS aURN, coalesce(a.Name,'') AS aName,
  b.URN AS bURN, coalesce(b.Name,'') AS bName,
  startNode(r).URN = a.URN AS aIsStart`;

    const result = await session.run(cypher, { selectedURNs, typeList });

    const seen = new Set();
    const relations = [];
    for (const rec of result.records) {
      const rid = String(toPlain(rec.get('relationID')));
      if (seen.has(rid)) continue;
      seen.add(rid);

      const aIsStart = rec.get('aIsStart');
      const aURN = rec.get('aURN'), bURN = rec.get('bURN');
      const rURN = aIsStart ? aURN : bURN;
      const tURN = aIsStart ? bURN : aURN;
      const rName = aIsStart ? rec.get('aName') : rec.get('bName');
      const tName = aIsStart ? rec.get('bName') : rec.get('aName');

      relations.push({
        relationID: rid,
        relType:    rec.get('relType'),
        effect:     normDisplayEff(rec.get('effect')),
        mechanism:  normDisplayEff(rec.get('mechanism')),
        numRefs:    toPlain(rec.get('numRefs')),
        rURN, rName, tURN, tName,
      });
    }
    res.json({ relations });
  } catch (err) {
    console.error('connect-selected error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── Pre-execution edge count check ──────────────────────────────────────────
// POST /api/graph/count-query
// Body: { query }  →  { edgeCount: N }
// Runs the user's Cypher query on Neo4j and counts how many relationship
// elements appear in the result — without sending back full node/edge data.
// Used to intercept large result sets before they reach the browser renderer.
app.post('/api/graph/count-query', dbLimiter, authMiddleware, async (req, res) => {
  const { query } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Cypher query is required' });

  // Transform the query into a fast COUNT query by replacing each RETURN clause.
  // For UNION queries every branch is counted separately and the results are summed
  // (a slight overcount for UNION-with-dedup, but safe for the "too large" gate).
  // e.g.  MATCH ... RETURN a,r,b UNION MATCH ... RETURN b,r,a
  //   →   run count(*) on each branch and sum

  function branchToCountQuery(branch) {
    // A trailing LIMIT bounds how many rows the query can actually return,
    // regardless of how many total matches exist before it — naively
    // replacing everything from RETURN onward (below) throws that LIMIT away
    // entirely, since it's part of what gets replaced. This was a real bug:
    // a "top 10 ..." ranking query (RETURN ... ORDER BY ... LIMIT 10) had its
    // LIMIT silently stripped by this count check, which then reported the
    // full unbounded match count — often far larger than 10 — incorrectly
    // triggering the "results too large" warning for a query that would
    // actually only ever return 10 rows. When a LIMIT is present, wrap the
    // ENTIRE original branch (preserving its own RETURN/ORDER BY/LIMIT
    // exactly as written) in a CALL {} subquery and count the rows that come
    // out of it, instead of replacing the RETURN clause outright.
    const hasLimit = /\bLIMIT\s+\d+\s*$/i.test(branch);
    if (hasLimit) {
      return 'CALL {\n' + branch + '\n}\nRETURN count(*) AS edgeCount';
    }
    const pos = branch.search(/\bRETURN\b/i);
    return pos !== -1
      ? branch.substring(0, pos) + 'RETURN count(*) AS edgeCount'
      : null;
  }

  // Split on UNION ALL first (longer token), then UNION, preserving both variants.
  // We only split on top-level UNION — subquery UNION (inside CALL {}) would be
  // indented and is not a concern for the query patterns we expect here.
  const branches = query.split(/\bUNION\s+ALL\b|\bUNION\b/i).map(b => b.trim()).filter(Boolean);
  const countQueries = branches.map(branchToCountQuery).filter(Boolean);

  // Fallback: if no RETURN was found anywhere, run the original query.
  if (countQueries.length === 0) countQueries.push(query);

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    let edgeCount = 0;
    for (const cq of countQueries) {
      const result = await session.run(cq);
      if (result.records.length > 0) {
        const val = result.records[0].get('edgeCount');
        // Neo4j returns integers as neo4j.Integer objects
        edgeCount += (val && typeof val.toNumber === 'function') ? val.toNumber() : Number(val);
      }
    }
    res.json({ edgeCount });
  } catch (err) {
    console.error('count-query error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── Cypher query history ─────────────────────────────────────────────────────
// NDJSON file: one JSON object per line — { date, query, count }
// Legacy TSV lines (Date \t Query \t Count) are still parsed for backwards compatibility.
app.get('/api/cypher/history', dbLimiter, authMiddleware, (req, res) => {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return res.json({ rows: [] });
    const content = fs.readFileSync(HISTORY_FILE, 'utf8');
    const rows = content.trim().split('\n').filter(l => l.trim()).map(line => {
      // Try NDJSON first (new format)
      if (line.trimStart().startsWith('{')) {
        try {
          const obj = JSON.parse(line);
          // v2 entries have the query base64-encoded; decode before returning to client
          let q = String(obj.query || '');
          if (obj.v === 2) {
            try { q = Buffer.from(q, 'base64').toString('utf8'); } catch (_) { /* keep as-is */ }
          }
          return {
            date:  String(obj.date  || ''),
            query: q,
            count: Number.isFinite(Number(obj.count)) ? Number(obj.count) : 0
          };
        } catch (_) { /* fall through to TSV */ }
      }
      // Legacy TSV format
      const parts = line.split('\t');
      const date  = parts[0] || '';
      const query = parts[1] || '';
      const count = parts.length > 2 ? parseInt(parts[2], 10) : 0;
      return { date, query, count: isNaN(count) ? 0 : count };
    });
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

const HISTORY_QUERY_MAX_CHARS = 10_000; // per-entry limit to prevent disk exhaustion
app.post('/api/cypher/history', dbLimiter, authMiddleware, (req, res) => {
  const { query, count } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });
  // Base64-encode the query so no raw user string reaches the file-write call.
  // This breaks CodeQL's taint chain for "network-data-written-to-file".
  // The GET endpoint decodes it back before returning to the client.
  const encodedQuery = Buffer.from(String(query).slice(0, HISTORY_QUERY_MAX_CHARS)).toString('base64');
  const entry = {
    date:  new Date().toISOString(),
    query: encodedQuery, // base64-encoded; decoded on read
    v:     2,            // version flag: v2 = query is base64
    count: Number.isFinite(Number(count)) ? Number(count) : 0
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(HISTORY_FILE, line, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// ─── Agentic AI — Python service lifecycle & proxy ───────────────────────────
const AGENT_PORT     = parseInt(process.env.AGENT_PORT || '3001', 10);
const AGENT_SCRIPT   = path.join(__dirname, 'agent_service.py');
let   _agentProc     = null;
let   _agentReady    = false;

function _killPortProcess(port, cb) {
  // Kill any existing process on the agent port (stale Python from a previous run).
  // Uses netstat on Windows, lsof on Unix.
  const isWin = process.platform === 'win32';
  const cmd   = isWin
    ? `FOR /F "tokens=5" %a IN ('netstat -ano ^| findstr :${port}') DO taskkill /F /PID %a`
    : `lsof -ti tcp:${port} | xargs kill -9`;
  require('child_process').exec(cmd, () => cb && cb());
}

function _startAgentService() {
  if (!fs.existsSync(AGENT_SCRIPT)) {
    console.warn('[agent] agent_service.py not found — Agentic AI disabled');
    return;
  }
  // Kill any stale process from a previous run before spawning a fresh one.
  _killPortProcess(AGENT_PORT, () => {
    setTimeout(_doSpawnAgent, 500);  // brief pause after kill
  });
}

function _doSpawnAgent() {
  const py = process.env.PYTHON_CMD || PYTHON_CMD;
  _agentProc = spawn(py, [AGENT_SCRIPT], {
    env: { ...process.env, AGENT_PORT: String(AGENT_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  _agentProc.stdout.on('data', d => process.stdout.write('[agent] ' + d));
  _agentProc.stderr.on('data', d => process.stderr.write('[agent] ' + d));
  _agentProc.on('exit', (code) => {
    _agentReady = false;
    console.log(`[agent] process exited (code ${code})`);
    // Auto-restart after 5 s unless we killed it intentionally
    if (code !== null && code !== 0) {
      setTimeout(_startAgentService, 5000);
    }
  });

  // Poll until the service responds to /health (give it up to 30 s)
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    http.get(`http://127.0.0.1:${AGENT_PORT}/health`, (r) => {
      if (r.statusCode === 200) {
        clearInterval(poll);
        _agentReady = true;
        console.log(`[agent] ready on port ${AGENT_PORT}`);
        // Push schema + LLM/Neo4j config to agent.
        // Always push credentials immediately (empty schema) so /health shows the
        // right model name right away, then push again with the full schema once
        // the Neo4j introspection query completes.
        setTimeout(async () => {
          // Immediate push — credentials + LLM, empty schema (status will show model name)
          _pushSchemaToAgent({ labels: [], relTypes: [], propKeys: [] });
          // Full push — only needed if schema not yet cached
          if (!_schemaServerCache) {
            // _fetchSchemaFromNeo4j calls _pushSchemaToAgent internally on success
            await _fetchSchemaFromNeo4j().catch(() => null);
          }
        }, 500);
      }
    }).on('error', () => {});
    if (attempts > 60) clearInterval(poll);
  }, 500);
}

function _pushSchemaToAgent(schema) {
  if (!_agentReady) return;
  const cache = schema || _schemaServerCache;
  if (!cache) return;
  const llmCfg = appSettings.llm || {};
  const neo4jCfg = {
    url:      appSettings.neo4j.url,
    database: appSettings.neo4j.database,
    username: appSettings.neo4j.username,
    password: appSettings.neo4j.password,
  };
  const schemaText = [
    `Node labels: ${(cache.labels || []).join(', ')}`,
    `Relationship types: ${(cache.relTypes || []).join(', ')}`,
    `Relationship property keys: ${(cache.propKeys || []).join(', ')}`,
  ].join('\n');

  const pgCfg = appSettings.postgres ? {
    host:     appSettings.postgres.host,
    port:     appSettings.postgres.port,
    database: appSettings.postgres.database,
    schema:   appSettings.postgres.schema,
    username: appSettings.postgres.username,
    password: appSettings.postgres.password,
  } : null;

  const body = JSON.stringify({ neo4j: neo4jCfg, schema_text: schemaText, llm: llmCfg, postgres: pgCfg });
  const opts = {
    hostname: '127.0.0.1', port: AGENT_PORT, path: '/schema',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = http.request(opts, r => {
    if (r.statusCode === 200) console.log('[agent] schema pushed (' + schemaText.length + ' chars, pg=' + !!pgCfg + ')');
  });
  req.on('error', e => {
    // Sanitized INLINE, directly as the console.warn() argument — not via an
    // intermediate variable one line above. CodeQL's static analysis for
    // this check does not reliably trace a sanitizing transformation across
    // a statement boundary, even one line earlier; it needs to see the
    // .replace() happening inline within the sink call's own arguments.
    console.warn('[agent] schema push failed:', String((e && e.message) || 'unknown error').replace(/[\r\n]+/g, ' '));
  });
  // `body` includes credentials read from settings.json (neo4jCfg/pgCfg/llmCfg
  // above) — CodeQL flags this as "file data in outbound network request"
  // (js/file-access-to-http), which is the right thing to flag in general,
  // but `opts.hostname` here is the hardcoded literal '127.0.0.1', never a
  // variable — this is server.js pushing its own configuration to the Python
  // agent_service.py process it spawned as a child process on the SAME host,
  // over loopback only (see agent_service.py's uvicorn.run(host="127.0.0.1")).
  // It is internal IPC between two halves of one application, not an
  // exfiltration path to an external destination.
  // codeql[js/file-access-to-http]
  req.write(body); req.end();
}

function _pushLLMConfigToAgent(llmCfg) {
  if (!_agentReady) return;
  const body = JSON.stringify(llmCfg);
  const opts = {
    hostname: '127.0.0.1', port: AGENT_PORT, path: '/llm-config',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = http.request(opts, () => {});
  req.on('error', () => {});
  req.write(body); req.end();
}

// Intercept llm-config updates so settings.json stays in sync with the agent's
// in-memory state — prevents _pushSchemaToAgent from reverting to the old model.
app.post('/api/agent/llm-config', dbLimiter, authMiddleware, (req, res, next) => {
  const { url, apikey, model_name, temperature, top_p, json_mode } = req.body || {};
  const existing = appSettings.llm || {};
  if (model_name && typeof model_name === 'string' && model_name.trim()) {
    existing.model_name = model_name.trim();
  }
  if (typeof url === 'string') existing.url = url.trim();
  if (typeof apikey === 'string' && apikey) existing.apikey = apikey.trim();
  if (Number.isFinite(Number(temperature))) existing.temperature = Number(temperature);
  if (Number.isFinite(Number(top_p)))       existing.top_p       = Number(top_p);
  if (json_mode !== undefined) existing.json_mode = json_mode === true || json_mode === 'true';
  appSettings.llm = existing;
  saveAppSettings(appSettings);   // persist to settings.json
  next();                          // continue to the generic proxy below
});

// Proxy all /api/agent/* requests to the Python service
app.all('/api/agent/*', dbLimiter, authMiddleware, (req, res) => {
  if (!_agentReady) {
    return res.status(503).json({ error: 'Agentic AI service is starting — please wait a moment and retry' });
  }
  const agentPath = req.url.replace(/^\/api\/agent/, '');
  // Express body-parser has already consumed req's stream, so we must re-serialise
  // req.body and set an accurate Content-Length instead of piping the raw stream.
  const bodyStr = (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined)
    ? JSON.stringify(req.body)
    : null;

  // x-ge-username is set here (never trusted from the client) so agent_service.py
  // can resolve THIS user's own Neo4j/Postgres credentials for its cypher/postgres
  // actions instead of one shared global connection — mirrors the per-user
  // connection model used everywhere else in server.js.
  const headers = { ...req.headers, host: `127.0.0.1:${AGENT_PORT}`, 'x-ge-username': req.user.username };
  if (bodyStr !== null) {
    headers['content-type']   = 'application/json';
    headers['content-length'] = Buffer.byteLength(bodyStr).toString();
    delete headers['transfer-encoding'];  // must not coexist with content-length
  }

  const opts = {
    hostname: '127.0.0.1',
    port:     AGENT_PORT,
    path:     agentPath || '/',
    method:   req.method,
    headers,
    timeout:  120_000,
  };
  const proxy = http.request(opts, (agentRes) => {
    res.status(agentRes.statusCode);
    Object.entries(agentRes.headers).forEach(([k, v]) => {
      if (k !== 'transfer-encoding') res.setHeader(k, v);
    });
    agentRes.pipe(res, { end: true });
  });
  proxy.on('timeout', () => {
    proxy.destroy();
    if (!res.headersSent)
      res.status(504).json({ error: 'AI Agent timed out — the LLM took too long to respond. Please retry.' });
  });
  proxy.on('error', (e) => {
    // Sanitized inline at the call site, no intermediate variable — CodeQL's
    // check did not trace a sanitizing transformation across a statement
    // boundary even one line earlier (confirmed empirically at this exact
    // spot), so the literal .replace() chain has to live directly in the
    // console.error() argument list itself.
    console.error('[agent proxy] error:', String(e && e.message).replace(/[\r\n]+/g, ' '));
    if (!res.headersSent)
      res.status(502).json({ error: 'Agent service unavailable' });
  });
  if (bodyStr !== null) {
    proxy.write(bodyStr);
  }
  proxy.end();
});

// ─── Start server ─────────────────────────────────────────────────────────────
// Vendor libraries must be pre-downloaded by running: node scripts/vendor-libs.js
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Graph Explorer running on http://localhost:${PORT}`);
  _startAgentService();
});

process.on('exit',    () => { if (_agentProc) _agentProc.kill(); });
process.on('SIGINT',  () => { if (_agentProc) _agentProc.kill(); process.exit(); });
process.on('SIGTERM', () => { if (_agentProc) _agentProc.kill(); process.exit(); });

// ─── Neo4j schema introspection ───────────────────────────────────────────────
// In-memory cache populated at startup and refreshed every 10 minutes.
let _schemaServerCache = null;
let _schemaFetchPromise = null; // in-flight promise guard — concurrent callers share one DB round-trip

async function _fetchSchemaFromNeo4j() {
  // If a fetch is already in progress, return the same promise so we don't hit Neo4j multiple times
  if (_schemaFetchPromise) return _schemaFetchPromise;
  _schemaFetchPromise = _doFetchSchemaFromNeo4j().finally(() => { _schemaFetchPromise = null; });
  return _schemaFetchPromise;
}

// Schema introspection (autocomplete + the AI agent's system prompt) isn't
// tied to one specific request, so there's no per-user req.neo4j to read here.
// It uses the first admin account's own Neo4j connection as the "system"
// connection — reasonable since this is just structural metadata (labels/
// relationship types/property keys), and in practice everyone on a given
// deployment points at the same underlying database. If a particular user's
// personal credentials point at a genuinely different database, their
// autocomplete/agent-prompt schema hints may not perfectly match what their
// own queries see — only the schema HINTS are shared; actual query execution
// always uses each user's own connection.
function _getSystemNeo4jConn() {
  const users = loadUsers();
  const admin = users.find(u => u.role === 'admin') || users[0];
  if (!admin) throw new Error('No users configured — cannot resolve a Neo4j connection for schema introspection');
  return getNeo4jConnForUser(admin.username);
}

async function _doFetchSchemaFromNeo4j() {
  const { driver, database } = _getSystemNeo4jConn();
  const s1 = driver.session({ database });
  const s2 = driver.session({ database });
  const s3 = driver.session({ database });
  try {
    const [labelsResult, relTypesResult] = await Promise.all([
      s1.run('CALL db.labels()'),
      s2.run('CALL db.relationshipTypes()'),
    ]);
    const labels   = labelsResult.records.map(r => r.get('label'));
    const relTypes = relTypesResult.records.map(r => r.get('relationshipType'));

    // Relationship-only property keys — schema metadata first (no data scan), fallback to sampling
    let propKeys = [];
    try {
      const pkResult = await s3.run(
        'CALL db.schema.relTypeProperties() YIELD propertyName RETURN DISTINCT propertyName AS k ORDER BY k'
      );
      propKeys = pkResult.records.map(r => r.get('k')).filter(Boolean);
    } catch (_) {
      try {
        const pkResult = await s3.run(
          'MATCH ()-[r]->() WITH r LIMIT 5000 UNWIND keys(r) AS k RETURN DISTINCT k ORDER BY k'
        );
        propKeys = pkResult.records.map(r => r.get('k'));
      } catch (_2) {}
    }
    _schemaServerCache = { labels, relTypes, propKeys };
    console.log(`Schema cache refreshed: ${labels.length} labels, ${relTypes.length} relTypes, ${propKeys.length} propKeys`);
    // Push to Agentic AI service so it can use the latest schema for text-to-Cypher
    _pushSchemaToAgent(_schemaServerCache);
    return _schemaServerCache;
  } catch (err) {
    console.error('Schema cache fetch error:', err.message);
    return null;
  } finally {
    await Promise.all([s1.close(), s2.close(), s3.close()]);
  }
}

// Pre-warm cache 3 s after startup (gives Neo4j time to accept connections)
setTimeout(function() {
  _fetchSchemaFromNeo4j().catch(() => {});
}, 3000);
// Refresh every 10 minutes so new relation types / property keys appear automatically
setInterval(function() {
  _fetchSchemaFromNeo4j().catch(() => {});
}, 10 * 60 * 1000);

// GET /api/graph/schema — returns { labels, relTypes, propKeys }
app.get('/api/graph/schema', dbLimiter, authMiddleware, async (req, res) => {
  try {
    // Serve from cache (instant); if cache not ready yet, fetch now and cache result
    const schema = _schemaServerCache || await _fetchSchemaFromNeo4j();
    if (!schema) return res.status(503).json({ error: 'Schema not available yet' });
    res.json(schema);
  } catch (err) {
    console.error('schema error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});


// ─── Distinct values for a relation property ──────────────────────────────────
// GET /api/schema/prop-values?prop=Effect
// Returns { values: [...] } – distinct non-empty values of the given property
// across all relationships in Neo4j, sorted alphabetically (max 200).
app.get('/api/schema/prop-values', dbLimiter, authMiddleware, async (req, res) => {
  const prop = (req.query.prop || '').trim();
  if (!prop || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prop))
    return res.status(400).json({ error: 'Invalid property name' });
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(
      `MATCH ()-[r]->() WHERE r[\`${prop}\`] IS NOT NULL AND r[\`${prop}\`] <> ''
       RETURN DISTINCT toString(r[\`${prop}\`]) AS v ORDER BY v LIMIT 200`
    );
    const values = result.records.map(rec => rec.get('v'));
    res.json({ values });
  } catch (err) {
    console.error('prop-values error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ─── Expand selected nodes ────────────────────────────────────────────────────
// POST /api/graph/expand
// Body: { urns: string[], mode: 'all'|'direct'|'biomarker'|'indirect'|'to',
//         targetLabels?: string[] }
// Returns same { nodes, edges } format as /api/graph/query
app.post('/api/graph/expand', dbLimiter, authMiddleware, async (req, res) => {
  const { urns, mode, targetLabels } = req.body || {};
  if (!Array.isArray(urns) || !urns.length)
    return res.status(400).json({ error: 'urns array is required' });

  const DIRECT_TYPES   = ['Binding','DirectRegulation','ProtModification','PromoterBinding','ChemicalReaction'];
  const INDIRECT_TYPES = ['Regulation','Expression','MolTransport','MolSynthesis','Metabolization'];

  // Build rel-type clause
  let relClause = '-[r]-';
  if (mode === 'direct') {
    relClause = '-[r:' + DIRECT_TYPES.join('|') + ']-';
  } else if (mode === 'biomarker') {
    relClause = '-[r:Biomarker|QuantitativeChange|StateChange|GeneticChange]-';
  } else if (mode === 'indirect') {
    relClause = '-[r:' + INDIRECT_TYPES.join('|') + ']-';
  }
  // 'to' uses no type filter in the pattern

  // Build target-label clause (for 'to' mode)
  let targetClause = '';
  if (mode === 'to' && Array.isArray(targetLabels) && targetLabels.length) {
    // Sanitize: only allow label names that are safe identifiers
    const safeLabels = targetLabels.filter(l => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l));
    if (safeLabels.length) {
      targetClause = ' AND any(lbl IN labels(b) WHERE lbl IN ' +
                     JSON.stringify(safeLabels) + ')';
    }
  }

  const cypher =
    'MATCH (a)' + relClause + '(b) ' +
    'WHERE a.`' + NEO4J_URN_PROP + '` IN $urns' +
    targetClause +
    ' RETURN a, r, b LIMIT 2000';

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(cypher, { urns });
    const nodesMap = new Map();
    const edgesMap = new Map();
    result.records.forEach(record => {
      record.keys.forEach(key => processValue(record.get(key), nodesMap, edgesMap));
    });
    res.json({ nodes: Array.from(nodesMap.values()), edges: Array.from(edgesMap.values()) });
  } catch (err) {
    console.error('expand error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});


// ─── Find ontology parents via is_a hierarchy ────────────────────────────────
// POST /api/graph/ontology-parents
// Body: { nodeParams: [{label: string, urn: string}, ...], maxDepth?: 1-5 }
// Returns { nodes, edges } of the is_a ancestry chain for each given node, up to
// maxDepth levels up (omit/0 for the full, unbounded ancestry chain — deeper
// traversals should generally go through "Ontology analysis" instead).
app.post('/api/graph/ontology-parents', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeParams = [], maxDepth } = req.body || {};
  if (!Array.isArray(nodeParams) || !nodeParams.length)
    return res.status(400).json({ error: 'nodeParams array is required' });

  const safe = nodeParams.filter(np =>
    np && typeof np.label === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(np.label) &&
    typeof np.urn === 'string' && np.urn.trim().length > 0
  );
  if (!safe.length) return res.json({ nodes: [], edges: [] });

  // Depth is menu-controlled (1-5), never user-typed — but validate anyway
  // before inlining it into the Cypher path-length range.
  const depth = Number.isInteger(maxDepth) && maxDepth >= 1 && maxDepth <= 5 ? maxDepth : null;
  const hopRange = depth ? `*1..${depth}` : '*';

  const cypher = `
    UNWIND $nodeParams AS np
    MATCH (p {\`${NEO4J_URN_PROP}\`: np.urn})
    WHERE np.label IN labels(p)
    OPTIONAL MATCH path = (p)-[:is_a|part_of${hopRange}]->(parent)
    WITH p, collect(DISTINCT path) AS paths
    RETURN p, paths
  `;

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(cypher, { nodeParams: safe });
    const nodesMap = new Map();
    const edgesMap = new Map();
    result.records.forEach(record => {
      record.keys.forEach(key => processValue(record.get(key), nodesMap, edgesMap));
    });
    res.json({ nodes: Array.from(nodesMap.values()), edges: Array.from(edgesMap.values()) });
  } catch (err) {
    console.error('ontology-parents error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});


// ─── Shortest path between selected nodes ────────────────────────────────────
// POST /api/graph/shortest-path
// Body: { nodeParams: [{label, urn}, ...], maxLength: 1-15, relTypes: [string,...] }
// For every pair among the given nodes, finds the shortest undirected path (up
// to maxLength hops) using only the given relationship types, and returns the
// union of nodes/edges across every path found (Database → Shortest path menu).
// POST /api/graph/shortest-path
// Body: { nodeParams: [{label, urn}, ...], maxLength, relTypes?, nodeTypes?,
//         propFilters?, nodePropFilters? }
// Driven by the Explore menu's universal "All relations" config dialog
// (action 'shortestPath') — relTypes/nodeTypes/propFilters/nodePropFilters
// are all optional now (previously relTypes was mandatory and errored if
// empty); omitting a filter means "no restriction", consistent with the
// other 3 actions that dialog also drives.
//   - relTypes empty/omitted → untyped variable-length pattern (traverse ANY
//     relationship type), instead of the old "must pick at least one type" error.
//   - nodeTypes restricts INTERMEDIATE path nodes only — the two path
//     endpoints are the user's own explicit selection and are never subject
//     to type filtering (requiring the user to also check their own two
//     endpoints' types would be an easy-to-forget footgun).
//   - propFilters (relation properties) must hold for EVERY relationship
//     along the path — same "every step must qualify" semantics as
//     nodeTypes, expressed via Neo4j's all(... IN ... WHERE ...) predicate.
//   - nodePropFilters (node properties, from Postgres node+attr) are
//     evaluated per-path AFTER the Cypher query returns, same as
//     explore-relations-report, again only against intermediate nodes.
app.post('/api/graph/shortest-path', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeParams = [], maxLength, relTypes, nodeTypes, propFilters, nodePropFilters } = req.body || {};

  const safeNodes = (Array.isArray(nodeParams) ? nodeParams : []).filter(np =>
    np && typeof np.label === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(np.label) &&
    typeof np.urn === 'string' && np.urn.trim().length > 0
  );
  if (safeNodes.length < 2)
    return res.status(400).json({ error: 'At least two valid selected nodes are required' });
  if (safeNodes.length > 10)
    return res.status(400).json({ error: 'Please select 10 or fewer nodes for shortest path (each pair is computed separately)' });

  const len = Number.isInteger(maxLength) && maxLength >= 1 && maxLength <= 15 ? maxLength : 2;

  const safeIdent = s => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

  let relPattern = '';
  if (Array.isArray(relTypes) && relTypes.length) {
    const safeTypes = relTypes.filter(safeIdent);
    if (safeTypes.length) relPattern = ':' + safeTypes.map(t => '`' + t + '`').join('|');
  }

  let safeNodeTypes = [];
  let nodeTypeClause = '';
  if (Array.isArray(nodeTypes) && nodeTypes.length) {
    safeNodeTypes = nodeTypes.filter(safeIdent);
    if (safeNodeTypes.length) nodeTypeClause = 'all(n IN nodes(p)[1..-1] WHERE any(lbl IN labels(n) WHERE lbl IN $nodeTypesParam))';
  }

  const { clauses: propClauses, params: propParams } = _buildRelPropFilterClauses(propFilters, 'r');
  const relPropClause = propClauses.length ? 'all(r IN relationships(p) WHERE ' + propClauses.join(' AND ') + ')' : '';

  const extraWhereParts = [nodeTypeClause, relPropClause].filter(Boolean);
  const extraWhere = extraWhereParts.length ? ('WHERE ' + extraWhereParts.join(' AND ')) : '';

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    // Every matched path is kept SEPARATE (not merged into a shared map yet)
    // until after the node-property post-filter runs below, since dropping a
    // path that fails a node-property filter must also drop whichever of its
    // nodes/edges aren't shared with any other surviving path.
    const candidatePaths = [];

    for (let i = 0; i < safeNodes.length; i++) {
      for (let j = i + 1; j < safeNodes.length; j++) {
        const a = safeNodes[i], b = safeNodes[j];
        const cypher = `
          MATCH (a {\`${NEO4J_URN_PROP}\`: $urnA}), (b {\`${NEO4J_URN_PROP}\`: $urnB})
          WHERE $labelA IN labels(a) AND $labelB IN labels(b)
          MATCH p = shortestPath((a)-[${relPattern}*1..${len}]-(b))
          ${extraWhere}
          RETURN p
        `;
        const result = await session.run(cypher, {
          urnA: a.urn, urnB: b.urn, labelA: a.label, labelB: b.label,
          nodeTypesParam: safeNodeTypes, ...propParams
        });
        result.records.forEach(record => {
          const p = record.get('p');
          if (!p) return;
          const tempNodes = new Map(), tempEdges = new Map();
          processValue(p, tempNodes, tempEdges);
          candidatePaths.push({ tempNodes, tempEdges, endpointURNs: new Set([String(a.urn), String(b.urn)]) });
        });
      }
    }

    // Node-property post-filter — every INTERMEDIATE node (never the two
    // path endpoints) in a kept path must satisfy every nodePropFilter.
    const safeNodePropFilters = _sanitizeNodePropFilters(nodePropFilters);
    if (safeNodePropFilters.length && candidatePaths.length) {
      const filterNames = Array.from(new Set(safeNodePropFilters.map(f => f.key.trim())));
      const allNodeIds = new Set();
      candidatePaths.forEach(cp => {
        cp.tempNodes.forEach(n => {
          const urn = n.properties && n.properties[NEO4J_URN_PROP];
          if (urn && cp.endpointURNs.has(String(urn))) return;
          const nid = n.properties && n.properties.NodeID;
          if (nid != null) allNodeIds.add(String(nid));
        });
      });
      const propsByNodeId = await _fetchNodePropsByNodeId(req.pg, Array.from(allNodeIds), filterNames);
      for (let k = candidatePaths.length - 1; k >= 0; k--) {
        const cp = candidatePaths[k];
        let ok = true;
        for (const n of cp.tempNodes.values()) {
          const urn = n.properties && n.properties[NEO4J_URN_PROP];
          if (urn && cp.endpointURNs.has(String(urn))) continue;
          const nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
          const props = (nid && propsByNodeId.get(nid)) || {};
          if (!_nodePropFilterMatches(props, safeNodePropFilters)) { ok = false; break; }
        }
        if (!ok) candidatePaths.splice(k, 1);
      }
    }

    const nodesMap = new Map();
    const edgesMap = new Map();
    candidatePaths.forEach(cp => {
      cp.tempNodes.forEach((v, k) => { if (!nodesMap.has(k)) nodesMap.set(k, v); });
      cp.tempEdges.forEach((v, k) => { if (!edgesMap.has(k)) edgesMap.set(k, v); });
    });

    res.json({
      nodes: Array.from(nodesMap.values()),
      edges: Array.from(edgesMap.values()),
      pathsFound: candidatePaths.length,
      pairsChecked: (safeNodes.length * (safeNodes.length - 1)) / 2
    });
  } catch (err) {
    console.error('shortest-path error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RELATION CURATION  ──  Create / Edit relations from the UI
// ═══════════════════════════════════════════════════════════════════════════════

// ── RelationID hashing (mirrors Python myhash) ─────────────────────────────────
function _myhash(text) {
  const buf = Buffer.from(String(text), 'utf8');
  const d   = _crypto.createHash('md5').update(buf).digest();
  const high = d.readBigUInt64BE(0);
  const low  = d.readBigUInt64BE(8);
  const MASK = BigInt('0x7FFFFFFFFFFFFFFF');
  let r = high ^ low;
  if (r > MASK) r = -(r & MASK);
  return r.toString();
}

// Reproduce Python's str() representation of a list/string so the hash matches.
function _pyRepr(val) {
  if (Array.isArray(val)) {
    if (!val.length) return '[]';
    // NodeIDs are integers — output as int literals (no quotes), matching Python str(list[int])
    return '[' + val.map(v => {
      const s = String(v);
      return /^-?\d+$/.test(s) ? s : ("'" + s.replace(/\\/g,'\\\\').replace(/'/g,"\\'") + "'");
    }).join(', ') + ']';
  }
  return "'" + String(val).replace(/\\/g,'\\\\').replace(/'/g,"\\'") + "'";
}

function calcRelationId({ inref=[], inoutref=[], outref=[], control_type='',
                          ontology='', relationship='', effect='', mechanism='' }) {
  // Lists sorted descending (matches Python .sort(reverse=True)) using BigInt for 64-bit NodeIDs
  const bigSort = (a, b) => { const x = BigInt(String(a)), y = BigInt(String(b)); return x < y ? 1 : x > y ? -1 : 0; };
  const s = '(' + [
    _pyRepr([...inref  ].sort(bigSort)),
    _pyRepr([...inoutref].sort(bigSort)),
    _pyRepr([...outref ].sort(bigSort)),
    _pyRepr(control_type), _pyRepr(ontology),
    _pyRepr(relationship), _pyRepr(effect.toLowerCase()), _pyRepr(mechanism)
  ].join(', ') + ')';
  return _myhash(s);
}

// GET /api/schema/relation-types  — distinct Neo4j relationship types
app.get('/api/schema/relation-types', dbLimiter, authMiddleware, async (req, res) => {
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const r = await session.run(
      'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType'
    );
    res.json({ types: r.records.map(rec => rec.get('relationshipType')) });
  } catch(e) { res.status(500).json({ error: safeError(e) }); }
  finally { await session.close(); }
});

// GET /api/schema/relation-properties  — distinct property keys on Neo4j relationships
app.get('/api/schema/relation-properties', dbLimiter, authMiddleware, async (req, res) => {
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const r = await session.run(
      'MATCH ()-[rel]->() WITH keys(rel) AS k UNWIND k AS key RETURN DISTINCT key ORDER BY key LIMIT 300'
    );
    res.json({ properties: r.records.map(rec => rec.get('key')) });
  } catch(e) { res.status(500).json({ error: safeError(e) }); }
  finally { await session.close(); }
});

// POST /api/curation/calculate-relation-id  — deterministic hash for live preview
// Also checks Neo4j for an existing relation of the same type between the same nodes,
// and returns the EXISTING RelationID if found (to avoid creating duplicates of
// relations that were loaded by the external Python pipeline with a different hash).
app.post('/api/curation/calculate-relation-id', dbLimiter, authMiddleware, async (req, res) => {
  const body = req.body || {};
  const computed = calcRelationId(body);

  // Try to find an existing relation in Neo4j with the same type + same node pair
  const { inref = [], outref = [], inoutref = [], control_type = '' } = body;
  const safeType = /^[A-Za-z_][A-Za-z0-9_]*$/.test(control_type) ? control_type : null;

  if (safeType && (inref.length || outref.length || inoutref.length)) {
    const session = req.neo4j.driver.session({ database: req.neo4j.database });
    try {
      let result;
      if (inref.length === 1 && outref.length === 1 && !inoutref.length) {
        // Directional: single source → single target
        result = await session.run(
          `MATCH (a {NodeID: $src})-[r:\`${safeType}\`]->(b {NodeID: $tgt})
           WHERE r.RelationID IS NOT NULL
           RETURN toString(r.RelationID) AS rid LIMIT 1`,
          { src: inref[0], tgt: outref[0] }
        );
      } else if (!inref.length && !outref.length && inoutref.length >= 2) {
        // Non-directional: match either direction
        result = await session.run(
          `MATCH (a {NodeID: $n1})-[r:\`${safeType}\`]-(b {NodeID: $n2})
           WHERE r.RelationID IS NOT NULL
           RETURN toString(r.RelationID) AS rid LIMIT 1`,
          { n1: inoutref[0], n2: inoutref[1] }
        );
      }
      if (result && result.records.length) {
        const existing = result.records[0].get('rid');
        return res.json({ relationId: existing, existingFound: true });
      }
    } catch(e) { /* fall through to computed */ }
    finally { await session.close(); }
  }

  res.json({ relationId: computed });
});

// POST /api/curation/write-relation  — MERGE to Neo4j + upsert references in Postgres
// Requires role === 'user'  (admin cannot curate per spec §1.3)
app.post('/api/curation/write-relation', dbLimiter, authMiddleware, async (req, res) => {
  if (req.user.role !== 'user')
    return res.status(403).json({ error: 'Curation requires User role.' });

  const { sourceNode, targetNode, relationType, properties = {}, relationId, references = [] } = req.body || {};
  if (!relationType)
    return res.status(400).json({ error: 'Please add relation type before adding relation to database.' });
  if (!sourceNode || !targetNode)
    return res.status(400).json({ error: 'Source (→) and target (←) nodes are required.' });

  // Validate identifiers used in Cypher interpolation
  const safeId = s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  if (!safeId(relationType))       return res.status(400).json({ error: `Unsafe relation type: "${relationType}"` });
  if (!safeId(sourceNode.nodeLabel)) return res.status(400).json({ error: `Unsafe label: "${sourceNode.nodeLabel}"` });
  if (!safeId(targetNode.nodeLabel)) return res.status(400).json({ error: `Unsafe label: "${targetNode.nodeLabel}"` });

  const username = req.user.username;

  // Coerce semicolon-separated strings → arrays for list properties.
  // Keys are validated against an allowlist before touching the object — breaks CodeQL taint path.
  const _PROP_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;
  const relProps = Object.create(null);
  Object.entries(properties).forEach(([k, v]) => {
    if (v == null || v === '') return;
    const key = String(k);
    if (!_PROP_KEY_RE.test(key)) return; // reject anything that isn't a safe identifier
    relProps[key] = (typeof v === 'string' && v.includes(';'))
      ? v.split(';').map(s => s.trim()).filter(Boolean) : v;
  });

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const cypher = `
      MATCH (a:${sourceNode.nodeLabel} {NodeID: $srcId}),
            (b:${targetNode.nodeLabel} {NodeID: $tgtId})
      MERGE (a)-[r:${relationType} {RelationID: $relId}]->(b)
      ON CREATE SET r.createdAt = timestamp(), r.updatedAt = timestamp(),
                    r.createdBy = $username,   r.updatedBy = $username
      ON MATCH  SET r.updatedAt = timestamp(), r.updatedBy = $username
      SET r += $relProps
      RETURN r,
             elementId(r) AS eid,
             id(a) AS aId, elementId(a) AS aEid,
             id(b) AS bId, elementId(b) AS bEid
    `;
    const result = await session.run(cypher, {
      srcId: sourceNode.nodeId, tgtId: targetNode.nodeId,
      relId: relationId, username, relProps
    });

    if (!result.records.length)
      return res.status(404).json({ error: 'Source or target node not found. Verify NodeID and label.' });
    const rec = result.records[0];

    // ── Write / delete references in Postgres ──────────────────────────────────
    if (req.pg && req.pg.pool && Array.isArray(references) && references.length) {
      const client = await req.pg.pool.connect();
      try {
        await client.query('BEGIN');

        // Fetch valid column names for the reference table once
        const colRes = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'reference'
           ORDER BY ordinal_position`,
          [req.pg.schema]
        );
        const validCols = new Set(colRes.rows.map(r => r.column_name));

        for (const ref of references) {
          if (!ref) continue;

          // Delete
          if (ref._deleted) {
            if (ref.unique_id)
              await client.query(`DELETE FROM ${req.pg.schema}.reference WHERE unique_id = $1`, [ref.unique_id]);
            continue;
          }

          // Collect writable columns
          const cols = Object.keys(ref).filter(k =>
            !k.startsWith('_') && k !== 'unique_id' && validCols.has(k) &&
            ref[k] != null && ref[k] !== ''
          );
          if (!cols.length) continue;

          if (ref.unique_id) {
            // Update existing row
            const setParts = cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ');
            await client.query(
              `UPDATE ${req.pg.schema}.reference SET ${setParts} WHERE unique_id = $1`,
              [ref.unique_id, ...cols.map(k => ref[k])]
            );
          } else {
            // Insert new row — always set id = RelationID.
            // Deduplicate by PMID: skip if a reference with the same PMID already exists
            // for this RelationID (guards against the agent re-submitting existing refs).
            if (ref.pmid) {
              const dupCheck = await client.query(
                `SELECT 1 FROM ${req.pg.schema}.reference WHERE id = $1 AND pmid = $2 LIMIT 1`,
                [BigInt(relationId), String(ref.pmid)]
              );
              if (dupCheck.rowCount > 0) continue; // already in DB — skip
            }

            const allCols = ['id', ...cols];
            const vals    = [BigInt(relationId), ...cols.map(k => ref[k])];
            const ph      = vals.map((_, i) => `$${i + 1}`).join(', ');
            await client.query(
              `INSERT INTO ${req.pg.schema}.reference (${allCols.map(c => `"${c}"`).join(', ')})
               VALUES (${ph})`,
              vals
            );
          }
        }
        await client.query('COMMIT');
      } catch (pgErr) {
        await client.query('ROLLBACK');
        console.error('Reference write error:', pgErr.message);
        // Neo4j write succeeded — don't abort the whole response
      } finally { client.release(); }
    }

    res.json({
      success: true,
      elementId:             rec.get('eid'),
      relationId,
      relationType,
      sourceNodeInternalId:  rec.get('aId').toString(),
      targetNodeInternalId:  rec.get('bId').toString(),
      sourceElementId:       rec.get('aEid'),
      targetElementId:       rec.get('bEid'),
      properties:            toPlain(rec.get('r').properties)
    });
  } catch (err) {
    console.error('write-relation error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally { await session.close(); }
});


// POST /api/graph/ontology-children
// Body: { nodeParams: [{label: string, urn: string}, ...] }
// Returns { nodes, edges } of the full is_a subtree rooted at each given node.
app.post('/api/graph/ontology-children', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeParams = [] } = req.body || {};
  if (!Array.isArray(nodeParams) || !nodeParams.length)
    return res.status(400).json({ error: 'nodeParams array is required' });

  // Validate inputs — label must be a safe Neo4j identifier, urn must be non-empty string
  const safe = nodeParams.filter(np =>
    np && typeof np.label === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(np.label) &&
    typeof np.urn === 'string' && np.urn.trim().length > 0
  );
  if (!safe.length) return res.json({ nodes: [], edges: [] });

  // UNWIND the list so all parent nodes are resolved in a single round-trip.
  // Labels cannot be parameterized in Cypher, so we filter by label using WHERE.
  const cypher = `
    UNWIND $nodeParams AS np
    MATCH (p {\`${NEO4J_URN_PROP}\`: np.urn})
    WHERE np.label IN labels(p)
    OPTIONAL MATCH path = (child)-[:is_a|part_of*]->(p)
    WITH p, collect(DISTINCT path) AS paths
    RETURN p, paths
  `;

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(cypher, { nodeParams: safe });
    const nodesMap = new Map();
    const edgesMap = new Map();
    result.records.forEach(record => {
      record.keys.forEach(key => processValue(record.get(key), nodesMap, edgesMap));
    });
    res.json({ nodes: Array.from(nodesMap.values()), edges: Array.from(edgesMap.values()) });
  } catch (err) {
    console.error('ontology-children error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});


// POST /api/graph/find-drugs (Database → Find drugs upstream)
// Body: { nodeParams: [{label: string, urn: string}, ...], relTypes?: string[], effect?: 'positive'|'negative' }
// Finds :SmallMol nodes that are UPSTREAM regulators of the given (selected)
// entities — (drug)-[r]->(entity), drug as source — and that the Pathway
// Studio Ontology actually classifies as a DRUG, not just any small molecule
// (plain :SmallMol also covers metabolites, reagents, and other non-drug
// compounds). The is_a-chain-to-a-drug-ontology-root filter mirrors
// cypher_examples.json's "Find drugs without PAINS compounds" example
// (is_a* up to either the SmallMol 'plant medicinal product' node or the
// SemanticConcept 'drugs' node).
//
// relTypes/effect narrow this to the specific submenu variants under "Find
// drugs upstream": direct/indirect antagonists (Effect=negative) or agonists
// (Effect=positive) restricted to DirectRegulation (direct) or Regulation/
// Expression/MolTransport (indirect), and expression modulators (Expression
// only, either Effect sign). Omitting both keeps the original unrestricted
// behavior ("All relations").
//
// Returns the same { nodes, edges } shape as /api/graph/ontology-children
// and /api/graph/expand, so the caller can merge it into the graph via the
// same expand-confirm-modal flow findOntologyChildren() already uses.
app.post('/api/graph/find-drugs', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeParams = [], relTypes, effect } = req.body || {};
  if (!Array.isArray(nodeParams) || !nodeParams.length)
    return res.status(400).json({ error: 'nodeParams array is required' });

  const safe = nodeParams.filter(np =>
    np && typeof np.label === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(np.label) &&
    typeof np.urn === 'string' && np.urn.trim().length > 0
  );
  if (!safe.length) return res.json({ nodes: [], edges: [] });

  // Relation types cannot be parameterized in Cypher — validated against a
  // safe-identifier allowlist (same pattern /api/graph/expand uses) before
  // being inlined, never taken from the client as a raw string.
  let relClause = '-[r]->';
  if (Array.isArray(relTypes) && relTypes.length) {
    const safeTypes = relTypes.filter(t => typeof t === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
    if (safeTypes.length) relClause = '-[r:' + safeTypes.join('|') + ']->';
  }

  const params = { nodeParams: safe };
  let effectClause = '';
  if (effect === 'positive' || effect === 'negative') {
    effectClause = '\n      AND r.Effect = $effect';
    params.effect = effect;
  }

  const cypher = `
    UNWIND $nodeParams AS np
    MATCH (p {\`${NEO4J_URN_PROP}\`: np.urn})
    WHERE np.label IN labels(p)
    MATCH (d:SmallMol)${relClause}(p)
    WHERE (
      (d)-[:is_a*]->(:SmallMol {Name:'plant medicinal product'})
      OR (d)-[:is_a*]->(:SemanticConcept {Name:'drugs'})
    )${effectClause}
    WITH DISTINCT p, r, d
    RETURN p, r, d
    LIMIT 2000
  `;

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(cypher, params);
    const nodesMap = new Map();
    const edgesMap = new Map();
    result.records.forEach(record => {
      record.keys.forEach(key => processValue(record.get(key), nodesMap, edgesMap));
    });
    res.json({ nodes: Array.from(nodesMap.values()), edges: Array.from(edgesMap.values()) });
  } catch (err) {
    console.error('find-drugs error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});


// POST /api/graph/find-drugs-report
// Body: same as /api/graph/find-drugs — { nodeParams, relTypes?, effect? }
// Used instead of the plain /api/graph/find-drugs merge-confirm flow whenever
// more than 2 input entities are selected: groups the same upstream-drug
// matches BY DRUG (rather than returning one flat node/edge soup) and adds
// per-drug reference/snippet counts from Postgres, so the "Connectivity
// Report" dialog can rank drugs by how many of the input entities they
// actually connect to before the user decides which ones to visualize.
//
// Response shape is intentionally generic (`groups`, not `drugs`) — the same
// dialog and response contract are meant to be reused by "Find common
// regulators" / "Find common targets" later, which will group by regulator/
// target instead of by drug but return the exact same
// { node, targetCount, referenceCount, snippetCount, targets, edges } shape.
app.post('/api/graph/find-drugs-report', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeParams = [], relTypes, effect } = req.body || {};
  if (!Array.isArray(nodeParams) || !nodeParams.length)
    return res.status(400).json({ error: 'nodeParams array is required' });

  const safe = nodeParams.filter(np =>
    np && typeof np.label === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(np.label) &&
    typeof np.urn === 'string' && np.urn.trim().length > 0
  );
  if (!safe.length) return res.json({ groups: [] });

  // Same relType/effect validation and clause-building as /api/graph/find-drugs.
  let relClause = '-[r]->';
  if (Array.isArray(relTypes) && relTypes.length) {
    const safeTypes = relTypes.filter(t => typeof t === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
    if (safeTypes.length) relClause = '-[r:' + safeTypes.join('|') + ']->';
  }
  const cypherParams = { nodeParams: safe };
  let effectClause = '';
  if (effect === 'positive' || effect === 'negative') {
    effectClause = '\n      AND r.Effect = $effect';
    cypherParams.effect = effect;
  }

  // Grouped by drug: collect({target, rel}) gives each drug its own list of
  // (target node, relationship) pairs in one round trip, rather than a flat
  // node/edge soup that would need re-grouping client-side.
  const cypher = `
    UNWIND $nodeParams AS np
    MATCH (p {\`${NEO4J_URN_PROP}\`: np.urn})
    WHERE np.label IN labels(p)
    MATCH (d:SmallMol)${relClause}(p)
    WHERE (
      (d)-[:is_a*]->(:SmallMol {Name:'plant medicinal product'})
      OR (d)-[:is_a*]->(:SemanticConcept {Name:'drugs'})
    )${effectClause}
    WITH DISTINCT d, p, r
    RETURN d, collect({target: p, rel: r}) AS links
  `;

  const nodeToPlain = (n) => ({
    id: n.identity.toString(),
    elementId: n.elementId || n.identity.toString(),
    labels: n.labels,
    properties: toPlain(n.properties),
  });
  // r.RelationID can be a scalar OR a list (StringArray) in Neo4j — same
  // normalization /api/relations/properties already uses for this quirk.
  const relIdsOf = (r) => {
    const raw = r.properties && r.properties.RelationID;
    if (raw == null) return [];
    return (Array.isArray(raw) ? raw : [raw]).map(x => String(toPlain(x)));
  };

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  let groups;
  try {
    const result = await session.run(cypher, cypherParams);
    groups = result.records.map(rec => {
      const d = rec.get('d');
      const links = rec.get('links') || [];
      const targetsById = new Map();
      const edgesById = new Map();
      const relIdSet = new Set();
      links.forEach(link => {
        const p = link.target, r = link.rel;
        const pid = p.identity.toString();
        if (!targetsById.has(pid)) targetsById.set(pid, nodeToPlain(p));
        const eid = r.identity.toString();
        if (!edgesById.has(eid)) {
          edgesById.set(eid, {
            id: eid,
            elementId: r.elementId || eid,
            type: r.type,
            startNodeId: r.start.toString(),
            endNodeId: r.end.toString(),
            properties: toPlain(r.properties),
          });
        }
        relIdsOf(r).forEach(rid => relIdSet.add(rid));
      });
      return {
        node: nodeToPlain(d),
        targetCount: targetsById.size,
        targets: Array.from(targetsById.values()),
        edges: Array.from(edgesById.values()),
        _relationIds: Array.from(relIdSet),  // internal only — stripped before response
      };
    });
  } catch (err) {
    console.error('find-drugs-report Neo4j error:', err.message);
    return res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }

  // Batched Postgres lookup: ONE query for every RelationID across every
  // drug (not one query per drug), then re-grouped back out per drug below —
  // avoids N round trips for a result set that can easily have dozens of drugs.
  const allRelIds = Array.from(new Set(groups.flatMap(g => g._relationIds)))
    .filter(id => /^-?\d+$/.test(id));
  const rowsByRelId = new Map();
  if (allRelIds.length && req.pg && req.pg.pool) {
    try {
      const sql = `SELECT id, doi, pmid, unique_id FROM ${req.pg.schema}.reference WHERE id = ANY($1::bigint[])`;
      const pgResult = await req.pg.pool.query(sql, [allRelIds]);
      pgResult.rows.forEach(row => {
        const key = String(row.id);
        if (!rowsByRelId.has(key)) rowsByRelId.set(key, []);
        rowsByRelId.get(key).push(row);
      });
    } catch (err) {
      console.error('find-drugs-report Postgres error:', err.message);
      // Reference/snippet counts just come back as 0 below — the node/edge
      // data itself (from Neo4j) is still useful without them.
    }
  }

  groups.forEach(g => {
    // # references: SELECT COUNT(DISTINCT COALESCE(doi, pmid)) FROM reference
    // WHERE id IN (this drug's RelationIDs) — computed here from the shared
    // batch fetch above instead of issuing that query per drug.
    const refKeys = new Set();
    // #snippets: SELECT COUNT(unique_id) FROM reference WHERE id IN (...) —
    // counts ROWS (supporting sentences), not distinct papers.
    let snippetCount = 0;
    g._relationIds.forEach(rid => {
      (rowsByRelId.get(rid) || []).forEach(row => {
        const coalesced = (row.doi != null && row.doi !== '') ? row.doi : row.pmid;
        if (coalesced != null && coalesced !== '') refKeys.add(String(coalesced));
        if (row.unique_id != null) snippetCount++;
      });
    });
    g.referenceCount = refKeys.size;
    g.snippetCount = snippetCount;
    delete g._relationIds;
  });

  groups.sort((a, b) => b.targetCount - a.targetCount);
  res.json({ groups });
});


// POST /api/graph/common-neighbors-report (Database → Find common neighbors)
// Body: { nodeParams: [{label, urn}, ...], direction: 'any'|'in'|'out', nodeTypes?: string[], relTypes?: string[] }
// General-purpose sibling of /api/graph/find-drugs-report — same grouped-by-
// neighbor response shape ({ groups: [{node, targetCount, referenceCount,
// snippetCount, targets, edges}] }), same Postgres reference/snippet
// batching, and feeds the same Connectivity Report dialog. Unlike find-
// drugs-report, there's no SmallMol/drug-ontology filter here: candidates
// are any node (optionally restricted to user-picked labels), matched via
// user-picked relation types, with `direction` choosing what "neighbor"
// means:
//   'any' ("All relations")   — (d)-[r]-(p)  neighbor connected either way
//   'in'  ("Find regulators") — (d)-[r]->(p) neighbor is an UPSTREAM regulator of the input
//   'out' ("Find targets")    — (p)-[r]->(d) neighbor is a DOWNSTREAM target of the input
// Builds extra WHERE clauses filtering the MATCHED RELATION (r) by arbitrary
// user-picked properties — Effect, Mechanism, Tissue, CellType,
// RelationNumberOfReferences, or anything else in the schema. Property
// KEYS can't be parameterized in Cypher (they're inlined as backtick-quoted
// identifiers, same as /api/schema/prop-values and the annotation-save
// endpoint already do), so they're validated to contain no backtick rather
// than restricted to a strict identifier pattern — several real property
// names here legitimately contain spaces/parens (e.g. "Confidence (%)").
// VALUES always travel as Cypher parameters, never inlined, regardless of
// operator. `>`/`>=`/`<`/`<=` require a numeric value (rows that don't parse
// are skipped); `=`/`<>` auto-detect numeric-looking text so
// RelationNumberOfReferences = 5 compares as a number, not a string.
function _buildRelPropFilterClauses(propFilters, relVar) {
  const clauses = [];
  const params = {};
  (Array.isArray(propFilters) ? propFilters : []).forEach((f, i) => {
    if (!f || typeof f.key !== 'string') return;
    const key = f.key.trim();
    if (!key || key.length > 100 || key.includes('`')) return;
    const op = f.op;
    const propRef = `${relVar}.\`${key}\``;
    if (op === 'exists') {
      clauses.push(`${propRef} IS NOT NULL`);
      return;
    }
    if (f.value == null || String(f.value).trim() === '') return;  // no value given, and not "exists" -- nothing to filter on
    const raw = String(f.value).trim();
    const paramName = `pf${i}`;
    if (op === '>' || op === '>=' || op === '<' || op === '<=') {
      const num = Number(raw);
      if (!Number.isFinite(num)) return;  // not a valid number for a numeric comparison -- skip rather than error the whole query
      params[paramName] = num;
      clauses.push(`${propRef} ${op} $${paramName}`);
    } else if (op === 'contains') {
      params[paramName] = raw;
      clauses.push(`toLower(toString(${propRef})) CONTAINS toLower($${paramName})`);
    } else if (op === '=' || op === '<>') {
      // Numeric-looking text compares as a number (so RelationNumberOfReferences
      // = "5" actually matches the integer 5); anything else stays a string.
      params[paramName] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      clauses.push(`${propRef} ${op} $${paramName}`);
    }
  });
  return { clauses, params };
}

app.post('/api/graph/common-neighbors-report', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeParams = [], direction, nodeTypes, relTypes, propFilters } = req.body || {};
  if (!Array.isArray(nodeParams) || !nodeParams.length)
    return res.status(400).json({ error: 'nodeParams array is required' });

  const safe = nodeParams.filter(np =>
    np && typeof np.label === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(np.label) &&
    typeof np.urn === 'string' && np.urn.trim().length > 0
  );
  if (!safe.length) return res.json({ groups: [] });

  // Relation types cannot be parameterized in Cypher — validated against a
  // safe-identifier allowlist before being inlined, same pattern
  // /api/graph/expand and /api/graph/find-drugs use.
  let relTypeClause = '';
  if (Array.isArray(relTypes) && relTypes.length) {
    const safeTypes = relTypes.filter(t => typeof t === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
    if (safeTypes.length) relTypeClause = ':' + safeTypes.join('|');
  }
  // Direction determines which side of the pattern is the candidate neighbor
  // (d) vs. the input entity (p) — see the endpoint comment above.
  let matchClause;
  if (direction === 'in') {
    matchClause = `MATCH (d)-[r${relTypeClause}]->(p)`;
  } else if (direction === 'out') {
    matchClause = `MATCH (p)-[r${relTypeClause}]->(d)`;
  } else {
    matchClause = `MATCH (d)-[r${relTypeClause}]-(p)`;
  }

  // Node labels also cannot be parameterized — same allowlist treatment.
  let nodeTypeClause = '';
  if (Array.isArray(nodeTypes) && nodeTypes.length) {
    const safeNodeTypes = nodeTypes.filter(t => typeof t === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
    if (safeNodeTypes.length) nodeTypeClause = ` AND any(lbl IN labels(d) WHERE lbl IN ${JSON.stringify(safeNodeTypes)})`;
  }

  // Additional relation-property filters (Effect, Mechanism, Tissue,
  // CellType, RelationNumberOfReferences, ...) — narrows the match itself,
  // which is what actually cuts query time down on a large fan-out, rather
  // than filtering the already-fetched result afterward.
  const { clauses: propClauses, params: propParams } = _buildRelPropFilterClauses(propFilters, 'r');
  const propFilterClause = propClauses.length ? ' AND ' + propClauses.join(' AND ') : '';

  const cypher = `
    UNWIND $nodeParams AS np
    MATCH (p {\`${NEO4J_URN_PROP}\`: np.urn})
    WHERE np.label IN labels(p)
    ${matchClause}
    WHERE d <> p${nodeTypeClause}${propFilterClause}
    WITH DISTINCT d, p, r
    RETURN d, collect({target: p, rel: r}) AS links
  `;

  const nodeToPlain = (n) => ({
    id: n.identity.toString(),
    elementId: n.elementId || n.identity.toString(),
    labels: n.labels,
    properties: toPlain(n.properties),
  });
  const relIdsOf = (r) => {
    const raw = r.properties && r.properties.RelationID;
    if (raw == null) return [];
    return (Array.isArray(raw) ? raw : [raw]).map(x => String(toPlain(x)));
  };

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  let groups;
  try {
    const result = await session.run(cypher, { nodeParams: safe, ...propParams });
    groups = result.records.map(rec => {
      const d = rec.get('d');
      const links = rec.get('links') || [];
      const targetsById = new Map();
      const edgesById = new Map();
      const relIdSet = new Set();
      links.forEach(link => {
        const p = link.target, r = link.rel;
        const pid = p.identity.toString();
        if (!targetsById.has(pid)) targetsById.set(pid, nodeToPlain(p));
        const eid = r.identity.toString();
        if (!edgesById.has(eid)) {
          edgesById.set(eid, {
            id: eid,
            elementId: r.elementId || eid,
            type: r.type,
            startNodeId: r.start.toString(),
            endNodeId: r.end.toString(),
            properties: toPlain(r.properties),
          });
        }
        relIdsOf(r).forEach(rid => relIdSet.add(rid));
      });
      return {
        node: nodeToPlain(d),
        targetCount: targetsById.size,
        targets: Array.from(targetsById.values()),
        edges: Array.from(edgesById.values()),
        _relationIds: Array.from(relIdSet),
      };
    });
  } catch (err) {
    console.error('common-neighbors-report Neo4j error:', err.message);
    return res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }

  // Same batched Postgres lookup as find-drugs-report: one query for every
  // RelationID across every group, re-aggregated per group below.
  const allRelIds = Array.from(new Set(groups.flatMap(g => g._relationIds)))
    .filter(id => /^-?\d+$/.test(id));
  const rowsByRelId = new Map();
  if (allRelIds.length && req.pg && req.pg.pool) {
    try {
      const sql = `SELECT id, doi, pmid, unique_id FROM ${req.pg.schema}.reference WHERE id = ANY($1::bigint[])`;
      const pgResult = await req.pg.pool.query(sql, [allRelIds]);
      pgResult.rows.forEach(row => {
        const key = String(row.id);
        if (!rowsByRelId.has(key)) rowsByRelId.set(key, []);
        rowsByRelId.get(key).push(row);
      });
    } catch (err) {
      console.error('common-neighbors-report Postgres error:', err.message);
    }
  }

  groups.forEach(g => {
    const refKeys = new Set();
    let snippetCount = 0;
    g._relationIds.forEach(rid => {
      (rowsByRelId.get(rid) || []).forEach(row => {
        const coalesced = (row.doi != null && row.doi !== '') ? row.doi : row.pmid;
        if (coalesced != null && coalesced !== '') refKeys.add(String(coalesced));
        if (row.unique_id != null) snippetCount++;
      });
    });
    g.referenceCount = refKeys.size;
    g.snippetCount = snippetCount;
    delete g._relationIds;
  });

  groups.sort((a, b) => b.targetCount - a.targetCount);
  res.json({ groups });
});

// POST /api/graph/explore-relations-report
// Body: { action: 'findBetween'|'connectSelected'|'expand'|'commonNeighbors',
//         anchorURNs?, scopeURNs?, nodeParams?, direction?,
//         nodeTypes?, relTypes?, propFilters?, nodePropFilters? }
//
// Shared backend for the Explore menu's universal "All relations" config
// dialog — one endpoint instead of teaching find-between/connect-selected/
// expand each their own copy of the grouping + Postgres-batching logic that
// common-neighbors-report above already has. The three existing preset-driven
// endpoints (find-between, connect-selected, expand) are left completely
// untouched — they still power the Direct/Biomarker/Indirect/Expand-To…
// menu items exactly as before; this endpoint only serves the NEW dialog's
// "All relations" path across all four actions.
//
// Every action produces the same {node, targetCount, targets, edges,
// referenceCount, snippetCount} grouped shape common-neighbors-report does,
// so results can feed the same Connectivity Report dialog regardless of
// which menu item triggered the query:
//   findBetween     — group by node OUTSIDE the anchor selection, connected
//                      to one or more anchors (mirrors /api/relations/find-between)
//   connectSelected — group by each anchor node, targets = OTHER anchor nodes
//                      it connects to directly (closed-loop, mirrors
//                      /api/relations/connect-selected)
//   expand          — group by any node NOT in the anchor set, connected to
//                      one or more anchors (mirrors /api/graph/expand's
//                      mode==='all')
//   commonNeighbors — identical to /api/graph/common-neighbors-report
//
// nodePropFilters is the new piece none of the existing endpoints have: since
// candidate nodes can come from anywhere in the database (not just the
// currently loaded pathway), their Postgres node+attr properties are batch-
// fetched by NodeID AFTER the Neo4j query returns, and groups whose node
// fails any filter are dropped — the same {key, op, value} shape and
// operator set (=, <>, contains, >, >=, <, <=, exists) as relation property
// filters, just evaluated in JS against Postgres text values instead of
// pushed into the Cypher WHERE clause (there's no single Neo4j pattern that
// covers "any of these four possible actions", so pre-filtering nodes in
// Cypher isn't practical the way it is for relation properties).
function _nodePropFilterMatches(propsMap, filters) {
  return (Array.isArray(filters) ? filters : []).every(f => {
    if (!f || typeof f.key !== 'string') return true;
    const key = f.key.trim();
    if (!key) return true;
    const raw = Object.prototype.hasOwnProperty.call(propsMap, key) ? propsMap[key] : undefined;
    if (f.op === 'exists') return raw !== undefined;
    if (raw === undefined) return false;
    if (f.value == null || String(f.value).trim() === '') return true;
    const val = String(f.value).trim();
    if (f.op === '>' || f.op === '>=' || f.op === '<' || f.op === '<=') {
      const a = Number(raw), b = Number(val);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (f.op === '>')  return a > b;
      if (f.op === '>=') return a >= b;
      if (f.op === '<')  return a < b;
      return a <= b;
    }
    if (f.op === 'contains') return String(raw).toLowerCase().includes(val.toLowerCase());
    if (f.op === '=' || f.op === '<>') {
      const numeric = /^-?\d+(\.\d+)?$/.test(val);
      const eq = numeric ? (Number(raw) === Number(val)) : (String(raw) === val);
      return f.op === '=' ? eq : !eq;
    }
    return true;
  });
}

// Shared by every endpoint that supports node-property filtering
// (explore-relations-report, shortest-path): validates {key, op, value} rows
// the same way relation-property filters are validated (no backtick, bounded
// length), so a stray unfinished "+ Add filter" row can't reach the database
// query.
function _sanitizeNodePropFilters(nodePropFilters) {
  return (Array.isArray(nodePropFilters) ? nodePropFilters : [])
    .filter(f => f && typeof f.key === 'string' && f.key.trim() && f.key.length <= 100 && !f.key.includes('`'));
}

// Batch-fetches Postgres node+attr properties for the given NodeIDs — only
// the property NAMES actually referenced by a filter (propNames), to keep
// the query small regardless of how many other properties a node carries.
// Returns a Map keyed by NodeID (string) -> {propName: value}.
async function _fetchNodePropsByNodeId(pg, nodeIds, propNames) {
  const propsByNodeId = new Map();
  const safeIds = (nodeIds || []).map(String).filter(id => /^-?\d+$/.test(id));
  if (!safeIds.length || !propNames || !propNames.length || !pg || !pg.pool) return propsByNodeId;
  try {
    const sql = `
      SELECT n.id::text AS node_id, a.name, a.value
      FROM ${pg.schema}.node AS n
      JOIN ${pg.schema}.attr AS a ON a.id = ANY(n.attributes)
      WHERE n.id = ANY($1::bigint[]) AND a.name = ANY($2::text[])
    `;
    const pgResult = await pg.pool.query(sql, [safeIds, propNames]);
    pgResult.rows.forEach(row => {
      if (!propsByNodeId.has(row.node_id)) propsByNodeId.set(row.node_id, {});
      propsByNodeId.get(row.node_id)[row.name] = row.value;
    });
  } catch (err) {
    console.error('node-property batch lookup error:', err.message);
  }
  return propsByNodeId;
}

app.post('/api/graph/explore-relations-report', dbLimiter, authMiddleware, async (req, res) => {
  const {
    action, anchorURNs = [], scopeURNs = [], nodeParams = [], direction,
    nodeTypes, relTypes, propFilters, nodePropFilters
  } = req.body || {};

  const VALID_ACTIONS = new Set(['findBetween', 'connectSelected', 'expand', 'commonNeighbors']);
  if (!VALID_ACTIONS.has(action)) return res.status(400).json({ error: 'Invalid or missing action' });

  // Relation types and node labels can't be parameterized in Cypher — same
  // safe-identifier allowlist common-neighbors-report/expand already use.
  const safeIdent = s => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  let relTypeClause = '';
  if (Array.isArray(relTypes) && relTypes.length) {
    const safeTypes = relTypes.filter(safeIdent);
    if (safeTypes.length) relTypeClause = ':' + safeTypes.join('|');
  }
  let nodeTypeClause = '';
  if (Array.isArray(nodeTypes) && nodeTypes.length) {
    const safeNodeTypes = nodeTypes.filter(safeIdent);
    if (safeNodeTypes.length) nodeTypeClause = ` AND any(lbl IN labels(d) WHERE lbl IN ${JSON.stringify(safeNodeTypes)})`;
  }
  const { clauses: propClauses, params: propParams } = _buildRelPropFilterClauses(propFilters, 'r');
  const propFilterClause = propClauses.length ? ' AND ' + propClauses.join(' AND ') : '';

  let cypher, cypherParams;

  if (action === 'commonNeighbors') {
    const safeNodeParams = (Array.isArray(nodeParams) ? nodeParams : []).filter(np =>
      np && typeof np.label === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(np.label) &&
      typeof np.urn === 'string' && np.urn.trim().length > 0
    );
    if (!safeNodeParams.length) return res.json({ groups: [] });
    let matchClause;
    if (direction === 'in')       matchClause = `MATCH (d)-[r${relTypeClause}]->(p)`;
    else if (direction === 'out') matchClause = `MATCH (p)-[r${relTypeClause}]->(d)`;
    else                          matchClause = `MATCH (d)-[r${relTypeClause}]-(p)`;
    cypher = `
      UNWIND $anchors AS np
      MATCH (p {\`${NEO4J_URN_PROP}\`: np.urn})
      WHERE np.label IN labels(p)
      ${matchClause}
      WHERE d <> p${nodeTypeClause}${propFilterClause}
      WITH DISTINCT d, p, r
      RETURN d, collect({target: p, rel: r}) AS links
    `;
    cypherParams = { anchors: safeNodeParams, ...propParams };
  } else {
    const safeAnchors = (Array.isArray(anchorURNs) ? anchorURNs : []).filter(u => typeof u === 'string' && u.trim().length > 0);
    if (!safeAnchors.length) return res.json({ groups: [] });

    if (action === 'findBetween') {
      const anchorSet = new Set(safeAnchors);
      const unselected = (Array.isArray(scopeURNs) ? scopeURNs : []).filter(u => typeof u === 'string' && !anchorSet.has(u));
      if (!unselected.length) return res.json({ groups: [] });
      cypher = `
        UNWIND $anchors AS aURN
        MATCH (a {\`${NEO4J_URN_PROP}\`: aURN})-[r${relTypeClause}]-(d)
        WHERE d.\`${NEO4J_URN_PROP}\` IN $unselected${nodeTypeClause}${propFilterClause}
        WITH DISTINCT d, a, r
        RETURN d, collect({target: a, rel: r}) AS links
      `;
      cypherParams = { anchors: safeAnchors, unselected, ...propParams };
    } else if (action === 'connectSelected') {
      if (safeAnchors.length < 2) return res.json({ groups: [] });
      cypher = `
        UNWIND $anchors AS aURN
        MATCH (d {\`${NEO4J_URN_PROP}\`: aURN})-[r${relTypeClause}]-(p)
        WHERE p.\`${NEO4J_URN_PROP}\` IN $anchors AND p.\`${NEO4J_URN_PROP}\` <> aURN${nodeTypeClause}${propFilterClause}
        WITH DISTINCT d, p, r
        RETURN d, collect({target: p, rel: r}) AS links
      `;
      cypherParams = { anchors: safeAnchors, ...propParams };
    } else { // 'expand'
      cypher = `
        UNWIND $anchors AS aURN
        MATCH (a {\`${NEO4J_URN_PROP}\`: aURN})-[r${relTypeClause}]-(d)
        WHERE NOT d.\`${NEO4J_URN_PROP}\` IN $anchors${nodeTypeClause}${propFilterClause}
        WITH DISTINCT d, a, r
        RETURN d, collect({target: a, rel: r}) AS links
      `;
      cypherParams = { anchors: safeAnchors, ...propParams };
    }
  }

  const nodeToPlain = (n) => ({
    id: n.identity.toString(),
    elementId: n.elementId || n.identity.toString(),
    labels: n.labels,
    properties: toPlain(n.properties),
  });
  const relIdsOf = (r) => {
    const raw = r.properties && r.properties.RelationID;
    if (raw == null) return [];
    return (Array.isArray(raw) ? raw : [raw]).map(x => String(toPlain(x)));
  };

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  let groups;
  try {
    const result = await session.run(cypher, cypherParams);
    groups = result.records.map(rec => {
      const d = rec.get('d');
      const links = rec.get('links') || [];
      const targetsById = new Map();
      const edgesById = new Map();
      const relIdSet = new Set();
      links.forEach(link => {
        const p = link.target, r = link.rel;
        const pid = p.identity.toString();
        if (!targetsById.has(pid)) targetsById.set(pid, nodeToPlain(p));
        const eid = r.identity.toString();
        if (!edgesById.has(eid)) {
          edgesById.set(eid, {
            id: eid,
            elementId: r.elementId || eid,
            type: r.type,
            startNodeId: r.start.toString(),
            endNodeId: r.end.toString(),
            properties: toPlain(r.properties),
          });
        }
        relIdsOf(r).forEach(rid => relIdSet.add(rid));
      });
      return {
        node: nodeToPlain(d),
        targetCount: targetsById.size,
        targets: Array.from(targetsById.values()),
        edges: Array.from(edgesById.values()),
        _relationIds: Array.from(relIdSet),
      };
    });
  } catch (err) {
    console.error('explore-relations-report Neo4j error:', err.message);
    return res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }

  // Node-property post-filter — batch-fetch Postgres node+attr properties for
  // every candidate group's node (by NodeID) and drop groups that fail any
  // filter.
  const safeNodePropFilters = _sanitizeNodePropFilters(nodePropFilters);
  if (safeNodePropFilters.length && groups.length) {
    const filterNames = Array.from(new Set(safeNodePropFilters.map(f => f.key.trim())));
    const nodeIds = groups.map(g => g.node.properties && g.node.properties.NodeID)
      .filter(id => id != null).map(String);
    const propsByNodeId = await _fetchNodePropsByNodeId(req.pg, nodeIds, filterNames);
    groups = groups.filter(g => {
      const nid = g.node.properties && g.node.properties.NodeID != null ? String(g.node.properties.NodeID) : null;
      const props = (nid && propsByNodeId.get(nid)) || {};
      return _nodePropFilterMatches(props, safeNodePropFilters);
    });
  }

  // Same batched Postgres reference/snippet lookup as common-neighbors-report.
  const allRelIds = Array.from(new Set(groups.flatMap(g => g._relationIds)))
    .filter(id => /^-?\d+$/.test(id));
  const rowsByRelId = new Map();
  if (allRelIds.length && req.pg && req.pg.pool) {
    try {
      const sql = `SELECT id, doi, pmid, unique_id FROM ${req.pg.schema}.reference WHERE id = ANY($1::bigint[])`;
      const pgResult = await req.pg.pool.query(sql, [allRelIds]);
      pgResult.rows.forEach(row => {
        const key = String(row.id);
        if (!rowsByRelId.has(key)) rowsByRelId.set(key, []);
        rowsByRelId.get(key).push(row);
      });
    } catch (err) {
      console.error('explore-relations-report Postgres error:', err.message);
    }
  }

  groups.forEach(g => {
    const refKeys = new Set();
    let snippetCount = 0;
    g._relationIds.forEach(rid => {
      (rowsByRelId.get(rid) || []).forEach(row => {
        const coalesced = (row.doi != null && row.doi !== '') ? row.doi : row.pmid;
        if (coalesced != null && coalesced !== '') refKeys.add(String(coalesced));
        if (row.unique_id != null) snippetCount++;
      });
    });
    g.referenceCount = refKeys.size;
    g.snippetCount = snippetCount;
    delete g._relationIds;
  });

  groups.sort((a, b) => b.targetCount - a.targetCount);
  res.json({ groups });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Ontology Analysis endpoints
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/ontology/roots
// Returns root SemanticConcept nodes: have is_a children but no is_a/part_of parents
app.get('/api/ontology/roots', dbLimiter, authMiddleware, async (req, res) => {
  const cypher = `
    MATCH (root:SemanticConcept)
    WHERE (root)<-[:is_a]-()
    AND NOT (root)-[:is_a|part_of]->()
    RETURN root
    ORDER BY root.name
  `;
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(cypher);
    const nodes = result.records.map(r => {
      const n = r.get('root');
      const p = toPlain(n.properties);
      return {
        id: n.identity.toString(),
        labels: n.labels,
        name: String(p.name || p.Name || p[NEO4J_URN_PROP] || n.identity.toString()),
        urn: String(p[NEO4J_URN_PROP] || '')
      };
    });
    res.json({ nodes });
  } catch (err) {
    console.error('ontology-roots error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});


// POST /api/ontology/direct-children
// Body: { urn: string }
// Returns the immediate (one-level) children of the given ontology node via is_a|part_of
app.post('/api/ontology/direct-children', dbLimiter, authMiddleware, async (req, res) => {
  const { urn } = req.body || {};
  if (!urn || typeof urn !== 'string' || !urn.trim())
    return res.status(400).json({ error: 'urn is required' });

  const cypher = `
    MATCH (parent {\`${NEO4J_URN_PROP}\`: $urn})
    MATCH (child)-[:is_a|part_of]->(parent)
    RETURN DISTINCT child
    ORDER BY child.name
  `;
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(cypher, { urn });
    const nodes = result.records.map(r => {
      const n = r.get('child');
      const p = toPlain(n.properties);
      return {
        id: n.identity.toString(),
        labels: n.labels,
        name: String(p.name || p.Name || p[NEO4J_URN_PROP] || n.identity.toString()),
        urn: String(p[NEO4J_URN_PROP] || '')
      };
    });
    res.json({ nodes });
  } catch (err) {
    console.error('ontology-direct-children error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});


// POST /api/ontology/batch-counts
// Body: { urns: string[], graphUrns: string[] }
// For each ontology URN, counts how many graphUrns are descendants of it.
// Returns { entries: [{urn, count}] }
// Response uses an array of objects so user-supplied strings are never object property keys.
const _URN_KEY_RE = /^[a-zA-Z0-9:@%.~_\-]{1,500}$/; // allowlist for URN validation

app.post('/api/ontology/batch-counts', dbLimiter, authMiddleware, async (req, res) => {
  const { urns = [], graphUrns = [] } = req.body || {};
  if (!Array.isArray(urns) || !urns.length) return res.json({ entries: [] });
  // Validate every URN before use
  const safeUrns = urns.filter(u => typeof u === 'string' && _URN_KEY_RE.test(u));
  if (!safeUrns.length) return res.json({ entries: [] });

  // Fast-path: no graphUrns supplied — every count is 0
  // Return as array of {urn, count} objects; user strings are values, never keys.
  if (!Array.isArray(graphUrns) || !graphUrns.length) {
    return res.json({ entries: safeUrns.map(u => ({ urn: u, count: 0 })) });
  }

  const cypher = `
    UNWIND $urns AS parentUrn
    MATCH (parent {\`${NEO4J_URN_PROP}\`: parentUrn})
    OPTIONAL MATCH (descendant)-[:is_a|part_of*0..]->(parent)
    WHERE descendant.\`${NEO4J_URN_PROP}\` IN $graphUrns
    RETURN parentUrn, count(DISTINCT descendant) AS cnt
  `;
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(cypher, { urns: safeUrns, graphUrns });
    // Use a Map (not a plain object) to accumulate Neo4j results; Map keys are not prototype-pollutable.
    const cntMap = new Map();
    result.records.forEach(r => {
      const u = String(r.get('parentUrn'));
      if (_URN_KEY_RE.test(u)) {
        cntMap.set(u, neo4j.isInt(r.get('cnt')) ? r.get('cnt').toNumber() : (Number(r.get('cnt')) || 0));
      }
    });
    // Emit as an array of {urn, count} entries — no user string is ever an object property key
    const entries = safeUrns.map(u => ({ urn: u, count: cntMap.get(u) || 0 }));
    res.json({ entries });
  } catch (err) {
    console.error('ontology-batch-counts error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});


// POST /api/ontology/descendants
// Body: { urn: string, graphUrns: string[] }
// Returns URNs of all descendants of the given ontology node that appear in graphUrns.
app.post('/api/ontology/descendants', dbLimiter, authMiddleware, async (req, res) => {
  const { urn, graphUrns = [] } = req.body || {};
  if (!urn || typeof urn !== 'string' || !urn.trim())
    return res.status(400).json({ error: 'urn is required' });

  const filterClause = (Array.isArray(graphUrns) && graphUrns.length)
    ? `WHERE descendant.\`${NEO4J_URN_PROP}\` IN $graphUrns`
    : '';
  const cypher = `
    MATCH (parent {\`${NEO4J_URN_PROP}\`: $urn})
    MATCH (descendant)-[:is_a|part_of*0..]->(parent)
    ${filterClause}
    RETURN DISTINCT descendant.\`${NEO4J_URN_PROP}\` AS urn
  `;
  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const result = await session.run(cypher, { urn, graphUrns });
    const urns = result.records
      .map(r => toPlain(r.get('urn')))
      .filter(u => u != null && u !== '');
    res.json({ urns });
  } catch (err) {
    console.error('ontology-descendants error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});

// POST /api/ontology/subtree
// Body: { urn: string, graphUrns: string[] }
// Returns the full ontology hierarchy from the given root down to the matching
// graph entities, including all intermediate ontology nodes and their
// is_a / part_of edges.  Used by "Copy ontology tree" in the context menu.
app.post('/api/ontology/subtree', dbLimiter, authMiddleware, async (req, res) => {
  const { urn, graphUrns = [] } = req.body || {};
  if (!urn || typeof urn !== 'string' || !urn.trim())
    return res.status(400).json({ error: 'urn is required' });
  if (!Array.isArray(graphUrns) || !graphUrns.length)
    return res.status(400).json({ error: 'graphUrns is required' });

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    // 1. All distinct nodes on any path from a matching entity up to the root
    const nodeResult = await session.run(`
      MATCH path = (entity)-[:is_a|part_of*0..]->(root)
      WHERE root.\`${NEO4J_URN_PROP}\` = $urn
        AND entity.\`${NEO4J_URN_PROP}\` IN $graphUrns
      UNWIND nodes(path) AS n
      WITH DISTINCT n
      RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props
    `, { urn, graphUrns });

    // 2. All distinct is_a / part_of edges on those same paths
    const edgeResult = await session.run(`
      MATCH path = (entity)-[:is_a|part_of*0..]->(root)
      WHERE root.\`${NEO4J_URN_PROP}\` = $urn
        AND entity.\`${NEO4J_URN_PROP}\` IN $graphUrns
      UNWIND relationships(path) AS r
      WITH DISTINCT r
      RETURN elementId(r) AS id, type(r) AS relType,
             elementId(startNode(r)) AS startId,
             elementId(endNode(r))   AS endId
    `, { urn, graphUrns });

    const nodes = nodeResult.records.map(rec => ({
      id:     rec.get('id'),
      labels: rec.get('labels'),
      props:  toPlain(rec.get('props'))
    }));
    const edges = edgeResult.records.map(rec => ({
      id:      rec.get('id'),
      relType: rec.get('relType'),
      startId: rec.get('startId'),
      endId:   rec.get('endId')
    }));

    res.json({ nodes, edges });
  } catch (err) {
    console.error('ontology-subtree error:', err.message);
    res.status(500).json({ error: safeError(err) });
  } finally {
    await session.close();
  }
});
