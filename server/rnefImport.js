/**
 * rnefImport.js — Database -> Import RNEF engine.
 *
 * Bulk-imports RNEF XML (a single file, or every *.rnef/*.xml file under a
 * server-side directory) into the shared Neo4j + Postgres databases:
 *   - new nodes get NodeID = myhash(URN) and are written to Neo4j plus
 *     Postgres `node`/`attr`;
 *   - new relations (RelationID computed via calcRelationId(), same as the
 *     browser's matchRnefRelationsToNeo4j()) are created in Neo4j in batches
 *     of 5000 and excluded entirely if their RelationID already exists;
 *   - references are deduped against Postgres by identifier (doi/pmid/embase/
 *     nct_id/pii/pui) for every batch, with an additional sentence-prefix
 *     recheck when the whole job is under 1000 relations.
 *
 * Does NOT own Neo4j/Postgres connections, SQL-building helpers, or the
 * RelationID/myhash algorithm itself — all of that is passed in from
 * server.js via createRnefImporter(deps) so there is exactly one copy of
 * each, matching the behavior server.js's other endpoints already rely on.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Relation types that use `inoutref` (undirected participant list) instead of
// `inref`/`outref` for RelationID hashing — mirrors public/app.js's own
// RELID_NONDIRECTIONAL_TYPES exactly (that set, not this one, is the single
// source of truth for the BROWSER path; this is the server-side mirror for
// the bulk import path, since the hashing algorithm requires both sides to
// classify a relation type identically or RelationIDs silently diverge).
const RELID_NONDIRECTIONAL_TYPES = new Set(['Binding', 'CellExpression', 'FunctionalAssociation', 'Metabolization', 'Paralog']);

// Approved Neo4j node/relation property subsets — see the Database -> Import
// RNEF FRD. Anything else on a parsed node/control is still captured (node
// attrs -> Postgres `attr` table; reference fields -> Postgres `reference`
// table) but is NOT written onto the Neo4j node/relationship itself.
const NEO4J_NODE_PROPS = [
  'Alias', 'CAS_ID', 'Class', 'Clinvar_VCV_ID', 'Description', 'Localization',
  'MedScan_ID', 'Name', 'Notes', 'Pharmapendium_ID', 'Reaxys_ID'
  // NodeID / URN are handled separately below (computed/authoritative values,
  // not read off raw_attrs like the rest of this list).
];
const NEO4J_REL_PROPS = [
  'BiomarkerType', 'CellLineName', 'CellType', 'ChangeType', 'Organ',
  'Organism', 'Phase', 'QuantitativeType', 'Source', 'Tissue'
  // Effect/Mechanism/RelationID are handled separately (already first-class
  // fields on a parsed edge, not looked up by name here).
];

// Reference identifier columns used for the "is this reference new?" dedup
// check — exactly the FRD's list (doi/pmid/embase/nct_id/pii/pui).
const REF_IDENTIFIER_COLS = ['doi', 'pmid', 'embase', 'nct_id', 'pii', 'pui'];

const RELATIONS_BATCH_SIZE = 5000;
const SMALL_IMPORT_THRESHOLD = 1000;
const NODE_UNWIND_CHUNK = 2000;
const REF_PREFETCH_CHUNK = 2000;
const PG_INSERT_ROWS_PER_STATEMENT = 500;

function sentencePrefix(s) {
  return String(s || '').slice(0, 5);
}

function createRnefImporter(deps) {
  const {
    PYTHON_CMD, RNEF_SCRIPT,
    myhash, calcRelationId,
    quoteCypherIdent,
    computeRefUniqueId, computeUniqueRef,
    neo4j, // the neo4j-driver module itself, for neo4j.int() — RelationID must
           // always be stored/matched as a Neo4j Integer, never a raw JS
           // string, to stay consistent with every other RelationID write in
           // this app (see write-relation's own neo4j.int() usage).
  } = deps;

  // calcRelationId()/myhash()/Postgres all hand back RelationID/NodeID as a
  // decimal string or BigInt — both are 64-bit values that MUST cross into
  // Cypher as a real Neo4j Integer (neo4j.int()), never a raw JS string or
  // number, or they either get stored as the wrong property type or silently
  // lose precision past Number.MAX_SAFE_INTEGER. Used for BOTH RelationID and
  // NodeID at every Cypher-call boundary below.
  const toNeoInt = (id) => neo4j.int(String(id));

  // ── File enumeration ────────────────────────────────────────────────────────
  function enumerateRnefFiles(targetPath) {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return [targetPath];
    const out = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(rnef|xml)$/i.test(entry.name)) out.push(full);
      }
    })(targetPath);
    return out;
  }

  // ── Parse one file via rnef_to_json.py --mode=import ───────────────────────
  // job is optional (only passed from runImportJob) — used purely to surface
  // live diagnostics (file size, elapsed time, stderr tail) in the progress
  // panel, since the Python subprocess can legitimately take a while on a
  // large file and the UI otherwise has nothing to show during that wait.
  function parseRnefFile(filePath, job) {
    return new Promise((resolve, reject) => {
      let fileSizeBytes = 0;
      try { fileSizeBytes = fs.statSync(filePath).size; } catch (_) {}
      const t0 = Date.now();
      console.log(`[rnef-import] parsing "${filePath}" (${(fileSizeBytes / 1048576).toFixed(1)} MB)…`);
      if (job) {
        job.phase = `parsing (${(fileSizeBytes / 1048576).toFixed(1)} MB)`;
        job.phaseStartedAt = t0;
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnefimport-'));
      execFile(
        PYTHON_CMD,
        [RNEF_SCRIPT, filePath, tmpDir, '--mode=import'],
        { maxBuffer: 1024 * 1024 * 1024, timeout: 600000 },
        (err, _stdout, stderr) => {
          const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
          if (job && stderr) job.lastStderr = String(stderr).split('\n').slice(-20).join('\n');
          try {
            if (err) {
              console.error(`[rnef-import] parse FAILED for "${filePath}" after ${elapsedSec}s: ${stderr || err.message}`);
              return reject(new Error(stderr || err.message));
            }
            console.log(`[rnef-import] parsed "${filePath}" in ${elapsedSec}s` + (stderr ? ` — ${stderr.trim().split('\n')[0]}` : ''));
            const outPath = path.join(tmpDir, '_import.json');
            const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            resolve(data.resnets || []);
          } catch (e) {
            console.error(`[rnef-import] post-parse error for "${filePath}" after ${elapsedSec}s:`, e.message);
            reject(e);
          } finally {
            try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
          }
        }
      );
    });
  }

  // ── Relation candidates from one resnet's already-resolved node ids ────────
  // Mirrors public/app.js's matchRnefRelationsToNeo4j(): groups edges by their
  // originating <control> (via the `controlId` field extract_resnet_core()
  // adds to every edge), computes RelationID the same way for both a plain
  // binary control (inref/outref or inoutref, by relation type) and a
  // hyperedge control (participant NodeIDs aggregated through the synthetic
  // HyperEdge hub node).
  function buildRelationCandidates(resnet, nodeIdByLocalId) {
    const groups = new Map();
    resnet.edges.forEach((e) => {
      const cid = e.controlId || e.id;
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid).push(e);
    });
    const hubNodeByEid = new Map();
    resnet.nodes.forEach((n) => {
      if (n.labels && n.labels.includes('HyperEdge')) hubNodeByEid.set(n.id, n);
    });

    const candidates = [];
    groups.forEach((edges, cid) => {
      const hub = hubNodeByEid.get(cid);
      if (hub) {
        // Hyperedge: RelationID attaches to the hub NODE (not the binary
        // participant relationships), exactly like the browser path does
        // (see matchRnefRelationsToNeo4j's "n.properties.RelationID = ..."
        // for HyperEdge hub nodes) — the participant relationships
        // themselves carry no RelationID of their own, they're structural
        // links from/to the hub.
        const rNodeIds = [], tNodeIds = [];
        edges.forEach((e) => {
          if (e.endNodeId === cid) {
            const nid = nodeIdByLocalId[e.startNodeId];
            if (nid) rNodeIds.push(nid);
          } else if (e.startNodeId === cid) {
            const nid = nodeIdByLocalId[e.endNodeId];
            if (nid) tNodeIds.push(nid);
          }
        });
        if (!rNodeIds.length || !tNodeIds.length) return;
        const relType = hub.properties.Name || '';
        const isNonDir = RELID_NONDIRECTIONAL_TYPES.has(relType);
        const relationId = calcRelationId({
          inref: isNonDir ? [] : rNodeIds,
          inoutref: isNonDir ? rNodeIds.concat(tNodeIds) : [],
          outref: isNonDir ? [] : tNodeIds,
          control_type: relType, ontology: '', relationship: '', effect: '', mechanism: ''
        });
        candidates.push({
          kind: 'hyperedge', relationId, relType,
          rNodeIds, tNodeIds,
          references: edges[0].properties.references || []
        });
      } else {
        const e = edges[0]; // a plain binary control always has exactly one edge
        const startNid = nodeIdByLocalId[e.startNodeId];
        const endNid = nodeIdByLocalId[e.endNodeId];
        if (!startNid || !endNid) return; // couldn't resolve one/both endpoints
        const relType = e.type;
        const isNonDir = RELID_NONDIRECTIONAL_TYPES.has(relType);
        const effect = e.properties.Effect || '';
        const mechanism = e.properties.Mechanism || '';
        const relationId = calcRelationId({
          inref: isNonDir ? [] : [startNid],
          inoutref: isNonDir ? [startNid, endNid] : [],
          outref: isNonDir ? [] : [endNid],
          control_type: relType, ontology: '', relationship: '', effect, mechanism
        });
        candidates.push({
          kind: 'binary', relationId, relType,
          srcNodeId: startNid, tgtNodeId: endNid,
          effect, mechanism,
          properties: e.properties,
          references: e.properties.references || []
        });
      }
    });
    return candidates;
  }

  // ── Node property builders ──────────────────────────────────────────────────
  function buildNeo4jNodeProps(node, resolvedNodeId) {
    const grouped = {};
    (node.raw_attrs || []).forEach((a) => {
      if (!NEO4J_NODE_PROPS.includes(a.name)) return;
      if (a.value == null || a.value === '') return;
      if (!grouped[a.name]) grouped[a.name] = [];
      grouped[a.name].push(a.value);
    });
    const out = { NodeID: toNeoInt(resolvedNodeId), URN: node.properties.URN };
    Object.keys(grouped).forEach((k) => {
      out[k] = grouped[k].length === 1 ? grouped[k][0] : grouped[k];
    });
    return out;
  }

  function buildAttrRows(node) {
    const seen = new Map(); // dedup within this one node (same name+value twice)
    (node.raw_attrs || []).forEach((a) => {
      if (a.value == null || a.value === '') return;
      const id = BigInt(myhash(`${a.name}|${a.value}`));
      seen.set(id.toString(), { id, name: a.name, value: a.value });
    });
    return Array.from(seen.values());
  }

  // ── Dynamic column discovery (mirrors write-relation's own approach) ───────
  async function discoverReferenceColumns(pgPool, schema) {
    const result = await pgPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'reference'`,
      [schema]
    );
    return new Set(result.rows.map((r) => r.column_name));
  }

  // ── Main entry point ─────────────────────────────────────────────────────────
  // job: a plain object the caller mutates/reads for progress (see
  // server.js's /api/import/rnef/start for its shape). neo4jConn: the
  // caller's OWN per-user { driver, database } (never shared/admin). pg: the
  // caller's own { pool, schema }.
  async function runImportJob(job, targetPath, neo4jConn, pg, username) {
    const files = enumerateRnefFiles(targetPath);
    job.filesTotal = files.length;

    const urnToNodeId = new Map(); // job-wide cache: URN -> resolved NodeID (string)
    const allCandidates = []; // across every file/resnet in this job
    const refColumns = pg && pg.pool ? await discoverReferenceColumns(pg.pool, pg.schema) : new Set();

    for (const file of files) {
      job.currentFile = path.basename(file);
      let resnets;
      try {
        resnets = await parseRnefFile(file, job);
      } catch (err) {
        console.error(`[rnef-import] giving up on "${job.currentFile}":`, err.message);
        job.errors.push({ file: job.currentFile, error: 'Parse failed: ' + err.message });
        job.filesDone++;
        continue;
      }
      console.log(`[rnef-import] "${job.currentFile}": ${resnets.length} resnet(s) parsed`);

      // ── Node resolution for the WHOLE file in one pass ───────────────────────
      // A "literature reference" style RNEF file can have 1000+ resnets (one
      // per control/relation, confirmed in real samples — see
      // extract_resnet_core()'s own docstring). Resolving URNs resnet-by-
      // resnet would open a fresh Neo4j session and round-trip per resnet —
      // 1000+ sequential network round-trips for a single file. Collecting
      // every resnet's URNs across the WHOLE file first means this is a
      // handful of batched queries total, no matter how many resnets the
      // file has.
      job.phase = 'collecting node URNs';
      job.phaseStartedAt = Date.now();
      const urns = Array.from(new Set(
        resnets.flatMap((resnet) =>
          resnet.nodes.filter((n) => n.properties && n.properties.URN).map((n) => String(n.properties.URN))
        )
      ));
      const unresolved = urns.filter((u) => !urnToNodeId.has(u));
      job.phase = `resolving ${unresolved.length} node URN(s) (of ${urns.length} total)`;
      console.log(`[rnef-import] "${job.currentFile}": ${urns.length} distinct node URNs, ${unresolved.length} not yet seen this job`);
      if (unresolved.length) {
        const t1 = Date.now();
        const session = neo4jConn.driver.session({ database: neo4jConn.database });
        try {
          for (let i = 0; i < unresolved.length; i += NODE_UNWIND_CHUNK) {
            const chunk = unresolved.slice(i, i + NODE_UNWIND_CHUNK);
            const result = await session.run(
              'UNWIND $urns AS urn MATCH (n {URN: urn}) RETURN urn, n.NodeID AS nodeId',
              { urns: chunk }
            );
            result.records.forEach((rec) => {
              const nodeId = rec.get('nodeId');
              urnToNodeId.set(rec.get('urn'), nodeId != null ? String(nodeId) : null);
            });
          }
        } finally {
          await session.close();
        }

        // Anything still unresolved genuinely doesn't exist yet — one node
        // per distinct URN, even if several resnets mention the same one.
        // brandNewUrnSet (not .includes() on the array) keeps the lookup
        // below O(1) per node — with a large file's node count potentially
        // in the tens/hundreds of thousands, an array .includes() here turns
        // this into an O(nodes × brandNewUrns) scan, easily billions of
        // comparisons and the real reason a big file could look "stuck".
        const brandNewUrns = unresolved.filter((u) => !urnToNodeId.get(u));
        job.phase = `creating ${brandNewUrns.length} new node(s)`;
        console.log(`[rnef-import] "${job.currentFile}": ${brandNewUrns.length} brand-new node(s) to create`);
        if (brandNewUrns.length) {
          const brandNewUrnSet = new Set(brandNewUrns);
          const seenUrns = new Set();
          const nodesToCreate = [];
          resnets.forEach((resnet) => {
            resnet.nodes.forEach((n) => {
              if (!n.properties || !n.properties.URN) return;
              const urn = String(n.properties.URN);
              if (!brandNewUrnSet.has(urn) || seenUrns.has(urn)) return;
              seenUrns.add(urn);
              nodesToCreate.push(n);
            });
          });
          const newIds = new Map(); // urn -> NodeID string
          nodesToCreate.forEach((n) => {
            newIds.set(String(n.properties.URN), BigInt(myhash(String(n.properties.URN))).toString());
          });

          if (pg && pg.pool && newIds.size) {
            const tPg = Date.now();
            await writeNodeAndAttrRows(pg, nodesToCreate, newIds);
            console.log(`[rnef-import] "${job.currentFile}": wrote ${newIds.size} node/attr row(s) to Postgres in ${((Date.now() - tPg) / 1000).toFixed(1)}s`);
          }
          if (newIds.size) {
            const tNeo = Date.now();
            await createNeo4jNodes(neo4jConn, nodesToCreate, newIds);
            console.log(`[rnef-import] "${job.currentFile}": created ${newIds.size} node(s) in Neo4j in ${((Date.now() - tNeo) / 1000).toFixed(1)}s`);
          }
          newIds.forEach((nodeId, urn) => urnToNodeId.set(urn, nodeId));
        }
      }

      job.phase = 'building relation candidates';
      for (const resnet of resnets) {
        const nodeIdByLocalId = {};
        resnet.nodes.forEach((n) => {
          if (!n.properties || !n.properties.URN) return;
          const nid = urnToNodeId.get(String(n.properties.URN));
          if (nid) nodeIdByLocalId[n.id] = nid;
        });

        allCandidates.push(...buildRelationCandidates(resnet, nodeIdByLocalId));
      }

      job.filesDone++;
      job.relationsParsed = allCandidates.length;
      console.log(`[rnef-import] "${job.currentFile}" done — ${allCandidates.length} total relation candidate(s) so far`);
    }

    // ── Batch processing: relations + references ────────────────────────────
    const isSmallImport = allCandidates.length < SMALL_IMPORT_THRESHOLD;
    job.batchTotal = Math.ceil(allCandidates.length / RELATIONS_BATCH_SIZE) || (allCandidates.length ? 1 : 0);
    const touchedRelationIds = new Set();

    for (let i = 0; i < allCandidates.length; i += RELATIONS_BATCH_SIZE) {
      job.batchIndex = Math.floor(i / RELATIONS_BATCH_SIZE) + 1;
      job.phase = `writing batch ${job.batchIndex}/${job.batchTotal}`;
      const t0 = Date.now();
      const batch = allCandidates.slice(i, i + RELATIONS_BATCH_SIZE);
      await processBatch(batch, neo4jConn, pg, refColumns, username, isSmallImport, touchedRelationIds, job);
      console.log(`[rnef-import] batch ${job.batchIndex}/${job.batchTotal} written in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    // ── Final recount pass (touched RelationIDs only) ───────────────────────
    if (pg && pg.pool && touchedRelationIds.size) {
      job.phase = `recomputing counts for ${touchedRelationIds.size} relation(s)`;
      await recomputeReferenceCounts(neo4jConn, pg, Array.from(touchedRelationIds));
    }

    job.phase = 'done';
    job.done = true;
    console.log(`[rnef-import] job finished: ${JSON.stringify({ filesTotal: job.filesTotal, relationsParsed: allCandidates.length, referencesInserted: job.referencesInserted, errors: job.errors.length })}`);
    job.summary = {
      filesTotal: job.filesTotal,
      filesDone: job.filesDone,
      relationsParsed: allCandidates.length,
      referencesInserted: job.referencesInserted,
      referencesSkippedMalformed: job.referencesSkippedMalformed,
      errorCount: job.errors.length
    };
  }

  // ── Postgres node/attr writes ────────────────────────────────────────────────
  async function writeNodeAndAttrRows(pg, nodesToCreate, newIds) {
    const attrRowsById = new Map(); // dedup across the whole batch
    const nodeRows = [];
    nodesToCreate.forEach((n) => {
      const urn = String(n.properties.URN);
      const nodeId = newIds.get(urn);
      if (!nodeId) return;
      const attrRows = buildAttrRows(n);
      attrRows.forEach((a) => attrRowsById.set(a.id.toString(), a));
      nodeRows.push({
        id: BigInt(nodeId),
        urn,
        name: n.properties.Name || '',
        nodetype: (n.labels && n.labels[0]) || 'Unknown',
        // Decimal strings, not raw BigInt — matches how every other 64-bit
        // id array already crosses into a ::bigint[] param elsewhere in this
        // app (see e.g. the validIds.map(String) pattern server.js's other
        // endpoints use for the same reason).
        attributes: attrRows.map((a) => a.id.toString())
      });
    });

    const client = await pg.pool.connect();
    try {
      await client.query('BEGIN');
      const attrRows = Array.from(attrRowsById.values());
      for (let i = 0; i < attrRows.length; i += PG_INSERT_ROWS_PER_STATEMENT) {
        const chunk = attrRows.slice(i, i + PG_INSERT_ROWS_PER_STATEMENT);
        const values = [];
        const placeholders = chunk.map((a, idx) => {
          values.push(a.id, a.name, a.value);
          const base = idx * 3;
          return `($${base + 1}, $${base + 2}, $${base + 3})`;
        });
        await client.query(
          `INSERT INTO ${pg.schema}.attr (id, name, value) VALUES ${placeholders.join(',')} ON CONFLICT (id) DO NOTHING`,
          values
        );
      }
      for (let i = 0; i < nodeRows.length; i += PG_INSERT_ROWS_PER_STATEMENT) {
        const chunk = nodeRows.slice(i, i + PG_INSERT_ROWS_PER_STATEMENT);
        const values = [];
        const placeholders = chunk.map((n, idx) => {
          values.push(n.id, n.urn, n.name, n.nodetype, n.attributes);
          const base = idx * 5;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::bigint[])`;
        });
        await client.query(
          `INSERT INTO ${pg.schema}.node (id, urn, name, nodetype, attributes) VALUES ${placeholders.join(',')} ON CONFLICT (id) DO NOTHING`,
          values
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Neo4j node creation ──────────────────────────────────────────────────────
  async function createNeo4jNodes(neo4jConn, nodesToCreate, newIds) {
    const byLabel = new Map();
    nodesToCreate.forEach((n) => {
      const urn = String(n.properties.URN);
      const nodeId = newIds.get(urn);
      if (!nodeId) return;
      const label = (n.labels && n.labels[0]) || 'Unknown';
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(buildNeo4jNodeProps(n, nodeId));
    });

    const session = neo4jConn.driver.session({ database: neo4jConn.database });
    try {
      for (const [label, rows] of byLabel) {
        if (!label || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) continue; // skip unsafe/unknown labels defensively
        const qLabel = quoteCypherIdent(label);
        await session.run(
          `UNWIND $rows AS row MERGE (n:${qLabel} {URN: row.URN}) ON CREATE SET n = row`,
          { rows }
        );
      }
    } finally {
      await session.close();
    }
  }

  // ── One batch of relation candidates: create + references ──────────────────
  async function processBatch(batch, neo4jConn, pg, refColumns, username, isSmallImport, touchedRelationIds, job) {
    const session = neo4jConn.driver.session({ database: neo4jConn.database });
    let existingSet = new Set();
    try {
      const ids = batch.map((c) => toNeoInt(c.relationId));
      const result = await session.run(
        `UNWIND $ids AS rid
         OPTIONAL MATCH ()-[r {RelationID: rid}]-()
         OPTIONAL MATCH (h:HyperEdge {RelationID: rid})
         RETURN rid, (r IS NOT NULL OR h IS NOT NULL) AS exists`,
        { ids }
      );
      // Compare as strings — rec.get('rid') comes back as a Neo4j Integer
      // object, which won't === a candidate's plain decimal-string relationId.
      result.records.forEach((rec) => { if (rec.get('exists')) existingSet.add(String(rec.get('rid'))); });

      const newBinary = batch.filter((c) => c.kind === 'binary' && !existingSet.has(c.relationId));
      const newHyper = batch.filter((c) => c.kind === 'hyperedge' && !existingSet.has(c.relationId));

      // New binary relations, grouped by relType (Cypher type isn't parameterizable).
      const byRelType = new Map();
      newBinary.forEach((c) => {
        if (!c.relType || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.relType)) return;
        if (!byRelType.has(c.relType)) byRelType.set(c.relType, []);
        const props = { RelationID: toNeoInt(c.relationId), Effect: c.effect || undefined, Mechanism: c.mechanism || undefined };
        NEO4J_REL_PROPS.forEach((k) => {
          const v = c.properties && c.properties[k];
          if (v != null && v !== '') props[k] = v;
        });
        Object.keys(props).forEach((k) => { if (props[k] === undefined) delete props[k]; });
        byRelType.get(c.relType).push({ srcId: toNeoInt(c.srcNodeId), tgtId: toNeoInt(c.tgtNodeId), props });
      });
      for (const [relType, rows] of byRelType) {
        const qRelType = quoteCypherIdent(relType);
        await session.run(
          `UNWIND $rows AS row
           MATCH (a {NodeID: row.srcId}), (b {NodeID: row.tgtId})
           CREATE (a)-[r:${qRelType}]->(b)
           SET r = row.props, r.Username = $username, r.createdAt = timestamp(), r.createdBy = $username`,
          { rows, username }
        );
      }

      // New hyperedges: MERGE the hub node by RelationID, then one plain
      // (no-RelationID) relationship per participant, grouped by relType.
      const hyperByRelType = new Map();
      newHyper.forEach((c) => {
        if (!c.relType || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.relType)) return;
        if (!hyperByRelType.has(c.relType)) hyperByRelType.set(c.relType, []);
        hyperByRelType.get(c.relType).push(c);
      });
      for (const [relType, cands] of hyperByRelType) {
        const qRelType = quoteCypherIdent(relType);
        const hubRows = cands.map((c) => ({
          relationId: toNeoInt(c.relationId),
          props: { RelationID: toNeoInt(c.relationId), Name: relType, Username: username }
        }));
        await session.run(
          `UNWIND $rows AS row
           MERGE (h:HyperEdge {RelationID: row.relationId})
           ON CREATE SET h = row.props, h.createdAt = timestamp(), h.createdBy = $username`,
          { rows: hubRows, username }
        );
        const participantRows = [];
        cands.forEach((c) => {
          c.rNodeIds.forEach((nid) => participantRows.push({ relationId: toNeoInt(c.relationId), nodeId: toNeoInt(nid), side: 'in' }));
          c.tNodeIds.forEach((nid) => participantRows.push({ relationId: toNeoInt(c.relationId), nodeId: toNeoInt(nid), side: 'out' }));
        });
        await session.run(
          `UNWIND $rows AS row
           MATCH (h:HyperEdge {RelationID: row.relationId}), (p {NodeID: row.nodeId})
           CALL apoc.do.when(row.side = 'in',
             'CREATE (p)-[r:${qRelType}]->(h) RETURN r',
             'CREATE (h)-[r:${qRelType}]->(p) RETURN r',
             {p: p, h: h}) YIELD value
           RETURN count(*)`,
          { rows: participantRows }
        ).catch(async () => {
          // APOC unavailable — fall back to two separate UNWINDs (no conditional CREATE).
          const inRows = participantRows.filter((r) => r.side === 'in');
          const outRows = participantRows.filter((r) => r.side === 'out');
          if (inRows.length) {
            await session.run(
              `UNWIND $rows AS row MATCH (h:HyperEdge {RelationID: row.relationId}), (p {NodeID: row.nodeId}) CREATE (p)-[r:${qRelType}]->(h)`,
              { rows: inRows }
            );
          }
          if (outRows.length) {
            await session.run(
              `UNWIND $rows AS row MATCH (h:HyperEdge {RelationID: row.relationId}), (p {NodeID: row.nodeId}) CREATE (h)-[r:${qRelType}]->(p)`,
              { rows: outRows }
            );
          }
        });
      }
    } finally {
      await session.close();
    }

    // ── References (both new and pre-existing RelationIDs) ──────────────────
    if (pg && pg.pool) {
      await processBatchReferences(batch, pg, refColumns, isSmallImport, touchedRelationIds, job);
    }
  }

  // ── Reference dedup + insert for one batch ──────────────────────────────────
  async function processBatchReferences(batch, pg, refColumns, isSmallImport, touchedRelationIds, job) {
    const relIds = Array.from(new Set(batch.map((c) => c.relationId)));
    const existingByRelId = new Map(); // relId -> [{doi,pmid,embase,nct_id,pii,pui,msrc}]
    for (let i = 0; i < relIds.length; i += REF_PREFETCH_CHUNK) {
      const chunk = relIds.slice(i, i + REF_PREFETCH_CHUNK);
      const result = await pg.pool.query(
        `SELECT id, doi, pmid, embase, nct_id, pii, pui, msrc FROM ${pg.schema}.reference WHERE id = ANY($1::bigint[])`,
        [chunk]
      );
      result.rows.forEach((row) => {
        const key = String(row.id);
        if (!existingByRelId.has(key)) existingByRelId.set(key, []);
        existingByRelId.get(key).push(row);
      });
    }

    const rowsToInsert = [];
    batch.forEach((c) => {
      (c.references || []).forEach((ref) => {
        const hasAnyIdentifier = REF_IDENTIFIER_COLS.some((col) => ref[col]);
        if (!hasAnyIdentifier) {
          job.referencesSkippedMalformed++;
          job.errors.push({
            relationId: c.relationId,
            error: 'Reference has no doi/pmid/embase/nct_id/pii/pui identifier — skipped',
            title: ref.title || '', textref: ref.textref || ''
          });
          return;
        }

        const existing = existingByRelId.get(c.relationId) || [];
        const identifierMatch = existing.find((row) =>
          REF_IDENTIFIER_COLS.some((col) => ref[col] && row[col] && String(row[col]) === String(ref[col]))
        );

        let shouldInsert;
        if (!identifierMatch) {
          shouldInsert = true;
        } else if (isSmallImport) {
          const newPrefix = sentencePrefix(ref.msrc);
          const sameSentence = existing.some((row) =>
            REF_IDENTIFIER_COLS.some((col) => ref[col] && row[col] && String(row[col]) === String(ref[col])) &&
            sentencePrefix(row.msrc) === newPrefix
          );
          shouldInsert = !sameSentence;
        } else {
          shouldInsert = false;
        }

        if (!shouldInsert) return;

        const relIdBigInt = BigInt(c.relationId);
        const uniqueId = computeRefUniqueId(ref, relIdBigInt);
        const uniqueRef = computeUniqueRef(ref, uniqueId);
        rowsToInsert.push({ relIdBigInt, uniqueId, uniqueRef, ref });
        existing.push(ref); // so a second reference in the SAME batch sees this one too
        existingByRelId.set(c.relationId, existing);
        touchedRelationIds.add(c.relationId);
      });
    });

    if (!rowsToInsert.length) return;

    const writableCols = Array.from(refColumns).filter((c) => c !== 'id' && c !== 'unique_id' && c !== 'unique_ref');
    const client = await pg.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < rowsToInsert.length; i += PG_INSERT_ROWS_PER_STATEMENT) {
        const chunk = rowsToInsert.slice(i, i + PG_INSERT_ROWS_PER_STATEMENT);
        const allCols = ['id', 'unique_id', 'unique_ref', ...writableCols];
        const values = [];
        const placeholders = chunk.map((row, idx) => {
          const rowValues = [row.relIdBigInt, row.uniqueId, row.uniqueRef, ...writableCols.map((c) => row.ref[c] ?? null)];
          const base = idx * allCols.length;
          values.push(...rowValues);
          return '(' + allCols.map((_, ci) => `$${base + ci + 1}`).join(',') + ')';
        });
        await client.query(
          `INSERT INTO ${pg.schema}.reference (${allCols.map((c) => `"${c}"`).join(',')}) VALUES ${placeholders.join(',')} ON CONFLICT (unique_id) DO NOTHING`,
          values
        );
      }
      await client.query('COMMIT');
      job.referencesInserted += rowsToInsert.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Final recount (touched RelationIDs only) ─────────────────────────────────
  async function recomputeReferenceCounts(neo4jConn, pg, relIds) {
    const counts = [];
    for (let i = 0; i < relIds.length; i += REF_PREFETCH_CHUNK) {
      const chunk = relIds.slice(i, i + REF_PREFETCH_CHUNK);
      const result = await pg.pool.query(
        `SELECT id, COUNT(*) AS sentences, COUNT(DISTINCT unique_ref) AS refs
         FROM ${pg.schema}.reference WHERE id = ANY($1::bigint[]) GROUP BY id`,
        [chunk]
      );
      result.rows.forEach((row) => counts.push({
        id: toNeoInt(row.id), sentences: Number(row.sentences), refs: Number(row.refs)
      }));
    }
    if (!counts.length) return;

    const session = neo4jConn.driver.session({ database: neo4jConn.database });
    try {
      for (let i = 0; i < counts.length; i += RELATIONS_BATCH_SIZE) {
        const chunk = counts.slice(i, i + RELATIONS_BATCH_SIZE);
        await session.run(
          `UNWIND $rows AS row
           MATCH ()-[r {RelationID: row.id}]-()
           SET r.RelationNumberOfReferences = row.refs, r.RelationNumberOfSentences = row.sentences`,
          { rows: chunk }
        );
        await session.run(
          `UNWIND $rows AS row
           MATCH (h:HyperEdge {RelationID: row.id})
           SET h.RelationNumberOfReferences = row.refs, h.RelationNumberOfSentences = row.sentences`,
          { rows: chunk }
        );
      }
    } finally {
      await session.close();
    }
  }

  return { enumerateRnefFiles, runImportJob };
}

module.exports = { createRnefImporter };
