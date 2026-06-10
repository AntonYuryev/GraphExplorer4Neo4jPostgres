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
let medScanMap = {};   // Neo4j NodeID (string) → MedScan ID value
let tooltipHideTimer = null;
let tooltipShowTimer = null;  // delay before tooltip appears (500 ms)
let lastMouseX = 0, lastMouseY = 0;
let tableRows = [];                          // all table rows
let tableSortCol = null;
let tableSortAsc = true;
let currentLayout = 'cose';
let currentSubgraphName = '';   // name from loaded JSON file
let contextTarget = null;   // element targeted by right-click
let curationTarget = null;  // element open in curation modal

// ─── Table column state ───────────────────────────────────────────────────────
let columnDefs = [];         // [{key,label,visible,source,dbField}] — current order
let availableDbColumns = { reference: [], scopus_data: [] };
let dragSrcColIdx = null;    // for header drag-and-drop
let colResizing   = null;    // { thEl, startX, startWidth } while resizing a column

// ─── Constants ────────────────────────────────────────────────────────────────
const DIRECT_TYPES = new Set([
  'Binding', 'DirectRegulation', 'ProtModification', 'PromoterBinding',
  'ChemicalReaction', 'miRNAeffect'
]);

const COLOR_PALETTE = [
  '#4f8ef7','#e05560','#4daf4a','#ff7f00','#984ea3',
  '#a65628','#f781bf','#17becf','#1b9e77','#d62728',
  '#9467bd','#8c564b','#e377c2','#7f7f7f','#bcbd22',
  '#2ca02c','#ff9896','#aec7e8','#ffbb78','#98df8a'
];

const NODE_COLORS = {
  // Node types — Pathway Studio colour scheme
  Protein:          '#d32f2f',  // red
  SmallMol:         '#388e3c',  // green
  Treatment:        '#1565c0',  // blue
  Disease:          '#7b1fa2',  // violet
  CellProcess:      '#f9a825',  // yellow
  FunctionalClass:  '#e65100',  // orange
  Complex:          '#7f0000',  // dark red
  CellObject:       '#757575',  // gray
  Tissue:           '#6d4c41',  // brown
  Organ:            '#4a148c',  // dark violet
  CellType:         '#81d4fa',  // light blue
  ChemicalReaction: '#212121',  // black
  // Legacy / fallback node types
  Gene:             '#388e3c',
  Drug:             '#1565c0',
  Chemical:         '#388e3c',
  Pathway:          '#7b1fa2',
  Cell:             '#81d4fa',
  Virus:            '#d32f2f',
  Bacteria:         '#e65100',
  Reaction:         '#999999'
};

// Edge/relation type colours — Pathway Studio colour scheme
const RELATION_COLORS = {
  PromoterBinding:       '#388e3c',  // green
  Binding:               '#7b1fa2',  // violet
  CellExpression:        '#1565c0',  // blue
  Expression:            '#1565c0',  // blue
  DirectRegulation:      '#9e9e9e',  // grey
  Regulation:            '#9e9e9e',  // grey
  GeneticChange:         '#6d4c41',  // brown
  ProtModification:      '#2e7d32',  // dark green
  ClinicalTrial:         '#4a148c',  // dark violet
  QuantitativeChange:    '#1a237e',  // strong dark blue
  MolSynthesis:          '#5c85d6',  // opaque blue
  MolTransport:          '#9e9e9e',  // grey
  StateChange:           '#1b5e20',  // darker green (darker than ProtModification)
  miRNAeffect:           '#d32f2f',  // red
  Biomarker:             '#6d4c41',  // brown
  FunctionalAssociation: '#9e9e9e',  // grey
};
const DEFAULT_NODE_COLOR = '#5a6a9a';

// Human-readable overrides for reference table column names in the Columns dialog
const COL_DISPLAY_NAMES = {
  'id':        'RelationID',
  'unique_id': 'AssertionID'
};

// Hardcoded scopus_data columns and their display labels.
// Joined to reference via: reference.unique_id = scopus_data.reference_id
const SCOPUS_COLUMNS = {
  'citation_type':                      'Article type',
  'citation_count':                     'Citations',
  'fwci':                               'FWCI',
  'fwci_perc':                          'FWCI %ile',
  'citation_count_ns':                  'Non-self citations',
  'fwci_ns':                            'Non-self FWCI',
  'fwci_perc_ns':                       'Non-self FWCI %ile',
  'citescore2024':                      'CiteScore2024',
  'min_asjc_citescore_percentile_raw':  'CiteScore %ile',
  'patent_citation_count':              'Patent citations',
  'corporate':                          'Corporate',
  'num_refs':                           'References',
  'independent_ref_count':              'Independent References',
  'document_score':                     'Document score',
  'relation_score':                     'Relation score'
};

const COL_CONFIG_KEY = 'graphExplorerColumnDefs';  // localStorage key

function saveColumnConfig() {
  try { localStorage.setItem(COL_CONFIG_KEY, JSON.stringify(columnDefs)); } catch(e) {}
}

