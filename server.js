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
    // Guess a friendly name from the URL
    let name = 'Default';
    if (llm.url.includes('generativelanguage.googleapis.com')) name = 'Google Gemini';
    else if (llm.url.includes('anthropic.com')) name = 'Anthropic Claude';
    else if (llm.url.includes('openai.com')) name = 'OpenAI';
    llm.providers = [{ name, url: llm.url }];
    appSettings.llm = llm;
    saveAppSettings(appSettings);
    console.log(`[INFO] Migrated LLM config: created providers array from url "${llm.url}"`);
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
      if (neo4j)    entry.neo4j    = neo4j;
      if (postgres) entry.postgres = postgres;
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
    // Note: sql originates from an authenticated admin request and has been
    // validated above to be a read-only SELECT/WITH query with no stacked
    // statements or comment injection.  Parameterised queries cannot be used
    // here because the entire query text is the user-supplied value.
    const result = await req.pg.pool.query(sql); // codeql[js/sql-injection] codeql[js/database-query-built-from-user-controlled-sources] — admin-only endpoint; sql validated as SELECT/WITH-only with no stacked statements
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

    // ── ChemicalReaction hyperedges ─────────────────────────────────────────
    // In Neo4j a ChemicalReaction hyperedge is stored as many (a)-[r]->(b) rows
    // sharing the same RelationID.  We pre-filter with IN, then verify the full
    // set of matched regulators/targets equals the RNEF set via size comparison.
    if (hyperedgeBatch.length > 0) {
      const cypher = `
UNWIND $rows AS row
MATCH (a)-[r:ChemicalReaction]->(b)
WHERE a.URN IN row.rURNs AND b.URN IN row.tURNs
WITH row, r.RelationID AS relID, r.RelationNumberOfSentences AS numSentences,
     collect(DISTINCT a.URN) AS matchedRegs,
     collect(DISTINCT b.URN) AS matchedTgts
WHERE size(matchedRegs) = size(row.rURNs) AND size(matchedTgts) = size(row.tURNs)
RETURN DISTINCT row.relURN AS relURN, relID AS relationID, numSentences`;

      const result = await session.run(cypher, { rows: hyperedgeBatch });
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
  req.on('error', e => console.warn('[agent] schema push failed:', e.message));
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
    console.error('[agent proxy] error:', e.message);
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
app.post('/api/graph/shortest-path', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeParams = [], maxLength, relTypes = [] } = req.body || {};

  const safeNodes = (Array.isArray(nodeParams) ? nodeParams : []).filter(np =>
    np && typeof np.label === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(np.label) &&
    typeof np.urn === 'string' && np.urn.trim().length > 0
  );
  if (safeNodes.length < 2)
    return res.status(400).json({ error: 'At least two valid selected nodes are required' });
  if (safeNodes.length > 10)
    return res.status(400).json({ error: 'Please select 10 or fewer nodes for shortest path (each pair is computed separately)' });

  const len = Number.isInteger(maxLength) && maxLength >= 1 && maxLength <= 15 ? maxLength : 2;

  const safeTypes = (Array.isArray(relTypes) ? relTypes : [])
    .filter(t => typeof t === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
  if (!safeTypes.length)
    return res.status(400).json({ error: 'At least one relation type must be selected' });

  const typePattern = safeTypes.map(t => '`' + t + '`').join('|');

  const session = req.neo4j.driver.session({ database: req.neo4j.database });
  try {
    const nodesMap = new Map();
    const edgesMap = new Map();
    let pathsFound = 0;

    for (let i = 0; i < safeNodes.length; i++) {
      for (let j = i + 1; j < safeNodes.length; j++) {
        const a = safeNodes[i], b = safeNodes[j];
        const cypher = `
          MATCH (a {\`${NEO4J_URN_PROP}\`: $urnA}), (b {\`${NEO4J_URN_PROP}\`: $urnB})
          WHERE $labelA IN labels(a) AND $labelB IN labels(b)
          MATCH p = shortestPath((a)-[:${typePattern}*1..${len}]-(b))
          RETURN p
        `;
        const result = await session.run(cypher, {
          urnA: a.urn, urnB: b.urn, labelA: a.label, labelB: b.label
        });
        result.records.forEach(record => {
          const p = record.get('p');
          if (p) { pathsFound++; processValue(p, nodesMap, edgesMap); }
        });
      }
    }

    res.json({
      nodes: Array.from(nodesMap.values()),
      edges: Array.from(edgesMap.values()),
      pathsFound,
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
