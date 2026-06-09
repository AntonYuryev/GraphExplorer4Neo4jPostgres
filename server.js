const express = require('express');
const neo4j = require('neo4j-driver');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
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
  'bolt+ssc://neo4j.lifesciencepsg.com:7687',
  neo4j.auth.basic('yuryeva', 'El$evier2024')
);
const NEO4J_DB = 'mammaloct2025new';

// ─── PostgreSQL schema ────────────────────────────────────────────────────────
// Change this to match your schema name (each user may have a different one).
const PG_SCHEMA = process.env.PG_SCHEMA || 'resnetcustomnov';

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pgPool = new Pool({
  host: 'postgres.cldbkt9huzvb.us-east-2.rds.amazonaws.com',
  port: 5432,
  database: 'psgdev',
  user: 'psguser',
  password: 'k4ZHuXWjt8eodjgeZimkCdzJgmAKoI8KPGXZphG4tbt2ujUw1rxSJpLhSHAtVOvx',
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'graph-explorer-jwt-secret-change-in-production';
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
    for (const [k, v] of Object.entries(val)) out[k] = toPlain(v);
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

    res.json({
      nodes: Array.from(nodesMap.values()),
      edges: Array.from(edgesMap.values())
    });
  } catch (err) {
    console.error('Neo4j error:', err.message);
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
    console.error('MedScan lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PostgreSQL: update reference row ────────────────────────────────────────
// Column names are validated against actual table columns to prevent SQL injection.
app.post('/api/references/update', dbLimiter, authMiddleware, async (req, res) => {
  const { id, fields } = req.body || {};
  if (!id || !fields) return res.status(400).json({ error: 'id and fields required' });

  const ALLOWED = ['pmid', 'doi', 'title', 'msrc', 'pubyear', 'journal', 'journalname'];
  const pairs = Object.entries(fields).filter(([k]) => ALLOWED.includes(k));
  if (!pairs.length) return res.json({ success: true, updated: 0 });

  const params = [String(id)];
  const setClauses = pairs.map(([k, v], i) => {
    params.push(v);
    return `${k} = $${i + 2}`;
  });

  try {
    const result = await pgPool.query(
      `UPDATE ${PG_SCHEMA}.reference SET ${setClauses.join(', ')} WHERE id = $1::bigint`,
      params
    );
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    console.error('PostgreSQL update reference error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PostgreSQL: list columns for reference and scopus_data tables ────────────
app.get('/api/schema/columns', dbLimiter, authMiddleware, async (req, res) => {
  try {
    const refResult = await pgPool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'reference'
       ORDER BY ordinal_position`,
      [PG_SCHEMA]
    );

    let scopusColumns = [];
    try {
      const scopusResult = await pgPool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'scopus_data'
         ORDER BY ordinal_position`,
        [PG_SCHEMA]
      );
      scopusColumns = scopusResult.rows.map(r => r.column_name);
    } catch (e) {
      // scopus_data table may not exist in all schemas
    }

    res.json({
      reference: refResult.rows.map(r => r.column_name),
      scopus_data: scopusColumns,
      schema: PG_SCHEMA
    });
  } catch (err) {
    console.error('Schema columns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Curation: update node properties ────────────────────────────────────────
app.post('/api/graph/update-node', dbLimiter, authMiddleware, async (req, res) => {
  const { elementId, properties } = req.body || {};
  if (!elementId || !properties) return res.status(400).json({ error: 'elementId and properties required' });

  const props = Object.fromEntries(
    Object.entries(properties).filter(([, v]) => v !== null && v !== undefined)
  );
  const session = neo4jDriver.session({ database: NEO4J_DB });
  try {
    try {
      await session.run(
        'MATCH (n) WHERE elementId(n) = $elementId SET n += $props',
        { elementId, props }
      );
    } catch {
      const numId = neo4j.int(parseInt(elementId, 10));
      await session.run(
        'MATCH (n) WHERE id(n) = $numId SET n += $props',
        { numId, props }
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Update node error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

// ─── Curation: update relation properties ────────────────────────────────────
app.post('/api/graph/update-relation', dbLimiter, authMiddleware, async (req, res) => {
  const { elementId, properties } = req.body || {};
  if (!elementId || !properties) return res.status(400).json({ error: 'elementId and properties required' });

  const props = Object.fromEntries(
    Object.entries(properties).filter(([, v]) => v !== null && v !== undefined)
  );

  const session = neo4jDriver.session({ database: NEO4J_DB });
  try {
    try {
      await session.run(
        'MATCH ()-[r]-() WHERE elementId(r) = $elementId SET r += $props',
        { elementId, props }
      );
    } catch {
      const numId = neo4j.int(parseInt(elementId, 10));
      await session.run(
        'MATCH ()-[r]-() WHERE id(r) = $numId SET r += $props',
        { numId, props }
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Update relation error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\nGraph Explorer running at http://localhost:' + PORT);
  loadUsers();
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await neo4jDriver.close();
  await pgPool.end();
  process.exit(0);
});