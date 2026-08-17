
// ================================================================================
// AGENTIC AI — frontend module
// ================================================================================

// ── State ────────────────────────────────────────────────────────────────────
var _agentPanelOpen    = false;
var _agentChatHistory  = [];   // [{role,content}]
var _agentLastCypher   = null;
var _agentLibraryFiles = [];
var _agentCurrentMode  = 'text2cypher';  // 'text2cypher' or 'summarize'
var _agentConfig       = {
  model_name:  '',
  temperature: 0.2,
  top_p:       0.9,
  json_mode:   false,
};
var _agentWorkflow     = [];
var _agentStatusTimer  = null;

// ── Panel open/close ─────────────────────────────────────────────────────────
function openAgenticPanel(mode) {
  // Called from menu (e.g., onclick="openAgenticPanel('summarize')")
  // Switch mode and open the panel
  console.log('[openAgenticPanel] Called with mode:', mode);
  if (mode === 'summarize' || mode === 'text2cypher') {
    switchAgentMode(mode);
  }
  toggleAgenticPanel();
}

function toggleAgenticPanel() {
  var panel = document.getElementById('agentic-panel');
  _agentPanelOpen = !_agentPanelOpen;
  console.log('[toggleAgenticPanel] Panel now:', _agentPanelOpen ? 'OPEN' : 'CLOSED');
  panel.style.display = _agentPanelOpen ? 'flex' : 'none';
  if (_agentPanelOpen) {
    _agentPollStatus();
    document.getElementById('agent-input').focus();
  } else {
    clearTimeout(_agentStatusTimer);
  }
}

function _agentPollStatus() {
  api('/api/agent/health', null, 'GET')
    .then(function(r) { _agentSetStatus(true,  r.llm_model || 'connected'); })
    .catch(function()  { _agentSetStatus(false, 'service unavailable'); });
  _agentStatusTimer = setTimeout(_agentPollStatus, 10000);
}

function _agentSetStatus(ok, label) {
  var dot = document.getElementById('agent-status-dot');
  var lbl = document.getElementById('agent-status-label');
  if (dot) dot.style.background = ok ? '#3a9c66' : '#c0392b';
  if (lbl) lbl.textContent = label;
}

// ── Chat ─────────────────────────────────────────────────────────────────────
function agentInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); }
}

async function agentSend() {
  var input = document.getElementById('agent-input');
  var msg = (input.value || '').trim();
  console.log('[agentSend] Starting send, current mode:', _agentCurrentMode);
  if (!msg) {
    console.log('[agentSend] Empty message, aborting');
    return;
  }
  input.value = '';

  _agentAppendMessage('user', msg);
  _agentChatHistory.push({ role: 'user', content: msg });

  var sendBtn  = document.getElementById('agent-send-btn');
  var thinking = document.getElementById('agent-thinking-indicator');
  sendBtn.disabled = true;
  if (thinking) thinking.style.display = 'inline';

  try {
    var result;
    if (_agentCurrentMode === 'summarize') {
      console.log('[agentSend] SUMMARIZE mode - building graph from Cytoscape');
      // Summarize mode: include current graph
      var currentGraph = _buildCurrentGraphFromCy();
      console.log('[agentSend] Built graph:', { nodes: currentGraph.nodes.length, edges: currentGraph.edges.length });

      // ── Merge database + inline references for all edges ────────────────
      console.log('[agentSend] Merging database references into graph edges...');
      currentGraph = await _mergeDbReferencesIntoGraph(currentGraph);
      
      // ── Clean empty values from reference objects only ──────────────────
      console.log('[agentSend] Cleaning empty values from references...');
      if (Array.isArray(currentGraph.edges)) {
        currentGraph.edges.forEach(function(edge) {
          if (Array.isArray(edge.references)) {
            edge.references = edge.references.map(function(ref) {
              var cleaned = {};
              for (var key in ref) {
                if (ref.hasOwnProperty(key)) {
                  var val = ref[key];
                  // Skip null, undefined, empty string, empty array
                  if (val === null || val === undefined || val === '') continue;
                  if (Array.isArray(val) && val.length === 0) continue;
                  cleaned[key] = val;
                }
              }
              return cleaned;
            });
          }
        });
      }
      
      // ── Debug: collect first 5 combined refs across all edges ────────────
      var allInlineRefs = [];
      var totalDatabaseRefs = 0;
      currentGraph.edges.forEach(function(e) {
        if (Array.isArray(e.references)) {
          e.references.forEach(function(r) {
            // Inject the edge's relationId into each ref so Python can echo it back
            var enriched = Object.assign({}, r, { relationId: e.relationId, relationIds: e.relationIds });
            allInlineRefs.push(enriched);
          });
        }
      });
      
      var edgesWithRefs = currentGraph.edges.filter(function(e) { return Array.isArray(e.references) && e.references.length > 0; }).length;
      var debugSampleRefs = allInlineRefs.slice(0, 5);
      var totalRefs = allInlineRefs.length;
      console.log('[agentSend] Combined references:', { totalRefs: totalRefs, edgesWithRefs: edgesWithRefs, sampleCount: debugSampleRefs.length });
      console.log('[agentSend] Sample refs (first 5):', debugSampleRefs);

      // Dump first raw graphData edge to diagnose field names
      var rawEdgeDump = '';
      if (graphData && graphData.edges && graphData.edges.length > 0) {
        var re0 = graphData.edges[0];
        var p0 = re0.properties || {};
        rawEdgeDump = '\nRaw graphData.edges[0] keys: ' + Object.keys(re0).join(', ') +
                      '\n  .properties keys: ' + Object.keys(p0).join(', ') +
                      '\n  RelationID=' + p0.RelationID + ' RelationIDs=' + JSON.stringify(p0.RelationIDs) +
                      '\n  RelationNumberOfReferences=' + p0.RelationNumberOfReferences +
                      '\n  has inline refs: ' + (Array.isArray(p0.references) ? p0.references.length : 'no') +
                      '\nBuilt edge[0] keys: ' + (currentGraph.edges[0] ? Object.keys(currentGraph.edges[0]).join(', ') : 'none') +
                      '\n  relationId=' + (currentGraph.edges[0] && currentGraph.edges[0].relationId) +
                      ' references.length=' + (currentGraph.edges[0] && Array.isArray(currentGraph.edges[0].references) ? currentGraph.edges[0].references.length : 0);
      }

      // Graph-size status message — only useful once, at the start of a new
      // Summarize conversation; repeating it on every turn just adds noise
      // once the user is already mid-conversation about the same graph.
      if (_agentChatHistory.length === 1) {
        var _graphLabel = currentGraph.tabName || currentGraph.graphName || '';
        var _graphPrefix = _graphLabel
          ? 'Analyzing graph “' + _graphLabel + '” with '
          : 'Analyzing graph with ';
        _agentAppendMessage('assistant',
          _graphPrefix + currentGraph.nodes.length + ' nodes, ' +
          currentGraph.edges.length + ' edges. ' +
          '(' + edgesWithRefs + ' edges are supported by ' + totalRefs + ' references)'
        );
      }
      // ─────────────────────────────────────────────────────────────────────

      var relationIds = _extractRelationIds(currentGraph.edges);
      console.log('[agentSend] Extracted relation_ids:', relationIds);

      // Scope the summary to the user's canvas selection, if any nodes/edges
      // are currently selected — otherwise fall back to the whole graph.
      var hasSelection = (currentGraph.selectedNodes && currentGraph.selectedNodes.length > 0) ||
                          (currentGraph.selectedEdges && currentGraph.selectedEdges.length > 0);
      var summaryScope = hasSelection ? 'selected' : 'all';
      console.log('[agentSend] Summary scope:', summaryScope,
        '(selectedNodes=' + (currentGraph.selectedNodes ? currentGraph.selectedNodes.length : 0) +
        ', selectedEdges=' + (currentGraph.selectedEdges ? currentGraph.selectedEdges.length : 0) + ')');

      // ── Fetch database credentials from server ──────────────────────────
      var dbCredentials = null;
      try {
        var credsResp = await api('/api/db-credentials', null, 'GET');
        if (credsResp) {
          dbCredentials = credsResp;
          console.log('[agentSend] Fetched db_credentials');
        }
      } catch (e) {
        console.warn('[agentSend] Failed to fetch db_credentials:', e);
      }

      var payload = {
        message: msg,
        history: _agentChatHistory.slice(0, -1),
        llm:     _agentConfig,
        NodeJSGraph: currentGraph,
        scope: summaryScope,
        relation_ids: relationIds,
        db_credentials: dbCredentials,
        debug_inline_refs: debugSampleRefs,
      };
      console.log('[agentSend] Full payload being sent to /api/agent/summarize-chat:');
      console.log('  - message:', payload.message);
      console.log('  - history length:', payload.history.length);
      console.log('  - llm config:', payload.llm);
      console.log('  - current_graph nodes:', payload.NodeJSGraph.nodes.length);
      console.log('  - current_graph edges:', payload.NodeJSGraph.edges.length);
      console.log('  - relation_ids:', payload.relation_ids);
      console.log('  - db_credentials present:', !!payload.db_credentials);
      console.log('  - debug_inline_refs:', payload.debug_inline_refs);
      
      result = await api('/api/agent/summarize-chat', payload);
      console.log('[agentSend] Response received from /api/agent/summarize-chat:', result);
    } else {
      // Text2Cypher mode (default)
      console.log('[agentSend] TEXT2CYPHER mode');
      var payload = {
        message: msg,
        history: _agentChatHistory.slice(0, -1),
        llm:     _agentConfig,
      };
      console.log('[agentSend] Payload sent to /api/agent/chat:', payload);
      result = await api('/api/agent/chat', payload);
      console.log('[agentSend] Response received from /api/agent/chat:', result);
    }
    
    var reply = result.reply || '(no reply)';
    console.log('[agentSend] Appending assistant reply:', reply.slice(0, 100) + '...');
    _agentChatHistory.push({ role: 'assistant', content: reply });
    _agentAppendMessage('assistant', reply, result.generated_cypher, result.cypher_results);

    if (result.generated_cypher) {
      _agentLastCypher = result.generated_cypher;
      var bar = document.getElementById('agent-cypher-bar');
      var pre = document.getElementById('agent-cypher-preview');
      if (bar) bar.style.display = 'block';
      if (pre) pre.textContent = result.generated_cypher;
    }
  } catch(err) {
    console.error('[agentSend] ERROR:', err);
    _agentAppendMessage('error', 'Error: ' + (err.message || String(err)));
  } finally {
    sendBtn.disabled = false;
    if (thinking) thinking.style.display = 'none';
  }
}

