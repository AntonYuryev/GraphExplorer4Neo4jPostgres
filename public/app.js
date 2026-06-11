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

// ─── Tab system state ─────────────────────────────────────────────────────────
let tabs = [];               // [{id, name, snapshot}]
let activeTabIdx = 0;
let graphClipboard = null;   // {nodes, edges, positions} copied from a tab
let rnefPathways = [];       // pathways stored when the RNEF selection modal is open

// ─── Table column state ───────────────────────────────────────────────────────
let columnDefs = [];         // [{key,label,visible,source,dbField}] — current order
let availableDbColumns = { reference: [], scopus_data: [] };
let dragSrcColIdx = null;    // for header drag-and-drop
let colResizing   = null;    // { thEl, startX, startWidth } while resizing a column
let columnWidths  = null;    // null = autofit on next render; {key:px} = user-customised widths
let tableViewMode = 'reference'; // 'reference' | 'relation'
let relationRows  = [];      // rows for Relation view (one per edge, no Postgres)

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
  'id':        'Relation ID',
  'unique_id': 'Assertion ID',
  'msrc':      'Sentence',
  'pmid':      'PMID',
  'doi':       'DOI',
  'pubyear':   'Year',
  'title':     'Title',
  'authors':   'Authors',
  'journal':   'Journal',
  'volume':    'Volume',
  'issue':     'Issue',
  'pages':     'Pages',
  'abstract':  'Abstract'
};

// Ordered list of Neo4j edge properties to expose in the Relations view Columns dialog.
// 'Effect' and 'RelationNumberOfReferences' are omitted here — they appear in the
// "graph columns" section already (as 'Effect' and 'Reference count').
const NEO4J_PROP_DEFS = [
  { prop: 'BiomarkerType',                  label: 'BiomarkerType' },
  { prop: 'CellLineName',                   label: 'CellLineName' },
  { prop: 'CellType',                       label: 'CellType' },
  { prop: 'ChangeType',                     label: 'ChangeType' },
  { prop: 'Bibliographic credibility score',label: 'Bibliographic credibility score' },
  { prop: 'Confidence',                     label: 'Confidence' },
  { prop: 'createdAt',                      label: 'createdAt' },
  { prop: 'Mechanism',                      label: 'Mechanism' },
  { prop: 'Organ',                          label: 'Organ' },
  { prop: 'Organism',                       label: 'Organism' },
  { prop: 'Phase',                          label: 'Phase' },
  { prop: 'QuantitativeType',               label: 'QuantitativeType' },
  { prop: 'RelationID',                     label: 'Relation ID' },
  { prop: 'RelationNumberOfSentences',      label: 'Assertion count' },
  { prop: 'Source',                         label: 'Source' },
  { prop: 'Tissue',                         label: 'Tissue' },
  { prop: 'updatedAt',                      label: 'updatedAt' },
];

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
  { key: 'numRefs',       label: 'Reference count', visible: true,  source: 'graph',     sortKey: 'numRefs' },
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
      var newW = Math.max(8, colResizing.startWidth + dx);
      colResizing.thEl.style.width = newW + 'px';
    }
  });

  document.addEventListener('mouseup', function() {
    if (colResizing) {
      colResizing = null;
      document.body.classList.remove('col-resizing');
      captureColumnWidths();
    }
  });

  // ─── Global keyboard shortcuts ───────────────────────────────────────────
  document.addEventListener('keydown', function(e) {
    var tag = (document.activeElement || {}).tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // Skip if any modal is open
    var modals = ['save-modal','change-pw-modal','users-modal','columns-modal','curation-modal','rnef-modal'];
    if (modals.some(function(id) {
      var el = document.getElementById(id);
      return el && el.style.display !== 'none';
    })) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelection();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      pasteClipboard();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      invertSelection();
    } else if (e.key === 'Delete') {
      deleteSelection();
    }
  });

  var tipEl = document.getElementById('tooltip');
  // Prevent tooltip events from reaching Cytoscape (pan/zoom).
  ['mousedown', 'mouseup', 'mousemove', 'click', 'wheel',
   'pointerdown', 'pointerup', 'pointermove',
   'touchstart', 'touchmove', 'touchend'].forEach(function(evtName) {
    tipEl.addEventListener(evtName, function(e) {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, { capture: true, passive: false });
  });
  // Keep tooltip alive while mouse is over it; hide when mouse leaves it.
  tipEl.addEventListener('mouseenter', function() {
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  });
  tipEl.addEventListener('mouseleave', function() {
    if (tooltipVisible) hideTooltipDelayed();
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

  // Initialize tab system with one empty tab
  tabs = [{ id: Date.now(), name: 'Pathway 1', snapshot: emptyTabSnapshot() }];
  activeTabIdx = 0;
  renderTabBar();
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
    boxSelectionEnabled: true,    // always on; panning state controls which drag mode fires
    userPanningEnabled: false,    // default: drag = box select; Move mode re-enables panning
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
      // Fall back to inline references stored in graphData.edges (e.g. pasted or RNEF edges)
      var refs = (relId && refsCache[relId]) || [];
      if (!refs.length) {
        var edgeRaw = graphData.edges.find(function(ge) { return ge.id === edge.id(); });
        if (edgeRaw && edgeRaw.properties && Array.isArray(edgeRaw.properties.references)) {
          refs = edgeRaw.properties.references;
        }
      }
      renderTooltip(edge, refs);
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
    tooltipVisible = false;
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    document.getElementById('tooltip').style.display = 'none';
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
    tooltipVisible = false;
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    document.getElementById('tooltip').style.display = 'none';
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

  // Auto-hide tooltip when mouse leaves the graph canvas — user can then
  // click toolbar buttons (Invert / Copy / Paste) without losing selection.
  document.getElementById('cy').addEventListener('mouseleave', function() {
    if (tooltipVisible) hideTooltipDelayed();
  });

  // Hide context menu and close all menus on any outside click
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('context-menu');
    if (menu && menu.style.display !== 'none' && !menu.contains(e.target)) hideContextMenu();
    // Close menubar dropdowns if click is outside the menu bar
    var mb = document.getElementById('menubar');
    if (mb && !mb.contains(e.target)) closeMenus();
  });

  // Update selection count display whenever selection changes.
  // Also hide tooltip on select — user has made their decision.
  cy.on('select', function() {
    updateSelectionInfo();
    tooltipVisible = false;
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    document.getElementById('tooltip').style.display = 'none';
  });
  cy.on('unselect', function() { updateSelectionInfo(); });

  // Cytoscape native box-select: fires after selection is complete.
  // Defer our state reset one tick so Cytoscape finishes its own cleanup
  // (clearing the rubber band canvas) before we change pan/zoom settings.
  cy.on('boxselect', function() {
    cy.elements().removeClass('faded');
    updateSelectionInfo();
    setTimeout(_endBoxSelect, 0);
  });
}

// ─── Menu bar ─────────────────────────────────────────────────────────────────
var _openMenu = null;  // ID of currently open menu entry, or null

function toggleMenu(id) {
  if (_openMenu === id) { closeMenus(); return; }
  closeMenus();
  var el = document.getElementById(id);
  if (el) { el.classList.add('open'); _openMenu = id; }
}

function hoverMenu(id) {
  if (_openMenu && _openMenu !== id) toggleMenu(id);
}

function closeMenus() {
  if (_openMenu) {
    var el = document.getElementById(_openMenu);
    if (el) el.classList.remove('open');
    _openMenu = null;
  }
}

function menuApplyLayout(name) {
  closeMenus();
  applyLayout(name);
}

function updateLayoutMenu(name) {
  ['cose','dagre','circle','concentric','grid'].forEach(function(l) {
    var el = document.getElementById('mc-' + l);
    if (el) el.textContent = (l === name) ? '✓' : '';
  });
}

function updateViewMenu(view) {
  var checks = { graph: 'mc-view-graph', relation: 'mc-view-relation', reference: 'mc-view-reference' };
  Object.values(checks).forEach(function(id) {
    var el = document.getElementById(id); if (el) el.textContent = '';
  });
  var key = (view === 'graph') ? 'graph' : tableViewMode;
  var el = document.getElementById(checks[key]);
  if (el) el.textContent = '✓';
  // Context-sensitive View menu: show only relevant items
  var graphItems = document.getElementById('view-graph-items');
  var tableItems = document.getElementById('view-table-items');
  if (graphItems) graphItems.style.display = (view === 'graph') ? '' : 'none';
  if (tableItems) tableItems.style.display = (view === 'graph') ? 'none' : '';
}

