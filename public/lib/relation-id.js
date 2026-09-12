/**
 * relation-id.js — canonical RelationID calculation for GraphExplorer
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
 * Node.js exports:  { calcRelationId, myhash }
 * Browser globals:  calcRelationId
 *   (myhash is not exposed as a browser global — server.js uses it for
 *    _computeRefUniqueId, which is a server-only concern)
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

  return { calcRelationId: calcRelationId, myhash: myhash };
}));
