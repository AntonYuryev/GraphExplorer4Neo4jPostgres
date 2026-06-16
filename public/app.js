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
let tooltipMouseInside = false;  // true while mouse cursor is inside the tooltip element
let tooltipRefSortAsc = true;    // true = oldest first, false = newest first
let tooltipCurrentRefs = [];     // refs array saved for sort toggle
let tooltipCurrentEdge = null;   // cy edge element currently shown in tooltip
let pendingMatchSpan = null;     // #match-rnef-status span waiting to be cleared after tooltip renders
let matchedRelIds = new Set();   // relIds newly matched by matchRnefRelationsToNeo4j
let matchingInProgress = false;  // true while matchRnefRelationsToNeo4j API call is in flight
let tabDragSrcIdx = -1;          // index of tab being dragged
let medScanMap = {};   // Neo4j NodeID (string) → MedScan ID value
let tooltipHideTimer = null;
let tooltipShowTimer = null;  // delay before tooltip appears (500 ms)
let lastMouseX = 0, lastMouseY = 0;
let tableRows = [];                          // all table rows
let tableSortCol = null;
let tableSortAsc = true;
let currentLayout = 'cose';
let currentStyle  = 'default';
let currentSubgraphName = '';   // name from loaded JSON file
let contextTarget = null;   // element targeted by right-click
let curationTarget = null;  // element open in curation modal
let undoStack = [];          // stack of {graphData, positions} snapshots for undo
let _dragUndoPushed = false; // guard: push only one undo snapshot per drag gesture
let redoStack = [];          // stack of {graphData, positions} snapshots for redo
let focusNodeId = null;      // reference node for alignment operations
let _loadedPropertyNames = new Set();  // property names loaded via "Load node properties" dialog

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

// Returns '#000000' or '#ffffff' — whichever contrasts better against the given hex color.
function contrastColor(hex) {
  if (!hex || hex.length < 7) return '#ffffff';
  var r = parseInt(hex.slice(1, 3), 16);
  var g = parseInt(hex.slice(3, 5), 16);
  var b = parseInt(hex.slice(5, 7), 16);
  var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

const NODE_COLORS = {
  // Node types — Pathway Studio colour scheme
  Protein:           '#d32f2f',  // red
  SmallMol:          '#00C853',  // bright green
  Treatment:         '#1565c0',  // blue
  Disease:           '#CC5500',  // burnt orange
  CellProcess:       '#f9a825',  // yellow
  FunctionalClass:   '#e65100',  // orange
  Complex:           '#7f0000',  // dark red
  CellObject:        '#757575',  // gray
  Tissue:            '#6d4c41',  // brown
  Organ:             '#4a148c',  // dark violet
  CellType:          '#81d4fa',  // light blue
  GeneticVariant:    '#FF6D00',  // vibrant orange
  ClinicalParameter: '#5C6BC0',  // slate blue
  MedicalProcedure:  '#5dd6c5',  // teal
  Pathogen:          '#61DE2A',  // toxic green
  Virus:             '#B5BF50',  // bright chartreuse
  ChemicalReaction:  '#212121',  // black
  // Legacy / fallback node types
  Gene:              '#388e3c',
  Drug:              '#1565c0',
  Chemical:          '#00C853',
  Pathway:           '#7b1fa2',
  Cell:              '#81d4fa',
  Bacteria:          '#61DE2A',
  Reaction:          '#999999'
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
  // RelationNumberOfSentences is exposed as a graph-source column ('numSentences')
  // so it appears in both Relation and Reference views — omitted here to avoid duplication.
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
  { key: 'numRefs',       label: 'Reference count',  visible: true,  source: 'graph', numeric: true },
  { key: 'numSentences',  label: 'Assertion count',  visible: true,  source: 'graph', numeric: true },
  { key: 'pmid',          label: 'PMID',           visible: true,  source: 'reference', dbField: 'pmid' },
  { key: 'doi',           label: 'DOI',            visible: true,  source: 'reference', dbField: 'doi' },
  { key: 'year',          label: 'Year',           visible: true,  source: 'reference', dbField: 'pubyear', numeric: true },
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
    _loadSchema(); // Preload schema if already logged in
  }
  // Hide autocomplete dropdown when textarea loses focus
  document.addEventListener('focusout', function(e) {
    if (e.target && e.target.id === 'cypher-input') {
      // Small delay so mousedown on suggestion fires first
      setTimeout(_acHide, 150);
    }
  });
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
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoGraphOperation();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      redoGraphOperation();
    } else if (e.key === 'Delete') {
      deleteSelection();
    }
  });

  var tipEl = document.getElementById('tooltip');
  // Handle sort-button click BEFORE the blanket event suppressor below.
  tipEl.addEventListener('click', function(e) {
    var btn = e.target.closest('#tooltip-sort-btn');
    if (!btn) return;
    e.stopPropagation();
    tooltipRefSortAsc = !tooltipRefSortAsc;
    var block = document.getElementById('tooltip-refs-block');
    if (block && block.parentNode) {
      var tmp = document.createElement('div');
      tmp.innerHTML = renderRefsHtml(tooltipCurrentRefs, tooltipRefSortAsc);
      block.parentNode.replaceChild(tmp.firstChild, block);
    }
  }, { capture: true });
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
  // Also set tooltipMouseInside so Cytoscape mouseover on underlying nodes/edges
  // cannot replace the current tooltip while the cursor is inside it.
  tipEl.addEventListener('mouseenter', function() {
    tooltipMouseInside = true;
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  });
  tipEl.addEventListener('mouseleave', function() {
    tooltipMouseInside = false;
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
    // Preload schema for autocomplete in background
    _loadSchema();
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
    document.getElementById('admin-btn') && (document.getElementById('admin-btn').style.display = '');
    document.getElementById('settings-users-item').style.display = '';
    document.getElementById('settings-db-section').style.display = '';
  }
  // Load saved column config or fall back to defaults
  columnDefs = loadColumnConfig() || DEFAULT_COLUMNS.map(function(c) { return Object.assign({}, c); });
  // Migration: inject numSentences column if absent (added after initial release)
  if (!columnDefs.find(function(c) { return c.key === 'numSentences'; })) {
    var numRefsIdx = columnDefs.findIndex(function(c) { return c.key === 'numRefs'; });
    var newCol = { key: 'numSentences', label: 'Assertion count', visible: true, source: 'graph', numeric: true };
    if (numRefsIdx >= 0) columnDefs.splice(numRefsIdx + 1, 0, newCol);
    else columnDefs.push(newCol);
  }
  // Migration: ensure numeric flag is set on numRefs (may be absent in older saved configs)
  var numRefsCol = columnDefs.find(function(c) { return c.key === 'numRefs'; });
  if (numRefsCol) numRefsCol.numeric = true;
  // Fetch available DB column lists (used by Columns dialog)
  api('/api/schema/columns', null).then(function(data) {
    availableDbColumns = { reference: data.reference || [], scopus_data: data.scopus_data || [] };
  }).catch(function() {});
  initCytoscape();
  setTimeout(_loadSchema, 200); // Preload schema for autocomplete

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
function setProgressMsg(msg) {
  var el = document.getElementById('progress-msg');
  if (!el) return;
  if (msg) { el.textContent = msg; el.style.display = 'inline-block'; }
  else      { el.textContent = '';  el.style.display = 'none'; }
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '';
  if (seconds < 90) return Math.ceil(seconds) + ' sec';
  return Math.ceil(seconds / 60) + ' min';
}

// Yield to the event loop so the browser can repaint before starting heavy sync work.
function yieldToUI() { return new Promise(function(r) { setTimeout(r, 0); }); }

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
    if (tooltipMouseInside) return;  // don't replace tooltip while cursor is inside it
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    var edge = evt.target;
    var pos = evt.originalEvent || { clientX: 0, clientY: 0 };
    tooltipShowTimer = setTimeout(async function() {
      tooltipShowTimer = null;
      showTooltipLoading();
      tooltipVisible = true;
      positionTooltip(lastMouseX, lastMouseY);
      var relId  = edge.data('relId');
      var relIds = edge.data('relIds') || (relId ? [relId] : []);
      // Fetch refs for all RelationIDs (merged edge may have several); cache under primary relId
      var cacheKey = relId || (relIds.length ? relIds[0] : null);
      if (cacheKey && refsCache[cacheKey] === undefined) {
        try {
          var rows = await api('/api/references', { relationIds: relIds.length ? relIds : [cacheKey] });
          refsCache[cacheKey] = rows;
        } catch(e) { refsCache[cacheKey] = []; }
      }
      // Fall back to inline references stored in graphData.edges (e.g. pasted or RNEF edges)
      var refs = (cacheKey && refsCache[cacheKey]) || [];
      if (!refs.length) {
        var edgeRaw = graphData.edges.find(function(ge) { return ge.id === edge.id(); });
        if (edgeRaw && edgeRaw.properties && Array.isArray(edgeRaw.properties.references)) {
          refs = edgeRaw.properties.references;
        }
      }
      tooltipCurrentEdge = edge;
      renderTooltip(edge, refs);
    }, 500);
  });

  cy.on('mouseout', 'edge', function() {
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
  });

  // Tooltip on node hover
  cy.on('mouseover', 'node', function(evt) {
    if (document.getElementById('curation-modal').style.display !== 'none') return;
    if (tooltipMouseInside) return;  // don't replace tooltip while cursor is inside it
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
    var isCtrl = evt.originalEvent && (evt.originalEvent.ctrlKey || evt.originalEvent.metaKey);
    if (isCtrl) {
      // Ctrl+click: designate this node as alignment anchor without changing neighbourhood fade
      setFocusNode(node.id());
      return;
    }
    cy.elements().removeClass('faded');
    var hood = node.closedNeighborhood();
    cy.elements().not(hood).addClass('faded');
    // Regular click also sets focus and shows resize handles
    setFocusNode(node.id());
    showResizeHandles(node);
  });

  cy.on('tap', function(evt) {
    if (evt.target === cy) {
      setFocusNode(null);
      hideResizeHandles();
      cy.elements().removeClass('faded');
      // Hide tooltip when clicking empty canvas area.
      tooltipVisible = false;
      if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
      if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
      document.getElementById('tooltip').style.display = 'none';
    }
  });

  // Resize handles: hide while dragging node, restore after.
  // Also dismiss the tooltip immediately on grab so it doesn't block dragging.
  cy.on('grab', 'node', function(evt) {
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    tooltipVisible = false;
    document.getElementById('tooltip').style.display = 'none';
    if (_rhNode && evt.target.id() === _rhNode.id()) hideResizeHandles();
    // Snapshot before drag so each node move is independently undoable.
    // Guard with _dragUndoPushed: when multiple nodes are selected and dragged
    // together, Cytoscape fires 'grab' on every node in the selection — without
    // the guard this pushes N identical snapshots onto the undo stack.
    if (!_dragUndoPushed) {
      _dragUndoPushed = true;
      pushUndo();
    }
  });
  cy.on('dragfree', 'node', function(evt) {
    _dragUndoPushed = false;  // reset so the next drag gets its own snapshot
    currentLayout = 'manual';
    // Re-show handles if this was the focused node
    if (focusNodeId && evt.target.id() === focusNodeId) showResizeHandles(evt.target);
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
    var SKIP = { id:1, elementId:1, label:1, color:1, nodeType:1, source:1, target:1,
                 customColor:1, customTextColor:1, highlightColor:1, rnefShape:1,
                 nodeWidth:1, nodeHeight:1, nodeFontSize:1, isClone:1, cloneOf:1 };
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
  cy.on('zoom pan', repositionResizeHandles);
  cy.on('position', 'node', function(evt) {
    if (_rhNode && evt.target.id() === _rhNode.id()) repositionResizeHandles();
  });

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
  ['cose','dagre','circle','concentric','grid','klay'].forEach(function(l) {
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

// ─── Cypher query bar: auto-resize + live linting ────────────────────────────

function getCypherQuery() {
  return (document.getElementById('cypher-input') || {}).value || '';
}
function setCypherQuery(val) {
  var el = document.getElementById('cypher-input');
  if (!el) return;
  el.value = val || '';
  cypherAutoResize(el);
}

// Grow/shrink the textarea to fit its content (single line minimum).
function cypherAutoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}

// Called on every keystroke (oninput handler in HTML).
var _lintDebounce = null;

// ─── Cypher Schema Autocomplete ───────────────────────────────────────────────
var _schemaCache = null;          // { labels, relTypes, propKeys }
var _acSelectedIdx = -1;          // currently highlighted row index
var _acItems = [];                 // current suggestion list

var CYPHER_KEYWORDS = [
  'MATCH','OPTIONAL MATCH','WHERE','RETURN','WITH','UNWIND','CREATE','MERGE',
  'SET','REMOVE','DELETE','DETACH DELETE','FOREACH','CALL','YIELD','UNION',
  'ORDER BY','SKIP','LIMIT','AS','DISTINCT','NOT','AND','OR','XOR','IN',
  'STARTS WITH','ENDS WITH','CONTAINS','IS NULL','IS NOT NULL','EXISTS',
  'COUNT','COLLECT','SUM','AVG','MIN','MAX','KEYS','LABELS','TYPE','ID',
  'toInteger','toString','toFloat','toLower','toUpper','trim','split','size',
  'head','last','tail','range','coalesce','datetime','date','time','duration',
  'shortestPath','allShortestPaths','nodes','relationships','length'
];

function _loadSchema() {
  if (_schemaCache) return Promise.resolve(_schemaCache);
  if (!authToken) return Promise.resolve(null);   // not logged in yet
  return fetch('/api/graph/schema', {
    headers: { 'Authorization': 'Bearer ' + authToken }
  })
  .then(function(r) { return r.ok ? r.json() : null; })
  .then(function(d) {
    if (d && d.labels) _schemaCache = d;  // only cache valid schema response
    return _schemaCache;
  })
  .catch(function() { return null; });
  // Note: on failure _schemaCache stays null so next keystroke retries
}

// Invalidate schema cache when user reconnects to a different DB
function _invalidateSchemaCache() { _schemaCache = null; }

function _acShow(items, ta) {
  var box = document.getElementById('cypher-autocomplete');
  if (!box) return;
  _acItems = items;
  _acSelectedIdx = -1;
  if (!items.length) { _acHide(); return; }
  box.innerHTML = '';
  items.forEach(function(item, i) {
    var row = document.createElement('div');
    row.textContent = item.text;
    row.style.cssText = 'padding:4px 12px;cursor:pointer;color:' + (item.kind === 'keyword' ? '#e5c07b' : item.kind === 'label' ? '#98c379' : item.kind === 'reltype' ? '#61afef' : '#c678dd') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    row.dataset.idx = i;
    row.addEventListener('mousedown', function(e) {
      e.preventDefault();
      _acAccept(ta, items[i]);
    });
    row.addEventListener('mouseover', function() {
      _acSetIdx(parseInt(row.dataset.idx), box);
    });
    box.appendChild(row);
  });
  box.style.display = 'block';
}

function _acHide() {
  var box = document.getElementById('cypher-autocomplete');
  if (box) box.style.display = 'none';
  _acItems = [];
  _acSelectedIdx = -1;
}

function _acSetIdx(idx, box) {
  if (!box) box = document.getElementById('cypher-autocomplete');
  if (!box) return;
  _acSelectedIdx = idx;
  Array.from(box.children).forEach(function(row, i) {
    row.style.background = (i === idx) ? '#2a3050' : 'transparent';
  });
}

function _acAccept(ta, item) {
  var val = ta.value;
  var pos = ta.selectionStart;
  // find start of the current token being typed
  var tokenStart = pos;
  if (item.kind === 'label' || item.kind === 'propkey') {
    // back up over word chars
    while (tokenStart > 0 && /[\w]/.test(val[tokenStart - 1])) tokenStart--;
  } else if (item.kind === 'reltype') {
    while (tokenStart > 0 && /[\w]/.test(val[tokenStart - 1])) tokenStart--;
  } else {
    // keyword — back up over letters
    while (tokenStart > 0 && /[A-Za-z_]/.test(val[tokenStart - 1])) tokenStart--;
  }
  var insert = item.text;
  ta.value = val.substring(0, tokenStart) + insert + val.substring(pos);
  ta.selectionStart = ta.selectionEnd = tokenStart + insert.length;
  _acHide();
  onCypherInput(ta);
}

function _acHandleKey(e) {
  var box = document.getElementById('cypher-autocomplete');
  if (!box || box.style.display === 'none' || !_acItems.length) return false;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _acSetIdx(Math.min(_acSelectedIdx + 1, _acItems.length - 1), box);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    _acSetIdx(Math.max(_acSelectedIdx - 1, 0), box);
    return true;
  }
  if (e.key === 'Tab' || e.key === 'Enter') {
    if (_acSelectedIdx >= 0 && _acItems[_acSelectedIdx]) {
      e.preventDefault();
      _acAccept(e.target, _acItems[_acSelectedIdx]);
      return true;
    }
  }
  if (e.key === 'Escape') {
    _acHide();
    return true;
  }
  return false;
}

// Detect autocomplete context from cursor position and trigger suggestions
function _acTrigger(ta) {
  var val = ta.value;
  var pos = ta.selectionStart;
  var before = val.substring(0, pos);

  // Don't show inside a string literal
  var inStr = false, strChar = '';
  for (var ci = 0; ci < before.length; ci++) {
    var ch = before[ci];
    if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strChar = ch; }
    else if (inStr && ch === strChar && before[ci-1] !== '\\') inStr = false;
  }
  if (inStr) { _acHide(); return; }

  // Context: after (: or [: → node label / rel type
  var mLabel = before.match(/\((?:[^()]*:)?\s*([\w]*)$/);
  var mRel   = before.match(/\[(?:[^\[\]]*:)?\s*([\w]*)$/);

  // Context: after . or { → property key
  var mProp  = before.match(/[\w\)}\]]\.([\w]*)$/) || before.match(/\{[^{}]*([\w]*)$/);

  // Generic word at cursor → keywords
  var mWord  = before.match(/(?:^|[\s,])([A-Za-z_][\w ]*)$/);

  _loadSchema().then(function(schema) {
    var suggestions = [];
    var typed = '';

    if (mRel) {
      // relationship type context
      typed = mRel[1] || '';
      var pool = schema ? schema.relTypes : [];
      suggestions = pool
        .filter(function(t) { return t.toLowerCase().startsWith(typed.toLowerCase()); })
        .slice(0, 20)
        .map(function(t) { return { text: t, kind: 'reltype' }; });
    } else if (mLabel) {
      // node label context
      typed = mLabel[1] || '';
      var pool = schema ? schema.labels : [];
      suggestions = pool
        .filter(function(l) { return l.toLowerCase().startsWith(typed.toLowerCase()); })
        .slice(0, 20)
        .map(function(l) { return { text: l, kind: 'label' }; });
    } else if (mProp) {
      // property key context
      typed = mProp[1] || '';
      var pool = schema ? schema.propKeys : [];
      suggestions = pool
        .filter(function(k) { return k.toLowerCase().startsWith(typed.toLowerCase()); })
        .slice(0, 20)
        .map(function(k) { return { text: k, kind: 'propkey' }; });
    } else if (mWord) {
      typed = mWord[1].replace(/\s+$/, '');
      if (typed.length >= 2) {
        suggestions = CYPHER_KEYWORDS
          .filter(function(kw) { return kw.toLowerCase().startsWith(typed.toLowerCase()); })
          .slice(0, 12)
          .map(function(kw) { return { text: kw, kind: 'keyword' }; });
      }
    }

    if (suggestions.length) {
      _acShow(suggestions, ta);
    } else {
      _acHide();
    }
  });
}

function onCypherInput(ta) {
  cypherAutoResize(ta);
  // Autocomplete
  _acTrigger(ta);
  // Immediate structural check (brackets / quotes)
  var structErr = cypherStructuralCheck(ta.value);
  if (structErr) { showCypherLint('error', structErr); return; }
  showCypherLint(null);   // clear panel while EXPLAIN is pending
  // Debounce Neo4j EXPLAIN lint
  if (_lintDebounce) clearTimeout(_lintDebounce);
  _lintDebounce = setTimeout(function() {
    _lintDebounce = null;
    runCypherExplainLint(ta.value);
  }, 1200);
}

// Check bracket/quote balance. Returns error string or null.
function cypherStructuralCheck(text) {
  var stack = [];
  var OPEN  = { '(': ')', '[': ']', '{': '}' };
  var CLOSE = new Set([')', ']', '}']);
  var inSingle = false, inDouble = false, inBacktick = false;

  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    var prev = i > 0 ? text[i - 1] : '';

    if (!inDouble && !inBacktick && c === "'") {
      if (inSingle && prev !== '\\') inSingle = false;
      else if (!inSingle) inSingle = true;
      continue;
    }
    if (!inSingle && !inBacktick && c === '"') {
      if (inDouble && prev !== '\\') inDouble = false;
      else if (!inDouble) inDouble = true;
      continue;
    }
    if (!inSingle && !inDouble && c === '`') { inBacktick = !inBacktick; continue; }
    if (inSingle || inDouble || inBacktick) continue;

    // Skip // line comments
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }

    if (OPEN[c]) {
      stack.push(c);
    } else if (CLOSE.has(c)) {
      var expected = OPEN[stack[stack.length - 1]];
      if (stack.length && expected === c) { stack.pop(); }
      else { return 'Unmatched "' + c + '" at position ' + i; }
    }
  }
  if (inSingle)   return 'Unclosed single-quote string';
  if (inDouble)   return 'Unclosed double-quote string';
  if (inBacktick) return 'Unclosed backtick identifier';
  if (stack.length) return 'Unclosed "' + stack[stack.length - 1] + '"';

  // Extra syntactic checks on the text outside string literals
  var stripped = _stripCypherStrings(text);
  // Dot followed by whitespace then identifier: r. Source  or  r. r.Source
  if (/\.\s+[\w]/.test(stripped)) {
    var _dm = stripped.match(/\b(\w+)\.\s+/);
    var _hint = _dm ? '"' + _dm[1] + '.\u2026"' : 'a property access';
    return 'Invalid property access: space after "." in ' + _hint + ' (remove the space)';
  }
  // Consecutive dots
  if (/\w\.\.[\w]/.test(stripped))
    return 'Invalid property access: consecutive dots';

  return null;
}

// Strip string literals → spaces for structural pattern checks.
function _stripCypherStrings(text) {
  var out = '', inS = false, inD = false, inB = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i], prev = i > 0 ? text[i-1] : '';
    if (!inD && !inB && c === "'") { inS = !inS; out += ' '; continue; }
    if (!inS && !inB && c === '"') { inD = !inD; out += ' '; continue; }
    if (!inS && !inD && c === '`') { inB = !inB; out += ' '; continue; }
    out += (inS || inD || inB) ? ' ' : c;
  }
  return out;
}


// Detect semantic issues EXPLAIN misses (runtime type errors etc.)
function cypherSemanticWarn(text) {
  var stripped = _stripCypherStrings(text);

  // Bare property access used as a boolean condition:
  //   WHERE r.Prop AND ...  /  AND r.Prop RETURN ...  /  WHERE r.Prop<EOL>
  // False-positive guard: skip if immediately followed by a comparison operator
  var boolRe = /\b(?:WHERE|AND|OR)\s+(\w+\.\w+)\s*(?=AND\b|OR\b|RETURN\b|WITH\b|LIMIT\b|ORDER\b|SKIP\b|$)/gi;
  var m;
  while ((m = boolRe.exec(stripped)) !== null) {
    // Make sure what follows the property isn't a comparison operator
    var after = stripped.slice(m.index + m[0].length);
    if (/^\s*[=<>!]|^\s+(?:IS|IN|CONTAINS|STARTS|ENDS)\b/i.test(after)) continue;
    return '\u26a0 Possible type error: "' + m[1] + '" is used as a boolean — ' +
           'did you mean "' + m[1] + ' > 0" or "' + m[1] + ' IS NOT NULL"?';
  }
  return null;
}

async function runCypherExplainLint(text) {
  if (!text.trim() || !authToken) return;
  try {
    var result = await api('/api/graph/lint', { query: text });
    if (!result.ok && result.error) {
      var e = result.error;
      var msg = e.message
        .replace(/^Neo\.\w+\.\w+\.\w+:\s*/i, '')            // strip Neo4j error code prefix
        .replace(/\s*\(line\s+\d+,\s+column\s+\d+.*$/i, '') // strip position suffix
        .trim();
      var loc = '';
      if (e.line != null) loc = ' (line ' + (e.line + 1) + ', col ' + (e.column + 1) + ')';
      showCypherLint('error', msg + loc);
    } else {
      // EXPLAIN passed — still check for semantic issues EXPLAIN can't catch
      var semWarn = cypherSemanticWarn(text);
      if (semWarn) {
        showCypherLint('warn', semWarn);
      } else {
        showCypherLint('ok', '✓ Syntax OK');
      }
    }
  } catch(_) { /* network error — stay silent */ }
}

function showCypherLint(level, msg) {
  var panel = document.getElementById('cypher-lint-panel');
  if (!panel) return;
  if (!level) { panel.style.display = 'none'; panel.textContent = ''; return; }
  panel.className = 'lint-' + level;
  panel.textContent = msg || '';
  panel.style.display = 'block';
}

function focusCypherInput() {
  var bar = document.getElementById('query-bar');
  if (!bar) return;
  var wasHidden = bar.style.display === 'none';
  bar.style.display = wasHidden ? '' : 'none';
  if (wasHidden) {
    var el = document.getElementById('cypher-input');
    if (el) {
      cypherAutoResize(el);
      setTimeout(function() { el.focus(); el.select(); }, 10);
    }
  }
}

// ─── SQL query dialog ─────────────────────────────────────────────────────────
// ─── Load Node Properties ─────────────────────────────────────────────────────
async function openLoadNodePropertiesDialog() {
  var modal  = document.getElementById('load-props-modal');
  var list   = document.getElementById('load-props-list');
  var status = document.getElementById('load-props-status');
  list.innerHTML = '<span style="color:#7a8099;font-size:12px">Loading…</span>';
  status.textContent = '';
  modal.style.display = 'flex';

  if (!graphData || !graphData.nodes || !graphData.nodes.length) {
    list.innerHTML = '<span style="color:#7a8099;font-size:12px">No pathway loaded.</span>';
    return;
  }

  // Collect numeric NodeIDs from current pathway
  var nodeIds = [];
  graphData.nodes.forEach(function(n) {
    var nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
    if (nid && /^-?\d+$/.test(nid)) nodeIds.push(nid);
  });

  try {
    var names = await api('/api/nodes/property-names', { nodeIds: nodeIds });
    if (!Array.isArray(names) || !names.length) {
      list.innerHTML = '<span style="color:#7a8099;font-size:12px">No properties found for nodes in this pathway.</span>';
      return;
    }
    list.innerHTML = names.map(function(n) {
      var id = 'lpp-' + n.replace(/[^a-zA-Z0-9]/g, '_');
      return '<label style="display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;cursor:pointer">'
        + '<input type="checkbox" id="' + id + '" data-prop="' + escHtml(n) + '">'
        + escHtml(n) + '</label>';
    }).join('');
  } catch (err) {
    list.innerHTML = '<span style="color:#e05560;font-size:12px">' + escHtml(err.message) + '</span>';
  }
}

function closeLoadPropsModal(e) {
  var modal = document.getElementById('load-props-modal');
  if (!e || e.target === modal) modal.style.display = 'none';
}

function loadPropsSelectAll(checked) {
  document.querySelectorAll('#load-props-list input[type=checkbox]')
    .forEach(function(cb) { cb.checked = checked; });
  ['load-props-degree', 'load-props-neighbor-count'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.checked = checked;
  });
}