function updatePasteMenuItem() {
  var el = document.getElementById('mi-paste');
  if (el) el.classList.toggle('disabled', !graphClipboard);
}
function showQueryResultTable(table) {
  var overlay = document.getElementById('query-result-overlay');
  if (!overlay) return;
  var rowCount = table.rows.length;
  var html = '<div class="qr-header">'
    + '<span class="qr-title">Query Result</span>'
    + '<span class="qr-count">' + rowCount + ' row' + (rowCount !== 1 ? 's' : '') + '</span>'
    + '<button class="qr-close" onclick="hideQueryResultTable()">&#x2715;</button>'
    + '</div><div class="qr-table-wrap"><table class="qr-table"><thead><tr>';
  table.columns.forEach(function(col) {
    html += '<th>' + escHtml(String(col)) + '</th>';
  });
  html += '</tr></thead><tbody>';
  table.rows.forEach(function(row) {
    html += '<tr>';
    row.forEach(function(cell) {
      var display = (cell === null || cell === undefined)
        ? '<span style="color:#7a8099">null</span>'
        : escHtml(typeof cell === 'object' ? JSON.stringify(cell) : String(cell));
      html += '<td>' + display + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  overlay.innerHTML = html;
  overlay.style.display = 'flex';
  document.getElementById('graph-empty-state').style.display = 'none';
}

function hideQueryResultTable() {
  var overlay = document.getElementById('query-result-overlay');
  if (overlay) { overlay.style.display = 'none'; overlay.innerHTML = ''; }
}


function toggleFilterRows() {
  var input = document.getElementById('table-search');
  if (!input) return;
  var show = input.style.display === 'none';
  input.style.display = show ? '' : 'none';
  var mark = show ? '✓' : '';
  var c1 = document.getElementById('mc-filter-rows');
  var c2 = document.getElementById('mc-filter-rows-ref');
  var c3 = document.getElementById('mc-filter-rows-view');
  if (c1) c1.textContent = mark;
  if (c2) c2.textContent = mark;
  if (c3) c3.textContent = mark;
  if (show) {
    input.focus();
  } else {
    input.value = '';
    filterTable('');
  }
}

function selectAllNodes() {
  if (!cy) return;
  cy.nodes().select();
}

function selectAllEdges() {
  if (!cy) return;
  cy.edges().select();
}

function focusCypherInput() {
  var bar = document.getElementById('query-bar');
  if (bar) {
    var wasHidden = bar.style.display === 'none';
    bar.style.display = wasHidden ? '' : 'none';
    if (wasHidden) {
      var el = document.getElementById('cypher-input');
      if (el) { el.focus(); el.select(); }
    }
  }
}

// ─── SQL query dialog ─────────────────────────────────────────────────────────
function openSqlDialog() {
  document.getElementById('sql-modal').style.display = 'flex';
  document.getElementById('sql-results').innerHTML = '';
  setTimeout(function() { document.getElementById('sql-input').focus(); }, 50);
}

function closeSqlModal(e) {
  if (e.target === document.getElementById('sql-modal'))
    document.getElementById('sql-modal').style.display = 'none';
}

async function runSqlQuery() {
  var sql = document.getElementById('sql-input').value.trim();
  if (!sql) return;
  var resultsEl = document.getElementById('sql-results');
  resultsEl.innerHTML = '<span style="color:#7a8099">Running…</span>';
  try {
    var data = await api('/api/sql-query', { sql: sql });
    if (!data.rows || data.rows.length === 0) {
      resultsEl.innerHTML = '<span style="color:#7a8099">No rows returned.</span>';
      return;
    }
    var cols = data.fields;
    var html = '<table style="border-collapse:collapse;width:100%;font-size:11px">'
      + '<thead><tr>' + cols.map(function(c) {
          return '<th style="padding:4px 8px;background:#1a1f33;border:1px solid #2d3147;color:#8899cc;text-align:left;white-space:nowrap">' + escHtml(c) + '</th>';
        }).join('') + '</tr></thead><tbody>';
    data.rows.forEach(function(row) {
      html += '<tr>' + cols.map(function(c) {
        var v = row[c];
        return '<td style="padding:4px 8px;border:1px solid #1e2340;color:#c8cde4;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
          + escHtml(v == null ? '' : String(v)) + '</td>';
      }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    html += '<div style="color:#7a8099;font-size:11px;margin-top:6px">' + data.rows.length + ' row' + (data.rows.length !== 1 ? 's' : '') + '</div>';
    resultsEl.innerHTML = html;
  } catch(e) {
    resultsEl.innerHTML = '<span style="color:#e05560">' + escHtml(e.message || String(e)) + '</span>';
  }
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
    },
    // ── Clone nodes — double border to signal "same entity, different position"
    {
      selector: 'node[?isClone]',
      style: {
        'border-width': 3,
        'border-color': '#FFD700',
        'border-style': 'double',
        'border-opacity': 0.85
      }
    },
    {
      selector: 'node[?isClone]:selected',
      style: {
        'border-width': 4,
        'border-color': '#FFD700',
        'border-opacity': 1
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
    if (n.isClone) d.isClone = true;
    if (n.cloneOf) d.cloneOf = n.cloneOf;
    Object.assign(d, n.properties);
    return {
      group: 'nodes',
      data: d,
      position: savedPositions
        ? (savedPositions[n.id] ||
           (!n.isClone && n.properties && n.properties.URN && savedPositions[n.properties.URN]) ||
           undefined)
        : undefined
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

  // Belt-and-suspenders: explicitly apply saved positions after add().
  // The position field in cy.add() element specs is not always honoured
  // reliably (e.g. when the cy container is hidden during batch adds),
  // so we set positions again here before the preset layout runs.
  if (savedPositions) {
    cy.nodes().forEach(function(n) {
      var pos = savedPositions[n.id()];
      if (!pos && !n.data('isClone')) {
        var urn = n.data('URN');
        if (urn) pos = savedPositions[urn];
      }
      if (pos) n.position(pos);
    });
  }

  document.getElementById('graph-empty-state').style.display =
    (cyNodes.length === 0 && cyEdges.length === 0) ? 'flex' : 'none';

  updateLegend();
  updateStats();

  if (savedPositions) {
    cy.layout({ name: 'preset' }).run();
    // Preset layout places nodes at exact coordinates but does NOT adjust the
    // viewport.  The fit must be deferred one animation frame so the browser
    // has finished painting the (now-visible) canvas before Cytoscape measures
    // container dimensions — otherwise it fits against a zero-size box and the
    // graph stays invisible until the user presses Fit manually.
    requestAnimationFrame(function() {
      if (cy) { cy.resize(); cy.fit(cy.elements(), 40); updateZoomLabel(); }
    });
  } else {
    applyLayout(currentLayout);
  }
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function applyLayout(name, btn) {
  if (!cy || !cy.nodes().length) return;
  currentLayout = name;

  updateLayoutMenu(name);

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
    var shortQ = query.length > 40 ? query.substring(0, 40) + '…' : query;
    updateCurrentTabName(shortQ);
    if (data.table && data.nodes.length === 0 && data.edges.length === 0) {
      showQueryResultTable(data.table);
    } else {
      hideQueryResultTable();
      renderGraph(data);
      if (document.getElementById('table-view').style.display !== 'none') {
        await loadTableData();
      }
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
  refsCache = {};
  medScanMap = {};
  tableRows = [];
  document.getElementById('table-body').innerHTML = '';
  document.getElementById('graph-empty-state').style.display = 'flex';
  hideQueryResultTable();
  currentSubgraphName = '';
  currentQuery = '';
  document.getElementById('graph-stats').textContent = '';
  document.getElementById('legend-items').innerHTML = '';
  updateCurrentTabName('New Tab');
  updateSelectionInfo();
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

function updateSelectionInfo() {
  if (!cy) return;
  var selNodes = cy.nodes(':selected').length;
  var selEdges = cy.edges(':selected').length;
  if (selNodes === 0 && selEdges === 0) {
    updateStats();
    return;
  }
  var parts = [];
  if (selNodes > 0) parts.push(selNodes + ' node' + (selNodes !== 1 ? 's' : '') + ' selected');
  if (selEdges > 0) parts.push(selEdges + ' relation' + (selEdges !== 1 ? 's' : '') + ' selected');
  document.getElementById('graph-stats').textContent = parts.join(' · ');
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
                      NumRefs:1, references:1, isClone:1, cloneOf:1 };

  var html = '<div class="tooltip-rel-header">' + escHtml(name);
  if (nodeType) html += ' <span style="color:#7a8099;font-weight:400;font-size:11px">(' + escHtml(nodeType) + ')</span>';
  html += '</div>';
  if (data.isClone) html += '<div style="font-size:11px;color:#FFD700;margin-top:3px">⬦ Clone — same entity as original</div>';
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
  document.getElementById('graph-view').style.display = view === 'graph' ? 'flex' : 'none';
  document.getElementById('table-view').style.display = view === 'table' ? 'flex' : 'none';
  updateViewMenu(view);

  // Always hide tooltip when leaving graph view.
  tooltipVisible = false;
  document.getElementById('tooltip').style.display = 'none';

  if (view === 'graph' && cy) {
    // When the cy container was hidden (display:none), Cytoscape loses track of
    // the viewport dimensions. Resize+fit restores the correct render.
    cy.resize();
  }

  if (view === 'table' && graphData.edges.length > 0) {
    if (tableViewMode === 'relation') {
      loadRelationData();
    } else {
      if (tableRows.length > 0) {
        renderTableHeader();
        renderTableRows(tableRows);
      } else {
        await loadTableData();
      }
    }
    requestAnimationFrame(function() {
      if (columnWidths === null) { autofitColumns(); } else { applyColumnWidths(); }
    });
  }
}

function syncTableModeIndicator(mode) {
  // Update View menu checkmarks for table modes
  var relEl = document.getElementById('mc-view-relation');
  var refEl = document.getElementById('mc-view-reference');
  if (relEl) relEl.textContent = (mode === 'relation') ? '✓' : '';
  if (refEl) refEl.textContent = (mode === 'reference') ? '✓' : '';
  // Also clear the Graph checkmark when in table mode
  var grEl = document.getElementById('mc-view-graph');
  if (grEl) grEl.textContent = '';
}

async function setTableViewMode(mode) {
  tableViewMode = mode;
  syncTableModeIndicator(mode);
  columnWidths = null;
  if (document.getElementById('table-view').style.display !== 'none'
      && graphData.edges.length > 0) {
    if (mode === 'relation') {
      loadRelationData();
    } else {
      if (tableRows.length > 0) {
        renderTableHeader();
        renderTableRows(tableRows);
      } else {
        await loadTableData();   // await so RAF fires after data is rendered
      }
    }
    requestAnimationFrame(function() {
      if (columnWidths === null) { autofitColumns(); } else { applyColumnWidths(); }
    });
  }
}

function toggleTableDropdown(e) {
  e.stopPropagation();
  var menu = document.getElementById('view-table-menu');
  if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function selectTableMode(mode) {
  var menu = document.getElementById('view-table-menu');
  if (menu) menu.style.display = 'none';
  setTableViewMode(mode);
  if (document.getElementById('table-view').style.display === 'none') {
    switchView('table');
  }
}

// ─── Table ────────────────────────────────────────────────────────────────────
async function colorSentencesNow() {
  var statsEl = document.getElementById('graph-stats');
  if (statsEl) statsEl.innerHTML = '<span style="color:#7a8099">Loading MedScan data…</span>';

  // Force-fetch MedScan IDs for ALL current nodes
  var nodeIds = graphData.nodes
    .map(function(n) { return n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null; })
    .filter(Boolean);
  if (nodeIds.length > 0) {
    try {
      var fetched = await api('/api/nodes/medscan', { nodeIds: nodeIds });
      Object.assign(medScanMap, fetched);
    } catch(err) {
      console.warn('MedScan lookup failed:', err.message);
    }
  }

  // Switch to reference view and rebuild
  tableViewMode = 'reference';
  syncTableModeIndicator('reference');
  switchView('table');
  tableRows = [];
  await loadTableData();

  var colored = Object.keys(medScanMap).length;
  if (statsEl) {
    statsEl.innerHTML = colored
      ? '<span style="color:#2a9d2a">Sentence coloring applied (' + colored + ' nodes matched)</span>'
      : '<span style="color:#e05560">No MedScan IDs found for current nodes</span>';
    setTimeout(updateStats, 3000);
  }
}

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

  // Fetch MedScan IDs for any nodes not yet in the map (handles paste into new tab
  // where fetchMedScanForNodes may have only covered some nodes, or ran too late).
  var missingNodeIds = graphData.nodes
    .map(function(n) { return n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null; })
    .filter(function(id) { return id && !medScanMap[id]; });
  if (missingNodeIds.length > 0) {
    msg.style.display = 'inline';
    msg.textContent = 'Loading matching data from database…';
    try {
      var fetched = await api('/api/nodes/medscan', { nodeIds: missingNodeIds });
      Object.assign(medScanMap, fetched);
    } catch(err) {
      console.warn('MedScan lookup failed:', err.message);
    }
    msg.textContent = 'Loading references…';
    msg.style.display = 'none';
  }

  function nodeLabel(node) {
    if (!node) return '?';
    // cy node label is always correct (set by renderGraph from computed getNodeLabel)
    if (cy) {
      var cyNode = cy.$id(node.id);
      if (cyNode && cyNode.length) { var lbl = cyNode.data('label'); if (lbl) return lbl; }
      if (node.properties && node.properties.URN) {
        cyNode = cy.$id(node.properties.URN);
        if (cyNode && cyNode.length) { var lbl2 = cyNode.data('label'); if (lbl2) return lbl2; }
      }
    }
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

function loadRelationData() {
  var nodeById = {};
  graphData.nodes.forEach(function(n) {
    nodeById[n.id] = n;
    if (n.properties && n.properties.URN) nodeById[n.properties.URN] = n;
  });
  function nodeLabel(node) {
    if (!node) return '?';
    // cy node label is always correct (set by renderGraph from computed getNodeLabel)
    if (cy) {
      var cyNode = cy.$id(node.id);
      if (cyNode && cyNode.length) { var lbl = cyNode.data('label'); if (lbl) return lbl; }
      if (node.properties && node.properties.URN) {
        cyNode = cy.$id(node.properties.URN);
        if (cyNode && cyNode.length) { var lbl2 = cyNode.data('label'); if (lbl2) return lbl2; }
      }
    }
    return getNodeLabel(node);
  }
  function nodeMedScan(node) {
    if (!node || !node.properties) return '';
    var nid = node.properties.NodeID != null ? String(node.properties.NodeID) : null;
    return (nid && medScanMap[nid]) ? medScanMap[nid] : '';
  }
  // Ensure all NEO4J_PROP_DEFS columns exist in columnDefs (hidden by default).
  var existingNeo4j = {};
  columnDefs.forEach(function(c) { if (c.source === 'neo4j') existingNeo4j[c.dbField] = c; });
  NEO4J_PROP_DEFS.forEach(function(def) {
    if (!existingNeo4j[def.prop]) {
      var newCol = { key: 'neo4j_' + def.prop, label: def.label, visible: false, source: 'neo4j', dbField: def.prop };
      columnDefs.push(newCol);
      existingNeo4j[def.prop] = newCol;
    }
  });
  relationRows = graphData.edges.map(function(edge) {
    var srcNode = nodeById[edge.startNodeId];
    var tgtNode = nodeById[edge.endNodeId];
    var row = {
      edgeId:           edge.id,
      elementId:        edge.elementId || edge.id,
      relId:            edge.properties.RelationID != null ? String(edge.properties.RelationID) : '',
      regulator:        nodeLabel(srcNode),
      regulatorMedScan: nodeMedScan(srcNode),
      regulatorType:    (srcNode && srcNode.labels && srcNode.labels[0]) || '',
      target:           nodeLabel(tgtNode),
      targetMedScan:    nodeMedScan(tgtNode),
      targetType:       (tgtNode && tgtNode.labels && tgtNode.labels[0]) || '',
      relationType:     edge.type,
      effect:           edge.properties.Effect || edge.properties.effect || '',
      numRefs:          edge.properties.RelationNumberOfReferences != null
                          ? edge.properties.RelationNumberOfReferences
                          : (Array.isArray(edge.properties.references) ? edge.properties.references.length : 0)
    };
    columnDefs.forEach(function(col) {
      if (col.source === 'neo4j') {
        row[col.key] = edge.properties[col.dbField] != null ? String(edge.properties[col.dbField]) : '';
      }
    });
    return row;
  });
  renderTableHeader();
  renderTableRows(relationRows);
}

function renderTableHeader() {
  var thead = document.querySelector('#data-table thead tr');
  if (!thead) return;
  var visCols = columnDefs.filter(function(c) {
    if (!c.visible) return false;
    if (tableViewMode === 'relation') return c.source === 'graph' || c.source === 'neo4j';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data';
  });
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
  var visCols = columnDefs.filter(function(c) {
    if (!c.visible) return false;
    if (tableViewMode === 'relation') return c.source === 'graph' || c.source === 'neo4j';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data';
  });
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

// ─── Columns dialog ───────────────────────────────────────────────────────────

var _colDragSrcIdx = null;

async function openColumnsDialog() {
  var refCols = [], sdCols = [];
  try {
    var schema = await api('/api/schema/columns');
    refCols = schema.referenceColumns || [];
    sdCols  = schema.scopusColumns    || [];
  } catch(e) {}

  // ── Graph columns ──────────────────────────────────────────────────────
  var graphList = document.getElementById('col-graph-list');
  graphList.innerHTML = '';
  columnDefs.filter(function(c) { return c.source === 'graph'; }).forEach(function(col) {
    var lb = document.createElement('label');
    lb.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap';
    lb.innerHTML = '<input type="checkbox" data-col-key="' + escHtml(col.key) + '"'
      + (col.visible ? ' checked' : '') + '> ' + escHtml(col.label);
    graphList.appendChild(lb);
  });

  var isRelationView = tableViewMode === 'relation';

  // ── Neo4j edge properties (Relation view only) ─────────────────────────
  var neo4jSection = document.getElementById('col-neo4j-section');
  var neo4jList    = document.getElementById('col-neo4j-list');
  if (!isRelationView) {
    if (neo4jSection) neo4jSection.style.display = 'none';
  } else {
    if (neo4jSection) neo4jSection.style.display = '';
    neo4jList.innerHTML = '';
    var existingNeo4jMap = {};
    columnDefs.forEach(function(c) { if (c.source === 'neo4j') existingNeo4jMap[c.dbField] = c; });
    NEO4J_PROP_DEFS.forEach(function(def) {
      if (!existingNeo4jMap[def.prop]) {
        var newCol = { key: 'neo4j_' + def.prop, label: def.label, visible: false, source: 'neo4j', dbField: def.prop };
        columnDefs.push(newCol);
        existingNeo4jMap[def.prop] = newCol;
      }
      var col = existingNeo4jMap[def.prop];
      var lb = document.createElement('label');
      lb.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap';
      lb.innerHTML = '<input type="checkbox" data-col-key="' + escHtml(col.key) + '"'
        + (col.visible ? ' checked' : '') + '> ' + escHtml(col.label);
      neo4jList.appendChild(lb);
    });
  }

  // ── Reference table columns (Reference view only) ──────────────────────
  var refSection = document.getElementById('col-ref-section');
  var refList    = document.getElementById('col-ref-list');
  if (refSection) refSection.style.display = isRelationView ? 'none' : '';
  if (!isRelationView) {
    // Match by dbField to avoid duplicating columns with custom keys (e.g. sentence/msrc).
    var refByDbField = {};
    columnDefs.forEach(function(c) { if (c.source === 'reference') refByDbField[c.dbField] = c; });

    refList.innerHTML = '';
    refCols.forEach(function(dbField) {
      if (!refByDbField[dbField]) {
        var label = COL_DISPLAY_NAMES[dbField] || dbField;
        var newCol = { key: dbField, label: label, visible: false, source: 'reference', dbField: dbField };
        columnDefs.push(newCol);
        refByDbField[dbField] = newCol;
      }
      var col = refByDbField[dbField];
      var cbLabel = escHtml(col.label);
      if (col.dbField && col.label !== col.dbField) {
        cbLabel += ' <span style="color:#7a8099;font-size:11px">(' + escHtml(col.dbField) + ')</span>';
      }
      var lb = document.createElement('label');
      lb.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap';
      lb.innerHTML = '<input type="checkbox" data-col-key="' + escHtml(col.key) + '"'
        + (col.visible ? ' checked' : '') + '> ' + cbLabel;
      refList.appendChild(lb);
    });
  }

  // ── Scopus data columns (Reference view only) ──────────────────────────
  var sdList    = document.getElementById('col-sd-list');
  var sdSection = document.getElementById('col-sd-section');
  var sdByKey   = {};
  columnDefs.forEach(function(c) { if (c.source === 'scopus_data') sdByKey[c.key] = c; });

  sdList.innerHTML = '';
  if (isRelationView || sdCols.length === 0) {
    if (sdSection) sdSection.style.display = 'none';
  } else {
    if (sdSection) sdSection.style.display = '';
    sdCols.forEach(function(dbField) {
      var key   = 'sd_' + dbField;
      var label = SCOPUS_COLUMNS[dbField] || dbField;
      if (!sdByKey[key]) {
        var newCol = { key: key, label: label, visible: false, source: 'scopus_data', dbField: dbField };
        columnDefs.push(newCol);
        sdByKey[key] = newCol;
      }
      var col = sdByKey[key];
      var lb = document.createElement('label');
      lb.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap';
      lb.innerHTML = '<input type="checkbox" data-col-key="' + escHtml(col.key) + '"'
        + (col.visible ? ' checked' : '') + '> ' + escHtml(col.label);
      sdList.appendChild(lb);
    });
  }

  document.getElementById('columns-modal').style.display = 'flex';
}

function closeColumnsModal(e) {
  if (e.target === document.getElementById('columns-modal'))
    document.getElementById('columns-modal').style.display = 'none';
}

function applyColumnsDialog() {
  document.querySelectorAll('[data-col-key]').forEach(function(cb) {
    var key = cb.getAttribute('data-col-key');
    var col = columnDefs.find(function(c) { return c.key === key; });
    if (col) col.visible = cb.checked;
  });
  saveColumnConfig();
  document.getElementById('columns-modal').style.display = 'none';
  columnWidths = null;
  if (document.getElementById('table-view').style.display !== 'none') {
    if (tableViewMode === 'relation') {
      loadRelationData();
    } else {
      tableRows = [];
      loadTableData();
    }
  }
}

// ─── Column header drag-to-reorder ───────────────────────────────────────────

function colDragStart(event, idx) {
  _colDragSrcIdx = idx;
  event.dataTransfer.effectAllowed = 'move';
}

function colDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

function colDrop(event, targetIdx) {
  event.preventDefault();
  if (_colDragSrcIdx === null || _colDragSrcIdx === targetIdx) return;
  var visCols = columnDefs.filter(function(c) { return c.visible; });
  var moved = visCols.splice(_colDragSrcIdx, 1)[0];
  visCols.splice(targetIdx, 0, moved);
  // Rebuild columnDefs: hidden cols keep their relative order; visible cols
  // use the newly reordered array.
  var hidden = columnDefs.filter(function(c) { return !c.visible; });
  columnDefs = visCols.concat(hidden);
  saveColumnConfig();
  renderTableHeader();
  renderTableRows(tableRows);
}

function colDragEnd(event) {
  _colDragSrcIdx = null;
}

// ─── Column resize ────────────────────────────────────────────────────────────

function colResizeStart(event, th) {
  event.preventDefault();
  var startX  = event.clientX;
  var startW  = th.offsetWidth;
  function onMove(e) {
    var w = Math.max(8, startW + (e.clientX - startX));
    th.style.width    = w + 'px';
    th.style.minWidth = w + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    captureColumnWidths();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

function autofitColumns() {
  var table = document.getElementById('data-table');
  if (!table) return;
  // Temporarily switch to auto layout so browser can measure natural widths
  table.style.tableLayout = 'auto';
  var ths = table.querySelectorAll('thead tr th');
  // Force reflow then read natural widths
  void table.offsetWidth;
  var widths = Array.from(ths).map(function(th) { return th.offsetWidth; });
  // Restore fixed layout and apply the measured widths
  table.style.tableLayout = 'fixed';
  ths.forEach(function(th, i) {
    th.style.width    = widths[i] + 'px';
    th.style.minWidth = widths[i] + 'px';
  });
}

function applyColumnWidths() {
  if (!columnWidths) return;
  var ths = document.querySelectorAll('#data-table thead tr th');
  var visCols = columnDefs.filter(function(c) {
    if (!c.visible) return false;
    if (tableViewMode === 'relation') return c.source === 'graph' || c.source === 'neo4j';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data';
  });
  ths.forEach(function(th, i) {
    var col = visCols[i];
    if (col && columnWidths[col.key]) {
      th.style.width    = columnWidths[col.key] + 'px';
      th.style.minWidth = columnWidths[col.key] + 'px';
    }
  });
}

function captureColumnWidths() {
  var ths = document.querySelectorAll('#data-table thead tr th');
  var visCols = columnDefs.filter(function(c) {
    if (!c.visible) return false;
    if (tableViewMode === 'relation') return c.source === 'graph' || c.source === 'neo4j';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data';
  });
  columnWidths = {};
  ths.forEach(function(th, i) {
    var col = visCols[i];
    if (col) columnWidths[col.key] = th.offsetWidth;
  });
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
      updateCurrentTabName(currentSubgraphName || file.name.replace(/\.json$/i, ''));

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
        // Same clone-offset fallback as openRnefPathway — handles cases where
        // positions were missing or defaulted to (0,0) in the saved file.
        var cloneIdx2 = {};
        cy.nodes().forEach(function(n) {
          if (!n.data('isClone')) return;
          var orig = n.data('cloneOf');
          if (!orig) return;
          var origNode = cy.$id(orig);
          if (!origNode || !origNode.length) return;
          var op = origNode.position();
          var cp = n.position();
          var hasSavedPos = data.positions[n.id()];
          var isAtOrigin  = Math.abs(cp.x) < 1 && Math.abs(cp.y) < 1;
          var sameAsOrig  = Math.abs(cp.x - op.x) < 2 && Math.abs(cp.y - op.y) < 2;
          if (hasSavedPos && !isAtOrigin && !sameAsOrig) return;
          var i = (cloneIdx2[orig] = (cloneIdx2[orig] || 0) + 1);
          n.position({ x: op.x + i * 140, y: op.y + i * 60 });
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
      // Multiple sub-graphs — show checklist so user can open one or many tabs
      rnefPathways = pathways;
      var list = document.getElementById('rnef-pathway-list');
      list.innerHTML = '';
      pathways.forEach(function(pw, i) {
        var label = document.createElement('label');
        label.className = 'rnef-pw-row';
        label.innerHTML = '<input type="checkbox" class="rnef-pw-cb" value="' + i + '">'
          + '<span>' + escHtml(pw.name) + '</span>';
        list.appendChild(label);
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
  updateCurrentTabName(currentSubgraphName || 'Pathway');

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
    // For clones with missing or bad positions, spread them around their original.
    // A position is "bad" if it is exactly (0,0) — the Cytoscape default when a
    // node has no position — or if the clone ended up at the exact same spot as
    // the original (which happens when the RNEF vobj Position attribute is absent).
    var cloneIdx = {};
    cy.nodes().forEach(function(n) {
      if (!n.data('isClone')) return;
      var orig = n.data('cloneOf');
      if (!orig) return;
      var origNode = cy.$id(orig);
      if (!origNode || !origNode.length) return;
      var op = origNode.position();
      var cp = n.position();
      // Need offset when: no saved position, OR current position is (0,0),
      // OR clone landed on top of its original
      var hasSavedPos = data.positions && data.positions[n.id()];
      var isAtOrigin  = Math.abs(cp.x) < 1 && Math.abs(cp.y) < 1;
      var sameAsOrig  = Math.abs(cp.x - op.x) < 2 && Math.abs(cp.y - op.y) < 2;
      if (hasSavedPos && !isAtOrigin && !sameAsOrig) return; // position looks good
      var i = (cloneIdx[orig] = (cloneIdx[orig] || 0) + 1);
      n.position({ x: op.x + i * 140, y: op.y + i * 60 });
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

function toggleAllRnefCheckboxes(masterCb) {
  var cbs = document.querySelectorAll('.rnef-pw-cb');
  cbs.forEach(function(cb) { cb.checked = masterCb.checked; });
}

function openSelectedRnefPathways() {
  var checked = Array.from(document.querySelectorAll('.rnef-pw-cb:checked'))
    .map(function(cb) { return parseInt(cb.value, 10); });

  if (checked.length === 0) {
    var hint = document.getElementById('rnef-select-hint');
    if (hint) {
      hint.style.display = 'inline';
      setTimeout(function() { hint.style.display = 'none'; }, 2000);
    }
    return;
  }

  document.getElementById('rnef-modal').style.display = 'none';

  // First selected pathway opens in the current (active) tab
  openRnefPathway(rnefPathways[checked[0]].data);

  // Each additional selected pathway gets its own new tab.
  // We open them sequentially with a small delay between each so that
  // Cytoscape has time to fully render one pathway before the next tab
  // is created (createNewTab calls applyTabState which clears cy —
  // without the delay the render of the previous pathway can race with
  // the clear and leave the new tab blank).
  if (checked.length > 1) {
    var remaining = checked.slice(1).map(function(idx) { return rnefPathways[idx]; });
    function openNext(list) {
      if (!list.length) return;
      var pw = list[0];
      // Save the current tab's live state before switching away
      if (activeTabIdx >= 0 && activeTabIdx < tabs.length) {
        tabs[activeTabIdx].snapshot = captureTabState();
      }
      // Create the new tab with an empty snapshot (tab bar updated)
      var newIdx = tabs.length;
      tabs.push({ id: Date.now() + newIdx, name: pw.name || ('Pathway ' + (newIdx + 1)), snapshot: emptyTabSnapshot() });
      activeTabIdx = newIdx;
      renderTabBar();
      // Show graph-view; don't call applyTabState so cy is NOT cleared yet
      document.getElementById('graph-view').style.display = 'flex';
      document.getElementById('table-view').style.display = 'none';
      document.getElementById('graph-empty-state').style.display = 'none';
      // Render the pathway directly into the (still-populated) cy instance
      openRnefPathway(pw.data);
      // Open remaining pathways after a short pause
      setTimeout(function() { openNext(list.slice(1)); }, 80);
    }
    setTimeout(function() { openNext(remaining); }, 80);
  }
}

// ─── Enrich subgraph nodes from Neo4j by URN ─────────────────────────────────
function enrichNodesFromNeo4j(jsonNodes) {
  var urns = jsonNodes
    .map(function(n) { return n.properties && n.properties.URN; })
    .filter(Boolean);
  if (!urns.length) return;

  // Record which tab issued this request. If the user switches tabs before the
  // API response arrives the callback must update the stored snapshot instead
  // of the live globals (which now belong to a different tab).
  var enrichTabIdx = activeTabIdx;

  api('/api/graph/enrich-by-urn', { urns: urns })
    .then(function(enriched) {
      var isCurrentTab = (activeTabIdx === enrichTabIdx);

      // graphData to enrich: if still on the same tab use the live global;
      // otherwise patch the tab snapshot directly so the data is ready when
      // the user switches back.
      var targetGD = isCurrentTab
        ? graphData
        : (tabs[enrichTabIdx] && tabs[enrichTabIdx].snapshot && tabs[enrichTabIdx].snapshot.graphData);
      if (!targetGD) return;

      var matched = 0;

      if (isCurrentTab) {
        // Current tab: update Cytoscape display nodes AND backing graphData.
        cy.nodes().forEach(function(cyNode) {
          var urn = cyNode.data('URN');
          if (!urn || !enriched[urn]) return;
          matched++;
          var neo = enriched[urn];
          var merged = Object.assign({}, cyNode.data(), neo.properties);
          merged.URN = urn;
          if (neo.properties.Name) merged.label = neo.properties.Name;
          if (neo.labels && neo.labels.length) {
            merged.nodeType = neo.labels[0];
            merged.color = getNodeColor(neo.labels);
          }
          merged.elementId = neo.elementId;
          cyNode.data(merged);
          var gn = targetGD.nodes.find(function(n) { return n.properties && n.properties.URN === urn; });
          if (gn) {
            var oldId = gn.id;
            gn.id = neo.id;
            gn.elementId = neo.elementId;
            gn.labels = neo.labels;
            Object.assign(gn.properties, neo.properties);
            gn.properties.URN = urn;
            if (oldId !== neo.id) {
              targetGD.edges.forEach(function(e) {
                if (e.startNodeId === oldId) e.startNodeId = neo.id;
                if (e.endNodeId   === oldId) e.endNodeId   = neo.id;
              });
            }
          }
        });
      } else {
        // Background tab: only update the snapshot graphData (cy belongs to the
        // active tab and must not be touched).
        urns.forEach(function(urn) {
          if (!enriched[urn]) return;
          var neo = enriched[urn];
          var gn = targetGD.nodes.find(function(n) { return n.properties && n.properties.URN === urn; });
          if (!gn) return;
          matched++;
          var oldId = gn.id;
          gn.id = neo.id;
          gn.elementId = neo.elementId;
          gn.labels = neo.labels;
          Object.assign(gn.properties, neo.properties);
          gn.properties.URN = urn;
          if (oldId !== neo.id) {
            targetGD.edges.forEach(function(e) {
              if (e.startNodeId === oldId) e.startNodeId = neo.id;
              if (e.endNodeId   === oldId) e.endNodeId   = neo.id;
            });
          }
        });
      }

      // Remove the "Loading matching data…" spinner (only visible on current tab).
      if (isCurrentTab) {
        var enrichSpan = document.getElementById('enrich-status');
        if (enrichSpan) enrichSpan.remove();
      }

      if (matched > 0) {
        if (isCurrentTab) {
          updateLegend();
          var statsEl = document.getElementById('graph-stats');
          if (statsEl) {
            var orig = statsEl.innerHTML;
            statsEl.innerHTML = orig + ' <span style="color:#4caf50;font-size:11px">(+' + matched + ' enriched from Neo4j)</span>';
            setTimeout(function() { updateStats(); }, 3000);
          }
        }

        // Pre-fetch MedScan IDs using the now-enriched node list.
        var nodeIds = targetGD.nodes
          .map(function(n) { return n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null; })
          .filter(Boolean);
        if (nodeIds.length > 0) {
          api('/api/nodes/medscan', { nodeIds: nodeIds })
            .then(function(map) {
              if (isCurrentTab) {
                // Apply to live state and refresh table if open.
                medScanMap = map;
                var tableViewEl = document.getElementById('table-view');
                if (tableViewEl && tableViewEl.style.display !== 'none') {
                  loadTableData();
                }
              } else if (tabs[enrichTabIdx] && tabs[enrichTabIdx].snapshot) {
                // Park in the background tab's snapshot for when the user returns.
                tabs[enrichTabIdx].snapshot.medScanMap = map;
              }
            })
            .catch(function() {});
        } else if (isCurrentTab) {
          var tableViewEl = document.getElementById('table-view');
          if (tableViewEl && tableViewEl.style.display !== 'none') {
            loadTableData();
          }
        }
      }
    })
    .catch(function() {
      if (activeTabIdx === enrichTabIdx) {
        var enrichSpan = document.getElementById('enrich-status');
        if (enrichSpan) enrichSpan.remove();
      }
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

  // Show/hide clone items depending on whether target is a node and whether it's already a clone
  var isNode = (type === 'node');
  var cyNode = isNode && cy ? cy.getElementById(id) : null;
  var alreadyClone = cyNode && cyNode.data('isClone');
  var cloneEl   = document.getElementById('ctx-clone');
  var sepEl     = document.getElementById('ctx-sep-clone');
  var uncloneEl = document.getElementById('ctx-unclone');
  if (cloneEl)   cloneEl.style.display   = isNode && !alreadyClone ? '' : 'none';
  if (sepEl)     sepEl.style.display     = isNode ? '' : 'none';
  if (uncloneEl) uncloneEl.style.display = isNode && alreadyClone ? '' : 'none';

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

// ─── Node cloning ─────────────────────────────────────────────────────────────
// A "clone" is a second (or third…) visual instance of the same database entity.
// It shares the original node's URN but has its own unique Cytoscape ID so it
// can be positioned independently and connected to different edges.
//
// Clones are stored as plain entries in graphData.nodes with isClone:true and
// cloneOf set to the original node's ID.  This makes them persist through
// save/load cycles just like any other node.
function cloneNode(sourceId) {
  if (!cy) return;
  var src = cy.getElementById(sourceId);
  if (!src || src.length === 0) return;

  var cloneId = sourceId + '__clone__' + Date.now();
  var srcData = src.data();
  var srcPos  = src.position();

  // Build Cytoscape data for the clone (copy all properties, mark as clone)
  var cloneData = Object.assign({}, srcData, {
    id:        cloneId,
    elementId: cloneId,
    isClone:   true,
    cloneOf:   srcData.cloneOf || sourceId   // keep pointing to the original
  });

  // Add to Cytoscape canvas, offset so it doesn't sit on top of the original
  cy.add({
    group: 'nodes',
    data: cloneData,
    position: { x: srcPos.x + 140, y: srcPos.y }
  });

  // Mirror into graphData.nodes so the clone survives captureTabState/save
  var srcGraphNode = graphData.nodes.find(function(n) { return n.id === sourceId; });
  var cloneGraphNode = {
    id:        cloneId,
    elementId: cloneId,
    labels:    srcGraphNode ? (srcGraphNode.labels || []).slice() : [srcData.nodeType || 'Unknown'],
    isClone:   true,
    cloneOf:   srcData.cloneOf || sourceId,
    properties: srcGraphNode
      ? Object.assign({}, srcGraphNode.properties)
      : Object.assign({}, srcData, { id: undefined, elementId: undefined,
                                      isClone: undefined, cloneOf: undefined,
                                      label: undefined, color: undefined,
                                      nodeType: undefined })
  };
  graphData.nodes.push(cloneGraphNode);

  updateStats();
}

function cloneNodeFromContext() {
  hideContextMenu();
  if (!contextTarget || contextTarget.type !== 'node') return;

  var sourceId = contextTarget.id;
  if (!cy) return;
  var src = cy.getElementById(sourceId);
  if (!src || src.length === 0) return;

  var connectedEdges = src.connectedEdges().toArray();

  // No edges — fall back to single clone
  if (connectedEdges.length === 0) {
    cloneNode(sourceId);
    return;
  }

  var srcData      = src.data();
  var srcPos       = src.position();
  var srcUrn       = srcData.URN;
  var srcGraphNode = graphData.nodes.find(function(n) {
    return n.id === sourceId ||
           (srcUrn && n.properties && n.properties.URN === srcUrn && !n.isClone);
  });
  var srcGnId      = srcGraphNode ? srcGraphNode.id : sourceId;
  var cloneOf      = srcData.cloneOf || sourceId;

  // Spread clones in a circle around the original position
  var n      = connectedEdges.length;
  var radius = 80;

  connectedEdges.forEach(function(edge, i) {
    var angle   = (2 * Math.PI * i / n) - Math.PI / 2;
    var cloneId = sourceId + '__clone__' + Date.now() + '_' + i;

    // Add clone node to Cytoscape
    cy.add({
      group: 'nodes',
      data: Object.assign({}, srcData, {
        id: cloneId, elementId: cloneId,
        isClone: true, cloneOf: cloneOf
      }),
      position: {
        x: srcPos.x + radius * Math.cos(angle),
        y: srcPos.y + radius * Math.sin(angle)
      }
    });

    // Move this edge's endpoint(s) from original to clone, then re-add
    var ed = Object.assign({}, edge.data());
    if (ed.source === sourceId) ed.source = cloneId;
    if (ed.target === sourceId) ed.target = cloneId;
    edge.remove();
    cy.add({ group: 'edges', data: ed });

    // Keep graphData.edges in sync
    var gde = graphData.edges.find(function(e) { return e.id === ed.id; });
    if (gde) {
      if (gde.startNodeId === srcGnId) gde.startNodeId = cloneId;
      if (gde.endNodeId   === srcGnId) gde.endNodeId   = cloneId;
    }

    // Add clone to graphData.nodes
    graphData.nodes.push({
      id: cloneId, elementId: cloneId,
      labels:    srcGraphNode ? (srcGraphNode.labels || []).slice() : [srcData.nodeType || 'Unknown'],
      isClone:   true,
      cloneOf:   cloneOf,
      properties: srcGraphNode
        ? Object.assign({}, srcGraphNode.properties)
        : Object.assign({}, srcData, { id: undefined, elementId: undefined,
                                        isClone: undefined, cloneOf: undefined,
                                        label: undefined, color: undefined,
                                        nodeType: undefined })
    });
  });

  // Remove the original — all its edges have been redistributed to clones
  src.remove();
  graphData.nodes = graphData.nodes.filter(function(n) { return n.id !== srcGnId; });

  updateStats();
}

function removeCloneFromContext() {
  hideContextMenu();
  if (!contextTarget || contextTarget.type !== 'node') return;
  var id = contextTarget.id;
  if (!cy) return;
  var node = cy.getElementById(id);
  if (!node || !node.data('isClone')) return;

  // Remove from Cytoscape
  node.remove();

  // Remove from graphData.nodes
  graphData.nodes = graphData.nodes.filter(function(n) { return n.id !== id; });

  updateStats();
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

// ═══════════════════════════════════════════════════════════════════════════
// TAB SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

function emptyTabSnapshot() {
  return {
    graphData:           { nodes: [], edges: [] },
    refsCache:           {},
    medScanMap:          {},
    tableRows:           [],
    currentSubgraphName: '',
    currentLayout:       'cose',
    currentQuery:        '',
    positions:           {},
    tableViewMode:       'reference'
  };
}

function captureTabState() {
  var positions = {};
  if (cy) {
    // Build a cy-node-id → graphData-node-id map.
    // After enrichNodesFromNeo4j, cy node IDs are the original URNs (immutable) but
    // graphData.nodes[i].id has been updated to the Neo4j integer ID.
    // We always key positions by graphData ID so renderGraph can look them up by n.id.
    // IMPORTANT: only map URN → graphData ID for the original (non-clone) node.
    // Clone nodes share the same URN as their original; if we mapped all of them
    // the last clone processed would overwrite the original's URN entry, causing the
    // original to lose its position on the next tab switch.
    var cyIdToGraphId = {};
    graphData.nodes.forEach(function(n) {
      cyIdToGraphId[n.id] = n.id;
      if (!n.isClone && n.properties && n.properties.URN) {
        cyIdToGraphId[n.properties.URN] = n.id;
      }
    });
    cy.nodes().forEach(function(n) {
      var gid = cyIdToGraphId[n.id()] !== undefined ? cyIdToGraphId[n.id()] : n.id();
      positions[gid] = { x: n.position('x'), y: n.position('y') };
    });
  }
  return {
    graphData:           JSON.parse(JSON.stringify(graphData)),
    refsCache:           Object.assign({}, refsCache),
    medScanMap:          Object.assign({}, medScanMap),
    tableRows:           JSON.parse(JSON.stringify(tableRows)),
    currentSubgraphName: currentSubgraphName,
    currentLayout:       currentLayout,
    currentQuery:        currentQuery,
    positions:           positions,
    tableViewMode:       tableViewMode
  };
}

function applyTabState(snapshot) {
  // Always switch to Graph view when activating a tab so:
  //  (a) the user sees the graph of the tab they just switched to, and
  //  (b) Cytoscape renders into a visible container (hidden containers lose
  //      their viewport dimensions and produce a blank canvas on reveal).
  document.getElementById('graph-view').style.display = 'flex';
  document.getElementById('table-view').style.display = 'none';

  var s = snapshot || emptyTabSnapshot();
  graphData           = JSON.parse(JSON.stringify(s.graphData));
  currentSubgraphName = s.currentSubgraphName || '';
  currentLayout       = s.currentLayout || 'cose';
  currentQuery        = s.currentQuery || '';

  var qEl = document.getElementById('cypher-input');
  if (qEl) qEl.value = currentQuery;

  updateLayoutMenu(currentLayout);

  if (graphData.nodes.length === 0 && graphData.edges.length === 0) {
    if (cy) cy.elements().remove();
    document.getElementById('graph-empty-state').style.display = 'flex';
    document.getElementById('graph-stats').innerHTML = '';
    document.getElementById('legend-items').innerHTML = '';
    refsCache  = Object.assign({}, s.refsCache);
    medScanMap = Object.assign({}, s.medScanMap);
    tableRows  = [];
  } else {
    var hasPos = s.positions && Object.keys(s.positions).length > 0;
    renderGraph(graphData, hasPos ? s.positions : null);
    // renderGraph resets refsCache/medScanMap — restore saved values
    refsCache  = Object.assign({}, s.refsCache);
    medScanMap = Object.assign({}, s.medScanMap);
    // Restore pre-computed table rows so switching to Table view doesn't need
    // to re-fetch all references from the server (preserves MedScan IDs and
    // sentence colouring even when medScanMap hadn't finished loading at capture time).
    tableRows  = s.tableRows ? JSON.parse(JSON.stringify(s.tableRows)) : [];
  }
  columnWidths = s.columnWidths ? Object.assign({}, s.columnWidths) : null;
  tableViewMode = s.tableViewMode || 'reference';
  syncTableModeIndicator(tableViewMode);
  updateViewMenu('graph');  // always land on Graph view; must run after syncTableModeIndicator
  updateSelectionInfo();
}

function createNewTab(name) {
  if (tabs.length > 0 && activeTabIdx >= 0 && activeTabIdx < tabs.length) {
    tabs[activeTabIdx].snapshot = captureTabState();
  }
  var idx = tabs.length;
  tabs.push({
    id: Date.now() + idx,
    name: name || ('Pathway ' + (idx + 1)),
    snapshot: emptyTabSnapshot()
  });
  activeTabIdx = idx;
  renderTabBar();
  applyTabState(tabs[activeTabIdx].snapshot);
}

function switchTab(idx) {
  if (idx === activeTabIdx || idx < 0 || idx >= tabs.length) return;
  tooltipVisible = false;
  document.getElementById('tooltip').style.display = 'none';
  tabs[activeTabIdx].snapshot = captureTabState();
  activeTabIdx = idx;
  renderTabBar();
  applyTabState(tabs[activeTabIdx].snapshot);
}

function closeTab(idx, event) {
  if (event) { event.stopPropagation(); event.preventDefault(); }
  if (tabs.length <= 1) return;
  tabs.splice(idx, 1);
  if (activeTabIdx >= tabs.length) activeTabIdx = tabs.length - 1;
  else if (activeTabIdx > idx)     activeTabIdx--;
  renderTabBar();
  applyTabState(tabs[activeTabIdx].snapshot);
}

function renderTabBar() {
  var list = document.getElementById('tab-list');
  if (!list) return;
  list.innerHTML = '';
  tabs.forEach(function(tab, idx) {
    var div = document.createElement('div');
    div.className = 'tab-item' + (idx === activeTabIdx ? ' active' : '');
    var closeHtml = tabs.length > 1
      ? '<span class="tab-close" title="Close tab">\xd7</span>'
      : '';
    div.innerHTML = '<span class="tab-name" title="' + escHtml(tab.name) + '">'
      + escHtml(tab.name) + '</span>' + closeHtml;
    div.addEventListener('click', (function(i) {
      return function(e) {
        if (e.target.classList.contains('tab-close')) closeTab(i, e);
        else switchTab(i);
      };
    })(idx));
    list.appendChild(div);
  });
}

// ─── Tab name helper ──────────────────────────────────────────────────────────
function updateCurrentTabName(name) {
  if (!name) return;
  if (activeTabIdx >= 0 && activeTabIdx < tabs.length) {
    tabs[activeTabIdx].name = name;
    renderTabBar();
  }
}

// ─── Selection helpers ───────────────────────────────────────────────────────
var boxSelectActive = false;

function toggleMoveMode() {
  if (!cy) return;
  var active = document.getElementById('mc-move-mode').textContent === '✓';
  if (active) {
    // turn off move mode — back to default box-select on drag
    cy.userPanningEnabled(false);
    document.getElementById('mc-move-mode').textContent = '';
  } else {
    // turn on move mode — plain drag pans the graph
    if (boxSelectActive) { _endBoxSelect(); }
    cy.userPanningEnabled(true);
    document.getElementById('mc-move-mode').textContent = '✓';
  }
}

function toggleBoxSelect() {
  if (!cy) return;
  boxSelectActive = !boxSelectActive;
  if (boxSelectActive) {
    cy.userPanningEnabled(false); // disabling pan makes drag = box select
    cy.elements().removeClass('faded');
  } else {
    _endBoxSelect();
  }
  var item = document.getElementById('me-select-area');
  if (item) item.style.color = boxSelectActive ? '#4f8ef7' : '';
  closeMenus();
}

function _endBoxSelect() {
  boxSelectActive = false;
  // Restore default: panning disabled so drag = box select
  // (unless Move mode is active)
  if (cy) {
    var moveActive = document.getElementById('mc-move-mode') &&
                     document.getElementById('mc-move-mode').textContent === '✓';
    if (!moveActive) cy.userPanningEnabled(false);
  }
  var item = document.getElementById('me-select-area');
  if (item) item.style.color = '';
}

function _installRubberBand() { /* selection handled natively by Cytoscape */ }

function invertSelection() {
  if (!cy) return;
  var sel = cy.elements(':selected');
  var unsel = cy.elements(':unselected');
  sel.unselect();
  unsel.select();
  updateSelectionInfo();
}

function copySelection() {
  if (!cy) return;
  var selNodes = cy.nodes(':selected');
  var selEdges = cy.edges(':selected');
  if (selNodes.length === 0 && selEdges.length === 0) return;

  // When edges are selected, also pull in their endpoint nodes
  var nodeMap = {};
  selNodes.forEach(function(n) { nodeMap[n.id()] = n; });
  selEdges.forEach(function(e) {
    nodeMap[e.source().id()] = e.source();
    nodeMap[e.target().id()] = e.target();
  });
  var nodesToCopy = Object.values(nodeMap);

  graphClipboard = {
    nodes: nodesToCopy.map(function(n) {
      var nUrn = n.data('URN');
      var gnRaw = graphData.nodes.find(function(gn) {
        return gn.id === n.id() ||
               (nUrn && gn.properties && gn.properties.URN === nUrn);
      });
      return {
        data: Object.assign({}, n.data()),
        position: Object.assign({}, n.position()),
        raw: gnRaw ? JSON.parse(JSON.stringify(gnRaw)) : null
      };
    }),
    edges: selEdges.map(function(e) {
      var geRaw = graphData.edges.find(function(ge) { return ge.id === e.id(); });
      return {
        data: Object.assign({}, e.data()),
        raw: geRaw ? JSON.parse(JSON.stringify(geRaw)) : null
      };
    })
  };

  var mi = document.getElementById('mi-paste');
  if (mi) mi.classList.remove('disabled');
  var statsEl = document.getElementById('graph-stats');
  if (statsEl) {
    var nc = graphClipboard.nodes.length, ec = graphClipboard.edges.length;
    var parts = [];
    if (nc) parts.push(nc + ' node' + (nc !== 1 ? 's' : ''));
    if (ec) parts.push(ec + ' edge' + (ec !== 1 ? 's' : ''));
    statsEl.innerHTML = '<span style="color:#2a9d2a">' + parts.join(' and ') + ' are in clipboard</span>';
  }
}


async function fetchMedScanForNodes(nodes) {
  // Fetch MedScan IDs for any NodeIDs not yet in medScanMap
  var missing = nodes
    .map(function(n) { return n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null; })
    .filter(function(id) { return id && !medScanMap[id]; });
  if (!missing.length) return;
  try {
    var result = await api('/api/nodes/medscan', { nodeIds: missing });
    Object.assign(medScanMap, result);
  } catch(err) {
    console.warn('MedScan lookup after paste failed:', err.message);
  }
}

function pasteClipboard() {
  if (!cy || !graphClipboard) return;
  cy.elements(':selected').unselect();
  var idMap = {};
  var offset = 60;
  graphClipboard.nodes.forEach(function(n) {
    var newId = n.data.id + '__paste__' + Date.now() + Math.random().toString(36).slice(2, 6);
    idMap[n.data.id] = newId;
    var newData = Object.assign({}, n.data, { id: newId, elementId: newId });
    var newNode = cy.add({ group: 'nodes', data: newData,
      position: { x: n.position.x + offset, y: n.position.y + offset } });
    newNode.select();
    var srcUrn = n.data.URN;
    var srcGn = n.raw || graphData.nodes.find(function(gn) {
      return gn.id === n.data.id ||
             (srcUrn && gn.properties && gn.properties.URN === srcUrn);
    });
    graphData.nodes.push({
      id: newId, elementId: newId,
      labels:    srcGn ? srcGn.labels.slice() : [n.data.nodeType || 'Unknown'],
      properties: srcGn ? Object.assign({}, srcGn.properties) : {}
    });
  });
  graphClipboard.edges.forEach(function(e) {
    var newSrc = idMap[e.data.source] || e.data.source;
    var newTgt = idMap[e.data.target] || e.data.target;
    var newEid = e.data.id + '__paste__' + Date.now() + Math.random().toString(36).slice(2, 6);
    cy.add({ group: 'edges',
      data: Object.assign({}, e.data, { id: newEid, elementId: newEid, source: newSrc, target: newTgt }) });
    if (e.raw) {
      var newRaw = JSON.parse(JSON.stringify(e.raw));
      newRaw.id = newEid;
      newRaw.elementId = newEid;
      newRaw.startNodeId = newSrc;
      newRaw.endNodeId = newTgt;
      graphData.edges.push(newRaw);
    } else {
      graphData.edges.push({
        id: newEid, elementId: newEid,
        startNodeId: newSrc, endNodeId: newTgt,
        type: e.data.relType || '',
        properties: {
          RelationID: e.data.relId || '',
          RelationNumberOfReferences: e.data.numRefs || 0,
          Effect: e.data.effect || '',
          Mechanism: e.data.mechanism || '',
          'Confidence (%)': e.data.confidence || '',
          'Citation score': e.data.citationScore || ''
        }
      });
    }
  });
  tableRows = [];
  var pastedNodes = graphClipboard.nodes.map(function(n) {
    return n.raw || { properties: n.data };
  });
  fetchMedScanForNodes(pastedNodes);
  setTimeout(function() { cy.fit(cy.elements(), 40); }, 50);
  var nc = graphClipboard.nodes.length, ec = graphClipboard.edges.length;
  var parts = [];
  if (nc) parts.push(nc + ' node' + (nc !== 1 ? 's' : ''));
  if (ec) parts.push(ec + ' edge' + (ec !== 1 ? 's' : ''));
  var statsEl = document.getElementById('graph-stats');
  if (statsEl) {
    statsEl.innerHTML = '<span style="color:#4f8ef7">' + parts.join(' and ') + ' pasted</span>';
    setTimeout(updateStats, 2500);
  } else { updateStats(); }
}

function deleteSelection() {
  if (!cy) return;
  var sel = cy.elements(':selected');
  if (sel.length === 0) return;
  var selIds = new Set(sel.map(function(el) { return el.id(); }));
  sel.remove();
  graphData.nodes = graphData.nodes.filter(function(n) { return !selIds.has(n.id); });
  graphData.edges = graphData.edges.filter(function(e) { return !selIds.has(e.id); });
  updateStats();
}