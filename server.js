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

// ─── Neo4j ───────────────────────────────────────────────────────────────────
// bolt+ssc = encrypted, trust all certificates (including self-signed)
const neo4jDriver = neo4j.driver(
  'YOUR_NEO4J_URI',
  neo4j.auth.basic('YOUR_NEO4J_USER', 'YOUR_NEO4J_PASSWORD')
);
const NEO4J_DB = 'mammaloct2025new';
// URN property name on Neo4j nodes — change to match your schema (e.g. 'id', '@id', 'URN')
const NEO4J_URN_PROP = process.env.NEO4J_URN_PROP || 'URN';

// ─── RNEF conversion ──────────────────────────────────────────────────────────
// Path to rnef_to_json.py — defaults to same directory as server.js.
// Override with RNEF_SCRIPT env var if placed elsewhere.
const RNEF_SCRIPT = process.env.RNEF_SCRIPT || path.join(__dirname, 'rnef_to_json.py');
const PYTHON_CMD  = process.env.PYTHON_CMD  || (() => {
  // Auto-detect: try python3, python, py in order
  const { execFileSync } = require('child_process');
  for (const cmd of ['python3', 'python', 'py']) {
    try { execFileSync(cmd, ['--version'], { timeout: 3000 }); return cmd; } catch(e) {}
  }
  return 'python3'; // fallback — will surface a clear error if missing
})();

// ─── PostgreSQL schema ────────────────────────────────────────────────────────
// Change this to match your schema name (each user may have a different one).
const PG_SCHEMA = process.env.PG_SCHEMA || 'resnetcustomnov';

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pgPool = new Pool({
  host: 'YOUR_PG_HOST',
  port: 5432,
  database: 'YOUR_PG_DATABASE',
  user: 'YOUR_PG_USER',
  password: 'YOUR_PG_PASSWORD',
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_JWT_SECRET';
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
  fs.writeFileSync(USERS_FILE, JSON.stringify(safe, null, 2));
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
    const out = {};
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
    if (!edgesMap.has(id)) {
      edgesMap.set(id, {
        id,
        elementId: val.elementId || id,
        type: val.type,
        startNodeId: val.start.toString(),
        endNodeId: val.end.toString(),
        properties: toPlain(val.properties)
      });
    }
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
  const SCOPUS_COL_SQL = {
    citation_type:  'sd."citation_type"  AS "sd_citation_type"',
    citation_count: 'sd."citation_count" AS "sd_citation_count"',
    sjr:            'sd."sjr"            AS "sd_sjr"',
    snip:           'sd."snip"           AS "sd_snip"',
    source_title:   'sd."source_title"   AS "sd_source_title"',
    issn:           'sd."issn"           AS "sd_issn"',
    volume:         'sd."volume"         AS "sd_volume"',
    issue:          'sd."issue"          AS "sd_issue"',
    pages:          'sd."pages"          AS "sd_pages"',
    open_access:    'sd."open_access"    AS "sd_open_access"',
    subject_area:   'sd."subject_area"   AS "sd_subject_area"',
    keywords:       'sd."keywords"       AS "sd_keywords"',
    abstract:       'sd."abstract"       AS "sd_abstract"',
    affiliation:    'sd."affiliation"    AS "sd_affiliation"',
    funding_info:   'sd."funding_info"   AS "sd_funding_info"'
  };
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
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
    return res.status(400).json({ error: 'Only SELECT / WITH queries are permitted' });
  }
  try {
    const result = await pgPool.query(sql);
    res.json({ rows: result.rows, fields: result.fields.map(function(f) { return f.name; }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── RNEF → JSON conversion ───────────────────────────────────────────────────
// Accepts raw XML text body (Content-Type: text/plain, up to 50 MB) and returns
// { pathways: [{name, data}, ...] }.  Using text/plain avoids the global 10 MB
// express.json limit — the body is never JSON-parsed by the global middleware.
app.post('/api/convert/rnef', express.text({ limit: '50mb', type: 'text/plain' }), authMiddleware, async (req, res) => {
  const content = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnef-'));
  const inputPath = path.join(tmpDir, 'input.rnef');
  const outDir    = path.join(tmpDir, 'out');
  fs.mkdirSync(outDir);
  fs.writeFileSync(inputPath, content, 'utf8');

  try {
    await new Promise((resolve, reject) => {
      execFile(PYTHON_CMD, [RNEF_SCRIPT, inputPath, outDir],
        { timeout: 120000 },
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

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Graph Explorer running on http://localhost:${PORT}`);
});