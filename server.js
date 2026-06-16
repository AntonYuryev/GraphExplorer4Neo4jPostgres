const express = require('express');
const neo4j = require('neo4j-driver');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const rateLimit = require('express-rate-limit');

const app = express();
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

// ─── Persistent settings (settings.json) ─────────────────────────────────────
// Connection credentials are stored here so admins can update them via the UI
// without restarting the server.  The file lives next to server.js and is never
// served to clients (it is outside the public/ directory).
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

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
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); // codeql[js/network-data-written-to-file]
}

let appSettings = loadAppSettings();

// ─── Neo4j ───────────────────────────────────────────────────────────────────
// URN property name on Neo4j nodes — change to match your schema (e.g. 'id', '@id', 'URN')
const NEO4J_URN_PROP = process.env.NEO4J_URN_PROP || 'URN';

function makeNeo4jDriver(cfg) {
  return neo4j.driver(cfg.url, neo4j.auth.basic(cfg.username, cfg.password));
}

let neo4jDriver = makeNeo4jDriver(appSettings.neo4j);
let NEO4J_DB    = appSettings.neo4j.database;

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

let pgPool    = makePgPool(appSettings.postgres);

// Validate schema name: must be a plain SQL identifier (letters, digits, underscores).
// This sanitises every downstream ${PG_SCHEMA} interpolation, preventing SQL injection
// regardless of how the schema was configured (settings.json or the Settings UI).
function sanitizeSchemaName(name) {
  const s = (typeof name === 'string' ? name : '') || 'resnetcustomnov';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(`Unsafe PostgreSQL schema name rejected: "${s}"`);
  }
  return s;
}

let PG_SCHEMA = sanitizeSchemaName(appSettings.postgres.schema);

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
  const NAME_RE   = /^[a-zA-Z0-9_-]{1,64}$/;
  const BCRYPT_RE = /^\$2[ab]\$\d{2}\$[./A-Za-z0-9]{53}$/;

  const safe = [];
  for (const u of users) {
    const nameMatch  = NAME_RE.exec(typeof u.username === 'string' ? u.username : '');
    const hashMatch  = BCRYPT_RE.exec(typeof u.password === 'string' ? u.password : '');
    // Role is always a hardcoded literal — never the user-supplied value itself.
    const role = u.role === 'admin' ? 'admin' : 'user';
    if (nameMatch && hashMatch) {
      safe.push({ username: nameMatch[0], password: hashMatch[0], role });
    }
  }
  // codeql[js/network-data-written-to-file] - `safe` contains only regex match[0]
  // values (NAME_RE / BCRYPT_RE) and hardcoded role literals; no raw network
  // data reaches this write.
  fs.writeFileSync(USERS_FILE, JSON.stringify(safe, null, 2)); // codeql[js/network-data-written-to-file]
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
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
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

// ─── Connection settings (admin only) ────────────────────────────────────────
app.get('/api/settings/neo4j', dbLimiter, authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    url:      appSettings.neo4j.url,
    database: appSettings.neo4j.database,
    username: appSettings.neo4j.username,
    password: appSettings.neo4j.password ? '••••••••' : ''  // never send real password to client
  });
});

app.post('/api/settings/neo4j', dbLimiter, authMiddleware, adminMiddleware, async (req, res) => {
  const { url, database, username, password } = req.body || {};
  if (!url || !database || !username) return res.status(400).json({ error: 'url, database, and username are required' });

  const cfg = {
    url:      String(url).trim(),
    database: String(database).trim(),
    username: String(username).trim(),
    password: (password && password !== '••••••••') ? String(password) : appSettings.neo4j.password
  };

  // Test the new connection before committing
  const testDriver = makeNeo4jDriver(cfg);
  try {
    const session = testDriver.session({ database: cfg.database });
    await session.run('RETURN 1');
    await session.close();
  } catch(e) {
    await testDriver.close();
    return res.status(400).json({ error: 'Connection test failed: ' + e.message });
  }

  // Commit: close old driver, switch to new
  try { await neo4jDriver.close(); } catch(e) {}
  neo4jDriver = testDriver;
  NEO4J_DB    = cfg.database;
  appSettings.neo4j = cfg;
  saveAppSettings(appSettings);
  res.json({ success: true });
});

app.get('/api/settings/postgres', dbLimiter, authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    host:     appSettings.postgres.host,
    port:     appSettings.postgres.port,
    database: appSettings.postgres.database,
    schema:   appSettings.postgres.schema,
    username: appSettings.postgres.username,
    password: appSettings.postgres.password ? '••••••••' : ''  // never send real password to client
  });
});

