/**
 * relation-id.js — canonical RelationID handling for GraphExplorer
 *
 * Single source of truth used by:
 *   - server.js          (Node.js, via require)
 *   - public/app.js      (browser, via <script src="/lib/relation-id.js">)
 *   - future batch-import scripts (Node.js, via require)
 *
 * Python mirror: agent_service.py  calc_relation_id() / _rid_myhash() / _rid_py_repr()
 *
 * UMD wrapper: works as CommonJS module (Node) or plain <script> (browser).
 *
 * Node.js exports:  { calcRelationId, myhash, normalizeRelationIds, fetchAndMergeDbReferences }
 * Browser globals:  calcRelationId
 *   (myhash, normalizeRelationIds, fetchAndMergeDbReferences are server-only concerns
 *    and are not exposed as browser globals)
 *
 * ── IMPORTANT: RelationID integer range ──────────────────────────────────────
 *
 * RelationIDs are 64-bit signed integers in both Neo4j and PostgreSQL.
 * Their range is −(2^63) … +(2^63−1).
 *
 * JavaScript's Number type is IEEE-754 double-precision float, which can only
 * represent integers exactly up to ±2^53 (Number.MAX_SAFE_INTEGER ≈ 9 × 10^15).
 * Many RelationIDs exceed this limit, so converting them with Number() silently
 * corrupts the value — e.g. Number('3362584539792416638') ≠ 3362584539792416638.
 *
 * Rule: RelationIDs MUST be kept as strings in Node.js at all times.
 *   ✓  String(id)              — safe
 *   ✓  BigInt(id)              — safe (for arithmetic / comparison only)
 *   ✗  Number(id) / +id        — silently loses precision above 2^53
 *   ✗  parseInt(id)            — same problem
 *
 * RelationIDs CAN BE NEGATIVE.  myhash() returns a signed 64-bit value, so
 * roughly half of all RelationIDs are negative.  Any regex or filter that
 * validates a RelationID string MUST include the optional leading minus sign:
 *   ✓  /^-?\d+$/               — correct
 *   ✗  /^\d+$/                 — rejects all negative IDs, breaking ~50 % of relations
 *
 * PostgreSQL handles the raw string just fine when the column is cast in SQL:
 *   WHERE id = ANY($1::bigint[])    ← pass idList as an array of strings
 */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    // Node.js
    module.exports = factory(require('crypto'));
  } else {
    // Browser — expose only calcRelationId globally
    var api = factory(null);
    root.calcRelationId = api.calcRelationId;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCrypto) {
  'use strict';

  // ── MD5 ────────────────────────────────────────────────────────────────────
  // In Node.js the built-in crypto module is used.
  // In the browser a self-contained pure-JS MD5 is used.

  function _md5BytesBrowser(str) {
    function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
    function toBytesUTF8(s) {
      var utf8  = unescape(encodeURIComponent(s));
      var bytes = new Uint8Array(utf8.length);
      for (var i = 0; i < utf8.length; i++) bytes[i] = utf8.charCodeAt(i) & 0xff;
      return bytes;
    }
    var K = new Array(64);
    for (var ki = 0; ki < 64; ki++)
      K[ki] = Math.floor(Math.abs(Math.sin(ki + 1)) * Math.pow(2, 32)) >>> 0;
    var S = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
             5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
             4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
             6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
    var msg         = toBytesUTF8(str);
    var origLenBits = msg.length * 8;
    var withOne     = new Uint8Array(msg.length + 1);
    withOne.set(msg);
    withOne[msg.length] = 0x80;
    var paddedLen = withOne.length;
    while (paddedLen % 64 !== 56) paddedLen++;
    var buf = new Uint8Array(paddedLen + 8);
    buf.set(withOne);
    var lenLow  = origLenBits >>> 0;
    var lenHigh = Math.floor(origLenBits / 0x100000000) >>> 0;
    var dv      = new DataView(buf.buffer);
    dv.setUint32(paddedLen,     lenLow,  true);
    dv.setUint32(paddedLen + 4, lenHigh, true);
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (var chunkStart = 0; chunkStart < buf.length; chunkStart += 64) {
      var M = new Array(16);
      for (var j = 0; j < 16; j++) M[j] = dv.getUint32(chunkStart + j * 4, true);
      var A = a0, B = b0, C = c0, D = d0;
      for (var round = 0; round < 64; round++) {
        var F, g;
        if      (round < 16) { F = (B & C) | (~B & D);  g = round; }
        else if (round < 32) { F = (D & B) | (~D & C);  g = (5 * round + 1) % 16; }
        else if (round < 48) { F = B ^ C ^ D;            g = (3 * round + 5) % 16; }
        else                 { F = C ^ (B | ~D);         g = (7 * round)     % 16; }
        F = (F + A + K[round] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[round])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var out   = new Uint8Array(16);
    var outDv = new DataView(out.buffer);
    outDv.setUint32(0, a0, true); outDv.setUint32(4, b0, true);
    outDv.setUint32(8, c0, true); outDv.setUint32(12, d0, true);
    return out;
  }

  /**
   * myhash(text) → string
   * MD5-based signed-64-bit hash, returned as a decimal string.
   * Matches Python _rid_myhash() in agent_service.py.
   */
  function myhash(text) {
    text = String(text);
    if (nodeCrypto) {
      // Node.js path
      var buf  = Buffer.from(text, 'utf8');
      var d    = nodeCrypto.createHash('md5').update(buf).digest();
      var high = d.readBigUInt64BE(0);
      var low  = d.readBigUInt64BE(8);
      var MASK = BigInt('0x7FFFFFFFFFFFFFFF');
      var r    = high ^ low;
      if (r > MASK) r = -(r & MASK);
      return r.toString();
    } else {
      // Browser path
      var bytes = _md5BytesBrowser(text);
      var view  = new DataView(bytes.buffer);
      var high2 = view.getBigUint64(0, false);
      var low2  = view.getBigUint64(8, false);
      var MASK2 = 0x7FFFFFFFFFFFFFFFn;
      var r2    = high2 ^ low2;
      if (r2 > MASK2) r2 = -(r2 & MASK2);
      return r2.toString();
    }
  }

  // ── Reproduce Python's str() representation of a list or scalar ────────────
  // Strings get single-quoted; integer strings stay unquoted — matching Python
  // str(list) output so the hashed text is byte-identical across all runtimes.
  function _pyRepr(val) {
    if (Array.isArray(val)) {
      if (!val.length) return '[]';
      return '[' + val.map(function (v) {
        var s = String(v);
        return /^-?\d+$/.test(s)
          ? s
          : ("'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
      }).join(', ') + ']';
    }
    return "'" + String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  // ── Main export ─────────────────────────────────────────────────────────────
  /**
   * calcRelationId({ inref, inoutref, outref, control_type, ontology,
   *                  relationship, effect, mechanism }) → string
   *
   * All node-ID lists are sorted descending (64-bit safe via BigInt).
   * Returns the RelationID as a string to preserve full 64-bit precision
   * (Number/float64 would corrupt values above 2^53-1).
   */
  function calcRelationId(opts) {
    opts = opts || {};
    var inref        = opts.inref        || [];
    var inoutref     = opts.inoutref     || [];
    var outref       = opts.outref       || [];
    var control_type = opts.control_type || '';
    var ontology     = opts.ontology     || '';
    var relationship = opts.relationship || '';
    var effect       = opts.effect       || '';
    var mechanism    = opts.mechanism    || '';

    function bigSort(a, b) {
      var x = BigInt(String(a)), y = BigInt(String(b));
      return x < y ? 1 : x > y ? -1 : 0;
    }

    var s = '(' + [
      _pyRepr(inref.slice().sort(bigSort)),
      _pyRepr(inoutref.slice().sort(bigSort)),
      _pyRepr(outref.slice().sort(bigSort)),
      _pyRepr(control_type),
      _pyRepr(ontology),
      _pyRepr(relationship),
      _pyRepr(String(effect).toLowerCase()),
      _pyRepr(mechanism)
    ].join(', ') + ')';

    return myhash(s);
  }

  // ── RelationID string normalisation ─────────────────────────────────────────
  /**
   * normalizeRelationIds(input) → string[]
   *
   * Accepts a single ID or any nested array of IDs (numbers, strings, or
   * Neo4j Integer-like objects with a .toString() method).  Returns a
   * deduplicated array of canonical RelationID strings.
   *
   * Key rules (see file header for the full explanation):
   *  • IDs are returned as STRINGS — never as Number / BigInt.
   *  • Negative IDs are valid; the leading "-" is preserved.
   *  • Anything that is not a plain integer string (after toString) is dropped.
   */
  function normalizeRelationIds(input) {
    if (input == null) return [];
    // Flatten any nesting (e.g. [[id1, id2], id3])
    var arr = Array.isArray(input) ? _flatten(input) : [input];
    var seen = {};
    var out  = [];
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (item == null) continue;
      // Support Neo4j Integer objects (have a .toString() that yields the value)
      var s = (typeof item === 'object' && typeof item.toString === 'function')
        ? item.toString()
        : String(item);
      // Must be an integer string, possibly negative — see header comment
      if (/^-?\d+$/.test(s) && !seen[s]) {
        seen[s] = true;
        out.push(s);
      }
    }
    return out;
  }

  function _flatten(arr) {
    var result = [];
    for (var i = 0; i < arr.length; i++) {
      if (Array.isArray(arr[i])) {
        var inner = _flatten(arr[i]);
        for (var j = 0; j < inner.length; j++) result.push(inner[j]);
      } else {
        result.push(arr[i]);
      }
    }
    return result;
  }

  // ── Server-side DB reference fetch (Node.js only) ────────────────────────────
  /**
   * fetchAndMergeDbReferences(body, pg) → Promise<body>
   *
   * Fetches PostgreSQL references for every relation ID in body's current graph
   * and merges them into each edge as edge.references = [{...}, ...].
   *
   * Only available in Node.js (requires a pg connection pool object).
   * Not exported as a browser global.
   *
   * @param {object} body  - The parsed request body sent to /api/agent/summarize-chat.
   *                         Must contain NodeJSGraph (or CurrentNodeJSGraph / current_graph)
   *                         with an edges array.  body.scope = 'selected' limits the fetch
   *                         to selectedEdges only (avoids fetching thousands of unused refs).
   * @param {object} pg    - { pool: pg.Pool, schema: string } from server.js middleware.
   * @returns {Promise<object>} The same body object, edges mutated in place with .references.
   *
   * Implementation notes:
   *  • IDs are normalised with normalizeRelationIds() — strings, negative allowed.
   *  • The id[] array is split into CHUNK-sized slices run in parallel to avoid
   *    a single huge query blocking the connection pool.
   *  • SQL uses  WHERE id = ANY($1::bigint[])  with string values — PostgreSQL
   *    casts them correctly; using Number() here would corrupt 64-bit IDs.
   */
  function fetchAndMergeDbReferences(body, pg) {
    // Guard: only works in Node.js where pg is available
    if (typeof pg === 'undefined' || !pg || !pg.pool || !pg.schema) return Promise.resolve(body);

    var cg = body.NodeJSGraph || body.CurrentNodeJSGraph || body.current_graph;
    if (!cg || !Array.isArray(cg.edges)) return Promise.resolve(body);

    // For "selected" scope only fetch references for selected edges —
    // avoids querying thousands of unused references for a full graph.
    var scope        = body.scope || 'all';
    var edgesToFetch = (scope === 'selected' && Array.isArray(cg.selectedEdges) && cg.selectedEdges.length > 0)
      ? cg.selectedEdges
      : cg.edges;

    // Collect and normalise relation IDs — must remain strings (see header comment)
    var rawIds = [];
    for (var i = 0; i < edgesToFetch.length; i++) {
      var e = edgesToFetch[i];
      if (e.relationId  != null) rawIds.push(e.relationId);
      if (Array.isArray(e.relationIds)) for (var j = 0; j < e.relationIds.length; j++) rawIds.push(e.relationIds[j]);
    }
    var idList = normalizeRelationIds(rawIds);
    if (!idList.length) return Promise.resolve(body);

    var schema = pg.schema;
    var pool   = pg.pool;

    // Split into parallel chunks so large graphs don't stall on one huge query
    var CHUNK  = 500;
    var chunks = [];
    for (var c = 0; c < idList.length; c += CHUNK) chunks.push(idList.slice(c, c + CHUNK));

    var sql = 'SELECT * FROM ' + schema + '.reference WHERE id = ANY($1::bigint[]) ORDER BY pubyear DESC NULLS LAST, id';

    var t0 = Date.now();
    return Promise.all(chunks.map(function(chunk) { return pool.query(sql, [chunk]); }))
      .then(function(chunkResults) {
        var allRows = [];
        for (var i = 0; i < chunkResults.length; i++) {
          var rows = chunkResults[i].rows;
          for (var j = 0; j < rows.length; j++) allRows.push(rows[j]);
        }
        console.log('[fetchAndMergeDbReferences] fetched ' + allRows.length + ' references for ' +
          idList.length + ' relation IDs in ' + chunks.length + ' parallel chunk(s) in ' + (Date.now() - t0) + 'ms');

        // Build lookup: String(relationId) → [row, ...]
        var byId = {};
        for (var i = 0; i < allRows.length; i++) {
          var row = allRows[i];
          var rid = String(row.id);
          if (!byId[rid]) byId[rid] = [];
          byId[rid].push(row);
        }

        // Dedup key: doi + pmid + sentence
        function refKey(r) {
          return JSON.stringify([
            (r.doi      || '').toLowerCase().trim(),
            (r.pmid     || '').toLowerCase().trim(),
            (r.msrc     || r.sentence || '').toLowerCase().trim()
          ]);
        }

        // Merge DB refs into each edge
        for (var i = 0; i < edgesToFetch.length; i++) {
          var edge   = edgesToFetch[i];
          var dbRefs = [];
          if (edge.relationId != null) {
            var r = byId[String(edge.relationId)];
            if (r) for (var k = 0; k < r.length; k++) dbRefs.push(r[k]);
          }
          if (Array.isArray(edge.relationIds)) {
            for (var ri = 0; ri < edge.relationIds.length; ri++) {
              var r2 = byId[String(edge.relationIds[ri])];
              if (r2) for (var k = 0; k < r2.length; k++) dbRefs.push(r2[k]);
            }
          }
          if (!dbRefs.length) continue;

          var existing = Array.isArray(edge.references) ? edge.references : [];
          var seen     = {};
          var merged   = [];
          for (var m = 0; m < existing.length; m++) { var kk = refKey(existing[m]); seen[kk] = true; merged.push(existing[m]); }
          for (var m = 0; m < dbRefs.length; m++) {
            var kk = refKey(dbRefs[m]);
            if (!seen[kk]) {
              seen[kk] = true;
              // Strip null / empty fields to keep payload lean
              var clean = {};
              var ref   = dbRefs[m];
              var keys  = Object.keys(ref);
              for (var f = 0; f < keys.length; f++) {
                var v = ref[keys[f]];
                if (v === null || v === undefined || v === '') continue;
                if (Array.isArray(v) && v.length === 0) continue;
                clean[keys[f]] = v;
              }
              merged.push(clean);
            }
          }
          edge.references = merged;
        }

        return body;
      })
      .catch(function(err) {
        console.warn('[fetchAndMergeDbReferences] DB fetch failed (continuing without):', err.message);
        return body;
      });
  }

  return {
    calcRelationId:           calcRelationId,
    myhash:                   myhash,
    normalizeRelationIds:     normalizeRelationIds,
    fetchAndMergeDbReferences: fetchAndMergeDbReferences
  };
}));