function loadColumnConfig() {
  try {
    var saved = localStorage.getItem(COL_CONFIG_KEY);
    if (saved) {
      var parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch(e) {}
  return null;
}

// Default table columns — source:'graph' columns come from Neo4j edge/node data,
// source:'reference' and source:'scopus_data' come from PostgreSQL.
// dbField is the raw DB column name; key is the property name in tableRows.
const DEFAULT_COLUMNS = [
  { key: 'regulator',     label: 'Regulator',      visible: true,  source: 'graph' },
  { key: 'regulatorType', label: 'Regulator Type', visible: true,  source: 'graph' },
  { key: 'target',        label: 'Target',         visible: true,  source: 'graph' },
  { key: 'targetType',    label: 'Target Type',    visible: true,  source: 'graph' },
  { key: 'relationType',  label: 'Relation Type',  visible: true,  source: 'graph' },
  { key: 'effect',        label: 'Effect',         visible: true,  source: 'graph' },
  { key: 'numRefs',       label: '# Refs',         visible: true,  source: 'graph',     sortKey: 'numRefs' },
  { key: 'pmid',          label: 'PMID',           visible: true,  source: 'reference', dbField: 'pmid' },
  { key: 'doi',           label: 'DOI',            visible: true,  source: 'reference', dbField: 'doi' },
  { key: 'year',          label: 'Year',           visible: true,  source: 'reference', dbField: 'pubyear' },
  { key: 'title',         label: 'Title',          visible: true,  source: 'reference', dbField: 'title' },
  { key: 'sentence',      label: 'Sentence',       visible: true,  source: 'reference', dbField: 'msrc' }
];

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', function() {
  var saved = sessionStorage.getItem('authToken');
  if (saved) {
    authToken = saved;
    currentUser = sessionStorage.getItem('currentUser');
    currentRole = sessionStorage.getItem('currentRole');
    showApp();
  }
  // Track cursor so renderTooltip can re-position after content is set.
  document.addEventListener('mousemove', function(e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    // Column resize tracking.
    if (colResizing) {
      var dx = e.clientX - colResizing.startX;
      var newW = Math.max(40, colResizing.startWidth + dx);
      colResizing.thEl.style.width = newW + 'px';
    }
  });

  document.addEventListener('mouseup', function() {
    if (colResizing) {
      colResizing = null;
      document.body.classList.remove('col-resizing');
    }
  });
  // Hovering the tooltip itself cancels the hide timer; leaving it hides it.
  var tipEl = document.getElementById('tooltip');
  // Prevent tooltip events from reaching Cytoscape (pan/zoom).
  // Use capture phase so we intercept before Cytoscape's own listeners.
  ['mousedown', 'mouseup', 'mousemove', 'click', 'wheel',
   'pointerdown', 'pointerup', 'pointermove',
   'touchstart', 'touchmove', 'touchend'].forEach(function(evtName) {
    tipEl.addEventListener(evtName, function(e) {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, { capture: true, passive: false });
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
  // Load saved column config or fall back to defaults
  columnDefs = loadColumnConfig() || DEFAULT_COLUMNS.map(function(c) { return Object.assign({}, c); });
  // Fetch available DB column lists (used by Columns dialog)
  api('/api/schema/columns', null).then(function(data) {
    availableDbColumns = { reference: data.reference || [], scopus_data: data.scopus_data || [] };
  }).catch(function() {});
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
  if (res.status === 401) {
    // Token expired or invalid — log out and return to login screen automatically.
    logout();
    throw new Error('Session expired. Please log in again.');
  }
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
  cy.on('mouseover', 'edge', function(evt) {
    if (document.getElementById('curation-modal').style.display !== 'none') return;
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    var edge = evt.target;
    var pos = evt.originalEvent || { clientX: 0, clientY: 0 };
    tooltipShowTimer = setTimeout(async function() {
      tooltipShowTimer = null;
      showTooltipLoading();
      tooltipVisible = true;
      positionTooltip(lastMouseX, lastMouseY);
      var relId = edge.data('relId');
      if (relId && refsCache[relId] === undefined) {
        try {
          var rows = await api('/api/references', { relationIds: [relId] });
          refsCache[relId] = rows;
        } catch(e) { refsCache[relId] = []; }
      }
      renderTooltip(edge, refsCache[relId] || []);
    }, 500);
  });

  cy.on('mouseout', 'edge', function() {
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
  });

  // Tooltip on node hover
  cy.on('mouseover', 'node', function(evt) {
    if (document.getElementById('curation-modal').style.display !== 'none') return;
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    var node = evt.target;
    tooltipShowTimer = setTimeout(function() {
      tooltipShowTimer = null;
      renderNodeTooltip(node);
      tooltipVisible = true;
      positionTooltip(lastMouseX, lastMouseY);
    }, 500);
  });

  cy.on('mouseout', 'node', function() {
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
  });

  // Node click: highlight neighbourhood
  cy.on('tap', 'node', function(evt) {
    var node = evt.target;
    cy.elements().removeClass('faded');
    var hood = node.closedNeighborhood();
    cy.elements().not(hood).addClass('faded');
  });

  cy.on('tap', function(evt) {
    if (evt.target === cy) {
      cy.elements().removeClass('faded');
      // Hide tooltip when clicking empty canvas area.
      tooltipVisible = false;
      if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
      if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
      document.getElementById('tooltip').style.display = 'none';
    }
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

  // Update zoom label on wheel zoom
  cy.on('zoom', updateZoomLabel);

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
    },
    // ── Reaction (hyperedge) nodes ────────────────────────────────────────
    {
      selector: 'node[NodeType="Reaction"]',
      style: {
        'shape': 'rectangle',
        'width': 12, 'height': 12,
        'background-color': '#555',
        'border-width': 1.5,
        'border-color': '#999',
        'label': '',
        'text-outline-width': 0
      }
    },
    // ── Substrate edges (no arrowhead — reactant into reaction node) ──────
    {
      selector: 'edge[relType="Substrate"]',
      style: {
        'target-arrow-shape': 'none',
        'source-arrow-shape': 'none',
        'line-color': '#888',
        'line-style': 'solid',
        'width': 1.5
      }
    },
    // ── Product edges (arrowhead at product node) ─────────────────────────
    {
      selector: 'edge[relType="Product"]',
      style: {
        'target-arrow-shape': 'triangle',
        'target-arrow-color': '#888',
        'line-color': '#888',
        'line-style': 'solid',
        'width': 1.5
      }
    },
    // ── Cofactor edges (dashed, no arrow — participates both sides) ───────
    {
      selector: 'edge[relType="Cofactor"]',
      style: {
        'target-arrow-shape': 'none',
        'source-arrow-shape': 'none',
        'line-color': '#aaa',
        'line-style': 'dashed',
        'width': 1.5
      }
    }
  ];
}

// ─── Graph rendering ──────────────────────────────────────────────────────────
function getTypeColor(type) {
  if (!typeColorMap[type]) {
    typeColorMap[type] = RELATION_COLORS[type] || COLOR_PALETTE[colorIdx % COLOR_PALETTE.length];
    if (!RELATION_COLORS[type]) colorIdx++;
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
  // Min 2px (easy to hover), max 5px for 3+ references
  var n = Math.min(Number(numRefs) || 0, 3);
  return 2 + (n / 3) * 3;
}

function renderGraph(data, savedPositions) {
  graphData = data;
  refsCache = {};
  medScanMap = {};
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
    var numRefs = e.properties.RelationNumberOfReferences != null
      ? e.properties.RelationNumberOfReferences
      : (Array.isArray(e.properties.references) ? e.properties.references.length : 0);
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
        isHyperedge: (e.type === 'Substrate' || e.type === 'Product' || e.type === 'Cofactor'),
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

// ─── Zoom controls ────────────────────────────────────────────────────────────
function updateZoomLabel() {
  var el = document.getElementById('zoom-level');
  if (el && cy) el.textContent = Math.round(cy.zoom() * 100) + '%';
}

function zoomIn() {
  if (!cy) return;
  cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  updateZoomLabel();
}

function zoomOut() {
  if (!cy) return;
  cy.zoom({ level: cy.zoom() * 0.8, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  updateZoomLabel();
}

function zoomFit() {
  if (!cy) return;
  cy.fit(cy.elements(), 40);
  updateZoomLabel();
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
  currentSubgraphName = '';
  document.getElementById('graph-stats').textContent = '';
  document.getElementById('legend-items').innerHTML = '';
}

// ─── Stats & Legend ───────────────────────────────────────────────────────────
function updateStats() {
  var n = cy.nodes().length;
  var e = cy.edges().length;
  var namePrefix = currentSubgraphName
    ? '<span style="font-weight:600;margin-right:6px">' + escHtml(currentSubgraphName) + '</span>&nbsp;·&nbsp;'
    : '';
  document.getElementById('graph-stats').innerHTML =
    namePrefix + n + ' node' + (n !== 1 ? 's' : '') + ' · ' + e + ' relation' + (e !== 1 ? 's' : '');
}

function updateLegend() {
  var container = document.getElementById('legend-items');
  container.innerHTML = '';
  var HYPEREDGE_TYPES = new Set(['Substrate','Product','Cofactor']);
  Object.keys(typeColorMap).forEach(function(type) {
    if (HYPEREDGE_TYPES.has(type)) return;
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
function hideTooltipDelayed() {
  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(function() {
    tooltipVisible = false;
    tooltipHideTimer = null;
    document.getElementById('tooltip').style.display = 'none';
  }, 800);
}

function showTooltipLoading() {
  var el = document.getElementById('tooltip');
  el.style.display = 'block';
  document.getElementById('tooltip-inner').innerHTML = '<div class="tooltip-loading">Loading references…</div>';
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

  el.style.display = 'block';
  document.getElementById('tooltip-inner').innerHTML = html;
  // Re-position now that full content is rendered and real dimensions are known.
  positionTooltip(lastMouseX, lastMouseY);
}

function renderNodeTooltip(node) {
  var el = document.getElementById('tooltip');
  var data = node.data();
  // For virtual reaction nodes use ControlType as the display name
  var isReactionNode = data.nodeType === 'Reaction' || data.NodeType === 'Reaction';
  var name = isReactionNode
    ? (data.ControlType || 'Reaction')
    : (data.Name || data.name || data.label || '');
  var description = data.Description || data.description || '';
  var urn = data.URN || data.urn || '';
  var nodeType = isReactionNode ? '' : (data.nodeType || '');

  // Keys to skip or render separately
  var HEADER_KEYS = { Name:1, name:1, label:1, Description:1, description:1,
                      URN:1, urn:1, nodeType:1, NodeType:1, ControlType:1,
                      id:1, elementId:1, color:1, source:1, target:1,
                      NumRefs:1, references:1 };

  var html = '<div class="tooltip-rel-header">' + escHtml(name);
  if (nodeType) html += ' <span style="color:#7a8099;font-weight:400;font-size:11px">(' + escHtml(nodeType) + ')</span>';
  html += '</div>';
  if (description) html += '<div style="font-size:12px;color:#c8cde8;margin-top:6px;line-height:1.5">' + escHtml(description) + '</div>';

  // Additional properties (from Neo4j enrichment or original data)
  var extras = Object.keys(data).filter(function(k) {
    return !HEADER_KEYS[k] && data[k] != null && data[k] !== '' && typeof data[k] !== 'object';
  });
  if (extras.length) {
    html += '<div style="margin-top:8px;border-top:1px solid #2a2f4a;padding-top:6px">';
    extras.forEach(function(k) {
      html += '<div style="font-size:11px;color:#c8cde8;margin-top:3px">'
        + '<span style="color:#7a8099">' + escHtml(k) + ':</span> ' + escHtml(String(data[k]))
        + '</div>';
    });
    html += '</div>';
  }

  if (urn) html += '<div style="font-size:11px;color:#7a8099;margin-top:6px;border-top:1px solid #2a2f4a;padding-top:4px">URN: ' + escHtml(urn) + '</div>';

  el.style.display = 'block';
  document.getElementById('tooltip-inner').innerHTML = html;
  positionTooltip(lastMouseX, lastMouseY);
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

// Renders a sentence with ID{medscanId=text} markups.
// Markups whose medscanId matches regulatorMedScan are colored red;
// those matching targetMedScan are colored green; others are shown as plain text.
function colorSentence(text, regulatorMedScan, targetMedScan) {
  if (!text) return '';
  var regex = /ID\{([^=}]+)=([^}]*)\}/g;
  var result = '';
  var lastIndex = 0;
  var match;
  while ((match = regex.exec(text)) !== null) {
    // Append escaped plain text before this markup
    result += escHtml(text.slice(lastIndex, match.index));
    var ids    = match[1].split(',').map(function(s) { return s.trim(); }); // one or more IDs
    var full   = match[0];   // entire ID{...} markup
    var color  = null;
    if (regulatorMedScan && ids.indexOf(String(regulatorMedScan)) !== -1) color = '#e05560';
    else if (targetMedScan && ids.indexOf(String(targetMedScan))  !== -1) color = '#4daf4a';
    if (color) {
      result += '<span style="color:' + color + ';font-weight:600">' + escHtml(full) + '</span>';
    } else {
      result += escHtml(full);
    }
    lastIndex = match.index + match[0].length;
  }
  result += escHtml(text.slice(lastIndex));
  return result;
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

  // Always hide tooltip when leaving graph view.
  tooltipVisible = false;
  document.getElementById('tooltip').style.display = 'none';

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

  // Collect any scopus_data columns that are currently active
  var scopusCols = columnDefs
    .filter(function(c) { return c.source === 'scopus_data'; })
    .map(function(c) { return c.dbField; });

  var refsGrouped = {};
  if (relIds.length > 0) {
    try {
      refsGrouped = await api('/api/references/batch', { relationIds: relIds, scopusColumns: scopusCols });
    } catch(err) {
      console.error('Batch references failed (with scopus):', err.message);
      // Scopus JOIN may have failed (e.g. table missing or type mismatch).
      // Retry without scopus columns so reference data still loads.
      if (scopusCols.length > 0) {
        try {
          refsGrouped = await api('/api/references/batch', { relationIds: relIds, scopusColumns: [] });
          console.warn('Scopus JOIN failed — showing reference columns only. Check server log for details.');
        } catch(err2) {
          console.error('Batch references also failed without scopus:', err2.message);
        }
      }
    }
  }
  msg.style.display = 'none';

  // Supplement with inline references stored in the JSON (RNEF-converted pathways).
  // These have the same field names (pmid, doi, pubyear, title, msrc) as DB rows.
  graphData.edges.forEach(function(e) {
    var relId = e.properties.RelationID != null ? String(e.properties.RelationID) : '';
    if (relId && !refsGrouped[relId] && e.properties.references && e.properties.references.length) {
      refsGrouped[relId] = e.properties.references;
    }
  });

  // Index by both current id and original URN so edges that still reference
  // the original URN local_id (before Neo4j enrichment swaps n.id) still resolve.
  var nodeById = {};
  graphData.nodes.forEach(function(n) {
    nodeById[n.id] = n;
    if (n.properties && n.properties.URN) nodeById[n.properties.URN] = n;
  });

  // Fetch MedScan IDs only if not already loaded (may have been pre-fetched
  // eagerly after Neo4j enrichment completed on pathway load).
  if (Object.keys(medScanMap).length === 0) {
    var nodeIds = graphData.nodes
      .map(function(n) { return n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null; })
      .filter(Boolean);
    if (nodeIds.length > 0) {
      msg.style.display = 'inline';
      msg.textContent = 'Loading matching data from database…';
      try {
        medScanMap = await api('/api/nodes/medscan', { nodeIds: nodeIds });
      } catch(err) {
        console.warn('MedScan lookup failed:', err.message);
        medScanMap = {};
      }
      msg.textContent = 'Loading references…';
      msg.style.display = 'none';
    }
  }

  function nodeLabel(node) {
    if (!node || !node.properties) return '?';
    return getNodeLabel(node);
  }

  function nodeMedScan(node) {
    if (!node || !node.properties) return '';
    var nid = node.properties.NodeID != null ? String(node.properties.NodeID) : null;
    return (nid && medScanMap[nid]) ? medScanMap[nid] : '';
  }

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
      regulator: nodeLabel(srcNode),
      regulatorMedScan: nodeMedScan(srcNode),
      regulatorType: (srcNode && srcNode.labels && srcNode.labels[0]) || '',
      target: nodeLabel(tgtNode),
      targetMedScan: nodeMedScan(tgtNode),
      targetType: (tgtNode && tgtNode.labels && tgtNode.labels[0]) || '',
      relationType: edge.type,
      effect: edge.properties.Effect || edge.properties.effect || '',
      numRefs: edge.properties.RelationNumberOfReferences != null
        ? edge.properties.RelationNumberOfReferences
        : (Array.isArray(edge.properties.references) ? edge.properties.references.length : 0)
    };

    var buildRow = function(ref) {
      var row = Object.assign({}, base);
      if (ref) {
        // Store ALL raw reference fields so columns added later can find values
        // without needing a DB reload (SELECT * already fetches everything).
        Object.keys(ref).forEach(function(k) {
          if (k.startsWith('sd_')) {
            row[k] = ref[k] != null ? String(ref[k]) : '';  // scopus already prefixed
          } else {
            row['_ref_' + k] = ref[k];  // raw storage, keyed by _ref_{dbFieldName}
          }
        });
        // Also map current columnDef keys for fast access in renderTableRows
        columnDefs.forEach(function(col) {
          if (col.source === 'reference') {
            if (col.key === 'year') row.year = getRefYear(ref);
            else if (col.key === 'sentence') row.sentence = ref.msrc || '';
            else row[col.key] = ref[col.dbField] != null ? String(ref[col.dbField]) : '';
          } else if (col.source === 'scopus_data') {
            row[col.key] = ref['sd_' + col.dbField] != null ? String(ref['sd_' + col.dbField]) : '';
          }
        });
      } else {
        columnDefs.forEach(function(col) {
          if (col.source === 'reference' || col.source === 'scopus_data') row[col.key] = '';
        });
      }
      return row;
    };

    if (refs.length === 0) {
      tableRows.push(buildRow(null));
    } else {
      refs.forEach(function(ref) { tableRows.push(buildRow(ref)); });
    }
  });

  renderTableHeader();
  renderTableRows(tableRows);
}

function renderTableHeader() {
  var thead = document.querySelector('#data-table thead tr');
  if (!thead) return;
  var visCols = columnDefs.filter(function(c) { return c.visible; });
  thead.innerHTML = visCols.map(function(col, i) {
    var sortAttr = col.source === 'graph' ? ' onclick="sortTable(\'' + col.key + '\')"' : '';
    var sortLabel = col.source === 'graph' ? ' <span class="col-sort-arrow">⇅</span>' : '';
    return '<th data-col-idx="' + i + '" draggable="true"' + sortAttr
      + ' ondragstart="colDragStart(event,' + i + ')"'
      + ' ondragover="colDragOver(event)"'
      + ' ondrop="colDrop(event,' + i + ')"'
      + ' ondragend="colDragEnd(event)"'
      + ' title="Drag to reorder">'
      + escHtml(col.label) + sortLabel
      + '<span class="col-resize-handle" draggable="false"'
      + ' onmousedown="colResizeStart(event,this.parentNode)"'
      + ' ondragstart="event.preventDefault();event.stopPropagation()">'
      + '</span></th>';
  }).join('');
}

function renderTableRows(rows) {
  var visCols = columnDefs.filter(function(c) { return c.visible; });
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
    var cells = visCols.map(function(col) {
      var val = row[col.key];
      // If this is a reference column added after the last loadTableData call,
      // row[col.key] won't exist yet — fall back to raw _ref_* storage.
      if (val === undefined && col.source === 'reference') {
        if (col.key === 'year') val = row['_ref_pubyear'] != null ? String(row['_ref_pubyear']) : '';
        else if (col.key === 'sentence') val = row['_ref_msrc'] || '';
        else val = row['_ref_' + col.dbField] != null ? String(row['_ref_' + col.dbField]) : '';
      }
      if (col.key === 'sentence') {
        return colorSentence(val != null ? String(val) : '', row.regulatorMedScan, row.targetMedScan);
      }
      if (col.key === 'regulator' && row.regulatorMedScan) {
        return escHtml(val != null ? String(val) : '') + '<br><span style="color:#7a8099;font-size:11px">MedScan ID: ' + escHtml(row.regulatorMedScan) + '</span>';
      }
      if (col.key === 'target' && row.targetMedScan) {
        return escHtml(val != null ? String(val) : '') + '<br><span style="color:#7a8099;font-size:11px">MedScan ID: ' + escHtml(row.targetMedScan) + '</span>';
      }
      if (col.key === 'pmid' && val) {
        return '<a href="https://pubmed.ncbi.nlm.nih.gov/' + escHtml(String(val)) + '" target="_blank" style="color:#4f8ef7">' + escHtml(String(val)) + '</a>';
      }
      if (col.key === 'doi' && val) {
        return '<a href="https://doi.org/' + escHtml(String(val)) + '" target="_blank" style="color:#4f8ef7">' + escHtml(String(val)) + '</a>';
      }
      return escHtml(val != null ? String(val) : '');
    });
    tr.innerHTML = cells.map(function(v, i) {
      var col = visCols[i];
      var isSentence = col.key === 'sentence' || (col.source === 'scopus_data');
      var cls = isSentence ? ' class="sentence-cell"' : '';
      var raw = typeof v === 'string' ? v : '';
      return '<td' + cls + ' title="' + raw.replace(/"/g, '&quot;') + '">' + v + '</td>';
    }).join('');
    // Clicking any table row dismisses a leftover graph tooltip.
    tr.addEventListener('click', function() {
      tooltipVisible = false;
      document.getElementById('tooltip').style.display = 'none';
    });
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
  var visCols = columnDefs.filter(function(c) { return c.visible; });
  var esc = function(v) { return '"' + String(v || '').replace(/"/g, '""') + '"'; };
  var lines = [visCols.map(function(c) { return esc(c.label); }).join(',')];
  tableRows.forEach(function(row) {
    lines.push(visCols.map(function(c) { return esc(row[c.key]); }).join(','));
  });
  var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'graph-data.csv'; a.click();
  URL.revokeObjectURL(url);
}

// ─── Export Excel ─────────────────────────────────────────────────────────────
// Builds an ExcelJS richText array from a sentence with ID{ids=text} markup.
// Regulator markup → red; target markup → green; plain text → default.
function buildSentenceRichText(text, regulatorMedScan, targetMedScan) {
  var plain = function(t) { return { text: t, font: { name: 'Arial', size: 10 } }; };
  if (!text) return { richText: [plain('')] };
  var regex = /ID\{([^=}]+)=([^}]*)\}/g;
  var richText = [];
  var lastIndex = 0;
  var match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) richText.push(plain(text.slice(lastIndex, match.index)));
    var ids   = match[1].split(',').map(function(s) { return s.trim(); });
    var full  = match[0];
    var color = null;
    if (regulatorMedScan && ids.indexOf(String(regulatorMedScan)) !== -1) color = 'FFE05560';
    else if (targetMedScan && ids.indexOf(String(targetMedScan))   !== -1) color = 'FF4DAF4A';
    if (color) {
      richText.push({ text: full, font: { name: 'Arial', size: 10, bold: true, color: { argb: color } } });
    } else {
      richText.push(plain(full));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) richText.push(plain(text.slice(lastIndex)));
  if (!richText.length) richText.push(plain(''));
  return { richText: richText };
}

function exportTableExcel() {
  if (typeof ExcelJS === 'undefined') {
    alert('ExcelJS library not loaded. Please check your internet connection.');
    return;
  }
  var visCols = columnDefs.filter(function(c) { return c.visible; });
  var wb      = new ExcelJS.Workbook();
  var sheet   = wb.addWorksheet('Graph Data');

  // Column widths by key
  var colWidths = {
    regulator: 22, regulatorType: 16, target: 22, targetType: 16,
    relationType: 18, effect: 12, numRefs: 8, pmid: 14, doi: 32,
    year: 8, title: 40, sentence: 60
  };

  sheet.columns = visCols.map(function(col) {
    return { key: col.key, width: colWidths[col.key] || 20 };
  });

  // Header row
  var headerRow = sheet.getRow(1);
  visCols.forEach(function(col, ci) {
    var cell = headerRow.getCell(ci + 1);
    cell.value = col.label;
    cell.font  = { name: 'Arial', size: 10, bold: true };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF0' } };
    cell.alignment = { vertical: 'middle', wrapText: false };
  });
  headerRow.commit();

  // Data rows
  tableRows.forEach(function(row) {
    var exRow = sheet.addRow({});
    visCols.forEach(function(col, ci) {
      var cell   = exRow.getCell(ci + 1);
      var val    = row[col.key];
      var valStr = val != null ? String(val) : '';

      cell.alignment = { vertical: 'top', wrapText: false };

      if (col.key === 'pmid' && valStr) {
        cell.value = { text: valStr, hyperlink: 'https://pubmed.ncbi.nlm.nih.gov/' + valStr };
        cell.font  = { name: 'Arial', size: 10, color: { argb: 'FF4F8EF7' }, underline: true };
      } else if (col.key === 'doi' && valStr) {
        cell.value = { text: valStr, hyperlink: 'https://doi.org/' + valStr };
        cell.font  = { name: 'Arial', size: 10, color: { argb: 'FF4F8EF7' }, underline: true };
      } else if (col.key === 'regulator' && row.regulatorMedScan) {
        cell.value = { richText: [
          { text: valStr,                                       font: { name: 'Arial', size: 10 } },
          { text: '\nMedScan ID: ' + row.regulatorMedScan,     font: { name: 'Arial', size: 9, color: { argb: 'FF7A8099' } } }
        ]};
        cell.alignment = { vertical: 'top', wrapText: true };
      } else if (col.key === 'target' && row.targetMedScan) {
        cell.value = { richText: [
          { text: valStr,                                     font: { name: 'Arial', size: 10 } },
          { text: '\nMedScan ID: ' + row.targetMedScan,      font: { name: 'Arial', size: 9, color: { argb: 'FF7A8099' } } }
        ]};
        cell.alignment = { vertical: 'top', wrapText: true };
      } else if (col.key === 'sentence') {
        cell.value     = buildSentenceRichText(valStr, row.regulatorMedScan, row.targetMedScan);
        cell.alignment = { vertical: 'top', wrapText: true };
      } else {
        cell.value = valStr;
        cell.font  = { name: 'Arial', size: 10 };
      }
    });
    exRow.commit();
  });

  // Download
  wb.xlsx.writeBuffer().then(function(buffer) {
    var blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = 'graph-data.xlsx'; a.click();
    URL.revokeObjectURL(url);
  }).catch(function(err) {
    alert('Excel export failed: ' + err.message);
  });
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

  // Handle RNEF files — send to server for conversion, then open result
  if (file.name.toLowerCase().endsWith('.rnef')) {
    loadRnefFile(file);
    return;
  }

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

      currentSubgraphName = data.name || '';
      renderGraph(data.graphData, data.positions || null);

      // Pre-populate refsCache with inline references from JSON so edge
      // tooltips work without a PostgreSQL lookup.
      (data.graphData.edges || []).forEach(function(e) {
        var relId = e.properties && e.properties.RelationID != null ? String(e.properties.RelationID) : '';
        if (relId && e.properties.references && e.properties.references.length) {
          refsCache[relId] = e.properties.references;
        }
      });

      if (data.positions) {
        cy.nodes().forEach(function(n) {
          var pos = data.positions[n.id()];
          if (pos) n.position(pos);
        });
        cy.fit(cy.elements(), 40);
      }

      // Enrich nodes from Neo4j using URN property (silent — best-effort)
      var statsEl = document.getElementById('graph-stats');
      if (statsEl) {
        statsEl.innerHTML += ' <span id="enrich-status" style="color:#7a8099;font-size:11px">Loading matching data from database…</span>';
      }
      enrichNodesFromNeo4j(data.graphData.nodes || []);

    } catch(err) {
      alert('Failed to load subgraph: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ─── RNEF file loading ────────────────────────────────────────────────────────
async function loadRnefFile(file) {
  var statsEl = document.getElementById('graph-stats');
  if (statsEl) statsEl.innerHTML = '<span style="color:#7a8099;font-size:11px">Converting RNEF…</span>';

  try {
    var content = await file.text();
    // Send as raw text to bypass the global 10 MB JSON body limit on the server.
    var res = await fetch('/api/convert/rnef', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': 'Bearer ' + authToken
      },
      body: content
    });
    if (res.status === 401) { logout(); throw new Error('Session expired'); }
    var result = await res.json();
    if (!res.ok) throw new Error(result.error || ('HTTP ' + res.status));
    var pathways = result.pathways || [];

    if (pathways.length === 0) {
      alert('No pathways found in this RNEF file.');
      if (statsEl) statsEl.innerHTML = '';
      return;
    }

    if (pathways.length === 1) {
      openRnefPathway(pathways[0].data);
    } else {
      // Multiple sub-graphs — let user pick
      var list = document.getElementById('rnef-pathway-list');
      list.innerHTML = '';
      pathways.forEach(function(pw) {
        var btn = document.createElement('button');
        btn.className = 'btn-tool';
        btn.style.cssText = 'text-align:left;padding:8px 12px;width:100%;font-size:13px';
        btn.textContent = pw.name;
        btn.onclick = function() {
          document.getElementById('rnef-modal').style.display = 'none';
          openRnefPathway(pw.data);
        };
        list.appendChild(btn);
      });
      if (statsEl) statsEl.innerHTML = '';
      document.getElementById('rnef-modal').style.display = 'flex';
    }
  } catch(err) {
    if (statsEl) statsEl.innerHTML = '';
    alert('RNEF conversion failed: ' + err.message);
  }
}

function openRnefPathway(data) {
  if (!data.graphData) { alert('Invalid pathway data'); return; }
  currentSubgraphName = data.name || '';
  renderGraph(data.graphData, data.positions || null);

  // Pre-populate refsCache with inline references
  (data.graphData.edges || []).forEach(function(e) {
    var relId = e.properties && e.properties.RelationID != null ? String(e.properties.RelationID) : '';
    if (relId && e.properties.references && e.properties.references.length) {
      refsCache[relId] = e.properties.references;
    }
  });

  if (data.positions) {
    cy.nodes().forEach(function(n) {
      var pos = data.positions[n.id()];
      if (pos) n.position(pos);
    });
    cy.fit(cy.elements(), 40);
  }

  var statsEl = document.getElementById('graph-stats');
  if (statsEl) {
    statsEl.innerHTML += ' <span id="enrich-status" style="color:#7a8099;font-size:11px">Loading matching data from database…</span>';
  }
  enrichNodesFromNeo4j(data.graphData.nodes || []);
  switchView('graph');
}

function closeRnefModal(e) {
  if (e.target === document.getElementById('rnef-modal'))
    document.getElementById('rnef-modal').style.display = 'none';
}

// ─── Enrich subgraph nodes from Neo4j by URN ─────────────────────────────────
function enrichNodesFromNeo4j(jsonNodes) {
  var urns = jsonNodes
    .map(function(n) { return n.properties && n.properties.URN; })
    .filter(Boolean);
  if (!urns.length) return;

  api('/api/graph/enrich-by-urn', { urns: urns })
    .then(function(enriched) {
      var matched = 0;
      cy.nodes().forEach(function(cyNode) {
        var urn = cyNode.data('URN');
        if (!urn || !enriched[urn]) return;
        matched++;
        var neo = enriched[urn];
        // Merge all Neo4j properties (preserve URN)
        var merged = Object.assign({}, cyNode.data(), neo.properties);
        merged.URN = urn;
        // Update display label
        if (neo.properties.Name) merged.label = neo.properties.Name;
        // Update node type and color from Neo4j labels
        if (neo.labels && neo.labels.length) {
          merged.nodeType = neo.labels[0];
          merged.color = getNodeColor(neo.labels);
        }
        // Swap to Neo4j's native IDs so curation and edge queries work
        merged.elementId = neo.elementId;
        cyNode.data(merged);
        // Also update the backing graphData so table view is consistent
        var gn = graphData.nodes.find(function(n) { return n.properties && n.properties.URN === urn; });
        if (gn) {
          gn.id = neo.id;
          gn.elementId = neo.elementId;
          gn.labels = neo.labels;
          Object.assign(gn.properties, neo.properties);
        }
      });
      // Remove the "Loading matching data…" spinner regardless of match count
      var enrichSpan = document.getElementById('enrich-status');
      if (enrichSpan) enrichSpan.remove();

      if (matched > 0) {
        updateLegend();
        // Show enrichment count briefly in stats bar
        var statsEl = document.getElementById('graph-stats');
        if (statsEl) {
          var orig = statsEl.innerHTML;
          statsEl.innerHTML = orig + ' <span style="color:#4caf50;font-size:11px">(+' + matched + ' enriched from Neo4j)</span>';
          setTimeout(function() { updateStats(); }, 3000);
        }

        // Eagerly pre-fetch MedScan IDs now that NodeIDs are available,
        // so Table view is ready instantly when the user opens it.
        var nodeIds = graphData.nodes
          .map(function(n) { return n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null; })
          .filter(Boolean);
        if (nodeIds.length > 0) {
          api('/api/nodes/medscan', { nodeIds: nodeIds })
            .then(function(map) { medScanMap = map; })
            .catch(function() {});
        }

        // If Table view is already open, reload it with the enriched data.
        var tableView = document.getElementById('table-view');
        if (tableView && tableView.style.display !== 'none') {
          loadTableData();
        }
      }
    })
    .catch(function() {
      var enrichSpan = document.getElementById('enrich-status');
      if (enrichSpan) enrichSpan.remove();
    });
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
      var pgHtml = '<div class="prop-section-title">PostgreSQL References</div>';
      refs.forEach(function(ref) {
        var year = ref.pubyear ? ' (' + ref.pubyear + ')' : '';
        pgHtml += '<div class="ref-item">';
        if (ref.title) pgHtml += '<div class="ref-title">' + escHtml(ref.title) + escHtml(year) + '</div>';
        if (ref.authors) pgHtml += '<div class="ref-authors">' + escHtml(ref.authors) + '</div>';
        if (ref.pmid)  pgHtml += '<div class="ref-pmid">PMID: ' + escHtml(ref.pmid) + '</div>';
        if (ref.msrc)  pgHtml += '<div class="ref-sentence">' + colorSentence(ref.msrc, null, null) + '</div>';
        pgHtml += '</div>';
      });
      pgSection.innerHTML = pgHtml;
    }
  }
}

function closeCurationModal(e) {
  if (e.target === e.currentTarget) document.getElementById('curation-modal').style.display = 'none';
}

function addPropertyRow() {
  var container = document.getElementById('curation-props-container');
  var row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = '<input class="prop-key" type="text" placeholder="Property name">'
    + '<input class="prop-val" type="text" placeholder="Value">'
    + '<button class="prop-delete" onclick="this.closest(\'.prop-row\').remove()" title="Remove">✕</button>';
  var pgSection = document.getElementById('pg-refs-section');
  if (pgSection) container.insertBefore(row, pgSection);
  else container.appendChild(row);
  row.querySelector('.prop-key').focus();
}

function renderCurationPropsHTML(props) {
  var html = '';
  Object.keys(props || {}).forEach(function(key) {
    var val = props[key] != null ? String(props[key]) : '';
    html += '<div class="prop-row" data-key="' + escHtml(key) + '">'
      + '<input class="prop-key" type="text" value="' + escHtml(key) + '" placeholder="Property name">'
      + '<input class="prop-val" type="text" value="' + escHtml(val) + '" placeholder="Value">'
      + '<button class="prop-delete" onclick="this.closest(\'.prop-row\').remove()" title="Remove">✕</button>'
      + '</div>';
  });
  return html;
}

async function saveCuration() {
  var status = document.getElementById('curation-status');
  status.textContent = 'Saving...';
  status.style.color = '#888';

  var container = document.getElementById('curation-props-container');
  var rows = container.querySelectorAll('.prop-row');
  var props = {};
  rows.forEach(function(row) {
    var key = (row.querySelector('.prop-key') || {}).value || '';
    var val = (row.querySelector('.prop-val') || {}).value || '';
    if (key.trim()) props[key.trim()] = val;
  });

  try {
    var endpoint = curationTarget.type === 'node'
      ? '/api/graph/update-node'
      : '/api/graph/update-relation';
    await api(endpoint, { elementId: curationTarget.elementId, properties: props });

    // Reflect changes in the live graph
    if (curationTarget.type === 'node') {
      var node = cy.$id(curationTarget.id);
      if (node.length) {
        Object.keys(props).forEach(function(k) { node.data(k, props[k]); });
        if (props.Name) node.data('label', props.Name);
      }
      var gn = graphData.nodes.find(function(n) { return n.id === curationTarget.id; });
      if (gn) Object.assign(gn.properties, props);
    } else {
      var ge = graphData.edges.find(function(e) { return e.id === curationTarget.id; });
      if (ge) Object.assign(ge.properties, props);
    }

    status.textContent = 'Saved!';
    status.style.color = '#4caf50';
    setTimeout(function() {
      document.getElementById('curation-modal').style.display = 'none';
    }, 900);
  } catch(err) {
    status.textContent = 'Error: ' + (err.message || 'Save failed');
    status.style.color = '#e05560';
  }
}