// ── Reference merging ───────────────────────────────────────────────────────
async function _mergeDbReferencesIntoGraph(currentGraph) {
  /**
   * Fetches database references for all relationIds in the graph edges,
   * merges them with inline (RNEF) references, deduplicates, and updates each edge's references array.
   * This ensures each edge has both inline + database references combined.
   */
  if (!currentGraph || !Array.isArray(currentGraph.edges)) return currentGraph;

  // Collect all unique relationIds
  var allRelationIds = new Set();
  currentGraph.edges.forEach(function(e) {
    if (e.relationId) allRelationIds.add(e.relationId);
    if (Array.isArray(e.relationIds)) e.relationIds.forEach(function(rid) { allRelationIds.add(rid); });
  });

  var relationIdsArray = Array.from(allRelationIds);
  console.log('[_mergeDbReferencesIntoGraph] Fetching db refs for relationIds:', relationIdsArray);

  if (relationIdsArray.length === 0) {
    console.log('[_mergeDbReferencesIntoGraph] No relationIds found, skipping db fetch');
    return currentGraph;
  }

  // Fetch database references (same endpoint used by tooltip)
  var dbRefsByRelId = {};
  try {
    var dbRefs = await api('/api/references', { relationIds: relationIdsArray });
    console.log('[_mergeDbReferencesIntoGraph] Fetched', dbRefs.length, 'database reference rows');
    
    // Organize by relationId so we can map them back to edges
    dbRefs.forEach(function(ref) {
      var rid = ref.id;  // 'id' field from reference table is the relationId
      if (!dbRefsByRelId[rid]) dbRefsByRelId[rid] = [];
      dbRefsByRelId[rid].push(ref);
    });
  } catch(e) {
    console.warn('[_mergeDbReferencesIntoGraph] Failed to fetch db references:', e);
    return currentGraph;
  }

  // Deduplication key: (doi, pmid, sentence) tuple
  function _refKey(ref) {
    return JSON.stringify([
      (ref.doi || '').toLowerCase().trim(),
      (ref.pmid || '').toLowerCase().trim(),
      (ref.msrc || ref.sentence || '').toLowerCase().trim()
    ]);
  }

  // Merge inline + database refs for each edge
  currentGraph.edges.forEach(function(edge) {
    var inlineRefs = edge.references || [];
    var dbRefs = [];

    // Collect all db refs for this edge's relationIds
    if (edge.relationId) {
      var rid = edge.relationId;
      if (dbRefsByRelId[rid]) dbRefs = dbRefs.concat(dbRefsByRelId[rid]);
    }
    if (Array.isArray(edge.relationIds)) {
      edge.relationIds.forEach(function(rid) {
        if (dbRefsByRelId[rid]) dbRefs = dbRefs.concat(dbRefsByRelId[rid]);
      });
    }

    // Merge, deduplicate by key, keep inline first then db
    var seen = new Set();
    var merged = [];
    
    inlineRefs.forEach(function(ref) {
      var key = _refKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(ref);
      }
    });

    dbRefs.forEach(function(ref) {
      var key = _refKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(ref);
      }
    });

    edge.references = merged;
    console.log('[_mergeDbReferencesIntoGraph] Edge', edge.source, '→', edge.target, 
                'has', merged.length, 'combined references (', inlineRefs.length, 'inline,', dbRefs.length, 'db)');
  });

  return currentGraph;
}

