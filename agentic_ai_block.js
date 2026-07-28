
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

      // ── Debug: collect first 5 inline refs across all edges ──────────────
      var allInlineRefs = [];
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
      console.log('[agentSend] Collected refs:', { total: allInlineRefs.length, edgesWithRefs: edgesWithRefs, sampleCount: debugSampleRefs.length });
      console.log('[agentSend] Sample refs (first 5):', debugSampleRefs);

      // Dump first raw graphData edge to diagnose field names
      var rawEdgeDump = '';
      if (graphData && graphData.edges && graphData.edges.length > 0) {
        var re0 = graphData.edges[0];
        var p0 = re0.properties || {};
        rawEdgeDump = '\nRaw graphData.edges[0] keys: ' + Object.keys(re0).join(', ') +
                      '\n  .properties keys: ' + Object.keys(p0).join(', ') +
                      '\n  RelationID=' + p0.RelationID + ' RelationIDs=' + JSON.stringify(p0.RelationIDs) +
                      '\n  has inline refs: ' + (Array.isArray(p0.references) ? p0.references.length : 'no') +
                      '\nBuilt edge[0] keys: ' + (currentGraph.edges[0] ? Object.keys(currentGraph.edges[0]).join(', ') : 'none') +
                      '\n  relationId=' + (currentGraph.edges[0] && currentGraph.edges[0].relationId) +
                      ' references.length=' + (currentGraph.edges[0] && Array.isArray(currentGraph.edges[0].references) ? currentGraph.edges[0].references.length : 0);
      }

      _agentAppendMessage('assistant',
        '[DEBUG] Graph snapshot: ' + currentGraph.nodes.length + ' nodes, ' +
        currentGraph.edges.length + ' edges. ' +
        edgesWithRefs + ' edges have inline references (' + allInlineRefs.length + ' total). ' +
        'Sending first ' + debugSampleRefs.length + ' refs separately as debug_inline_refs.' +
        rawEdgeDump
      );
      // ─────────────────────────────────────────────────────────────────────

      var relationIds = _extractRelationIds(currentGraph.edges);
      console.log('[agentSend] Extracted relation_ids:', relationIds);

      var payload = {
        message: msg,
        history: _agentChatHistory.slice(0, -1),
        llm:     _agentConfig,
        current_graph: currentGraph,
        relation_ids: relationIds,
        debug_inline_refs: debugSampleRefs,
      };
      console.log('[agentSend] Full payload being sent to /api/agent/summarize-chat:');
      console.log('  - message:', payload.message);
      console.log('  - history length:', payload.history.length);
      console.log('  - llm config:', payload.llm);
      console.log('  - current_graph nodes:', payload.current_graph.nodes.length);
      console.log('  - current_graph edges:', payload.current_graph.edges.length);
      console.log('  - relation_ids:', payload.relation_ids);
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

