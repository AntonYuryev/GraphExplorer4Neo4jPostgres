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

// ─── Relation Curation state (Create / Edit Relation dialog) ──────────────────
var _rc = {
  mode: 'create',       // 'create' | 'edit'
  nodes: [],            // [{cyId, label, nodeType, nodeId, direction:'→'|'←'|'−'}]
  props: [],            // [{id, key, value}]   user-added / pre-populated properties
  existingEdge: null,   // cy edge element when editing an existing relation
  refs: [],             // reference row objects loaded from Postgres + newly created
  refIdx: 0,            // index of the currently displayed reference
  refsVisible: false,
  refsLoaded: false,
  refCols: [],          // reference table column names (from /api/schema/columns)
  relTypes: [],         // all Neo4j relation types (cached)
  propKeys: [],         // all Neo4j relation property keys (cached)
  currentRelId: '',     // live-calculated RelationID
  _pid: 0,              // auto-incrementing property row ID
  _debounce: null       // debounce timer for RelationID recalc
};

// Relation types that carry no directionality — displayed as a plain line (no arrow)
var RC_NONDIRECTIONAL_TYPES = new Set(['Binding', 'FunctionalAssociation', 'CellExpression']);

// State for the pair dialog (exactly 2 nodes selected → Create Relation for pair)
var _rcPair = {
  nodeA: null,        // {cyId, label, nodeType, nodeId}
  nodeB: null,
  flipped: false,     // false: A→B (A is regulator), true: B→A
  isNonDir: false,    // true for Binding / FunctionalAssociation / CellExpression
  props: [],
  refs: [],
  refIdx: 0,
  refsVisible: false,
  refsLoaded: false,
  currentRelId: '',
  _pid: 0,
  _debounce: null
};
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
    if (e.target && (e.target.id === 'cypher-input' || e.target.id === 'sankey-cypher')) {
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
  // DB connection settings are available to all roles
  document.getElementById('settings-db-section').style.display = '';
  if (currentRole === 'admin') {
    document.getElementById('admin-btn') && (document.getElementById('admin-btn').style.display = '');
    document.getElementById('settings-users-item').style.display = '';
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
    // Pre-populate curation refCols so dialogs open instantly with no loading delay
    if (!_rc.refCols.length) _rc.refCols = data.referenceColumns || [];
  }).catch(function() {});
  initCytoscape();
  _loadSchema(); // Preload schema immediately so relation-type dropdowns are ready before any dialog opens

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
    minZoom: 0.001, maxZoom: 5,
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
    // Node was manually repositioned — reset the scale base so the slider
    // starts fresh from the current (post-drag) positions next time it's moved.
    _layoutBasePositions = null;
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

function addNeighborsToSelection() {
  if (!cy) return;
  var selected = cy.nodes(':selected');
  if (!selected.length) return;
  var neighbors = selected.neighborhood('node').not('[?isClone]');
  neighbors.select();
  // Also select edges connecting input nodes to their neighbors
  selected.edgesWith(neighbors).select();
}

function selectNodesByLabel(lbl) {
  if (!cy) return;
  cy.nodes().unselect();
  cy.nodes('[nodeType="' + lbl + '"]').not('[?isClone]').select();
  closeMenus();
}