function _agentAppendMessage(role, content, cypher, results) {
  var container = document.getElementById('agent-chat-messages');
  if (!container) return;

  var bubble = document.createElement('div');
  var baseStyle = 'max-width:96%;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.55;word-break:break-word;';
  if (role === 'user')        bubble.style.cssText = baseStyle + 'align-self:flex-end;background:#2a4a7f;color:#e0e8ff;border-bottom-right-radius:3px;white-space:pre-wrap';
  else if (role === 'error')  bubble.style.cssText = baseStyle + 'align-self:flex-start;background:#4a1c1c;color:#ffaaaa;border-bottom-left-radius:3px;white-space:pre-wrap';
  else {
    bubble.style.cssText = baseStyle + 'align-self:flex-start;background:#1e2a45;color:#c8d0e8;border-bottom-left-radius:3px';
    // Rich rendering for assistant messages: PMID links + entity highlighting
    if (_agentCurrentMode === 'summarize') {
      _renderSummarizeReply(content, bubble);
    } else {
      bubble.style.whiteSpace = 'pre-wrap';
      bubble.textContent = content;
    }
  }
  if (role !== 'assistant' || _agentCurrentMode !== 'summarize') {
    bubble.style.whiteSpace = 'pre-wrap';
    if (!bubble.childNodes.length) bubble.textContent = content;
  }

  if (cypher) {
    var cypherBox = document.createElement('div');
    cypherBox.style.cssText = 'margin-top:8px;background:#0d1220;border:1px solid #2a4a7f;border-radius:6px;padding:8px 10px;font-family:monospace;font-size:11px;color:#a0cfff;white-space:pre-wrap;word-break:break-all;cursor:pointer';
    cypherBox.title = 'Click to load into query bar';
    cypherBox.textContent = cypher;
    cypherBox.onclick = function() { _agentLastCypher = cypher; agentLoadCypherToBar(); };
    bubble.appendChild(cypherBox);
  }
  if (results && results.length > 0) {
    var resBox = document.createElement('div');
    resBox.style.cssText = 'margin-top:6px;font-size:11px;color:#7a8099';
    resBox.textContent = results.length + ' row(s) returned';
    bubble.appendChild(resBox);
  }

  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

// ── Rich rendering for summarize-mode LLM replies ────────────────────────────
// Renders markdown headings/bold/bullets, makes PMIDs into PubMed links and DOIs
// into doi.org links, and wraps graph entity names in clickable spans that select
// them on the graph.
function _renderSummarizeReply(text, container) {
  // Collect node names from current graph for entity linking
  var nodeNames = [];  // [{label, id}]
  if (cy && typeof cy.nodes === 'function') {
    cy.nodes().not('[?isClone]').forEach(function(n) {
      var lbl = n.data('label') || n.data('Name') || n.data('name') || '';
      if (lbl.length > 2) nodeNames.push({ label: lbl, id: n.id() });
    });
    // Sort longest first so longer names match before substrings
    nodeNames.sort(function(a, b) { return b.label.length - a.label.length; });
  }

  // Normalise LLM citation tokens so PMID_RE / DOI_RE can match them cleanly.
  //   Pass 0:   strip LLM-generated malformed citation wrappers
  //   Pass 1:   flatten [PMID X](url)  → plain "PMID X"
  //   Pass 1.5: consolidate mixed PMID+DOI blocks so PMIDs are never fragmented by DOIs
  //   Pass 2:   merge residual adjacent "PMID X, PMID Y" → "PMID X, Y"
  //   Pass 2.5: consolidate consecutive [DOI:d](url) links → one magic token for annotateText

  // Pass 0A: [[DOI:xxx](url1)](url2) → [DOI:xxx](url1)
  //   LLM sometimes double-wraps a DOI markdown link inside another markdown link.
  //   The outer [ breaks _DM matching in Pass 1.5 and leaves stray characters in output.
  text = text.replace(/\[\[DOI([^\]]*)\]\(([^)]*)\)\]\([^)]*\)/gi, '[DOI$1]($2)');

  // Pass 0B: [DOI refs](https://doi.org/10.xxx) or [DOI ref](…) → DOI:10.xxx
  //   LLM copies our rendered "DOI refs" link format into its next reply.
  //   Convert to plain DOI text so Pass 1.5 _DP token can handle it normally.
  text = text.replace(/\[DOI refs?\]\(https?:\/\/doi\.org\/([^)]+)\)/gi, 'DOI:$1');

  // Pass 1: flatten markdown PMID links → plain text (case-insensitive, \d{1,9} for short PMIDs)
  text = text.replace(/\[PMID[:\s]+(\d{1,9})\]\([^)]*\)/gi, 'PMID $1');

  // Pass 1.5: consolidate mixed PMID+DOI citation blocks.
  // After Pass 1, interleaved "PMID X, [DOI:...](url), PMID Y" blocks prevent Pass 2
  // from merging all PMIDs into one cluster.  Extract every PMID and DOI from each
  // block, then emit:
  //   "PMID x1, x2, x3 [DOI:d1](url1) [DOI:d2](url2)"  when ≤ 25 PMIDs
  //   "PMID x1, x2, ..., x25"                           when > 25 PMIDs (DOIs dropped)
  (function() {
    var _PT  = 'PMID[:\\s]+\\d{1,9}(?:\\s*,\\s*\\d{1,9})*';   // PMID cluster token
    var _DM  = '\\[DOI[:\\s]+[^\\]]+\\]\\([^)]*\\)';           // DOI markdown link token
    var _DP  = 'DOI[:\\s]+10\\.\\d{4,9}\\/[^\\s,\\]\\)"\']+';  // DOI plain-text token
    var _ANY = '(?:' + _PT + '|' + _DM + '|' + _DP + ')';
    var _SEP = '(?:\\s*,\\s*|\\s+)';
    var _BLOCK = new RegExp(_ANY + '(?:' + _SEP + _ANY + ')+', 'gi');
    var _TOK   = new RegExp(_PT + '|' + _DM + '|' + _DP, 'gi');
    text = text.replace(_BLOCK, function(block) {
      var pmids = [], dois = [], _m;
      _TOK.lastIndex = 0;
      while ((_m = _TOK.exec(block)) !== null) {
        var tok = _m[0];
        if (/^PMID/i.test(tok)) {
          pmids = pmids.concat(tok.match(/\d{1,9}/g) || []);
        } else {
          var _mdM = tok.match(/^\[DOI[:\s]+([^\]]+)\]\(([^)]*)\)/i);
          if (_mdM) {
            dois.push({id: _mdM[1].replace(/^[:\s]+/, '').trim(), url: _mdM[2]});
          } else {
            var _plM = tok.match(/^DOI[:\s]+(10\.\d{4,9}\/[^\s,\]\)"']+)/i);
            if (_plM) dois.push({id: _plM[1], url: 'https://doi.org/' + _plM[1]});
          }
        }
      }
      var MAX = 25, out = '';
      if (pmids.length > 0) {
        // PMIDs present — use them and drop DOIs.
        // PMID links already cover the articles; mixing in DOI links produces
        // redundant "(references [DOI:xxx])" output.
        out = 'PMID ' + pmids.slice(0, MAX).join(', ');
      } else if (dois.length > 0) {
        // No PMIDs — DOIs are the only citation, so include them.
        dois.forEach(function(d) { out += (out ? ' ' : '') + '[DOI:' + d.id + '](' + d.url + ')'; });
      }
      return out || block;
    });
  })();

  // Pass 2: merge residual adjacent "PMID X, PMID Y" → "PMID X, Y"
  text = text.replace(/PMID\s+\d{1,9}(?:,\s*PMID\s+\d{1,9})+/gi, function(match) {
    var ids = match.match(/\d{1,9}/g) || [];
    return 'PMID ' + ids.slice(0, 25).join(', ');
  });

  // Pass 2.5: consolidate consecutive [DOI:d](url) tokens (space-separated, emitted by
  // Pass 1.5) into one magic token that annotateText decodes as a single "DOI refs" link.
  // Format: [DOI refs](__DOISDAT__id1++id2__SEP__url1++url2)
  text = text.replace(/(\[DOI[:\s]+[^\]]+\]\([^)]*\))(?:\s+(\[DOI[:\s]+[^\]]+\]\([^)]*\)))+/gi, function(block) {
    var _doiRe = /\[DOI[:\s]+([^\]]+)\]\(([^)]*)\)/gi, _dm2, _ids = [], _urls = [];
    while ((_dm2 = _doiRe.exec(block)) !== null) {
      _ids.push(_dm2[1].trim().replace(/^[:\s]+/, ''));
      _urls.push(_dm2[2]);
    }
    return '[DOI refs](__DOISDAT__' + _ids.join('++') + '__SEP__' + _urls.join('++') + ')';
  });

  var PMID_RE = /PMIDs?[:\s]+\d{1,9}(?:\s*,\s*(?:PMIDs?[:\s]+)?\d{1,9})*/gi;
  var DOI_RE  = /DOIs?[:\s]+10\.\d{4,9}\/[^\s,\]\)"']+/gi;
  // Matches the magic token emitted by Pass 2.5 — decoded in annotateText as one "DOI refs" link.
  var DOIREFS_RE = /\[DOI refs\]\(__DOISDAT__[^)]+\)/gi;

  var entityParts = nodeNames.map(function(n) {
    // Escape regex special chars, then wrap with word boundaries so "ATR" does
    // not match inside "treatments" or "latrunculin" (whole-token match only).
    var escaped = n.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return '\\b' + escaped + '\\b';
  });
  var combinedRE = entityParts.length
    ? new RegExp('(' + PMID_RE.source + ')|(' + DOI_RE.source + ')|(' + DOIREFS_RE.source + ')|(' + entityParts.join('|') + ')', 'gi')
    : new RegExp('(' + PMID_RE.source + ')|(' + DOI_RE.source + ')|(' + DOIREFS_RE.source + ')', 'gi');

  // Map label (lowercase) → node id for click handler
  var labelToId = {};
  nodeNames.forEach(function(n) { labelToId[n.label.toLowerCase()] = n.id; });

  function annotateText(rawText, parentEl) {
    if (!rawText) return;
    var lastIndex = 0;
    var re = new RegExp(combinedRE.source, 'gi');
    var m;
    while ((m = re.exec(rawText)) !== null) {
      // Text before this match
      if (m.index > lastIndex) {
        parentEl.appendChild(document.createTextNode(rawText.slice(lastIndex, m.index)));
      }
      var matched = m[0];
      var pmidMatch    = /^PMIDs?\b/i.test(matched);
      var doiRefsMatch = !pmidMatch && matched.indexOf('[DOI refs](__DOISDAT__') === 0;
      var doiMatch     = !pmidMatch && !doiRefsMatch && /^DOIs?\b/i.test(matched);
      if (pmidMatch) {
        var pmids = matched.match(/\d{1,9}/g) || [];
        var pmidsCapped = pmids.slice(0, 25);  // PubMed URL cap
        var a = document.createElement('a');
        // Single PMID → direct article page; multiple PMIDs → one "Pubmed references"
        // link that opens all matching abstracts via PubMed's multi-UID search.
        a.href = pmidsCapped.length > 1
          ? 'https://pubmed.ncbi.nlm.nih.gov/?term=' + pmidsCapped.join('%2C+') + '%5Buid%5D'
          : 'https://pubmed.ncbi.nlm.nih.gov/' + pmidsCapped[0] + '/';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = pmidsCapped.length > 1 ? 'references' : 'PMID ' + pmidsCapped[0];
        a.title = pmidsCapped.join(', ');  // show actual PMIDs on hover
        a.style.cssText = 'color:#6ab4ff;text-decoration:underline;cursor:pointer';
        parentEl.appendChild(a);
      } else if (doiRefsMatch) {
        // Multiple DOIs consolidated by Pass 2.5 → one "DOI refs" hyperlink.
        // Format inside: __DOISDAT__id1++id2__SEP__url1++url2
        var _inner = matched.slice(22, -1);  // strip '[DOI refs](__DOISDAT__' (22 chars) and trailing ')'
        var _sepIdx = _inner.indexOf('__SEP__');
        var _doiIds  = (_sepIdx >= 0 ? _inner.slice(0, _sepIdx) : _inner).split('++');
        var _doiUrls = (_sepIdx >= 0 ? _inner.slice(_sepIdx + 7).split('++') : []);
        var doiRefsLink = document.createElement('a');
        doiRefsLink.href = _doiUrls[0] || ('https://doi.org/' + _doiIds[0]);
        doiRefsLink.target = '_blank';
        doiRefsLink.rel = 'noopener noreferrer';
        doiRefsLink.textContent = 'DOI refs';
        doiRefsLink.title = _doiIds.join(', ');  // all DOI ids on hover
        doiRefsLink.style.cssText = 'color:#6ab4ff;text-decoration:underline;cursor:pointer';
        parentEl.appendChild(doiRefsLink);
      } else if (doiMatch) {
        var doiId = (matched.match(/10\.\d{4,9}\/[^\s,\]\)"']+/i) || [matched])[0];
        var doiLink = document.createElement('a');
        doiLink.href = 'https://doi.org/' + doiId;
        doiLink.target = '_blank';
        doiLink.rel = 'noopener noreferrer';
        doiLink.textContent = matched;
        doiLink.style.cssText = 'color:#6ab4ff;text-decoration:underline;cursor:pointer';
        parentEl.appendChild(doiLink);
      } else {
        // Entity name
        var nodeId = labelToId[matched.toLowerCase()];
        var span = document.createElement('span');
        span.textContent = matched;
        span.title = 'Click to select "' + matched + '" on graph';
        span.style.cssText = 'color:#a8e6a8;border-bottom:1px dotted #6ab88a;cursor:pointer;font-weight:500';
        span.dataset.nodeId = nodeId || '';
        span.dataset.nodeLabel = matched;
        span.onclick = function(e) {
          e.stopPropagation();
          var nid = this.dataset.nodeId;
          var nlbl = this.dataset.nodeLabel;
          if (!cy || typeof cy.nodes !== 'function') return;
          cy.nodes().unselect();
          var targets = nid ? cy.$id(nid) : cy.nodes().filter(function(n) {
            return (n.data('label') || n.data('Name') || n.data('name') || '').toLowerCase() === nlbl.toLowerCase();
          });
          if (targets.length) {
            targets.select();
          }
        };
        parentEl.appendChild(span);
      }
      lastIndex = m.index + matched.length;
    }
    if (lastIndex < rawText.length) {
      parentEl.appendChild(document.createTextNode(rawText.slice(lastIndex)));
    }
  }

  function renderInlineMarkdown(rawText, parentEl) {
    // Handle **bold** inline
    var parts = rawText.split(/(\*\*[^*]+\*\*)/g);
    parts.forEach(function(part) {
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        var b = document.createElement('strong');
        annotateText(part.slice(2, -2), b);
        parentEl.appendChild(b);
      } else {
        annotateText(part, parentEl);
      }
    });
  }

  var lines = text.split('\n');
  var i = 0;
  var prevWasBlank = true; // treat start-of-text as "after a blank line"

  // Returns true when a plain-text line should be auto-promoted to a section
  // title.  Triggered only on the first non-empty line after a blank line (or
  // the very start of the reply).  Heuristics that disqualify a line:
  //   • ends with sentence-ending punctuation (it's a sentence, not a heading)
  //   • contains "PMID" or "[" (citation or markdown link — already content)
  //   • longer than 100 chars (too long to be a title)
  //   • starts with an explicit markdown prefix (handled separately above)
  function _isAutoTitle(line) {
    var t = line.trim();
    if (!t || t.length > 100) return false;
    if (/[.?!,;:]$/.test(t)) return false;
    if (/PMID|\[/.test(t)) return false;
    return true;
  }

  while (i < lines.length) {
    var line = lines[i];
    var trimmed = line.trim();

    if (/^###\s+/.test(line)) {
      var h = document.createElement('div');
      h.style.cssText = 'font-weight:700;font-size:13px;color:#8ab4e8;margin-top:12px;margin-bottom:4px;border-bottom:1px solid #2a3a5a;padding-bottom:3px';
      renderInlineMarkdown(line.replace(/^###\s+/, ''), h);
      container.appendChild(h);
      prevWasBlank = false;
    } else if (/^##\s+/.test(line)) {
      var h = document.createElement('div');
      h.style.cssText = 'font-weight:700;font-size:14px;color:#a0c4ff;margin-top:14px;margin-bottom:5px';
      renderInlineMarkdown(line.replace(/^##\s+/, ''), h);
      container.appendChild(h);
      prevWasBlank = false;
    } else if (/^#\s+/.test(line)) {
      var h = document.createElement('div');
      h.style.cssText = 'font-weight:700;font-size:15px;color:#b8d4ff;margin-top:16px;margin-bottom:6px';
      renderInlineMarkdown(line.replace(/^#\s+/, ''), h);
      container.appendChild(h);
      prevWasBlank = false;
    } else if (/^[-*]\s+/.test(line)) {
      var li = document.createElement('div');
      li.style.cssText = 'padding-left:16px;margin:2px 0';
      var bullet = document.createTextNode('• ');
      li.appendChild(bullet);
      renderInlineMarkdown(line.replace(/^[-*]\s+/, ''), li);
      container.appendChild(li);
      prevWasBlank = false;
    } else if (trimmed === '') {
      // Blank line → small spacer
      var spacer = document.createElement('div');
      spacer.style.height = '6px';
      container.appendChild(spacer);
      prevWasBlank = true;
    } else if (prevWasBlank && _isAutoTitle(trimmed)) {
      // Plain-text title: first non-empty line after a blank (or start),
      // styled the same as ### but with a slightly different accent colour
      // to distinguish LLM-generated section titles from markdown headings.
      var h = document.createElement('div');
      h.style.cssText = 'font-weight:700;font-size:13px;color:#c8a4f0;margin-top:14px;margin-bottom:4px;border-bottom:1px solid #3a2a5a;padding-bottom:3px';
      renderInlineMarkdown(trimmed, h);
      container.appendChild(h);
      prevWasBlank = false;
    } else {
      var p = document.createElement('div');
      p.style.marginBottom = '2px';
      renderInlineMarkdown(line, p);
      container.appendChild(p);
      prevWasBlank = false;
    }
    i++;
  }
}

function agentLoadCypherToBar() {
  if (!_agentLastCypher) return;
  // Try plain textarea first, then CodeMirror
  var input = document.getElementById('cypher-input') || document.querySelector('textarea[placeholder*="Cypher"]');
  if (input) { input.value = _agentLastCypher; input.dispatchEvent(new Event('input')); }
  if (window.cypherEditor && window.cypherEditor.setValue) window.cypherEditor.setValue(_agentLastCypher);
}

function agentClearChat() {
  _agentChatHistory = [];
  _agentLastCypher  = null;
  var bar = document.getElementById('agent-cypher-bar');
  if (bar) bar.style.display = 'none';
  var container = document.getElementById('agent-chat-messages');
  if (container) container.innerHTML = '<div style="text-align:center;color:#5a6080;font-size:12px;padding:20px 0">Ask anything about your graph &mdash; I can translate natural language to Cypher, run queries, and chain multi-step workflows.</div>';
}

// ── Agent mode switching ─────────────────────────────────────────────────────
function switchAgentMode(mode) {
  if (!mode || (mode !== 'text2cypher' && mode !== 'summarize')) {
    console.log('[switchAgentMode] Invalid mode:', mode);
    return;
  }
  
  console.log('[switchAgentMode] Switching to mode:', mode);
  var _prevMode = _agentCurrentMode;
  _agentCurrentMode = mode;
  // Only clear chat when the mode actually changes — not when the panel is merely
  // closed and reopened in the same mode.  The user must press "Clear chat" to
  // wipe the history explicitly.
  if (_prevMode !== mode) {
    agentClearChat();
  }
  
  // Update tab highlighting
  var tabs = document.querySelectorAll('.agent-mode-tab');
  tabs.forEach(function(tab) {
    tab.classList.toggle('active', tab.getAttribute('data-mode') === mode);
  });

  // Update panel title so it doesn't keep showing "Text2Cypher" while in Summarize mode
  var title = document.getElementById('agent-panel-title');
  if (title) {
    title.textContent = mode === 'summarize' ? '🤖 Summarize' : '🤖 Text2Cypher';
  }

  // Update message placeholder based on mode
  var input = document.getElementById('agent-input');
  if (input) {
    input.placeholder = mode === 'summarize'
      ? 'Ask a question about the current graph and its references…'
      : 'Ask anything about your graph…';
  }
}

// ── Summarize mode actions ───────────────────────────────────────────────────

function agentSummarizeAll() {
  _ensureSummarizeMode();
  var input = document.getElementById('agent-input');
  input.value = 'Summarize all relations in the current graph using the supporting sentences and provide a comprehensive overview of the biological pathway.';
  agentSend();
}

function agentSummarizeSelected() {
  // Get selected nodes/edges from Cytoscape
  if (!cy || typeof cy.nodes !== 'function') {
    console.log('[agentSummarizeSelected] No Cytoscape instance');
    return;
  }

  var selectedElements = cy.$(":selected");
  if (!selectedElements || selectedElements.length === 0) {
    alert('Please select nodes or edges to summarize');
    return;
  }

  var selectedEdges = selectedElements.edges().length;
  var selectedNodes = selectedElements.nodes().length;

  _ensureSummarizeMode();
  var input = document.getElementById('agent-input');
  input.value = 'Summarize the ' + selectedEdges + ' selected relation(s) and ' + selectedNodes + ' selected node(s) using their supporting sentences and references.';
  agentSend();
}

// Enable/disable the "Summarize selected" button based on current Cytoscape selection.
function _updateSummarizeSelectedBtn() {
  var btn = document.getElementById('agent-summarize-selected-btn');
  if (!btn) return;
  var hasSelection = cy && typeof cy.$ === 'function' && cy.$(":selected").length > 0;
  btn.disabled = !hasSelection;
  if (hasSelection) {
    btn.style.borderColor = '#4f8ef7';
    btn.style.color = '#4f8ef7';
    btn.style.cursor = 'pointer';
  } else {
    btn.style.borderColor = '#3a3f55';
    btn.style.color = '#3a3f55';
    btn.style.cursor = 'not-allowed';
  }
}

// Switch to summarize mode and open the panel if it isn't already open.
function _ensureSummarizeMode() {
  if (_agentCurrentMode !== 'summarize') {
    switchAgentMode('summarize');
  }
  if (!_agentPanelOpen) {
    toggleAgenticPanel();
  }
}

// ── Graph building for agent ─────────────────────────────────────────────────

// Collect all unique integer relation IDs from an array of built edges.
function _extractRelationIds(edges) {
  var seen = {};
  var ids = [];
  (edges || []).forEach(function(e) {
    var candidates = [];
    if (e.relationId != null && e.relationId !== '') candidates.push(e.relationId);
    if (Array.isArray(e.relationIds)) e.relationIds.forEach(function(r) { candidates.push(r); });
    candidates.forEach(function(r) {
      var n = parseInt(String(r), 10);
      if (!isNaN(n) && !seen[n]) { seen[n] = true; ids.push(n); }
    });
  });
  console.log('[_extractRelationIds] Extracted IDs from', edges.length, 'edges:', ids);
  return ids;
}

function _buildCurrentGraphFromCy() {
  // Extract current Cytoscape data and merge with graphData references.
  // Field names must match what summarize_agent.py expects:
  //   Nodes: urn, aliases, label, type
  //   Edges: source/target (names), sourceURN/targetURN, sourceType/targetType,
  //          sourceNodeId/targetNodeId, type, effect, mechanism,
  //          relationId, relationIds, references (array)
  //   Graph/pathway name: tabName / graphName — summarize_agent.py's
  //     get_graph_names() reads these (among a few other synonyms) to seed
  //     anatomy/context lookups from the graph's title (e.g. "lung cancer"
  //     tab name -> "lung" anatomy token). The only app-side value that's
  //     actually kept up to date today is the active tab's name (tabs[]),
  //     so that's what we send.
  console.log('[_buildCurrentGraphFromCy] Starting graph build...');
  var currentTabName = (Array.isArray(tabs) && tabs[activeTabIdx] && tabs[activeTabIdx].name) || '';
  if (!cy || typeof cy.nodes !== 'function') {
    console.log('[_buildCurrentGraphFromCy] No Cytoscape instance, returning empty graph');
    return { nodes: [], edges: [], tabName: currentTabName, graphName: currentTabName };
  }

  // Index graphData nodes by id for fast URN / alias lookup
  var gdNodeById = {};
  if (graphData && Array.isArray(graphData.nodes)) {
    graphData.nodes.forEach(function(n) { if (n.id != null) gdNodeById[String(n.id)] = n; });
    console.log('[_buildCurrentGraphFromCy] Indexed', graphData.nodes.length, 'nodes from graphData');
  }

  // Index graphData edges by id for fast reference lookup
  var gdEdgeById = {};
  if (graphData && Array.isArray(graphData.edges)) {
    graphData.edges.forEach(function(e) { if (e.id != null) gdEdgeById[String(e.id)] = e; });
    console.log('[_buildCurrentGraphFromCy] Indexed', graphData.edges.length, 'edges from graphData');
  }

  // Build nodes array — also track which ones are currently selected on the
  // canvas (cyNode.selected()) so the backend can scope its summary to just
  // the user's selection instead of always summarizing the whole graph.
  var nodes = [];
  var selectedNodes = [];
  cy.nodes().forEach(function(cyNode) {
    var d = cyNode.data();
    // Cytoscape node data has all n.properties spread in (see _buildCyNodeData)
    // so URN, Alias, Name etc. are directly on `d`.
    var urn = d.URN || d.urn || '';
    var gdn = gdNodeById[String(d.id)] || {};
    var gdProps = (gdn.properties) || {};
    var nodeObj = {
      id:      d.id,
      urn:     urn,
      label:   d.label || d.Name || d.id,
      type:    d.nodeType || d.NodeType || '',
      aliases: d.Alias ? (Array.isArray(d.Alias) ? d.Alias : String(d.Alias).split(',')) : (gdProps.Alias ? String(gdProps.Alias).split(',') : [])
    };
    nodes.push(nodeObj);
    // Push the SAME object (not a clone) so later in-place edits (e.g. the
    // reference merge below) are automatically reflected in both arrays.
    if (cyNode.selected()) selectedNodes.push(nodeObj);
  });
  console.log('[_buildCurrentGraphFromCy] Built', nodes.length, 'nodes,', selectedNodes.length, 'selected');

  // Build edges array — same "selected" tracking as nodes above.
  var edges = [];
  var selectedEdges = [];
  cy.edges().forEach(function(cyEdge) {
    var d = cyEdge.data();
    // Cytoscape edge data fields come from _buildCyEdgeData:
    //   relId (string), relIds (array|null), relType, effect, mechanism
    //   source/target are Cytoscape node IDs — we need names from those nodes
    var srcNode = cy.getElementById(d.source);
    var tgtNode = cy.getElementById(d.target);
    var srcData = srcNode.length ? srcNode.data() : {};
    var tgtData = tgtNode.length ? tgtNode.data() : {};

    // Get raw graphData edge for properties.references and full property access
    var gde = gdEdgeById[String(d.id)] || {};
    var gdeProps = gde.properties || {};

    // Build relation IDs — Python expects camelCase: relationId / relationIds
    var relId = d.relId || (gdeProps.RelationID != null ? String(gdeProps.RelationID) : null);
    var relIds = d.relIds || (Array.isArray(gdeProps.RelationIDs) ? gdeProps.RelationIDs : null);

    // References: only present for RNEF/file-loaded edges (properties.references)
    var refs = (gdeProps.references && Array.isArray(gdeProps.references)) ? gdeProps.references : [];

    var edgeObj = {
      id:           d.id,
      source:       srcData.Name || srcData.label || d.source,
      target:       tgtData.Name || tgtData.label || d.target,
      sourceURN:    srcData.URN  || srcData.urn  || '',
      targetURN:    tgtData.URN  || tgtData.urn  || '',
      sourceType:   srcData.nodeType || srcData.NodeType || '',
      targetType:   tgtData.nodeType || tgtData.NodeType || '',
      sourceNodeId: d.source,
      targetNodeId: d.target,
      type:         d.relType || gde.type || '',
      effect:       d.effect  || gdeProps.Effect || gdeProps.effect || '',
      mechanism:    d.mechanism || gdeProps.Mechanism || gdeProps.mechanism || '',
      relationId:   relId,
      relationIds:  relIds,
      references:   refs
    };
    edges.push(edgeObj);
    // Same object reference (not a clone) so the reference-merge step below
    // updates this entry too, everywhere it appears.
    if (cyEdge.selected()) selectedEdges.push(edgeObj);
  });
  console.log('[_buildCurrentGraphFromCy] Built', edges.length, 'edges,', selectedEdges.length, 'selected');
  if (edges.length > 0) {
    console.log('[_buildCurrentGraphFromCy] First edge details:', edges[0]);
  }

  // Merge pathway-level properties (Description, Notes, Organ, Tissue, etc.)
  // from the currently open RNEF pathway so Python's init_resnet_graph() /
  // graph2analyze() can populate PSPathway props and prompt_introduction()
  // can include them in the LLM prompt.
  // currentPathwayProperties is a let variable in app.js (same global scope).
  var pathwayMeta = {};
  if (typeof currentPathwayProperties !== 'undefined' && currentPathwayProperties &&
      typeof currentPathwayProperties === 'object') {
    Object.keys(currentPathwayProperties).forEach(function(k) {
      var v = currentPathwayProperties[k];
      if (v != null && v !== '' && typeof v === 'string') {
        pathwayMeta[k] = v;
      }
    });
  }

  return Object.assign({
    nodes: nodes, edges: edges, selectedNodes: selectedNodes, selectedEdges: selectedEdges,
    tabName: currentTabName, graphName: currentTabName
  }, pathwayMeta);
}

// ── Library browser ───────────────────────────────────────────────────────────
function openAgentLibrary() {
  document.getElementById('agent-library-modal').style.display = 'flex';
  agentLibraryRefresh();
}
function closeAgentLibrary() {
  document.getElementById('agent-library-modal').style.display = 'none';
}

async function agentLibraryRefresh() {
  var list = document.getElementById('agent-library-list');
  list.innerHTML = '<div style="color:#5a6080;font-size:12px;text-align:center;padding:20px">Loading...</div>';
  try {
    var data = await api('/api/agent/library', null, 'GET');
    _agentLibraryFiles = data.files || [];
    _renderLibraryList(_agentLibraryFiles);
  } catch(e) {
    list.innerHTML = '<div style="color:#ff6b6b;font-size:12px;padding:10px">Failed to load library: ' + e.message + '</div>';
  }
}

function agentLibraryFilter(q) {
  var lower = q.toLowerCase();
  _renderLibraryList(_agentLibraryFiles.filter(function(f) {
    return f.name.toLowerCase().includes(lower) || (f.description || '').toLowerCase().includes(lower);
  }));
}

function _renderLibraryList(files) {
  var list = document.getElementById('agent-library-list');
  if (!files.length) {
    list.innerHTML = '<div style="color:#5a6080;font-size:12px;text-align:center;padding:20px">No files found.</div>';
    return;
  }
  list.innerHTML = '';
  files.forEach(function(f) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;background:#252a40;border:1px solid #2a3050;border-radius:6px;padding:10px 12px';
    var desc = escHtml(f.description || '') + (f.steps ? ' &middot; ' + f.steps + ' step(s)' : '') + (f.created ? ' &middot; ' + f.created.slice(0,10) : '');
    row.innerHTML =
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:13px;color:#e0e0e0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(f.name) + '</div>' +
        '<div style="font-size:11px;color:#5a6080;margin-top:2px">' + desc + '</div>' +
      '</div>' +
      '<button onclick="agentLibraryLoad(\'' + f.id + '\')" style="padding:4px 10px;background:#4f8ef7;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer;white-space:nowrap">Load</button>' +
      '<button onclick="agentLibraryDelete(\'' + f.id + '\',this)" style="padding:4px 10px;background:transparent;border:1px solid #4a1c1c;border-radius:4px;color:#ff6b6b;font-size:11px;cursor:pointer;white-space:nowrap">Delete</button>';
    list.appendChild(row);
  });
}

async function agentLibraryLoad(fileId) {
  try {
    var data = await api('/api/agent/library/' + fileId, null, 'GET');
    if (data.llm_config) Object.assign(_agentConfig, data.llm_config);
    if (data.workflow && data.workflow.length) _agentWorkflow = data.workflow;
    var summary = 'Loaded: ' + data.name + (data.description ? '\n' + data.description : '');
    if (data.notes) summary += '\n\nNotes: ' + data.notes;
    if (data.workflow && data.workflow.length) {
      summary += '\n\nWorkflow steps:\n' + data.workflow.map(function(s, i) {
        return (i+1) + '. [' + s.type + '] ' + (s.description || s.prompt_template || '');
      }).join('\n');
    }
    _agentAppendMessage('assistant', summary);
    closeAgentLibrary();
  } catch(e) { alert('Failed to load file: ' + e.message); }
}

async function agentLibraryDelete(fileId, btn) {
  if (!confirm('Delete this library file?')) return;
  btn.disabled = true;
  try {
    await api('/api/agent/library/' + fileId, null, 'DELETE');
    agentLibraryRefresh();
  } catch(e) { alert('Delete failed: ' + e.message); btn.disabled = false; }
}

function agentLibrarySaveNew() {
  closeAgentLibrary();
  document.getElementById('asave-name').value        = '';
  document.getElementById('asave-description').value = '';
  document.getElementById('asave-notes').value       = '';
  document.getElementById('asave-error').style.display = 'none';
  document.getElementById('agent-save-modal').style.display = 'flex';
}

async function agentLibraryDoSave() {
  var name = (document.getElementById('asave-name').value || '').trim();
  if (!name) {
    document.getElementById('asave-error').textContent = 'Name is required';
    document.getElementById('asave-error').style.display = 'block';
    return;
  }
  try {
    await api('/api/agent/library', {
      name:        name,
      description: document.getElementById('asave-description').value || '',
      notes:       document.getElementById('asave-notes').value || '',
      llm_config:  _agentConfig,
      workflow:    _agentWorkflow,
    });
    closeAgentSave();
  } catch(e) {
    document.getElementById('asave-error').textContent = 'Save failed: ' + e.message;
    document.getElementById('asave-error').style.display = 'block';
  }
}

function closeAgentSave() {
  document.getElementById('agent-save-modal').style.display = 'none';
}

// ── Config dialog ─────────────────────────────────────────────────────────────
function openAgentConfig() {
  document.getElementById('acfg-temperature').value = _agentConfig.temperature;
  document.getElementById('acfg-top-p').value       = _agentConfig.top_p;
  document.getElementById('acfg-model').value       = _agentConfig.model_name || '';
  document.getElementById('acfg-json-mode').checked = !!_agentConfig.json_mode;
  _renderWorkflowSteps();
  document.getElementById('agent-config-modal').style.display = 'flex';
}
function closeAgentConfig() {
  document.getElementById('agent-config-modal').style.display = 'none';
}
function saveAgentConfig() {
  _agentConfig.temperature = parseFloat(document.getElementById('acfg-temperature').value) || 0.2;
  _agentConfig.top_p       = parseFloat(document.getElementById('acfg-top-p').value) || 0.9;
  _agentConfig.model_name  = document.getElementById('acfg-model').value.trim();  // empty = use server-side LLM settings
  _agentConfig.json_mode   = document.getElementById('acfg-json-mode').checked;
  closeAgentConfig();
}

function _renderWorkflowSteps() {
  var container = document.getElementById('acfg-workflow-steps');
  container.innerHTML = '';
  if (!_agentWorkflow.length) {
    container.innerHTML = '<div style="color:#5a6080;font-size:12px">No steps. Click &quot;+ Add step&quot; to build a multi-step workflow.</div>';
    return;
  }
  _agentWorkflow.forEach(function(step, idx) {
    var row = document.createElement('div');
    row.style.cssText = 'background:#252a40;border:1px solid #2a3050;border-radius:6px;padding:8px 10px;display:flex;gap:8px;align-items:flex-start';
    var typeOpts = ['text2cypher','llm','write_back'].map(function(t) {
      return '<option value="' + t + '"' + (step.type === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('');
    row.innerHTML =
      '<div style="flex:1">' +
        '<div style="display:flex;gap:6px;margin-bottom:4px">' +
          '<select onchange="_agentUpdateStep(' + idx + ',\'type\',this.value)" style="background:#1e2235;border:1px solid #3a3f55;border-radius:4px;color:#e0e0e0;font-size:11px;padding:2px 4px">' + typeOpts + '</select>' +
          '<span style="font-size:11px;color:#5a6080">Step ' + (idx+1) + '</span>' +
        '</div>' +
        '<input type="text" value="' + escHtml(step.description || '') + '" placeholder="Description" oninput="_agentUpdateStep(' + idx + ',\'description\',this.value)" style="width:100%;background:#1e2235;border:1px solid #3a3f55;border-radius:4px;color:#e0e0e0;font-size:11px;padding:3px 6px;margin-bottom:3px;box-sizing:border-box">' +
        '<input type="text" value="' + escHtml(step.prompt_template || step.cypher_template || '') + '" placeholder="Prompt template — use {input} for user input" oninput="_agentUpdateStep(' + idx + ',\'prompt_template\',this.value)" style="width:100%;background:#1e2235;border:1px solid #3a3f55;border-radius:4px;color:#e0e0e0;font-size:11px;padding:3px 6px;box-sizing:border-box">' +
      '</div>' +
      '<button onclick="_agentRemoveStep(' + idx + ')" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:16px;padding:0;flex-shrink:0">x</button>';
    container.appendChild(row);
  });
}

function agentAddWorkflowStep() {
  _agentWorkflow.push({ step: _agentWorkflow.length + 1, type: 'text2cypher', description: '', prompt_template: '{input}' });
  _renderWorkflowSteps();
}
function _agentUpdateStep(idx, key, value) {
  if (_agentWorkflow[idx]) _agentWorkflow[idx][key] = value;
}
function _agentRemoveStep(idx) {
  _agentWorkflow.splice(idx, 1);
  _agentWorkflow.forEach(function(s, i) { s.step = i + 1; });
  _renderWorkflowSteps();
}

async function agentRunWorkflow() {
  if (!_agentWorkflow.length) { alert('No workflow steps defined. Open the Config dialog to add steps.'); return; }
  var input     = document.getElementById('agent-input');
  var userInput = (input.value || '').trim() || '{input}';
  input.value   = '';

  _agentAppendMessage('user', 'Running workflow (' + _agentWorkflow.length + ' step(s))...\nInput: ' + userInput);
  var sendBtn  = document.getElementById('agent-send-btn');
  var thinking = document.getElementById('agent-thinking-indicator');
  sendBtn.disabled = true;
  if (thinking) thinking.style.display = 'inline';

  try {
    var result = await api('/api/agent/workflow/execute', {
      workflow: _agentWorkflow,
      input:    userInput,
      llm:      _agentConfig,
    });
    var lines = ['Workflow completed:'];
    (result.results || []).forEach(function(r) {
      lines.push('Step ' + r.step + ' [' + r.type + ']: ' + (r.status || ''));
      if (r.cypher) { lines.push('  Cypher: ' + r.cypher.slice(0, 120)); _agentLastCypher = r.cypher; }
      if (r.row_count !== undefined) lines.push('  Rows: ' + r.row_count);
      if (r.reply) lines.push('  ' + r.reply.slice(0, 300));
      if (r.error) lines.push('  Error: ' + r.error);
    });
    _agentAppendMessage('assistant', lines.join('\n'));
  } catch(e) {
    _agentAppendMessage('error', 'Workflow failed: ' + e.message);
  } finally {
    sendBtn.disabled = false;
    if (thinking) thinking.style.display = 'none';
  }
}

// ── Default model lists per provider URL ────────────────────────────────────
var _LLM_DEFAULT_MODELS = {
  'https://generativelanguage.googleapis.com/v1beta/openai/': [
    'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash-lite',
    'gemini-1.5-pro', 'gemini-1.5-flash'
  ],
  'https://api.openai.com/v1': [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'
  ],
  'https://api.anthropic.com': [
    'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
    'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'
  ],
  'https://api.groq.com/openai/v1': [
    'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
    'mixtral-8x7b-32768', 'gemma2-9b-it'
  ],
  'https://api.together.xyz': [
    'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    'mistralai/Mixtral-8x7B-Instruct-v0.1'
  ],
  'https://api.replicate.com': [
    'meta/llama-3.1-405b-instruct', 'meta/llama-3.1-70b-instruct',
    'meta/llama-3.1-8b-instruct'
  ],
};

function _populateModelSelect(providerUrl, savedModel) {
  var modelSelect = document.getElementById('llms-user-model');
  var defaults = _LLM_DEFAULT_MODELS[providerUrl] || [];
  modelSelect.innerHTML = '';
  if (!providerUrl) {
    modelSelect.innerHTML = '<option value="">— Select provider first —</option>';
    return;
  }
  var allModels = defaults.slice();
  // If saved model isn't in defaults, add it at the top
  if (savedModel && allModels.indexOf(savedModel) < 0) {
    allModels.unshift(savedModel);
  }
  if (!allModels.length) {
    modelSelect.innerHTML = '<option value="">— Click ↻ Fetch to load models —</option>';
    return;
  }
  allModels.forEach(function(m) {
    var opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modelSelect.appendChild(opt);
  });
  modelSelect.value = savedModel || allModels[0];
}

// ── LLM Settings modal ────────────────────────────────────────────────────────
async function openLLMSettings() {
  document.getElementById('llm-settings-error').style.display   = 'none';
  document.getElementById('llm-settings-success').style.display = 'none';
  try {
    var userData = await api('/api/settings/my-llm', null, 'GET');

    // Check if user is admin by checking their role (not by trying to call admin endpoint)
    var currentUser = window._currentUser || {};
    var isAdmin = currentUser.role === 'admin';
    
    // Load provider list and admin settings
    var data = {};
    try {
      data = await api('/api/settings/llm', null, 'GET');
    } catch(err) {
      console.error('[LLM] Failed to load provider settings:', err);
      data = { providers: [] };
    }

    // Show/hide admin section based on actual user role
    var adminSection = document.getElementById('llms-admin-section');
    if (isAdmin) {
      adminSection.style.display = 'block';

      // Populate custom providers list (admin can only edit custom ones, not defaults)
      var providersList = document.getElementById('llms-providers-list');
      providersList.innerHTML = '';
      if (data.custom_providers && Array.isArray(data.custom_providers)) {
        data.custom_providers.forEach(function(provider, index) {
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px;background:#252a40;border-radius:4px;border:1px solid #3a3f55';
          row.innerHTML = '<input type="text" placeholder="Provider name" value="' + (provider.name || '') + '" data-index="' + index + '" class="llms-provider-name" style="flex:1;background:#1a1f30;border:1px solid #3a3f55;border-radius:3px;color:#e0e0e0;padding:5px 8px;font-size:12px">' +
                          '<input type="text" placeholder="API URL" value="' + (provider.url || '') + '" data-index="' + index + '" class="llms-provider-url" style="flex:1;background:#1a1f30;border:1px solid #3a3f55;border-radius:3px;color:#e0e0e0;padding:5px 8px;font-size:12px">' +
                          '<button type="button" onclick="llmsRemoveProvider(' + index + ')" style="padding:3px 8px;background:#3a2a2a;border:1px solid #5a3a3a;border-radius:3px;color:#d0a0a0;font-size:11px;cursor:pointer">Remove</button>';
          providersList.appendChild(row);
        });
      }

    } else {
      adminSection.style.display = 'none';
    }

    // Populate provider dropdown FIRST (options use URL as value)
    var providerSelect = document.getElementById('llms-user-provider');
    providerSelect.innerHTML = '<option value="">— Select provider —</option>';
    if (data.providers && Array.isArray(data.providers)) {
      data.providers.forEach(function(provider) {
        var option = document.createElement('option');
        option.value = provider.url || '';
        option.textContent = provider.name || 'Unknown';
        providerSelect.appendChild(option);
      });
    }

    // Restore saved provider selection
    var savedUrl = userData.url || '';
    var savedModel = userData.model_name || '';
    providerSelect.value = savedUrl;

    // Populate model dropdown with defaults for the saved provider, restoring saved model
    _populateModelSelect(savedUrl, savedModel);

    document.getElementById('llms-user-apikey').value = '';  // never returned for security; leave empty to keep saved key
    document.getElementById('llms-user-temperature').value = userData.temperature !== undefined ? userData.temperature : 0.2;
    document.getElementById('llms-user-top-p').value = userData.top_p !== undefined ? userData.top_p : 0.9;
    document.getElementById('llms-user-json-mode').checked = !!userData.json_mode;

  } catch(e) {
    document.getElementById('llm-settings-error').textContent = 'Failed to load settings: ' + e.message;
    document.getElementById('llm-settings-error').style.display = 'block';
  }
  document.getElementById('llm-settings-modal').style.display = 'flex';
}

function llmsUserProviderChanged() {
  var selectedProvider = document.getElementById('llms-user-provider').value;
  _populateModelSelect(selectedProvider, '');
  document.getElementById('llms-user-models-status').textContent = '';
}

async function llmsUserFetchModels() {
  var statusEl = document.getElementById('llms-user-models-status');
  var apiKey = document.getElementById('llms-user-apikey').value.trim();
  var provider = document.getElementById('llms-user-provider').value.trim();
  
  if (!provider) {
    statusEl.textContent = 'Please select a provider';
    statusEl.style.color = '#e07070';
    return;
  }
  
  if (!apiKey) {
    statusEl.textContent = 'Please enter API key';
    statusEl.style.color = '#e07070';
    return;
  }
  
  statusEl.textContent = 'Fetching...';
  statusEl.style.color = '#a0b0d0';
  
  try {
    var result = await api('/api/agent/list-models', {
      url: provider,
      apikey: apiKey
    });
    
    var models = result.models || [];
    if (models.length === 0) {
      statusEl.textContent = 'No models found';
      statusEl.style.color = '#7a8099';
      return;
    }
    
    // Replace model dropdown with live API results
    var modelSelect = document.getElementById('llms-user-model');
    var currentModel = modelSelect.value;
    modelSelect.innerHTML = '';
    models.forEach(function(model) {
      var option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      modelSelect.appendChild(option);
    });
    // Restore previously selected model if still in list, else pick first
    modelSelect.value = (models.indexOf(currentModel) >= 0) ? currentModel : models[0];
    
    statusEl.textContent = models.length + ' models loaded';
    statusEl.style.color = '#70d070';
  } catch(e) {
    statusEl.textContent = 'Error: ' + (e.message || 'Failed to fetch');
    statusEl.style.color = '#e07070';
    console.error('[LLM] Fetch models error:', e);
  }
}

async function llmsUserTestConnection() {
  var resultEl = document.getElementById('llms-user-ping-result');
  var apiKey = document.getElementById('llms-user-apikey').value.trim();
  var provider = document.getElementById('llms-user-provider').value.trim();
  
  if (!provider) {
    resultEl.textContent = 'Select provider';
    resultEl.style.color = '#e07070';
    return;
  }
  
  if (!apiKey) {
    resultEl.textContent = 'Enter API key';
    resultEl.style.color = '#e07070';
    return;
  }
  
  var modelName = document.getElementById('llms-user-model').value.trim();
  if (!modelName) {
    resultEl.textContent = 'Select a model first (click Fetch, then choose one)';
    resultEl.style.color = '#e07070';
    return;
  }

  resultEl.textContent = 'Testing...';
  resultEl.style.color = '#a0b0d0';
  
  try {
    var result = await api('/api/agent/ping-llm', {
      llm: {
        url:        provider,
        apikey:     apiKey,
        model_name: modelName
      }
    });
    
    resultEl.textContent = '✓ Connection OK — ' + (result.model || modelName);
    resultEl.style.color = '#70d070';
  } catch(e) {
    resultEl.textContent = '✗ ' + (e.message || 'Connection failed');
    resultEl.style.color = '#e07070';
    console.error('[LLM] Ping error:', e);
  }
}

function llmsAddProvider() {
  var providersList = document.getElementById('llms-providers-list');
  var index = providersList.children.length;
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px;background:#252a40;border-radius:4px;border:1px solid #3a3f55';
  row.innerHTML = '<input type="text" placeholder="Provider name" value="" data-index="' + index + '" class="llms-provider-name" style="flex:1;background:#1a1f30;border:1px solid #3a3f55;border-radius:3px;color:#e0e0e0;padding:5px 8px;font-size:12px">' +
                  '<input type="text" placeholder="API URL" value="" data-index="' + index + '" class="llms-provider-url" style="flex:1;background:#1a1f30;border:1px solid #3a3f55;border-radius:3px;color:#e0e0e0;padding:5px 8px;font-size:12px">' +
                  '<button type="button" onclick="llmsRemoveProvider(' + index + ')" style="padding:3px 8px;background:#3a2a2a;border:1px solid #5a3a3a;border-radius:3px;color:#d0a0a0;font-size:11px;cursor:pointer">Remove</button>';
  providersList.appendChild(row);
}

function llmsRemoveProvider(index) {
  var providersList = document.getElementById('llms-providers-list');
  if (providersList.children[index]) {
    providersList.children[index].remove();
  }
}

function closeLLMSettings(event) {
  if (event && event.target !== document.getElementById('llm-settings-modal')) return;
  document.getElementById('llm-settings-modal').style.display = 'none';
}

async function saveLLMSettings() {
  var errEl   = document.getElementById('llm-settings-error');
  var okEl    = document.getElementById('llm-settings-success');
  var saveBtn = document.getElementById('llms-save-btn');
  errEl.style.display = 'none';
  okEl.style.display  = 'none';
  saveBtn.disabled    = true;

  try {
    // First, verify auth is working
    console.log('[LLM] Verifying authentication...');
    var authTest = await api('/api/test/user-auth', null, 'GET').catch(e => {
      console.error('[LLM] Auth test failed:', e);
      return null;
    });
    console.log('[LLM] Auth test result:', authTest);

    // All users save their own LLM settings
    var providerSelect = document.getElementById('llms-user-provider');
    var selectedOption = providerSelect.options[providerSelect.selectedIndex];
    var providerName = selectedOption && selectedOption.textContent ? selectedOption.textContent : '';
    var providerUrl = providerSelect.value.trim() || '';
    
    var userPayload = {
      provider_name: providerName,
      url:           providerUrl,
      apikey:        document.getElementById('llms-user-apikey').value,
      model_name:    document.getElementById('llms-user-model').value.trim() || '',
      temperature:   parseFloat(document.getElementById('llms-user-temperature').value) || 0.2,
      top_p:         parseFloat(document.getElementById('llms-user-top-p').value) || 0.9,
      json_mode:     document.getElementById('llms-user-json-mode').checked,
    };
    console.log('[LLM] Saving user settings:', userPayload);
    await api('/api/settings/my-llm', userPayload);

    // Admin can add custom providers (separate save)
    var adminSection = document.getElementById('llms-admin-section');
    if (adminSection && adminSection.style.display !== 'none') {
      try {
        var custom_providers = [];
        var providerRows = document.getElementById('llms-providers-list').querySelectorAll('div[style*="flex"]');
        providerRows.forEach(function(row) {
          var nameInput = row.querySelector('.llms-provider-name');
          var urlInput = row.querySelector('.llms-provider-url');
          if (nameInput && urlInput && nameInput.value.trim() && urlInput.value.trim()) {
            custom_providers.push({
              name: nameInput.value.trim(),
              url: urlInput.value.trim()
            });
          }
        });

        var adminPayload = {
          custom_providers: custom_providers,
        };
        console.log('[LLM] Saving admin settings:', adminPayload);
        await api('/api/settings/llm', adminPayload);
      } catch(adminErr) {
        console.error('[LLM] Admin settings failed (OK for non-admin):', adminErr.message);
      }
    }

    Object.assign(_agentConfig, {
      model_name:  userPayload.model_name,
      temperature: userPayload.temperature,
      top_p:       userPayload.top_p,
      json_mode:   userPayload.json_mode,
    });
    okEl.textContent   = 'Settings saved.';
    okEl.style.display = 'block';
  } catch(e) {
    console.error('[LLM] Save error:', e, 'Message:', e.message);
    errEl.textContent   = 'Save failed: ' + (e.message || String(e));
    errEl.style.display = 'block';
  } finally {
    saveBtn.disabled = false;
  }
}

// ── Init on login ─────────────────────────────────────────────────────────────
function _initAgenticAI() {
  var btn = document.getElementById('agentic-ai-btn');
  if (btn) btn.style.display = 'inline-block';

  var currentUser = window._currentUser || {};
  if (currentUser.role === 'admin') {
    var llmItem = document.getElementById('settings-llm-item');
    if (llmItem) llmItem.style.display = 'block';
  }

  api('/api/settings/llm', null, 'GET').then(function(d) {
    Object.assign(_agentConfig, {
      model_name:  d.model_name  || 'claude-sonnet-4-6',
      temperature: d.temperature !== undefined ? d.temperature : 0.2,
      top_p:       d.top_p      !== undefined ? d.top_p      : 0.9,
      json_mode:   !!d.json_mode,
    });
  }).catch(function() {});
}