function _agentAppendMessage(role, content, cypher, results) {
  var container = document.getElementById('agent-chat-messages');
  if (!container) return;

  var bubble = document.createElement('div');
  var baseStyle = 'max-width:96%;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;';
  if (role === 'user')        bubble.style.cssText = baseStyle + 'align-self:flex-end;background:#2a4a7f;color:#e0e8ff;border-bottom-right-radius:3px';
  else if (role === 'error')  bubble.style.cssText = baseStyle + 'align-self:flex-start;background:#4a1c1c;color:#ffaaaa;border-bottom-left-radius:3px';
  else                        bubble.style.cssText = baseStyle + 'align-self:flex-start;background:#1e2a45;color:#c8d0e8;border-bottom-left-radius:3px';
  bubble.textContent = content;

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
  _agentCurrentMode = mode;
  agentClearChat();
  
  // Update tab highlighting
  var tabs = document.querySelectorAll('.agent-mode-tab');
  tabs.forEach(function(tab) {
    tab.classList.toggle('active', tab.getAttribute('data-mode') === mode);
  });
  
  // Update message placeholder based on mode
  var input = document.getElementById('agent-input');
  if (input) {
    if (mode === 'summarize') {
      input.placeholder = 'Ask a question about the current graph and its references…';
    } else {
      input.placeholder = 'Ask anything about your graph…';
    }
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
  console.log('[_buildCurrentGraphFromCy] Starting graph build...');
  if (!window.cy) {
    console.log('[_buildCurrentGraphFromCy] No Cytoscape instance, returning empty graph');
    return { nodes: [], edges: [] };
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

  // Build nodes array
  var nodes = [];
  cy.nodes().forEach(function(cyNode) {
    var d = cyNode.data();
    // Cytoscape node data has all n.properties spread in (see _buildCyNodeData)
    // so URN, Alias, Name etc. are directly on `d`.
    var urn = d.URN || d.urn || '';
    var gdn = gdNodeById[String(d.id)] || {};
    var gdProps = (gdn.properties) || {};
    nodes.push({
      id:      d.id,
      urn:     urn,
      label:   d.label || d.Name || d.id,
      type:    d.nodeType || d.NodeType || '',
      aliases: d.Alias ? (Array.isArray(d.Alias) ? d.Alias : String(d.Alias).split(',')) : (gdProps.Alias ? String(gdProps.Alias).split(',') : [])
    });
  });
  console.log('[_buildCurrentGraphFromCy] Built', nodes.length, 'nodes');

  // Build edges array
  var edges = [];
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

    edges.push({
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
    });
  });
  console.log('[_buildCurrentGraphFromCy] Built', edges.length, 'edges');
  if (edges.length > 0) {
    console.log('[_buildCurrentGraphFromCy] First edge details:', edges[0]);
  }

  return { nodes: nodes, edges: edges };
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
  _agentConfig.model_name  = document.getElementById('acfg-model').value.trim() || 'claude-sonnet-4-6';
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

// ── LLM Settings modal ────────────────────────────────────────────────────────
async function openLLMSettings() {
  document.getElementById('llm-settings-error').style.display   = 'none';
  document.getElementById('llm-settings-success').style.display = 'none';
  try {
    var data = await api('/api/settings/llm', null, 'GET');
    document.getElementById('llms-url').value         = data.url        || '';
    document.getElementById('llms-apikey').value      = data.apikey     || '';
    document.getElementById('llms-username').value    = data.username   || '';
    document.getElementById('llms-password').value    = data.password   || '';
    document.getElementById('llms-model').value       = data.model_name || 'claude-sonnet-4-6';
    document.getElementById('llms-temperature').value = data.temperature !== undefined ? data.temperature : 0.2;
    document.getElementById('llms-top-p').value       = data.top_p      !== undefined ? data.top_p      : 0.9;
    document.getElementById('llms-json-mode').checked = !!data.json_mode;
  } catch(e) {
    document.getElementById('llm-settings-error').textContent = 'Failed to load settings: ' + e.message;
    document.getElementById('llm-settings-error').style.display = 'block';
  }
  document.getElementById('llm-settings-modal').style.display = 'flex';
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

  var payload = {
    url:         document.getElementById('llms-url').value.trim(),
    apikey:      document.getElementById('llms-apikey').value,
    username:    document.getElementById('llms-username').value.trim(),
    password:    document.getElementById('llms-password').value,
    model_name:  document.getElementById('llms-model').value.trim() || 'claude-sonnet-4-6',
    temperature: parseFloat(document.getElementById('llms-temperature').value) || 0.2,
    top_p:       parseFloat(document.getElementById('llms-top-p').value) || 0.9,
    json_mode:   document.getElementById('llms-json-mode').checked,
  };

  try {
    await api('/api/settings/llm', payload);
    Object.assign(_agentConfig, {
      model_name:  payload.model_name,
      temperature: payload.temperature,
      top_p:       payload.top_p,
      json_mode:   payload.json_mode,
    });
    okEl.textContent   = 'Settings saved.';
    okEl.style.display = 'block';
  } catch(e) {
    errEl.textContent   = 'Save failed: ' + e.message;
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