async function executeLoadNodeProperties() {
  var status = document.getElementById('load-props-status');
  var btn    = document.getElementById('load-props-upload-btn');

  var selected = Array.from(document.querySelectorAll('#load-props-list input[type=checkbox]:checked'))
    .map(function(cb) { return cb.getAttribute('data-prop'); });

  if (!cy || !graphData) { status.textContent = 'No pathway loaded.'; return; }

  // Collect node IDs and URNs from current pathway
  var nodeIds = [], urns = [];
  graphData.nodes.forEach(function(n) {
    var nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
    var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
    if (nid && /^-?\d+$/.test(nid)) nodeIds.push(nid);
    else if (urn) urns.push(urn);
  });

  if (!nodeIds.length && !urns.length) {
    status.textContent = 'No nodes with database IDs found in pathway.';
    return;
  }

  var loadDegree        = !!(document.getElementById('load-props-degree') &&
                              document.getElementById('load-props-degree').checked);
  var loadNeighborCount = !!(document.getElementById('load-props-neighbor-count') &&
                              document.getElementById('load-props-neighbor-count').checked);

  if (!selected.length && !loadDegree && !loadNeighborCount) { status.textContent = 'Select at least one property.'; return; }

  btn.disabled = true;
  status.textContent = 'Loading…';
  try {
    var result = selected.length
      ? await api('/api/nodes/load-properties', { nodeIds: nodeIds, urns: urns, properties: selected })
      : { byNodeId: {}, byUrn: {} };
    var byNodeId = result.byNodeId || {};
    var byUrn    = result.byUrn    || {};

    // Build URN → [cy elements] lookup (array so clones with same URN are all included).
    // IMPORTANT: after enrichNodesFromNeo4j, graphData.nodes[i].id is updated to the
    // Neo4j integer ID but the cy element ID remains the original URN string.
    // Using cy.getElementById(n.id) fails for enriched RNEF nodes — use URN instead.
    var urnToCyNodes = {};
    cy.nodes().forEach(function(cyNode) {
      var urn = cyNode.data('URN');
      if (urn) {
        var key = String(urn);
        if (!urnToCyNodes[key]) urnToCyNodes[key] = [];
        urnToCyNodes[key].push(cyNode);
      }
    });

    var annotated = 0;
    graphData.nodes.forEach(function(n) {
      var props = null;
      var nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
      var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
      if (nid && byNodeId[nid]) props = byNodeId[nid];
      else if (urn && byUrn[urn]) props = byUrn[urn];
      if (!props) return;

      // Update backing graphData
      Object.assign(n.properties, props);

      // Update all cy elements sharing this URN (covers original + RNEF clones).
      // Fall back to direct ID lookup for enriched nodes whose n.id became a Neo4j integer.
      var cyNodesForUrn = (urn && urnToCyNodes[urn]) ? urnToCyNodes[urn] : null;
      if (cyNodesForUrn) {
        cyNodesForUrn.forEach(function(cyNode) {
          Object.keys(props).forEach(function(k) { cyNode.data(k, props[k]); });
        });
        annotated++;
      } else {
        var cyNode = cy.getElementById(String(n.id));
        if (cyNode && cyNode.length) {
          Object.keys(props).forEach(function(k) { cyNode.data(k, props[k]); });
          annotated++;
        }
      }
    });

    // ── Degree / Neighbor Count ───────────────────────────────────────────────
    if (loadDegree || loadNeighborCount) {
      status.textContent = 'Loading graph metrics…';
      var metricUrns = [];
      cy.nodes().forEach(function(cyNode) {
        var urn = cyNode.data('URN');
        if (urn) metricUrns.push(String(urn));
      });
      if (metricUrns.length) {
        var metricsResult = await api('/api/nodes/connectivity', { urns: metricUrns });
        cy.nodes().forEach(function(cyNode) {
          var urn = cyNode.data('URN');
          if (!urn) return;
          var metrics = metricsResult[String(urn)] || { degree: 0, neighborCount: 0 };
          if (loadDegree) {
            cyNode.data('Degree', metrics.degree);
            var gNodeD = graphData.nodes.find(function(n) {
              return n.properties && String(n.properties.URN) === String(urn);
            });
            if (gNodeD) gNodeD.properties.Degree = metrics.degree;
          }
          if (loadNeighborCount) {
            cyNode.data('NeighborCount', metrics.neighborCount);
            var gNodeN = graphData.nodes.find(function(n) {
              return n.properties && String(n.properties.URN) === String(urn);
            });
            if (gNodeN) gNodeN.properties.NeighborCount = metrics.neighborCount;
          }
          annotated++;
        });
        if (loadDegree)        _loadedPropertyNames.add('Degree');
        if (loadNeighborCount) _loadedPropertyNames.add('NeighborCount');
      }
    }

    if (annotated > 0) {
      // Track which property names were loaded so the tooltip can show them first
      selected.forEach(function(k) { _loadedPropertyNames.add(k); });
      document.getElementById('load-props-modal').style.display = 'none';
    } else {
      var total = Object.keys(byNodeId).length + Object.keys(byUrn).length;
      status.style.color = '#f9a825';
      status.textContent = 'No matching nodes found in database (' + total + ' DB matches, ' + annotated + ' pathway nodes annotated).';
    }
  } catch (err) {
    status.style.color = '#e05560';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

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
    // ── Focus node — white border ring, used as alignment reference ───────────
    {
      selector: 'node.focus-node',
      style: { 'border-width': 4, 'border-color': '#ffffff', 'border-opacity': 1 }
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
    // ── Effect-based arrow shapes (default for all views) ────────────────
    {
      selector: 'edge[effect="Positive"]',
      style: {
        'target-arrow-shape': 'triangle',
        'target-label': '⊕',
        'target-text-offset': 35
      }
    },
    {
      selector: 'edge[effect="Negative"]',
      style: {
        'target-arrow-shape': 'tee'
      }
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
    // ── Per-NodeType shapes, gradient fills, borders ────────────────────────
    // Protein — vertical oval, red gradient
    { selector: 'node[NodeType="Protein"]', style: {
        'shape': 'ellipse', 'width': 32, 'height': 50,
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#E78D8D #d32f2f', 'background-gradient-stop-positions': '0 1'
    }},
    // SmallMol — circle, bright green gradient
    { selector: 'node[NodeType="SmallMol"]', style: {
        'shape': 'ellipse',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#73E1A0 #00C853', 'background-gradient-stop-positions': '0 1',
        'color': '#000000', 'text-outline-color': 'rgba(255,255,255,0.88)', 'text-outline-width': 2
    }},
    // Treatment — 8-pointed starburst, blue gradient
    { selector: 'node[NodeType="Treatment"]', style: {
        'shape': 'polygon',
        'shape-polygon-points': '0 -1  0.153 -0.370  0.707 -0.707  0.370 -0.153  1 0  0.370 0.153  0.707 0.707  0.153 0.370  0 1  -0.153 0.370  -0.707 0.707  -0.370 0.153  -1 0  -0.370 -0.153  -0.707 -0.707  -0.153 -0.370',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#7EAADC #1565c0', 'background-gradient-stop-positions': '0 1'
    }},
    // Disease — tall roundrectangle (Emerald Diamond), burnt orange gradient
    { selector: 'node[NodeType="Disease"]', style: {
        'shape': 'roundrectangle', 'width': 42, 'height': 62,
        'text-wrap': 'wrap', 'text-max-width': '38px',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#E3A273 #CC5500', 'background-gradient-stop-positions': '0 1'
    }},
    // CellProcess — stadium (wide roundrectangle), yellow gradient
    { selector: 'node[NodeType="CellProcess"]', style: {
        'shape': 'roundrectangle',
        'width': function(n){ var l=(n.data('label')||'').length; return Math.min(Math.max(50,l*6.5+20),175); },
        'height': 34,
        'padding': '10px', 'text-wrap': 'wrap', 'text-max-width': '160px',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#FCCF87 #f9a825', 'background-gradient-stop-positions': '0 1',
        'color': '#000000', 'text-outline-color': 'rgba(255,255,255,0.88)', 'text-outline-width': 2
    }},
    // FunctionalClass — hexagon, orange gradient
    { selector: 'node[NodeType="FunctionalClass"]', style: {
        'shape': 'hexagon',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#F19F73 #e65100', 'background-gradient-stop-positions': '0 1'
    }},
    // Complex — vesica piscis (vertical lens), dark red gradient
    { selector: 'node[NodeType="Complex"]', style: {
        'shape': 'polygon',
        'shape-polygon-points': '0 -1  0.35 -0.87  0.5 0  0.35 0.87  0 1  -0.35 0.87  -0.5 0  -0.35 -0.87',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#B97373 #7f0000', 'background-gradient-stop-positions': '0 1'
    }},
    // CellObject — vertical oval, gray gradient
    { selector: 'node[NodeType="CellObject"]', style: {
        'shape': 'ellipse', 'width': 32, 'height': 50,
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#B3B3B3 #757575', 'background-gradient-stop-positions': '0 1'
    }},
    // Tissue — stadium (wide roundrectangle), brown gradient
    { selector: 'node[NodeType="Tissue"]', style: {
        'shape': 'roundrectangle',
        'width': function(n){ var l=(n.data('label')||'').length; return Math.min(Math.max(50,l*6.5+20),175); },
        'height': 34,
        'padding': '10px', 'text-wrap': 'wrap', 'text-max-width': '160px',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#AF9D97 #6d4c41', 'background-gradient-stop-positions': '0 1'
    }},
    // Organ — kidney/bean shape, dark violet gradient, gray solid border
    { selector: 'node[NodeType="Organ"]', style: {
        'shape': 'polygon',
        'shape-polygon-points': '0 -1  0.7 -0.7  1 0  0.7 0.7  0 1  -0.5 0.9  -0.5 0.3  0 0.1  0 -0.1  -0.5 -0.3  -0.5 -0.9',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#9B7EC0 #4a148c', 'background-gradient-stop-positions': '0 1',
        'border-width': 2, 'border-color': '#808080', 'border-style': 'solid'
    }},
    // CellType / Cell — amoeba-like polygon, light blue gradient
    { selector: 'node[NodeType="CellType"], node[NodeType="Cell"]', style: {
        'shape': 'polygon',
        'shape-polygon-points': '0.800 -0.000 0.866 -0.500 0.350 -0.606 0.000 -0.920 -0.310 -0.537 -0.762 -0.440 -0.760 -0.000 -0.866 0.500 -0.330 0.572 -0.000 0.820 0.480 0.831 0.624 0.360',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#BAE7FC #81d4fa', 'background-gradient-stop-positions': '0 1',
        'color': '#000000', 'text-outline-color': 'rgba(255,255,255,0.88)', 'text-outline-width': 2
    }},
    // GeneticVariant — triangle (delta), vibrant orange gradient
    { selector: 'node[NodeType="GeneticVariant"]', style: {
        'shape': 'triangle',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#FFAF73 #FF6D00', 'background-gradient-stop-positions': '0 1'
    }},
    // ClinicalParameter — plus/cross shape, slate blue gradient, dashed border
    { selector: 'node[NodeType="ClinicalParameter"]', style: {
        'shape': 'polygon',
        'shape-polygon-points': '-0.3 -1  0.3 -1  0.3 -0.3  1 -0.3  1 0.3  0.3 0.3  0.3 1  -0.3 1  -0.3 0.3  -1 0.3  -1 -0.3  -0.3 -0.3',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#A5AEDC #5C6BC0', 'background-gradient-stop-positions': '0 1',
        'border-width': 2, 'border-color': '#5C6BC0', 'border-style': 'dashed'
    }},
    // MedicalProcedure — right-pointing chevron, teal gradient
    { selector: 'node[NodeType="MedicalProcedure"]', style: {
        'shape': 'polygon',
        'shape-polygon-points': '-1 -0.5  0.1 -0.5  0.1 -1  1 0  0.1 1  0.1 0.5  -1 0.5',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#A6E8DF #5dd6c5', 'background-gradient-stop-positions': '0 1',
        'color': '#000000', 'text-outline-color': 'rgba(255,255,255,0.88)', 'text-outline-width': 2
    }},
    // Pathogen — 8-pointed starburst, toxic green gradient
    { selector: 'node[NodeType="Pathogen"]', style: {
        'shape': 'polygon',
        'shape-polygon-points': '0 -1  0.153 -0.370  0.707 -0.707  0.370 -0.153  1 0  0.370 0.153  0.707 0.707  0.153 0.370  0 1  -0.153 0.370  -0.707 0.707  -0.370 0.153  -1 0  -0.370 -0.153  -0.707 -0.707  -0.153 -0.370',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#A8ED8A #61DE2A', 'background-gradient-stop-positions': '0 1',
        'color': '#000000', 'text-outline-color': 'rgba(255,255,255,0.88)', 'text-outline-width': 2
    }},
    // Virus — spiked circle (corona, 8 spikes), chartreuse gradient
    { selector: 'node[NodeType="Virus"]', style: {
        'shape': 'polygon',
        'shape-polygon-points': '0 -1  0.211 -0.508  0.707 -0.707  0.508 -0.211  1 0  0.508 0.211  0.707 0.707  0.211 0.508  0 1  -0.211 0.508  -0.707 0.707  -0.508 0.211  -1 0  -0.508 -0.211  -0.707 -0.707  -0.211 -0.508',
        'background-fill': 'linear-gradient', 'background-gradient-direction': 'to-bottom',
        'background-gradient-stop-colors': '#D6DC9F #B5BF50', 'background-gradient-stop-positions': '0 1',
        'color': '#000000', 'text-outline-color': 'rgba(255,255,255,0.88)', 'text-outline-width': 2
    }},
    // ── RNEF-preserved rectangular nodes ─────────────────────────────────────
    {
      selector: 'node[rnefShape="rectangle"]',
      style: {
        'shape': 'rectangle',
        'width':  function(n){ var l=(n.data('label')||'').length; return Math.min(Math.max(40,l*6.5+10),172); },
        'height': function(n){ var l=(n.data('label')||'').length; var cpl=Math.floor(162/6.5); var lines=Math.max(1,Math.ceil(l/cpl)); return Math.max(24,lines*16+10); },
        'padding': '5px', 'text-wrap': 'wrap', 'text-max-width': '162px'
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
    // ── Undirected edges (from RNEF in-out links) — no arrowhead ─────────────
    {
      selector: 'edge.undirected',
      style: {
        'target-arrow-shape': 'none',
        'source-arrow-shape': 'none'
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
    },
    // ── Custom node color (overrides gradient fill) ───────────────────────────
    {
      selector: 'node[customColor]',
      style: {
        'background-fill':    'solid',
        'background-color':   'data(customColor)',
        'text-outline-color': 'data(customColor)'
      }
    },
    {
      selector: 'node[customTextColor]',
      style: { 'color': 'data(customTextColor)' }
    },
    // ── Highlight aura — underlay circle drawn outside the node boundary ────
    {
      selector: 'node[highlightColor]',
      style: {
        'underlay-color':   'data(highlightColor)',
        'underlay-opacity': 0.45,
        'underlay-padding': 18,
        'underlay-shape':   'ellipse'
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

// Returns the number of unique papers in a reference array, counted by the first
// available stable identifier per row (DOI → EMBASE → PII → PUI → NCT_ID).
// Rows with no identifier are not counted, ensuring refCount ≤ refs.length.
function calcRefCount(refs) {
  if (!Array.isArray(refs) || !refs.length) return 0;
  var idSet = new Set();
  refs.forEach(function(r) {
    if      (r.doi)    idSet.add('DOI:'    + String(r.doi).toLowerCase().trim());
    else if (r.embase) idSet.add('EMBASE:' + String(r.embase).trim());
    else if (r.pii)    idSet.add('PII:'    + String(r.pii).trim());
    else if (r.pui)    idSet.add('PUI:'    + String(r.pui).trim());
    else if (r.nct_id) idSet.add('NCT_ID:' + String(r.nct_id).trim());
  });
  return idSet.size;
}

function getEdgeThickness(numRefs) {
  var n = Number(numRefs) || 0;
  if (n <= 0) return 2;
  if (n === 1) return 4;
  if (n === 2) return 6;
  return 7; // 3+
}

// Normalize effect values to title-case for CSS selector matching.
// Neo4j stores 'positive'/'negative' (lowercase); stylesheet selectors expect
// 'Positive'/'Negative'. Also maps '_' and 'unknown' variants to '' (no effect).
function normEffectDisplay(v) {
  if (!v) return '';
  const s = String(v);
  if (s === '_' || s.toLowerCase() === 'unknown') return '';
  if (s.toLowerCase() === 'positive') return 'Positive';
  if (s.toLowerCase() === 'negative') return 'Negative';
  return s;
}

// ─── Shared graph-merge helpers ──────────────────────────────────────────────
// All operations that add nodes/edges from Neo4j (Expand, Find relations, etc.)
// must call mergeGraphData() so node/edge data is assembled exactly once, the
// same way renderGraph() does it.

/** Build the Cytoscape data object for one graphData node — mirrors renderGraph. */
function _buildCyNodeData(n) {
  var d = {
    id: n.id,
    elementId: n.elementId || n.id,
    label: getNodeLabel(n),
    color: getNodeColor(n.labels),
    nodeType: (n.labels && n.labels[0]) || 'Unknown'
  };
  if (n.isClone) d.isClone = true;
  if (n.cloneOf)  d.cloneOf = n.cloneOf;
  Object.assign(d, n.properties);
  d.id = n.id;                            // guard: n.properties.id must never overwrite cy id
  if (!d.NodeType) d.NodeType = d.nodeType;
  return d;
}

/** Build the Cytoscape data object for one graphData edge — mirrors renderGraph.
 *  srcCyId / tgtCyId are the already-resolved Cytoscape node IDs (may differ
 *  from e.startNodeId / e.endNodeId after URN-based anchor resolution). */
function _buildCyEdgeData(e, srcCyId, tgtCyId) {
  var p = e.properties || {};
  var _inlineRefs = Array.isArray(p.references) && p.references.length ? p.references : null;
  var numRefs = _inlineRefs
    ? calcRefCount(_inlineRefs)
    : (p.RelationNumberOfReferences != null ? p.RelationNumberOfReferences : 0);
  var undirected = p.directed === false || !p.directed && !DIRECT_TYPES.has(e.type || '');
  return {
    id:           e.id,
    elementId:    e.elementId || e.id,
    source:       srcCyId,
    target:       tgtCyId,
    relType:      e.type || '',
    relId:        p.RelationID != null ? String(p.RelationID) : '',
    relIds:       Array.isArray(p.RelationIDs) ? p.RelationIDs : null,
    edgeURN:      p.URN != null ? String(p.URN) : '',
    numRefs:      numRefs,
    effect:       normEffectDisplay(p.Effect || p.effect || ''),
    mechanism:    p.Mechanism || p.mechanism || '',
    confidence:   p['Confidence (%)'] != null ? p['Confidence (%)'] : '',
    citationScore: p['Citation score'] != null ? p['Citation score'] : '',
    color:        getTypeColor(e.type || ''),
    isHyperedge:  (e.type === 'Substrate' || e.type === 'Product' || e.type === 'Cofactor'),
    thickness:    getEdgeThickness(numRefs),
    lineStyle:    DIRECT_TYPES.has(e.type || '') ? 'solid' : 'dashed',
    directed:     !undirected
  };
}

/**
 * Merge server-returned { nodes, edges } into the live graph without replacing
 * existing elements.  Handles the anchor-node ID mismatch: the server uses Neo4j
 * internal IDs while the canvas may use different IDs for nodes loaded earlier.
 * Bridges the gap via URN lookup exactly once here, so callers never need to
 * worry about ID translation.
 *
 * Returns { addedNodes, addedEdges } counts.
 */
function mergeGraphData(newData) {
  var newNodes = newData.nodes || [];
  var newEdges = newData.edges || [];

  // ── Step 1: build URN → cy-id map from the live canvas ──────────────────
  var urnToCyId = {};
  cy.nodes().not('[?isClone]').forEach(function(n) {
    var urn = n.data('URN') || n.data('urn');
    if (urn) urnToCyId[String(urn)] = n.id();
  });

  // ── Step 2: neo4j-internal-id → cy-id (for endpoint resolution in edges) ─
  var neo4jToCy = {};

  // Pre-pass: map IDs of returned nodes that already exist on canvas (anchors)
  newNodes.forEach(function(n) {
    var nid = String(n.id);
    var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
    if (urn && urnToCyId[urn]) neo4jToCy[nid] = urnToCyId[urn];
  });

  // ── Step 3: collect existing IDs for dedup ───────────────────────────────
  var existingEdgeIds = new Set();
  graphData.edges.forEach(function(e) { existingEdgeIds.add(String(e.id)); });

  // ── Step 4: add new nodes ────────────────────────────────────────────────
  var addedNodes = 0;
  newNodes.forEach(function(n) {
    var nid = String(n.id);
    if (neo4jToCy[nid]) return;            // already on canvas (anchor)
    var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
    if (urn && urnToCyId[urn]) { neo4jToCy[nid] = urnToCyId[urn]; return; }

    // Genuinely new node
    neo4jToCy[nid] = nid;
    if (urn) urnToCyId[urn] = nid;
    graphData.nodes.push(n);
    addedNodes++;
    cy.add({
      group: 'nodes',
      data: _buildCyNodeData(n),
      position: { x: Math.random() * 200 - 100, y: Math.random() * 200 - 100 }
    });
  });

  // ── Step 5: add new edges ────────────────────────────────────────────────
  var addedEdges = 0;
  newEdges.forEach(function(e) {
    var eid = String(e.id);
    if (existingEdgeIds.has(eid)) return;
    existingEdgeIds.add(eid);

    var srcCyId = neo4jToCy[String(e.startNodeId)];
    var tgtCyId = neo4jToCy[String(e.endNodeId)];
    if (!srcCyId || !tgtCyId) return;
    if (!cy.getElementById(srcCyId).length || !cy.getElementById(tgtCyId).length) return;

    graphData.edges.push(e);
    addedEdges++;
    var undirected = !(e.properties && e.properties.directed !== false &&
                       (e.properties.directed || DIRECT_TYPES.has(e.type || '')));
    cy.add({
      group: 'edges',
      classes: undirected ? 'undirected' : '',
      data: _buildCyEdgeData(e, srcCyId, tgtCyId)
    });
  });

  return { addedNodes: addedNodes, addedEdges: addedEdges };
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
    // Spread Neo4j properties into the Cytoscape data object, but guard against
    // the "id" property (Neo4j nodes sometimes have a property literally named
    // "id" that holds the database integer).  enrichNodesFromNeo4j now renames
    // it to "databaseID", but any snapshot saved before that fix might still
    // carry n.properties.id.  Restore d.id from n.id afterwards to be safe.
    Object.assign(d, n.properties);
    d.id = n.id;        // ensure Cytoscape node ID is never clobbered by n.properties.id
    if (!d.NodeType) d.NodeType = d.nodeType;  // Neo4j: type is a label, not a property
    if (n.isClone) d.isClone = true;
    if (n.cloneOf) d.cloneOf = n.cloneOf;
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

  // Build a set of all node IDs that will exist in cy so we can skip dangling edges
  var cyNodeIdSet = new Set(data.nodes.map(function(n) { return String(n.id); }));

  var skippedEdges = 0;
  var cyEdges = [];
  data.edges.forEach(function(e) {
    // Skip edges whose source or target node is not in this graph — prevents
    // Cytoscape "nonexistent source/target" crash on files saved with dangling edges.
    if (!cyNodeIdSet.has(String(e.startNodeId)) || !cyNodeIdSet.has(String(e.endNodeId))) {
      skippedEdges++;
      return;
    }
    // When inline refs are present, derive both counts from them so they stay
    // consistent with each other (Neo4j values may be from a different snapshot).
    var _inlineRefs = Array.isArray(e.properties.references) && e.properties.references.length
                      ? e.properties.references : null;
    var numRefs = _inlineRefs
      ? calcRefCount(_inlineRefs)
      : (e.properties.RelationNumberOfReferences != null ? e.properties.RelationNumberOfReferences : 0);
    var undirected = e.properties.directed === false;
    cyEdges.push({
      group: 'edges',
      classes: undirected ? 'undirected' : '',
      data: {
        id: e.id,
        elementId: e.elementId || e.id,
        source: e.startNodeId,
        target: e.endNodeId,
        relType: e.type,
        relId: e.properties.RelationID != null ? String(e.properties.RelationID) : '',
        relIds: Array.isArray(e.properties.RelationIDs) ? e.properties.RelationIDs : null,
        edgeURN: e.properties.URN != null ? String(e.properties.URN) : '',
        numRefs: numRefs,
        effect: normEffectDisplay(e.properties.Effect || e.properties.effect || ''),
        mechanism: e.properties.Mechanism || e.properties.mechanism || '',
        confidence: e.properties['Confidence (%)'] != null ? e.properties['Confidence (%)'] : '',
        citationScore: e.properties['Citation score'] != null ? e.properties['Citation score'] : '',
        color: getTypeColor(e.type),
        isHyperedge: (e.type === 'Substrate' || e.type === 'Product' || e.type === 'Cofactor'),
        thickness: getEdgeThickness(numRefs),
        lineStyle: DIRECT_TYPES.has(e.type) ? 'solid' : 'dashed'
      }
    });
  });
  if (skippedEdges > 0) console.warn('renderGraph: skipped ' + skippedEdges + ' edge(s) with missing endpoints.');

  focusNodeId = null;   // focus class is lost when elements are destroyed
  cy.elements().remove();
  cy.add(cyNodes.concat(cyEdges));

  // Restore highlight inline styles for nodes that carry highlightColor in data.
  // The stylesheet selector handles this on first render, but explicit inline styles
  // ensure the aura is visible immediately on tab-switch / renderGraph calls.
  cy.nodes('[highlightColor]').forEach(function(n) {
    var c = n.data('highlightColor');
    if (c) {
      n.style({ 'underlay-color': c, 'underlay-opacity': 0.45, 'underlay-padding': 18, 'underlay-shape': 'ellipse' });
    }
  });
  cy.nodes('[nodeWidth]').forEach(function(n) {
    var w = n.data('nodeWidth');
    var h = n.data('nodeHeight') || w;
    var f = n.data('nodeFontSize');
    if (w) n.style({ width: w, height: h, 'font-size': f || BASE_NODE_FONT });
  });
  cy.nodes('[customColor]').forEach(function(n) {
    var c = n.data('customColor');
    if (c) {
      var tc = contrastColor(c);
      n.data('customTextColor', tc);
      n.style({ 'background-color': c, 'text-outline-color': tc === '#000000' ? 'rgba(255,255,255,0.88)' : c, 'text-outline-width': 2, 'color': tc });
    }
  });

  // Belt-and-suspenders: explicitly apply saved positions after add().
  // The position field in cy.add() element specs is not always honoured
  // reliably (e.g. when the cy container is hidden during batch adds),
  // so we set positions again here before the preset layout runs.
  if (savedPositions) {
    var _bsFound = 0, _bsMiss = 0, _bsMissSample = [];
    cy.nodes().forEach(function(n) {
      var pos = savedPositions[n.id()];
      if (!pos && !n.data('isClone')) {
        var urn = n.data('URN');
        if (urn) pos = savedPositions[urn];
      }
      if (pos) { n.position(pos); _bsFound++; }
      else {
        _bsMiss++;
        if (_bsMissSample.length < 2) _bsMissSample.push('id=' + n.id() + ' URN=' + n.data('URN'));
      }
    });
    console.log('[TAB-DEBUG] renderGraph belt-and-suspenders: found=' + _bsFound + ' notFound=' + _bsMiss + (_bsMissSample.length ? ' missing=' + _bsMissSample.join(';') : ''));
  }

  document.getElementById('graph-empty-state').style.display =
    (cyNodes.length === 0 && cyEdges.length === 0) ? 'flex' : 'none';

  updateLegend();
  updateStats();

  if (savedPositions) {
    console.log('[TAB-DEBUG][' + Date.now() + '] renderGraph: using PRESET layout (savedPositions provided)');
    cy.layout({ name: 'preset' }).run();
    // Preset layout places nodes at exact coordinates but does NOT adjust the
    // viewport.  The fit must be deferred one animation frame so the browser
    // has finished painting the (now-visible) canvas before Cytoscape measures
    // container dimensions — otherwise it fits against a zero-size box and the
    // graph stays invisible until the user presses Fit manually.
    requestAnimationFrame(function() {
      if (cy) {
        cy.resize();
        var _bb = cy.elements().boundingBox();
        console.log('[TAB-DEBUG] RAF fit: nodes=' + cy.nodes().length +
          ' bb=(' + Math.round(_bb.x1) + ',' + Math.round(_bb.y1) + ')→(' + Math.round(_bb.x2) + ',' + Math.round(_bb.y2) + ')' +
          ' spread=(' + Math.round(_bb.x2 - _bb.x1) + 'x' + Math.round(_bb.y2 - _bb.y1) + ')');
        cy.fit(cy.elements(), 40);
        updateZoomLabel();
      }
    });
  } else {
    console.trace('[TAB-DEBUG][' + Date.now() + '] renderGraph: using ALGORITHM layout (no savedPositions) currentLayout=' + currentLayout);
    applyLayout(currentLayout);
  }
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function applyLayout(name, btn) {
  if (!cy || !cy.nodes().length) return;
  currentLayout = name;
  console.trace('[TAB-DEBUG][' + Date.now() + '] applyLayout called with: ' + name);

  updateLayoutMenu(name);

  var layoutConfigs = {
    cose:      { name: 'cose',      animate: false, numIter: 100, nodeRepulsion: 4500, idealEdgeLength: 100, fit: true, padding: 40 },
    dagre:     { name: 'dagre',     rankDir: 'TB', nodeSep: 60, rankSep: 80, animate: false, fit: true, padding: 40 },
    circle:    { name: 'circle',    animate: false, fit: true, padding: 40 },
    concentric:{ name: 'concentric',animate: false, fit: true, padding: 40, minNodeSpacing: 40 },
    grid:      { name: 'grid',      animate: false, fit: true, padding: 40, avoidOverlap: true },
    klay:      { name: 'klay',      animate: false, fit: true, padding: 40,
                 klay: { direction: 'DOWN', edgeRouting: 'ORTHOGONAL',
                         nodeLayering: 'LONGEST_PATH', nodePlacement: 'BRANDES_KOEPF',
                         inLayerSpacingFactor: 1.0, edgeSpacingFactor: 0.5 } }
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
// ─── In-memory large-query exports (FR-2 / FR-3 / FR-4) ─────────────────────
// Shared Excel writer — accepts pre-built rows + isRelMode flag + filename.
// Mirrors exportTableExcel() but operates on caller-supplied rows so it can be
// used without touching tableRows / relationRows global state.
async // Build an ExcelJS buffer from rows without triggering a download.
// Separated so callers can build multiple buffers in parallel then download in order.
async function buildExcelBuffer(rows, isRelMode, plainText) {
  var visCols = columnDefs.filter(function(c) {
    if (!c.visible) return false;
    if (isRelMode) return c.source === 'graph' || c.source === 'neo4j' || c.source === 'node_prop';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data' || c.source === 'node_prop';
  });

  var wb    = new ExcelJS.Workbook();
  var sheet = wb.addWorksheet('Graph Data');
  var colWidths = {
    regulator: 22, regulatorType: 16, target: 22, targetType: 16,
    relationType: 18, effect: 12, numRefs: 8, pmid: 14, doi: 32,
    year: 8, title: 40, sentence: 60
  };
  sheet.columns = visCols.map(function(col) {
    return { key: col.key, width: colWidths[col.key] || 20 };
  });
  var hRow = sheet.getRow(1);
  visCols.forEach(function(col, ci) {
    var cell = hRow.getCell(ci + 1);
    cell.value = col.label;
    cell.font  = { name: 'Arial', size: 10, bold: true };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF0' } };
    cell.alignment = { vertical: 'middle', wrapText: false };
  });
  hRow.commit();

  rows.forEach(function(row) {
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
          { text: valStr,                                     font: { name: 'Arial', size: 10 } },
          { text: '\nMedScan ID: ' + row.regulatorMedScan,   font: { name: 'Arial', size: 9, color: { argb: 'FF7A8099' } } }
        ]};
        cell.alignment = { vertical: 'top', wrapText: true };
      } else if (col.key === 'target' && row.targetMedScan) {
        cell.value = { richText: [
          { text: valStr,                                   font: { name: 'Arial', size: 10 } },
          { text: '\nMedScan ID: ' + row.targetMedScan,    font: { name: 'Arial', size: 9, color: { argb: 'FF7A8099' } } }
        ]};
        cell.alignment = { vertical: 'top', wrapText: true };
      } else if (col.key === 'sentence') {
        cell.value     = plainText ? valStr : buildSentenceRichText(valStr, row.regulatorMedScan, row.targetMedScan);
        cell.alignment = { vertical: 'top', wrapText: true };
      } else {
        // Write as number when: column is flagged numeric, or the raw value is
        // already a JS number (Neo4j numeric properties such as Relation score,
        // Confidence %, etc.).  Also covers year (numeric string → number).
        var numVal = (col.numeric && valStr !== '') ? Number(valStr)
                   : (typeof val === 'number'      ? val
                   :  NaN);
        if (isFinite(numVal)) {
          cell.value = numVal;
          cell.numFmt = Number.isInteger(numVal) ? '0' : '0.##';
        } else {
          cell.value = valStr;
        }
        cell.font = { name: 'Arial', size: 10 };
      }
    });
    exRow.commit();
  });

  return await wb.xlsx.writeBuffer();
}

function downloadBuffer(buffer, filename) {
  var blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function writeRowsToExcel(rows, isRelMode, filename, plainText) {
  if (typeof ExcelJS === 'undefined') {
    alert('ExcelJS library not loaded. Please check your internet connection.'); return;
  }
  try {
    var buffer = await buildExcelBuffer(rows, isRelMode, plainText);
    downloadBuffer(buffer, filename);
  } catch (err) { alert('Excel export failed: ' + err.message); }
}

// Shared: run query in-memory and build node/edge lookup + MedScan map.
// Returns { qNodes, qEdges, nodeById, medScan } or null on error.
async function _fetchQueryData(query) {
  var qData;
  try { qData = await api('/api/graph/query', { query }); }
  catch (err) { alert('Query error: ' + err.message); return null; }

  var qNodes = qData.nodes || [];
  var qEdges = qData.edges || [];

  // nodeById index (by id and URN)
  var nodeById = {};
  qNodes.forEach(function(n) {
    nodeById[n.id] = n;
    if (n.properties && n.properties.URN) nodeById[n.properties.URN] = n;
  });

  // Fetch MedScan IDs for nodes that have a Neo4j NodeID
  var nodeIds = qNodes
    .map(function(n) { return n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null; })
    .filter(Boolean);
  var medScan = {};
  if (nodeIds.length > 0) {
    try {
      var fetched = await api('/api/nodes/medscan', { nodeIds });
      Object.assign(medScan, fetched);
    } catch(e) { console.warn('MedScan lookup failed:', e.message); }
  }

  return { qNodes, qEdges, nodeById, medScan };
}

// Export References — mirrors loadTableData row-building, no UI side effects.
async function exportQueryReferences(query) {
  setProgressMsg('⏳ Fetching relations from database…');
  var ctx = await _fetchQueryData(query);
  if (!ctx) { setProgressMsg(null); return; }
  var { qEdges, nodeById, medScan } = ctx;

  setProgressMsg('⏳ Fetching references… (' + qEdges.length + ' relations)');
  // Collect relation IDs and fetch references
  var relIds = [];
  qEdges.forEach(function(e) {
    if (Array.isArray(e.properties.RelationIDs))
      e.properties.RelationIDs.forEach(function(id) { if (id != null) relIds.push(String(id)); });
    else if (e.properties.RelationID != null) relIds.push(String(e.properties.RelationID));
  });

  var refsGrouped = {};
  if (relIds.length > 0) {
    var scopusCols = columnDefs.filter(function(c) { return c.source === 'scopus_data'; }).map(function(c) { return c.dbField; });
    var CHUNK       = 200;
    var CONCURRENCY = 4;   // parallel requests in flight at once

    // Split into chunks
    var _chunks = [];
    for (var _ci = 0; _ci < relIds.length; _ci += CHUNK)
      _chunks.push(relIds.slice(_ci, _ci + CHUNK));

    var _completed  = 0;
    var _total      = _chunks.length;
    var _totalIds   = relIds.length;
    var _startTime  = Date.now();

    // Fetch one chunk, with Scopus fallback on error
    async function _fetchChunk(chunk) {
      try {
        return await api('/api/references/batch', { relationIds: chunk, scopusColumns: scopusCols });
      } catch(e) {
        if (scopusCols.length > 0) {
          try { return await api('/api/references/batch', { relationIds: chunk, scopusColumns: [] }); }
          catch(e2) {}
        }
        return {};
      }
    }

    // Concurrency-limited pool — workers pull from _chunks as they finish (as_completed style)
    var _qIdx = 0;
    async function _worker() {
      while (_qIdx < _chunks.length) {
        var _i     = _qIdx++;
        var _part  = await _fetchChunk(_chunks[_i]);
        Object.assign(refsGrouped, _part);
        _completed++;
        var _doneIds = Math.min(_completed * CHUNK, _totalIds);
        var _elapsed = (Date.now() - _startTime) / 1000;
        var _eta     = (_completed > 1) ? formatEta(_elapsed / _completed * (_total - _completed)) : '';
        setProgressMsg('⏳ Fetching references… (' + _doneIds + ' / ' + _totalIds +
                       (_eta ? '  ·  ~' + _eta + ' left' : '') + ')');
      }
    }

    // Launch CONCURRENCY workers in parallel; each drains the queue independently
    var _workers = [];
    for (var _w = 0; _w < Math.min(CONCURRENCY, _chunks.length); _w++) _workers.push(_worker());
    await Promise.all(_workers);
  }

  function nodeLabel(node) { return node ? getNodeLabel(node) : '?'; }
  function nodeMedScanLocal(node) {
    if (!node || !node.properties) return '';
    var nid = node.properties.NodeID != null ? String(node.properties.NodeID) : null;
    return (nid && medScan[nid]) ? medScan[nid] : '';
  }

  setProgressMsg('⏳ Building rows…');
  await yieldToUI();
  var rows = [];
  qEdges.forEach(function(edge) {
    var srcNode = nodeById[edge.startNodeId];
    var tgtNode = nodeById[edge.endNodeId];
    var relId = edge.properties.RelationID != null ? String(edge.properties.RelationID) : '';
    var relIdsArr = Array.isArray(edge.properties.RelationIDs) ? edge.properties.RelationIDs : (relId ? [relId] : []);
    var refs = [];
    for (var ri = 0; ri < relIdsArr.length; ri++) {
      var _r = refsGrouped[relIdsArr[ri]];
      if (_r && _r.length) { refs = _r; break; }
    }
    var base = {
      edgeId: edge.id, elementId: edge.elementId || edge.id,
      relId: relIdsArr.join(', ') || relId,
      regulator: nodeLabel(srcNode), regulatorMedScan: nodeMedScanLocal(srcNode),
      regulatorType: (srcNode && srcNode.labels && srcNode.labels[0]) || '',
      target: nodeLabel(tgtNode), targetMedScan: nodeMedScanLocal(tgtNode),
      targetType: (tgtNode && tgtNode.labels && tgtNode.labels[0]) || '',
      relationType: edge.type,
      effect: normEffectDisplay(edge.properties.Effect || edge.properties.effect || ''),
      numRefs: edge.properties.RelationNumberOfReferences || 0,
      numSentences: edge.properties.RelationNumberOfSentences || 0,
    };
    var buildRow = function(ref) {
      var row = Object.assign({}, base);
      if (ref) {
        Object.keys(ref).forEach(function(k) {
          row[k.startsWith('sd_') ? k : ('_ref_' + k)] = ref[k];
        });
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
    if (refs.length === 0) rows.push(buildRow(null));
    else refs.forEach(function(ref) { rows.push(buildRow(ref)); });
  });

  var MAX_ROWS   = 20000;
  var _parts     = Math.ceil(rows.length / MAX_ROWS);
  var _plain     = _parts > 1;
  if (_parts > 1) {
    setProgressMsg(null);
    var _proceed = confirm('Number of exported rows exceeded ' + MAX_ROWS.toLocaleString() + ' limit ' +
                           '(' + rows.length.toLocaleString() + ' rows). ' +
                           'Sentence coloring is disabled. The export will be split into ' + _parts + ' files.\n\n' +
                           'Click OK to continue or Cancel to abort.');
    if (!_proceed) return;
  }

  if (typeof ExcelJS === 'undefined') {
    alert('ExcelJS library not loaded. Please check your internet connection.');
    setProgressMsg(null); return;
  }

  // Build all buffers in parallel (concurrency 3), download in order as they finish.
  var GEN_CONCURRENCY = 3;
  var _slices = [];
  var _fnames = [];
  for (var _pi = 0; _pi < _parts; _pi++) {
    _slices.push(rows.slice(_pi * MAX_ROWS, (_pi + 1) * MAX_ROWS));
    _fnames.push('query-references-part' + (_pi + 1) + '.xlsx');
  }

  var _buffers  = new Array(_parts);
  var _genDone  = 0;
  var _genIdx   = 0;
  var _genStart = Date.now();
  var _note     = _plain ? ' · plain text' : '';

  function _updateGenProgress() {
    var _elapsed = (Date.now() - _genStart) / 1000;
    var _eta     = (_genDone > 1) ? formatEta(_elapsed / _genDone * (_parts - _genDone)) : '';
    setProgressMsg('⏳ Building Excel parts… (' + _genDone + ' / ' + _parts + _note +
                   (_eta ? '  ·  ~' + _eta + ' left' : '') + ')');
  }

  // Worker: pulls from queue, builds buffer, stores at index
  async function _genWorker() {
    while (_genIdx < _parts) {
      var _i       = _genIdx++;
      _buffers[_i] = await buildExcelBuffer(_slices[_i], false, _plain);
      _slices[_i]  = null;   // free row data immediately
      _genDone++;
      _updateGenProgress();
    }
  }

  // Generate all parts in parallel
  var _workers = [];
  for (var _w = 0; _w < Math.min(GEN_CONCURRENCY, _parts); _w++) _workers.push(_genWorker());
  await Promise.all(_workers);

  // Bundle into one ZIP and download — single browser confirmation
  if (_parts === 1) {
    setProgressMsg('⏳ Downloading…');
    await yieldToUI();
    downloadBuffer(_buffers[0], 'query-references.xlsx');
  } else {
    setProgressMsg('⏳ Zipping ' + _parts + ' files…');
    await yieldToUI();
    var _zip = new JSZip();
    for (var _zi = 0; _zi < _parts; _zi++) {
      _zip.file(_fnames[_zi], _buffers[_zi]);
      _buffers[_zi] = null;   // free memory as we go
    }
    var _zipBuf = await _zip.generateAsync({ type: 'arraybuffer',
                                             compression: 'DEFLATE',
                                             compressionOptions: { level: 1 } });
    downloadBuffer(_zipBuf, 'query-references.zip');
  }
  setProgressMsg(null);
}

// Export Relations — mirrors loadRelationData row-building, no UI side effects.
async function exportQueryRelations(query) {
  setProgressMsg('⏳ Fetching relations from database…');
  var ctx = await _fetchQueryData(query);
  if (!ctx) { setProgressMsg(null); return; }
  var { qEdges, nodeById, medScan } = ctx;

  function nodeLabel(node) { return node ? getNodeLabel(node) : '?'; }
  function nodeMedScanLocal(node) {
    if (!node || !node.properties) return '';
    var nid = node.properties.NodeID != null ? String(node.properties.NodeID) : null;
    return (nid && medScan[nid]) ? medScan[nid] : '';
  }

  // Ensure NEO4J_PROP_DEFS columns exist (same logic as loadRelationData)
  var existingNeo4j = {};
  columnDefs.forEach(function(c) { if (c.source === 'neo4j') existingNeo4j[c.dbField] = c; });
  NEO4J_PROP_DEFS.forEach(function(def) {
    if (!existingNeo4j[def.prop]) {
      var newCol = { key: 'neo4j_' + def.prop, label: def.label, visible: false, source: 'neo4j', dbField: def.prop };
      columnDefs.push(newCol); existingNeo4j[def.prop] = newCol;
    }
  });

  var rows = qEdges.map(function(edge) {
    var srcNode = nodeById[edge.startNodeId];
    var tgtNode = nodeById[edge.endNodeId];
    var relId = edge.properties.RelationID != null ? String(edge.properties.RelationID) : '';
    var relIdsArr = Array.isArray(edge.properties.RelationIDs) ? edge.properties.RelationIDs : (relId ? [relId] : []);
    var row = {
      edgeId: edge.id, elementId: edge.elementId || edge.id,
      relId: relIdsArr.length > 1 ? relIdsArr.join(', ') : relId,
      regulator: nodeLabel(srcNode), regulatorMedScan: nodeMedScanLocal(srcNode),
      regulatorType: (srcNode && srcNode.labels && srcNode.labels[0]) || '',
      target: nodeLabel(tgtNode), targetMedScan: nodeMedScanLocal(tgtNode),
      targetType: (tgtNode && tgtNode.labels && tgtNode.labels[0]) || '',
      relationType: edge.type,
      effect: normEffectDisplay(edge.properties.Effect || edge.properties.effect || ''),
      numRefs: edge.properties.RelationNumberOfReferences || 0,
      numSentences: edge.properties.RelationNumberOfSentences || '',
    };
    columnDefs.forEach(function(col) {
      if (col.source === 'neo4j') {
        row[col.key] = edge.properties[col.dbField] != null ? String(edge.properties[col.dbField]) : '';
      } else if (col.source === 'node_prop') {
        var npNode = col.nodeRole === 'tgt' ? tgtNode : srcNode;
        row[col.key] = (npNode && npNode.properties && npNode.properties[col.dbField] != null)
          ? String(npNode.properties[col.dbField]) : '';
      }
    });
    return row;
  });

  var MAX_ROWS = 100000;
  var _parts = Math.ceil(rows.length / MAX_ROWS);
  for (var _pi = 0; _pi < _parts; _pi++) {
    var _slice = rows.slice(_pi * MAX_ROWS, (_pi + 1) * MAX_ROWS);
    var _label = _parts > 1 ? ' (part ' + (_pi + 1) + ' of ' + _parts + ')' : '';
    setProgressMsg('⏳ Formatting Excel' + _label + '… (' + _slice.length + ' rows)');
    await yieldToUI();
    var _fname = _parts > 1 ? 'query-relations-part' + (_pi + 1) + '.xlsx' : 'query-relations.xlsx';
    var _plain = _parts > 1;
    await writeRowsToExcel(_slice, true, _fname, _plain);
    if (_pi < _parts - 1) await new Promise(function(r) {{ setTimeout(r, 800); }});
  }
  setProgressMsg(null);
}


// Pending query stored when large-query intercept modal fires
var _largeQueryPending = null;

function closeLargeQueryModal() {
  _largeQueryPending = null;
  document.getElementById('large-query-modal').style.display = 'none';
}

async function largeQueryExport(mode) {
  var query = _largeQueryPending;
  closeLargeQueryModal();
  if (!query) return;
  if (mode === 'references') await exportQueryReferences(query);
  else                       await exportQueryRelations(query);
}

async function runQuery() {
  var query = getCypherQuery().trim();
  if (!query) return;
  currentQuery = query;

  // ── Pre-execution count check (FR-1.1 / FR-1.2) ──────────────────────────
  var _limitMatch = query.match(/LIMIT\s+(\d+)\s*$/i);
  var _limitVal   = _limitMatch ? parseInt(_limitMatch[1], 10) : Infinity;
  var _edgeCount  = _limitVal;
  var _tooLarge   = false;

  // Fast intercept: LIMIT >= 1000 — skip counting, just show modal.
  if (_limitVal >= 1000) {
    // Still run count(*) so we can show the real number, but with a 5 s timeout.
    setProgressMsg('⏳ Counting matching relations…');
  } else {
    setProgressMsg('⏳ Counting matching relations…');
  }

  try {
    // Wrap the count API call with a 5-second timeout via AbortController.
    var _abortCtrl   = new AbortController();
    var _abortTimer  = setTimeout(function() { _abortCtrl.abort(); }, 5000);
    var _countOpts   = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 'Authorization': authToken ? 'Bearer ' + authToken : '' },
      body: JSON.stringify({ query: query }),
      signal: _abortCtrl.signal
    };
    var _cRes  = await fetch('/api/graph/count-query', _countOpts);
    clearTimeout(_abortTimer);
    var countRes = await _cRes.json().catch(function() { return {}; });
    setProgressMsg(null);
    if (countRes && typeof countRes.edgeCount === 'number') {
      _edgeCount = countRes.edgeCount;
      if (_edgeCount >= 1000) _tooLarge = true;
    } else if (_limitVal >= 1000) {
      _tooLarge = true;
    }
  } catch (countErr) {
    setProgressMsg(null);
    if (countErr.name === 'AbortError') {
      console.warn('count-query timed out — proceeding with main query');
      // Timeout: if there is already a LIMIT >= 1000, still intercept.
      if (_limitVal >= 1000) _tooLarge = true;
      // No LIMIT + timeout → let the query run; the result may be large but we
      // cannot know for sure, so don't block the user.
    } else {
      console.warn('count-query failed:', countErr.message);
      if (_limitVal >= 1000) _tooLarge = true;
    }
  }

  if (_tooLarge) {
    _largeQueryPending = query;
    var _countStr = isFinite(_edgeCount) ? _edgeCount.toLocaleString() : 'more than 1,000';
    document.getElementById('large-query-msg').textContent =
      'The query returns ' + _countStr + ' edges. ' +
      'The results with more than 1,000 edges cannot be displayed in the App. ' +
      'Would you like to export the results to Excel instead?';
    document.getElementById('large-query-modal').style.display = 'flex';
    return;
  }

  var startTabId = tabs[activeTabIdx].id;
  tabs[activeTabIdx].running = true;
  renderTabBar();

  document.getElementById('graph-loading').style.display = 'flex';
  document.getElementById('graph-empty-state').style.display = 'none';
  document.getElementById('run-btn').disabled = true;

  try {
    var data = await api('/api/graph/query', { query: query });
    var shortQ = query.length > 40 ? query.substring(0, 40) + '…' : query;
    var startTabIdx = tabs.findIndex(function(t) { return t.id === startTabId; });
    if (startTabIdx < 0) return; // tab was closed while query ran

    if (startTabIdx === activeTabIdx) {
      // Still on the originating tab — render normally
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
    } else {
      // User switched away — store results so they appear when they come back
      tabs[startTabIdx].name = shortQ;
      tabs[startTabIdx].snapshot.pendingGraphData = data;
    }
  } catch(err) {
    var startTabIdx = tabs.findIndex(function(t) { return t.id === startTabId; });
    if (startTabIdx === activeTabIdx) {
      alert('Query error: ' + err.message);
    } else if (startTabIdx >= 0) {
      tabs[startTabIdx].snapshot.pendingQueryError = err.message;
    }
  } finally {
    var startTabIdx = tabs.findIndex(function(t) { return t.id === startTabId; });
    if (startTabIdx >= 0) tabs[startTabIdx].running = false;
    if (startTabIdx === activeTabIdx) {
      document.getElementById('graph-loading').style.display = 'none';
      document.getElementById('run-btn').disabled = false;
    }
    renderTabBar();
  }
}

function handleQueryKeydown(e) {
  var ta = e.target;

  // Autocomplete keyboard navigation
  if (_acHandleKey(e)) return;

  // Wrap selected text in quotes/backticks when a quote key is pressed with an active selection.
  // e.g. double-click "BRCA1" then press ' → 'BRCA1'
  if (e.key === "'" || e.key === '"' || e.key === '`') {
    var start = ta.selectionStart, end = ta.selectionEnd;
    if (start !== end) {
      e.preventDefault();
      var q = e.key;
      var selected = ta.value.substring(start, end);
      ta.setRangeText(q + selected + q, start, end, 'end');
      // Keep just the inner word selected (cursor sits after closing quote
      // but the word itself remains highlighted so the user can re-quote or retype).
      ta.selectionStart = start + 1;
      ta.selectionEnd   = start + 1 + selected.length;
      onCypherInput(ta);
      return;
    }
  }

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
  undoStack = [];
  var btn = document.getElementById('undo-btn');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }
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
    tooltipCurrentEdge = null;
    document.getElementById('tooltip').style.display = 'none';
  }, 800);
}

function showTooltipLoading() {
  var el = document.getElementById('tooltip');
  el.style.display = 'block';
  document.getElementById('tooltip-inner').innerHTML = '<div class="tooltip-loading">Loading references…</div>';
}

function renderRefsHtml(refs, asc) {
  var btnLabel = asc ? '↑ oldest first' : '↓ newest first';
  var btnTitle = asc ? 'Switch to newest first' : 'Switch to oldest first';
  var out = '<div id="tooltip-refs-block">';
  if (refs.length > 1) {
    out += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">'
      + '<span style="font-size:11px;color:#7a8099">References</span>'
      + '<button id="tooltip-sort-btn" title="' + btnTitle + '" '
      + 'style="font-size:10px;color:#7a8099;background:none;border:1px solid #2a2f4a;border-radius:3px;'
      + 'padding:1px 5px;cursor:pointer;line-height:1.4">' + btnLabel + '</button>'
      + '</div>';
  }
  var sorted = refs.slice().sort(function(a, b) {
    var ya = parseInt(a.pubyear || a.year || 0, 10);
    var yb = parseInt(b.pubyear || b.year || 0, 10);
    return asc ? ya - yb : yb - ya;
  });
  var display = sorted.slice(0, 3);
  if (display.length === 0) {
    out += '<div class="tooltip-no-data">No references in database</div>';
  } else {
    // Display labels for identifier columns (shown as "Label: value" in meta line)
    var ID_COLS = [
      { key: 'doi',    label: 'DOI' },
      { key: 'pmid',   label: 'PMID' },
      { key: 'embase', label: 'Embase' },
      { key: 'pii',    label: 'PII' },
      { key: 'pui',    label: 'PUI' },
      { key: 'nct_id', label: 'NCT_ID' },
    ];
    display.forEach(function(ref, i) {
      if (i > 0) out += '<hr class="tooltip-divider">';
      var year = getRefYear(ref);
      var journal = ref.journal || ref.journalname || ref.journaltitle || ref.source || '';
      var sentence = ref.msrc || '';
      // Find best available identifier: doi first, then first non-null fallback
      var idLabel = '', idValue = '';
      for (var ci = 0; ci < ID_COLS.length; ci++) {
        var v = ref[ID_COLS[ci].key];
        if (v != null && String(v).trim() !== '') {
          idLabel = ID_COLS[ci].label;
          idValue = String(v).trim();
          break;
        }
      }
      out += '<div class="tooltip-ref">';
      var metaParts = [];
      if (year) metaParts.push(escHtml(year));
      if (journal) metaParts.push(escHtml(journal));
      if (idLabel) metaParts.push('<span style="color:#8a9ab8">' + escHtml(idLabel) + ':</span> ' + escHtml(idValue));
      out += '<div class="tooltip-meta">' + metaParts.join(' · ') + '</div>';
      if (sentence) out += '<div class="tooltip-sentence">' + escHtml(sentence) + '</div>';
      out += '</div>';
    });
    if (refs.length > 3) {
      out += '<div style="font-size:11px;color:#7a8099;margin-top:6px">+' + (refs.length - 3) + ' more reference(s)</div>';
    }
  }
  out += '</div>';
  return out;
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
  // If actual refs were passed in (freshly loaded), derive the count from them
  // so the header always matches the list — even when the cy edge data was
  // computed before background reference fetching completed.  Also write the
  // correct count back to the cy element so future tooltip opens don't need to
  // re-derive it.
  if (refs && refs.length > 0) {
    var freshCount = calcRefCount(refs);
    if (freshCount !== numRefs) {
      numRefs = freshCount;
      try { edge.data('numRefs', numRefs); edge.data('thickness', getEdgeThickness(numRefs)); } catch(e) {}
    }
  }
  var confidence = edge.data('confidence');
  var citationScore = edge.data('citationScore');

  var NONDIRECTIONAL = new Set(['Binding','CellExpression','FunctionalAssociation','Metabolization','Paralog']);
  var isNonDir = NONDIRECTIONAL.has(relType);
  var normEff  = effect ? String(effect).trim().toLowerCase() : '';

  // Directional connector with effect sign:
  //   positive → green →+    negative → red —|    none → grey →
  //   non-directional → grey —
  var arrowHtml;
  if (isNonDir) {
    arrowHtml = ' <span style="color:#9e9e9e">—</span> ';
  } else if (normEff === 'positive') {
    arrowHtml = ' <span style="color:#43a047;font-weight:700">&#x2192;+</span> ';
  } else if (normEff === 'negative') {
    arrowHtml = ' <span style="color:#e53935;font-weight:700">&#x2014;|</span> ';
  } else {
    arrowHtml = ' <span style="color:#9e9e9e">&#x2192;</span> ';
  }

  // Full triple on one line: SourceNode — RelationType →+ TargetNode
  var html = '<div class="tooltip-rel-header">'
    + escHtml(srcLabel)
    + ' <span style="color:#7a8099;font-weight:400">—</span> '
    + relType
    + arrowHtml
    + escHtml(tgtLabel)
    + '</div>';

  if (mechanism && String(mechanism).trim()) {
    html += '<div style="font-size:11px;color:#7a8099;margin-bottom:4px">Mechanism: '
      + escHtml(String(mechanism).trim()) + '</div>';
  }

  var metaLine = (numRefs || 0) + ' reference(s)';
  if (confidence !== '' && confidence != null) metaLine += ' · Confidence: ' + confidence + '%';
  if (citationScore !== '' && citationScore != null) metaLine += ' · Citation score: ' + citationScore;
  html += '<div style="font-size:11px;color:#7a8099;margin-bottom:8px">' + metaLine + '</div>';

  tooltipCurrentRefs = refs;
  html += renderRefsHtml(refs, tooltipRefSortAsc);

  // Service fields — RelationID (Neo4j) and/or URN (RNEF) shown at bottom in muted style
  var relId   = edge.data('relId');
  var relIds  = edge.data('relIds') || (relId ? [relId] : []);
  var edgeURN = edge.data('edgeURN');
  if (relIds.length > 0 || (edgeURN && edgeURN !== '')) {
    html += '<div style="margin-top:8px;border-top:1px solid #2a2f4a;padding-top:4px">';
    if (relIds.length > 0) {
      html += '<div style="font-size:10px;color:#5a6080;margin-top:2px">'
        + '<span style="color:#454d6a">RelationID:</span> ' + escHtml(relIds.join(', '))
        + '</div>';
    }
    if (edgeURN && edgeURN !== '') {
      html += '<div style="font-size:10px;color:#5a6080;margin-top:2px">'
        + '<span style="color:#454d6a">URN:</span> ' + escHtml(String(edgeURN))
        + '</div>';
    }
    html += '</div>';
  }

  el.style.display = 'block';
  document.getElementById('tooltip-inner').innerHTML = html;
  // Re-position now that full content is rendered and real dimensions are known.
  positionTooltip(lastMouseX, lastMouseY);

  // If a "Matching relations" status message is waiting to be cleared, remove it
  // now that the tooltip is actually showing a RelationID — this is the moment
  // the user can see the ID, so the message has served its purpose.
  var _tipRelIds = edge.data('relIds') || (edge.data('relId') ? [edge.data('relId')] : []);
  if (pendingMatchSpan && _tipRelIds.some(function(id) { return matchedRelIds.has(id); })) {
    pendingMatchSpan.remove();
    pendingMatchSpan = null;
    matchedRelIds.clear();
  }
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

  // Keys already rendered in the header or to be placed in specific sections
  var HEADER_KEYS = { Name:1, name:1, label:1, Description:1, description:1,
                      URN:1, urn:1, nodeType:1, NodeType:1, ControlType:1,
                      id:1, elementId:1, color:1, source:1, target:1,
                      NumRefs:1, references:1, isClone:1, cloneOf:1,
                      // internal styling / service properties
                      rnefShape:1, customColor:1, customTextColor:1,
                      highlightColor:1, nodeWidth:1, nodeHeight:1, nodeFontSize:1,
                      thickness:1, directed:1, RelationID:1 };
  // Priority fields shown immediately after description
  var PRIORITY_FIELDS = ['Localization', 'localization', 'Notes', 'notes', 'Aliases', 'aliases'];
  // Service fields shown at the very bottom
  var SERVICE_FIELDS  = ['createdAt', 'updatedAt', 'NodeID', 'URN', 'urn'];
  var SERVICE_SET = {};
  SERVICE_FIELDS.forEach(function(k) { SERVICE_SET[k] = 1; });
  var PRIORITY_SET = {};
  PRIORITY_FIELDS.forEach(function(k) { PRIORITY_SET[k] = 1; });

  var html = '<div class="tooltip-rel-header">' + escHtml(name);
  if (nodeType) html += ' <span style="color:#7a8099;font-weight:400;font-size:11px">(' + escHtml(nodeType) + ')</span>';
  html += '</div>';
  if (data.isClone) html += '<div style="font-size:11px;color:#FFD700;margin-top:3px">⬦ Clone — same entity as original</div>';
  if (description) html += '<div style="font-size:12px;color:#c8cde8;margin-top:6px;line-height:1.5">' + escHtml(description) + '</div>';

  function renderPropRow(k, val) {
    return '<div style="font-size:11px;color:#c8cde8;margin-top:3px">'
      + '<span style="color:#7a8099">' + escHtml(k) + ':</span> ' + escHtml(String(val))
      + '</div>';
  }

  // 0. User-loaded properties (from "Load node properties" dialog) — shown first, highlighted
  if (_loadedPropertyNames.size > 0) {
    var loadedHtml = '';
    _loadedPropertyNames.forEach(function(k) {
      var val = data[k];
      // val is always a string from the server (multi-values joined with " | ")
      if (val != null && val !== '') {
        var display = Array.isArray(val) ? val.join(' | ') : String(val);
        loadedHtml += '<div style="font-size:11px;color:#c8cde8;margin-top:3px">'
          + '<span style="color:#5dd6c5;font-weight:600">' + escHtml(k) + ':</span> ' + escHtml(display)
          + '</div>';
      }
    });
    if (loadedHtml) {
      html += '<div style="margin-top:8px;border-top:1px solid #2a4040;padding-top:6px;'
            + 'background:rgba(93,214,197,0.06);border-radius:4px;padding:6px 6px 2px">'
            + '<div style="font-size:10px;color:#5dd6c5;margin-bottom:4px;letter-spacing:0.04em">DB PROPERTIES</div>'
            + loadedHtml + '</div>';
    }
  }

  // 1. Priority fields: Localization, Notes, Aliases
  var priorityHtml = '';
  PRIORITY_FIELDS.forEach(function(k) {
    if (data[k] != null && data[k] !== '' && typeof data[k] !== 'object') {
      priorityHtml += renderPropRow(k, data[k]);
    }
  });
  if (priorityHtml) html += '<div style="margin-top:8px;border-top:1px solid #2a2f4a;padding-top:6px">' + priorityHtml + '</div>';

  // 2. Other fields (not header, not priority, not service, not already shown in loaded section)
  var otherExtras = Object.keys(data).filter(function(k) {
    return !HEADER_KEYS[k] && !PRIORITY_SET[k] && !SERVICE_SET[k] && !_loadedPropertyNames.has(k)
        && data[k] != null && data[k] !== '' && typeof data[k] !== 'object';
  });
  if (otherExtras.length) {
    html += '<div style="margin-top:8px;border-top:1px solid #2a2f4a;padding-top:6px">';
    otherExtras.forEach(function(k) { html += renderPropRow(k, data[k]); });
    html += '</div>';
  }

  // 3. Service fields: createdAt, updatedAt, NodeID, URN
  var serviceHtml = '';
  SERVICE_FIELDS.forEach(function(k) {
    var val = data[k];
    if (val != null && val !== '' && typeof val !== 'object') {
      serviceHtml += '<div style="font-size:10px;color:#5a6080;margin-top:2px">'
        + '<span style="color:#454d6a">' + escHtml(k) + ':</span> ' + escHtml(String(val))
        + '</div>';
    }
  });
  if (serviceHtml) html += '<div style="margin-top:8px;border-top:1px solid #2a2f4a;padding-top:4px">' + serviceHtml + '</div>';

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
      await loadRelationData();
    } else {
      if (tableRows.length > 0) {
        renderTableHeader();
        renderTableRows(tableRows);
      } else {
        await loadTableData();
      }
    }
    // Re-apply active sort (survives tab switches and mode changes)
    if (tableSortCol) {
      var _src = tableViewMode === 'relation' ? relationRows : tableRows;
      var _colDef = columnDefs.find(function(c) { return c.key === tableSortCol; });
      var _numeric = _colDef && _colDef.numeric;
      var _sorted = _src.slice().sort(function(a, b) {
        var av = a[tableSortCol], bv = b[tableSortCol];
        if (_numeric) {
          var an = av !== '' && av != null ? Number(av) : -Infinity;
          var bn = bv !== '' && bv != null ? Number(bv) : -Infinity;
          return tableSortAsc ? an - bn : bn - an;
        }
        av = String(av || '').toLowerCase();
        bv = String(bv || '').toLowerCase();
        return tableSortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
      renderTableRows(_sorted);
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
  var relIds = [];
  graphData.edges.forEach(function(e) {
    if (Array.isArray(e.properties.RelationIDs)) {
      e.properties.RelationIDs.forEach(function(id) { if (id != null) relIds.push(String(id)); });
    } else if (e.properties.RelationID != null) {
      relIds.push(String(e.properties.RelationID));
    }
  });

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

  // Fetch RelationNumberOfSentences from Neo4j for edges that have a RelationID
  // but no value yet (RNEF-matched edges, similar relations).
  var missingNosIds = relIds.filter(function(id) {
    var e = graphData.edges.find(function(ge) {
      var ids = Array.isArray(ge.properties.RelationIDs) ? ge.properties.RelationIDs
              : (ge.properties.RelationID != null ? [String(ge.properties.RelationID)] : []);
      return ids.indexOf(id) >= 0;
    });
    return e && e.properties.RelationNumberOfSentences == null;
  });
  if (missingNosIds.length > 0) {
    try {
      var nosMap = await api('/api/relations/properties',
        { relationIds: missingNosIds, properties: ['RelationNumberOfSentences'] });
      graphData.edges.forEach(function(e) {
        var ids = Array.isArray(e.properties.RelationIDs) ? e.properties.RelationIDs
                : (e.properties.RelationID != null ? [String(e.properties.RelationID)] : []);
        for (var i = 0; i < ids.length; i++) {
          var entry = nosMap[ids[i]];
          if (entry && entry.RelationNumberOfSentences != null) {
            e.properties.RelationNumberOfSentences = entry.RelationNumberOfSentences;
            break;
          }
        }
      });
    } catch(err) {
      console.warn('RelationNumberOfSentences fetch failed:', err.message);
    }
  }

  // Supplement with inline references stored in the JSON (RNEF-converted pathways).
  // These have the same field names (pmid, doi, pubyear, title, msrc) as DB rows.
  graphData.edges.forEach(function(e) {
    var relId = e.properties.RelationID != null ? String(e.properties.RelationID) : '';
    // For merged edges, also index refs under each of their RelationIDs
    var allIds = Array.isArray(e.properties.RelationIDs) ? e.properties.RelationIDs : (relId ? [relId] : []);
    if (e.properties.references && e.properties.references.length) {
      allIds.forEach(function(id) { if (id && !refsGrouped[id]) refsGrouped[id] = e.properties.references; });
    }
  });

  // Auto-fetch node properties for any active node_prop columns
  var nodePropCols = columnDefs.filter(function(c) { return c.source === 'node_prop' && c.visible; });
  if (nodePropCols.length > 0) {
    var npNodeIds = [], npUrns = [];
    graphData.nodes.forEach(function(n) {
      var nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
      var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
      if (nid && /^-?\d+$/.test(nid)) npNodeIds.push(nid);
      else if (urn) npUrns.push(urn);
    });
    if (npNodeIds.length || npUrns.length) {
      // Only request props not yet loaded on the first node — avoids redundant fetches
      var propNames = nodePropCols.map(function(c) { return c.dbField; });
      try {
        msg.style.display = 'inline';
        msg.textContent = 'Loading node properties…';
        var npResult = await api('/api/nodes/load-properties', { nodeIds: npNodeIds, urns: npUrns, properties: propNames });
        var npById = npResult.byNodeId || {};
        var npByUrn = npResult.byUrn   || {};
        // Build URN→cy lookup for data update (same fix as executeLoadNodeProperties)
        var urnToCyNode = {};
        if (cy) cy.nodes().forEach(function(cyNode) {
          var u = cyNode.data('URN');
          if (u) urnToCyNode[String(u)] = cyNode;
        });
        graphData.nodes.forEach(function(n) {
          var nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
          var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
          var props = (nid && npById[nid]) ? npById[nid] : (urn && npByUrn[urn]) ? npByUrn[urn] : null;
          if (!props) return;
          Object.assign(n.properties, props);
          var cyNode = (urn && urnToCyNode[urn]) ? urnToCyNode[urn] : (cy ? cy.getElementById(n.id) : null);
          if (cyNode && cyNode.length) Object.keys(props).forEach(function(k) { cyNode.data(k, props[k]); });
          propNames.forEach(function(k) { _loadedPropertyNames.add(k); });
        });
        msg.style.display = 'none';
      } catch(e) {
        msg.style.display = 'none';
        console.warn('Node property fetch failed:', e.message);
      }
    }
  }

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
    var relIdsArr = Array.isArray(edge.properties.RelationIDs) ? edge.properties.RelationIDs : (relId ? [relId] : []);
    var relIdDisplay = relIdsArr.join(', ') || relId;
    var refs = [];
    for (var ri = 0; ri < relIdsArr.length; ri++) {
      var _r = refsGrouped[relIdsArr[ri]];
      if (_r && _r.length) { refs = _r; break; }
    }

    var base = {
      edgeId: edge.id,
      elementId: edge.elementId || edge.id,
      relId: relIdDisplay,
      regulator: nodeLabel(srcNode),
      regulatorMedScan: nodeMedScan(srcNode),
      regulatorType: (srcNode && srcNode.labels && srcNode.labels[0]) || '',
      target: nodeLabel(tgtNode),
      targetMedScan: nodeMedScan(tgtNode),
      targetType: (tgtNode && tgtNode.labels && tgtNode.labels[0]) || '',
      relationType: edge.type,
      effect: normEffectDisplay(edge.properties.Effect || edge.properties.effect || ''),
      // Derive both counts from the same source to prevent numRefs > numSentences.
      // Inline refs (from PostgreSQL) take priority; fall back to Neo4j stored values.
      numRefs: (Array.isArray(edge.properties.references) && edge.properties.references.length)
        ? calcRefCount(edge.properties.references)
        : (edge.properties.RelationNumberOfReferences != null ? edge.properties.RelationNumberOfReferences : 0),
      numSentences: (Array.isArray(edge.properties.references) && edge.properties.references.length)
        ? edge.properties.references.length
        : (edge.properties.RelationNumberOfSentences != null ? Number(edge.properties.RelationNumberOfSentences) : '')
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
      // Node property columns — reg from source node, tgt from target node
      columnDefs.forEach(function(col) {
        if (col.source === 'node_prop') {
          var node = col.nodeRole === 'tgt' ? tgtNode : srcNode;
          row[col.key] = (node && node.properties && node.properties[col.dbField] != null)
            ? String(node.properties[col.dbField]) : '';
        }
      });
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

async function loadRelationData() {
  // Auto-fetch node properties for any active node_prop columns
  var relNpCols = columnDefs.filter(function(c) { return c.source === 'node_prop' && c.visible; });
  if (relNpCols.length > 0) {
    var rnpNodeIds = [], rnpUrns = [];
    graphData.nodes.forEach(function(n) {
      var nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
      var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
      if (nid && /^-?\d+$/.test(nid)) rnpNodeIds.push(nid);
      else if (urn) rnpUrns.push(urn);
    });
    if (rnpNodeIds.length || rnpUrns.length) {
      var rnpNames = relNpCols.map(function(c) { return c.dbField; });
      try {
        var rnpResult = await api('/api/nodes/load-properties', { nodeIds: rnpNodeIds, urns: rnpUrns, properties: rnpNames });
        var rnpById = rnpResult.byNodeId || {};
        var rnpByUrn = rnpResult.byUrn   || {};
        var urnToCy = {};
        if (cy) cy.nodes().forEach(function(cyNode) { var u = cyNode.data('URN'); if (u) urnToCy[String(u)] = cyNode; });
        graphData.nodes.forEach(function(n) {
          var nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
          var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
          var props = (nid && rnpById[nid]) ? rnpById[nid] : (urn && rnpByUrn[urn]) ? rnpByUrn[urn] : null;
          if (!props) return;
          Object.assign(n.properties, props);
          var cyNode = (urn && urnToCy[urn]) ? urnToCy[urn] : (cy ? cy.getElementById(n.id) : null);
          if (cyNode && cyNode.length) Object.keys(props).forEach(function(k) { cyNode.data(k, props[k]); });
          rnpNames.forEach(function(k) { _loadedPropertyNames.add(k); });
        });
      } catch(e) { console.warn('Node property fetch failed (relation view):', e.message); }
    }
  }

  // Fetch RelationNumberOfSentences for edges that don't have it yet
  var relMissingIds = graphData.edges
    .filter(function(e) { return e.properties.RelationID != null && e.properties.RelationNumberOfSentences == null; })
    .map(function(e) { return String(e.properties.RelationID); });
  if (relMissingIds.length > 0) {
    try {
      var relNosMap = await api('/api/relations/properties',
        { relationIds: relMissingIds, properties: ['RelationNumberOfSentences'] });
      graphData.edges.forEach(function(e) {
        var id = e.properties.RelationID != null ? String(e.properties.RelationID) : null;
        if (id && relNosMap[id] && relNosMap[id].RelationNumberOfSentences != null) {
          e.properties.RelationNumberOfSentences = relNosMap[id].RelationNumberOfSentences;
        }
      });
    } catch(err) {
      console.warn('RelationNumberOfSentences fetch failed (relation view):', err.message);
    }
  }

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
      relId:            (function() {
                          var ids = Array.isArray(edge.properties.RelationIDs) ? edge.properties.RelationIDs : null;
                          var primary = edge.properties.RelationID != null ? String(edge.properties.RelationID) : '';
                          return ids && ids.length > 1 ? ids.join(', ') : primary;
                        })(),
      regulator:        nodeLabel(srcNode),
      regulatorMedScan: nodeMedScan(srcNode),
      regulatorType:    (srcNode && srcNode.labels && srcNode.labels[0]) || '',
      target:           nodeLabel(tgtNode),
      targetMedScan:    nodeMedScan(tgtNode),
      targetType:       (tgtNode && tgtNode.labels && tgtNode.labels[0]) || '',
      relationType:     edge.type,
      effect:           normEffectDisplay(edge.properties.Effect || edge.properties.effect || ''),
      numRefs:      (Array.isArray(edge.properties.references) && edge.properties.references.length)
                          ? calcRefCount(edge.properties.references)
                          : (edge.properties.RelationNumberOfReferences != null ? edge.properties.RelationNumberOfReferences : 0),
      numSentences: (Array.isArray(edge.properties.references) && edge.properties.references.length)
                          ? edge.properties.references.length
                          : (edge.properties.RelationNumberOfSentences != null ? Number(edge.properties.RelationNumberOfSentences) : '')
    };
    columnDefs.forEach(function(col) {
      if (col.source === 'neo4j') {
        row[col.key] = edge.properties[col.dbField] != null ? String(edge.properties[col.dbField]) : '';
      } else if (col.source === 'node_prop') {
        var npNode = col.nodeRole === 'tgt' ? tgtNode : srcNode;
        row[col.key] = (npNode && npNode.properties && npNode.properties[col.dbField] != null)
          ? String(npNode.properties[col.dbField]) : '';
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
    if (tableViewMode === 'relation') return c.source === 'graph' || c.source === 'neo4j' || c.source === 'node_prop';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data' || c.source === 'node_prop';
  });
  thead.innerHTML = visCols.map(function(col, i) {
    var sortAttr = ' onclick="sortTable(\'' + col.key + '\')"';
    var sortLabel = ' <span class="col-sort-arrow">⇅</span>';
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
    if (tableViewMode === 'relation') return c.source === 'graph' || c.source === 'neo4j' || c.source === 'node_prop';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data' || c.source === 'node_prop';
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
  var sourceRows = tableViewMode === 'relation' ? relationRows : tableRows;
  if (!q) { renderTableRows(sourceRows); return; }
  var lower = q.toLowerCase();
  var filtered = sourceRows.filter(function(row) {
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
  var sourceRows = tableViewMode === 'relation' ? relationRows : tableRows;
  var colDef = columnDefs.find(function(c) { return c.key === col; });
  var isNumeric = colDef && colDef.numeric;
  var sorted = sourceRows.slice().sort(function(a, b) {
    var av = a[col], bv = b[col];
    if (isNumeric) {
      var an = av !== '' && av != null ? Number(av) : -Infinity;
      var bn = bv !== '' && bv != null ? Number(bv) : -Infinity;
      return tableSortAsc ? an - bn : bn - an;
    }
    av = String(av || '').toLowerCase();
    bv = String(bv || '').toLowerCase();
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

  // ── Node properties (both views) ──────────────────────────────────────────
  var nodePropSection = document.getElementById('col-nodeprops-section');
  var nodePropList    = document.getElementById('col-nodeprops-list');
  var nodePropNote    = document.getElementById('col-nodeprops-note');
  nodePropList.innerHTML = '';
  nodePropNote.textContent = '';

  // Collect nodeIds from current pathway to fetch available property names
  var npNodeIds = [];
  if (graphData && graphData.nodes) {
    graphData.nodes.forEach(function(n) {
      var nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
      if (nid && /^-?\d+$/.test(nid)) npNodeIds.push(nid);
    });
  }

  if (!npNodeIds.length) {
    if (nodePropSection) nodePropSection.style.display = 'none';
  } else {
    if (nodePropSection) nodePropSection.style.display = '';
    // Build lookup: propName → {reg: colDef, tgt: colDef}
    var existingNpMap = {};
    columnDefs.forEach(function(c) {
      if (c.source === 'node_prop') {
        var m = c.key.match(/^np_(reg|tgt)_(.+)$/);
        if (m) {
          if (!existingNpMap[m[2]]) existingNpMap[m[2]] = {};
          existingNpMap[m[2]][m[1]] = c;
        }
      }
    });

    // Fetch available property names for nodes in the current pathway
    api('/api/nodes/property-names', { nodeIds: npNodeIds })
      .then(function(propNames) {
        if (!propNames || !propNames.length) {
          nodePropNote.textContent = 'No properties found for nodes in this pathway.';
          return;
        }
        nodePropNote.textContent = 'Each property adds two columns: Regulator and Target. Data fetched automatically when table loads.';
        propNames.forEach(function(propName) {
          // Ensure both reg and tgt column defs exist
          if (!existingNpMap[propName]) existingNpMap[propName] = {};
          if (!existingNpMap[propName].reg) {
            var rc = { key: 'np_reg_' + propName, label: 'Regulator ' + propName, visible: false, source: 'node_prop', dbField: propName, nodeRole: 'reg' };
            columnDefs.push(rc);
            existingNpMap[propName].reg = rc;
          }
          if (!existingNpMap[propName].tgt) {
            var tc = { key: 'np_tgt_' + propName, label: 'Target ' + propName, visible: false, source: 'node_prop', dbField: propName, nodeRole: 'tgt' };
            columnDefs.push(tc);
            existingNpMap[propName].tgt = tc;
          }
          // One checkbox controls both reg+tgt columns
          var isChecked = existingNpMap[propName].reg.visible || existingNpMap[propName].tgt.visible;
          var lb = document.createElement('label');
          lb.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap';
          lb.innerHTML = '<input type="checkbox" data-node-prop="' + escHtml(propName) + '"'
            + (isChecked ? ' checked' : '') + '> ' + escHtml(propName);
          nodePropList.appendChild(lb);
        });
      })
      .catch(function() {
        nodePropNote.textContent = 'Could not load property list from database.';
      });
  }

  document.getElementById('columns-modal').style.display = 'flex';
}

function closeColumnsModal(e) {
  if (e.target === document.getElementById('columns-modal'))
    document.getElementById('columns-modal').style.display = 'none';
}

function resetColumnsToDefault() {
  try { localStorage.removeItem(COL_CONFIG_KEY); } catch(e) {}
  columnDefs = DEFAULT_COLUMNS.map(function(c) { return Object.assign({}, c); });
  document.getElementById('columns-modal').style.display = 'none';
  columnWidths = null;
  if (document.getElementById('table-view').style.display !== 'none') {
    if (tableViewMode === 'relation') { loadRelationData(); }
    else { tableRows = []; loadTableData(); }
  }
}

function applyColumnsDialog() {
  document.querySelectorAll('[data-col-key]').forEach(function(cb) {
    var key = cb.getAttribute('data-col-key');
    var col = columnDefs.find(function(c) { return c.key === key; });
    if (col) col.visible = cb.checked;
  });
  // node_prop checkboxes each control a reg+tgt pair
  document.querySelectorAll('[data-node-prop]').forEach(function(cb) {
    var propName = cb.getAttribute('data-node-prop');
    ['np_reg_' + propName, 'np_tgt_' + propName].forEach(function(key) {
      var col = columnDefs.find(function(c) { return c.key === key; });
      if (col) col.visible = cb.checked;
    });
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

// Returns the currently-displayed rows respecting active filter and sort state.
// Used by both export functions so exports always match what the user sees.
function getActiveTableRows() {
  var sourceRows = tableViewMode === 'relation' ? relationRows : tableRows;

  // Apply filter (match what filterTable() does)
  var filterInput = document.getElementById('table-search');
  var q = filterInput ? filterInput.value.trim().toLowerCase() : '';
  var rows = q
    ? sourceRows.filter(function(row) {
        return Object.values(row).some(function(v) { return v && String(v).toLowerCase().includes(q); });
      })
    : sourceRows.slice();

  // Apply sort (match what sortTable() does)
  if (tableSortCol) {
    var colDef = columnDefs.find(function(c) { return c.key === tableSortCol; });
    var isNumeric = colDef && colDef.numeric;
    rows = rows.slice().sort(function(a, b) {
      var av = a[tableSortCol], bv = b[tableSortCol];
      if (isNumeric) {
        var an = av !== '' && av != null ? Number(av) : -Infinity;
        var bn = bv !== '' && bv != null ? Number(bv) : -Infinity;
        return tableSortAsc ? an - bn : bn - an;
      }
      av = String(av || '').toLowerCase();
      bv = String(bv || '').toLowerCase();
      return tableSortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }
  return rows;
}

function exportTableCSV() {
  var isRelMode = tableViewMode === 'relation';
  var rows = getActiveTableRows();
  var visCols = columnDefs.filter(function(c) {
    if (!c.visible) return false;
    if (isRelMode) return c.source === 'graph' || c.source === 'neo4j' || c.source === 'node_prop';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data' || c.source === 'node_prop';
  });
  var esc = function(v) { return '"' + String(v || '').replace(/"/g, '""') + '"'; };
  var lines = [visCols.map(function(c) { return esc(c.label); }).join(',')];
  rows.forEach(function(row) {
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
  var isRelMode = tableViewMode === 'relation';
  var exportRows = getActiveTableRows();
  var visCols = columnDefs.filter(function(c) {
    if (!c.visible) return false;
    if (isRelMode) return c.source === 'graph' || c.source === 'neo4j' || c.source === 'node_prop';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data' || c.source === 'node_prop';
  });
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
  exportRows.forEach(function(row) {
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
  // Pre-fill with the current tab name so repeat saves don't require retyping
  var suggested = (tabs[activeTabIdx] && tabs[activeTabIdx].name) || currentSubgraphName || '';
  document.getElementById('save-name-input').value = suggested;
  document.getElementById('save-modal').style.display = 'flex';
  setTimeout(function() {
    var inp = document.getElementById('save-name-input');
    inp.focus();
    inp.select();
  }, 100);
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

  // Strip edges whose endpoints aren't in the node list before saving.
  var nodeIdSet = new Set(graphData.nodes.map(function(n) { return String(n.id); }));
  var cleanEdges = graphData.edges.filter(function(e) {
    return nodeIdSet.has(String(e.startNodeId)) && nodeIdSet.has(String(e.endNodeId));
  });
  var saveData = {
    name: name,
    query: currentQuery,
    savedAt: new Date().toISOString(),
    layout: currentLayout,
    positions: positions,
    graphData: { nodes: graphData.nodes, edges: cleanEdges }
  };

  var blob = new Blob([JSON.stringify(saveData, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[^a-z0-9_\-]/gi, '_') + '.json';
  a.click();
  URL.revokeObjectURL(url);

  // Sync tab name and subgraph name to match the saved file
  currentSubgraphName = name;
  updateCurrentTabName(name);
  updateStats();
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
        setCypherQuery(data.query);
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
    if (res.status === 413) throw new Error('File too large for the server. Ask your administrator to increase the server upload limit.');
    var text = await res.text();
    var result;
    try { result = JSON.parse(text); } catch(e) {
      throw new Error('Server returned an unexpected response (status ' + res.status + '). The file may be too large.');
    }
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
    statsEl.innerHTML += ' <span id="enrich-status" style="color:#7a8099;font-size:11px">Loading matching data from database…</span>'
      + ' <span id="match-rnef-status" style="color:#4caf50;font-size:11px">· Matching relations…</span>';
  }
  enrichNodesFromNeo4j(data.graphData.nodes || []);
  matchRnefRelationsToNeo4j();
  switchView('graph');
}

function closeRnefModal(e) {
  if (e.target === document.getElementById('rnef-modal'))
    document.getElementById('rnef-modal').style.display = 'none';
}

// ── Match RNEF relations to Neo4j relations, annotating them with RelationID ──
// Runs silently after an RNEF pathway loads.  Builds two batches:
//   batch          – regular (1 regulator → 1 target) edges
//   hyperedgeBatch – ChemicalReaction edges (many regulators / many targets)
// On success, updates both graphData and cy so the RelationID appears in tooltips.
async function matchRnefRelationsToNeo4j() {
  if (!graphData || !cy) return;

  // Capture the tab index NOW (synchronously) so the async response knows
  // which tab it belongs to even if the user switches before it arrives.
  var matchTabIdx = activeTabIdx;
  matchingInProgress = true;

  // Normalize effect: RNEF "Unknown" and "_" mean the same as missing.
  function normEffect(v) {
    if (!v || v === 'Unknown' || v === '_') return '';
    return String(v);
  }

  // Build a nodeId → URN map (needed to resolve startNodeId/endNodeId to URNs).
  var nodeUrnById = {};
  graphData.nodes.forEach(function(n) {
    var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
    if (urn) nodeUrnById[String(n.id)] = urn;
  });

  // Build a reactionNodeId → { rURNs, tURNs } map for ChemicalReaction hyperedges.
  var reactionData = {};
  graphData.nodes.forEach(function(n) {
    if (n.labels && n.labels.includes('Reaction')) {
      reactionData[String(n.id)] = { rURNs: [], tURNs: [] };
    }
  });
  graphData.edges.forEach(function(e) {
    var endId = String(e.endNodeId), startId = String(e.startNodeId);
    if (e.type === 'Substrate' && reactionData[endId]) {
      var urn = nodeUrnById[startId];
      if (urn) reactionData[endId].rURNs.push(urn);
    } else if (e.type === 'Product' && reactionData[startId]) {
      var urn = nodeUrnById[endId];
      if (urn) reactionData[startId].tURNs.push(urn);
    }
  });

  var batch = [], hyperedgeBatch = [];

  graphData.edges.forEach(function(e) {
    if (!e.properties || !e.properties.URN) return;        // not an RNEF edge
    if (e.properties.RelationID != null) return;           // already annotated
    var relURN = String(e.properties.URN);
    var relType = e.type;
    var effect    = normEffect(e.properties.Effect || e.properties.effect || '');
    var mechanism = e.properties.Mechanism || e.properties.mechanism || '';

    if (relType === 'Substrate' || relType === 'Product') return;  // handled via Reaction node

    if (relType === 'ChemicalReaction') {
      var rURN = nodeUrnById[String(e.startNodeId)];
      var tURN = nodeUrnById[String(e.endNodeId)];
      if (rURN && tURN) batch.push({ rURN: rURN, tURN: tURN, relType: relType, effect: effect, mechanism: mechanism, relURN: relURN });
      return;
    }

    var rURN = nodeUrnById[String(e.startNodeId)];
    var tURN = nodeUrnById[String(e.endNodeId)];
    if (rURN && tURN) {
      batch.push({ rURN: rURN, tURN: tURN, relType: relType, effect: effect, mechanism: mechanism, relURN: relURN });
    }
  });

  // Reaction nodes → hyperedge batch entries
  Object.keys(reactionData).forEach(function(reactId) {
    var rd = reactionData[reactId];
    if (!rd.rURNs.length || !rd.tURNs.length) return;
    var reactNode = graphData.nodes.find(function(n) { return String(n.id) === reactId; });
    if (!reactNode || !reactNode.properties || !reactNode.properties.URN) return;
    if (reactNode.properties.RelationID != null) return;  // already annotated
    hyperedgeBatch.push({
      rURNs:     rd.rURNs,
      tURNs:     rd.tURNs,
      effect:    '',
      mechanism: '',
      relURN:    String(reactNode.properties.URN)
    });
  });

  if (!batch.length && !hyperedgeBatch.length) {
    // All edges already carry RelationID (e.g. pathway saved after a previous
    // matching run).  No need to call the match API, but we still need to:
    //   1. Fetch references for edges that have RelationID but no references
    //   2. Clean up the status span and matchingInProgress flag
    var preRelIds = [];
    graphData.edges.forEach(function(e) {
      if (!e.properties) return;
      if (Array.isArray(e.properties.references) && e.properties.references.length) return; // already has refs
      if (Array.isArray(e.properties.RelationIDs)) {
        e.properties.RelationIDs.forEach(function(id) { if (id != null) preRelIds.push(String(id)); });
      } else if (e.properties.RelationID != null) {
        preRelIds.push(String(e.properties.RelationID));
      }
    });
    // Also pre-populate refsCache from inline refs already present in graphData
    graphData.edges.forEach(function(e) {
      var relId = e.properties && e.properties.RelationID != null ? String(e.properties.RelationID) : '';
      if (relId && Array.isArray(e.properties.references) && e.properties.references.length) {
        refsCache[relId] = e.properties.references;
      }
    });
    var matchSpan = document.getElementById('match-rnef-status');
    if (preRelIds.length) {
      try {
        var preRefsGrouped = await api('/api/references/batch', { relationIds: preRelIds, scopusColumns: [] });
        function preRefSentenceKey(msrc) {
          if (!msrc) return '';
          return msrc.slice(0, 100).replace(/ID\{[^}]*\}/g, '').slice(0, 30);
        }
        function preRefKey(ref) {
          var sentence = preRefSentenceKey(ref.msrc || '');
          if (ref.doi)  return 'doi:'  + String(ref.doi).toLowerCase().trim()  + ' ' + sentence;
          if (ref.pmid) return 'pmid:' + String(ref.pmid).trim()               + ' ' + sentence;
          return 'cnt:' + (ref.pubyear || '') + ' ' + (ref.journal || '') + ' ' + sentence;
        }
        var isCurrentTabPre = (activeTabIdx === matchTabIdx);
        var targetGDpre = isCurrentTabPre
          ? graphData
          : (tabs[matchTabIdx] && tabs[matchTabIdx].snapshot && tabs[matchTabIdx].snapshot.graphData);
        var urnToCyEdgePre = {};
        if (isCurrentTabPre) {
          cy.edges().forEach(function(cyEdge) {
            var u = cyEdge.data('edgeURN');
            if (u) urnToCyEdgePre[String(u)] = cyEdge;
          });
        }
        if (targetGDpre) {
          targetGDpre.edges.forEach(function(e) {
            if (!e.properties || e.properties.RelationID == null) return;
            var relId = String(e.properties.RelationID);
            var dbRefs     = preRefsGrouped[relId] || [];
            var inlineRefs = Array.isArray(e.properties.references) ? e.properties.references : [];
            var allRefs    = inlineRefs.concat(dbRefs);
            var seenKeys   = new Set();
            var dedupedRefs = allRefs.filter(function(ref) {
              var k = preRefKey(ref);
              if (seenKeys.has(k)) return false;
              seenKeys.add(k);
              return true;
            });
            var refCount = calcRefCount(dedupedRefs);
            e.properties.references                 = dedupedRefs;
            e.properties.RelationNumberOfReferences = refCount;
            e.properties.RelationNumberOfSentences  = dedupedRefs.length;
            // Cache under every ID the edge carries (relId = primary; also RelationIDs array)
            var _preAllIds = Array.isArray(e.properties.RelationIDs)
              ? e.properties.RelationIDs.map(String)
              : (relId ? [relId] : []);
            _preAllIds.forEach(function(rid) {
              refsCache[rid] = dedupedRefs;
              if (!isCurrentTabPre && tabs[matchTabIdx] && tabs[matchTabIdx].snapshot) {
                tabs[matchTabIdx].snapshot.refsCache[rid] = dedupedRefs;
              }
            });
            if (isCurrentTabPre) {
              var cyEdge = urnToCyEdgePre[String(e.properties.URN || '')];
              if (cyEdge) {
                cyEdge.data('numRefs',      refCount);
                cyEdge.data('numSentences', dedupedRefs.length);
                cyEdge.data('thickness',    getEdgeThickness(refCount));
              }
            }
          });
        }
        if (matchSpan) { matchSpan.textContent = '· references loaded'; setTimeout(function() { if (matchSpan.parentNode) matchSpan.remove(); }, 3000); }
      } catch (preRefErr) {
        console.warn('matchRnefRelationsToNeo4j (pre-annotated): reference fetch failed:', preRefErr.message);
        if (matchSpan && matchSpan.parentNode) matchSpan.remove();
      }
    } else {
      if (matchSpan && matchSpan.parentNode) matchSpan.remove();
    }
    matchingInProgress = false;
    return;
  }

  try {
    var mapping = await api('/api/relations/match-rnef', { batch: batch, hyperedgeBatch: hyperedgeBatch });
    var matched = 0;

    var isCurrentTab = (activeTabIdx === matchTabIdx);

    // Choose target graphData: live global if still on this tab, otherwise
    // the tab's snapshot (same pattern as enrichNodesFromNeo4j).
    var targetGD = isCurrentTab
      ? graphData
      : (tabs[matchTabIdx] && tabs[matchTabIdx].snapshot && tabs[matchTabIdx].snapshot.graphData);
    if (!targetGD) return;

    if (!isCurrentTab) {
      // ── Background tab: annotate snapshot graphData only ──────────────────
      // cy belongs to the active tab — do not touch it.
      // When the user switches back, applyTabState → renderGraph will read
      // RelationID from the snapshot and populate cy edge relId correctly.
      targetGD.edges.forEach(function(e) {
        if (!e.properties || !e.properties.URN) return;
        var match = mapping[String(e.properties.URN)];
        if (!match) return;
        var relId = match.id || match;
        e.properties.RelationID = relId;
        if (match.numSentences != null) e.properties.RelationNumberOfSentences = match.numSentences;
        matched++;
      });
      targetGD.nodes.forEach(function(n) {
        if (!n.labels || !n.labels.includes('Reaction')) return;
        var nodeURN = n.properties && n.properties.URN ? String(n.properties.URN) : null;
        if (!nodeURN) return;
        var match = mapping[nodeURN];
        if (!match) return;
        n.properties.RelationID = match.id || match;
      });
      if (matched > 0) {
        console.log('matchRnefRelationsToNeo4j (background tab ' + matchTabIdx + '): annotated ' + matched + ' edge(s)');

        // ── Background tab: also fetch references so refsCache and snapshot are
        //    populated when the user switches back ──────────────────────────────
        var bgRelIds = [];
        targetGD.edges.forEach(function(e) {
          if (!e.properties) return;
          if (Array.isArray(e.properties.RelationIDs)) {
            e.properties.RelationIDs.forEach(function(id) { if (id != null) bgRelIds.push(String(id)); });
          } else if (e.properties.RelationID != null) {
            bgRelIds.push(String(e.properties.RelationID));
          }
        });
        if (bgRelIds.length) {
          try {
            var bgRefsGrouped = await api('/api/references/batch', { relationIds: bgRelIds, scopusColumns: [] });

            function bgRefSentenceKey(msrc) {
              if (!msrc) return '';
              return msrc.slice(0, 100).replace(/ID\{[^}]*\}/g, '').slice(0, 30);
            }
            function bgRefKey(ref) {
              var sentence = bgRefSentenceKey(ref.msrc || '');
              if (ref.doi)  return 'doi:'  + String(ref.doi).toLowerCase().trim()  + '\x00' + sentence;
              if (ref.pmid) return 'pmid:' + String(ref.pmid).trim()               + '\x00' + sentence;
              return 'cnt:' + (ref.pubyear || '') + '\x00' + (ref.journal || '') + '\x00' + sentence;
            }

            targetGD.edges.forEach(function(e) {
              if (!e.properties || e.properties.RelationID == null) return;
              var relId = String(e.properties.RelationID);
              var dbRefs     = bgRefsGrouped[relId] || [];
              var inlineRefs = Array.isArray(e.properties.references) ? e.properties.references : [];
              var allRefs    = inlineRefs.concat(dbRefs);
              var seenKeys   = new Set();
              var dedupedRefs = allRefs.filter(function(ref) {
                var k = bgRefKey(ref);
                if (seenKeys.has(k)) return false;
                seenKeys.add(k);
                return true;
              });
              var refCount = calcRefCount(dedupedRefs);
              e.properties.references                 = dedupedRefs;
              e.properties.RelationNumberOfReferences = refCount;
              e.properties.RelationNumberOfSentences  = dedupedRefs.length;
              // Cache under every ID the edge carries (relId = primary; also RelationIDs array)
              var _bgAllIds = Array.isArray(e.properties.RelationIDs)
                ? e.properties.RelationIDs.map(String)
                : (relId ? [relId] : []);
              _bgAllIds.forEach(function(rid) {
                refsCache[rid] = dedupedRefs;
                // Also persist into the snapshot's own refsCache so applyTabState
                // doesn't overwrite the entry when it does refsCache = Object.assign({}, s.refsCache)
                if (tabs[matchTabIdx] && tabs[matchTabIdx].snapshot) {
                  tabs[matchTabIdx].snapshot.refsCache[rid] = dedupedRefs;
                }
              });
            });
            console.log('matchRnefRelationsToNeo4j (background tab ' + matchTabIdx + '): references fetched for ' + bgRelIds.length + ' relation(s)');
          } catch (bgRefErr) {
            console.warn('matchRnefRelationsToNeo4j (background): reference fetch failed:', bgRefErr.message);
          }
        }
      }
      return;
    }

    // ── Current tab: update both graphData and live cy edges ─────────────────
    matchedRelIds.clear();

    // Apply RelationID back to graphData.edges and live cy edges.
    targetGD.edges.forEach(function(e) {
      if (!e.properties || !e.properties.URN) return;
      var relURN = String(e.properties.URN);
      var match  = mapping[relURN];
      if (!match) return;
      var relId  = match.id || match;

      e.properties.RelationID = relId;
      if (match.numSentences != null) e.properties.RelationNumberOfSentences = match.numSentences;
      cy.edges().forEach(function(cyEdge) {
        var urn = cyEdge.data('edgeURN');
        if (urn && String(urn) === relURN) {
          cyEdge.data('relId', relId);
          matchedRelIds.add(relId);
          matched++;
        }
      });
    });

    // Also annotate Reaction-node entries in graphData.nodes
    targetGD.nodes.forEach(function(n) {
      if (!n.labels || !n.labels.includes('Reaction')) return;
      var nodeURN = n.properties && n.properties.URN ? String(n.properties.URN) : null;
      if (!nodeURN) return;
      var match = mapping[nodeURN];
      if (!match) return;
      var relId = match.id || match;
      n.properties.RelationID = relId;
      var reactCyId = String(n.id);
      cy.edges().forEach(function(cyEdge) {
        var src = cyEdge.data('source'), tgt = cyEdge.data('target');
        if (src === reactCyId || tgt === reactCyId) {
          cyEdge.data('relId', relId);
          matchedRelIds.add(relId);
          matched++;
        }
      });
    });

    // ── Fetch and merge references for all newly matched edges ──────────────────
    // Uses the same assertion-level dedup key as mergeSimilarRelations so that
    // inline RNEF references and Neo4j DB references are combined without
    // creating duplicate rows for the same assertion.
    if (matched > 0) {
      var newRelIds = Array.from(matchedRelIds);
      try {
        var matchedRefsGrouped = await api('/api/references/batch', { relationIds: newRelIds, scopusColumns: [] });

        // Assertion-level key: identical to refKey / refSentenceKey in mergeSimilarRelations
        function mRefSentenceKey(msrc) {
          if (!msrc) return '';
          return msrc.slice(0, 100).replace(/ID\{[^}]*\}/g, '').slice(0, 30);
        }
        function mRefKey(ref) {
          var sentence = mRefSentenceKey(ref.msrc || '');
          if (ref.doi)  return 'doi:'  + String(ref.doi).toLowerCase().trim()  + '\x00' + sentence;
          if (ref.pmid) return 'pmid:' + String(ref.pmid).trim()               + '\x00' + sentence;
          return 'cnt:' + (ref.pubyear || '') + '\x00' + (ref.journal || '') + '\x00' + sentence;
        }

        // Build URN → cy edge map (only valid if still on same tab)
        var urnToCyEdgeMatch = {};
        if (activeTabIdx === matchTabIdx) {
          cy.edges().forEach(function(cyEdge) {
            var u = cyEdge.data('edgeURN');
            if (u) urnToCyEdgeMatch[String(u)] = cyEdge;
          });
        }

        targetGD.edges.forEach(function(e) {
          if (!e.properties || e.properties.RelationID == null) return;
          var relId = String(e.properties.RelationID);
          if (!matchedRelIds.has(relId)) return;

          var dbRefs     = matchedRefsGrouped[relId] || [];
          var inlineRefs = Array.isArray(e.properties.references) ? e.properties.references : [];

          // Merge inline RNEF refs (from XML) with DB refs, deduplicating at assertion level
          var allRefs = inlineRefs.concat(dbRefs);
          var seenKeys = new Set();
          var dedupedRefs = allRefs.filter(function(ref) {
            var k = mRefKey(ref);
            if (seenKeys.has(k)) return false;
            seenKeys.add(k);
            return true;
          });

          var refCount = calcRefCount(dedupedRefs);

          // Update graphData edge (persists into saved JSON / table view)
          e.properties.references                 = dedupedRefs;
          e.properties.RelationNumberOfReferences = refCount;
          e.properties.RelationNumberOfSentences  = dedupedRefs.length;

          // Update refsCache so tooltip and table show merged refs immediately
          refsCache[relId] = dedupedRefs;

          // Update cy edge display values (only when still on the same tab)
          if (activeTabIdx === matchTabIdx) {
            var cyEdge = urnToCyEdgeMatch[String(e.properties.URN || '')];
            if (cyEdge) {
              cyEdge.data('numRefs',      refCount);
              cyEdge.data('numSentences', dedupedRefs.length);
              cyEdge.data('thickness',    getEdgeThickness(refCount));
            }
          }
        });

        // Re-render open tooltip so reference count reflects the newly fetched data
        if (tooltipVisible && tooltipCurrentEdge && activeTabIdx === matchTabIdx) {
          var _tipRelId  = tooltipCurrentEdge.data('relId');
          var _tipRelIds = tooltipCurrentEdge.data('relIds') || (_tipRelId ? [_tipRelId] : []);
          var _tipRefs   = null;
          for (var _ti = 0; _ti < _tipRelIds.length; _ti++) {
            if (refsCache[_tipRelIds[_ti]] !== undefined) { _tipRefs = refsCache[_tipRelIds[_ti]]; break; }
          }
          if (_tipRefs !== null) renderTooltip(tooltipCurrentEdge, _tipRefs);
        }

      } catch (refErr) {
        console.warn('matchRnefRelationsToNeo4j: reference fetch failed:', refErr.message);
      }
    }

    var matchSpan = document.getElementById('match-rnef-status');
    if (matchSpan) {
      if (matched > 0) {
        matchSpan.textContent = '· ' + matched + ' relation(s) matched';
        matchSpan.style.color = '#4caf50';

        // If a tooltip is already open for a just-matched edge, re-render it now.
        if (tooltipVisible && tooltipCurrentEdge && tooltipCurrentEdge.data('relId')) {
          var relId = tooltipCurrentEdge.data('relId');
          var refs = refsCache[relId];
          if (refs === undefined) {
            api('/api/references', { relationIds: [relId] })
              .then(function(rows) { refsCache[relId] = rows; renderTooltip(tooltipCurrentEdge, rows); })
              .catch(function() { refsCache[relId] = []; renderTooltip(tooltipCurrentEdge, []); });
          } else {
            renderTooltip(tooltipCurrentEdge, refs);
          }
        }

        pendingMatchSpan = matchSpan;
        setTimeout(function() {
          if (pendingMatchSpan === matchSpan) {
            pendingMatchSpan = null;
            matchedRelIds.clear();
            if (matchSpan.parentNode) matchSpan.remove();
          }
        }, 60000);

      } else {
        matchSpan.remove();
      }
    }
    if (matched > 0) {
      console.log('matchRnefRelationsToNeo4j: annotated ' + matched + ' cy edge(s)');
    }
  } catch (err) {
    // Non-fatal — RNEF pathways work fine without RelationID annotation
    console.warn('matchRnefRelationsToNeo4j failed:', err.message);
    if (activeTabIdx === matchTabIdx) {
      var matchSpan = document.getElementById('match-rnef-status');
      if (matchSpan) matchSpan.remove();
    }
  } finally {
    matchingInProgress = false;
  }
}

// ─── Load similar relations from Neo4j ────────────────────────────────────────
// For every RNEF edge in the current pathway that has no RelationID, queries
// Neo4j for similar relations using a 3-tier matching hierarchy and adds the
// found Neo4j relations to the graph as new edges.
async function loadSimilarRelations() {
  if (!cy || !graphData) { alert('No pathway loaded.'); return; }
  if (matchingInProgress) { alert('Relation matching is still in progress. Please wait for it to finish before loading similar relations.'); return; }

  // Capture which tab started this search NOW (synchronously).
  // After the async API call returns the user may have switched to another tab;
  // this index lets us route writes to the correct graphData snapshot.
  var simTabIdx = activeTabIdx;

  var NONDIRECTIONAL = new Set(['Binding','CellExpression','FunctionalAssociation','Metabolization','Paralog']);

  // Build both maps directly from live cy nodes — more reliable than graphData
  // after enrichNodesFromNeo4j may have transformed node properties.
  var nodeUrnById = {};   // cyNodeId  → URN
  var urnToCyIds  = {};   // URN       → [cyNodeId, ...]
  // URN → graphData node ID (Neo4j integer after enrichment, URN before).
  // Used when pushing new edges to graphData so their startNodeId/endNodeId
  // match graphData.nodes[i].id — otherwise renderGraph skips them on tab restore.
  var urnToGdId = {};
  graphData.nodes.forEach(function(n) {
    var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
    if (urn && !n.isClone) urnToGdId[urn] = n.id;
  });
  cy.nodes().forEach(function(n) {
    var urn = n.data('URN');
    if (!urn) {
      // Clones may carry cloneOf; resolve to original's URN
      var orig = n.data('cloneOf');
      if (orig) urn = nodeUrnById[orig];  // orig already processed if it appeared first
    }
    if (!urn) return;
    nodeUrnById[n.id()] = String(urn);
    (urnToCyIds[urn] = urnToCyIds[urn] || []).push(n.id());
  });
  // Second pass for clones whose original hadn't been processed yet
  cy.nodes().forEach(function(n) {
    if (nodeUrnById[n.id()]) return;
    var orig = n.data('cloneOf');
    if (orig && nodeUrnById[orig]) {
      var urn = nodeUrnById[orig];
      nodeUrnById[n.id()] = urn;
      (urnToCyIds[urn] = urnToCyIds[urn] || []).push(n.id());
    }
  });

  // Collect RNEF edges without RelationID
  var unmatchedEdges = cy.edges().filter(function(e) {
    return e.data('edgeURN') && !e.data('relId');
  });
  if (!unmatchedEdges.length) {
    alert('All relations in this pathway already have a RelationID.');
    return;
  }

  // Build batch
  var batch = [];
  unmatchedEdges.forEach(function(e, idx) {
    var rURN = nodeUrnById[e.data('source')];
    var tURN = nodeUrnById[e.data('target')];
    if (rURN && tURN) {
      batch.push({
        idx:       idx,
        rURN:      rURN,
        tURN:      tURN,
        relType:   e.data('relType') || '',
        effect:    e.data('effect')  || '',
        mechanism: e.data('mechanism') || ''
      });
    }
  });
  if (!batch.length) {
    var diag = 'Could not resolve node URNs for any unmatched relation.\n\n'
      + 'Unmatched edges: ' + unmatchedEdges.length + '\n'
      + 'Nodes with URN: ' + Object.keys(nodeUrnById).length + '\n'
      + 'Sample source IDs: ' + unmatchedEdges.slice(0,3).map(function(e){ return e.data('source'); }).join(', ');
    alert(diag);
    return;
  }

  // Show progress in stats bar
  var statsEl = document.getElementById('graph-stats');
  var simSpan = document.createElement('span');
  simSpan.id = 'sim-rel-status';
  simSpan.style.cssText = 'color:#7a8099;font-size:11px';
  simSpan.textContent = ' · Searching for similar relations…';
  if (statsEl) statsEl.appendChild(simSpan);

  try {
    var response = await api('/api/relations/find-similar', { relations: batch });
    var results  = response.results || [];

    // ── Re-establish targets after the async gap ──────────────────────────────
    // If the user opened a new tab while the search was running, cy and graphData
    // now belong to that OTHER tab.  We must never touch the wrong cy (which would
    // corrupt tab 2) or the wrong graphData.  Instead we route all writes to the
    // snapshot of the originating tab; renderGraph will apply them when the user
    // switches back.
    var isCurrentTab = (activeTabIdx === simTabIdx);
    var targetGD = isCurrentTab
      ? graphData
      : (tabs[simTabIdx] && tabs[simTabIdx].snapshot && tabs[simTabIdx].snapshot.graphData);

    if (!targetGD) {
      // The originating tab was closed while the search was in flight
      if (simSpan.parentNode) simSpan.remove();
      return;
    }

    // Rebuild urnToGdId from the chosen targetGD — enrichNodesFromNeo4j may have
    // updated node IDs after the batch request was sent.
    var targetUrnToGdId = {};
    targetGD.nodes.forEach(function(n) {
      var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
      if (urn && !n.isClone) targetUrnToGdId[urn] = n.id;
    });

    // Build existingRelIds from the correct data source
    var existingRelIds = new Set();
    if (isCurrentTab) {
      cy.edges().forEach(function(e) {
        var rid = e.data('relId'); if (rid) existingRelIds.add(rid);
        var rids = e.data('relIds'); if (rids) rids.forEach(function(id) { existingRelIds.add(id); });
      });
    } else {
      targetGD.edges.forEach(function(e) {
        var rid = e.properties && e.properties.RelationID;
        if (rid) existingRelIds.add(String(rid));
        var rids = e.properties && e.properties.RelationIDs;
        if (Array.isArray(rids)) rids.forEach(function(id) { existingRelIds.add(String(id)); });
      });
    }
    var preMatchedCount = existingRelIds.size;

    // Snapshot for undo — only meaningful when still on the originating tab
    if (isCurrentTab) pushUndo();

    // Counters for summary
    var exactCount   = 0;   // idx matched at Check 1
    var similarIdxs  = new Set();  // original idx matched at Check 2 or 3
    var addedEdges   = 0;   // new edges pushed to targetGD (and cy when current tab)

    results.forEach(function(entry) {
      if (entry.check === 1) exactCount++;
      else similarIdxs.add(entry.idx);

      // The original unmatchedEdges cy element references retain their .data()
      // even after the element is removed from cy on a tab switch — safe to read.
      var origEdge = unmatchedEdges[entry.idx];
      var edgeURN  = origEdge ? String(origEdge.data('edgeURN') || '') : '';

      // For Check 1 exact matches, annotate the existing RNEF edge in graphData
      // and (if still on same tab) in the live cy graph.
      if (entry.check === 1 && entry.relations.length > 0) {
        var firstRel = entry.relations[0];
        if (firstRel.relationID && firstRel.relationID !== 'null') {
          var gEdge = edgeURN ? targetGD.edges.find(function(e) {
            return e.properties && String(e.properties.URN) === edgeURN;
          }) : null;
          if (gEdge) gEdge.properties.RelationID = firstRel.relationID;
          if (isCurrentTab && edgeURN) {
            cy.edges().forEach(function(cyE) {
              if (String(cyE.data('edgeURN')) === edgeURN) cyE.data('relId', firstRel.relationID);
            });
          }
        }
      }

      // Add each found Neo4j relation as a new edge (dedup by RelationID)
      entry.relations.forEach(function(rel) {
        if (!rel.relationID || rel.relationID === 'null') return;
        if (existingRelIds.has(rel.relationID)) return;
        existingRelIds.add(rel.relationID);

        var undirected = NONDIRECTIONAL.has(rel.relType);
        var numRefs    = typeof rel.numRefs === 'number' ? rel.numRefs : 0;
        var edgeId     = 'sim-' + rel.relationID;

        // Resolve graphData node IDs (rebuilt after potential enrichment)
        var srcGdId = targetUrnToGdId[rel.rURN] !== undefined ? targetUrnToGdId[rel.rURN] : rel.rURN;
        var tgtGdId = targetUrnToGdId[rel.tURN] !== undefined ? targetUrnToGdId[rel.tURN] : rel.tURN;

        if (isCurrentTab) {
          // ── Current tab: need valid cy node IDs; skip edge if nodes absent ──
          var srcCyIds = urnToCyIds[rel.rURN] || [];
          var tgtCyIds = urnToCyIds[rel.tURN] || [];
          if (!srcCyIds.length || !tgtCyIds.length) return;

          var srcCyId = (origEdge && srcCyIds.indexOf(origEdge.data('source')) >= 0)
            ? origEdge.data('source') : srcCyIds[0];
          var tgtCyId = (origEdge && tgtCyIds.indexOf(origEdge.data('target')) >= 0)
            ? origEdge.data('target') : tgtCyIds[0];

          var _simEdge = {
            id: edgeId, elementId: edgeId, type: rel.relType,
            startNodeId: srcGdId, endNodeId: tgtGdId,
            properties: {
              RelationID: rel.relationID, Effect: rel.effect, Mechanism: rel.mechanism,
              RelationNumberOfReferences: numRefs, directed: !undirected, sourceType: 'similar'
            }
          };
          targetGD.edges.push(_simEdge);
          cy.add({
            group: 'edges',
            classes: undirected ? 'undirected' : '',
            data: _buildCyEdgeData(_simEdge, srcCyId, tgtCyId)
          });

        } else {
          // ── Background tab: write only to snapshot graphData ─────────────────
          // cy will render these edges when the user switches back and
          // applyTabState → renderGraph reads them from the snapshot.
          targetGD.edges.push({
            id: edgeId, elementId: edgeId, type: rel.relType,
            startNodeId: srcGdId, endNodeId: tgtGdId,
            properties: {
              RelationID: rel.relationID, Effect: rel.effect, Mechanism: rel.mechanism,
              RelationNumberOfReferences: numRefs, directed: !undirected, sourceType: 'similar'
            }
          });
        }
        addedEdges++;
      });
    });

    // Update status
    if (simSpan.parentNode) {
      if (addedEdges > 0) {
        simSpan.style.color = '#4caf50';
        simSpan.textContent = ' · ' + addedEdges + ' similar relation(s) added';
        setTimeout(function() { if (simSpan.parentNode) simSpan.remove(); }, 5000);
      } else {
        simSpan.remove();
      }
    }

    // Summary message
    var msg = 'Load similar relations complete:\n\n'
      + '  Relations with RelationID before this search: ' + preMatchedCount + '\n'
      + '  New exact matches found (RelationID assigned): ' + exactCount + '\n'
      + '  Original pathway relations that have similar relations in the database: ' + similarIdxs.size + '\n'
      + '  Similar relations loaded from Neo4j: ' + addedEdges;
    alert(msg);

  } catch (err) {
    if (simSpan.parentNode) simSpan.remove();
    alert('Load similar relations failed: ' + err.message);
  }
}

// ─── Merge Similar Relations ──────────────────────────────────────────────────
// Groups edges in the current graph that connect the same two nodes and share
// equivalent relation types (per FRD 3.2 + server TYPE3_EQUIV), then collapses
// each group into a single anchor edge: merging references and resolving effect.
// Extract direction token from an RNEF edge URN, e.g. 'out', 'in-out', 'in'.
function edgeDirectionToken(ei) {
  if (!ei || !ei.edgeURN) return null;
  var m = ei.edgeURN.match(/^urn:agi-[^:]+:([^:]+):/);
  return m ? m[1] : null;
}

// ─── Find relations between selected and unselected nodes ────────────────────
// filterType: 'all' | 'direct' | 'biomarker' | 'indirect'
async function findRelationsBetweenGroups(filterType) {
  if (!cy || !graphData) { alert('No pathway loaded.'); return; }

  // Collect selected node URNs
  var selectedNodes = cy.nodes(':selected').not('[?isClone]');
  if (selectedNodes.length === 0) {
    alert('Please select at least one node to find relations.');
    return;
  }

  var selectedURNs   = [];
  var selectedCyIds  = new Set();
  selectedNodes.forEach(function(n) {
    var urn = n.data('urn') || n.data('URN') || '';
    if (urn) { selectedURNs.push(urn); selectedCyIds.add(n.id()); }
  });

  // All node URNs in pathway (originals only, no clones)
  var allURNs = [];
  cy.nodes().not('[?isClone]').forEach(function(n) {
    var urn = n.data('urn') || n.data('URN') || '';
    if (urn) allURNs.push(urn);
  });

  if (selectedURNs.length === 0) {
    alert('Selected nodes have no URNs — cannot query database.');
    return;
  }

  // Build URN → cy node ID map (mirrors loadSimilarRelations, avoids clone IDs)
  var nodeUrnById = {};  // cyNodeId → URN
  var urnToCyIdsLocal = {};  // URN → [cyNodeId, ...]
  cy.nodes().forEach(function(n) {
    var urn = n.data('URN');
    if (!urn) {
      var orig = n.data('cloneOf');
      if (orig) urn = nodeUrnById[orig];
    }
    if (!urn) return;
    nodeUrnById[n.id()] = String(urn);
    (urnToCyIdsLocal[urn] = urnToCyIdsLocal[urn] || []).push(n.id());
  });
  // Prefer non-clone cy ID for each URN
  var urnToCyId = {};
  Object.keys(urnToCyIdsLocal).forEach(function(urn) {
    var ids = urnToCyIdsLocal[urn];
    for (var i = 0; i < ids.length; i++) {
      if (!cy.$id(ids[i]).data('isClone')) { urnToCyId[urn] = ids[i]; break; }
    }
    if (!urnToCyId[urn]) urnToCyId[urn] = ids[0];
  });

  // Build URN → graphData node ID map
  var urnToGdId = {};
  graphData.nodes.forEach(function(n) {
    var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
    if (urn && urnToGdId[urn] === undefined) urnToGdId[urn] = n.id;
  });

  // Collect already-present RelationIDs to avoid duplicates
  var existingRelIds = new Set();
  cy.edges().forEach(function(e) {
    var rid = e.data('relId'); if (rid) existingRelIds.add(String(rid));
  });

  var filterLabel = { all: 'All', direct: 'Direct physical interactions',
                      biomarker: 'Biomarker', indirect: 'Indirect' }[filterType] || filterType;

  var resp;
  try {
    resp = await api('/api/relations/find-between', {
      selectedURNs: selectedURNs,
      allURNs:      allURNs,
      filterType:   filterType,
    });
  } catch (err) {
    alert('Query failed: ' + err.message);
    return;
  }

  var relations = (resp && resp.relations) || [];

  // Filter out already-present edges
  var newRelations = relations.filter(function(r) {
    return r.relationID && !existingRelIds.has(String(r.relationID));
  });

  // Build breakdown by relation type for the confirmation dialog
  var byType = {};
  newRelations.forEach(function(r) {
    byType[r.relType] = (byType[r.relType] || 0) + 1;
  });
  var breakdown = Object.keys(byType).sort()
    .map(function(t) { return '  ' + t + ': ' + byType[t]; }).join('\n');

  var msg = 'Filter: ' + filterLabel + '\n' +
            'Will add ' + newRelations.length + ' relation(s)' +
            (newRelations.length > 0 ? ':\n' + breakdown : '.') +
            '\n\nClick OK to add them to the pathway.';

  if (!confirm(msg)) return;
  if (newRelations.length === 0) return;

  pushUndo();

  // Add edges to graph
  var NONDIRECTIONAL = new Set(['Binding','CellExpression','FunctionalAssociation','Metabolization','Paralog']);
  var added = 0;
  newRelations.forEach(function(rel) {
    var srcCyId = urnToCyId[rel.rURN];
    var tgtCyId = urnToCyId[rel.tURN];
    if (!srcCyId || !tgtCyId) return;  // skip if a node isn't in this pathway

    var undirected = NONDIRECTIONAL.has(rel.relType);
    var numRefs    = typeof rel.numRefs === 'number' ? rel.numRefs : 0;
    var edgeId     = 'sim-' + rel.relationID;

    // graphData node IDs
    var srcGdId = urnToGdId[rel.rURN] !== undefined ? urnToGdId[rel.rURN] : rel.rURN;
    var tgtGdId = urnToGdId[rel.tURN] !== undefined ? urnToGdId[rel.tURN] : rel.tURN;

    var _betweenEdge = {
      id: edgeId, elementId: edgeId, type: rel.relType,
      startNodeId: srcGdId, endNodeId: tgtGdId,
      properties: {
        RelationID: rel.relationID, Effect: rel.effect, Mechanism: rel.mechanism,
        RelationNumberOfReferences: numRefs, directed: !undirected, sourceType: 'between'
      }
    };
    graphData.edges.push(_betweenEdge);
    cy.add({
      group: 'edges',
      classes: undirected ? 'undirected' : '',
      data: _buildCyEdgeData(_betweenEdge, srcCyId, tgtCyId)
    });
    added++;
  });

  updateStats();
  if (document.getElementById('table-view').style.display !== 'none') {
    if (tableViewMode === 'relation') loadRelationData();
    else { tableRows = []; loadTableData(); }
  }
  if (added === 0) alert('No new edges could be placed (nodes not found in pathway).');
}


// ─── Connect Selected Nodes ───────────────────────────────────────────────────
// Finds edges whose BOTH endpoints are among the currently selected nodes
// (closed-loop / inner-connections query).
// filterType: 'all' | 'direct' | 'biomarker' | 'indirect'
async function connectSelectedNodes(filterType) {
  if (!cy || !graphData) { alert('No pathway loaded.'); return; }

  var selectedNodes = cy.nodes(':selected').not('[?isClone]');
  if (selectedNodes.length < 2) {
    alert('Please select at least two nodes to find connections between them.');
    return;
  }

  var selectedURNs = [];
  var selectedCyIds = new Set();
  selectedNodes.forEach(function(n) {
    var urn = n.data('URN') || n.data('urn') || '';
    if (urn) { selectedURNs.push(urn); selectedCyIds.add(n.id()); }
  });

  if (selectedURNs.length < 2) {
    alert('Selected nodes have no URNs — cannot query database.');
    return;
  }

  // Build URN → cy node ID map (non-clone preferred)
  var urnToCyIdsLocal = {};
  cy.nodes().forEach(function(n) {
    var urn = n.data('URN');
    if (!urn) return;
    (urnToCyIdsLocal[urn] = urnToCyIdsLocal[urn] || []).push(n.id());
  });
  var urnToCyId = {};
  Object.keys(urnToCyIdsLocal).forEach(function(urn) {
    var ids = urnToCyIdsLocal[urn];
    for (var i = 0; i < ids.length; i++) {
      if (!cy.$id(ids[i]).data('isClone')) { urnToCyId[urn] = ids[i]; break; }
    }
    if (!urnToCyId[urn]) urnToCyId[urn] = ids[0];
  });

  // Build URN → graphData node ID map
  var urnToGdId = {};
  graphData.nodes.forEach(function(n) {
    var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
    if (urn && urnToGdId[urn] === undefined) urnToGdId[urn] = n.id;
  });

  // Collect already-present RelationIDs to avoid duplicates
  var existingRelIds = new Set();
  cy.edges().forEach(function(e) {
    var rid = e.data('relId'); if (rid) existingRelIds.add(String(rid));
  });

  var filterLabel = { all: 'All', direct: 'Direct physical interactions',
                      biomarker: 'Biomarker', indirect: 'Indirect' }[filterType] || filterType;

  var resp;
  try {
    resp = await api('/api/relations/connect-selected', {
      selectedURNs: selectedURNs,
      filterType:   filterType,
    });
  } catch (err) {
    alert('Query failed: ' + err.message);
    return;
  }

  var relations = (resp && resp.relations) || [];
  var newRelations = relations.filter(function(r) {
    return r.relationID && !existingRelIds.has(String(r.relationID));
  });

  // Build breakdown by relation type
  var byType = {};
  newRelations.forEach(function(r) {
    byType[r.relType] = (byType[r.relType] || 0) + 1;
  });
  var breakdown = Object.keys(byType).sort()
    .map(function(t) { return '  ' + t + ': ' + byType[t]; }).join('\n');

  var msg = 'Filter: ' + filterLabel + '\n' +
            'Will add ' + newRelations.length + ' relation(s)' +
            (newRelations.length > 0 ? ':\n' + breakdown : '.') +
            '\n\nClick OK to add them to the pathway.';

  if (!confirm(msg)) return;
  if (newRelations.length === 0) return;

  pushUndo();

  var NONDIRECTIONAL = new Set(['Binding','CellExpression','FunctionalAssociation','Metabolization','Paralog']);
  var added = 0;
  newRelations.forEach(function(rel) {
    var srcCyId = urnToCyId[rel.rURN];
    var tgtCyId = urnToCyId[rel.tURN];
    if (!srcCyId || !tgtCyId) return;

    var undirected = NONDIRECTIONAL.has(rel.relType);
    var numRefs    = typeof rel.numRefs === 'number' ? rel.numRefs : 0;
    var edgeId     = 'sim-' + rel.relationID;

    var srcGdId = urnToGdId[rel.rURN] !== undefined ? urnToGdId[rel.rURN] : rel.rURN;
    var tgtGdId = urnToGdId[rel.tURN] !== undefined ? urnToGdId[rel.tURN] : rel.tURN;

    var _connEdge = {
      id: edgeId, elementId: edgeId, type: rel.relType,
      startNodeId: srcGdId, endNodeId: tgtGdId,
      properties: {
        RelationID: rel.relationID, Effect: rel.effect, Mechanism: rel.mechanism,
        RelationNumberOfReferences: numRefs, directed: !undirected, sourceType: 'connect-selected'
      }
    };
    graphData.edges.push(_connEdge);
    cy.add({
      group: 'edges',
      classes: undirected ? 'undirected' : '',
      data: _buildCyEdgeData(_connEdge, srcCyId, tgtCyId)
    });
    added++;
  });

  updateStats();
  if (document.getElementById('table-view').style.display !== 'none') {
    if (tableViewMode === 'relation') loadRelationData();
    else { tableRows = []; loadTableData(); }
  }
  if (added === 0) alert('No new edges could be placed (nodes not found in pathway).');
}


async function mergeSimilarRelations() {
  if (!cy || !graphData) { alert('No pathway loaded.'); return; }
  if (matchingInProgress) { alert('Relation matching is still in progress. Please wait for it to finish before merging.'); return; }

  // ── Type equivalence (symmetric, from FRD 3.2 + server TYPE3_EQUIV) ─────────
  var MERGE_EQUIV = {
    'DirectRegulation': new Set(['Binding','ProtModification','Regulation','FunctionalAssociation']),
    'Binding':          new Set(['DirectRegulation','ProtModification','Regulation']),
    'ProtModification': new Set(['DirectRegulation','Binding','Regulation','FunctionalAssociation']),
    'Biomarker':        new Set(['QuantitativeChange','StateChange','FunctionalAssociation']),
    'QuantitativeChange': new Set(['Biomarker']),
    'StateChange':      new Set(['Biomarker']),
    'FunctionalAssociation': new Set(['Biomarker','Regulation','DirectRegulation','ProtModification','MolTransport','MolSynthesis']),
    'MolSynthesis':     new Set(['Regulation','FunctionalAssociation']),
    'MolTransport':     new Set(['Regulation','FunctionalAssociation']),
    'PromoterBinding':  new Set(['Expression','Regulation']),
    'Expression':       new Set(['PromoterBinding']),
    'Regulation':       new Set(['DirectRegulation','FunctionalAssociation','PromoterBinding','MolSynthesis','MolTransport','ProtModification']),
  };

  // ── Anchor class precedence (FRD 3.2): higher = preferred anchor ─────────────
  var CLASS_SCORE = {
    'DirectRegulation': 6, 'ProtModification': 5, 'Biomarker': 4,
    'MolTransport': 3,  'MolSynthesis': 3,  'Regulation': 2,
    'Binding': 1, 'PromoterBinding': 1, 'Expression': 1,
    'QuantitativeChange': 0, 'StateChange': 0, 'FunctionalAssociation': 0,
  };

  function normEff(v) {
    if (!v) return '';
    var s = String(v);
    return (s === '_' || s.toLowerCase() === 'unknown') ? '' : s;
  }

  // Strip ID{...} markup from the first 100 chars, then take first 30 as key fragment
  function refSentenceKey(msrc) {
    if (!msrc) return '';
    return msrc.slice(0, 100).replace(/ID\{[^}]*\}/g, '').slice(0, 30);
  }

  function refKey(ref) {
    // Keys are assertion-level: same paper can produce multiple assertions.
    // Combine a paper identifier with the sentence fragment so two assertions
    // from the same paper are kept distinct, but the exact same assertion
    // appearing in multiple source edges is deduplicated.
    var sentence = refSentenceKey(ref.msrc || '');
    if (ref.doi)  return 'doi:'  + String(ref.doi).toLowerCase().trim()  + '\x00' + sentence;
    if (ref.pmid) return 'pmid:' + String(ref.pmid).trim()               + '\x00' + sentence;
    // Fall back to year+journal+sentence when no identifier is available
    return 'cnt:' + (ref.pubyear || '') + '\x00' + (ref.journal || '') + '\x00' + sentence;
  }

  // ── Node URN lookup ───────────────────────────────────────────────────────────
  var nodeUrnById = {};
  cy.nodes().forEach(function(n) {
    var urn = n.data('URN');
    if (!urn) { var orig = n.data('cloneOf'); if (orig) urn = nodeUrnById[orig]; }
    if (urn) nodeUrnById[n.id()] = String(urn);
  });
  // Second pass for clones whose original hadn't been processed yet
  cy.nodes().forEach(function(n) {
    if (nodeUrnById[n.id()]) return;
    var orig = n.data('cloneOf');
    if (orig && nodeUrnById[orig]) nodeUrnById[n.id()] = nodeUrnById[orig];
  });

  // ── Collect edge data ─────────────────────────────────────────────────────────
  var SKIP_TYPES = new Set(['Substrate', 'Product']);
  // Types where A→B and B→A are the same relation (no directionality).
  // All other types are directional: opposite-direction edges must not merge.
  var NONDIRECTIONAL_MERGE = new Set(['Binding','CellExpression','FunctionalAssociation','Metabolization','Paralog']);
  var edgeInfos = [];

  cy.edges().forEach(function(e) {
    var relType = e.data('relType') || '';
    if (!relType || SKIP_TYPES.has(relType)) return;
    var srcURN = nodeUrnById[e.data('source')];
    var tgtURN = nodeUrnById[e.data('target')];
    if (!srcURN || !tgtURN) return;

    // Undirected types (Binding, FunctionalAssociation, etc.): sort the pair so
    // A→B and B→A share one key — direction is meaningless for these types.
    // Directional types (Regulation, MolTransport, etc.): preserve direction.
    // An edge A→B and an edge B→A are distinct biological statements and must
    // NOT be merged just because they share the same two endpoints.
    var pairKey = NONDIRECTIONAL_MERGE.has(relType)
      ? (srcURN < tgtURN ? srcURN + '\x00' + tgtURN : tgtURN + '\x00' + srcURN)
      : srcURN + '\x00' + tgtURN;

    // Collect references from inline graphData OR refsCache
    var refs = [];
    var relId  = e.data('relId')   || null;
    var edgeURN = e.data('edgeURN') || null;
    if (relId && refsCache[relId]) {
      refs = refsCache[relId].slice();
    } else {
      var gEdge = edgeURN
        ? graphData.edges.find(function(ge) { return ge.properties && String(ge.properties.URN) === edgeURN; })
        : (relId ? graphData.edges.find(function(ge) { return ge.properties && String(ge.properties.RelationID) === relId; }) : null);
      if (!gEdge) gEdge = graphData.edges.find(function(ge) { return ge.id === e.id(); });
      if (gEdge && gEdge.properties && Array.isArray(gEdge.properties.references)) {
        refs = gEdge.properties.references.slice();
      }
    }

    edgeInfos.push({
      cyEdge:   e,
      id:       e.id(),
      relType:  relType,
      srcURN:   srcURN,
      tgtURN:   tgtURN,
      pairKey:  pairKey,
      effect:   normEff(e.data('effect') || ''),
      mechanism: normEff(e.data('mechanism') || ''),
      numRefs:  refs.length || (parseInt(e.data('numRefs')) || 0),
      refs:     refs,
      relId:    relId,
      edgeURN:  edgeURN,
    });
  });

  // ── Fetch missing reference objects for sim edges ────────────────────────────
  // loadSimilarRelations stores only numRefs (a count); the actual ref objects
  // needed for dedup/merge are fetched here on demand.
  var missingRelIds = edgeInfos
    .filter(function(ei) { return ei.relId && !ei.edgeURN && ei.refs.length === 0 && ei.numRefs > 0; })
    .map(function(ei) { return ei.relId; });
  if (missingRelIds.length > 0) {
    try {
      var fetchedRefs = await api('/api/references/batch', { relationIds: missingRelIds, scopusColumns: [] });
      edgeInfos.forEach(function(ei) {
        if (!ei.relId || ei.edgeURN || ei.refs.length > 0) return;
        var refs = (fetchedRefs[ei.relId]) || [];
        if (refs.length > 0) {
          refsCache[ei.relId] = refs;
          ei.refs    = refs;
          ei.numRefs = calcRefCount(refs) || ei.numRefs;
        }
      });
    } catch (fetchErr) {
      console.warn('[MERGE-DEBUG] Failed to fetch sim refs for merge:', fetchErr.message);
    }
  }

  // ── Union-Find grouping ───────────────────────────────────────────────────────
  console.log('[MERGE-DEBUG] edgeInfos collected:', edgeInfos.length,
    '(cy.edges total:', cy.edges().length, ', SKIP/no-URN excluded)');
  edgeInfos.forEach(function(ei) {
    var srcN = cy.$id(ei.cyEdge.data('source')); var tgtN = cy.$id(ei.cyEdge.data('target'));
    var srcClone = srcN.data('isClone') ? '[clone]' : '';
    var tgtClone = tgtN.data('isClone') ? '[clone]' : '';
    console.log('[MERGE-DEBUG]  edge:', ei.id.slice(0,60),
      '| type:', ei.relType,
      '| src:', (ei.srcURN||'').split(':').pop() + srcClone,
      '-> tgt:', (ei.tgtURN||'').split(':').pop() + tgtClone,
      '| rnef:', !!ei.edgeURN, '| relId:', ei.relId,
      '| refs:', ei.numRefs, '| effect:', ei.effect || '(none)');
  });
  var uf = {};
  edgeInfos.forEach(function(e) { uf[e.id] = e.id; });

  function ufFind(x) {
    while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; }
    return x;
  }
  function ufUnion(x, y) {
    var px = ufFind(x), py = ufFind(y);
    if (px !== py) uf[px] = py;
  }

  // Two edges connect the "same" node pair when:
  //   - forward direction matches (srcURN===srcURN, tgtURN===tgtURN), OR
  //   - reverse direction AND at least one of the types is nondirectional
  //     (e.g. Binding A-B should group with DirectRegulation A→B)
  function sameNodePair(e1, e2) {
    if (e1.srcURN === e2.srcURN && e1.tgtURN === e2.tgtURN) return true;
    var rev = e1.srcURN === e2.tgtURN && e1.tgtURN === e2.srcURN;
    return rev && (NONDIRECTIONAL_MERGE.has(e1.relType) || NONDIRECTIONAL_MERGE.has(e2.relType));
  }

  for (var i = 0; i < edgeInfos.length; i++) {
    for (var j = i + 1; j < edgeInfos.length; j++) {
      var e1 = edgeInfos[i], e2 = edgeInfos[j];
      if (!sameNodePair(e1, e2)) continue;
      var t1 = e1.relType, t2 = e2.relType;
      if (t1 === t2 || (MERGE_EQUIV[t1] && MERGE_EQUIV[t1].has(t2))) {
        ufUnion(e1.id, e2.id);
      }
    }
  }

  // Build groups (only those with >1 edge need merging)
  var groups = {};
  edgeInfos.forEach(function(e) {
    var root = ufFind(e.id);
    (groups[root] = groups[root] || []).push(e);
  });

  // ── Process each merge group ──────────────────────────────────────────────────
  var multiGroups = Object.values(groups).filter(function(g){ return g.length > 1; });
  console.log('[MERGE-DEBUG] groups total:', Object.keys(groups).length,
    '| groups needing merge:', multiGroups.length);
  multiGroups.forEach(function(g, gi) {
    console.log('[MERGE-DEBUG]  group', gi, '(' + g.length + ' edges):');
    g.forEach(function(ei) {
      var srcN = cy.$id(ei.cyEdge.data('source')); var tgtN = cy.$id(ei.cyEdge.data('target'));
      console.log('[MERGE-DEBUG]    -', ei.relType,
        (ei.srcURN||'').split(':').pop() + (srcN.data('isClone') ? '[clone]':''),
        '->', (ei.tgtURN||'').split(':').pop() + (tgtN.data('isClone') ? '[clone]':''),
        '| rnef:', !!ei.edgeURN, '| relId:', ei.relId,
        '| tier:', (ei.effect?1:0)+(ei.mechanism?1:0),
        '| class:', ei.relType, '| refs:', ei.numRefs);
    });
  });
  // Check whether any groups actually need merging before touching the graph
  var hasWork = Object.values(groups).some(function(g) { return g.length > 1; });
  if (!hasWork) {
    alert('No similar relations found to merge in this pathway.');
    return;
  }

  // Snapshot before modifications so the operation is undoable
  pushUndo();

  var mergedGroupCount = 0, removedEdgeCount = 0;

  function findGEdge(info) {
    if (info.edgeURN) {
      var e = graphData.edges.find(function(ge) { return ge.properties && String(ge.properties.URN) === info.edgeURN; });
      if (e) return e;
    }
    if (info.relId) {
      var e = graphData.edges.find(function(ge) { return ge.properties && String(ge.properties.RelationID) === info.relId; });
      if (e) return e;
    }
    return graphData.edges.find(function(ge) { return ge.id === info.id; });
  }

  Object.values(groups).forEach(function(group) {
    if (group.length < 2) return;

    // Completeness tier: 2 = effect+mechanism, 1 = effect only, 0 = neither
    function tier(e) { return (e.effect ? 1 : 0) + (e.mechanism ? 1 : 0); }

    // Number of clone-node endpoints on an edge (0, 1 or 2).
    // Edges connecting to original (non-clone) nodes are preferred as anchors so
    // that the remaining edge stays visually attached to the canonical node,
    // rather than to a clone copy that may float at a different position.
    function cloneEndpointCount(e) {
      var srcClone = cy.$id(e.cyEdge.data('source')).data('isClone') ? 1 : 0;
      var tgtClone = cy.$id(e.cyEdge.data('target')).data('isClone') ? 1 : 0;
      return srcClone + tgtClone;
    }

    // Sort: completeness desc → class score desc → RNEF before sim → numRefs desc → clone endpoints asc
    //
    // RNEF edges (edgeURN set) carry the original pathway layout: clone nodes are
    // intentionally positioned near their logical neighbours.  Sim edges (no edgeURN)
    // connect to the canonical/original node which may be far away in the layout.
    // Always prefer an RNEF edge as anchor so the merged result stays attached to the
    // clone that is already visually correct in the pathway.
    // Clone-endpoint count is a secondary tiebreaker: when two RNEF edges have equal
    // quality, prefer the one connecting to the original (non-clone) node.
    group.sort(function(a, b) {
      // CLASS_SCORE is primary: a sim with higher biological specificity
      // (e.g. DirectRegulation=6) beats an RNEF with lower specificity
      // (e.g. Binding=1). Within the same class score, RNEF wins.
      var ds = (CLASS_SCORE[b.relType] || 0) - (CLASS_SCORE[a.relType] || 0); if (ds) return ds;
      var da = (a.edgeURN ? 0 : 1) - (b.edgeURN ? 0 : 1); if (da) return da;
      var dt = tier(b) - tier(a);           if (dt) return dt;
      var dr = b.numRefs - a.numRefs;       if (dr) return dr;
      // In RNEF pathways clone nodes are placed next to their gene by design;
      // the clone connection IS the intended local visual connection, so prefer
      // edges that connect to clone endpoints (descending clone count).
      return cloneEndpointCount(b) - cloneEndpointCount(a); // more clone endpoints = better anchor
    });

    var anchor = group[0];
    var others  = group.slice(1);
    (function(){
      var srcN = cy.$id(anchor.cyEdge.data('source')); var tgtN = cy.$id(anchor.cyEdge.data('target'));
      console.log('[MERGE-DEBUG] ANCHOR ->', anchor.relType,
        (anchor.srcURN||'').split(':').pop() + (srcN.data('isClone')?'[clone]':''),
        '->', (anchor.tgtURN||'').split(':').pop() + (tgtN.data('isClone')?'[clone]':''),
        '| rnef:', !!anchor.edgeURN, '| id:', anchor.id.slice(0,60));
      others.forEach(function(oi){
        var sN = cy.$id(oi.cyEdge.data('source')); var tN = cy.$id(oi.cyEdge.data('target'));
        console.log('[MERGE-DEBUG] REMOVE ->', oi.relType,
          (oi.srcURN||'').split(':').pop() + (sN.data('isClone')?'[clone]':''),
          '->', (oi.tgtURN||'').split(':').pop() + (tN.data('isClone')?'[clone]':''),
          '| rnef:', !!oi.edgeURN, '| id:', oi.id.slice(0,60));
      });
    })();

    // FRD 4.1: if anchor has no effect, take from the non-anchor with most refs
    var resolvedEffect = anchor.effect;
    if (!resolvedEffect) {
      var withEff = others.filter(function(e) { return e.effect; });
      if (withEff.length) {
        withEff.sort(function(a, b) { return b.numRefs - a.numRefs; });
        resolvedEffect = withEff[0].effect;
      }
    }

    // FRD 5: merge + deduplicate references by (year, journal, first-30-of-sentence)
    var allRefs = anchor.refs.slice();
    others.forEach(function(e) { allRefs = allRefs.concat(e.refs); });
    var seenKeys = new Set();
    var dedupedRefs = allRefs.filter(function(ref) {
      var k = refKey(ref);
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    });

    // Collect all RelationIDs from every edge in this group (including already-merged ones)
    var allGroupRelIds = [];
    group.forEach(function(ei) {
      var rids = ei.cyEdge.data('relIds') || (ei.relId ? [ei.relId] : []);
      rids.forEach(function(id) { if (id) allGroupRelIds.push(id); });
    });
    var uniqueGroupRelIds = Array.from(new Set(allGroupRelIds));

    // Reference count = unique papers by DOI/EMBASE/PII/PUI/NCT_ID (shared helper).
    var refCount = calcRefCount(dedupedRefs);

    // Update anchor cy edge
    if (resolvedEffect !== anchor.effect) {
      anchor.cyEdge.data('effect', normEffectDisplay(resolvedEffect));
    }
    anchor.cyEdge.data('numRefs',      refCount);
    anchor.cyEdge.data('numSentences', dedupedRefs.length);
    anchor.cyEdge.data('thickness',    getEdgeThickness(refCount));
    if (uniqueGroupRelIds.length > 1) {
      anchor.cyEdge.data('relIds', uniqueGroupRelIds);
    }

    // Update anchor graphData edge
    var anchorGEdge = findGEdge(anchor);
    if (anchorGEdge) {
      if (resolvedEffect !== anchor.effect) {
        anchorGEdge.properties.Effect  = normEffectDisplay(resolvedEffect);
        anchorGEdge.properties.effect  = normEffectDisplay(resolvedEffect);
      }
      anchorGEdge.properties.references = dedupedRefs;
      anchorGEdge.properties.NumRefs = refCount;
      anchorGEdge.properties.RelationNumberOfReferences  = refCount;
      anchorGEdge.properties.RelationNumberOfSentences   = dedupedRefs.length;
      if (uniqueGroupRelIds.length > 1) {
        anchorGEdge.properties.RelationIDs = uniqueGroupRelIds;
      }
    }

    // Update refsCache under all RelationIDs so tooltip shows merged refs immediately
    uniqueGroupRelIds.forEach(function(id) { refsCache[id] = dedupedRefs; });

    // Remove non-anchor edges from cy and graphData.
    // Exception: when BOTH the anchor and the candidate are RNEF edges (have edgeURN)
    // but one connects to all-original endpoints while the other has a clone endpoint,
    // they represent the same biological relation with DIFFERENT visual anchors — the
    // RNEF pathway intentionally places clones next to genes for readability while
    // also keeping a direct connection to the canonical node.  Removing either would
    // make a visible connection disappear, so we skip removal in that case.
    others.forEach(function(e) {
      if (e.edgeURN && anchor.edgeURN) {
        // Both are RNEF: if their URN direction tokens differ (e.g. 'out' vs 'in-out'),
        // they represent DIFFERENT biological relations (unidirectional vs bidirectional
        // transport) and must never be merged.
        var aDir = edgeDirectionToken(anchor);
        var eDir = edgeDirectionToken(e);
        if (aDir && eDir && aDir !== eDir) {
          console.log('[MERGE-DEBUG] KEEP (direction mismatch ' + aDir + ' vs ' + eDir + '): skipping removal of', e.id.slice(0,60));
          return;
        }
      }
      if (e.edgeURN && anchor.edgeURN) {
        // Both are RNEF: if one connects to a clone endpoint and the other to an
        // original endpoint, they are different visual anchors for the same relation
        // — keep both so neither the clone nor the original node loses its connection.
        var anchorHasClone = cloneEndpointCount(anchor) > 0;
        var eHasClone      = cloneEndpointCount(e)      > 0;
        if (anchorHasClone !== eHasClone) {
          console.log('[MERGE-DEBUG] KEEP (clone vs original split): skipping removal of', e.id.slice(0,60));
          return; // keep this RNEF edge — different endpoint type than anchor
        }
      }
      var idx = graphData.edges.findIndex(function(ge) {
        if (e.edgeURN && ge.properties && String(ge.properties.URN) === e.edgeURN) return true;
        if (e.relId  && ge.properties && String(ge.properties.RelationID) === e.relId) return true;
        return ge.id === e.id;
      });
      if (idx >= 0) { graphData.edges.splice(idx, 1); }
      else { console.warn('[MERGE-DEBUG] graphData edge NOT FOUND for removal:', e.id, '| edgeURN:', e.edgeURN, '| relId:', e.relId); }
      // Capture clone endpoints before removing the edge
      var eSrc = e.cyEdge.data('source');
      var eTgt = e.cyEdge.data('target');
      e.cyEdge.remove();
      removedEdgeCount++;
      // If a clone endpoint is now orphaned (no remaining edges), remove it too
      [eSrc, eTgt].forEach(function(nid) {
        var n = cy.$id(nid);
        if (!n.empty() && n.data('isClone') && n.connectedEdges().length === 0) {
          console.log('[MERGE-DEBUG] removing orphaned clone node:', nid);
          var ni = graphData.nodes.findIndex(function(gn) { return String(gn.id) === String(nid); });
          if (ni >= 0) { graphData.nodes.splice(ni, 1); }
          n.remove();
        }
      });
    });

    mergedGroupCount++;
  });

  alert('Merge complete:\n  ' + mergedGroupCount + ' group(s) merged\n  ' + removedEdgeCount + ' duplicate relation(s) removed');
  updateStats();
  if (document.getElementById('table-view').style.display !== 'none') {
    if (tableViewMode === 'relation') { loadRelationData(); }
    else { tableRows = []; loadTableData(); }
  }

  // Re-render open tooltip so its reference count reflects the merged result.
  if (tooltipVisible && tooltipCurrentEdge) {
    var _tipRelId  = tooltipCurrentEdge.data('relId');
    var _tipRelIds = tooltipCurrentEdge.data('relIds') || (_tipRelId ? [_tipRelId] : []);
    var _tipRefs   = null;
    for (var _i = 0; _i < _tipRelIds.length; _i++) {
      if (refsCache[_tipRelIds[_i]] !== undefined) { _tipRefs = refsCache[_tipRelIds[_i]]; break; }
    }
    if (_tipRefs !== null) renderTooltip(tooltipCurrentEdge, _tipRefs);
  }
}

// ─── Expand Selected Nodes ────────────────────────────────────────────────────
// Pending expansion data — set before showing confirm modal, consumed on commit.
var _expandPending = null;   // { nodes, edges }

async function expandSelectedNodes(mode) {
  if (!cy || !graphData) { alert('No pathway loaded.'); return; }

  var selectedNodes = cy.nodes(':selected').not('[?isClone]');
  if (selectedNodes.length === 0) {
    showAlignToast('Please select at least one node to perform an expansion.');
    return;
  }

  var urns = [];
  selectedNodes.forEach(function(n) {
    var urn = n.data('URN') || n.data('urn') || '';
    if (urn) urns.push(urn);
  });
  if (!urns.length) {
    showAlignToast('Selected nodes have no URN — cannot expand.');
    return;
  }

  if (mode === 'to') {
    showExpandToDialog();
    return;
  }

  await _doExpand(mode, null, urns);
}

// Show "Expand To..." label picker dialog
function showExpandToDialog() {
  _loadSchema().then(function(schema) {
    var labels = (schema && schema.labels) ? schema.labels.slice().sort() : [];
    var list = document.getElementById('expand-to-label-list');
    list.innerHTML = '';
    if (!labels.length) {
      list.innerHTML = '<span style="color:#7a8099;font-size:12px">No labels found in schema.</span>';
    }
    labels.forEach(function(lbl) {
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:#c0c4d4;cursor:pointer;padding:3px 0';
      row.innerHTML = '<input type="checkbox" value="' + lbl + '" style="accent-color:#4f8ef7;width:14px;height:14px"> ' + lbl;
      list.appendChild(row);
    });
    document.getElementById('expand-to-modal').style.display = 'flex';
  });
}

// Called by the Expand button in the "Expand To..." dialog
async function expandToConfirm() {
  var checked = Array.from(
    document.querySelectorAll('#expand-to-label-list input[type=checkbox]:checked')
  ).map(function(cb) { return cb.value; });

  if (!checked.length) {
    alert('Please select at least one node type.');
    return;
  }
  document.getElementById('expand-to-modal').style.display = 'none';

  var selectedNodes = cy.nodes(':selected').not('[?isClone]');
  var urns = [];
  selectedNodes.forEach(function(n) {
    var urn = n.data('URN') || n.data('urn') || '';
    if (urn) urns.push(urn);
  });

  await _doExpand('to', checked, urns);
}

// Core expansion: fetch from server, tally results, show confirm modal.
async function _doExpand(mode, targetLabels, urns) {
  setProgressMsg('⏳ Expanding graph…');
  try {
    var body = { urns: urns, mode: mode };
    if (targetLabels) body.targetLabels = targetLabels;

    var result = await api('/api/graph/expand', body);
    setProgressMsg(null);

    if (result.error) { alert('Expansion error: ' + result.error); return; }

    var newNodes = result.nodes || [];
    var newEdges = result.edges || [];

    if (!newEdges.length) {
      alert('No new relations found for the selected nodes.');
      return;
    }

    // Build count-by-type summary
    var typeCounts = {};
    newEdges.forEach(function(e) {
      var t = e.type || 'Unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
    var total = newEdges.length;
    var lines = ['Will add ' + total + ' relation' + (total === 1 ? '' : 's') + ':'];
    Object.keys(typeCounts).sort().forEach(function(t) {
      lines.push('  • ' + t + ': ' + typeCounts[t]);
    });

    // Store pending data and show confirmation
    _expandPending = { nodes: newNodes, edges: newEdges };
    document.getElementById('expand-confirm-msg').textContent = lines.join('\n');
    document.getElementById('expand-confirm-modal').style.display = 'flex';

  } catch(err) {
    setProgressMsg(null);
    alert('Expansion failed: ' + (err.message || err));
  }
}

function _expandCancel() {
  _expandPending = null;
  document.getElementById('expand-confirm-modal').style.display = 'none';
}

function _expandCommit() {
  document.getElementById('expand-confirm-modal').style.display = 'none';
  if (!_expandPending) return;
  var pending = _expandPending;
  _expandPending = null;

  pushUndo();  // snapshot BEFORE merge so Undo restores pre-expand state
  var result = mergeGraphData(pending);
  console.log('[expand] added ' + result.addedNodes + ' nodes, ' + result.addedEdges + ' edges');

  updateStats();
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
          // ── CRITICAL ──────────────────────────────────────────────────────────
          // Neo4j nodes often have a *property* literally named "id" (the internal
          // database integer).  If we let that field flow into cyNode.data() it
          // overwrites _private.data.id on every cy node whose URN matches —
          // including clone nodes.  Once a clone's cy id() is silently changed to
          // the integer, every downstream operation that calls node.id() (merge,
          // captureTabState, …) receives the wrong value, producing dangling edge
          // references and "nonexistant source" errors on tab restore.
          // Fix: rename the Neo4j property to "databaseID" so it never collides
          // with the Cytoscape element id, then explicitly restore merged.id.
          var safeProps = Object.assign({}, neo.properties);
          if (safeProps.id !== undefined) {
            safeProps.databaseID = safeProps.id;
            delete safeProps.id;
          }
          var merged = Object.assign({}, cyNode.data(), safeProps);
          merged.id  = cyNode.id();   // never let neo.properties overwrite cy id
          merged.URN = urn;
          if (neo.properties.Name) merged.label = neo.properties.Name;
          if (neo.labels && neo.labels.length) {
            merged.nodeType = neo.labels[0];
            merged.color = getNodeColor(neo.labels);
          }
          merged.elementId = neo.elementId;
          cyNode.data(merged);
          var gn = targetGD.nodes.find(function(n) { return !n.isClone && n.properties && n.properties.URN === urn; });
          if (gn) {
            var oldId = gn.id;
            gn.id = neo.id;
            gn.elementId = neo.elementId;
            gn.labels = neo.labels;
            Object.assign(gn.properties, safeProps);
            gn.properties.URN = urn;
            if (oldId !== neo.id) {
              targetGD.edges.forEach(function(e) {
                if (e.startNodeId === oldId) e.startNodeId = neo.id;
                if (e.endNodeId   === oldId) e.endNodeId   = neo.id;
              });
            }
            // Propagate enriched properties to RNEF clones in graphData so they
            // survive tab switches (cy nodes are already updated by the cy.nodes() loop above).
            targetGD.nodes.forEach(function(cloneNode) {
              if (!cloneNode.isClone || !cloneNode.properties || cloneNode.properties.URN !== urn) return;
              Object.assign(cloneNode.properties, safeProps);
              cloneNode.properties.URN = urn;
              cloneNode.labels = neo.labels.slice();
            });
          }
        });
      } else {
        // Background tab: only update the snapshot graphData (cy belongs to the
        // active tab and must not be touched).
        urns.forEach(function(urn) {
          if (!enriched[urn]) return;
          var neo = enriched[urn];
          var safeProps = Object.assign({}, neo.properties);
          if (safeProps.id !== undefined) {
            safeProps.databaseID = safeProps.id;
            delete safeProps.id;
          }
          var gn = targetGD.nodes.find(function(n) { return !n.isClone && n.properties && n.properties.URN === urn; });
          if (!gn) return;
          matched++;
          var oldId = gn.id;
          gn.id = neo.id;
          gn.elementId = neo.elementId;
          gn.labels = neo.labels;
          Object.assign(gn.properties, safeProps);
          gn.properties.URN = urn;
          if (oldId !== neo.id) {
            targetGD.edges.forEach(function(e) {
              if (e.startNodeId === oldId) e.startNodeId = neo.id;
              if (e.endNodeId   === oldId) e.endNodeId   = neo.id;
            });
            // Remap the saved-positions key so renderGraph can find coordinates
            // after the tab is restored.  The key is whichever identifier was
            // used at captureTabState time — either the old neo4j int or the
            // original URN string (when capture ran before enrichment completed).
            var _snap = tabs[enrichTabIdx] && tabs[enrichTabIdx].snapshot;
            if (_snap && _snap.positions) {
              if (_snap.positions[oldId] !== undefined) {
                _snap.positions[neo.id] = _snap.positions[oldId];
                delete _snap.positions[oldId];
              } else if (_snap.positions[urn] !== undefined) {
                // positions was keyed by URN (pre-enrichment capture)
                _snap.positions[neo.id] = _snap.positions[urn];
                delete _snap.positions[urn];
              }
            }
          }
          // Propagate to clones in background snapshot as well.
          targetGD.nodes.forEach(function(cloneNode) {
            if (!cloneNode.isClone || !cloneNode.properties || cloneNode.properties.URN !== urn) return;
            Object.assign(cloneNode.properties, safeProps);
            cloneNode.properties.URN = urn;
            cloneNode.labels = neo.labels.slice();
          });
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
            statsEl.innerHTML = orig + ' <span id="enrich-result-status" style="color:#4caf50;font-size:11px">(' + matched + ' nodes were enriched from Neo4j)</span>';
            setTimeout(function() {
              var s = document.getElementById('enrich-result-status');
              if (s) s.remove();
            }, 5000);
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

// ─── Settings dropdown menu ───────────────────────────────────────────────────
function toggleSettingsMenu(e) {
  e.stopPropagation();
  var dd = document.getElementById('settings-dropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}
function closeSettingsMenu() {
  var dd = document.getElementById('settings-dropdown');
  if (dd) dd.style.display = 'none';
}
// Close when clicking outside
document.addEventListener('click', function(e) {
  var wrap = document.getElementById('settings-menu-wrap');
  if (wrap && !wrap.contains(e.target)) closeSettingsMenu();
});

// ─── Neo4j settings dialog ────────────────────────────────────────────────────
async function openNeo4jSettings() {
  var errEl = document.getElementById('neo4j-settings-error');
  var okEl  = document.getElementById('neo4j-settings-success');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  try {
    var s = await api('/api/settings/neo4j');
    document.getElementById('ns-url').value      = s.url      || '';
    document.getElementById('ns-database').value = s.database || '';
    document.getElementById('ns-username').value = s.username || '';
    document.getElementById('ns-password').value = '';  // never pre-fill password
  } catch(e) { /* show empty form */ }
  document.getElementById('neo4j-settings-modal').style.display = 'flex';
}
function closeNeo4jSettingsModal(e) {
  if (!e || e.target === document.getElementById('neo4j-settings-modal'))
    document.getElementById('neo4j-settings-modal').style.display = 'none';
}
async function saveNeo4jSettings() {
  var errEl = document.getElementById('neo4j-settings-error');
  var okEl  = document.getElementById('neo4j-settings-success');
  var btn   = document.getElementById('ns-save-btn');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  var payload = {
    url:      document.getElementById('ns-url').value.trim(),
    database: document.getElementById('ns-database').value.trim(),
    username: document.getElementById('ns-username').value.trim(),
    password: document.getElementById('ns-password').value  // blank = keep current
  };
  if (!payload.url || !payload.database || !payload.username) {
    errEl.textContent = 'URL, database, and username are required.';
    errEl.style.display = 'block'; return;
  }
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    await api('/api/settings/neo4j', payload, 'POST');
    okEl.textContent = 'Saved! Neo4j reconnected successfully.';
    okEl.style.display = 'block';
    setTimeout(function() { document.getElementById('neo4j-settings-modal').style.display = 'none'; }, 1500);
    _invalidateSchemaCache(); // reset schema autocomplete for new connection
  } catch(err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Test & Save';
  }
}

// ─── Postgres settings dialog ─────────────────────────────────────────────────
async function openPostgresSettings() {
  var errEl = document.getElementById('pg-settings-error');
  var okEl  = document.getElementById('pg-settings-success');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  try {
    var s = await api('/api/settings/postgres');
    document.getElementById('pgs-host').value     = s.host     || '';
    document.getElementById('pgs-port').value     = s.port     || 5432;
    document.getElementById('pgs-database').value = s.database || '';
    document.getElementById('pgs-schema').value   = s.schema   || '';
    document.getElementById('pgs-username').value = s.username || '';
    document.getElementById('pgs-password').value = '';  // never pre-fill password
  } catch(e) { /* show empty form */ }
  document.getElementById('postgres-settings-modal').style.display = 'flex';
}
function closePostgresSettingsModal(e) {
  if (!e || e.target === document.getElementById('postgres-settings-modal'))
    document.getElementById('postgres-settings-modal').style.display = 'none';
}
async function savePostgresSettings() {
  var errEl = document.getElementById('pg-settings-error');
  var okEl  = document.getElementById('pg-settings-success');
  var btn   = document.getElementById('pgs-save-btn');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  var payload = {
    host:     document.getElementById('pgs-host').value.trim(),
    port:     parseInt(document.getElementById('pgs-port').value) || 5432,
    database: document.getElementById('pgs-database').value.trim(),
    schema:   document.getElementById('pgs-schema').value.trim(),
    username: document.getElementById('pgs-username').value.trim(),
    password: document.getElementById('pgs-password').value
  };
  if (!payload.host || !payload.database || !payload.schema || !payload.username) {
    errEl.textContent = 'Host, database, schema, and username are required.';
    errEl.style.display = 'block'; return;
  }
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    await api('/api/settings/postgres', payload, 'POST');
    okEl.textContent = 'Saved! Postgres reconnected successfully.';
    okEl.style.display = 'block';
    setTimeout(function() { document.getElementById('postgres-settings-modal').style.display = 'none'; }, 1500);
  } catch(err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Test & Save';
  }
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
  if (cloneEl)   cloneEl.style.display   = isNode ? '' : 'none';
  if (sepEl)     sepEl.style.display     = isNode ? '' : 'none';
  if (uncloneEl) uncloneEl.style.display = isNode && alreadyClone ? '' : 'none';

  // Show "Merge selected clones" when 2+ selected nodes are clones
  var selectedCloneCount = cy ? cy.nodes(':selected').filter(function(n) { return n.data('isClone'); }).length : 0;
  var showMerge = selectedCloneCount >= 2;
  var sepMergeEl   = document.getElementById('ctx-sep-merge');
  var mergeCloneEl = document.getElementById('ctx-merge-clones');
  if (sepMergeEl)   sepMergeEl.style.display   = showMerge ? '' : 'none';
  if (mergeCloneEl) mergeCloneEl.style.display = showMerge ? '' : 'none';

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

// Helper: strip the clone-edge prefix to get the original edge id.
// Clone edges are created as  cloneId + '__e__' + originalEdgeId
function _baseEdgeId(edgeId) {
  var idx = edgeId.indexOf('__e__');
  return idx >= 0 ? edgeId.substring(idx + 5) : edgeId;
}

// ─── Focus node & alignment ───────────────────────────────────────────────────

function setFocusNode(id) {
  if (cy) cy.nodes('.focus-node').removeClass('focus-node');
  focusNodeId = id || null;
  if (focusNodeId && cy) {
    var n = cy.getElementById(focusNodeId);
    if (n.length) n.addClass('focus-node');
  }
}

var _alignHintTimer = null;
function showAlignHint(msg) {
  var toast = document.getElementById('align-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  clearTimeout(_alignHintTimer);
  _alignHintTimer = setTimeout(function() { toast.style.display = 'none'; }, 3000);
}

function alignNodesHorizontally() {
  if (!cy) return;
  var sel = cy.nodes(':selected');
  if (sel.length < 2) { showAlignHint('Select 2 or more nodes first'); return; }
  if (!focusNodeId || !cy.getElementById(focusNodeId).length) {
    showAlignHint('Ctrl+click a node to set it as the anchor');
    return;
  }
  pushUndo();
  var refY = cy.getElementById(focusNodeId).position('y');
  sel.forEach(function(n) { n.position('y', refY); });
  currentLayout = 'manual';
}

function alignNodesVertically() {
  if (!cy) return;
  var sel = cy.nodes(':selected');
  if (sel.length < 2) { showAlignHint('Select 2 or more nodes first'); return; }
  if (!focusNodeId || !cy.getElementById(focusNodeId).length) {
    showAlignHint('Ctrl+click a node to set it as the anchor');
    return;
  }
  pushUndo();
  var refX = cy.getElementById(focusNodeId).position('x');
  sel.forEach(function(n) { n.position('x', refX); });
  currentLayout = 'manual';
}

// ─── Manual resize handles ────────────────────────────────────────────────────

var _rhNode        = null;   // cy node whose handles are showing
var _rhDragging    = false;
var _rhHandle      = null;   // 'TL'|'TC'|'TR'|'ML'|'MR'|'BL'|'BC'|'BR'
var _rhStartMouse  = null;   // {x,y} screen px at drag start
var _rhStartW      = 0;
var _rhStartH      = 0;
var _rhStartPos    = null;   // node center in model coords at drag start
var _rhWasPanning  = false;  // saved panning state before handle drag
var _rhStartF      = 0;      // font size at drag start

var _RH_DEFS = [
  { id:'TL', cursor:'nw-resize' }, { id:'TC', cursor:'n-resize'  }, { id:'TR', cursor:'ne-resize' },
  { id:'ML', cursor:'w-resize'  },                                   { id:'MR', cursor:'e-resize'  },
  { id:'BL', cursor:'sw-resize' }, { id:'BC', cursor:'s-resize'  }, { id:'BR', cursor:'se-resize' }
];

function _rhBBox(node) {
  var pos = node.position(), zoom = cy.zoom(), pan = cy.pan();
  var w = node.width(), h = node.height();
  var sx = pos.x * zoom + pan.x, sy = pos.y * zoom + pan.y;
  return {
    left: sx - w/2*zoom, top: sy - h/2*zoom,
    right: sx + w/2*zoom, bottom: sy + h/2*zoom,
    cx: sx, cy: sy
  };
}

function _rhHandlePos(bb, id) {
  switch (id) {
    case 'TL': return { x: bb.left,  y: bb.top    };
    case 'TC': return { x: bb.cx,    y: bb.top    };
    case 'TR': return { x: bb.right, y: bb.top    };
    case 'ML': return { x: bb.left,  y: bb.cy     };
    case 'MR': return { x: bb.right, y: bb.cy     };
    case 'BL': return { x: bb.left,  y: bb.bottom };
    case 'BC': return { x: bb.cx,    y: bb.bottom };
    case 'BR': return { x: bb.right, y: bb.bottom };
  }
}

function showResizeHandles(node) {
  _rhNode = node;
  var ov = document.getElementById('resize-handles-overlay');
  if (!ov) return;
  ov.innerHTML = '';
  var bb = _rhBBox(node);
  _RH_DEFS.forEach(function(def) {
    var p = _rhHandlePos(bb, def.id);
    var el = document.createElement('div');
    el.className = 'resize-handle';
    el.dataset.handle = def.id;
    el.style.cursor = def.cursor;
    el.style.left = p.x + 'px';
    el.style.top  = p.y + 'px';
    el.addEventListener('mousedown', _rhMouseDown);
    ov.appendChild(el);
  });
}

function hideResizeHandles() {
  _rhNode = null;
  var ov = document.getElementById('resize-handles-overlay');
  if (ov) ov.innerHTML = '';
}

function repositionResizeHandles() {
  if (!_rhNode) return;
  var ov = document.getElementById('resize-handles-overlay');
  if (!ov) return;
  var bb = _rhBBox(_rhNode);
  ov.querySelectorAll('.resize-handle').forEach(function(el) {
    var p = _rhHandlePos(bb, el.dataset.handle);
    el.style.left = p.x + 'px';
    el.style.top  = p.y + 'px';
  });
}

function _rhMouseDown(e) {
  e.preventDefault(); e.stopPropagation();
  if (!_rhNode) return;
  pushUndo();   // snapshot before manual resize so it's undoable
  _rhDragging   = true;
  _rhHandle     = e.currentTarget.dataset.handle;
  _rhStartMouse = { x: e.clientX, y: e.clientY };
  _rhStartW     = _rhNode.width();
  _rhStartH     = _rhNode.height();
  _rhStartF     = _rhNode.data('nodeFontSize') || _rhNode.pstyle('font-size').pfValue || BASE_NODE_FONT;
  _rhStartPos   = { x: _rhNode.position('x'), y: _rhNode.position('y') };
  _rhWasPanning = cy.userPanningEnabled();
  cy.userPanningEnabled(false);   // prevent canvas pan during handle drag
  document.addEventListener('mousemove', _rhMouseMove);
  document.addEventListener('mouseup',   _rhMouseUp);
}

function _rhMouseMove(e) {
  if (!_rhDragging || !_rhNode) return;
  var zoom = cy.zoom();
  var dx = (e.clientX - _rhStartMouse.x) / zoom;
  var dy = (e.clientY - _rhStartMouse.y) / zoom;
  var h = _rhHandle;

  var newW = _rhStartW, newH = _rhStartH;
  var newX = _rhStartPos.x, newY = _rhStartPos.y;

  // Width: left handles move left edge (negative dx = grow), right = positive
  if (h === 'TL' || h === 'ML' || h === 'BL') {
    newW = Math.max(20, _rhStartW - dx);
    newX = _rhStartPos.x + (_rhStartW - newW) / 2;
  } else if (h === 'TR' || h === 'MR' || h === 'BR') {
    newW = Math.max(20, _rhStartW + dx);
    newX = _rhStartPos.x + (newW - _rhStartW) / 2;
  }
  // Height: top handles move top edge, bottom = positive
  if (h === 'TL' || h === 'TC' || h === 'TR') {
    newH = Math.max(20, _rhStartH - dy);
    newY = _rhStartPos.y + (_rhStartH - newH) / 2;
  } else if (h === 'BL' || h === 'BC' || h === 'BR') {
    newH = Math.max(20, _rhStartH + dy);
    newY = _rhStartPos.y + (newH - _rhStartH) / 2;
  }

  // Scale font proportionally to geometric mean of new dimensions
  var scale = Math.sqrt((newW * newH) / (_rhStartW * _rhStartH));
  var newF  = Math.max(6, Math.round(_rhStartF * scale * 10) / 10);
  _rhNode.style({ width: Math.round(newW), height: Math.round(newH), 'font-size': newF });
  _rhNode.position({ x: newX, y: newY });
  repositionResizeHandles();
}

function _rhMouseUp() {
  if (!_rhDragging) return;
  _rhDragging = false;
  cy.userPanningEnabled(_rhWasPanning);
  document.removeEventListener('mousemove', _rhMouseMove);
  document.removeEventListener('mouseup',   _rhMouseUp);
  if (!_rhNode) return;

  // Persist to data + graphData
  var newW = Math.round(_rhNode.width());
  var newH = Math.round(_rhNode.height());
  var newF2 = parseFloat(_rhNode.style('font-size')) || BASE_NODE_FONT;
  _rhNode.data('nodeWidth',    newW);
  _rhNode.data('nodeHeight',   newH);
  _rhNode.data('nodeFontSize', newF2);
  var id = _rhNode.id();
  var gn = graphData.nodes.find(function(n) { return n.id === id; });
  if (!gn) {
    var urn = _rhNode.data('URN');
    if (urn) gn = graphData.nodes.find(function(n) { return !n.isClone && n.properties && n.properties.URN === urn; });
  }
  if (gn) {
    if (!gn.properties) gn.properties = {};
    gn.properties.nodeWidth    = newW;
    gn.properties.nodeHeight   = newH;
    gn.properties.nodeFontSize = newF2;
  }
  // Sync position to tab snapshot
  if (tabs && tabs[activeTabIdx]) {
    var snap = tabs[activeTabIdx].snapshot;
    if (snap && snap.positions) snap.positions[id] = _rhNode.position();
  }
}

// ─── Node resize ──────────────────────────────────────────────────────────────

var BASE_NODE_SIZE = 44;
var BASE_NODE_FONT = 11;

function resizeSelectedNodes(factor) {
  if (!cy) return;
  var sel = cy.nodes(':selected');
  if (sel.length === 0) return;
  pushUndo();
  sel.forEach(function(node) {
    var id  = node.id();
    // Use stored size if available, else fall back to actual rendered dimensions
    var curW = node.data('nodeWidth')    || node.width()  || BASE_NODE_SIZE;
    var curH = node.data('nodeHeight')   || node.height() || curW;
    var curF = node.data('nodeFontSize') || BASE_NODE_FONT;
    var newW = Math.max(20, Math.round(curW * factor));
    var newH = Math.max(20, Math.round(curH * factor));
    var newF = Math.max(6,  Math.round(curF * factor * 10) / 10);
    node.data('nodeWidth',    newW);
    node.data('nodeHeight',   newH);
    node.data('nodeFontSize', newF);
    node.style({ width: newW, height: newH, 'font-size': newF });
    // Sync to graphData for tab-switch and JSON persistence
    var gn = graphData.nodes.find(function(n) { return n.id === id; });
    if (!gn) {
      var urn = node.data('URN');
      if (urn) gn = graphData.nodes.find(function(n) { return !n.isClone && n.properties && n.properties.URN === urn; });
    }
    if (gn) {
      if (!gn.properties) gn.properties = {};
      gn.properties.nodeWidth    = newW;
      gn.properties.nodeHeight   = newH;
      gn.properties.nodeFontSize = newF;
    }
  });
}

// ─── Highlight ────────────────────────────────────────────────────────────────

var _highlightTargetIds = [];   // IDs captured at picker-open time

function toggleHighlightPicker(event) {
  if (event) event.stopPropagation();
  var picker = document.getElementById('highlight-picker');
  if (!picker) return;
  if (picker.style.display === 'flex') {
    picker.style.display = 'none';
    _highlightTargetIds = [];
    return;
  }
  // Only open if at least one node is selected; snapshot IDs now
  if (!cy) return;
  var sel = cy.nodes(':selected');
  if (sel.length === 0) return;
  _highlightTargetIds = sel.map(function(n) { return n.id(); });
  var btn = document.getElementById('highlight-btn');
  var rect = btn.getBoundingClientRect();
  picker.style.top  = (rect.bottom + 5) + 'px';
  picker.style.left = rect.left + 'px';
  picker.style.display = 'flex';
}

function hideHighlightPicker() {
  var picker = document.getElementById('highlight-picker');
  if (picker) picker.style.display = 'none';
}

function applyHighlightStyle(node, color) {
  if (color) {
    node.data('highlightColor', color);
    node.style({
      'underlay-color':   color,
      'underlay-opacity': 0.45,
      'underlay-padding': 18,
      'underlay-shape':   'ellipse'
    });
  } else {
    node.removeData('highlightColor');
    node.style({
      'underlay-opacity': 0,
      'underlay-padding': 0
    });
  }
}

function setHighlightColor(color) {
  hideHighlightPicker();
  if (!cy) return;
  pushUndo();
  var ids = _highlightTargetIds.length ? _highlightTargetIds : cy.nodes(':selected').map(function(n) { return n.id(); });
  _highlightTargetIds = [];
  ids.forEach(function(id) {
    var node = cy.getElementById(id);
    if (!node || node.length === 0) return;
    applyHighlightStyle(node, color);
    // Sync to graphData for tab-switch and JSON-save persistence
    var gn = graphData.nodes.find(function(n) { return n.id === id; });
    if (!gn) {
      var urn = node.data('URN');
      if (urn) gn = graphData.nodes.find(function(n) { return !n.isClone && n.properties && n.properties.URN === urn; });
    }
    if (gn) {
      if (!gn.properties) gn.properties = {};
      if (color) {
        gn.properties.highlightColor = color;
      } else {
        delete gn.properties.highlightColor;
      }
    }
  });
}

// Close picker when clicking anywhere outside it
document.addEventListener('click', function(e) {
  if (!e.target.closest('#highlight-picker') && !e.target.closest('#highlight-btn')) {
    hideHighlightPicker();
    _highlightTargetIds = [];
  }
});

// ─── Node color change ────────────────────────────────────────────────────────

var _colorTargetIds = [];

function toggleNodeColorPicker(event) {
  if (event) event.stopPropagation();
  var picker = document.getElementById('nodecolor-picker');
  if (!picker) return;
  if (picker.style.display === 'flex') {
    picker.style.display = 'none';
    _colorTargetIds = [];
    return;
  }
  if (!cy) return;
  var sel = cy.nodes(':selected');
  if (sel.length === 0) return;
  _colorTargetIds = sel.map(function(n) { return n.id(); });
  var btn = document.getElementById('nodecolor-btn');
  var rect = btn.getBoundingClientRect();
  picker.style.top  = (rect.bottom + 5) + 'px';
  picker.style.left = rect.left + 'px';
  picker.style.display = 'flex';
}

function hideNodeColorPicker() {
  var picker = document.getElementById('nodecolor-picker');
  if (picker) picker.style.display = 'none';
  var row = document.getElementById('nodecolor-wheel-row');
  if (row) row.style.display = 'none';
}

function _applyColorToNodes(ids, color) {
  ids.forEach(function(id) {
    var node = cy.getElementById(id);
    if (!node || node.length === 0) return;
    if (color) {
      var tc = contrastColor(color);
      node.data('customColor', color);
      node.data('customTextColor', tc);
      node.style({ 'background-color': color, 'text-outline-color': color, 'color': tc });
    } else {
      node.removeData('customColor');
      node.removeData('customTextColor');
      // Restore the original auto-color from node type
      var origColor = node.data('color');
      node.style({ 'background-color': origColor, 'text-outline-color': origColor, 'color': '' });
    }
    // Persist to graphData
    var gn = graphData.nodes.find(function(n) { return n.id === id; });
    if (!gn) {
      var urn = node.data('URN');
      if (urn) gn = graphData.nodes.find(function(n) { return !n.isClone && n.properties && n.properties.URN === urn; });
    }
    if (gn) {
      if (!gn.properties) gn.properties = {};
      if (color) { gn.properties.customColor = color; gn.properties.customTextColor = contrastColor(color); }
      else        { delete gn.properties.customColor; delete gn.properties.customTextColor; }
    }
  });
}

function applyNodeColor(color) {
  hideNodeColorPicker();
  if (!cy) return;
  var ids = _colorTargetIds.length ? _colorTargetIds : cy.nodes(':selected').map(function(n) { return n.id(); });
  _colorTargetIds = [];
  if (ids.length === 0) return;
  pushUndo();
  _applyColorToNodes(ids, color);
}

function openNodeColorWheel() {
  var row = document.getElementById('nodecolor-wheel-row');
  if (row) row.style.display = row.style.display === 'flex' ? 'none' : 'flex';
}

function applyMoreNodeColor(color) {
  hideNodeColorPicker();
  var row = document.getElementById('nodecolor-wheel-row');
  if (row) row.style.display = 'none';
  if (!cy || !color) return;
  var ids = _colorTargetIds.length ? _colorTargetIds : cy.nodes(':selected').map(function(n) { return n.id(); });
  _colorTargetIds = [];
  if (ids.length === 0) return;
  pushUndo();
  _applyColorToNodes(ids, color);
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('#nodecolor-picker') && !e.target.closest('#nodecolor-btn')) {
    hideNodeColorPicker();
  }
});

// ─── Undo ─────────────────────────────────────────────────────────────────────

function pushUndo() {
  var snapshot = captureTabState();
  undoStack.push({ graphData: snapshot.graphData, positions: snapshot.positions });
  // Any new operation clears the redo history
  redoStack = [];
  var btn = document.getElementById('undo-btn');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  var rbtn = document.getElementById('redo-btn');
  if (rbtn) { rbtn.disabled = true; rbtn.style.opacity = '0.4'; }
}

function undoGraphOperation() {
  if (undoStack.length === 0) return;
  // Save current state to redo stack before reverting
  var cur = captureTabState();
  redoStack.push({ graphData: cur.graphData, positions: cur.positions });
  var prev = undoStack.pop();
  graphData = JSON.parse(JSON.stringify(prev.graphData));
  renderGraph(graphData, prev.positions);
  applyStyle(currentStyle);   // restore current visual style (metabolic, effect, etc.)
  // Keep active tab snapshot in sync
  if (tabs && tabs[activeTabIdx]) {
    tabs[activeTabIdx].snapshot = captureTabState();
  }
  var btn = document.getElementById('undo-btn');
  if (btn) {
    btn.disabled = undoStack.length === 0;
    btn.style.opacity = undoStack.length === 0 ? '0.4' : '1';
  }
  var rbtn = document.getElementById('redo-btn');
  if (rbtn) { rbtn.disabled = false; rbtn.style.opacity = '1'; }
}

function redoGraphOperation() {
  if (redoStack.length === 0) return;
  // Save current state to undo stack before re-applying
  var cur = captureTabState();
  undoStack.push({ graphData: cur.graphData, positions: cur.positions });
  var next = redoStack.pop();
  graphData = JSON.parse(JSON.stringify(next.graphData));
  renderGraph(graphData, next.positions);
  applyStyle(currentStyle);
  // Keep active tab snapshot in sync
  if (tabs && tabs[activeTabIdx]) {
    tabs[activeTabIdx].snapshot = captureTabState();
  }
  var btn = document.getElementById('undo-btn');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  var rbtn = document.getElementById('redo-btn');
  if (rbtn) {
    rbtn.disabled = redoStack.length === 0;
    rbtn.style.opacity = redoStack.length === 0 ? '0.4' : '1';
  }
}

function cloneNodeFromContext() {
  hideContextMenu();
  if (!contextTarget || contextTarget.type !== 'node') return;
  pushUndo();

  var sourceId = contextTarget.id;
  if (!cy) return;
  var src = cy.getElementById(sourceId);
  if (!src || src.length === 0) return;

  var srcData      = src.data();
  var srcPos       = src.position();
  var srcUrn       = srcData.URN;
  // Step 1: exact graphData-ID match (covers clones and un-enriched originals).
  var srcGraphNode = graphData.nodes.find(function(n) { return n.id === sourceId; });
  // Step 2: URN fallback for enriched originals whose graphData id was updated
  // to a Neo4j integer while the cy node id stayed as the URN string.
  // Important: do NOT let this fallback fire when sourceId is a clone id —
  // the original non-clone with the same URN would be found first otherwise,
  // leading to the wrong srcGnId and removing the original instead of the clone.
  if (!srcGraphNode) {
    srcGraphNode = graphData.nodes.find(function(n) {
      return srcUrn && n.properties && n.properties.URN === srcUrn && !n.isClone;
    });
  }

  var srcGnId = srcGraphNode ? srcGraphNode.id : sourceId;
  var cloneOf = srcData.cloneOf || sourceId;

  // Create N clones — one per connected edge — each clone gets exactly 1 edge.
  // The original node is removed once all edges have been redistributed.
  var connectedEdges = src.connectedEdges().toArray();
  var n      = connectedEdges.length;
  var radius = 80;

  connectedEdges.forEach(function(edge, i) {
    var angle   = (2 * Math.PI * i / n) - Math.PI / 2;
    var cloneId = sourceId + '__clone__' + Date.now() + '_' + i;

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

    // Move this edge from the original to its clone
    var ed = Object.assign({}, edge.data());
    edge.remove();
    cy.add({
      group: 'edges',
      data: Object.assign({}, ed, {
        source: ed.source === sourceId ? cloneId : ed.source,
        target: ed.target === sourceId ? cloneId : ed.target
      })
    });

    var gde = graphData.edges.find(function(e) { return e.id === ed.id; });
    if (gde) {
      if (gde.startNodeId === srcGnId) gde.startNodeId = cloneId;
      if (gde.endNodeId   === srcGnId) gde.endNodeId   = cloneId;
    }
  });

  // Remove the original — all edges redistributed to clones
  src.remove();
  graphData.nodes = graphData.nodes.filter(function(n) { return n.id !== srcGnId; });

  updateStats();
}

function mergeSelectedClonesFromContext() {
  hideContextMenu();
  if (!cy) return;
  pushUndo();

  // Collect all selected clone nodes
  var selectedClones = cy.nodes(':selected').filter(function(n) {
    return n.data('isClone');
  });

  if (selectedClones.length < 2) return;

  // Group by URN (canonical biological identifier, stable across enrichment).
  // Fallback to cloneOf if URN is absent.
  // This handles the case where some clones were created pre-enrichment
  // (cloneOf = URN string) and others post-enrichment (cloneOf = Neo4j integer ID),
  // but all share the same URN on the node itself.
  var groups = {};
  selectedClones.forEach(function(n) {
    var groupKey = n.data('URN') || n.data('cloneOf');
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(n);
  });

  Object.keys(groups).forEach(function(cloneOf) {
    var group = groups[cloneOf];
    if (group.length < 2) return; // Nothing to merge for this original

    // First node in the group is the survivor; rest are merged into it
    var survivor   = group[0];
    var survivorId = survivor.id();

    for (var i = 1; i < group.length; i++) {
      var victim   = group[i];
      var victimId = victim.id();

      // Redirect each edge that touches the victim over to the survivor.
      // Edges that are duplicates of edges already on the survivor are discarded.
      victim.connectedEdges().forEach(function(edge) {
        var ed     = Object.assign({}, edge.data());
        var newSrc = ed.source === victimId ? survivorId : ed.source;
        var newTgt = ed.target === victimId ? survivorId : ed.target;

        // Save the graphData record BEFORE removing (it holds type + properties)
        var gde = graphData.edges.find(function(e) { return e.id === ed.id; });

        // Remove victim's edge from cy and graphData
        edge.remove();
        graphData.edges = graphData.edges.filter(function(e) { return e.id !== ed.id; });

        if (newSrc === newTgt) return;  // would be self-loop — discard

        // Discard if survivor already has an edge cloned from the same original
        // (two clones of Na+ both had Clone→MT; after merge survivor would have two survivor→MT)
        var baseId = _baseEdgeId(ed.id);
        var isDupe = cy.edges().some(function(e) {
          return _baseEdgeId(e.id()) === baseId &&
                 e.source().id() === newSrc &&
                 e.target().id() === newTgt;
        });
        if (isDupe) return;

        // Re-add to cy (don't mutate ed — use a fresh merge)
        cy.add({ group: 'edges', data: Object.assign({}, ed, { source: newSrc, target: newTgt }) });

        // Push a properly-structured graphData edge.
        // IMPORTANT: graphData edges store graphData node IDs (which may be Neo4j
        // integers after enrichment), NOT cy node IDs (which are URN strings).
        // Only swap the endpoint that literally equals victimId — leave all other
        // endpoints (e.g. the Neo4j-integer IDs of neighbour nodes) untouched.
        if (gde) {
          graphData.edges.push(Object.assign({}, gde, {
            startNodeId: gde.startNodeId === victimId ? survivorId : gde.startNodeId,
            endNodeId:   gde.endNodeId   === victimId ? survivorId : gde.endNodeId
          }));
        } else {
          // Fallback: reconstruct from cy data fields
          graphData.edges.push({
            id:          ed.id,
            elementId:   ed.elementId || ed.id,
            type:        ed.relType || '',
            startNodeId: newSrc,
            endNodeId:   newTgt,
            properties: {
              RelationID: ed.relId  || ed.id,
              Effect:     ed.effect || '',
              NumRefs:    ed.numRefs || 0,
              references: []
            }
          });
        }
      });

      // Remove victim from Cytoscape and graphData
      victim.remove();
      graphData.nodes = graphData.nodes.filter(function(n) { return n.id !== victimId; });
    }
  });

  updateStats();
}

function removeCloneFromContext() {
  hideContextMenu();
  if (!contextTarget || contextTarget.type !== 'node') return;
  pushUndo();
  var id = contextTarget.id;
  if (!cy) return;
  var node = cy.getElementById(id);
  if (!node || !node.data('isClone')) return;

  // Remove clone and all its connected edges from Cytoscape
  // (node.remove() automatically removes connected cy edges)
  node.remove();

  // Remove from graphData.nodes
  graphData.nodes = graphData.nodes.filter(function(n) { return n.id !== id; });

  // Remove all graphData edges that referenced this clone (pre-existing bug fix)
  graphData.edges = graphData.edges.filter(function(e) {
    return e.startNodeId !== id && e.endNodeId !== id;
  });

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
    graphData:            { nodes: [], edges: [] },
    refsCache:            {},
    medScanMap:           {},
    tableRows:            [],
    currentSubgraphName:  '',
    currentLayout:        'cose',
    currentStyle:         'default',
    currentQuery:         '',
    positions:            {},
    tableViewMode:        'reference',
    activeView:           'graph',
    tableSortCol:         null,
    tableSortAsc:         true,
    loadedPropertyNames:  []
  };
}

function captureTabState() {
  var positions = {};
  if (cy) {
    // Key positions by URN for normal nodes and by cy-ID for clones.
    //
    // Why URN?  The cy node ID is whatever was in graphData.nodes[i].id when
    // renderGraph last ran — it may be a legacy Neo4j integer from an older saved
    // file, or a freshly-enriched integer that differs from the one in a snapshot
    // that was written earlier.  Either way, background enrichNodesFromNeo4j can
    // change graphData node IDs in the snapshot AFTER captureTabState captures
    // positions, making numeric keys stale.
    //
    // URN strings are written by the RNEF author and are never mutated by
    // enrichment, so they form a stable key that survives any number of
    // background ID updates.  renderGraph has a URN fallback in both the
    // cyNodes position field and the belt-and-suspenders loop.
    //
    // Clone nodes share URN with their original, so they use their unique cy ID
    // (e.g. "clone-…") as the key instead; their first-lookup path in renderGraph
    // already handles this.
    cy.nodes().forEach(function(n) {
      var urn = !n.data('isClone') && n.data('URN');
      positions[urn || n.id()] = { x: n.position('x'), y: n.position('y') };
    });
  }
  var tableEl = document.getElementById('table-view');
  var activeView = (tableEl && tableEl.style.display !== 'none') ? 'table' : 'graph';
  var _posKeys = Object.keys(positions);
  var _posVals = _posKeys.slice(0,3).map(function(k) {
    var p = positions[k];
    return k + ':(' + Math.round(p.x) + ',' + Math.round(p.y) + ')';
  }).join(' | ');
  console.log('[TAB-DEBUG][' + Date.now() + '] captureTabState: tab=' + activeTabIdx + ' posCount=' + _posKeys.length + ' vals=' + _posVals);
  return {
    graphData:           JSON.parse(JSON.stringify(graphData)),
    refsCache:           Object.assign({}, refsCache),
    medScanMap:          Object.assign({}, medScanMap),
    tableRows:           JSON.parse(JSON.stringify(tableRows)),
    currentSubgraphName: currentSubgraphName,
    currentLayout:       currentLayout,
    currentStyle:        currentStyle,
    currentQuery:        getCypherQuery() || currentQuery,
    positions:           positions,
    tableViewMode:       tableViewMode,
    activeView:          activeView,
    tableSortCol:        tableSortCol,
    tableSortAsc:        tableSortAsc,
    loadedPropertyNames: Array.from(_loadedPropertyNames)
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
  currentStyle        = s.currentStyle  || 'default';
  currentQuery        = s.currentQuery || '';
  _loadedPropertyNames = new Set(Array.isArray(s.loadedPropertyNames) ? s.loadedPropertyNames : []);

  setCypherQuery(currentQuery);

  updateLayoutMenu(currentLayout);
  updateStyleMenu(currentStyle);

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
    var _sPosKeys = Object.keys(s.positions || {});
    var _sPosVals = _sPosKeys.slice(0,3).map(function(k) {
      var p = s.positions[k];
      return k + ':(' + Math.round(p.x) + ',' + Math.round(p.y) + ')';
    }).join(' | ');
    console.log('[TAB-DEBUG][' + Date.now() + '] applyTabState: tab=' + activeTabIdx + ' hasPos=' + hasPos + ' posCount=' + _sPosKeys.length + ' vals=' + _sPosVals);
    renderGraph(graphData, hasPos ? s.positions : null);
    applyStyle(currentStyle);
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
  tableSortCol  = s.tableSortCol  || null;
  tableSortAsc  = s.tableSortAsc  !== undefined ? s.tableSortAsc : true;
  syncTableModeIndicator(tableViewMode);
  updateSelectionInfo();

  // Restore the view the user was on when they left this tab.
  // Graph view was already set above (required for cy to render correctly);
  // switch to table now if that's where the user was.
  var restoredView = s.activeView || 'graph';
  if (restoredView === 'table' && graphData.edges.length > 0) {
    switchView('table');
  } else {
    updateViewMenu('graph');
  }

  // Apply results that arrived while this tab was in the background
  if (s.pendingGraphData) {
    var pd = s.pendingGraphData;
    delete s.pendingGraphData;
    if (pd.table && pd.nodes.length === 0 && pd.edges.length === 0) {
      showQueryResultTable(pd.table);
    } else {
      hideQueryResultTable();
      renderGraph(pd);
    }
  }
  if (s.pendingQueryError) {
    var pe = s.pendingQueryError;
    delete s.pendingQueryError;
    alert('Query error: ' + pe);
  }

  // If this tab still has a query running, restore the loading state
  var tab = tabs[activeTabIdx];
  if (tab && tab.running) {
    document.getElementById('graph-loading').style.display = 'flex';
    document.getElementById('run-btn').disabled = true;
  }
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
  // Always clear loading overlay before switching — destination tab may not be running a query
  document.getElementById('graph-loading').style.display = 'none';
  document.getElementById('run-btn').disabled = false;
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
    div.draggable = true;
    var closeHtml = tabs.length > 1
      ? '<span class="tab-close" title="Close tab">\xd7</span>'
      : '';
    var runningHtml = tab.running ? '<span class="tab-running-dot" title="Query running…"></span>' : '';
    div.innerHTML = '<span class="tab-name" title="' + escHtml(tab.name) + '">'
      + escHtml(tab.name) + '</span>' + runningHtml + closeHtml;

    div.addEventListener('click', (function(i) {
      return function(e) {
        if (e.target.classList.contains('tab-close')) closeTab(i, e);
        else switchTab(i);
      };
    })(idx));

    // ── drag-to-reorder ──────────────────────────────────────────────────────
    div.addEventListener('dragstart', (function(i, el) {
      return function(e) {
        tabDragSrcIdx = i;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
        setTimeout(function() { el.classList.add('tab-dragging'); }, 0);
      };
    })(idx, div));

    div.addEventListener('dragend', (function(el) {
      return function() {
        el.classList.remove('tab-dragging');
        list.querySelectorAll('.tab-item').forEach(function(t) {
          t.classList.remove('tab-drag-over-left', 'tab-drag-over-right');
        });
        tabDragSrcIdx = -1;
      };
    })(div));

    div.addEventListener('dragover', (function(i, el) {
      return function(e) {
        if (tabDragSrcIdx < 0 || tabDragSrcIdx === i) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.remove('tab-drag-over-left', 'tab-drag-over-right');
        var mid = el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2;
        el.classList.add(e.clientX < mid ? 'tab-drag-over-left' : 'tab-drag-over-right');
      };
    })(idx, div));

    div.addEventListener('dragleave', (function(el) {
      return function() {
        el.classList.remove('tab-drag-over-left', 'tab-drag-over-right');
      };
    })(div));

    div.addEventListener('drop', (function(i, el) {
      return function(e) {
        e.preventDefault();
        el.classList.remove('tab-drag-over-left', 'tab-drag-over-right');
        var src = tabDragSrcIdx;
        if (src < 0 || src === i) return;
        var rect = el.getBoundingClientRect();
        var insertBefore = e.clientX < rect.left + rect.width / 2;
        var dest = insertBefore ? i : i + 1;
        var activeId = tabs[activeTabIdx].id;
        var moved = tabs.splice(src, 1)[0];
        if (src < dest) dest--;
        tabs.splice(dest, 0, moved);
        activeTabIdx = tabs.findIndex(function(t) { return t.id === activeId; });
        tabDragSrcIdx = -1;
        renderTabBar();
      };
    })(idx, div));

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

// ─── Selection clipboard (cross-tab, URN-based) ───────────────────────────────
// Stores URNs of selected nodes/edges so the user can select the intersection
// of that set in a different pathway.
var selectionClipboard = { nodeUrns: new Set(), edgeUrns: new Set() };

function copySelectionToClipboard() {
  if (!cy) return;
  var nodeUrns = new Set();
  var edgeUrns = new Set();
  cy.nodes(':selected').forEach(function(n) {
    var urn = n.data('URN');
    if (urn) nodeUrns.add(String(urn));
  });
  cy.edges(':selected').forEach(function(e) {
    var urn = e.data('edgeURN');
    if (urn) edgeUrns.add(String(urn));
  });
  selectionClipboard = { nodeUrns: nodeUrns, edgeUrns: edgeUrns };
  var total = nodeUrns.size + edgeUrns.size;
  // Enable the menu item and update its label to show what was copied
  var mi = document.getElementById('mi-select-from-clipboard');
  if (mi) {
    mi.style.color = '';
    mi.textContent = 'Select from clipboard (' + total + ')';
  }
  updateSelectionInfo();
}

function selectFromClipboard() {
  if (!cy) return;
  var nodeUrns = selectionClipboard.nodeUrns;
  var edgeUrns = selectionClipboard.edgeUrns;
  if (!nodeUrns.size && !edgeUrns.size) return;
  cy.elements().unselect();
  cy.nodes().forEach(function(n) {
    var urn = n.data('URN');
    if (urn && nodeUrns.has(String(urn))) n.select();
  });
  cy.edges().forEach(function(e) {
    var urn = e.data('edgeURN');
    if (urn && edgeUrns.has(String(urn))) e.select();
  });
  updateSelectionInfo();
}

function copySelection() {
  if (!cy) return;
  var selNodes = cy.nodes(':selected');
  var selEdges = cy.edges(':selected');
  if (selNodes.length === 0 && selEdges.length === 0) return;
  // Also update the URN-based selection clipboard for cross-tab "Select from clipboard"
  copySelectionToClipboard();

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
  var mergedNodes = 0;
  var skippedEdges = 0;

  // Build URN → existing cy node ID map for merge detection
  var urnToExistingCyId = {};
  cy.nodes().forEach(function(cyNode) {
    var urn = cyNode.data('URN');
    if (urn) urnToExistingCyId[String(urn)] = cyNode.id();
  });

  graphClipboard.nodes.forEach(function(n) {
    var srcUrn = n.data.URN;

    // If a node with the same URN already exists, merge instead of duplicating
    if (srcUrn && urnToExistingCyId[String(srcUrn)]) {
      idMap[n.data.id] = urnToExistingCyId[String(srcUrn)];
      mergedNodes++;
      return;
    }

    var newId = n.data.id + '__paste__' + Date.now() + Math.random().toString(36).slice(2, 6);
    idMap[n.data.id] = newId;
    var newData = Object.assign({}, n.data, { id: newId, elementId: newId });
    var newNode = cy.add({ group: 'nodes', data: newData,
      position: { x: n.position.x + offset, y: n.position.y + offset } });
    newNode.select();
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

  // Build identity set for existing edges to detect duplicates.
  // Identity rule (mirrors Pathway Studio):
  //   Primary:   RelationID from Neo4j
  //   Fallback:  (source, target, type, effect, mechanism) — same direction
  var existingEdgeKeys = new Set();
  cy.edges().forEach(function(cyEdge) {
    var relId = cyEdge.data('relId') || cyEdge.data('RelationID');
    if (relId) existingEdgeKeys.add('rid:' + String(relId));
    var src  = cyEdge.data('source');
    var tgt  = cyEdge.data('target');
    var type = cyEdge.data('relType') || '';
    var eff  = cyEdge.data('effect')  || '';
    var mech = cyEdge.data('mechanism') || '';
    existingEdgeKeys.add('struct:' + src + '|' + tgt + '|' + type + '|' + eff + '|' + mech);
  });

  graphClipboard.edges.forEach(function(e) {
    var newSrc = idMap[e.data.source] || e.data.source;
    var newTgt = idMap[e.data.target] || e.data.target;

    // Check RelationID identity
    var relId = e.data.relId
      || (e.raw && e.raw.properties && e.raw.properties.RelationID)
      || null;
    if (relId && existingEdgeKeys.has('rid:' + String(relId))) {
      skippedEdges++;
      return;
    }

    // Check structural identity (uses merged node IDs so duplicates via shared
    // nodes are also caught)
    var type = e.data.relType || '';
    var eff  = e.data.effect  || '';
    var mech = e.data.mechanism || '';
    var structKey = 'struct:' + newSrc + '|' + newTgt + '|' + type + '|' + eff + '|' + mech;
    if (existingEdgeKeys.has(structKey)) {
      skippedEdges++;
      return;
    }

    // Register this edge so subsequent clipboard edges don't duplicate each other
    if (relId) existingEdgeKeys.add('rid:' + String(relId));
    existingEdgeKeys.add(structKey);

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

  var newNodes  = graphClipboard.nodes.length - mergedNodes;
  var newEdges  = graphClipboard.edges.length - skippedEdges;
  var parts = [];
  if (newNodes  > 0) parts.push(newNodes  + ' node' + (newNodes  !== 1 ? 's' : '') + ' added');
  if (mergedNodes > 0) parts.push(mergedNodes + ' node' + (mergedNodes !== 1 ? 's' : '') + ' merged');
  if (newEdges  > 0) parts.push(newEdges  + ' edge' + (newEdges  !== 1 ? 's' : '') + ' added');
  if (skippedEdges > 0) parts.push(skippedEdges + ' duplicate edge' + (skippedEdges !== 1 ? 's' : '') + ' skipped');
  if (!parts.length) parts.push('nothing new to paste');

  var statsEl = document.getElementById('graph-stats');
  if (statsEl) {
    statsEl.innerHTML = '<span style="color:#4f8ef7">' + parts.join(', ') + '</span>';
    setTimeout(updateStats, 3000);
  } else { updateStats(); }
}

function deleteSelection() {
  if (!cy) return;
  var sel = cy.elements(':selected');
  if (sel.length === 0) return;
  pushUndo();
  var selIds = new Set(sel.map(function(el) { return el.id(); }));
  sel.remove();
  graphData.nodes = graphData.nodes.filter(function(n) { return !selIds.has(n.id); });
  graphData.edges = graphData.edges.filter(function(e) { return !selIds.has(e.id); });
  updateStats();
}


// ─── Styles ───────────────────────────────────────────────────────────────────
function menuApplyStyle(name) {
  closeMenus();
  applyStyle(name);
  if (tabs && tabs[activeTabIdx]) tabs[activeTabIdx].snapshot = captureTabState();
}

function updateStyleMenu(name) {
  ['default', 'effect', 'metabolic'].forEach(function(s) {
    var el = document.getElementById('mc-style-' + s);
    if (el) el.textContent = (s === name) ? '✓' : '';
  });
}

// ─── Wrap label at ~25 chars for Metabolic style ─────────────────────────────
function wrapLabelForMetabolic(text) {
  var MAX = 25;
  if (!text || text.length <= MAX) return text;
  var lines = [];
  var remaining = text;
  while (remaining.length > MAX) {
    // Prefer breaking after a hyphen or at a space within the first MAX chars
    var breakAt = -1;
    for (var i = MAX; i > 0; i--) {
      var ch = remaining[i];
      if (ch === '-') { breakAt = i + 1; break; }   // include the hyphen
      if (ch === ' ') { breakAt = i;     break; }   // exclude the space
    }
    if (breakAt <= 0) breakAt = MAX;                 // hard break if no delimiter
    lines.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^ /, '');
  }
  if (remaining) lines.push(remaining);
  return lines.join('\n');
}

function applyStyle(name) {
  currentStyle = name || 'default';
  updateStyleMenu(currentStyle);
  if (!cy) return;

  if (currentStyle === 'default') {
    // Remove inline overrides — stylesheet takes over again
    cy.edges().forEach(function(e) {
      e.removeStyle('line-color target-arrow-color source-arrow-color');
    });
    cy.nodes().forEach(function(n) {
      if (n.data('NodeType') === 'Reaction') return;
      n.removeStyle(
        'label shape width height padding background-color background-fill color ' +
        'text-outline-width border-width border-color border-style text-wrap text-max-width'
      );
      // Re-apply manual resize if the node was previously resized
      var w = n.data('nodeWidth');
      var h = n.data('nodeHeight') || w;
      var f = n.data('nodeFontSize');
      if (w) n.style({ width: w, height: h, 'font-size': f || BASE_NODE_FONT });
    });

  } else if (currentStyle === 'effect') {
    cy.edges().forEach(function(e) {
      var effect = (e.data('effect') || '').toLowerCase();
      var color = effect === 'positive' ? '#43a047'   // green
                : effect === 'negative' ? '#e53935'   // red
                :                         '#9e9e9e';  // gray (unknown/none)
      e.style({
        'line-color':          color,
        'target-arrow-color':  color,
        'source-arrow-color':  color
      });
    });

  } else if (currentStyle === 'metabolic') {
    // Edge colors by effect (same as 'effect' style)
    cy.edges().forEach(function(e) {
      var effect = (e.data('effect') || '').toLowerCase();
      var color = effect === 'positive' ? '#43a047'
                : effect === 'negative' ? '#e53935'
                :                         '#9e9e9e';
      e.style({ 'line-color': color, 'target-arrow-color': color, 'source-arrow-color': color });
    });

    // Rectangle nodes auto-sized to their label
    cy.nodes().forEach(function(n) {
      if (n.data('NodeType') === 'Reaction') return;   // keep tiny reaction dot
      var isSmallMol = n.data('NodeType') === 'SmallMol';
      var bgColor    = isSmallMol ? '#ffffff' : (n.data('color') || '#555555');
      var textColor  = isSmallMol ? '#000000' : '#ffffff';
      var borderW    = isSmallMol ? 1.5 : 0;

      var rawLabel = n.data('label') || '';
      var wrappedLabel = wrapLabelForMetabolic(rawLabel);
      // Respect manually-set size so undo restores the right dimensions
      var manualW = n.data('nodeWidth');
      var manualH = n.data('nodeHeight');
      var manualF = n.data('nodeFontSize');
      n.style({
        'label':              wrappedLabel,
        'shape':              'rectangle',
        'background-fill':    'solid',
        'width':              manualW ? manualW : 'label',
        'height':             manualH ? manualH : (manualW ? manualW : 'label'),
        'padding':            manualW ? '0px' : '5px',
        'background-color':    bgColor,
        'color':               textColor,
        'text-outline-color':  textColor === '#000000' ? 'rgba(255,255,255,0.88)' : bgColor,
        'text-outline-width':  2,
        'font-size':          (manualF || 11) + (manualF ? 'px' : 'px'),
        'text-wrap':          'wrap',
        'border-width':       borderW,
        'border-color':       '#555555'
      });
    });
  }
}


// ─── Find nodes ───────────────────────────────────────────────────────────────
var _findPopupOpen = false;

function toggleFindPopup(event) {
  if (event) event.stopPropagation();
  var popup = document.getElementById('find-popup');
  if (!popup) return;
  if (_findPopupOpen) {
    hideFindPopup();
  } else {
    var btn = document.getElementById('find-btn');
    if (btn) {
      var rect = btn.getBoundingClientRect();
      popup.style.top = (rect.bottom + 6) + 'px';
      popup.style.left = rect.left + 'px';
    }
    popup.style.display = 'block';
    _findPopupOpen = true;
    document.getElementById('find-result').textContent = '';
    var inp = document.getElementById('find-input');
    if (inp) { inp.value = ''; setTimeout(function() { inp.focus(); }, 50); }
  }
}

function hideFindPopup() {
  var popup = document.getElementById('find-popup');
  if (popup) popup.style.display = 'none';
  _findPopupOpen = false;
}

// Keys to skip when searching node data (internal / styling)
var _findSkipKeys = {
  id: true, elementId: true, isClone: true, cloneOf: true,
  color: true, nodeWidth: true, nodeHeight: true, nodeFontSize: true,
  customColor: true, customTextColor: true, highlightColor: true, rnefShape: true
};

function executeNodeSearch() {
  if (!cy) return;
  var inp = document.getElementById('find-input');
  var resultEl = document.getElementById('find-result');
  if (!inp || !resultEl) return;
  var q = inp.value.trim().toLowerCase();
  if (!q) { resultEl.textContent = 'Enter a search term.'; return; }

  var matched = cy.nodes().filter(function(node) {
    var d = node.data();
    for (var key in d) {
      if (_findSkipKeys[key]) continue;
      var val = d[key];
      if (val === null || val === undefined) continue;
      if (String(val).toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  });

  cy.elements().unselect();
  if (matched.length > 0) {
    matched.select();
    resultEl.textContent = matched.length + ' node' + (matched.length === 1 ? '' : 's') + ' found.';
    if (matched.length === 1) {
      cy.animate({ center: { eles: matched }, zoom: cy.zoom() < 1 ? 1 : cy.zoom() }, { duration: 300 });
    }
  } else {
    resultEl.textContent = 'No nodes matched "' + inp.value.trim() + '".';
  }
}

// Close find popup when clicking outside
document.addEventListener('click', function(e) {
  if (!_findPopupOpen) return;
  var popup = document.getElementById('find-popup');
  var btn = document.getElementById('find-btn');
  if (popup && !popup.contains(e.target) && e.target !== btn) {
    hideFindPopup();
  }
});
