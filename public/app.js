/* ═══════════════════════════════════════════════════════════════════════════
   Graph Explorer — Frontend Logic
   Dependencies: Cytoscape.js, cytoscape-dagre (loaded in index.html)
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let authToken = null;
let currentUser = null;
let currentRole = null;
let cy = null;
let currentQuery = '';
let graphData = { nodes: [], edges: [] };   // raw data from server
let refsCache = {};                          // relId → [postgres rows]
let typeColorMap = {};                       // relType → hex color
let colorIdx = 0;
let tooltipVisible = false;
let tableRows = [];                          // all table rows
let tableSortCol = null;
let tableSortAsc = true;
let currentLayout = 'cose';
let contextTarget = null;   // element targeted by right-click
let curationTarget = null;  // element open in curation modal

// ─── Constants ────────────────────────────────────────────────────────────────
const DIRECT_TYPES = new Set([
  'Binding', 'DirectRegulation', 'ProtModification', 'PromoterBinding', 'ChemicalReaction'
]);

const COLOR_PALETTE = [
  '#4f8ef7','#e05560','#4daf4a','#ff7f00','#984ea3',
  '#a65628','#f781bf','#17becf','#1b9e77','#d62728',
  '#9467bd','#8c564b','#e377c2','#7f7f7f','#bcbd22',
  '#2ca02c','#ff9896','#aec7e8','#ffbb78','#98df8a'
];

const NODE_COLORS = {
  Gene: '#4daf4a', Protein: '#377eb8', Disease: '#e41a1c',
  Drug: '#ff7f00', Chemical: '#a65628', Pathway: '#984ea3',
  CellProcess: '#f781bf', Cell: '#1b9e77', Tissue: '#d95f02',
  Organ: '#e6ab02', SmallMol: '#66c2a5', Virus: '#fc8d62',
  Bacteria: '#8da0cb', FunctionalClass: '#e78ac3',
  Complex: '#a6d854', Reaction: '#999999'
};
const DEFAULT_NODE_COLOR = '#5a6a9a';

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', function() {
  var saved = sessionStorage.getItem('authToken');
  if (saved) {
    authToken = saved;
    currentUser = sessionStorage.getItem('currentUser');
    currentRole = sessionStorage.getItem('currentRole');
    showApp();
  }
  document.addEventListener('mousemove', function(e) {
    if (tooltipVisible) positionTooltip(e.clientX, e.clientY);
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  var username = document.getElementById('login-username').value.trim();
  var password = document.getElementById('login-password').value;
  var errEl = document.getElementById('login-error');
  var btn = document.getElementById('login-btn');

  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    var res = await api('/api/auth/login', { username: username, password: password }, false);
    authToken = res.token;
    currentUser = res.username;
    currentRole = res.role;
    sessionStorage.setItem('authToken', authToken);
    sessionStorage.setItem('currentUser', currentUser);
    sessionStorage.setItem('currentRole', currentRole);
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('current-user-label').textContent = currentUser;
  if (currentRole === 'admin') {
    document.getElementById('admin-btn').style.display = '';
  }
  initCytoscape();
}

function logout() {
  authToken = null; currentUser = null; currentRole = null;
  sessionStorage.clear();
  if (cy) cy.destroy();
  cy = null;
  graphData = { nodes: [], edges: [] };
  refsCache = {};
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
}

// ─── API helper ───────────────────────────────────────────────────────────────
async function api(path, body, auth) {
  if (auth === undefined) auth = true;
  var opts = {
    method: body !== null && body !== undefined ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' }
  };
  if (auth && authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
  if (body !== null && body !== undefined) opts.body = JSON.stringify(body);

  var res = await fetch(path, opts);
  var data = await res.json().catch(function() { return {}; });
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function apiDelete(path) {
  var res = await fetch(path, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + authToken }
  });
  var data = await res.json().catch(function() { return {}; });
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ─── Cytoscape init ───────────────────────────────────────────────────────────
function initCytoscape() {
  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: [],
    minZoom: 0.05, maxZoom: 5,
    wheelSensitivity: 0.3,
    style: getCyStyle(),
    layout: { name: 'preset' }
  });

  // Tooltip on edge hover
  cy.on('mouseover', 'edge', async function(evt) {
    if (document.getElementById('curation-modal').style.display !== 'none') return;
    var edge = evt.target;
    var pos = evt.originalEvent || { clientX: 0, clientY: 0 };
    showTooltipLoading();
    tooltipVisible = true;
    positionTooltip(pos.clientX, pos.clientY);

    var relId = edge.data('relId');
    if (relId && refsCache[relId] === undefined) {
      try {
        var rows = await api('/api/references', { relationIds: [relId] });
        refsCache[relId] = rows;
      } catch(e) { refsCache[relId] = []; }
    }
    renderTooltip(edge, refsCache[relId] || []);
  });

  cy.on('mouseout', 'edge', function() {
    tooltipVisible = false;
    document.getElementById('tooltip').style.display = 'none';
  });

  // Tooltip on node hover
  cy.on('mouseover', 'node', function(evt) {
    if (document.getElementById('curation-modal').style.display !== 'none') return;
    var node = evt.target;
    var pos = evt.originalEvent || { clientX: 0, clientY: 0 };
    renderNodeTooltip(node);
    tooltipVisible = true;
    positionTooltip(pos.clientX, pos.clientY);
  });

  cy.on('mouseout', 'node', function() {
    tooltipVisible = false;
    document.getElementById('tooltip').style.display = 'none';
  });

  // Node click: highlight neighbourhood
  cy.on('tap', 'node', function(evt) {
    var node = evt.target;
    cy.elements().removeClass('faded');
    var hood = node.closedNeighborhood();
    cy.elements().not(hood).addClass('faded');
  });

  cy.on('tap', function(evt) {
    if (evt.target === cy) cy.elements().removeClass('faded');
  });

  // Save positions on node drag
  cy.on('dragfree', 'node', function() {
    currentLayout = 'manual';
  });

  // Right-click on node
  cy.on('cxttap', 'node', function(evt) {
    var node = evt.target;
    var pos = evt.originalEvent || { clientX: 0, clientY: 0 };
    var id = node.id();
    var elementId = node.data('elementId') || id;
    var name = node.data('Name') || node.data('name') || node.data('label') || id;
    var SKIP = { id:1, elementId:1, label:1, color:1, nodeType:1, source:1, target:1 };
    var props = {};
    Object.keys(node.data()).forEach(function(k) {
      if (SKIP[k]) return;
      var v = node.data(k);
      if (v != null && v !== '') props[k] = v;
    });
    showContextMenu(pos.clientX, pos.clientY, 'node', id, elementId, name, props, '');
  });

  // Right-click on edge
  cy.on('cxttap', 'edge', function(evt) {
    var edge = evt.target;
    var pos = evt.originalEvent || { clientX: 0, clientY: 0 };
    var id = edge.id();
    var elementId = edge.data('elementId') || id;
    var relType = edge.data('relType') || '';
    var relId = edge.data('relId') || '';
    var srcLabel = cy.$id(edge.data('source')).data('label') || edge.data('source');
    var tgtLabel = cy.$id(edge.data('target')).data('label') || edge.data('target');
    var name = relType + ': ' + srcLabel + ' → ' + tgtLabel;
    var edgeRaw = graphData.edges.find(function(e) { return e.id === id; });
    var props = edgeRaw ? edgeRaw.properties : {};
    showContextMenu(pos.clientX, pos.clientY, 'edge', id, elementId, name, props, relId);
  });

  // Prevent browser default context menu over cy canvas
  document.getElementById('cy').addEventListener('contextmenu', function(e) { e.preventDefault(); });

  // Hide context menu on any outside click
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('context-menu');
    if (menu.style.display !== 'none' && !menu.contains(e.target)) hideContextMenu();
  });
}

function getCyStyle() {
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        'label': 'data(label)',
        'color': '#fff',
        'text-outline-color': 'data(color)',
        'text-outline-width': '2px',
        'font-size': '11px',
        'width': 44,
        'height': 44,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '60px',
        'border-width': 0
      }
    },
    {
      selector: 'node:selected',
      style: { 'border-width': 3, 'border-color': '#FFD700', 'border-opacity': 1 }
    },
    {
      selector: 'node.faded',
      style: { 'opacity': 0.2 }
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': 'data(color)',
        'line-color': 'data(color)',
        'width': 'data(thickness)',
        'line-style': 'data(lineStyle)',
        'label': 'data(relType)',
        'font-size': '9px',
        'text-rotation': 'autorotate',
        'color': '#ccc',
        'text-background-color': '#0f1117',
        'text-background-opacity': 0.75,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle',
        'opacity': 0.85
      }
    },
    {
      selector: 'edge:selected',
      style: { 'opacity': 1, 'width': function(ele) { return ele.data('thickness') + 1; } }
    },
    {
      selector: 'edge.faded',
      style: { 'opacity': 0.08 }
    }
  ];
}

// ─── Graph rendering ──────────────────────────────────────────────────────────
function getTypeColor(type) {
  if (!typeColorMap[type]) {
    typeColorMap[type] = COLOR_PALETTE[colorIdx % COLOR_PALETTE.length];
    colorIdx++;
  }
  return typeColorMap[type];
}

function getNodeLabel(node) {
  var p = node.properties || {};
  return p.name || p.Name || p.id || p.ID || (node.labels && node.labels[0]) || '?';
}

function getNodeColor(labels) {
  for (var i = 0; i < (labels || []).length; i++) {
    if (NODE_COLORS[labels[i]]) return NODE_COLORS[labels[i]];
  }
  return DEFAULT_NODE_COLOR;
}

function getEdgeThickness(numRefs) {
  var n = Math.min(Number(numRefs) || 0, 3);
  return 1 + (n / 3) * 3;
}

function renderGraph(data, savedPositions) {
  graphData = data;
  refsCache = {};
  typeColorMap = {};
  colorIdx = 0;

  var cyNodes = data.nodes.map(function(n) {
    var d = {
      id: n.id,
      elementId: n.elementId || n.id,
      label: getNodeLabel(n),
      color: getNodeColor(n.labels),
      nodeType: (n.labels && n.labels[0]) || 'Unknown'
    };
    Object.assign(d, n.properties);
    return {
      group: 'nodes',
      data: d,
      position: savedPositions ? savedPositions[n.id] : undefined
    };
  });

  var cyEdges = data.edges.map(function(e) {
    var numRefs = e.properties.RelationNumberOfReferences;
    return {
      group: 'edges',
      data: {
        id: e.id,
        elementId: e.elementId || e.id,
        source: e.startNodeId,
        target: e.endNodeId,
        relType: e.type,
        relId: e.properties.RelationID != null ? String(e.properties.RelationID) : '',
        numRefs: numRefs,
        effect: e.properties.Effect || e.properties.effect || '',
        mechanism: e.properties.Mechanism || e.properties.mechanism || '',
        confidence: e.properties['Confidence (%)'] != null ? e.properties['Confidence (%)'] : '',
        citationScore: e.properties['Citation score'] != null ? e.properties['Citation score'] : '',
        color: getTypeColor(e.type),
        thickness: getEdgeThickness(numRefs),
        lineStyle: DIRECT_TYPES.has(e.type) ? 'solid' : 'dashed'
      }
    };
  });

  cy.elements().remove();
  cy.add(cyNodes.concat(cyEdges));

  document.getElementById('graph-empty-state').style.display =
    (cyNodes.length === 0 && cyEdges.length === 0) ? 'flex' : 'none';

  updateLegend();
  updateStats();

  if (savedPositions) {
    cy.layout({ name: 'preset' }).run();
  } else {
    applyLayout(currentLayout);
  }
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function applyLayout(name, btn) {
  if (!cy || !cy.nodes().length) return;
  currentLayout = name;

  if (btn) {
    document.querySelectorAll('[data-layout]').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
  }

  var layoutConfigs = {
    cose:      { name: 'cose',      animate: false, numIter: 100, nodeRepulsion: 4500, idealEdgeLength: 100, fit: true, padding: 40 },
    dagre:     { name: 'dagre',     rankDir: 'TB', nodeSep: 60, rankSep: 80, animate: false, fit: true, padding: 40 },
    circle:    { name: 'circle',    animate: false, fit: true, padding: 40 },
    concentric:{ name: 'concentric',animate: false, fit: true, padding: 40, minNodeSpacing: 40 },
    grid:      { name: 'grid',      animate: false, fit: true, padding: 40, avoidOverlap: true }
  };

  var config = layoutConfigs[name] || layoutConfigs.cose;
  try {
    cy.layout(config).run();
  } catch(err) {
    cy.layout(layoutConfigs.cose).run();
  }
}

// ─── Run query ────────────────────────────────────────────────────────────────
async function runQuery() {
  var query = document.getElementById('cypher-input').value.trim();
  if (!query) return;
  currentQuery = query;

  document.getElementById('graph-loading').style.display = 'flex';
  document.getElementById('graph-empty-state').style.display = 'none';
  document.getElementById('run-btn').disabled = true;

  try {
    var data = await api('/api/graph/query', { query: query });
    renderGraph(data);
    if (document.getElementById('table-view').style.display !== 'none') {
      await loadTableData();
    }
  } catch(err) {
    alert('Query error: ' + err.message);
  } finally {
    document.getElementById('graph-loading').style.display = 'none';
    document.getElementById('run-btn').disabled = false;
  }
}

function handleQueryKeydown(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runQuery();
  }
}

function clearGraph() {
  if (cy) cy.elements().remove();
  graphData = { nodes: [], edges: [] };
  tableRows = [];
  document.getElementById('table-body').innerHTML = '';
  document.getElementById('graph-empty-state').style.display = 'flex';
  document.getElementById('graph-stats').textContent = '';
  document.getElementById('legend-items').innerHTML = '';
}

// ─── Stats & Legend ───────────────────────────────────────────────────────────
function updateStats() {
  var n = cy.nodes().length;
  var e = cy.edges().length;
  document.getElementById('graph-stats').textContent =
    n + ' node' + (n !== 1 ? 's' : '') + ' · ' + e + ' relation' + (e !== 1 ? 's' : '');
}

function updateLegend() {
  var container = document.getElementById('legend-items');
  container.innerHTML = '';
  Object.keys(typeColorMap).forEach(function(type) {
    var color = typeColorMap[type];
    var isDirect = DIRECT_TYPES.has(type);
    var div = document.createElement('div');
    div.className = 'legend-item';
    div.innerHTML = '<span class="legend-color-dot" style="background:' + color + '"></span>'
      + '<span title="' + (isDirect ? 'Direct' : 'Indirect') + '">' + type + '</span>';
    container.appendChild(div);
  });
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function showTooltipLoading() {
  var el = document.getElementById('tooltip');
  el.innerHTML = '<div class="tooltip-loading">Loading references…</div>';
  el.style.display = 'block';
}

function renderTooltip(edge, refs) {
  var el = document.getElementById('tooltip');
  var src = edge.data('source');
  var tgt = edge.data('target');
  var srcLabel = cy.$id(src).data('label') || src;
  var tgtLabel = cy.$id(tgt).data('label') || tgt;
  var relType = edge.data('relType');
  var effect = edge.data('effect');
  var mechanism = edge.data('mechanism');
  var numRefs = edge.data('numRefs');
  var confidence = edge.data('confidence');
  var citationScore = edge.data('citationScore');

  var html = '<div class="tooltip-rel-header">' + relType;
  var parts = [];
  if (effect && String(effect).trim()) parts.push(String(effect).trim());
  if (mechanism && String(mechanism).trim()) parts.push(String(mechanism).trim());
  if (parts.length) html += ' <span style="color:#7a8099;font-weight:400;font-size:11px">(' + escHtml(parts.join(' · ')) + ')</span>';
  html += '</div>';
  html += '<div style="font-size:11px;color:#7a8099;margin-bottom:6px">' + escHtml(srcLabel) + ' → ' + escHtml(tgtLabel) + '</div>';

  var metaLine = (numRefs || 0) + ' reference(s)';
  if (confidence !== '' && confidence != null) metaLine += ' · Confidence: ' + confidence + '%';
  if (citationScore !== '' && citationScore != null) metaLine += ' · Citation score: ' + citationScore;
  html += '<div style="font-size:11px;color:#7a8099;margin-bottom:8px">' + metaLine + '</div>';

  var display = refs.slice(0, 3);
  if (display.length === 0) {
    html += '<div class="tooltip-no-data">No references in database</div>';
  } else {
    display.forEach(function(ref, i) {
      if (i > 0) html += '<hr class="tooltip-divider">';
      var year = getRefYear(ref);
      var journal = ref.journal || ref.journalname || ref.journaltitle || ref.source || '';
      var sentence = ref.msrc || '';
      html += '<div class="tooltip-ref">';
      html += '<div class="tooltip-meta">' + year + (journal ? ' · ' + escHtml(journal) : '') + '</div>';
      if (sentence) html += '<div class="tooltip-sentence">' + escHtml(sentence) + '</div>';
      html += '</div>';
    });
    if (refs.length > 3) {
      html += '<div style="font-size:11px;color:#7a8099;margin-top:6px">+' + (refs.length - 3) + ' more reference(s)</div>';
    }
  }

  el.innerHTML = html;
  el.style.display = 'block';
}

function renderNodeTooltip(node) {
  var el = document.getElementById('tooltip');
  var name = node.data('Name') || node.data('name') || node.data('label') || '';
  var description = node.data('Description') || node.data('description') || '';
  var urn = node.data('URN') || node.data('urn') || '';
  var nodeType = node.data('nodeType') || '';

  var html = '<div class="tooltip-rel-header">' + escHtml(name);
  if (nodeType) html += ' <span style="color:#7a8099;font-weight:400;font-size:11px">(' + escHtml(nodeType) + ')</span>';
  html += '</div>';
  if (description) html += '<div style="font-size:12px;color:#c8cde8;margin-top:6px;line-height:1.5">' + escHtml(description) + '</div>';
  if (urn) html += '<div style="font-size:11px;color:#7a8099;margin-top:6px">URN: ' + escHtml(urn) + '</div>';

  el.innerHTML = html;
  el.style.display = 'block';
}

function positionTooltip(x, y) {
  var el = document.getElementById('tooltip');
  var W = window.innerWidth, H = window.innerHeight;
  var left = x + 16, top = y - 12;
  var rect = el.getBoundingClientRect();
  if (left + rect.width > W - 8) left = x - rect.width - 16;
  if (top + rect.height > H - 8) top = H - rect.height - 8;
  if (top < 8) top = 8;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function getRefYear(ref) {
  return ref.pubyear || ref.year ||
    (ref.publicationdate ? String(ref.publicationdate).slice(0, 4) : '');
}

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── View toggle ──────────────────────────────────────────────────────────────
async function switchView(view) {
  document.getElementById('view-graph-btn').classList.toggle('active', view === 'graph');
  document.getElementById('view-table-btn').classList.toggle('active', view === 'table');
  document.getElementById('graph-view').style.display = view === 'graph' ? 'flex' : 'none';
  document.getElementById('table-view').style.display = view === 'table' ? 'flex' : 'none';

  if (view === 'table' && graphData.edges.length > 0) {
    await loadTableData();
  }
}

// ─── Table ────────────────────────────────────────────────────────────────────
async function loadTableData() {
  var relIds = graphData.edges
    .map(function(e) { return e.properties.RelationID; })
    .filter(function(id) { return id != null; })
    .map(function(id) { return String(id); });

  var msg = document.getElementById('table-loading-msg');
  msg.style.display = 'inline';

  var refsGrouped = {};
  if (relIds.length > 0) {
    try {
      refsGrouped = await api('/api/references/batch', { relationIds: relIds });
    } catch(err) {
      console.error('Batch references failed:', err.message);
    }
  }
  msg.style.display = 'none';

  var nodeById = {};
  graphData.nodes.forEach(function(n) { nodeById[n.id] = n; });

  tableRows = [];
  graphData.edges.forEach(function(edge) {
    var srcNode = nodeById[edge.startNodeId];
    var tgtNode = nodeById[edge.endNodeId];
    var relId = edge.properties.RelationID != null ? String(edge.properties.RelationID) : '';
    var refs = relId ? (refsGrouped[relId] || []) : [];

    var base = {
      edgeId: edge.id,
      elementId: edge.elementId || edge.id,
      relId: relId,
      regulator: getNodeLabel(srcNode || {}),
      regulatorType: (srcNode && srcNode.labels && srcNode.labels[0]) || '',
      target: getNodeLabel(tgtNode || {}),
      targetType: (tgtNode && tgtNode.labels && tgtNode.labels[0]) || '',
      relationType: edge.type,
      effect: edge.properties.Effect || edge.properties.effect || '',
      numRefs: edge.properties.RelationNumberOfReferences || 0
    };

    if (refs.length === 0) {
      tableRows.push(Object.assign({}, base, { pmid: '', doi: '', year: '', title: '', sentence: '' }));
    } else {
      refs.forEach(function(ref) {
        tableRows.push(Object.assign({}, base, {
          pmid: ref.pmid || '',
          doi: ref.doi || '',
          year: getRefYear(ref),
          title: ref.title || '',
          sentence: ref.msrc || ''
        }));
      });
    }
  });

  renderTableRows(tableRows);
}

function renderTableRows(rows) {
  var tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  rows.forEach(function(row) {
    var tr = document.createElement('tr');
    if (row.edgeId) {
      tr.dataset.edgeId = row.edgeId;
      tr.title = 'Right-click to edit properties';
      tr.style.cursor = 'context-menu';
      tr.addEventListener('contextmenu', function(evt) {
        evt.preventDefault();
        var edge = graphData.edges.find(function(e) { return e.id === row.edgeId; });
        var props = edge ? edge.properties : {};
        var name = row.relationType + ': ' + row.regulator + ' → ' + row.target;
        showContextMenu(evt.clientX, evt.clientY, 'edge', row.edgeId, row.elementId, name, props, row.relId);
      });
    }
    var pmidCell = row.pmid
      ? '<a href="https://pubmed.ncbi.nlm.nih.gov/' + row.pmid + '" target="_blank" style="color:#4f8ef7">' + row.pmid + '</a>'
      : '';
    var doiCell = row.doi
      ? '<a href="https://doi.org/' + row.doi + '" target="_blank" style="color:#4f8ef7">' + escHtml(row.doi) + '</a>'
      : '';
    var cells = [
      escHtml(row.regulator), escHtml(row.regulatorType),
      escHtml(row.target),    escHtml(row.targetType),
      escHtml(row.relationType), escHtml(row.effect),
      escHtml(String(row.numRefs)),
      pmidCell, doiCell,
      escHtml(String(row.year || '')),
      escHtml(row.title),
      escHtml(row.sentence)
    ];
    tr.innerHTML = cells.map(function(v, i) {
      var cls = i === 11 ? ' class="sentence-cell"' : '';
      var raw = typeof v === 'string' ? v : '';
      return '<td' + cls + ' title="' + raw.replace(/"/g, '&quot;') + '">' + v + '</td>';
    }).join('');
    tbody.appendChild(tr);
  });
}

function filterTable(q) {
  if (!q) { renderTableRows(tableRows); return; }
  var lower = q.toLowerCase();
  var filtered = tableRows.filter(function(row) {
    return Object.values(row).some(function(v) { return v && String(v).toLowerCase().includes(lower); });
  });
  renderTableRows(filtered);
}

function sortTable(col) {
  if (tableSortCol === col) {
    tableSortAsc = !tableSortAsc;
  } else {
    tableSortCol = col;
    tableSortAsc = true;
  }
  var sorted = tableRows.slice().sort(function(a, b) {
    var av = String(a[col] || '').toLowerCase();
    var bv = String(b[col] || '').toLowerCase();
    return tableSortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
  });
  renderTableRows(sorted);
}

function exportTableCSV() {
  var cols = ['regulator','regulatorType','target','targetType',
    'relationType','effect','numRefs','pmid','doi','year','title','sentence'];
  var header = ['Regulator','Regulator Type','Target','Target Type',
    'Relation Type','Effect','RelationNumberOfReferences','PMID','DOI','Year','Title','Sentence'];

  var esc = function(v) { return '"' + String(v || '').replace(/"/g, '""') + '"'; };
  var lines = [header.map(esc).join(',')];
  tableRows.forEach(function(row) { lines.push(cols.map(function(c) { return esc(row[c]); }).join(',')); });

  var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'graph-data.csv'; a.click();
  URL.revokeObjectURL(url);
}

// ─── Save / Load subgraph ─────────────────────────────────────────────────────
function promptSaveSubgraph() {
  if (!cy || !cy.nodes().length) { alert('No graph to save.'); return; }
  document.getElementById('save-name-input').value = '';
  document.getElementById('save-modal').style.display = 'flex';
  setTimeout(function() { document.getElementById('save-name-input').focus(); }, 100);
}

function closeSaveModal(e) {
  if (e.target === document.getElementById('save-modal'))
    document.getElementById('save-modal').style.display = 'none';
}

function confirmSave() {
  var name = document.getElementById('save-name-input').value.trim();
  if (!name) { alert('Please enter a name.'); return; }
  document.getElementById('save-modal').style.display = 'none';

  var positions = {};
  cy.nodes().forEach(function(n) { positions[n.id()] = { x: n.position('x'), y: n.position('y') }; });

  var saveData = {
    name: name,
    query: currentQuery,
    savedAt: new Date().toISOString(),
    layout: currentLayout,
    positions: positions,
    graphData: graphData
  };

  var blob = new Blob([JSON.stringify(saveData, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[^a-z0-9_\-]/gi, '_') + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function loadSubgraph(event) {
  var file = event.target.files[0];
  if (!file) return;
  event.target.value = '';

  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!data.graphData) throw new Error('Invalid file format');

      if (data.query) {
        document.getElementById('cypher-input').value = data.query;
        currentQuery = data.query;
      }

      if (data.layout) {
        var btn = document.querySelector('[data-layout="' + data.layout + '"]');
        document.querySelectorAll('[data-layout]').forEach(function(b) { b.classList.remove('active'); });
        if (btn) btn.classList.add('active');
      }

      renderGraph(data.graphData, data.positions || null);

      if (data.positions) {
        cy.nodes().forEach(function(n) {
          var pos = data.positions[n.id()];
          if (pos) n.position(pos);
        });
        cy.fit(cy.elements(), 40);
      }
    } catch(err) {
      alert('Failed to load subgraph: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ─── Change password ──────────────────────────────────────────────────────────
function openChangePassword() {
  document.getElementById('cp-current').value = '';
  document.getElementById('cp-new').value = '';
  document.getElementById('cp-confirm').value = '';
  document.getElementById('change-pw-error').style.display = 'none';
  document.getElementById('change-pw-success').style.display = 'none';
  document.getElementById('change-pw-modal').style.display = 'flex';
}

function closeChangePwModal(e) {
  if (e.target === document.getElementById('change-pw-modal'))
    document.getElementById('change-pw-modal').style.display = 'none';
}

async function submitChangePassword() {
  var errEl = document.getElementById('change-pw-error');
  var okEl = document.getElementById('change-pw-success');
  errEl.style.display = 'none'; okEl.style.display = 'none';

  var cur  = document.getElementById('cp-current').value;
  var nw   = document.getElementById('cp-new').value;
  var conf = document.getElementById('cp-confirm').value;

  if (!cur || !nw || !conf) { errEl.textContent = 'All fields required.'; errEl.style.display = 'block'; return; }
  if (nw !== conf) { errEl.textContent = 'New passwords do not match.'; errEl.style.display = 'block'; return; }
  if (nw.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display = 'block'; return; }

  try {
    await api('/api/auth/change-password', { currentPassword: cur, newPassword: nw });
    okEl.textContent = 'Password changed successfully!';
    okEl.style.display = 'block';
    setTimeout(function() { document.getElementById('change-pw-modal').style.display = 'none'; }, 1500);
  } catch(err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

// ─── User management (admin) ──────────────────────────────────────────────────
async function openUserManagement() {
  document.getElementById('users-modal').style.display = 'flex';
  await refreshUserList();
}

function closeUsersModal(e) {
  if (e.target === document.getElementById('users-modal'))
    document.getElementById('users-modal').style.display = 'none';
}

async function refreshUserList() {
  try {
    var list = await api('/api/auth/users', null, true);
    var container = document.getElementById('users-list-container');
    container.innerHTML = list.map(function(u) {
      return '<div class="user-row">'
        + '<span class="user-row-name">' + escHtml(u.username) + '</span>'
        + '<span class="user-row-role">' + u.role + '</span>'
        + (u.username !== 'admin'
          ? '<button class="btn-sm-danger" onclick="deleteUser(\'' + escHtml(u.username) + '\')">Remove</button>'
          : '')
        + '</div>';
    }).join('');
  } catch(err) {
    document.getElementById('users-list-container').innerHTML =
      '<p style="color:#e05560;font-size:12px">' + escHtml(err.message) + '</p>';
  }
}

async function addUser() {
  var errEl = document.getElementById('add-user-error');
  errEl.style.display = 'none';
  var username = document.getElementById('new-user-name').value.trim();
  var password = document.getElementById('new-user-pass').value;
  var role = document.getElementById('new-user-role').value;

  if (!username || !password) {
    errEl.textContent = 'Username and password required.'; errEl.style.display = 'block'; return;
  }
  try {
    await api('/api/auth/users', { username: username, password: password, role: role });
    document.getElementById('new-user-name').value = '';
    document.getElementById('new-user-pass').value = '';
    await refreshUserList();
  } catch(err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
  }
}

async function deleteUser(username) {
  if (!confirm('Delete user "' + username + '"?')) return;
  try {
    await apiDelete('/api/auth/users/' + encodeURIComponent(username));
    await refreshUserList();
  } catch(err) {
    alert('Error: ' + err.message);
  }
}

// ─── Curation: context menu ───────────────────────────────────────────────────
function showContextMenu(x, y, type, id, elementId, displayName, properties, relId) {
  contextTarget = { type: type, id: id, elementId: elementId, displayName: displayName, properties: properties, relId: relId || '' };
  var menu = document.getElementById('context-menu');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.display = 'block';
  var rect = menu.getBoundingClientRect();
  var W = window.innerWidth, H = window.innerHeight;
  if (rect.right > W - 4) menu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > H - 4) menu.style.top = (y - rect.height) + 'px';
}

function hideContextMenu() {
  document.getElementById('context-menu').style.display = 'none';
}

function openCurationFromContext() {
  hideContextMenu();
  if (!contextTarget) return;
  openCurationModal(contextTarget.type, contextTarget.id, contextTarget.elementId,
    contextTarget.displayName, contextTarget.properties, contextTarget.relId);
}

// ─── Curation: modal ──────────────────────────────────────────────────────────
async function openCurationModal(type, id, elementId, displayName, properties, relId) {
  // Hide tooltip immediately so it does not overlap the modal
  tooltipVisible = false;
  document.getElementById('tooltip').style.display = 'none';

  curationTarget = { type: type, id: id, elementId: elementId, displayName: displayName,
    properties: Object.assign({}, properties), relId: relId || '', pgRefs: [] };

  document.getElementById('curation-title').textContent =
    (type === 'node' ? 'Edit Node: ' : 'Edit Relation: ') + displayName;
  document.getElementById('curation-status').textContent = '';
  document.getElementById('curation-modal').style.display = 'flex';

  var container = document.getElementById('curation-props-container');
  container.innerHTML = '<div class="prop-section-title">Neo4j Properties</div>' + renderCurationPropsHTML(properties);

  // For edges: load PostgreSQL references section
  if (type === 'edge' && relId) {
    var pgSection = document.createElement('div');
    pgSection.id = 'pg-refs-section';
    pgSection.innerHTML = '<div class="prop-section-title">PostgreSQL References</div>'
      + '<div style="color:#7a8099;font-size:12px">Loading...</div>';
    container.appendChild(pgSection);

    var refs = refsCache[relId];
    if (!refs) {
      try { refs = await api('/api/references', { relationIds: [relId] }); refsCache[relId] = refs; }
      catch(e) { refs = []; }
    }
    curationTarget.pgRefs = refs;

    if (refs.length === 0) {
      pgSection.innerHTML = '<div class="prop-section-title">PostgreSQL References</div>'
        + '<div style="color:#7a8099;font-size:12px">No references found for this relation.</div>';
    } else {
      var pgHtml = '<div class="prop-section-title">PostgreSQL References (' + refs.length + ')</div>';
      refs.forEach(function(ref, idx) {
        var rid = String(ref.id);
        pgHtml += '<div class="pg-ref-block" data-ref-idx="' + idx + '" data-ref-id="' + escHtml(rid) + '">';
        pgHtml += '<div class="pg-ref-id">Reference ID: ' + escHtml(rid) + '</div>';
        [
          ['pmid',    'PMID',    String(ref.pmid    || '')],
          ['doi',     'DOI',     String(ref.doi     || '')],
          ['pubyear', 'Year',    String(ref.pubyear || '')],
          ['title',   'Title',   String(ref.title   || '')],
          ['msrc',    'Sentence',String(ref.msrc    || '')],
          ['journal', 'Journal', String(ref.journal || ref.journalname || '')]
        ].forEach(function(row) {
          pgHtml += '<div class="pg-ref-row">'
            + '<span class="pg-ref-label">' + row[1] + '</span>'
            + '<input class="pg-ref-input" data-field="' + row[0] + '" value="' + escHtml(row[2]) + '">'
            + '</div>';
        });
        pgHtml += '</div>';
      });
      pgSection.innerHTML = pgHtml;
    }
  }
}

function renderCurationPropsHTML(properties) {
  var html = '';
  Object.entries(properties).forEach(function(entry) {
    var k = entry[0], v = entry[1];
    if (v == null || v === '') return;
    html += '<div class="prop-row">'
      + '<input class="prop-key neo-prop-key" value="' + escHtml(String(k)) + '" placeholder="Property name">'
      + '<input class="prop-val neo-prop-val" value="' + escHtml(String(v)) + '" placeholder="Value">'
      + '<button class="prop-del" onclick="this.closest(\'.prop-row\').remove()" title="Remove">×</button>'
      + '</div>';
  });
  return html;
}

function addPropertyRow() {
  var container = document.getElementById('curation-props-container');
  var pgSection = document.getElementById('pg-refs-section');
  var row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = '<input class="prop-key neo-prop-key" value="" placeholder="Property name">'
    + '<input class="prop-val neo-prop-val" value="" placeholder="Value">'
    + '<button class="prop-del" onclick="this.closest(\'.prop-row\').remove()" title="Remove">×</button>';
  if (pgSection) container.insertBefore(row, pgSection);
  else container.appendChild(row);
  row.querySelector('.neo-prop-key').focus();
}

function closeCurationModal(e) {
  if (e.target === document.getElementById('curation-modal'))
    document.getElementById('curation-modal').style.display = 'none';
}

async function saveCuration() {
  if (!curationTarget) return;
  var type = curationTarget.type;
  var elementId = curationTarget.elementId;
  var relId = curationTarget.relId;
  var pgRefs = curationTarget.pgRefs;

  var statusEl = document.getElementById('curation-status');
  statusEl.style.color = '#7a8099';
  statusEl.textContent = 'Saving...';

  // Collect Neo4j properties from editable rows
  var container = document.getElementById('curation-props-container');
  var keyEls = container.querySelectorAll('.neo-prop-key');
  var valEls = container.querySelectorAll('.neo-prop-val');
  var neoProps = {};
  keyEls.forEach(function(keyEl, i) {
    var k = keyEl.value.trim();
    var v = valEls[i] ? valEls[i].value.trim() : '';
    if (k) neoProps[k] = v;
  });

  // Save to Neo4j
  var endpoint = type === 'node' ? '/api/graph/update-node' : '/api/graph/update-relation';
  try {
    await api(endpoint, { elementId: elementId, properties: neoProps });
  } catch(err) {
    statusEl.style.color = '#e05560';
    statusEl.textContent = 'Neo4j error: ' + err.message;
    return;
  }

  // Update in-memory graphData
  if (type === 'node') {
    var nd = graphData.nodes.find(function(n) { return n.id === curationTarget.id; });
    if (nd) nd.properties = Object.assign({}, nd.properties, neoProps);
    var cyNode = cy.$id(curationTarget.id);
    if (cyNode) Object.entries(neoProps).forEach(function(e) { cyNode.data(e[0], e[1]); });
  } else {
    var ed = graphData.edges.find(function(e) { return e.id === curationTarget.id; });
    if (ed) ed.properties = Object.assign({}, ed.properties, neoProps);
  }

  // Save PostgreSQL reference changes (edges only)
  if (type === 'edge' && pgRefs && pgRefs.length > 0) {
    var pgSection = document.getElementById('pg-refs-section');
    if (pgSection) {
      var blocks = pgSection.querySelectorAll('.pg-ref-block');
      var pgErrors = [];
      for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        var refId = block.dataset.refId;
        var fields = {};
        block.querySelectorAll('.pg-ref-input').forEach(function(input) {
          fields[input.dataset.field] = input.value.trim();
        });
        try {
          await api('/api/references/update', { id: refId, fields: fields });
          if (refsCache[relId]) {
            var cached = refsCache[relId].find(function(r) { return String(r.id) === refId; });
            if (cached) Object.assign(cached, fields);
          }
        } catch(err) {
          pgErrors.push('Ref ' + refId + ': ' + err.message);
        }
      }
      if (pgErrors.length) {
        statusEl.style.color = '#e05560';
        statusEl.textContent = 'Neo4j saved. PG errors: ' + pgErrors.join('; ');
        return;
      }
    }
  }

  statusEl.style.color = '#4daf4a';
  statusEl.textContent = 'Saved successfully!';
  setTimeout(function() {
    document.getElementById('curation-modal').style.display = 'none';
  }, 900);
}