function populateSelectByLabelMenu() {
  var sub = document.getElementById('select-by-label-submenu');
  if (!sub) return;
  // Collect unique nodeType values from current graph
  var labels = [];
  if (cy && cy.nodes().length) {
    var seen = {};
    cy.nodes().not('[?isClone]').forEach(function(n) {
      var t = n.data('nodeType');
      if (t && !seen[t]) { seen[t] = true; labels.push(t); }
    });
    labels.sort(function(a, b) { return a.localeCompare(b); });
  }
  if (!labels.length) {
    sub.innerHTML = '<div class="menu-item" style="color:#7a8099;font-style:italic">No nodes in graph</div>';
    return;
  }
  sub.innerHTML = labels.map(function(lbl) {
    var count = cy.nodes('[nodeType="' + lbl + '"]').not('[?isClone]').length;
    var escaped = lbl.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    return '<div class="menu-item" data-select-label="' + escaped + '">'
      + escaped + ' <span style="color:#7a8099;font-size:11px">(' + count + ')</span></div>';
  }).join('');
  // Attach delegation listener once per submenu element (flag prevents duplicates)
  if (!sub._labelListenerAttached) {
    sub._labelListenerAttached = true;
    sub.addEventListener('click', function(e) {
      var item = e.target.closest('[data-select-label]');
      if (item) selectNodesByLabel(item.getAttribute('data-select-label'));
    });
  }
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
var _schemaLoadPromise = null;    // in-flight fetch promise — shared so concurrent callers don't fire duplicate requests
var _acSelectedIdx = -1;          // currently highlighted row index
var _acItems = [];                 // current suggestion list
var _acBoxId = 'cypher-autocomplete';   // active autocomplete dropdown element id
var _lintPanelId = 'cypher-lint-panel'; // active lint panel element id

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

// Populate relation-curation caches from a schema object (called whenever schema is fetched)
function _applySchemaToRc(schema) {
  if (!schema) return;
  if (schema.relTypes && schema.relTypes.length && !_rc.relTypes.length) {
    _rc.relTypes = schema.relTypes;
  }
  if (schema.propKeys && schema.propKeys.length && !_rc.propKeys.length) {
    _rc.propKeys = schema.propKeys;
  }
}

function _loadSchema() {
  if (_schemaCache) {
    _applySchemaToRc(_schemaCache);
    return Promise.resolve(_schemaCache);
  }
  if (!authToken) return Promise.resolve(null);   // not logged in yet
  // Return the in-flight promise if a fetch is already underway — avoids duplicate server requests
  if (_schemaLoadPromise) return _schemaLoadPromise;
  _schemaLoadPromise = fetch('/api/graph/schema', {
    headers: { 'Authorization': 'Bearer ' + authToken }
  })
  .then(function(r) { return r.ok ? r.json() : null; })
  .then(function(d) {
    if (d && d.labels) { _schemaCache = d; _applySchemaToRc(d); }
    return _schemaCache;
  })
  .catch(function() { return null; })
  .finally(function() { _schemaLoadPromise = null; }); // clear guard so a failed load can be retried
  return _schemaLoadPromise;
}

// Invalidate schema cache when user reconnects to a different DB, then immediately reload
function _invalidateSchemaCache() {
  _schemaCache = null;
  _rc.relTypes = [];
  _rc.propKeys = [];
  _loadSchema(); // repopulate globals for new connection
}

function _acShow(items, ta) {
  var box = document.getElementById(_acBoxId);
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
  var box = document.getElementById(_acBoxId);
  if (box) box.style.display = 'none';
  _acItems = [];
  _acSelectedIdx = -1;
}

function _acSetIdx(idx, box) {
  if (!box) box = document.getElementById(_acBoxId);
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
  var box = document.getElementById(_acBoxId);
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
  _acBoxId = 'cypher-autocomplete';
  _lintPanelId = 'cypher-lint-panel';
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

// Sankey cypher textarea — same pipeline, different dropdown/lint elements
function onSankeyCypherInput(ta) {
  _acBoxId = 'sankey-autocomplete';
  _lintPanelId = 'sankey-lint-panel';
  cypherAutoResize(ta);
  _acTrigger(ta);
  var structErr = cypherStructuralCheck(ta.value);
  if (structErr) { showCypherLint('error', structErr); return; }
  showCypherLint(null);
  if (_lintDebounce) clearTimeout(_lintDebounce);
  _lintDebounce = setTimeout(function() {
    _lintDebounce = null;
    _lintPanelId = 'sankey-lint-panel'; // restore in case another field fired
    runCypherExplainLint(ta.value);
  }, 1200);
}

// Same keydown handler works for both editors; it reads e.target (the textarea)
function onSankeyCypherKeydown(e) {
  _acBoxId = 'sankey-autocomplete';
  _lintPanelId = 'sankey-lint-panel';
  if (_acHandleKey(e)) return;
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runSankeyQuery(); }
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
  var panel = document.getElementById(_lintPanelId);
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

// ─── Sankey diagram ───────────────────────────────────────────────────────────
var _sankeyCache = null;         // last query result for re-render on option change
var _sankeySelNodeIds = null;    // Set of graph node IDs in current Sankey selection (null = all)
var _sankeySelEdgeIds = null;    // Set of graph edge IDs in current Sankey selection (null = all)

// Module-level hook so sankeyShowAll() (called from HTML) can reach into the active render closure
var _sankeyShowAll = null;

function sankeyShowAll() {
  if (_sankeyShowAll) _sankeyShowAll();
}

function openSankeyDialog() {
  document.getElementById('sankey-modal').style.display = 'flex';
  document.getElementById('sankey-status').textContent = '';
  var btn = document.getElementById('sankey-show-all-btn');
  if (btn) btn.style.display = 'none';
  _sankeyShowAll = null;
  _sankeySelNodeIds = null;
  _sankeySelEdgeIds = null;
  setTimeout(function() { document.getElementById('sankey-cypher').focus(); }, 50);
}

function closeSankeyDialog() {
  document.getElementById('sankey-modal').style.display = 'none';
}

async function runSankeyQuery() {
  var query = (document.getElementById('sankey-cypher').value || '').trim();
  if (!query) return;
  var status = document.getElementById('sankey-status');
  var wrap   = document.getElementById('sankey-svg-wrap');
  status.textContent = '⏳ Running…';
  status.style.color = '#7a8099';
  wrap.innerHTML = '';
  try {
    var data = await api('/api/graph/query', { query: query });
    _sankeyCache = data;
    renderSankeyFromCache();
    var edgeCount = data.edges ? data.edges.length : 0;
    status.textContent = data.nodes.length + ' nodes · ' + edgeCount + ' edges';
    status.style.color = '#4caf50';
    appendCypherHistory(query, edgeCount);
  } catch (err) {
    status.textContent = 'Error: ' + (err.message || err);
    status.style.color = '#e05560';
  }
}

function renderSankeyFromCache() {
  if (!_sankeyCache) return;
  var valueProp  = (document.getElementById('sankey-value-prop').value || '').trim();
  var showLabels = document.getElementById('sankey-show-labels').checked;
  _renderSankey(_sankeyCache.nodes, _sankeyCache.edges, valueProp, showLabels);
}

// Break cycles in-place by reversing back-edges found via iterative DFS.
// links[i].source and .target are numeric indices into nodes[].
// Effect node block colors (positive=red, negative=green, per Pathway Studio convention)
var _EFFECT_COLORS = { positive:'#ef5350', negative:'#66bb6a', unknown:'#90a4ae', undefined:'#90a4ae' };
function _sankeyEffectColor(e) { return _EFFECT_COLORS[(e||'unknown').toLowerCase()] || '#90a4ae'; }

// Target spectrum color for effect-based link color shifting
var _EFFECT_SPECTRUM = { positive:'#d32f2f', negative:'#388e3c', unknown:'#78909c', undefined:'#78909c' };
function _effectSpectrumColor(e) { return _EFFECT_SPECTRUM[(e||'unknown').toLowerCase()] || '#78909c'; }

// Blend two hex colors: t=0 → c1, t=1 → c2
function _blendHex(c1, c2, t) {
  function p(h) { return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]; }
  var a = p(c1 || '#9e9e9e'), b = p(c2 || '#9e9e9e');
  return '#' + [0,1,2].map(function(i){
    return ('0' + Math.round(a[i]*(1-t) + b[i]*t).toString(16)).slice(-2);
  }).join('');
}

// (kept for potential direct-graph mode in future)
function _sankeyBreakCycles(nodeCount, links) {
  var WHITE = 0, GRAY = 1, BLACK = 2;
  var color = new Array(nodeCount).fill(WHITE);
  // adjacency: node → [link index, ...]
  var adj = [];
  for (var i = 0; i < nodeCount; i++) adj.push([]);
  links.forEach(function(l, li) {
    if (l.source !== l.target) adj[l.source].push(li);
  });

  var reversed = new Set();
  for (var start = 0; start < nodeCount; start++) {
    if (color[start] !== WHITE) continue;
    // Iterative DFS — frame = { node, edgeIdx }
    var stack = [{ node: start, ei: 0 }];
    color[start] = GRAY;
    while (stack.length) {
      var frame = stack[stack.length - 1];
      var u = frame.node;
      var moved = false;
      while (frame.ei < adj[u].length) {
        var li = adj[u][frame.ei++];
        if (reversed.has(li)) continue;
        var v = links[li].target;
        if (color[v] === GRAY) {
          // back-edge → reverse it to break the cycle
          reversed.add(li);
          var tmp = links[li].source;
          links[li].source = links[li].target;
          links[li].target = tmp;
          // add to adj of new source so DFS stays consistent
          adj[links[li].source].push(li);
        } else if (color[v] === WHITE) {
          color[v] = GRAY;
          stack.push({ node: v, ei: 0 });
          moved = true;
          break;
        }
      }
      if (!moved) {
        color[u] = BLACK;
        stack.pop();
      }
    }
  }
}

// Generates a closed filled-ribbon SVG path for a Sankey link.
// Using filled paths (vs. wide strokes) gives pixel-accurate hit detection:
// mouse events fire on the exact visible ribbon, not on the stroke bounding box.
// customWidth overrides d._w0/d.width — used for proportional selection scaling.
function sankeyLinkFilled(d, customWidth) {
  var w  = Math.max(0.5, customWidth !== undefined ? customWidth : (d._w0 || d.width || 1));
  var hw = w / 2;
  var x0 = d.source.x1, x1 = d.target.x0, xm = (x0 + x1) / 2;
  var y0 = d.y0, y1 = d.y1;
  return 'M' + x0 + ',' + (y0 - hw)
    + 'C' + xm + ',' + (y0 - hw) + ' ' + xm + ',' + (y1 - hw) + ' ' + x1 + ',' + (y1 - hw)
    + 'L' + x1 + ',' + (y1 + hw)
    + 'C' + xm + ',' + (y1 + hw) + ' ' + xm + ',' + (y0 + hw) + ' ' + x0 + ',' + (y0 + hw)
    + 'Z';
}

function _renderSankey(gNodes, gEdges, valueProp, showLabels) {
  var wrap = document.getElementById('sankey-svg-wrap');
  wrap.innerHTML = '';

  if (!gNodes || !gNodes.length) {
    wrap.innerHTML = '<div style="color:#7a8099;padding:20px;font-size:13px">No nodes returned.</div>';
    return;
  }

  // ── Anchor detection ──────────────────────────────────────────────────────
  var degree = {};
  gEdges.forEach(function(e) {
    var s = String(e.startNodeId), t = String(e.endNodeId);
    degree[s] = (degree[s] || 0) + 1;
    degree[t] = (degree[t] || 0) + 1;
  });
  var anchorGId = Object.keys(degree).sort(function(a, b) { return degree[b] - degree[a]; })[0];
  var nodeById = {};
  gNodes.forEach(function(n) { nodeById[String(n.id)] = n; });
  var anchorProp = (nodeById[anchorGId] || {}).properties || {};
  var anchorName = anchorProp.Name || anchorProp.name || anchorGId || 'Hub';

  var _skipL = { Entity:1, Named:1, Validated:1, Object:1 };
  function primaryLabel(node) {
    var ls = (node || {}).labels || [];
    return ls.find(function(l) { return !_skipL[l]; }) || ls[0] || 'Unknown';
  }

  // ── Aggregate groups + collect raw edge/node metadata ────────────────────
  // upstream key  = "entityLabel|||effect|||relType"
  // downstream key= "relType|||effect|||entityLabel"
  var upAgg = {}, downAgg = {};
  var upMeta = {}, downMeta = {};   // key → { edgeCount, nodeSet, edgeIdSet }

  gEdges.forEach(function(e) {
    var src = String(e.startNodeId), tgt = String(e.endNodeId);
    if (src === tgt) return;
    var isDown = (src === anchorGId), isUp = (tgt === anchorGId);
    if (!isDown && !isUp) return;
    var otherId = isDown ? tgt : src;
    var other   = nodeById[otherId];
    if (!other) return;
    var label   = primaryLabel(other);
    var effect  = (e.properties || {}).Effect || 'unknown';
    var relType = e.type || 'Unknown';
    var rv      = valueProp ? (e.properties || {})[valueProp] : null;
    var value   = (rv != null && isFinite(parseFloat(rv)) && parseFloat(rv) > 0) ? parseFloat(rv) : 1;
    var eid     = String(e.id !== undefined ? e.id : (e.elementId || (src+'_'+tgt)));
    if (isUp) {
      var k = label+'|||'+effect+'|||'+relType;
      upAgg[k] = (upAgg[k] || 0) + value;
      if (!upMeta[k]) upMeta[k] = { edgeCount:0, nodeSet:new Set(), edgeIdSet:new Set() };
      upMeta[k].edgeCount++; upMeta[k].nodeSet.add(otherId); upMeta[k].nodeSet.add(anchorGId);
      upMeta[k].edgeIdSet.add(eid);
    } else {
      var k = relType+'|||'+effect+'|||'+label;
      downAgg[k] = (downAgg[k] || 0) + value;
      if (!downMeta[k]) downMeta[k] = { edgeCount:0, nodeSet:new Set(), edgeIdSet:new Set() };
      downMeta[k].edgeCount++; downMeta[k].nodeSet.add(otherId); downMeta[k].nodeSet.add(anchorGId);
      downMeta[k].edgeIdSet.add(eid);
    }
  });

  // ── Sankey builder helpers ────────────────────────────────────────────────
  var sNodes = [], nodeIdxMap = {};
  function addNode(key, name, color) {
    if (!(key in nodeIdxMap)) { nodeIdxMap[key] = sNodes.length; sNodes.push({ key:key, name:name, color:color }); }
    return nodeIdxMap[key];
  }
  var sLinkMap = {};
  var sLinkGroupVal = {};  // linkKey → { groupKey → value } — for proportional rescaling
  function addLink(si, ti, val, color, gk) {
    var k = si+'|'+ti;
    // Track per-group contribution so we can rescale width on selection
    if (gk) {
      if (!sLinkGroupVal[k]) sLinkGroupVal[k] = {};
      sLinkGroupVal[k][gk] = (sLinkGroupVal[k][gk] || 0) + val;
    }
    if (sLinkMap[k]) {
      sLinkMap[k].value += val;
      if (gk && sLinkMap[k]._gks.indexOf(gk) < 0) sLinkMap[k]._gks.push(gk);
    } else {
      sLinkMap[k] = { source:si, target:ti, value:val, color:color||'#7a8099', _lk:k, _gks:gk?[gk]:[] };
    }
  }

  // Group ↔ Sankey element associations (for selection tracing)
  var nodeKeyGroups = {};    // sankeyNodeKey → [groupKey]
  var linkKeyGroups = {};    // linkKey       → [groupKey]
  var groupNodeKeys = {};    // groupKey → [sankeyNodeKey]
  var groupLinkKeys = {};    // groupKey → [linkKey]
  function assoc(nodeKey, linkKey, gk) {
    function push(map, k, v) { if (!map[k]) map[k]=[]; if(map[k].indexOf(v)<0) map[k].push(v); }
    if (nodeKey) { push(nodeKeyGroups, nodeKey, gk); push(groupNodeKeys, gk, nodeKey); }
    if (linkKey) { push(linkKeyGroups, linkKey, gk); push(groupLinkKeys, gk, linkKey); }
  }

  var _ecMap = {};
  function entityColor(l) { if(!_ecMap[l]) _ecMap[l]=NODE_COLORS[l]||DEFAULT_NODE_COLOR; return _ecMap[l]; }
  function relBaseColor(t) { return RELATION_COLORS[t]||DEFAULT_NODE_COLOR; }
  var ANCHOR_CLR = '#b71c1c';
  var aIdx = addNode('__anchor__', anchorName, ANCHOR_CLR);

  Object.keys(upAgg).forEach(function(k) {
    var p=k.split('|||'), label=p[0], effect=p[1], relType=p[2], val=upAgg[k];
    var ec=entityColor(label), efc=_sankeyEffectColor(effect), rc=relBaseColor(relType), sp=_effectSpectrumColor(effect);
    var eIdx  = addNode('up_e_'+label,             label,   ec);
    var efIdx = addNode('up_ef_'+label+'_'+effect, effect,  efc);
    var rIdx  = addNode('up_r_'+relType,           relType, rc);
    var lk1=eIdx+'|'+efIdx, lk2=efIdx+'|'+rIdx, lk3=rIdx+'|'+aIdx;
    addLink(eIdx, efIdx, val, _blendHex(ec, sp, 0.5), k);
    addLink(efIdx, rIdx, val, _blendHex(rc, sp, 0.5), k);
    addLink(rIdx,  aIdx, val, rc, k);
    ['up_e_'+label,'up_ef_'+label+'_'+effect,'up_r_'+relType,'__anchor__'].forEach(function(nk){ assoc(nk,null,k); });
    [lk1,lk2,lk3].forEach(function(lk){ assoc(null,lk,k); });
  });

  Object.keys(downAgg).forEach(function(k) {
    var p=k.split('|||'), relType=p[0], effect=p[1], label=p[2], val=downAgg[k];
    var ec=entityColor(label), efc=_sankeyEffectColor(effect), rc=relBaseColor(relType), sp=_effectSpectrumColor(effect);
    var rIdx  = addNode('down_r_'+relType,             relType, rc);
    var efIdx = addNode('down_ef_'+relType+'_'+effect, effect,  efc);
    var eIdx  = addNode('down_e_'+label,               label,   ec);
    var lk1=aIdx+'|'+rIdx, lk2=rIdx+'|'+efIdx, lk3=efIdx+'|'+eIdx;
    addLink(aIdx,  rIdx,  val, rc, k);
    addLink(rIdx,  efIdx, val, _blendHex(rc, sp, 0.5), k);
    addLink(efIdx, eIdx,  val, _blendHex(ec, sp, 0.5), k);
    ['__anchor__','down_r_'+relType,'down_ef_'+relType+'_'+effect,'down_e_'+label].forEach(function(nk){ assoc(nk,null,k); });
    [lk1,lk2,lk3].forEach(function(lk){ assoc(null,lk,k); });
  });

  var sLinks = Object.values(sLinkMap);
  if (!sLinks.length) {
    wrap.innerHTML = '<div style="color:#7a8099;padding:20px;font-size:13px">No edges connected to hub node (' + escHtml(anchorName) + ').</div>';
    return;
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  var HEADER = 52;
  var W = Math.max(wrap.clientWidth || 1000, 700);
  var H = Math.max(420, sNodes.length * 16 + 80);

  var sankey = d3.sankey()
    .nodeWidth(16).nodePadding(8)
    .extent([[2, 2], [W - 2, H - 2]])
    .nodeAlign(d3.sankeyLeft);

  var graph;
  try {
    graph = sankey({
      nodes: sNodes.map(function(n) { return Object.assign({}, n); }),
      links: sLinks.map(function(l) { return Object.assign({}, l); })
    });
  } catch(err) {
    wrap.innerHTML = '<div style="color:#e05560;padding:20px;font-size:13px">Layout error: ' + escHtml(err.message) + '</div>';
    return;
  }
  // Cache each link's d3-sankey-computed width so clearHighlight can reliably restore it
  graph.links.forEach(function(l) { l._w0 = l.width || 1; });

  // ── SVG scaffold ──────────────────────────────────────────────────────────
  var svg = d3.select(wrap).append('svg')
    .attr('width', W).attr('height', H + HEADER)
    .attr('id', 'sankey-svg')
    .style('font-family', 'sans-serif').style('font-size', '11px');

  // Column headers
  var depthX = {};
  graph.nodes.forEach(function(n) { if (!(n.depth in depthX)) depthX[n.depth] = n.x0; });
  var maxD = d3.max(Object.keys(depthX).map(Number));
  function colLabel(d) {
    if (d===0||d===maxD) return 'ENTITY';
    if (d===1||d===maxD-1) return 'EFFECT';
    if (d===2||d===maxD-2) return 'RELATION';
    return null;
  }
  Object.keys(depthX).forEach(function(d) {
    d=+d; var lbl=colLabel(d); if(!lbl) return;
    svg.append('text').attr('x',depthX[d]).attr('y',HEADER-10)
      .attr('fill','#8090b0').attr('font-size','9px').attr('font-weight','700').attr('letter-spacing','1.5px').text(lbl);
  });

  // UPSTREAM / DOWNSTREAM banners
  var upNd = graph.nodes.filter(function(n){ return n.key&&n.key.indexOf('up_')===0; });
  var dnNd = graph.nodes.filter(function(n){ return n.key&&n.key.indexOf('down_')===0; });
  function bannerX(ns){ return [d3.min(ns,function(n){return n.x0;}),d3.max(ns,function(n){return n.x1;})]; }
  if (upNd.length){ var bx=bannerX(upNd); svg.append('text').attr('x',(bx[0]+bx[1])/2).attr('y',16).attr('text-anchor','middle').attr('fill','#7a9fd4').attr('font-size','11px').attr('font-weight','bold').attr('letter-spacing','2px').text('UPSTREAM'); }
  if (dnNd.length){ var bx=bannerX(dnNd); svg.append('text').attr('x',(bx[0]+bx[1])/2).attr('y',16).attr('text-anchor','middle').attr('fill','#7a9fd4').attr('font-size','11px').attr('font-weight','bold').attr('letter-spacing','2px').text('DOWNSTREAM'); }

  var g = svg.append('g').attr('transform', 'translate(0,'+HEADER+')');

  // ── Interactive selection ─────────────────────────────────────────────────
  var statusEl   = document.getElementById('sankey-status');
  var showAllBtn = document.getElementById('sankey-show-all-btn');
  var _selKey    = null;  // currently selected element key (or null)
  var _origText  = '';    // captured lazily on first selection (after query status is written)

  function resolveGroups(key, isLink) {
    // If anchor node selected, include ALL groups
    if (!isLink && key === '__anchor__') {
      return Object.keys(upMeta).concat(Object.keys(downMeta));
    }
    return (isLink ? linkKeyGroups[key] : nodeKeyGroups[key]) || [];
  }

  // Semi-transparent fog overlay — shown during selection to dim unselected areas
  var fogRect = g.append('rect')
    .attr('x', 0).attr('y', -HEADER).attr('width', W).attr('height', H + HEADER)
    .attr('fill', '#070c14').attr('fill-opacity', 0).style('pointer-events', 'none');

  // Sum the contribution of the selected groups to a specific link
  function _selLinkVal(lk, groups) {
    var map = sLinkGroupVal[lk];
    if (!map) return 0;
    var sum = 0;
    groups.forEach(function(gk) { sum += (map[gk] || 0); });
    return sum;
  }

  function applyHighlight(selNodeSet, selLinkSet, groups) {
    // Show button immediately — before the heavy per-link SVG recalculation below
    if (showAllBtn) showAllBtn.style.display = '';
    fogRect.transition().duration(150).attr('fill-opacity', 0.62);
    linkSel.attr('fill-opacity', function(d) { return selLinkSet.has(d._lk) ? 0.82 : 0; });
    // Regenerate the ribbon path at scaled width for proportional flow display
    linkSel.attr('d', function(d) {
      var origW = d._w0 || d.width || 1;
      if (!selLinkSet.has(d._lk)) return sankeyLinkFilled(d, origW);
      var selVal = _selLinkVal(d._lk, groups);
      var scale  = (d.value > 0 && selVal > 0) ? selVal / d.value : 1;
      return sankeyLinkFilled(d, Math.max(1, origW * scale));
    });
    nodeSel.attr('opacity', function(d) { return selNodeSet.has(d.key) ? 1 : 0; });
    if (labelSel) labelSel.attr('opacity', function(d) { return selNodeSet.has(d.key) ? 1 : 0; });
  }

  function clearHighlight() {
    fogRect.transition().duration(150).attr('fill-opacity', 0);
    // Restore full-width ribbon paths and opacity
    linkSel.attr('fill-opacity', 0.42);
    linkSel.attr('d', function(d) { return sankeyLinkFilled(d); });
    nodeSel.attr('opacity', 0.92);
    if (labelSel) labelSel.attr('opacity', 1);
    if (statusEl) { statusEl.textContent = _origText; statusEl.style.color = '#4caf50'; }
    if (showAllBtn) showAllBtn.style.display = 'none';
    _selKey = null;
    _sankeySelNodeIds = null;
    _sankeySelEdgeIds = null;
  }

  function selectElement(key, isLink) {
    if (_selKey === key) { clearHighlight(); return; }   // toggle off
    // Capture the current status text as the restore point only on the first selection
    // (runSankeyQuery writes the "N nodes · M edges" total AFTER _renderSankey returns,
    //  so capturing here guarantees we get the completed status, not "⏳ Running…")
    if (_selKey === null && statusEl) _origText = statusEl.textContent;
    _selKey = key;

    var groups = resolveGroups(key, isLink);
    if (!groups.length) { clearHighlight(); return; }

    // Collect all Sankey elements that belong to these groups
    var selNodeKeys = new Set(), selLinkKeys = new Set();
    var totalEdges = 0, allNodeIds = new Set(), allEdgeIds = new Set();
    groups.forEach(function(gk) {
      (groupNodeKeys[gk] || []).forEach(function(nk) { selNodeKeys.add(nk); });
      (groupLinkKeys[gk] || []).forEach(function(lk) { selLinkKeys.add(lk); });
      var meta = upMeta[gk] || downMeta[gk];
      if (meta) {
        totalEdges += meta.edgeCount;
        meta.nodeSet.forEach(function(id) { allNodeIds.add(id); });
        if (meta.edgeIdSet) meta.edgeIdSet.forEach(function(id) { allEdgeIds.add(id); });
      }
    });

    // Expose selected graph element IDs so "Show graph" can filter the dataset
    _sankeySelNodeIds = allNodeIds;
    _sankeySelEdgeIds = allEdgeIds;

    applyHighlight(selNodeKeys, selLinkKeys, groups);

    if (statusEl) {
      statusEl.textContent = allNodeIds.size + ' nodes · ' + totalEdges + ' edges selected';
      statusEl.style.color = '#4caf50';
    }
  }

  // ── Render links as filled ribbons ────────────────────────────────────────
  // Filled paths give pixel-accurate hit detection — events fire only on the
  // visible ribbon area, not on the wide stroke bounding box that causes the
  // "wrong path highlighted on hover" bug when paths overlap.
  var linkSel = g.append('g').attr('stroke', 'none')
    .selectAll('path').data(graph.links).join('path')
      .attr('d', function(d) { return sankeyLinkFilled(d); })
      .attr('fill', function(d) { return d.color || d.source.color || '#7a8099'; })
      .attr('fill-opacity', 0.42)
      .style('cursor', 'pointer')
      .on('click', function(event, d) {
        event.stopPropagation();
        selectElement(d._lk, true);
      });
  // Append tooltip titles separately so linkSel stays as <path> selection
  linkSel.append('title').text(function(d) {
    return d.source.name + ' → ' + d.target.name + '\nValue: ' + d.value.toFixed(0);
  });

  // ── Render nodes ──────────────────────────────────────────────────────────
  var nodeSel = g.append('g').selectAll('rect').data(graph.nodes).join('rect')
    .attr('x',      function(d){ return d.x0; })
    .attr('y',      function(d){ return d.y0; })
    .attr('height', function(d){ return Math.max(2, d.y1-d.y0); })
    .attr('width',  function(d){ return d.x1-d.x0; })
    .attr('fill',   function(d){ return d.color || '#7a8099'; })
    .attr('opacity', 0.92)
    .style('cursor', 'pointer')
    .on('click', function(event, d) {
      event.stopPropagation();
      selectElement(d.key, false);
    });
  // Append tooltip titles separately so nodeSel stays as <rect> selection
  nodeSel.append('title').text(function(d){ return d.name; });

  // ── Labels ────────────────────────────────────────────────────────────────
  var labelSel = null;
  if (showLabels) {
    labelSel = g.append('g').selectAll('text').data(graph.nodes).join('text')
      .attr('x',    function(d){ return d.x0 < W/2 ? d.x1+5 : d.x0-5; })
      .attr('y',    function(d){ return (d.y1+d.y0)/2; })
      .attr('dy',   '0.35em')
      .attr('text-anchor', function(d){ return d.x0 < W/2 ? 'start' : 'end'; })
      .attr('fill', '#c8d0e8').attr('font-size', '11px')
      .style('pointer-events', 'none')
      .text(function(d){ return d.name; });
  }

  // Expose clearHighlight AFTER linkSel/nodeSel/labelSel are fully built,
  // so the closure captures all selections with their final values.
  _sankeyShowAll = clearHighlight;

  // Click SVG background to deselect
  svg.on('click', function() { clearHighlight(); });
}

function exportSankeyAsSvg() {
  var svgEl = document.getElementById('sankey-svg');
  if (!svgEl) { alert('Run a query first.'); return; }
  var blob = new Blob([svgEl.outerHTML], { type: 'image/svg+xml' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sankey.svg';
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 2000);
}

function showSankeyAsGraph() {
  if (!_sankeyCache) { alert('Run a query first.'); return; }
  var data = _sankeyCache;
  var filteredData;

  if (_sankeySelNodeIds && _sankeySelNodeIds.size > 0) {
    // A path is selected — show only the nodes and edges in that selection
    var nodeSet = _sankeySelNodeIds;
    var edgeSet = _sankeySelEdgeIds;
    filteredData = {
      nodes: data.nodes.filter(function(n) { return nodeSet.has(String(n.id)); }),
      edges: data.edges.filter(function(e) {
        // Use tracked edge IDs when available, otherwise fall back to endpoint membership
        return edgeSet && edgeSet.size > 0
          ? edgeSet.has(String(e.id !== undefined ? e.id : (e.elementId || '')))
          : (nodeSet.has(String(e.startNodeId)) && nodeSet.has(String(e.endNodeId)));
      })
    };
  } else {
    // No selection — show the full query result
    filteredData = { nodes: data.nodes, edges: data.edges };
  }

  closeSankeyDialog();
  hideQueryResultTable();
  renderGraph(filteredData);
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
  var newNodeIds = [];
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
    newNodeIds.push(nid);
    cy.add({
      group: 'nodes',
      data: _buildCyNodeData(n),
      position: { x: Math.random() * 200 - 100, y: Math.random() * 200 - 100 }
    });
  });

  // ── Step 5: add / update edges ───────────────────────────────────────────
  var addedEdges = 0;
  newEdges.forEach(function(e) {
    var eid = String(e.id);
    if (existingEdgeIds.has(eid)) {
      // Edge already on canvas — update properties in graphData and Cytoscape
      if (e.properties) {
        var ge = graphData.edges.find(function(x) { return String(x.id) === eid; });
        if (ge) Object.assign(ge.properties, e.properties);
        var cyEdge = cy.getElementById(eid);
        if (cyEdge.length) {
          Object.keys(e.properties).forEach(function(k) { cyEdge.data(k, e.properties[k]); });
        }
      }
      return;
    }
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

  // Select newly added nodes so the user can immediately drag them as a group
  if (newNodeIds.length) {
    cy.nodes(':selected').unselect();
    newNodeIds.forEach(function(id) {
      var n = cy.getElementById(id);
      if (n.length) n.select();
    });
  }

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

  // Reset scale slider whenever a new layout is applied
  resetLayoutScale();

  // circle/concentric: disable built-in fit (it ignores label extents) and do a
  // label-aware fit ourselves via zoomFit() once the layout has placed nodes.
  var needsLabelFit = (name === 'circle' || name === 'concentric');

  var layoutConfigs = {
    cose:      { name: 'cose',      animate: false, numIter: 100, nodeRepulsion: 4500, idealEdgeLength: 100, fit: true, padding: 40 },
    dagre:     { name: 'dagre',     rankDir: 'TB', nodeSep: 60, rankSep: 80, animate: false, fit: true, padding: 40 },
    circle:    { name: 'circle',    animate: false, fit: false, padding: 40 },
    concentric:{ name: 'concentric',animate: false, fit: false, padding: 40, minNodeSpacing: 40 },
    grid:      { name: 'grid',      animate: false, fit: true, padding: 40, avoidOverlap: true },
    klay:      { name: 'klay',      animate: false, fit: true, padding: 40,
                 klay: { direction: 'DOWN', edgeRouting: 'ORTHOGONAL',
                         nodeLayering: 'LONGEST_PATH', nodePlacement: 'BRANDES_KOEPF',
                         inLayerSpacingFactor: 1.0, edgeSpacingFactor: 0.5 } }
  };

  var config = layoutConfigs[name] || layoutConfigs.cose;
  try {
    var layoutInst = cy.layout(config);
    if (needsLabelFit) {
      layoutInst.on('layoutstop', function() { zoomFit(); });
    }
    layoutInst.run();
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
  var padding = 40;
  // Use a label-inclusive bounding box so wrapped node labels don't get clipped
  // at the viewport edge (most visible on circular / concentric layouts where
  // every outermost node sits right at the fitted boundary).
  var bb;
  try { bb = cy.nodes().boundingBox({ includeLabels: true }); } catch(e) { bb = null; }
  if (!bb || !isFinite(bb.w) || !isFinite(bb.h) || bb.w === 0 || bb.h === 0) {
    cy.fit(cy.elements(), padding);
    updateZoomLabel();
    return;
  }
  var zoom = Math.min(
    (cy.width()  - 2 * padding) / bb.w,
    (cy.height() - 2 * padding) / bb.h
  );
  // Do NOT clamp to cy.minZoom() — Fit must always show the whole graph even
  // if that requires going below the interactive zoom floor.
  zoom = Math.min(Math.max(zoom, 0.001), cy.maxZoom());
  cy.viewport({
    zoom: zoom,
    pan: {
      x: cy.width()  / 2 - zoom * (bb.x1 + bb.x2) / 2,
      y: cy.height() / 2 - zoom * (bb.y1 + bb.y2) / 2
    }
  });
  updateZoomLabel();
}

// ─── Layout scale slider ──────────────────────────────────────────────────────
var _layoutBasePositions = null;  // node positions captured when slider was first moved

function applyLayoutScale(val) {
  if (!cy) return;
  val = parseFloat(val);

  // Update the label
  var lbl = document.getElementById('layout-scale-label');
  if (lbl) lbl.textContent = (val === 1 ? '1' : val.toFixed(2).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')) + '×';

  // Capture base positions the first time the slider moves after a reset
  if (!_layoutBasePositions) {
    pushUndo();
    _layoutBasePositions = {};
    cy.nodes().not('[?isClone]').forEach(function(n) {
      var p = n.position();
      _layoutBasePositions[n.id()] = { x: p.x, y: p.y };
    });
  }

  // Centroid of base positions
  var ids = Object.keys(_layoutBasePositions);
  if (!ids.length) return;
  var cx = 0, cy_ = 0;
  ids.forEach(function(id) { cx += _layoutBasePositions[id].x; cy_ += _layoutBasePositions[id].y; });
  cx /= ids.length;
  cy_ /= ids.length;

  // Scale each node's offset from the centroid
  cy.startBatch();
  cy.nodes().not('[?isClone]').forEach(function(n) {
    var base = _layoutBasePositions[n.id()];
    if (!base) return;
    n.position({
      x: cx + (base.x - cx) * val,
      y: cy_ + (base.y - cy_) * val
    });
  });
  cy.endBatch();
}

function resetLayoutScale() {
  _layoutBasePositions = null;
  var slider = document.getElementById('layout-scale-slider');
  if (slider) slider.value = '1';
  var lbl = document.getElementById('layout-scale-label');
  if (lbl) lbl.textContent = '1×';
}

// ─── Rotate graph ─────────────────────────────────────────────────────────────
// Rotates all node positions by `degrees` (positive = clockwise) around the
// bounding-box centroid.  Saves an undo snapshot before moving anything.
function rotateGraph(degrees) {
  if (!cy) return;
  var nodes = cy.nodes().not('[?isClone]');
  if (nodes.length === 0) return;

  pushUndo();

  var rad = degrees * Math.PI / 180;
  var cosA = Math.cos(rad);
  var sinA = Math.sin(rad);

  // Centroid of all node positions
  var cx = 0, cy_ = 0;
  nodes.forEach(function(n) { var p = n.position(); cx += p.x; cy_ += p.y; });
  cx /= nodes.length;
  cy_ /= nodes.length;

  // Rotate each node around the centroid
  cy.startBatch();
  nodes.forEach(function(n) {
    var p  = n.position();
    var dx = p.x - cx;
    var dy = p.y - cy_;
    n.position({ x: cx + dx * cosA - dy * sinA,
                 y: cy_ + dx * sinA + dy * cosA });
  });
  cy.endBatch();
}

// ─── Run query ────────────────────────────────────────────────────────────────
// ─── In-memory large-query exports (FR-2 / FR-3 / FR-4) ─────────────────────
// Shared Excel writer — accepts pre-built rows + isRelMode flag + filename.
// Mirrors exportTableExcel() but operates on caller-supplied rows so it can be
// used without touching tableRows / relationRows global state.
// Build an ExcelJS buffer from rows without triggering a download.
// Separated so callers can build multiple buffers sequentially then download in order.
async function buildExcelBuffer(rows, isRelMode, plainText) {
  function _matchSource(c) {
    if (isRelMode) return c.source === 'graph' || c.source === 'neo4j' || c.source === 'node_prop';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data' || c.source === 'node_prop';
  }
  var visCols = columnDefs.filter(function(c) { return c.visible && _matchSource(c); });
  // Fallback: if all matching columns are hidden, include them all (prevents empty export)
  if (visCols.length === 0) visCols = columnDefs.filter(_matchSource);

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
  var mimeType = /\.zip$/i.test(filename) ? 'application/zip'
               : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var blob = new Blob([buffer], { type: mimeType });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.style.display = 'none'; a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a generous delay — revoking synchronously can abort large downloads
  // before the browser has finished reading the Blob.
  setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
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

// ─── CSV export engine ────────────────────────────────────────────────────────
// Max rows per CSV file before splitting into a zip archive.
var MAX_CSV_ROWS = 1000000;

// Builds one comma-separated line from a row object (RFC 4180).
// Values containing commas, newlines, or double-quotes are wrapped in double-quotes
// with inner double-quotes escaped by doubling them.
// Sentence (msrc) values are kept exactly as they exist in PostgreSQL — the
// ID{…} markup is NOT stripped, per spec.
function buildCsvLine(row, visCols) {
  return visCols.map(function(col) {
    var val = row[col.key];
    var s   = val != null ? String(val) : '';
    // Always quote every field so Excel treats all values as strings (no
    // auto-conversion of IDs, years, or numeric-looking text to numbers).
    return '"' + s.replace(/"/g, '""') + '"';
  }).join(',');
}

// Triggers a plain-text download of a string.
function downloadTextFile(text, filename) {
  var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.style.display = 'none'; a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
}

// Writes an array of row objects as comma-separated CSV (RFC 4180).
// Splits into multiple files at maxRows (default MAX_CSV_ROWS) and zips them
// using the JSZip library that is already loaded on the page.
async function writeRowsToCSV(rows, isRelMode, baseName, maxRows) {
  maxRows = maxRows || MAX_CSV_ROWS;

  function _csvMatchSource(c) {
    if (isRelMode) return c.source === 'graph' || c.source === 'neo4j' || c.source === 'node_prop';
    return c.source === 'graph' || c.source === 'reference' ||
           c.source === 'scopus_data' || c.source === 'node_prop';
  }
  var visCols = columnDefs.filter(function(c) { return c.visible && _csvMatchSource(c); });
  // Fallback: if all matching columns are hidden, include them all (prevents silent empty export)
  if (visCols.length === 0) visCols = columnDefs.filter(_csvMatchSource);

  var headerLine = visCols.map(function(c) { return '"' + c.label.replace(/"/g, '""') + '"'; }).join(',');
  var _parts = Math.max(1, Math.ceil(rows.length / maxRows));

  if (_parts === 1) {
    setProgressMsg('⏳ Building CSV… (' + rows.length.toLocaleString() + ' rows)');
    await yieldToUI();
    var lines = [headerLine];
    rows.forEach(function(row) { lines.push(buildCsvLine(row, visCols)); });
    downloadTextFile(lines.join('\n'), baseName + '.csv');

  } else {
    if (typeof JSZip === 'undefined') {
      alert('JSZip library not loaded. Cannot create multi-file archive.');
      setProgressMsg(null); return;
    }
    var zip = new JSZip();
    for (var _pi = 0; _pi < _parts; _pi++) {
      setProgressMsg('⏳ Building CSV part ' + (_pi + 1) + ' of ' + _parts + '…');
      await yieldToUI();
      var _slice = rows.slice(_pi * maxRows, (_pi + 1) * maxRows);
      var lines  = [headerLine];
      _slice.forEach(function(row) { lines.push(buildCsvLine(row, visCols)); });
      zip.file(baseName + '-part' + (_pi + 1) + '.csv', lines.join('\n'));
    }
    setProgressMsg('⏳ Compressing ' + _parts + ' CSV files…');
    await yieldToUI();
    var _zipBuf = await zip.generateAsync({
      type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 1 }
    });
    var blob = new Blob([_zipBuf], { type: 'application/zip' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a'); a.href = url; a.download = baseName + '.zip'; a.click();
    URL.revokeObjectURL(url);
  }
  setProgressMsg(null);
}

// ─── CSV export — References mode ─────────────────────────────────────────────
// Uses /api/export/csv-query (Neo4j fetchSize 50 000) and 10 parallel PG workers.
// Processes edges in batches of EDGE_BATCH to keep browser memory bounded:
// refs are fetched and converted to CSV lines per-batch, then discarded.
// Splits output at MAX_CSV_ROWS rows per file; downloads a zip when > 1 file.
async function exportQueryCSVReferences(query) {
  setProgressMsg('⏳ Fetching relations from database…');
  var qData;
  try { qData = await api('/api/export/csv-query', { query }); }
  catch (err) { setProgressMsg(null); alert('Query error: ' + err.message); return; }

  var qNodes = qData.nodes || [];
  var qEdges = qData.edges || [];

  var nodeById = {};
  qNodes.forEach(function(n) {
    nodeById[n.id] = n;
    if (n.properties && n.properties.URN) nodeById[n.properties.URN] = n;
  });

  // MedScan IDs
  var medScan = {};
  var nodeIds = qNodes
    .map(function(n) { return n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null; })
    .filter(Boolean);
  if (nodeIds.length > 0) {
    try { Object.assign(medScan, await api('/api/nodes/medscan', { nodeIds })); }
    catch(e) { console.warn('MedScan lookup failed:', e.message); }
  }

  function nodeLabel(node)   { return node ? getNodeLabel(node) : '?'; }
  function nodeMedScan(node) {
    if (!node || !node.properties) return '';
    var nid = node.properties.NodeID != null ? String(node.properties.NodeID) : null;
    return (nid && medScan[nid]) ? medScan[nid] : '';
  }

  // Column definitions — same filter as writeRowsToCSV(isRelMode=false)
  function _refMatchSource(c) {
    return c.source === 'graph' || c.source === 'reference' ||
           c.source === 'scopus_data' || c.source === 'node_prop';
  }
  var visCols = columnDefs.filter(function(c) { return c.visible && _refMatchSource(c); });
  if (visCols.length === 0) visCols = columnDefs.filter(_refMatchSource);
  var scopusCols = columnDefs.filter(function(c) { return c.source === 'scopus_data' && c.visible; })
                             .map(function(c) { return c.dbField; });
  var headerLine = visCols.map(function(c) { return '"' + c.label.replace(/"/g, '""') + '"'; }).join(',');

  // Streaming CSV accumulation — bounded memory via edge batching
  var EDGE_BATCH  = 5000;   // edges processed per round
  var REF_CHUNK   = 200;    // relIds per PostgreSQL batch request
  var CONCURRENCY = 10;     // parallel PG workers per edge batch

  // fileSegments holds one complete CSV string per output file.
  // Flushed at MAX_CSV_ROWS rows so no single file exceeds Excel's row limit.
  var fileSegments = [];
  var currentLines = [headerLine];
  var currentCount = 0;
  var totalRows    = 0;
  var _startTime   = Date.now();

  function flushSegment() {
    fileSegments.push(currentLines.join('\n'));
    currentLines = [headerLine];
    currentCount = 0;
  }

  function buildRefRow(base, ref) {
    var row = Object.assign({}, base);
    if (ref) {
      Object.keys(ref).forEach(function(k) {
        row[k.startsWith('sd_') ? k : ('_ref_' + k)] = ref[k];
      });
      columnDefs.forEach(function(col) {
        if (col.source === 'reference') {
          if      (col.key === 'year')     row.year     = getRefYear(ref);
          else if (col.key === 'sentence') row.sentence = ref.msrc || '';
          else                             row[col.key] = ref[col.dbField] != null ? String(ref[col.dbField]) : '';
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
  }

  // Main loop: one edge batch at a time
  for (var batchStart = 0; batchStart < qEdges.length; batchStart += EDGE_BATCH) {
    var batchEdges = qEdges.slice(batchStart, batchStart + EDGE_BATCH);
    var doneEdges  = Math.min(batchStart + EDGE_BATCH, qEdges.length);
    var _elapsed   = (Date.now() - _startTime) / 1000;
    var _eta       = batchStart > 0 ? formatEta(_elapsed / doneEdges * (qEdges.length - doneEdges)) : '';

    // Collect relIds for this batch only
    var batchRelIds = [];
    batchEdges.forEach(function(e) {
      if (Array.isArray(e.properties.RelationIDs))
        e.properties.RelationIDs.forEach(function(id) { if (id != null) batchRelIds.push(String(id)); });
      else if (e.properties.RelationID != null)
        batchRelIds.push(String(e.properties.RelationID));
    });

    setProgressMsg('⏳ Fetching references… (' + (batchStart + 1).toLocaleString() + '–' + doneEdges.toLocaleString() +
                   ' / ' + qEdges.length.toLocaleString() + ' relations' + (_eta ? '  ·  ~' + _eta + ' left' : '') + ')');
    await yieldToUI();

    // Fetch refs for this batch — 10 parallel PG workers
    var refsGrouped = {};
    if (batchRelIds.length > 0) {
      var batchChunks = [];
      for (var _ci = 0; _ci < batchRelIds.length; _ci += REF_CHUNK)
        batchChunks.push(batchRelIds.slice(_ci, _ci + REF_CHUNK));

      var _qIdx = 0;
      var _batchWorker = async function() {
        while (_qIdx < batchChunks.length) {
          var _i = _qIdx++;
          try {
            var _part = await api('/api/references/batch', { relationIds: batchChunks[_i], scopusColumns: scopusCols });
            Object.assign(refsGrouped, _part);
          } catch(e) {
            if (scopusCols.length > 0) {
              try {
                var _p2 = await api('/api/references/batch', { relationIds: batchChunks[_i], scopusColumns: [] });
                Object.assign(refsGrouped, _p2);
              } catch(e2) {}
            }
          }
        }
      };
      var _workers = [];
      for (var _w = 0; _w < Math.min(CONCURRENCY, batchChunks.length); _w++) _workers.push(_batchWorker());
      await Promise.all(_workers);
    }

    // Convert this batch's edges directly to CSV lines — no intermediate rows array
    batchEdges.forEach(function(edge) {
      var srcNode   = nodeById[edge.startNodeId];
      var tgtNode   = nodeById[edge.endNodeId];
      var relId     = edge.properties.RelationID != null ? String(edge.properties.RelationID) : '';
      var relIdsArr = Array.isArray(edge.properties.RelationIDs)
                    ? edge.properties.RelationIDs : (relId ? [relId] : []);

      var refs = [];
      for (var ri = 0; ri < relIdsArr.length; ri++) {
        var _r = refsGrouped[String(relIdsArr[ri])];
        if (_r && _r.length) { refs = _r; break; }
      }

      var base = {
        edgeId: edge.id, elementId: edge.elementId || edge.id,
        relId:         relIdsArr.join(', ') || relId,
        regulator:     nodeLabel(srcNode),    regulatorMedScan: nodeMedScan(srcNode),
        regulatorType: (srcNode && srcNode.labels && srcNode.labels[0]) || '',
        target:        nodeLabel(tgtNode),    targetMedScan:    nodeMedScan(tgtNode),
        targetType:    (tgtNode && tgtNode.labels && tgtNode.labels[0]) || '',
        relationType:  edge.type,
        effect:        normEffectDisplay(edge.properties.Effect || edge.properties.effect || ''),
        numRefs:       edge.properties.RelationNumberOfReferences  || 0,
        numSentences:  edge.properties.RelationNumberOfSentences   || 0,
      };

      function writeEdge(ref) {
        currentLines.push(buildCsvLine(buildRefRow(base, ref), visCols));
        currentCount++;
        totalRows++;
        if (currentCount >= MAX_CSV_ROWS) flushSegment();
      }

      if (refs.length === 0) writeEdge(null);
      else refs.forEach(function(ref) { writeEdge(ref); });
    });

    // Discard this batch's refs — frees memory before next batch
    refsGrouped = null;
  }

  // Flush any remaining lines into the last file segment
  if (currentLines.length > 1 || fileSegments.length === 0) flushSegment();

  setProgressMsg('⏳ Generating download… (' + totalRows.toLocaleString() + ' rows' +
                 (fileSegments.length > 1 ? ', ' + fileSegments.length + ' files' : '') + ')');
  await yieldToUI();

  if (fileSegments.length === 1) {
    // Single file — download directly as CSV, no zip overhead
    downloadTextFile(fileSegments[0], 'query-references.csv');
  } else {
    // Multiple files — zip them
    if (typeof JSZip === 'undefined') {
      alert('JSZip library not loaded. Cannot create multi-file archive.');
      setProgressMsg(null);
      return;
    }
    var zip = new JSZip();
    fileSegments.forEach(function(seg, idx) {
      zip.file('query-references-part' + (idx + 1) + '.csv', seg);
    });
    setProgressMsg('⏳ Compressing ' + fileSegments.length + ' files…');
    await yieldToUI();
    var zipBuf = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
    downloadBuffer(zipBuf, 'query-references.zip');
  }

  setProgressMsg(null);
}

// ─── CSV export — Relations mode ──────────────────────────────────────────────
// Uses /api/export/csv-query (Neo4j fetchSize 50 000). No PG calls needed —
// all relation data comes directly from Neo4j edge properties.
async function exportQueryCSVRelations(query) {
  setProgressMsg('⏳ Fetching relations from database…');
  var qData;
  try { qData = await api('/api/export/csv-query', { query }); }
  catch (err) { setProgressMsg(null); alert('Query error: ' + err.message); return; }

  var qNodes = qData.nodes || [];
  var qEdges = qData.edges || [];

  var nodeById = {};
  qNodes.forEach(function(n) {
    nodeById[n.id] = n;
    if (n.properties && n.properties.URN) nodeById[n.properties.URN] = n;
  });

  var medScan = {};
  var nodeIds = qNodes
    .map(function(n) { return n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null; })
    .filter(Boolean);
  if (nodeIds.length > 0) {
    try { Object.assign(medScan, await api('/api/nodes/medscan', { nodeIds })); }
    catch(e) { console.warn('MedScan lookup failed:', e.message); }
  }

  function nodeLabel(node)   { return node ? getNodeLabel(node) : '?'; }
  function nodeMedScan(node) {
    if (!node || !node.properties) return '';
    var nid = node.properties.NodeID != null ? String(node.properties.NodeID) : null;
    return (nid && medScan[nid]) ? medScan[nid] : '';
  }

  // Ensure NEO4J_PROP_DEFS columns are registered (mirrors exportQueryRelations)
  var existingNeo4j = {};
  columnDefs.forEach(function(c) { if (c.source === 'neo4j') existingNeo4j[c.dbField] = c; });
  NEO4J_PROP_DEFS.forEach(function(def) {
    if (!existingNeo4j[def.prop]) {
      var nc = { key: 'neo4j_' + def.prop, label: def.label, visible: false, source: 'neo4j', dbField: def.prop };
      columnDefs.push(nc); existingNeo4j[def.prop] = nc;
    }
  });

  setProgressMsg('⏳ Building rows…');
  await yieldToUI();

  var rows = qEdges.map(function(edge) {
    var srcNode   = nodeById[edge.startNodeId];
    var tgtNode   = nodeById[edge.endNodeId];
    var relId     = edge.properties.RelationID != null ? String(edge.properties.RelationID) : '';
    var relIdsArr = Array.isArray(edge.properties.RelationIDs)
                  ? edge.properties.RelationIDs : (relId ? [relId] : []);
    var row = {
      edgeId: edge.id, elementId: edge.elementId || edge.id,
      relId:         relIdsArr.length > 1 ? relIdsArr.join(', ') : relId,
      regulator:     nodeLabel(srcNode),    regulatorMedScan: nodeMedScan(srcNode),
      regulatorType: (srcNode && srcNode.labels && srcNode.labels[0]) || '',
      target:        nodeLabel(tgtNode),    targetMedScan:    nodeMedScan(tgtNode),
      targetType:    (tgtNode && tgtNode.labels && tgtNode.labels[0]) || '',
      relationType:  edge.type,
      effect:        normEffectDisplay(edge.properties.Effect || edge.properties.effect || ''),
      numRefs:       edge.properties.RelationNumberOfReferences  || 0,
      numSentences:  edge.properties.RelationNumberOfSentences   || '',
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

  await writeRowsToCSV(rows, true, 'query-relations');
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
    var scopusCols = columnDefs.filter(function(c) { return c.source === 'scopus_data' && c.visible; }).map(function(c) { return c.dbField; });
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

  if (rows.length === 0) {
    alert('No data to export — the query returned no edges or references.');
    setProgressMsg(null); return;
  }

  var EXCEL_MAX  = 20000;
  var _parts     = Math.max(1, Math.ceil(rows.length / EXCEL_MAX));
  var _plain     = _parts > 1;

  // Entry Point 2: intercept if result exceeds 20 000 rows
  if (_parts > 1) {
    setProgressMsg(null);
    var _choice = await showLargeExportModal(_parts, rows.length);
    if (!_choice) return;  // Cancel

    if (_choice === 'csv') {
      // Path B: write all rows as tab-delimited CSV (no markup strip)
      await writeRowsToCSV(rows, false, 'query-references');
      return;
    }
    // Path A: fall through to split-Excel logic below
  }

  if (typeof ExcelJS === 'undefined') {
    alert('ExcelJS library not loaded. Please check your internet connection.');
    setProgressMsg(null); return;
  }

  // Build Excel files one at a time (sequential) and add directly to the zip.
  // This avoids holding multiple large Excel buffers in memory simultaneously,
  // which caused silent failures for exports > ~60 k rows on most browsers.
  var _note  = _plain ? ' · plain text' : '';
  var _fnames = [];
  for (var _fi = 0; _fi < _parts; _fi++)
    _fnames.push('query-references-part' + (_fi + 1) + '.xlsx');

  if (_parts === 1) {
    // Single file — no zip needed.
    setProgressMsg('⏳ Building Excel… (' + rows.length + ' rows' + _note + ')');
    await yieldToUI();
    try {
      var _buf = await buildExcelBuffer(rows.slice(0, EXCEL_MAX), false, _plain);
      setProgressMsg('⏳ Downloading…');
      await yieldToUI();
      downloadBuffer(_buf, 'query-references.xlsx');
    } catch(e) {
      console.error('[Export] buildExcelBuffer failed:', e);
      setProgressMsg(null);
      alert('Excel export failed: ' + e.message + '\n\nTry CSV format — it uses much less memory.');
      return;
    }
  } else {
    var _zip = new JSZip();
    var _genStart = Date.now();
    for (var _pi = 0; _pi < _parts; _pi++) {
      var _elapsed = (Date.now() - _genStart) / 1000;
      var _eta     = (_pi > 0) ? formatEta(_elapsed / _pi * (_parts - _pi)) : '';
      setProgressMsg('⏳ Building Excel ' + (_pi + 1) + ' / ' + _parts + _note +
                     (_eta ? '  ·  ~' + _eta + ' left' : '') + '…');
      await yieldToUI();
      try {
        var _slice = rows.slice(_pi * EXCEL_MAX, (_pi + 1) * EXCEL_MAX);
        var _buf   = await buildExcelBuffer(_slice, false, _plain);
        _zip.file(_fnames[_pi], _buf);
      } catch(e) {
        console.error('[Export] buildExcelBuffer failed for part', _pi + 1, ':', e);
        setProgressMsg(null);
        alert('Excel export failed at part ' + (_pi + 1) + ' of ' + _parts + ': ' + e.message +
              '\n\nTip: "Convert to CSV" uses much less memory for large exports.');
        return;
      }
    }
    setProgressMsg('⏳ Zipping ' + _parts + ' files…');
    await yieldToUI();
    try {
      var _zipBuf = await _zip.generateAsync({ type: 'arraybuffer',
                                               compression: 'DEFLATE',
                                               compressionOptions: { level: 1 } });
      downloadBuffer(_zipBuf, 'query-references.zip');
    } catch(e) {
      console.error('[Export] zip.generateAsync failed:', e);
      setProgressMsg(null);
      alert('Zip generation failed: ' + e.message + '\n\nTry CSV format instead.');
      return;
    }
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

  if (rows.length === 0) {
    alert('No data to export — the query returned no edges.');
    setProgressMsg(null); return;
  }

  var EXCEL_MAX = 20000;

  // Entry Point 2: intercept if result exceeds 20 000 rows
  if (rows.length > EXCEL_MAX) {
    var _warnParts = Math.ceil(rows.length / EXCEL_MAX);
    setProgressMsg(null);
    var _choice = await showLargeExportModal(_warnParts, rows.length);
    if (!_choice) return;  // Cancel

    if (_choice === 'csv') {
      // Path B: write all rows as tab-delimited CSV
      await writeRowsToCSV(rows, true, 'query-relations');
      return;
    }

    // Path A: split into 20k-row Excel files, bundle into zip (plain text, no colours).
    // Sequential generation — one file at a time, added directly to zip — avoids
    // holding multiple large buffers in memory simultaneously.
    if (typeof ExcelJS === 'undefined') {
      alert('ExcelJS library not loaded. Please check your internet connection.');
      setProgressMsg(null); return;
    }

    var _parts    = _warnParts;
    var _zip      = new JSZip();
    var _rStart   = Date.now();
    for (var _pi = 0; _pi < _parts; _pi++) {
      var _el  = (Date.now() - _rStart) / 1000;
      var _eta = (_pi > 0) ? formatEta(_el / _pi * (_parts - _pi)) : '';
      setProgressMsg('⏳ Building Excel ' + (_pi + 1) + ' / ' + _parts + ' · plain text' +
                     (_eta ? '  ·  ~' + _eta + ' left' : '') + '…');
      await yieldToUI();
      try {
        var _slice = rows.slice(_pi * EXCEL_MAX, (_pi + 1) * EXCEL_MAX);
        var _buf   = await buildExcelBuffer(_slice, true, true /* plainText */);
        console.log('[Export-Relations] Part', _pi + 1, 'built:', (_buf.byteLength || _buf.length), 'bytes');
        _zip.file('query-relations-part' + (_pi + 1) + '.xlsx', _buf);
      } catch(e) {
        console.error('[Export-Relations] buildExcelBuffer failed for part', _pi + 1, ':', e);
        setProgressMsg(null);
        alert('Excel export failed at part ' + (_pi + 1) + ' of ' + _parts + ': ' + e.message +
              '\n\nTip: "Convert to CSV" uses much less memory for large exports.');
        return;
      }
    }
    setProgressMsg('⏳ Zipping ' + _parts + ' files…');
    await yieldToUI();
    try {
      var _zipBuf = await _zip.generateAsync({ type: 'arraybuffer',
                                               compression: 'DEFLATE',
                                               compressionOptions: { level: 1 } });
      console.log('[Export-Relations] Zip generated:', _zipBuf.byteLength, 'bytes,', _parts, 'files');
      downloadBuffer(_zipBuf, 'query-relations.zip');
    } catch(e) {
      console.error('[Export-Relations] zip.generateAsync failed:', e);
      setProgressMsg(null);
      alert('Zip generation failed: ' + e.message + '\n\nTry CSV format instead.');
      return;
    }
    setProgressMsg(null);
    return;
  }

  // ≤ 20 000 rows: single Excel file, no warning needed
  setProgressMsg('⏳ Formatting Excel… (' + rows.length + ' rows)');
  await yieldToUI();
  await writeRowsToExcel(rows, true, 'query-relations.xlsx', false);
  setProgressMsg(null);
}


// Pending query stored when large-query intercept modal fires
var _largeQueryPending = null;

function closeLargeQueryModal() {
  _largeQueryPending = null;
  document.getElementById('large-query-modal').style.display = 'none';
}

// Reads the two dropdowns and dispatches to the appropriate export function.
async function largeQueryExport() {
  var query  = _largeQueryPending;
  closeLargeQueryModal();
  if (!query) return;

  var scope  = (document.getElementById('lq-scope-sel')  || {}).value || 'references';
  var format = (document.getElementById('lq-format-sel') || {}).value || 'excel';

  if (format === 'csv') {
    if (scope === 'relations') await exportQueryCSVRelations(query);
    else                       await exportQueryCSVReferences(query);
  } else {
    if (scope === 'relations') await exportQueryRelations(query);
    else                       await exportQueryReferences(query);
  }
}

// ─── Large Export Warning modal ───────────────────────────────────────────────
// Shown when an Excel export exceeds 20 000 rows (entry point 2 per spec).
// The modal is driven by a Promise so async export functions can await the choice.

var _largeExportResolve = null; // set while the modal is open

function showLargeExportModal(parts, rowCount) {
  var msg = 'Row count exceeds the 20,000 limit. Text coloring is disabled due to performance ' +
    'limits. The export will be split into ' + parts.toLocaleString() + ' file' +
    (parts > 1 ? 's' : '') + ' (' + rowCount.toLocaleString() + ' rows total). ' +
    'Choose how you would like to proceed:';
  document.getElementById('large-export-msg').textContent = msg;
  document.getElementById('large-export-modal').style.display = 'flex';
  return new Promise(function(resolve) { _largeExportResolve = resolve; });
}

function closeLargeExportModal() {
  document.getElementById('large-export-modal').style.display = 'none';
  if (_largeExportResolve) { _largeExportResolve(null);    _largeExportResolve = null; }
}

function confirmLargeExportSplit() {
  document.getElementById('large-export-modal').style.display = 'none';
  if (_largeExportResolve) { _largeExportResolve('split'); _largeExportResolve = null; }
}

function confirmLargeExportCSV() {
  document.getElementById('large-export-modal').style.display = 'none';
  if (_largeExportResolve) { _largeExportResolve('csv');   _largeExportResolve = null; }
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
      appendCypherHistory(query, _edgeCount);
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

// ─── Cypher history ────────────────────────────────────────────────────────────
function appendCypherHistory(query, count) {
  // Fire-and-forget — never blocks the UI
  api('/api/cypher/history', { query: query, count: count }).catch(function() {});
}

async function openCypherHistory() {
  var modal  = document.getElementById('cypher-history-modal');
  var tbody  = document.getElementById('cypher-history-tbody');
  var status = document.getElementById('cypher-history-status');
  tbody.innerHTML = '';
  status.textContent = 'Loading…';
  modal.style.display = 'flex';
  try {
    var data = await api('/api/cypher/history');
    var rows = (data.rows || []).slice().reverse(); // newest first
    status.textContent = '';
    if (!rows.length) { status.textContent = 'No history yet.'; return; }
    rows.forEach(function(r) {
      var tr = document.createElement('tr');
      var dt = '';
      try { dt = new Date(r.date).toLocaleString(); } catch(e) { dt = r.date; }

      // Date
      var tdDate = document.createElement('td');
      tdDate.textContent = dt;
      tdDate.style.cssText = 'white-space:nowrap;padding:5px 10px;border-bottom:1px solid #2a3050;color:#a0aec0;font-size:12px;vertical-align:top';

      // Result count
      var tdCount = document.createElement('td');
      tdCount.textContent = (typeof r.count === 'number' ? r.count.toLocaleString() : r.count);
      tdCount.style.cssText = 'white-space:nowrap;padding:5px 10px;border-bottom:1px solid #2a3050;text-align:right;color:#7ee8a2;font-size:12px;vertical-align:top';

      // Query text — clicking loads into Graph editor (default)
      var tdQuery = document.createElement('td');
      tdQuery.textContent = r.query;
      tdQuery.style.cssText = 'padding:5px 10px;border-bottom:1px solid #2a3050;font-family:monospace;font-size:12px;word-break:break-all;cursor:pointer;color:#e2e8f0;vertical-align:top';
      tdQuery.title = 'Click to open in Graph editor';
      tdQuery.addEventListener('click', function() {
        var ta = document.getElementById('cypher-input');
        if (ta) { ta.value = r.query; onCypherInput(ta); focusCypherInput(); }
        document.getElementById('cypher-history-modal').style.display = 'none';
      });

      // "Open in" dropdown
      var tdOpen = document.createElement('td');
      tdOpen.style.cssText = 'white-space:nowrap;padding:5px 10px;border-bottom:1px solid #2a3050;text-align:center;vertical-align:top';

      var sel = document.createElement('select');
      sel.style.cssText = 'background:#1a1f35;border:1px solid #3a4060;border-radius:5px;color:#c8d0e8;font-size:12px;padding:3px 8px;cursor:pointer;outline:none';
      [['graph','📊 Graph'], ['sankey','🔀 Sankey']].forEach(function(opt) {
        var o = document.createElement('option');
        o.value = opt[0]; o.textContent = opt[1];
        sel.appendChild(o);
      });

      sel.addEventListener('change', function() {
        var dest = sel.value;
        document.getElementById('cypher-history-modal').style.display = 'none';
        if (dest === 'sankey') {
          // Open Sankey dialog and populate its textarea
          var sankeyTa = document.getElementById('sankey-cypher');
          if (sankeyTa) {
            openSankeyDialog();
            sankeyTa.value = r.query;
            onSankeyCypherInput(sankeyTa);
          }
        } else {
          // Default: load into Graph Cypher editor
          var ta = document.getElementById('cypher-input');
          if (ta) { ta.value = r.query; onCypherInput(ta); focusCypherInput(); }
        }
        // Reset dropdown so it can be triggered again for the same option
        setTimeout(function() { sel.value = 'graph'; }, 300);
      });

      tdOpen.appendChild(sel);

      tr.appendChild(tdDate);
      tr.appendChild(tdCount);
      tr.appendChild(tdQuery);
      tr.appendChild(tdOpen);
      tbody.appendChild(tr);
    });
  } catch(e) {
    status.textContent = 'Error loading history: ' + e.message;
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
  _restoreMatchStatus();
  document.getElementById('legend-items').innerHTML = '';
  updateCurrentTabName('New Tab');
  updateSelectionInfo();
}

// ─── Stats & Legend ───────────────────────────────────────────────────────────

// Re-append the "Matching relations…" span if a match is still running.
// Call this after any write to #graph-stats so the status is never lost.
var _simSpan = null;  // active "Searching for similar relations…" span element

function _restoreMatchStatus() {
  var statsEl = document.getElementById('graph-stats');
  if (!statsEl) return;
  // Restore RNEF match span
  if (matchingInProgress && !document.getElementById('match-rnef-status')) {
    statsEl.insertAdjacentHTML('beforeend',
      ' <span id="match-rnef-status" style="color:#4caf50;font-size:11px">· Matching relations…</span>');
  }
  // Restore similar-search span (preserves its current text/colour)
  if (_simSpan && !_simSpan.parentNode) {
    statsEl.appendChild(_simSpan);
  }
}

function updateStats() {
  var n = cy.nodes().length;
  var e = cy.edges().length;
  var namePrefix = currentSubgraphName
    ? '<span style="font-weight:600;margin-right:6px">' + escHtml(currentSubgraphName) + '</span>&nbsp;·&nbsp;'
    : '';
  document.getElementById('graph-stats').innerHTML =
    namePrefix + n + ' node' + (n !== 1 ? 's' : '') + ' · ' + e + ' relation' + (e !== 1 ? 's' : '');
  _restoreMatchStatus();
}

function updateSelectionInfo() {
  if (!cy) return;
  var selNodes = cy.nodes(':selected').length;
  var selEdges = cy.edges(':selected').length;
  if (selNodes === 0 && selEdges === 0) {
    updateStats();
    rcUpdateMenuState(0, 0);
    return;
  }
  var parts = [];
  if (selNodes > 0) parts.push(selNodes + ' node' + (selNodes !== 1 ? 's' : '') + ' selected');
  if (selEdges > 0) parts.push(selEdges + ' relation' + (selEdges !== 1 ? 's' : '') + ' selected');
  document.getElementById('graph-stats').textContent = parts.join(' · ');
  _restoreMatchStatus();
  rcUpdateMenuState(selNodes, selEdges);
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
  _simSpan = simSpan;
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
        setTimeout(function() { if (simSpan.parentNode) simSpan.remove(); _simSpan = null; }, 5000);
      } else {
        simSpan.remove(); _simSpan = null;
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
    _simSpan = null;
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
    'QuantitativeChange': new Set(['Biomarker','Regulation']),
    'StateChange':      new Set(['Biomarker']),
    'FunctionalAssociation': new Set(['Biomarker','Regulation','DirectRegulation','ProtModification','MolTransport','MolSynthesis']),
    'MolSynthesis':     new Set(['Regulation','FunctionalAssociation']),
    'MolTransport':     new Set(['Regulation','FunctionalAssociation']),
    'PromoterBinding':  new Set(['Expression','Regulation']),
    'Expression':       new Set(['PromoterBinding']),
    'Regulation':       new Set(['DirectRegulation','FunctionalAssociation','PromoterBinding','MolSynthesis','MolTransport','ProtModification','QuantitativeChange']),
  };

  // ── Anchor class precedence (FRD 3.2): higher = preferred anchor ─────────────
  var CLASS_SCORE = {
    'DirectRegulation': 6, 'PromoterBinding': 6,
    'ProtModification': 5,
    'Binding': 4,
    'Biomarker': 3,
    'MolTransport': 1, 'MolSynthesis': 1, 'Expression': 1,
    'QuantitativeChange': 0, 'StateChange': 0,
    'Regulation': -1, 'FunctionalAssociation': -2,
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

  for (var group of Object.values(groups)) {
    if (group.length < 2) continue;

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

    // FRD 4.1 (mechanism): if anchor has no mechanism, take from the non-anchor with most refs
    var resolvedMechanism = anchor.mechanism;
    if (!resolvedMechanism) {
      var withMech = others.filter(function(e) { return e.mechanism; });
      if (withMech.length) {
        withMech.sort(function(a, b) { return b.numRefs - a.numRefs; });
        resolvedMechanism = withMech[0].mechanism;
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
    if (resolvedMechanism !== anchor.mechanism) {
      anchor.cyEdge.data('mechanism', resolvedMechanism);
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
      if (resolvedMechanism !== anchor.mechanism) {
        anchorGEdge.properties.Mechanism = resolvedMechanism;
        anchorGEdge.properties.mechanism = resolvedMechanism;
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
        // Exception: when the anchor is strictly superior (higher class score), the
        // inferior edge must always be removed regardless of clone positioning.
        var anchorScore = CLASS_SCORE[anchor.relType] !== undefined ? CLASS_SCORE[anchor.relType] : 0;
        var eScore      = CLASS_SCORE[e.relType]      !== undefined ? CLASS_SCORE[e.relType]      : 0;
        if (anchorScore === eScore) {
          var anchorHasClone = cloneEndpointCount(anchor) > 0;
          var eHasClone      = cloneEndpointCount(e)      > 0;
          if (anchorHasClone !== eHasClone) {
            console.log('[MERGE-DEBUG] KEEP (clone vs original split): skipping removal of', e.id.slice(0,60));
            return; // keep this RNEF edge — different endpoint type than anchor
          }
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

    // ── Recompute RelationID via myhash when effect/mechanism was resolved or RelationID is missing ──
    var needsRelIdUpdate = resolvedEffect !== anchor.effect || resolvedMechanism !== anchor.mechanism || !anchor.relId;
    if (needsRelIdUpdate) {
      var anchorSrcCyId = anchor.cyEdge.data('source');
      var anchorTgtCyId = anchor.cyEdge.data('target');
      var anchorSrcNodeId = cy.$id(anchorSrcCyId).data('NodeID');
      var anchorTgtNodeId = cy.$id(anchorTgtCyId).data('NodeID');
      if (anchorSrcNodeId && anchorTgtNodeId) {
        try {
          var ridResult = await api('/api/curation/calculate-relation-id', {
            inref:        [String(anchorSrcNodeId)],
            outref:       [String(anchorTgtNodeId)],
            inoutref:     [],
            control_type: anchor.relType,
            ontology:     '',
            relationship: '',
            effect:       resolvedEffect || '',
            mechanism:    resolvedMechanism || ''
          });
          if (ridResult && ridResult.relationId) {
            var newRelId = ridResult.relationId;
            anchor.cyEdge.data('relId', newRelId);
            if (anchorGEdge) {
              anchorGEdge.properties.RelationID = newRelId;
              // Update refsCache under the new RelationID as well
              refsCache[newRelId] = dedupedRefs;
              uniqueGroupRelIds = uniqueGroupRelIds.filter(function(id) { return id !== anchor.relId; });
              if (!uniqueGroupRelIds.includes(newRelId)) uniqueGroupRelIds.unshift(newRelId);
              if (uniqueGroupRelIds.length > 1) {
                anchor.cyEdge.data('relIds', uniqueGroupRelIds);
                anchorGEdge.properties.RelationIDs = uniqueGroupRelIds;
              }
            }
            console.log('[MERGE-DEBUG] RelationID recomputed:', newRelId, '(effect:', resolvedEffect, ')');
          }
        } catch(e) {
          console.warn('[MERGE-DEBUG] RelationID recompute failed:', e.message);
        }
      }
    }

    mergedGroupCount++;
  }

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
    showAlignHint('Please select at least one node to perform an expansion.');
    return;
  }

  var urns = [];
  selectedNodes.forEach(function(n) {
    var urn = n.data('URN') || n.data('urn') || '';
    if (urn) urns.push(urn);
  });
  if (!urns.length) {
    showAlignHint('Selected nodes have no URN — cannot expand.');
    return;
  }

  if (mode === 'to') {
    showExpandToDialog();
    return;
  }

  await _doExpand(mode, null, urns);
}

// ─── Find ontology children (is_a hierarchy) ─────────────────────────────────
// For each selected node, queries Neo4j for all nodes that reach it via
// (child)-[:is_a*]->(parent), then merges results into the graph.
async function findOntologyChildren() {
  if (!cy || !graphData) { alert('No pathway loaded.'); return; }

  var selectedNodes = cy.nodes(':selected').not('[?isClone]');
  if (selectedNodes.length === 0) {
    showAlignHint('Please select at least one node to find ontology children.');
    return;
  }

  var nodeParams = [];
  selectedNodes.forEach(function(n) {
    var urn   = n.data('URN') || n.data('urn') || '';
    var label = n.data('nodeType') || '';
    if (urn && label) nodeParams.push({ label: label, urn: urn });
  });
  if (!nodeParams.length) {
    showAlignHint('Selected nodes have no URN or label — cannot query ontology children.');
    return;
  }

  setProgressMsg('⏳ Finding ontology children…');
  try {
    var result = await api('/api/graph/ontology-children', { nodeParams: nodeParams });
    setProgressMsg(null);

    if (result.error) { alert('Ontology children error: ' + result.error); return; }

    var newNodes = result.nodes || [];
    var newEdges = result.edges || [];

    if (!newNodes.length && !newEdges.length) {
      alert('No ontology children found for the selected node' + (nodeParams.length > 1 ? 's' : '') + '.');
      return;
    }

    var nodeWord = newNodes.length === 1 ? 'node' : 'nodes';
    var edgeWord = newEdges.length === 1 ? 'is_a relation' : 'is_a relations';
    var summary  = 'Will add ' + newNodes.length + ' ' + nodeWord +
                   ' and ' + newEdges.length + ' ' + edgeWord + '.';

    _expandPending = { nodes: newNodes, edges: newEdges };
    document.getElementById('expand-confirm-msg').textContent = summary;
    document.getElementById('expand-confirm-modal').style.display = 'flex';

  } catch(err) {
    setProgressMsg(null);
    alert('Ontology children query failed: ' + (err.message || err));
  }
}

// ─── Find ontology parents (is_a hierarchy) ──────────────────────────────────
// For each selected node, queries Neo4j for all nodes reachable via
// (p)<-[:is_a*]-(parent), then merges results into the graph.
async function findOntologyParents() {
  if (!cy || !graphData) { alert('No pathway loaded.'); return; }

  var selectedNodes = cy.nodes(':selected').not('[?isClone]');
  if (selectedNodes.length === 0) {
    showAlignHint('Please select at least one node to find ontology parents.');
    return;
  }

  var nodeParams = [];
  selectedNodes.forEach(function(n) {
    var urn   = n.data('URN') || n.data('urn') || '';
    var label = n.data('nodeType') || '';
    if (urn && label) nodeParams.push({ label: label, urn: urn });
  });
  if (!nodeParams.length) {
    showAlignHint('Selected nodes have no URN or label — cannot query ontology parents.');
    return;
  }

  setProgressMsg('⏳ Finding ontology parents…');
  try {
    var result = await api('/api/graph/ontology-parents', { nodeParams: nodeParams });
    setProgressMsg(null);

    if (result.error) { alert('Ontology parents error: ' + result.error); return; }

    var newNodes = result.nodes || [];
    var newEdges = result.edges || [];

    if (!newNodes.length && !newEdges.length) {
      alert('No ontology parents found for the selected node' + (nodeParams.length > 1 ? 's' : '') + '.');
      return;
    }

    var nodeWord = newNodes.length === 1 ? 'node' : 'nodes';
    var edgeWord = newEdges.length === 1 ? 'is_a relation' : 'is_a relations';
    var summary  = 'Will add ' + newNodes.length + ' ' + nodeWord +
                   ' and ' + newEdges.length + ' ' + edgeWord + '.';

    _expandPending = { nodes: newNodes, edges: newEdges };
    document.getElementById('expand-confirm-msg').textContent = summary;
    document.getElementById('expand-confirm-modal').style.display = 'flex';

  } catch(err) {
    setProgressMsg(null);
    alert('Ontology parents query failed: ' + (err.message || err));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ONTOLOGY ANALYSIS  (Database → Ontology → Ontology analysis)
// ═══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
// Each tree node: { id, name, urn, labels, graphCount, children, expanded, loading }
// graphCount: null = not yet fetched, number = count, '?' = fetch failed
var _ontologyTree        = [];
var _ontologyLayout      = 'hierarchical';  // 'hierarchical' | 'orthogonal'
var _ontologyCtxNode     = null;            // node right-clicked
var _ontologySourceData  = null;  // when set, use this {nodes,edges} instead of cy for URNs & copy

// ── Open / close ──────────────────────────────────────────────────────────────
function openOntologyAnalysisFromSankey() {
  if (!_sankeyCache || !_sankeyCache.nodes) {
    showAlignHint('Run a Sankey query first.');
    return;
  }
  // If a path is selected, restrict to only those nodes/edges
  if (_sankeySelNodeIds && _sankeySelNodeIds.size > 0) {
    _ontologySourceData = {
      nodes: _sankeyCache.nodes.filter(function(n) {
        return _sankeySelNodeIds.has(String(n.id));
      }),
      edges: _sankeyCache.edges.filter(function(e) {
        return _sankeySelEdgeIds && _sankeySelEdgeIds.has(String(
          e.id !== undefined ? e.id : (e.elementId || '')
        ));
      })
    };
  } else {
    _ontologySourceData = _sankeyCache;
  }
  _openOntologyAnalysisDialog();
}

function openOntologyAnalysis() {
  if (!cy || !graphData) {
    showAlignHint('Please open a graph or run a Cypher query first.');
    return;
  }
  _ontologySourceData = null;  // use cy
  _openOntologyAnalysisDialog();
}

function _openOntologyAnalysisDialog() {
  var modal = document.getElementById('ontology-analysis-modal');
  if (!modal) return;

  // Reset state
  _ontologyTree   = [];
  _ontologyLayout = 'hierarchical';
  // Reset radio buttons
  var radios = modal.querySelectorAll('input[name="ontology-layout"]');
  radios.forEach(function(r) { r.checked = r.value === 'hierarchical'; });

  modal.style.display = 'flex';
  _renderOntologyTree();
  _setOntologyStatus('Loading root ontology groups…');
  _loadOntologyRoots();

  // Close context menu on any click outside it
  document.addEventListener('click', _hideOntologyCtxMenu, true);
}

function closeOntologyAnalysis() {
  var modal = document.getElementById('ontology-analysis-modal');
  if (modal) modal.style.display = 'none';
  _hideOntologyCtxMenu();
  document.removeEventListener('click', _hideOntologyCtxMenu, true);
}

function setOntologyLayout(mode) {
  _ontologyLayout = mode;
  _renderOntologyTree();
}

function _setOntologyStatus(msg) {
  var el = document.getElementById('ontology-status-bar');
  if (el) el.textContent = msg || '';
}

// ── Graph URN helpers ─────────────────────────────────────────────────────────
function _getGraphUrns() {
  // When called from Sankey context, read URNs from the source data
  if (_ontologySourceData) {
    var urns = [];
    (_ontologySourceData.nodes || []).forEach(function(n) {
      var u = n.properties && (n.properties.URN || n.properties.urn);
      if (u) urns.push(String(u));
    });
    return urns;
  }
  if (!cy) return [];
  var urns = [];
  cy.nodes().not('[?isClone]').forEach(function(n) {
    var u = n.data('URN') || n.data('urn');
    if (u) urns.push(String(u));
  });
  return urns;
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function _loadOntologyRoots() {
  try {
    var result = await api('/api/ontology/roots');   // GET
    var nodes  = result.nodes || [];
    _ontologyTree = nodes.map(function(n) {
      return { id: n.id, name: n.name, urn: n.urn, labels: n.labels || [],
               graphCount: null, children: null, expanded: false, loading: false };
    });
    _renderOntologyTree();
    _setOntologyStatus(nodes.length + ' root group' + (nodes.length !== 1 ? 's' : '') + ' loaded. Double-click to expand.');
    if (_ontologyTree.length) _fetchGraphCountsBatch(_ontologyTree);
  } catch(e) {
    _setOntologyStatus('Error loading roots: ' + (e.message || e));
  }
}

async function _fetchGraphCountsBatch(treeNodes) {
  var urns = treeNodes.map(function(n) { return n.urn; }).filter(Boolean);
  if (!urns.length) return;
  var graphUrns = _getGraphUrns();
  if (!graphUrns.length) {
    treeNodes.forEach(function(n) { n.graphCount = 0; });
    _renderOntologyTree();
    return;
  }
  try {
    var result = await api('/api/ontology/batch-counts', { urns: urns, graphUrns: graphUrns });
    // Server returns { entries: [{urn, count}] } — convert to a local Map for O(1) lookup
    var counts = new Map();
    (result.entries || []).forEach(function(e) { counts.set(e.urn, e.count); });
    treeNodes.forEach(function(n) {
      n.graphCount = counts.has(n.urn) ? counts.get(n.urn) : 0;
    });
    _renderOntologyTree();
  } catch(e) {
    console.warn('ontology batch-counts failed:', e);
    treeNodes.forEach(function(n) { n.graphCount = '?'; });
    _renderOntologyTree();
  }
}

async function _expandOntologyNode(node) {
  // Toggle collapse if already expanded
  if (node.expanded) {
    node.expanded = false;
    _renderOntologyTree();
    return;
  }
  // Already loaded — just expand
  if (node.children !== null) {
    node.expanded = true;
    _renderOntologyTree();
    return;
  }
  // Fetch children
  node.loading = true;
  _renderOntologyTree();
  try {
    var result = await api('/api/ontology/direct-children', { urn: node.urn });
    node.children = (result.nodes || []).map(function(n) {
      return { id: n.id, name: n.name, urn: n.urn, labels: n.labels || [],
               graphCount: null, children: null, expanded: false, loading: false };
    });
    node.expanded = true;
    node.loading  = false;
    _renderOntologyTree();
    if (node.children.length) {
      _fetchGraphCountsBatch(node.children);
    } else {
      _setOntologyStatus('"' + node.name + '" has no children.');
    }
  } catch(e) {
    node.loading  = false;
    node.children = [];
    _renderOntologyTree();
    showAlignHint('Error loading children: ' + (e.message || e));
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function _renderOntologyTree() {
  var container = document.getElementById('ontology-tree-container');
  if (!container) return;
  if (_ontologyLayout === 'orthogonal') {
    _renderOntologyOrthogonal(container);
  } else {
    _renderOntologyHierarchical(container);
  }
}

// Shared helper: count badge HTML
function _ontoCntBadge(graphCount) {
  if (graphCount === null) return '<span style="color:#3a4060;font-size:10px;margin-left:6px">…</span>';
  if (graphCount === '?')  return '<span style="color:#6a4040;font-size:10px;margin-left:6px">?</span>';
  if (graphCount > 0)
    return '<span style="background:#0e2a4a;color:#4f8ef7;border-radius:10px;padding:1px 8px;font-size:10px;margin-left:6px">'
           + graphCount + '</span>';
  return '<span style="color:#3a4060;font-size:10px;margin-left:6px">0</span>';
}

// ── Hierarchical (indented list) ──────────────────────────────────────────────
function _renderOntologyHierarchical(container) {
  if (!_ontologyTree.length) {
    container.innerHTML = '<div style="color:#5a6080;font-size:12px;padding:24px;text-align:center">Loading…</div>';
    return;
  }

  var rows = [];
  function collect(nodes, level) {
    nodes.forEach(function(node) {
      rows.push({ node: node, level: level });
      if (node.expanded && node.children && node.children.length) collect(node.children, level + 1);
    });
  }
  collect(_ontologyTree, 0);

  var html = rows.map(function(r) {
    var node   = r.node;
    var indent = r.level * 18 + 8;
    var hasKids = node.children === null || (node.children && node.children.length > 0);
    var arrow;
    if (node.loading)        arrow = '<span style="color:#4f8ef7;width:14px;display:inline-block;text-align:center">⋯</span>';
    else if (hasKids)        arrow = '<span style="color:#7a8099;width:14px;display:inline-block;text-align:center;cursor:pointer">' + (node.expanded ? '▼' : '▶') + '</span>';
    else                     arrow = '<span style="color:#2a3555;width:14px;display:inline-block;text-align:center">·</span>';
    var safeUrn = _ontoEscAttr(node.urn);
    return '<div class="onto-row" data-urn="' + safeUrn + '"'
      + ' style="padding:4px 8px 4px ' + indent + 'px;display:flex;align-items:center;gap:5px;'
      + 'border-radius:4px;font-size:12px;color:#c0c8e0;white-space:nowrap;'
      + 'overflow:hidden;user-select:none;cursor:pointer" '
      + 'onmouseenter="this.style.background=\'#151f35\'" onmouseleave="this.style.background=\'\'">'
      + arrow
      + '<span style="overflow:hidden;text-overflow:ellipsis;flex:1" title="' + safeUrn + '">'
      + _ontoEscHtml(node.name) + '</span>'
      + _ontoCntBadge(node.graphCount)
      + '</div>';
  }).join('');

  container.innerHTML = html;

  // Event delegation — double-click to expand, right-click for context menu
  container.ondblclick = function(e) {
    var urn = _ontoUrnFromEvent(e, container);
    if (urn) { var n = _findOntologyNode(urn); if (n) _expandOntologyNode(n); }
  };
  container.oncontextmenu = function(e) {
    e.preventDefault();
    var urn = _ontoUrnFromEvent(e, container);
    if (urn) _showOntologyCtxMenu(e, urn);
  };
}

// ── Orthogonal (SVG horizontal tree) ─────────────────────────────────────────
function _renderOntologyOrthogonal(container) {
  // Collect flat ordered rows first (same traversal as hierarchical)
  var rows = [];
  function collect(nodes, level) {
    nodes.forEach(function(node) {
      var rowIdx = rows.length;
      rows.push({ node: node, level: level, rowIdx: rowIdx });
      if (node.expanded && node.children && node.children.length) collect(node.children, level + 1);
    });
  }
  collect(_ontologyTree, 0);

  if (!rows.length) {
    container.innerHTML = '<div style="color:#5a6080;font-size:12px;padding:24px;text-align:center">Loading…</div>';
    return;
  }

  var NODE_W = 170, NODE_H = 28, COL_W = 200, ROW_H = 36, PAD_X = 10, PAD_Y = 8;
  var urnToRow = {};
  rows.forEach(function(r) {
    r.x = PAD_X + r.level * COL_W;
    r.y = PAD_Y + r.rowIdx * ROW_H;
    urnToRow[r.node.urn] = r;
  });

  var svgW = 0, svgH = 0;
  rows.forEach(function(r) {
    svgW = Math.max(svgW, r.x + NODE_W + PAD_X);
    svgH = Math.max(svgH, r.y + NODE_H + PAD_Y);
  });

  var parts = ['<svg width="' + svgW + '" height="' + svgH
    + '" xmlns="http://www.w3.org/2000/svg" style="display:block;font-family:system-ui,sans-serif">'];

  // Connections first (so nodes render on top)
  rows.forEach(function(r) {
    if (!r.node.expanded || !r.node.children || !r.node.children.length) return;
    var px  = r.x + NODE_W;
    var pcy = r.y + NODE_H / 2;
    var midX = px + (COL_W - NODE_W) / 2;
    r.node.children.forEach(function(child) {
      var cr = urnToRow[child.urn];
      if (!cr) return;
      var ccy = cr.y + NODE_H / 2;
      parts.push('<path d="M' + px + ',' + pcy + ' H' + midX + ' V' + ccy + ' H' + cr.x + '"'
        + ' stroke="#253050" stroke-width="1.5" fill="none" stroke-linejoin="round"/>');
    });
  });

  // Node boxes
  rows.forEach(function(r) {
    var n = r.node;
    var x = r.x, y = r.y;
    var hasCnt = typeof n.graphCount === 'number' && n.graphCount > 0;
    var fill   = hasCnt ? '#0e2035' : '#141c30';
    var stroke = hasCnt ? '#1e4070' : '#252f4a';
    var safeUrn  = _ontoEscAttr(n.urn);
    var safeName = _ontoEscHtml(n.name.length > 19 ? n.name.slice(0, 17) + '…' : n.name);

    // Box
    parts.push('<rect x="' + x + '" y="' + y + '" width="' + NODE_W + '" height="' + NODE_H
      + '" rx="5" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1"/>');

    // Arrow indicator
    var hasKids = n.children === null || (n.children && n.children.length > 0);
    var arrowTxt = n.loading ? '⋯' : (hasKids ? (n.expanded ? '▼' : '▶') : '·');
    parts.push('<text x="' + (x + 10) + '" y="' + (y + NODE_H / 2 + 4)
      + '" font-size="9" fill="#5a6880">' + arrowTxt + '</text>');

    // Name
    parts.push('<text x="' + (x + 22) + '" y="' + (y + NODE_H / 2 + 4)
      + '" font-size="11" fill="#b8c4dc">' + safeName + '</text>');

    // Count badge
    if (hasCnt) {
      var bw = Math.max(24, String(n.graphCount).length * 7 + 10);
      var bx = x + NODE_W - bw - 4;
      parts.push('<rect x="' + bx + '" y="' + (y + 6) + '" width="' + bw + '" height="16" rx="8" fill="#0a2040"/>');
      parts.push('<text x="' + (bx + bw / 2) + '" y="' + (y + 17)
        + '" font-size="9" fill="#4f8ef7" text-anchor="middle">' + n.graphCount + '</text>');
    } else if (n.graphCount === null) {
      parts.push('<text x="' + (x + NODE_W - 12) + '" y="' + (y + NODE_H / 2 + 4)
        + '" font-size="9" fill="#2a3555" text-anchor="middle">…</text>');
    }

    // Transparent hit target with data-urn
    parts.push('<rect x="' + x + '" y="' + y + '" width="' + NODE_W + '" height="' + NODE_H
      + '" rx="5" fill="transparent" data-urn="' + safeUrn + '" style="cursor:pointer"/>');
  });

  parts.push('</svg>');
  container.innerHTML = parts.join('');

  // Event delegation
  container.ondblclick = function(e) {
    var urn = _ontoUrnFromEvent(e, container);
    if (urn) { var n = _findOntologyNode(urn); if (n) _expandOntologyNode(n); }
  };
  container.oncontextmenu = function(e) {
    e.preventDefault();
    var urn = _ontoUrnFromEvent(e, container);
    if (urn) _showOntologyCtxMenu(e, urn);
  };
}

// ── Interaction helpers ───────────────────────────────────────────────────────
function _ontoUrnFromEvent(e, container) {
  var el = e.target;
  while (el && el !== container) {
    var u = el.getAttribute('data-urn');
    if (u) return u;
    el = el.parentElement;
  }
  return null;
}

function _showOntologyCtxMenu(e, urn) {
  _ontologyCtxNode = _findOntologyNode(urn);
  if (!_ontologyCtxNode) return;
  var menu = document.getElementById('ontology-ctx-menu');
  if (!menu) return;
  menu.style.display = 'block';
  var mx = Math.min(e.clientX, window.innerWidth  - menu.offsetWidth  - 8);
  var my = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = mx + 'px';
  menu.style.top  = my + 'px';
}

function _hideOntologyCtxMenu() {
  var menu = document.getElementById('ontology-ctx-menu');
  if (menu) menu.style.display = 'none';
}

function _findOntologyNode(urn, nodes) {
  nodes = nodes || _ontologyTree;
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].urn === urn) return nodes[i];
    if (nodes[i].children && nodes[i].children.length) {
      var found = _findOntologyNode(urn, nodes[i].children);
      if (found) return found;
    }
  }
  return null;
}

function _ontoEscHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _ontoEscAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Context-menu copy actions ─────────────────────────────────────────────────
async function ontologyCtxAction(action) {
  _hideOntologyCtxMenu();
  if (!_ontologyCtxNode || !cy) return;
  var node = _ontologyCtxNode;

  setProgressMsg('⏳ Fetching ontology descendants…');
  try {
    var graphUrns = _getGraphUrns();
    var result = await api('/api/ontology/descendants', { urn: node.urn, graphUrns: graphUrns });
    var descendantUrnSet = new Set((result.urns || []).map(String));
    setProgressMsg(null);

    if (!descendantUrnSet.size) {
      showAlignHint('No graph nodes belong to "' + node.name + '".');
      return;
    }

    if (_ontologySourceData) {
      // ── Sankey context: build clipboard from raw cache data ──────────────
      var srcNodes = (_ontologySourceData.nodes || []).filter(function(n) {
        var u = n.properties && (n.properties.URN || n.properties.urn);
        return u && descendantUrnSet.has(String(u));
      });
      if (!srcNodes.length) {
        showAlignHint('No Sankey nodes found for "' + node.name + '".');
        return;
      }
      var matchedIdSet = new Set(srcNodes.map(function(n) { return String(n.id); }));
      var srcEdges = [];
      if (action === 'copy-neighborhood') {
        // Include neighbors reachable via Sankey edges
        var neighborNodes = [];
        (_ontologySourceData.edges || []).forEach(function(e) {
          var s = String(e.startNodeId), t = String(e.endNodeId);
          if (matchedIdSet.has(s) || matchedIdSet.has(t)) srcEdges.push(e);
          if (matchedIdSet.has(s) && !matchedIdSet.has(t)) {
            var nb = (_ontologySourceData.nodes || []).find(function(n) { return String(n.id) === t; });
            if (nb) neighborNodes.push(nb);
          }
          if (matchedIdSet.has(t) && !matchedIdSet.has(s)) {
            var nb = (_ontologySourceData.nodes || []).find(function(n) { return String(n.id) === s; });
            if (nb) neighborNodes.push(nb);
          }
        });
        // Deduplicate neighbors by ID (same node can be neighbor via multiple edges)
        var seenNeighborIds = new Set();
        neighborNodes.forEach(function(n) {
          var id = String(n.id);
          if (!matchedIdSet.has(id) && !seenNeighborIds.has(id)) {
            seenNeighborIds.add(id);
            srcNodes.push(n);
          }
        });
      } else {
        // copy-children: only internal edges
        (_ontologySourceData.edges || []).forEach(function(e) {
          if (matchedIdSet.has(String(e.startNodeId)) && matchedIdSet.has(String(e.endNodeId)))
            srcEdges.push(e);
        });
      }
      graphClipboard = {
        nodes: srcNodes.map(function(n) {
          return { data: Object.assign({ id: String(n.id), label: getNodeLabel(n),
                     nodeType: (n.labels && n.labels[0]) || 'Unknown',
                     color: getNodeColor(n.labels) }, n.properties),
                   position: { x: 0, y: 0 }, raw: JSON.parse(JSON.stringify(n)) };
        }),
        edges: srcEdges.map(function(e) {
          // Use _buildCyEdgeData so relId, numRefs, effect, mechanism etc. are all
          // set correctly — the tooltip and references system depend on these fields.
          return {
            data: _buildCyEdgeData(e, String(e.startNodeId), String(e.endNodeId)),
            raw:  JSON.parse(JSON.stringify(e))
          };
        })
      };
    } else {
      // ── Graph-view context: use Cytoscape ─────────────────────────────────
      var matchedNodes = cy.nodes().not('[?isClone]').filter(function(n) {
        var u = n.data('URN') || n.data('urn');
        return u && descendantUrnSet.has(String(u));
      });

      if (!matchedNodes.length) {
        showAlignHint('No graph nodes found for "' + node.name + '".');
        return;
      }

      var nodesToCopy, edgesToCopy;
      if (action === 'copy-neighborhood') {
        var neighbors = matchedNodes.neighborhood('node').not('[?isClone]');
        nodesToCopy   = matchedNodes.union(neighbors);
        edgesToCopy   = matchedNodes.edgesWith(neighbors).union(matchedNodes.edgesTo(matchedNodes));
      } else {
        nodesToCopy = matchedNodes;
        edgesToCopy = matchedNodes.edgesTo(matchedNodes);
      }

      var nodeMap = {};
      nodesToCopy.forEach(function(n) { nodeMap[n.id()] = n; });

      graphClipboard = {
        nodes: Object.values(nodeMap).map(function(n) {
          var nUrn  = n.data('URN');
          var gnRaw = graphData.nodes.find(function(gn) {
            return gn.id === n.id() || (nUrn && gn.properties && gn.properties.URN === nUrn);
          });
          return { data: Object.assign({}, n.data()), position: Object.assign({}, n.position()),
                   raw: gnRaw ? JSON.parse(JSON.stringify(gnRaw)) : null };
        }),
        edges: edgesToCopy.map(function(e) {
          var geRaw = graphData.edges.find(function(ge) { return ge.id === e.id(); });
          return { data: Object.assign({}, e.data()),
                   raw: geRaw ? JSON.parse(JSON.stringify(geRaw)) : null };
        })
      };
    }

    // Update paste menu item
    var mi = document.getElementById('mi-paste');
    if (mi) mi.classList.remove('disabled');

    // Status feedback
    var nc = graphClipboard.nodes.length, ec = graphClipboard.edges.length;
    var parts = [];
    if (nc) parts.push(nc + ' node' + (nc !== 1 ? 's' : ''));
    if (ec) parts.push(ec + ' edge' + (ec !== 1 ? 's' : ''));
    var msg = parts.join(' and ') + ' from "' + node.name + '" copied.';
    var statsEl = document.getElementById('graph-stats');
    if (statsEl) statsEl.innerHTML = '<span style="color:#2a9d2a">' + msg + '</span>';
    showAlignHint('✓ ' + msg);

  } catch(e) {
    setProgressMsg(null);
    alert('Copy failed: ' + (e.message || e));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CREATE / EDIT RELATION  (Database → Create/Edit relation)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Menu item state ───────────────────────────────────────────────────────────
// Called from updateSelectionInfo on every select/deselect event.
// Visible only for 'user' role; enabled when 2+ nodes or 1 edge are selected.
function rcUpdateMenuState(selNodes, selEdges) {
  var item = document.getElementById('me-create-relation');
  if (!item) return;
  if (currentRole !== 'user') { item.style.display = 'none'; return; }
  item.style.display = '';
  var enabled = selNodes >= 2 || (selEdges === 1 && selNodes === 0);
  item.style.color         = enabled ? '' : '#3a4060';
  item.style.pointerEvents = enabled ? '' : 'none';
  item.style.cursor        = enabled ? '' : 'default';
}

// ── Dialog open ───────────────────────────────────────────────────────────────
async function openRelationCurationDialog() {
  if (!cy || currentRole !== 'user') return;

  var selNodes = cy.nodes(':selected').not('[?isClone]');
  var selEdges = cy.edges(':selected');

  // Exactly 2 nodes → dedicated pair dialog (ignore any selected edges)
  if (selNodes.length === 2) {
    openPairRelationDialog();
    return;
  }

  // Reset dialog state
  Object.assign(_rc, {
    mode: 'create', nodes: [], props: [], existingEdge: null,
    refs: [], refIdx: 0, refsVisible: false, refsLoaded: false,
    currentRelId: '', _pid: 0
  });

  if (selEdges.length === 1 && selNodes.length === 0) {
    // ── EDIT existing edge ─────────────────────────────────────────────────
    _rc.mode = 'edit';
    var edge = selEdges[0];
    _rc.existingEdge = edge;

    var srcCy = cy.$id(edge.data('source'));
    var tgtCy = cy.$id(edge.data('target'));

    _rc.nodes = [
      { cyId: srcCy.id(), label: srcCy.data('label') || srcCy.id(),
        nodeType: srcCy.data('nodeType') || '', nodeId: srcCy.data('NodeID') || '', direction: '→' },
      { cyId: tgtCy.id(), label: tgtCy.data('label') || tgtCy.id(),
        nodeType: tgtCy.data('nodeType') || '', nodeId: tgtCy.data('NodeID') || '', direction: '←' }
    ];

    // Pre-populate properties from edge data (skip structural/audit fields)
    var EDGE_SKIP = { RelationID:1, RelationIDs:1, RelationNumberOfReferences:1,
                      RelationNumberOfSentences:1, createdAt:1, updatedAt:1,
                      createdBy:1, updatedBy:1, id:1, source:1, target:1,
                      elementId:1, relType:1, relId:1, relIds:1, color:1, label:1 };
    Object.keys(edge.data()).forEach(function(k) {
      if (EDGE_SKIP[k]) return;
      var v = edge.data(k);
      if (v == null || v === '') return;
      _rc.props.push({ id: ++_rc._pid, key: k,
        value: Array.isArray(v) ? v.join(';') : String(v) });
    });

  } else if (selNodes.length >= 2) {
    // ── CREATE new edge ────────────────────────────────────────────────────
    selNodes.forEach(function(n) {
      _rc.nodes.push({
        cyId: n.id(), label: n.data('label') || n.id(),
        nodeType: n.data('nodeType') || '', nodeId: n.data('NodeID') || '',
        direction: '−'
      });
    });
  } else {
    showAlignHint('Select 2+ nodes to create a relation, or 1 edge to edit it.');
    return;
  }

  document.getElementById('rc-title').textContent =
    _rc.mode === 'edit' ? 'Edit Relation' : 'Create/Edit Hyperedge';

  // Show dialog immediately with whatever schema is already cached
  rcRenderNodes();
  rcRenderRelTypeDropdown();
  rcRenderPropKeyDropdown();
  rcRenderProps();
  rcHideRefsPanel();
  document.getElementById('rel-curation-modal').style.display = 'flex';

  // Load schema caches in background and refresh dropdowns when done
  var needSchema = !_rc.relTypes.length || !_rc.propKeys.length || !_rc.refCols.length;
  if (needSchema) {
    (async function() {
      try {
        if (!_rc.relTypes.length || !_rc.propKeys.length) {
          var schema = await api('/api/graph/schema');
          if (!_rc.relTypes.length) { _rc.relTypes = schema.relTypes || []; rcRenderRelTypeDropdown(); }
          if (!_rc.propKeys.length) { _rc.propKeys = schema.propKeys || []; rcRenderPropKeyDropdown(); }
        }
      } catch(e) {}
      try {
        if (!_rc.refCols.length) {
          _rc.refCols = (await api('/api/schema/columns')).referenceColumns || [];
        }
      } catch(e) {}
    })();
  }

  rcScheduleRelIdCalc();
}

function closeRelationCurationDialog() {
  document.getElementById('rel-curation-modal').style.display = 'none';
}

// ── Nodes section ─────────────────────────────────────────────────────────────
function rcRenderNodes() {
  var c = document.getElementById('rc-nodes');
  c.innerHTML = '';
  _rc.nodes.forEach(function(n, idx) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:5px 0;' +
                        'border-bottom:1px solid #1a2040;min-height:32px';
    var tag = n.nodeType
      ? '<span style="font-size:10px;color:#4f8ef7;background:#1a2a50;border-radius:3px;padding:1px 5px;margin-right:5px;flex-shrink:0">' + escHtml(n.nodeType) + '</span>'
      : '';
    row.innerHTML =
      '<div style="flex:1;font-size:13px;color:#c0c4d4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        tag + escHtml(n.label) +
      '</div>' +
      '<select data-idx="' + idx + '" onchange="rcSetDirection(this)" ' +
        'style="background:#0d1117;border:1px solid #3a3f55;border-radius:5px;color:#c0c4d4;padding:4px 8px;font-size:13px;cursor:pointer">' +
        '<option value="→"' + (n.direction === '→' ? ' selected' : '') + '>→  outbound</option>' +
        '<option value="←"' + (n.direction === '←' ? ' selected' : '') + '>←  inbound</option>' +
        '<option value="−"' + (n.direction === '−' ? ' selected' : '') + '>−  none</option>' +
      '</select>';
    c.appendChild(row);
  });
}

function rcSetDirection(sel) {
  _rc.nodes[parseInt(sel.getAttribute('data-idx'))].direction = sel.value;
  rcScheduleRelIdCalc();
}

// ── Relation type dropdown ────────────────────────────────────────────────────
function rcRenderRelTypeDropdown() {
  var sel = document.getElementById('rc-reltype');
  var cur = (_rc.mode === 'edit' && _rc.existingEdge) ? (_rc.existingEdge.data('relType') || '') : '';
  sel.innerHTML = '<option value="">— select type —</option>';
  _rc.relTypes.forEach(function(t) {
    sel.insertAdjacentHTML('beforeend',
      '<option value="' + escHtml(t) + '"' + (t === cur ? ' selected' : '') + '>' + escHtml(t) + '</option>');
  });
}

function rcOnRelTypeChange() { rcScheduleRelIdCalc(); }

// ── Property key dropdown + add ───────────────────────────────────────────────
// ── Property value datalist helper ────────────────────────────────────────────
// Called oninput on the prop-key field. For Effect/Mechanism, populates the
// paired value datalist with known/fetched values so users don't mistype them.
var _propValCache = {};   // cache: propName → [values]

async function rcOnPropKeyInput(keyInput, valListId) {
  var dl = document.getElementById(valListId);
  if (!dl) return;
  var key = keyInput.value.trim();
  var lk  = key.toLowerCase();

  // Clear datalist for unrecognised props
  if (lk !== 'effect' && lk !== 'mechanism') { dl.innerHTML = ''; return; }

  // Use cache if available
  var canonical = lk === 'effect' ? 'Effect' : 'Mechanism';
  if (_propValCache[canonical]) {
    _fillValDatalist(dl, _propValCache[canonical]);
    return;
  }

  // Effect values are fixed — no need to query Neo4j
  if (canonical === 'Effect') {
    _propValCache['Effect'] = ['Positive', 'Negative'];
    _fillValDatalist(dl, _propValCache['Effect']);
    return;
  }

  // Mechanism: fetch distinct values from Neo4j
  try {
    var data = await api('/api/schema/prop-values?prop=Mechanism');
    _propValCache['Mechanism'] = data.values || [];
    _fillValDatalist(dl, _propValCache['Mechanism']);
  } catch(e) { /* leave datalist empty on error */ }
}

function _fillValDatalist(dl, values) {
  dl.innerHTML = '';
  values.forEach(function(v) {
    var opt = document.createElement('option');
    opt.value = v;
    dl.appendChild(opt);
  });
}

function rcRenderPropKeyDropdown() {
  var dl = document.getElementById('rc-prop-key-list');
  if (!dl) return;
  dl.innerHTML = '';
  _rc.propKeys.forEach(function(k) {
    dl.insertAdjacentHTML('beforeend', '<option value="' + escHtml(k) + '">');
  });
}

function rcAddProperty() {
  var keyEl = document.getElementById('rc-prop-key');
  var valEl = document.getElementById('rc-prop-val');
  var key = keyEl.value.trim();
  var val = valEl.value.trim();
  if (!key)  { alert('Please enter a property name.'); return; }
  if (!val)  { alert('Value cannot be empty.');     return; }
  _rc.props.push({ id: ++_rc._pid, key: key, value: val });
  valEl.value = ''; keyEl.value = '';
  rcRenderProps();
  rcScheduleRelIdCalc();
}

function rcDeleteProperty(pid) {
  _rc.props = _rc.props.filter(function(p) { return p.id !== pid; });
  rcRenderProps();
  rcScheduleRelIdCalc();
}

function rcRenderProps() {
  var c = document.getElementById('rc-props');
  if (!_rc.props.length) {
    c.innerHTML = '<div style="font-size:12px;color:#2a3050;font-style:italic;padding:4px 0">No properties added.</div>';
    return;
  }
  c.innerHTML = '';
  _rc.props.forEach(function(p) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 2px;border-bottom:1px solid #1a2040';
    row.innerHTML =
      '<div style="font-size:12px;color:#7a8099;min-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(p.key) + '">' + escHtml(p.key) + '</div>' +
      '<div style="flex:1;font-size:13px;color:#c0c4d4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(String(p.value)) + '">' + escHtml(String(p.value)) + '</div>' +
      '<button onclick="rcDeleteProperty(' + p.id + ')" title="Remove" ' +
        'style="background:none;border:none;color:#8a2020;font-size:17px;cursor:pointer;line-height:1;padding:0 2px;flex-shrink:0">×</button>';
    c.appendChild(row);
  });
}

// ── RelationID live calculation ───────────────────────────────────────────────
function rcScheduleRelIdCalc() {
  if (_rc._debounce) clearTimeout(_rc._debounce);
  _rc._debounce = setTimeout(rcCalcRelId, 380);
}

async function rcCalcRelId() {
  var relType  = document.getElementById('rc-reltype').value;
  var inref = [], outref = [], inoutref = [];
  _rc.nodes.forEach(function(n) {
    if (!n.nodeId) return;
    if      (n.direction === '→') inref.push(n.nodeId);
    else if (n.direction === '←') outref.push(n.nodeId);
    else                          inoutref.push(n.nodeId);
  });

  function getProp(names) {
    for (var i = 0; i < names.length; i++) {
      var p = null;
      for (var j = 0; j < _rc.props.length; j++) {
        if (_rc.props[j].key.toLowerCase() === names[i].toLowerCase()) { p = _rc.props[j]; break; }
      }
      if (p) return p.value;
    }
    return '';
  }

  try {
    var r = await api('/api/curation/calculate-relation-id', {
      inref: inref, inoutref: inoutref, outref: outref,
      control_type: relType,
      ontology:     getProp(['ontology']),
      relationship: getProp(['relationship']),
      effect:       getProp(['effect','Effect']),
      mechanism:    getProp(['mechanism','Mechanism'])
    });
    _rc.currentRelId = r.relationId || '';
    var relIdEl = document.getElementById('rc-rel-id');
    relIdEl.textContent = _rc.currentRelId || '—';
    relIdEl.title = r.existingFound
      ? 'Matched existing relation in database — Save will update it'
      : 'New relation — computed hash';
    relIdEl.style.color = r.existingFound ? '#4caf50' : '#5a6a90';
  } catch(e) {
    document.getElementById('rc-rel-id').textContent = '(error)';
  }
}

// ── References panel ──────────────────────────────────────────────────────────
async function rcToggleRefs() {
  _rc.refsVisible = !_rc.refsVisible;
  var btn = document.getElementById('rc-refs-btn');
  if (_rc.refsVisible) {
    document.getElementById('rc-refs-section').style.display = 'block';
    btn.style.background   = '#0e2040';
    btn.style.borderColor  = '#4f8ef7';
    btn.style.color        = '#4f8ef7';
    if (!_rc.refsLoaded) await rcLoadRefs();
  } else {
    rcHideRefsPanel();
  }
}

function rcHideRefsPanel() {
  _rc.refsVisible = false;
  document.getElementById('rc-refs-section').style.display = 'none';
  var btn = document.getElementById('rc-refs-btn');
  btn.style.background  = '#1a2040';
  btn.style.borderColor = '#3a3f55';
  btn.style.color       = '#c0c4d4';
}

async function rcLoadRefs() {
  // Ensure RelationID is fresh
  if (_rc._debounce) { clearTimeout(_rc._debounce); await rcCalcRelId(); }

  _rc.refs = [];
  if (_rc.currentRelId) {
    try {
      var res = await api('/api/references/batch', { relationIds: [_rc.currentRelId], scopusColumns: [] });
      var rows = res[_rc.currentRelId] || [];
      _rc.refs = rows.map(function(r) { return Object.assign({ _mode: 'view' }, r); });
    } catch(e) { /* no refs */ }
  }

  // Always start with at least one editable section for new relations
  if (!_rc.refs.length) _rc.refs = [{ _mode: 'edit', _new: true }];

  _rc.refsLoaded = true;
  _rc.refIdx = 0;
  rcRenderRefNav();
  rcRenderRefCard();
}

function rcRenderRefNav() {
  var total = _rc.refs.length;
  var idx   = _rc.refIdx;
  document.getElementById('rc-ref-counter').textContent =
    total ? ('Reference ' + (idx + 1) + ' of ' + total) : 'No references';
  var first = document.getElementById('rc-nav-first');
  var prev  = document.getElementById('rc-nav-prev');
  var next  = document.getElementById('rc-nav-next');
  var last  = document.getElementById('rc-nav-last');
  var dis = 'opacity:.35;pointer-events:none';
  var ena = 'opacity:1;pointer-events:auto';
  first.style.cssText += ';' + (idx === 0          ? dis : ena);
  prev.style.cssText  += ';' + (idx === 0          ? dis : ena);
  next.style.cssText  += ';' + (idx >= total - 1   ? dis : ena);
  last.style.cssText  += ';' + (idx >= total - 1   ? dis : ena);
}

function rcNavRef(dir) {
  if (!rcValidateCurrentRef()) return;
  var total = _rc.refs.length;
  if      (dir === 'first') _rc.refIdx = 0;
  else if (dir === 'prev')  _rc.refIdx = Math.max(0, _rc.refIdx - 1);
  else if (dir === 'next')  _rc.refIdx = Math.min(total - 1, _rc.refIdx + 1);
  else if (dir === 'last')  _rc.refIdx = total - 1;
  rcRenderRefNav();
  rcRenderRefCard();
}

// Validate mandatory fields on the currently displayed reference (if in edit mode).
// Returns true if valid or not in edit mode; false + alert if invalid.
function rcValidateCurrentRef() {
  var ref = _rc.refs[_rc.refIdx];
  if (!ref || ref._mode !== 'edit') return true;

  // Persist any live DOM edits back into the ref object first
  rcSaveRefInputs();

  var ID_FIELDS = ['doi','pmid','embase','pii','pui','nct_id'];
  var hasId   = ID_FIELDS.some(function(f) { return (String(ref[f] || '')).trim() !== ''; });
  var hasMsrc = (String(ref.msrc || '')).trim() !== '';

  if (!hasId || !hasMsrc) {
    var missing = [];
    if (!hasId)   missing.push('at least one identifier: DOI, PMID, EMBASE, PII, PUI, or NCT ID');
    if (!hasMsrc) missing.push('Sentence (msrc)');
    alert('Reference ' + (_rc.refIdx + 1) + ' is missing:\n• ' + missing.join('\n• '));
    return false;
  }
  return true;
}

function rcSaveRefInputs() {
  var ref  = _rc.refs[_rc.refIdx];
  var card = document.getElementById('rc-ref-card');
  if (!ref || !card) return;
  card.querySelectorAll('[data-ref-field]').forEach(function(el) {
    ref[el.getAttribute('data-ref-field')] = el.value;
  });
}

// ── Reference card rendering ──────────────────────────────────────────────────
var RC_PROM_FIELDS = ['doi','pmid','embase','pii','pui','nct_id','msrc','pubyear','title','authors'];
var RC_ID_FIELDS   = { doi:1, pmid:1, embase:1, pii:1, pui:1, nct_id:1 };
var RC_SKIP_FIELDS = { _mode:1, _new:1, _deleted:1, unique_id:1, id:1 };

function rcRenderRefCard() {
  var card = document.getElementById('rc-ref-card');
  var ref  = _rc.refs[_rc.refIdx];
  if (!ref) { card.innerHTML = '<div style="color:#2a3050;font-size:12px">No reference.</div>'; return; }

  if (ref._mode === 'edit') {
    rcRenderRefEditMode(card, ref);
  } else {
    rcRenderRefViewMode(card, ref);
  }
}

function rcRenderRefViewMode(card, ref) {
  var fields = Object.keys(ref).filter(function(k) {
    return !RC_SKIP_FIELDS[k] && ref[k] != null && ref[k] !== '';
  });
  // Sort: prominent fields first, then the rest alphabetically
  fields.sort(function(a, b) {
    var ai = RC_PROM_FIELDS.indexOf(a);
    var bi = RC_PROM_FIELDS.indexOf(b);
    if (ai === -1 && bi === -1) return a < b ? -1 : 1;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  var html = '<div style="display:flex;flex-direction:column;gap:5px;margin-bottom:12px">';
  fields.forEach(function(k) {
    var isId = RC_ID_FIELDS[k] ? '<span style="color:#4f8ef7;font-size:10px;margin-left:3px">ID</span>' : '';
    html +=
      '<div style="display:flex;gap:8px;align-items:flex-start">' +
        '<div style="min-width:90px;font-size:11px;color:#7a8099;flex-shrink:0;padding-top:1px">' + escHtml(k) + isId + '</div>' +
        '<div style="flex:1;font-size:12px;color:#c0c4d4;word-break:break-word">' + escHtml(String(ref[k])) + '</div>' +
      '</div>';
  });
  html += '</div>';
  html +=
    '<div style="display:flex;gap:8px">' +
      '<button onclick="rcEditRef()" title="Edit reference" ' +
        'style="background:#1a2a50;border:1px solid #3a3f55;border-radius:5px;color:#4f8ef7;padding:4px 12px;font-size:12px;cursor:pointer">✎ Edit</button>' +
      '<button onclick="rcDeleteRef()" title="Delete reference" ' +
        'style="background:#280e0e;border:1px solid #7a2020;border-radius:5px;color:#cc4040;padding:4px 10px;font-size:12px;cursor:pointer">✕ Delete</button>' +
    '</div>';
  card.innerHTML = html;
}

function rcRenderRefEditMode(card, ref) {
  // Build the ordered list of fields to show (prominent + any extras already on the ref)
  var shown = {};
  var fieldList = RC_PROM_FIELDS.slice();
  Object.keys(ref).forEach(function(k) {
    if (!RC_SKIP_FIELDS[k] && !shown[k] && RC_PROM_FIELDS.indexOf(k) === -1) fieldList.push(k);
  });

  var html = '<div style="display:flex;flex-direction:column;gap:7px">';
  fieldList.forEach(function(k) {
    if (RC_SKIP_FIELDS[k]) return;
    shown[k] = 1;
    var isReq = (k === 'msrc' || RC_ID_FIELDS[k]) ? '<span style="color:#e05060">*</span>' : '';
    var label = escHtml(k) + isReq;
    var val   = ref[k] != null ? escHtml(String(ref[k])) : '';
    html +=
      '<div style="display:flex;align-items:flex-start;gap:8px">' +
        '<div style="min-width:80px;font-size:11px;color:#7a8099;flex-shrink:0;padding-top:7px">' + label + '</div>';
    if (k === 'msrc') {
      html += '<textarea data-ref-field="' + k + '" rows="3" ' +
        'style="flex:1;background:#0a0f1e;border:1px solid #3a3f55;border-radius:5px;color:#c0c4d4;padding:5px 8px;font-size:12px;resize:vertical">' + val + '</textarea>';
    } else {
      html += '<input type="text" data-ref-field="' + k + '" value="' + val + '" ' +
        'style="flex:1;background:#0a0f1e;border:1px solid #3a3f55;border-radius:5px;color:#c0c4d4;padding:5px 8px;font-size:12px">';
    }
    html += '</div>';
  });

  // Add extra field row
  html +=
    '<div style="display:flex;gap:6px;align-items:center;margin-top:4px;padding-top:6px;border-top:1px solid #1a2040">' +
      '<select id="rc-ref-addcol" style="background:#0a0f1e;border:1px solid #2a3050;border-radius:4px;color:#c0c4d4;padding:4px 6px;font-size:12px">' +
        _rc.refCols.filter(function(c) { return !RC_SKIP_FIELDS[c] && !shown[c]; })
          .map(function(c) { return '<option value="' + escHtml(c) + '">' + escHtml(c) + '</option>'; }).join('') +
      '</select>' +
      '<input type="text" id="rc-ref-addval" placeholder="value" ' +
        'style="flex:1;background:#0a0f1e;border:1px solid #2a3050;border-radius:4px;color:#c0c4d4;padding:4px 8px;font-size:12px">' +
      '<button onclick="rcRefAddField()" ' +
        'style="background:#2a3050;border:1px solid #3a3f55;border-radius:4px;color:#c0c4d4;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap">Add field</button>' +
    '</div>';
  html += '</div>';
  card.innerHTML = html;
}

function rcEditRef() {
  _rc.refs[_rc.refIdx]._mode = 'edit';
  rcRenderRefCard();
}

function rcRefAddField() {
  rcSaveRefInputs();  // persist current inputs first
  var col = document.getElementById('rc-ref-addcol');
  var val = document.getElementById('rc-ref-addval');
  if (!col || !val || !val.value.trim()) return;
  _rc.refs[_rc.refIdx][col.value] = val.value.trim();
  rcRenderRefCard();
}

function rcDeleteRef() {
  var ref = _rc.refs[_rc.refIdx];
  if (!ref) return;
  if (!ref._new) ref._deleted = true;   // mark for server-side deletion
  _rc.refs.splice(_rc.refIdx, 1);
  if (_rc.refIdx >= _rc.refs.length) _rc.refIdx = Math.max(0, _rc.refs.length - 1);
  rcRenderRefNav();
  rcRenderRefCard();
}

function rcAddNewRef() {
  _rc.refs.push({ _mode: 'edit', _new: true });
  _rc.refIdx = _rc.refs.length - 1;
  rcRenderRefNav();
  rcRenderRefCard();
}

// ── Save to database ──────────────────────────────────────────────────────────
async function rcSaveToDatabase() {
  var relType = document.getElementById('rc-reltype').value;
  if (!relType) {
    alert('Please add relation type before adding relation to database.');
    return;
  }

  // Find source (→) and target (←)
  var sourceNode = null, targetNode = null;
  for (var i = 0; i < _rc.nodes.length; i++) {
    var n = _rc.nodes[i];
    if (n.direction === '→' && !sourceNode) sourceNode = n;
    if (n.direction === '←' && !targetNode) targetNode = n;
  }
  if (!sourceNode) { alert('Please set one node as source (→).'); return; }
  if (!targetNode) { alert('Please set one node as target (←).'); return; }
  if (!sourceNode.nodeId || !targetNode.nodeId) {
    alert('Source or target node is missing a NodeID. Cannot write to database.');
    return;
  }

  // Ensure fresh RelationID
  if (_rc._debounce) { clearTimeout(_rc._debounce); await rcCalcRelId(); }
  if (!_rc.currentRelId) {
    alert('Could not calculate RelationID. Ensure nodes have NodeIDs and a relation type is selected.');
    return;
  }

  // Persist any in-progress reference edits
  if (_rc.refsVisible && _rc.refs.length) rcSaveRefInputs();

  // Collect properties map
  var props = {};
  _rc.props.forEach(function(p) { props[p.key] = p.value; });

  // Refs to send: all (server filters by _deleted / _new)
  var refsToSend = _rc.refs.filter(function(r) {
    if (r._deleted) return true;
    // Include non-empty new refs and all edited existing refs
    return Object.keys(r).some(function(k) { return !k.startsWith('_') && r[k]; });
  });

  setProgressMsg('⏳ Saving relation…');
  try {
    var result = await api('/api/curation/write-relation', {
      sourceNode: { nodeId: sourceNode.nodeId, nodeLabel: sourceNode.nodeType },
      targetNode: { nodeId: targetNode.nodeId, nodeLabel: targetNode.nodeType },
      relationType: relType,
      properties:   props,
      relationId:   _rc.currentRelId,
      isNew:        _rc.mode === 'create',
      references:   refsToSend
    });
    setProgressMsg(null);

    if (result.error) { alert('Save failed: ' + result.error); return; }

    // Merge the new/updated edge into the current graph
    pushUndo();
    var savedProps = Object.assign({ RelationID: _rc.currentRelId }, result.properties);

    if (_rc.mode === 'create') {
      // Brand-new edge — add via mergeGraphData (handles Cytoscape insertion)
      mergeGraphData({
        nodes: [],
        edges: [{
          id:          result.elementId,
          elementId:   result.elementId,
          type:        relType,
          startNodeId: result.sourceNodeInternalId,
          endNodeId:   result.targetNodeInternalId,
          properties:  savedProps
        }]
      });
    } else {
      // Existing edge — look it up by RelationID and update in-memory data directly.
      // (mergeGraphData ID-matching fails when the existing edge uses an integer ID
      //  while the server returns a Neo4j element-ID string.)
      var relIdStr = String(_rc.currentRelId);
      var ge = graphData.edges.find(function(e) {
        return e.properties && String(e.properties.RelationID) === relIdStr;
      });
      if (ge) {
        Object.assign(ge.properties, savedProps);
        var cyEdge = cy.getElementById(ge.id);
        if (cyEdge && cyEdge.length) {
          Object.keys(savedProps).forEach(function(k) { cyEdge.data(k, savedProps[k]); });
        }
      } else {
        // Fallback: try mergeGraphData in case IDs do happen to match
        mergeGraphData({
          nodes: [],
          edges: [{
            id:          result.elementId,
            elementId:   result.elementId,
            type:        relType,
            startNodeId: result.sourceNodeInternalId,
            endNodeId:   result.targetNodeInternalId,
            properties:  savedProps
          }]
        });
      }
    }
    updateStats();

    closeRelationCurationDialog();
    showAlignHint('Relation saved to database.');
  } catch(err) {
    setProgressMsg(null);
    alert('Save failed: ' + (err.message || err));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CREATE RELATION — PAIR DIALOG  (exactly 2 nodes selected)
// ═══════════════════════════════════════════════════════════════════════════════

function openPairRelationDialog() {
  if (!cy || currentRole !== 'user') return;
  var selNodes = cy.nodes(':selected').not('[?isClone]');
  if (selNodes.length !== 2) return;

  var nA = selNodes[0], nB = selNodes[1];
  _rcPair.nodeA      = { cyId: nA.id(), label: nA.data('label') || nA.id(), nodeType: nA.data('nodeType') || '', nodeId: nA.data('NodeID') || '' };
  _rcPair.nodeB      = { cyId: nB.id(), label: nB.data('label') || nB.id(), nodeType: nB.data('nodeType') || '', nodeId: nB.data('NodeID') || '' };
  _rcPair.flipped    = false;
  _rcPair.isNonDir   = false;
  _rcPair.props      = [];
  _rcPair.refs       = [];
  _rcPair.refIdx     = 0;
  _rcPair.refsVisible = false;
  _rcPair.refsLoaded  = false;
  _rcPair.currentRelId = '';
  _rcPair._pid       = 0;

  document.getElementById('rcp-reltype').value = '';
  document.getElementById('rcp-rel-id').textContent = '—';

  rcPairRenderVisual();
  rcPairRenderProps();
  rcPairHideRefsPanel();
  document.getElementById('rc-pair-modal').style.display = 'flex';

  // Populate dropdowns from cache; load in background if cache is empty
  rcPairPopulateRelTypeDropdown();
  rcPairPopulatePropKeyDropdown();
  if (!_rc.relTypes.length || !_rc.propKeys.length || !_rc.refCols.length) {
    (async function() {
      try {
        if (!_rc.relTypes.length || !_rc.propKeys.length) {
          var schema = await api('/api/graph/schema');
          if (!_rc.relTypes.length) { _rc.relTypes = schema.relTypes || []; rcPairPopulateRelTypeDropdown(); }
          if (!_rc.propKeys.length) { _rc.propKeys = schema.propKeys || []; rcPairPopulatePropKeyDropdown(); }
        }
      } catch(e) {}
      try { if (!_rc.refCols.length)   { _rc.refCols   = (await api('/api/schema/columns')).referenceColumns || []; } } catch(e) {}
    })();
  }
}

function closePairRelationDialog() {
  document.getElementById('rc-pair-modal').style.display = 'none';
}

// Open the pair Create/Edit dialog pre-populated from an existing Cytoscape edge
function openPairRelationDialogForEdge(cyEdge) {
  if (!cy || currentRole !== 'user' || !cyEdge || !cyEdge.length) return;

  var srcCy = cy.$id(cyEdge.data('source'));
  var tgtCy = cy.$id(cyEdge.data('target'));
  if (!srcCy.length || !tgtCy.length) return;

  var relType = cyEdge.data('relType') || '';

  _rcPair.nodeA       = { cyId: srcCy.id(), label: srcCy.data('label') || srcCy.id(),
                          nodeType: srcCy.data('nodeType') || '', nodeId: srcCy.data('NodeID') || '' };
  _rcPair.nodeB       = { cyId: tgtCy.id(), label: tgtCy.data('label') || tgtCy.id(),
                          nodeType: tgtCy.data('nodeType') || '', nodeId: tgtCy.data('NodeID') || '' };
  _rcPair.flipped     = false;
  _rcPair.relType     = relType;
  _rcPair.isNonDir    = RC_NONDIRECTIONAL_TYPES.has(relType);
  _rcPair.currentRelId = '';
  _rcPair.refs        = [];
  _rcPair.refIdx      = 0;
  _rcPair.refsVisible = false;
  _rcPair.refsLoaded  = false;
  _rcPair._pid        = 0;

  // Pre-populate properties from edge data (skip structural/audit fields)
  var EDGE_SKIP = { RelationID:1, RelationIDs:1, RelationNumberOfReferences:1,
                    RelationNumberOfSentences:1, createdAt:1, updatedAt:1,
                    createdBy:1, updatedBy:1, id:1, source:1, target:1,
                    elementId:1, relType:1, relId:1, relIds:1, color:1, label:1,
                    numRefs:1, numSentences:1, thickness:1, directed:1 };
  _rcPair.props = [];
  Object.keys(cyEdge.data()).forEach(function(k) {
    if (EDGE_SKIP[k]) return;
    var v = cyEdge.data(k);
    if (v == null || v === '') return;
    _rcPair.props.push({ id: ++_rcPair._pid, key: k,
      value: Array.isArray(v) ? v.join(';') : String(v) });
  });

  // Set relation type in dropdown after populating
  document.getElementById('rcp-rel-id').textContent = '—';
  document.getElementById('rcp-title').textContent = 'Create/Edit Relation';

  rcPairRenderProps();
  rcPairHideRefsPanel();

  document.getElementById('rc-pair-modal').style.display = 'flex';

  var loadingEl = document.getElementById('rcp-schema-loading');

  if (!_rc.relTypes.length) {
    // Schema not yet ready — show blocking overlay, wait for load, then populate
    if (loadingEl) loadingEl.style.display = 'flex';
    _loadSchema().then(function() {
      if (loadingEl) loadingEl.style.display = 'none';
      rcPairPopulateRelTypeDropdown();
      rcPairPopulatePropKeyDropdown();
      var sel = document.getElementById('rcp-reltype');
      if (sel) sel.value = relType;
      rcPairRenderVisual();
      rcPairCalcRelId();
      if (!_rc.refCols.length) {
        api('/api/schema/columns', null).then(function(d) {
          _rc.refCols = d.referenceColumns || [];
        }).catch(function() {});
      }
    }).catch(function() {
      if (loadingEl) loadingEl.style.display = 'none';
    });
  } else {
    // Schema already cached — populate immediately
    rcPairPopulateRelTypeDropdown();
    rcPairPopulatePropKeyDropdown();
    var sel = document.getElementById('rcp-reltype');
    if (sel) sel.value = relType;
    rcPairRenderVisual();
    rcPairCalcRelId();
    if (!_rc.refCols.length) {
      api('/api/schema/columns', null).then(function(d) {
        _rc.refCols = d.referenceColumns || [];
      }).catch(function() {});
    }
  }
}

// ── Dropdowns ─────────────────────────────────────────────────────────────────
function rcPairPopulateRelTypeDropdown() {
  var sel = document.getElementById('rcp-reltype');
  var cur = sel.value;
  sel.innerHTML = '<option value="">— select relation type —</option>';
  _rc.relTypes.forEach(function(t) {
    sel.insertAdjacentHTML('beforeend',
      '<option value="' + escHtml(t) + '"' + (t === cur ? ' selected' : '') + '>' + escHtml(t) + '</option>');
  });
}

function rcPairPopulatePropKeyDropdown() {
  var dl = document.getElementById('rcp-prop-key-list');
  if (!dl) return;
  dl.innerHTML = '';
  _rc.propKeys.forEach(function(k) {
    dl.insertAdjacentHTML('beforeend', '<option value="' + escHtml(k) + '">');
  });
}

// ── Relation type change ───────────────────────────────────────────────────────
function rcPairOnRelTypeChange() {
  var relType = document.getElementById('rcp-reltype').value;
  _rcPair.relType  = relType;
  _rcPair.isNonDir = RC_NONDIRECTIONAL_TYPES.has(relType);
  if (_rcPair.isNonDir) _rcPair.flipped = false;
  rcPairRenderVisual();
  rcPairScheduleRelIdCalc();
}

function rcPairSwapDirection() {
  _rcPair.flipped = !_rcPair.flipped;
  rcPairRenderVisual();
  rcPairScheduleRelIdCalc();
}

// ── Node pair visual ──────────────────────────────────────────────────────────
function rcPairRenderVisual() {
  var c = document.getElementById('rcp-visual');
  var nA = _rcPair.nodeA, nB = _rcPair.nodeB;
  if (!nA || !nB) { c.innerHTML = ''; return; }

  var relType = document.getElementById('rcp-reltype').value || _rcPair.relType || '';
  var src = _rcPair.flipped ? nB : nA;
  var tgt = _rcPair.flipped ? nA : nB;

  function nodeBox(n, roleLabel) {
    return '<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0">'
      + '<div style="background:#1a2040;border:1px solid #3a4060;border-radius:7px;padding:10px 12px;width:100%;box-sizing:border-box;text-align:center">'
        + (n.nodeType ? '<div style="font-size:10px;color:#4f8ef7;margin-bottom:3px">' + escHtml(n.nodeType) + '</div>' : '')
        + '<div style="font-size:13px;color:#e0e4f4;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(n.label) + '">' + escHtml(n.label) + '</div>'
      + '</div>'
      + (roleLabel ? '<div style="font-size:10px;color:#7a8099;margin-top:5px">' + roleLabel + '</div>' : '')
    + '</div>';
  }

  var connector, swapHtml = '';
  if (!relType) {
    connector = '<div style="align-self:center;padding:0 8px;font-size:22px;color:#2a3050;flex-shrink:0">?</div>';
  } else if (_rcPair.isNonDir) {
    connector = '<div style="align-self:center;padding:0 8px;flex-shrink:0">'
      + '<div style="width:48px;height:2px;background:#5a6080"></div>'
    + '</div>';
  } else {
    connector = '<div style="align-self:center;padding:0 4px;font-size:26px;color:#4f8ef7;flex-shrink:0;line-height:1">→</div>';
    swapHtml = '<div style="display:flex;justify-content:center;margin-top:10px">'
      + '<button onclick="rcPairSwapDirection()" '
        + 'style="background:#1a2040;border:1px solid #3a3f55;border-radius:5px;color:#c0c4d4;'
        + 'padding:5px 16px;font-size:12px;cursor:pointer">⇄ Swap regulator / target</button>'
    + '</div>';
  }

  var regLabel  = _rcPair.isNonDir ? '' : 'Regulator';
  var tgtLabel  = _rcPair.isNonDir ? '' : 'Target';

  c.innerHTML = '<div style="display:flex;align-items:flex-start;gap:8px;width:100%">'
      + nodeBox(src, regLabel)
      + connector
      + nodeBox(tgt, tgtLabel)
    + '</div>'
    + swapHtml;
}

// ── Properties ────────────────────────────────────────────────────────────────
function rcPairAddProperty() {
  var keyEl = document.getElementById('rcp-prop-key');
  var valEl = document.getElementById('rcp-prop-val');
  var key = keyEl.value.trim(), val = valEl.value.trim();
  if (!key) { alert('Please enter a property name.'); return; }
  if (!val) { alert('Value cannot be empty.');    return; }
  _rcPair.props.push({ id: ++_rcPair._pid, key: key, value: val });
  valEl.value = ''; keyEl.value = '';
  rcPairRenderProps();
  rcPairScheduleRelIdCalc();
}

function rcPairDeleteProperty(pid) {
  _rcPair.props = _rcPair.props.filter(function(p) { return p.id !== pid; });
  rcPairRenderProps();
  rcPairScheduleRelIdCalc();
}

function rcPairRenderProps() {
  var c = document.getElementById('rcp-props');
  if (!_rcPair.props.length) {
    c.innerHTML = '<div style="font-size:12px;color:#2a3050;font-style:italic;padding:4px 0">No properties added.</div>';
    return;
  }
  c.innerHTML = '';
  _rcPair.props.forEach(function(p) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 2px;border-bottom:1px solid #1a2040';
    row.innerHTML =
      '<div style="font-size:12px;color:#7a8099;min-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(p.key) + '</div>'
      + '<div style="flex:1;font-size:13px;color:#c0c4d4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(String(p.value)) + '</div>'
      + '<button onclick="rcPairDeleteProperty(' + p.id + ')" style="background:none;border:none;color:#8a2020;font-size:17px;cursor:pointer;line-height:1;padding:0 2px;flex-shrink:0">×</button>';
    c.appendChild(row);
  });
}

// ── RelationID ────────────────────────────────────────────────────────────────
function rcPairScheduleRelIdCalc() {
  if (_rcPair._debounce) clearTimeout(_rcPair._debounce);
  _rcPair._debounce = setTimeout(rcPairCalcRelId, 380);
}

async function rcPairCalcRelId() {
  var relType = document.getElementById('rcp-reltype').value;
  var src = _rcPair.flipped ? _rcPair.nodeB : _rcPair.nodeA;
  var tgt = _rcPair.flipped ? _rcPair.nodeA : _rcPair.nodeB;
  var inref = [], outref = [], inoutref = [];
  if (_rcPair.isNonDir) {
    if (_rcPair.nodeA.nodeId) inoutref.push(_rcPair.nodeA.nodeId);
    if (_rcPair.nodeB.nodeId) inoutref.push(_rcPair.nodeB.nodeId);
  } else {
    if (src.nodeId) inref.push(src.nodeId);
    if (tgt.nodeId) outref.push(tgt.nodeId);
  }
  function getProp(names) {
    for (var i = 0; i < names.length; i++)
      for (var j = 0; j < _rcPair.props.length; j++)
        if (_rcPair.props[j].key.toLowerCase() === names[i].toLowerCase()) return _rcPair.props[j].value;
    return '';
  }
  try {
    var r = await api('/api/curation/calculate-relation-id', {
      inref: inref, inoutref: inoutref, outref: outref,
      control_type: relType,
      ontology:     getProp(['ontology']),
      relationship: getProp(['relationship']),
      effect:       getProp(['effect','Effect']),
      mechanism:    getProp(['mechanism','Mechanism'])
    });
    _rcPair.currentRelId = r.relationId || '';
    document.getElementById('rcp-rel-id').textContent = _rcPair.currentRelId || '—';
  } catch(e) {
    document.getElementById('rcp-rel-id').textContent = '(error)';
  }
}

// ── References ────────────────────────────────────────────────────────────────
async function rcPairToggleRefs() {
  _rcPair.refsVisible = !_rcPair.refsVisible;
  var btn = document.getElementById('rcp-refs-btn');
  if (_rcPair.refsVisible) {
    document.getElementById('rcp-refs-section').style.display = 'block';
    btn.style.background  = '#0e2040'; btn.style.borderColor = '#4f8ef7'; btn.style.color = '#4f8ef7';
    if (!_rcPair.refsLoaded) await rcPairLoadRefs();
  } else {
    rcPairHideRefsPanel();
  }
}

function rcPairHideRefsPanel() {
  _rcPair.refsVisible = false;
  document.getElementById('rcp-refs-section').style.display = 'none';
  var btn = document.getElementById('rcp-refs-btn');
  btn.style.background  = '#1a2040'; btn.style.borderColor = '#3a3f55'; btn.style.color = '#c0c4d4';
}

async function rcPairLoadRefs() {
  if (_rcPair._debounce) { clearTimeout(_rcPair._debounce); await rcPairCalcRelId(); }
  _rcPair.refs = [];
  if (_rcPair.currentRelId) {
    try {
      var res = await api('/api/references/batch', { relationIds: [_rcPair.currentRelId], scopusColumns: [] });
      _rcPair.refs = (res[_rcPair.currentRelId] || []).map(function(r) { return Object.assign({ _mode: 'view' }, r); });
    } catch(e) {}
  }
  if (!_rcPair.refs.length) _rcPair.refs = [{ _mode: 'edit', _new: true }];
  _rcPair.refsLoaded = true;
  _rcPair.refIdx = 0;
  rcPairRenderRefNav();
  rcPairRenderRefCard();
}

function rcPairRenderRefNav() {
  var total = _rcPair.refs.length, idx = _rcPair.refIdx;
  document.getElementById('rcp-ref-counter').textContent =
    total ? ('Reference ' + (idx + 1) + ' of ' + total) : 'No references';
  var dis = 'opacity:.35;pointer-events:none', ena = 'opacity:1;pointer-events:auto';
  ['rcp-nav-first','rcp-nav-prev'].forEach(function(id) { document.getElementById(id).style.cssText += ';' + (idx === 0        ? dis : ena); });
  ['rcp-nav-next', 'rcp-nav-last'].forEach(function(id) { document.getElementById(id).style.cssText += ';' + (idx >= total - 1 ? dis : ena); });
}

function rcPairNavRef(dir) {
  if (!rcPairValidateCurrentRef()) return;
  var total = _rcPair.refs.length;
  if      (dir === 'first') _rcPair.refIdx = 0;
  else if (dir === 'prev')  _rcPair.refIdx = Math.max(0, _rcPair.refIdx - 1);
  else if (dir === 'next')  _rcPair.refIdx = Math.min(total - 1, _rcPair.refIdx + 1);
  else if (dir === 'last')  _rcPair.refIdx = total - 1;
  rcPairRenderRefNav();
  rcPairRenderRefCard();
}

function rcPairValidateCurrentRef() {
  var ref = _rcPair.refs[_rcPair.refIdx];
  if (!ref || ref._mode !== 'edit') return true;
  rcPairSaveRefInputs();
  var ID_FIELDS = ['doi','pmid','embase','pii','pui','nct_id'];
  var hasId   = ID_FIELDS.some(function(f) { return (String(ref[f] || '')).trim() !== ''; });
  var hasMsrc = (String(ref.msrc || '')).trim() !== '';
  if (!hasId || !hasMsrc) {
    var missing = [];
    if (!hasId)   missing.push('at least one identifier: DOI, PMID, EMBASE, PII, PUI, or NCT ID');
    if (!hasMsrc) missing.push('Sentence (msrc)');
    alert('Reference ' + (_rcPair.refIdx + 1) + ' is missing:\n• ' + missing.join('\n• '));
    return false;
  }
  return true;
}

function rcPairSaveRefInputs() {
  var ref = _rcPair.refs[_rcPair.refIdx];
  var card = document.getElementById('rcp-ref-card');
  if (!ref || !card) return;
  card.querySelectorAll('[data-ref-field]').forEach(function(el) {
    ref[el.getAttribute('data-ref-field')] = el.value;
  });
}

function rcPairRenderRefCard() {
  var card = document.getElementById('rcp-ref-card');
  var ref  = _rcPair.refs[_rcPair.refIdx];
  if (!ref) { card.innerHTML = '<div style="color:#2a3050;font-size:12px">No reference.</div>'; return; }
  if (ref._mode === 'edit') {
    rcPairRenderRefEditMode(card, ref);
  } else {
    rcPairRenderRefViewMode(card, ref);
  }
}

function rcPairRenderRefViewMode(card, ref) {
  var fields = Object.keys(ref).filter(function(k) { return !RC_SKIP_FIELDS[k] && ref[k] != null && ref[k] !== ''; });
  fields.sort(function(a, b) {
    var ai = RC_PROM_FIELDS.indexOf(a), bi = RC_PROM_FIELDS.indexOf(b);
    if (ai === -1 && bi === -1) return a < b ? -1 : 1;
    if (ai === -1) return 1; if (bi === -1) return -1;
    return ai - bi;
  });
  var html = '<div style="display:flex;flex-direction:column;gap:5px;margin-bottom:12px">';
  fields.forEach(function(k) {
    var isId = RC_ID_FIELDS[k] ? '<span style="color:#4f8ef7;font-size:10px;margin-left:3px">ID</span>' : '';
    html += '<div style="display:flex;gap:8px;align-items:flex-start">'
      + '<div style="min-width:90px;font-size:11px;color:#7a8099;flex-shrink:0;padding-top:1px">' + escHtml(k) + isId + '</div>'
      + '<div style="flex:1;font-size:12px;color:#c0c4d4;word-break:break-word">' + escHtml(String(ref[k])) + '</div>'
      + '</div>';
  });
  html += '</div>';
  html += '<div style="display:flex;gap:8px">'
    + '<button onclick="rcPairEditRef()" style="background:#1a2a50;border:1px solid #3a3f55;border-radius:5px;color:#4f8ef7;padding:4px 12px;font-size:12px;cursor:pointer">✎ Edit</button>'
    + '<button onclick="rcPairDeleteRef()" style="background:#280e0e;border:1px solid #7a2020;border-radius:5px;color:#cc4040;padding:4px 10px;font-size:12px;cursor:pointer">✕ Delete</button>'
    + '</div>';
  card.innerHTML = html;
}

function rcPairRenderRefEditMode(card, ref) {
  var shown = {};
  var fieldList = RC_PROM_FIELDS.slice();
  Object.keys(ref).forEach(function(k) { if (!RC_SKIP_FIELDS[k] && !shown[k] && RC_PROM_FIELDS.indexOf(k) === -1) fieldList.push(k); });
  var html = '<div style="display:flex;flex-direction:column;gap:7px">';
  fieldList.forEach(function(k) {
    if (RC_SKIP_FIELDS[k]) return;
    shown[k] = 1;
    var isReq = (k === 'msrc' || RC_ID_FIELDS[k]) ? '<span style="color:#e05060">*</span>' : '';
    var val = ref[k] != null ? escHtml(String(ref[k])) : '';
    html += '<div style="display:flex;align-items:flex-start;gap:8px">'
      + '<div style="min-width:80px;font-size:11px;color:#7a8099;flex-shrink:0;padding-top:7px">' + escHtml(k) + isReq + '</div>';
    if (k === 'msrc') {
      html += '<textarea data-ref-field="' + k + '" rows="3" style="flex:1;background:#0a0f1e;border:1px solid #3a3f55;border-radius:5px;color:#c0c4d4;padding:5px 8px;font-size:12px;resize:vertical">' + val + '</textarea>';
    } else {
      html += '<input type="text" data-ref-field="' + k + '" value="' + val + '" style="flex:1;background:#0a0f1e;border:1px solid #3a3f55;border-radius:5px;color:#c0c4d4;padding:5px 8px;font-size:12px">';
    }
    html += '</div>';
  });
  var availCols = _rc.refCols.filter(function(c) { return !RC_SKIP_FIELDS[c] && !shown[c]; });
  if (availCols.length) {
    html += '<div style="display:flex;gap:6px;align-items:center;margin-top:4px;padding-top:6px;border-top:1px solid #1a2040">'
      + '<select id="rcp-ref-addcol" style="background:#0a0f1e;border:1px solid #2a3050;border-radius:4px;color:#c0c4d4;padding:4px 6px;font-size:12px">'
      + availCols.map(function(c) { return '<option value="' + escHtml(c) + '">' + escHtml(c) + '</option>'; }).join('')
      + '</select>'
      + '<input type="text" id="rcp-ref-addval" placeholder="value" style="flex:1;background:#0a0f1e;border:1px solid #2a3050;border-radius:4px;color:#c0c4d4;padding:4px 8px;font-size:12px">'
      + '<button onclick="rcPairRefAddField()" style="background:#2a3050;border:1px solid #3a3f55;border-radius:4px;color:#c0c4d4;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap">Add field</button>'
      + '</div>';
  }
  html += '</div>';
  card.innerHTML = html;
}

function rcPairEditRef()   { _rcPair.refs[_rcPair.refIdx]._mode = 'edit'; rcPairRenderRefCard(); }
function rcPairDeleteRef() {
  var ref = _rcPair.refs[_rcPair.refIdx];
  if (!ref) return;
  if (!ref._new) ref._deleted = true;
  _rcPair.refs.splice(_rcPair.refIdx, 1);
  if (_rcPair.refIdx >= _rcPair.refs.length) _rcPair.refIdx = Math.max(0, _rcPair.refs.length - 1);
  rcPairRenderRefNav(); rcPairRenderRefCard();
}
function rcPairAddNewRef() {
  _rcPair.refs.push({ _mode: 'edit', _new: true });
  _rcPair.refIdx = _rcPair.refs.length - 1;
  rcPairRenderRefNav(); rcPairRenderRefCard();
}
function rcPairRefAddField() {
  rcPairSaveRefInputs();
  var col = document.getElementById('rcp-ref-addcol');
  var val = document.getElementById('rcp-ref-addval');
  if (!col || !val || !val.value.trim()) return;
  _rcPair.refs[_rcPair.refIdx][col.value] = val.value.trim();
  rcPairRenderRefCard();
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function rcPairSaveToDatabase() {
  var relType = document.getElementById('rcp-reltype').value;
  if (!relType) { alert('Please select a relation type.'); return; }

  var src = _rcPair.flipped ? _rcPair.nodeB : _rcPair.nodeA;
  var tgt = _rcPair.flipped ? _rcPair.nodeA : _rcPair.nodeB;
  if (!src.nodeId || !tgt.nodeId) {
    alert('One or both nodes are missing a NodeID. Cannot write to database.');
    return;
  }

  if (!_rcPair.isNonDir) {
    // For directional types, make sure the user explicitly swapped if needed
    // (default A→B is acceptable; just ensure relType is set — already checked above)
  }

  if (_rcPair._debounce) { clearTimeout(_rcPair._debounce); await rcPairCalcRelId(); }
  if (!_rcPair.currentRelId) {
    alert('Could not calculate RelationID. Ensure nodes have NodeIDs and a relation type is selected.');
    return;
  }

  if (_rcPair.refsVisible && _rcPair.refs.length) rcPairSaveRefInputs();

  var props = {};
  _rcPair.props.forEach(function(p) { props[p.key] = p.value; });

  var refsToSend = _rcPair.refs.filter(function(r) {
    if (r._deleted) return true;
    return Object.keys(r).some(function(k) { return !k.startsWith('_') && r[k]; });
  });

  setProgressMsg('⏳ Saving relation…');
  try {
    var result = await api('/api/curation/write-relation', {
      sourceNode:   { nodeId: src.nodeId,  nodeLabel: src.nodeType  },
      targetNode:   { nodeId: tgt.nodeId,  nodeLabel: tgt.nodeType  },
      relationType: relType,
      properties:   props,
      relationId:   _rcPair.currentRelId,
      isNew:        true,
      references:   refsToSend
    });
    setProgressMsg(null);
    if (result.error) { alert('Save failed: ' + result.error); return; }

    pushUndo();
    mergeGraphData({
      nodes: [],
      edges: [{
        id: result.elementId, elementId: result.elementId,
        type: relType,
        startNodeId: result.sourceNodeInternalId,
        endNodeId:   result.targetNodeInternalId,
        properties:  Object.assign({ RelationID: _rcPair.currentRelId }, result.properties)
      }]
    });
    updateStats();
    closePairRelationDialog();
    showAlignHint('Relation saved to database.');
  } catch(err) {
    setProgressMsg(null);
    alert('Save failed: ' + (err.message || err));
  }
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

function _expandCommitNewTab() {
  document.getElementById('expand-confirm-modal').style.display = 'none';
  if (!_expandPending) return;
  var pending = _expandPending;
  _expandPending = null;

  // Save active tab state, create a fresh tab, then load the expansion into it
  createNewTab('Expansion ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  var result = mergeGraphData(pending);
  console.log('[expand→new tab] added ' + result.addedNodes + ' nodes, ' + result.addedEdges + ' edges');

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
  if (contextTarget.type === 'edge' && currentRole === 'user') {
    var cyEdge = cy.getElementById(contextTarget.id);
    if (cyEdge && cyEdge.length) {
      // Route based on number of distinct endpoint nodes
      var srcId = cyEdge.data('source');
      var tgtId = cyEdge.data('target');
      var endpointCount = (srcId && tgtId && srcId !== tgtId) ? 2 : 1;
      if (endpointCount === 2) {
        // Standard 2-node relation → Create/Edit Relation (pair dialog)
        openPairRelationDialogForEdge(cyEdge);
      } else {
        // Self-loop or multi-node hyperedge → hyperedge dialog
        cy.elements().unselect();
        cyEdge.select();
        openRelationCurationDialog();
      }
      return;
    }
  }
  // Nodes (or edges where cy element not found) → simple property editor
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
    } else {
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
      + '<input class="prop-key" type="text" value="' + escHtml(key) + '" placeholder="Property name" readonly style="background:#111;color:#6a7090;cursor:default">'
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
    var keyEl = row.querySelector('.prop-key');
    var key = (keyEl ? keyEl.value : null) || row.getAttribute('data-key') || '';
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
      // Also update Cytoscape edge data so re-opening "Edit properties" shows fresh values
      var cyEdge = cy.getElementById(curationTarget.id);
      if (cyEdge && cyEdge.length) {
        Object.keys(props).forEach(function(k) { cyEdge.data(k, props[k]); });
      }
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