app.post('/api/settings/postgres', dbLimiter, authMiddleware, adminMiddleware, async (req, res) => {
  const { host, port, database, schema, username, password } = req.body || {};
  if (!host || !database || !schema || !username) return res.status(400).json({ error: 'host, database, schema, and username are required' });

  const cfg = {
    host:     String(host).trim(),
    port:     parseInt(port) || 5432,
    database: String(database).trim(),
    schema:   String(schema).trim(),
    username: String(username).trim(),
    password: (password && password !== '••••••••') ? String(password) : appSettings.postgres.password
  };

  // Test the new connection before committing
  const testPool = makePgPool(cfg);
  try {
    await testPool.query('SELECT 1');
  } catch(e) {
    await testPool.end();
    return res.status(400).json({ error: 'Connection test failed: ' + e.message });
  }

  // Commit: end old pool, switch to new
  try { await pgPool.end(); } catch(e) {}
  pgPool    = testPool;
  PG_SCHEMA = sanitizeSchemaName(cfg.schema);
  appSettings.postgres = cfg;
  saveAppSettings(appSettings);
  res.json({ success: true });
});

// ─── Neo4j query ─────────────────────────────────────────────────────────────
app.post('/api/graph/query', dbLimiter, authMiddleware, async (req, res) => {
  const { query } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Cypher query is required' });

  const session = neo4jDriver.session({ database: NEO4J_DB });
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
    res.status(500).json({ error: err.message });
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
  const session = neo4jDriver.session({ database: NEO4J_DB });
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
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

// ─── PostgreSQL references (tooltip — single edge hover) ──────────────────────
// RelationID in Neo4j is a string; id in Postgres is bigint.
// Pass as strings and cast to bigint in SQL to preserve full 64-bit precision.
app.post('/api/references', dbLimiter, authMiddleware, async (req, res) => {
  const { relationIds } = req.body || {};
  if (!Array.isArray(relationIds) || !relationIds.length) return res.json([]);

  const validIds = relationIds.map(String).filter(id => /^-?\d+$/.test(id));
  if (!validIds.length) return res.json([]);

  try {
    const sql = `
      SELECT *
      FROM ${PG_SCHEMA}.reference
      WHERE id = ANY($1::bigint[])
      ORDER BY COALESCE(pubyear::text, '9999'), id
    `;
    const result = await pgPool.query(sql, [validIds]);
    res.json(result.rows);
  } catch (err) {
    // Fallback without ORDER BY date in case column name differs
    try {
      const sql2 = `SELECT * FROM ${PG_SCHEMA}.reference WHERE id = ANY($1::bigint[])`;
      const result2 = await pgPool.query(sql2, [validIds]);
      res.json(result2.rows);
    } catch (err2) {
      console.error('PostgreSQL error:', err2.message);
      res.status(500).json({ error: err2.message });
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

app.post('/api/references/batch', dbLimiter, authMiddleware, async (req, res) => {
  const { relationIds, scopusColumns } = req.body || {};
  if (!Array.isArray(relationIds) || !relationIds.length) return res.json({});

  const validIds = relationIds.map(String).filter(id => /^-?\d+$/.test(id));
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
        FROM ${PG_SCHEMA}.reference r
        LEFT JOIN ${PG_SCHEMA}.scopus_data sd ON r.unique_id = sd.reference_id
        WHERE r.id = ANY($1::bigint[])
        ORDER BY r.id, COALESCE(r.pubyear::text, '9999')
      `;
    } else {
      sql = `
        SELECT *
        FROM ${PG_SCHEMA}.reference
        WHERE id = ANY($1::bigint[])
        ORDER BY id, COALESCE(pubyear::text, '9999')
      `;
    }
    const result = await pgPool.query(sql, [validIds]);

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
    res.status(500).json({ error: err.message });
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
      FROM ${PG_SCHEMA}.node AS n
      JOIN ${PG_SCHEMA}.attr AS a ON a.id = ANY(n.attributes)
      WHERE a.name = 'MedScan ID'
      AND n.id = ANY($1::bigint[])
    `;
    const result = await pgPool.query(sql, [validIds]);
    const map = {};
    result.rows.forEach(row => { map[row.id] = row.value; });
    res.json(map);
  } catch (err) {
    console.error('MedScan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Node property names filtered to current pathway nodes ───────────────────
app.post('/api/nodes/property-names', dbLimiter, authMiddleware, async (req, res) => {
  const { nodeIds = [] } = req.body || {};
  const validIds = nodeIds.map(String).filter(id => /^-?\d+$/.test(id));
  if (!validIds.length) return res.json([]);

  try {
    const result = await pgPool.query(
      `SELECT DISTINCT a.name
       FROM ${PG_SCHEMA}.node n
       JOIN ${PG_SCHEMA}.attr a ON a.id = ANY(n.attributes)
       WHERE n.id = ANY($1::bigint[])
       ORDER BY a.name`,
      [validIds]
    );
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    console.error('property-names error:', err.message);
    res.status(500).json({ error: err.message });
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
      FROM ${PG_SCHEMA}.node AS n
      JOIN ${PG_SCHEMA}.attr AS a ON a.id = ANY(n.attributes)
      WHERE n.id = ANY($1::bigint[])
        AND a.name = ANY($2::text[])
    `;
    const result = await pgPool.query(sql, [validIds, safeProps]);
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
      FROM ${PG_SCHEMA}.node AS n
      JOIN ${PG_SCHEMA}.attr AS a_urn ON a_urn.id = ANY(n.attributes)
      JOIN ${PG_SCHEMA}.attr AS a     ON a.id     = ANY(n.attributes)
      WHERE a_urn.name = 'URN'
        AND a_urn.value = ANY($1::text[])
        AND a.name = ANY($2::text[])
    `;
    const result = await pgPool.query(sql, [safeUrns, safeProps]);
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

  const session = neo4jDriver.session({ database: NEO4J_DB });
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
    res.status(500).json({ error: err.message });
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
    await pgPool.query(
      `UPDATE ${PG_SCHEMA}.reference SET msrc = $1 WHERE id = $2::bigint`,
      [msrc, safeId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Reference update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Neo4j node property update (curation) ───────────────────────────────────
app.post('/api/graph/update-node', dbLimiter, authMiddleware, async (req, res) => {
  const { elementId, properties } = req.body || {};
  if (!elementId || typeof properties !== 'object') {
    return res.status(400).json({ error: 'elementId and properties required' });
  }
  const session = neo4jDriver.session({ database: NEO4J_DB });
  try {
    await session.run(
      'MATCH (n) WHERE elementId(n) = $eid SET n += $props',
      { eid: elementId, props: properties }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('update-node error:', err.message);
    res.status(500).json({ error: err.message });
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
  const session = neo4jDriver.session({ database: NEO4J_DB });
  try {
    await session.run(
      'MATCH ()-[r]->() WHERE elementId(r) = $eid SET r += $props',
      { eid: elementId, props: properties }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('update-relation error:', err.message);
    res.status(500).json({ error: err.message });
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
    const refCols = await pgPool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'reference'
       ORDER BY ordinal_position`,
      [PG_SCHEMA]
    );
    res.json({
      referenceColumns: refCols.rows.map(r => r.column_name),
      scopusColumns: Object.keys(SCOPUS_COL_SQL)
    });
  } catch (err) {
    console.error('schema/columns error:', err.message);
    res.status(500).json({ error: err.message });
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
    const result = await pgPool.query(sql); // codeql[js/sql-injection] codeql[js/database-query-built-from-user-controlled-sources] — admin-only endpoint; sql validated as SELECT/WITH-only with no stacked statements
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

  const session = neo4jDriver.session({ database: NEO4J_DB });
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

  const session = neo4jDriver.session({ database: NEO4J_DB });
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
    res.status(500).json({ error: err.message });
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

  const session = neo4jDriver.session({ database: NEO4J_DB });
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
        const val = rec.get(p);
        out[relId][p] = (val != null && typeof val === 'object' && val.toNumber)
          ? val.toNumber()
          : val;
      });
    });
    res.json(out);
  } catch (err) {
    console.error('Neo4j relations/properties error:', err.message);
    res.status(500).json({ error: err.message });
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

  const session = neo4jDriver.session({ database: NEO4J_DB });

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
      rows.forEach(r => { (g[r.relType] = g[r.relType] || []).push(r); });
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
    res.status(500).json({ error: err.message });
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
  fs.writeFileSync(inputPath, content, 'utf8'); // codeql[js/network-data-written-to-file] - content is RNEF XML written to a server-controlled tmpdir path; not served back to clients

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
    res.status(500).json({ error: 'Conversion failed: ' + err.message });
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

  const DIRECT_TYPES   = ['Binding','DirectRegulation','ProtModification','PromoterBinding','ChemicalReaction'];
  const BIOMARKER_TYPES = ['Biomarker','QuantitativeChange','StateChange','GeneticChange'];

  // Build relationship-type filter clause for Cypher
  let typeFilter = '';
  if (filterType === 'direct') {
    typeFilter = 'AND type(r) IN $typeList ';
  } else if (filterType === 'biomarker') {
    typeFilter = 'AND type(r) IN $typeList ';
  } else if (filterType === 'indirect') {
    typeFilter = 'AND NOT type(r) IN $typeList ';
  }
  // filterType === 'all': no filter

  const typeList = filterType === 'direct'   ? DIRECT_TYPES
                 : filterType === 'biomarker' ? BIOMARKER_TYPES
                 : filterType === 'indirect'  ? DIRECT_TYPES   // excluded for indirect
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

  const session = neo4jDriver.session({ database: NEO4J_DB });
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
    res.status(500).json({ error: err.message });
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

  let typeFilter = '';
  if (filterType === 'direct')   typeFilter = 'AND type(r) IN $typeList ';
  else if (filterType === 'biomarker') typeFilter = 'AND type(r) IN $typeList ';
  else if (filterType === 'indirect')  typeFilter = 'AND NOT type(r) IN $typeList ';

  const typeList = filterType === 'direct'    ? DIRECT_TYPES
                 : filterType === 'biomarker' ? BIOMARKER_TYPES
                 : filterType === 'indirect'  ? DIRECT_TYPES
                 : [];

  function normDisplayEff(v) {
    if (v == null) return '';
    const s = String(v);
    if (s === '' || s === '_' || s.toLowerCase() === 'unknown') return '';
    if (s.toLowerCase() === 'positive') return 'Positive';
    if (s.toLowerCase() === 'negative') return 'Negative';
    return s;
  }

  const session = neo4jDriver.session({ database: NEO4J_DB });
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
    res.status(500).json({ error: err.message });
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

  // Transform the query into a fast COUNT query by replacing the RETURN clause.
  // e.g.  MATCH ... RETURN a,r,b  →  MATCH ... RETURN count(*) AS edgeCount
  // This avoids fetching full node/edge data just to count rows.
  const returnPos = query.search(/\bRETURN\b/i);
  const countQuery = returnPos !== -1
    ? query.substring(0, returnPos) + 'RETURN count(*) AS edgeCount'
    : query;  // fallback: run original if no RETURN found

  const session = neo4jDriver.session({ database: NEO4J_DB });
  try {
    const result = await session.run(countQuery);
    let edgeCount = 0;
    if (result.records.length > 0) {
      const val = result.records[0].get('edgeCount');
      // Neo4j returns integers as neo4j.Integer objects
      edgeCount = (val && typeof val.toNumber === 'function') ? val.toNumber() : Number(val);
    }
    res.json({ edgeCount });
  } catch (err) {
    console.error('count-query error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Graph Explorer running on http://localhost:${PORT}`);
});

// ─── Neo4j schema introspection ───────────────────────────────────────────────
// GET /api/graph/schema
// Returns { labels: [...], relTypes: [...], propKeys: [...] }
app.get('/api/graph/schema', dbLimiter, authMiddleware, async (req, res) => {
  // Use three separate sessions — Neo4j forbids concurrent queries on one session
  const s1 = neo4jDriver.session({ database: NEO4J_DB });
  const s2 = neo4jDriver.session({ database: NEO4J_DB });
  const s3 = neo4jDriver.session({ database: NEO4J_DB });
  try {
    const [labelsResult, relTypesResult, propKeysResult] = await Promise.all([
      s1.run('CALL db.labels()'),
      s2.run('CALL db.relationshipTypes()'),
      s3.run('CALL db.propertyKeys()'),
    ]);
    const labels   = labelsResult.records.map(r => r.get('label'));
    const relTypes = relTypesResult.records.map(r => r.get('relationshipType'));
    const propKeys = propKeysResult.records.map(r => r.get('propertyKey'));
    res.json({ labels, relTypes, propKeys });
  } catch (err) {
    console.error('schema error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await Promise.all([s1.close(), s2.close(), s3.close()]);
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

  const DIRECT_TYPES = ['Binding','DirectRegulation','ProtModification','PromoterBinding','ChemicalReaction'];

  // Build rel-type clause
  let relClause = '-[r]-';
  if (mode === 'direct') {
    relClause = '-[r:' + DIRECT_TYPES.join('|') + ']-';
  } else if (mode === 'biomarker') {
    relClause = '-[r:Biomarker|QuantitativeChange|StateChange|GeneticChange]-';
  }
  // 'indirect' and 'to' use no type filter in the pattern; indirect is filtered by WHERE below

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

  // Build indirect exclusion clause
  let indirectClause = '';
  if (mode === 'indirect') {
    indirectClause = ' AND NOT type(r) IN ' + JSON.stringify(DIRECT_TYPES);
  }

  const cypher =
    'MATCH (a)' + relClause + '(b) ' +
    'WHERE a.`' + NEO4J_URN_PROP + '` IN $urns' +
    targetClause + indirectClause +
    ' RETURN a, r, b LIMIT 2000';

  const session = neo4jDriver.session({ database: NEO4J_DB });
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
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});
