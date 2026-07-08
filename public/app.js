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
// Table ⇄ graph selection sync — the set of edge ids currently selected, kept in
// lockstep with the Cytoscape graph's selected edges regardless of which view is
// visible, so switching views never loses or hides the current selection.
let _selectedTableEdgeIds  = new Set();
let _selectedTableNodeIds  = new Set();  // Nodes-view analogue of _selectedTableEdgeIds
let _lastClickedTableRowIdx = null;
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
let tableViewMode = 'reference'; // 'reference' | 'relation' | 'node'
let relationRows  = [];      // rows for Relation view (one per edge, no Postgres)
let nodeRows      = [];      // rows for Node view (one per node)

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

// Node type → highlight color (mirrors Cytoscape stylesheet gradient-bottom stops)
var NODE_TYPE_COLORS = {
  Protein: '#d32f2f', SmallMol: '#00C853', Treatment: '#1565c0',
  Disease: '#CC5500', CellProcess: '#f9a825', FunctionalClass: '#e65100',
  Complex: '#7f0000', CellObject: '#757575', Tissue: '#6d4c41',
  Organ: '#4a148c', CellType: '#29b6f6', Cell: '#29b6f6',
  GeneticVariant: '#FF6D00', ClinicalParameter: '#5C6BC0',
  MedicalProcedure: '#5dd6c5', Pathogen: '#61DE2A', Virus: '#B5BF50',
};

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

// Default columns for the Nodes table view — source:'node_graph' is the node-view
// analogue of 'graph' above (kept distinct so the two don't mix in the shared
// columnDefs array). Additional per-node properties (Neo4j-native or fetched from
// Postgres node/attr) are added dynamically as source:'node_col', mirroring how
// NEO4J_PROP_DEFS / node_prop columns are added for the other views.
const DEFAULT_NODE_COLUMNS = [
  { key: 'name',       label: 'Name',      visible: true, source: 'node_graph' },
  { key: 'nodeType',   label: 'Node Type', visible: true, source: 'node_graph' },
  { key: 'urn',        label: 'URN',       visible: true, source: 'node_graph' },
  { key: 'nodeIdProp', label: 'NodeID',    visible: true, source: 'node_graph' },
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
    // Allow native Ctrl+C when the user has text selected in the agent chat panel
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      var sel = window.getSelection();
      if (sel && sel.toString().length > 0) {
        var agentPanel = document.getElementById('agentic-panel');
        if (agentPanel && agentPanel.contains(sel.anchorNode)) return;
      }
    }

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
  // "My Connection" (personal Neo4j/Postgres credentials) is available to all roles
  document.getElementById('settings-db-section').style.display = '';
  if (currentRole === 'admin') {
    document.getElementById('admin-btn') && (document.getElementById('admin-btn').style.display = '');
    document.getElementById('settings-users-item').style.display = '';
    // Database endpoint (URL/host) configuration is admin-only
    document.getElementById('settings-db-admin-section').style.display = '';
  }
  // Initialise Agentic AI (show button, load LLM config)
  window._currentUser = { name: currentUser, role: currentRole };
  _initAgenticAI();
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
  // Migration: inject the Nodes-view default columns for configs saved before that view existed
  DEFAULT_NODE_COLUMNS.forEach(function(defCol) {
    if (!columnDefs.find(function(c) { return c.key === defCol.key; })) {
      columnDefs.push(Object.assign({}, defCol));
    }
  });
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

async function api(path, body, methodOrAuth) {
  // Third param may be: boolean (auth flag, legacy) or string (HTTP method override).
  var auth   = true;
  var method;
  if (typeof methodOrAuth === 'string') {
    method = methodOrAuth;                           // explicit: 'GET', 'DELETE', etc.
  } else {
    if (methodOrAuth !== undefined) auth = methodOrAuth;
    method = (body !== null && body !== undefined) ? 'POST' : 'GET';
  }
  var opts = {
    method:  method,
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
  var checks = { graph: 'mc-view-graph', relation: 'mc-view-relation', reference: 'mc-view-reference', node: 'mc-view-node' };
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
  var c4 = document.getElementById('mc-filter-rows-node');
  if (c1) c1.textContent = mark;
  if (c2) c2.textContent = mark;
  if (c3) c3.textContent = mark;
  if (c4) c4.textContent = mark;
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

function selectEdgesByType(relType) {
  if (!cy) return;
  cy.edges().unselect();
  cy.edges('[relType="' + relType + '"]').select();
  closeMenus();
}

function populateSelectByEdgeTypeMenu() {
  var sub = document.getElementById('select-by-edge-type-submenu');
  if (!sub) return;
  // Collect unique relType values from current graph
  var types = [];
  if (cy && cy.edges().length) {
    var seen = {};
    cy.edges().forEach(function(e) {
      var t = e.data('relType');
      if (t && !seen[t]) { seen[t] = true; types.push(t); }
    });
    types.sort(function(a, b) { return a.localeCompare(b); });
  }
  if (!types.length) {
    sub.innerHTML = '<div class="menu-item" style="color:#7a8099;font-style:italic">No relations in graph</div>';
    return;
  }
  sub.innerHTML = types.map(function(t) {
    var count = cy.edges('[relType="' + t + '"]').length;
    var esc = t.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    return '<div class="menu-item" data-select-edge-type="' + esc + '">'
      + esc + ' <span style="color:#7a8099;font-size:11px">(' + count + ')</span></div>';
  }).join('');
  if (!sub._edgeTypeListenerAttached) {
    sub._edgeTypeListenerAttached = true;
    sub.addEventListener('click', function(e) {
      var item = e.target.closest('[data-select-edge-type]');
      if (item) selectEdgesByType(item.getAttribute('data-select-edge-type'));
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

// ── Cypher syntax-error position marker ─────────────────────────────────────
// Neo4j error text sometimes names an exact character offset, e.g.
// "Unmatched ']' at position 244" or the EXPLAIN-lint format
// "(line 3, column 12 (offset: 244))". Extract that offset so the failing
// character can be pointed to directly instead of leaving the user to count
// characters by hand.
function _parseCypherErrorOffset(msg) {
  if (!msg) return null;
  var m = msg.match(/\(line\s+\d+,\s*column\s+\d+\s*\(offset:\s*(\d+)\)\)/i);
  if (m) return parseInt(m[1], 10);
  m = msg.match(/at position\s+(\d+)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

// A plain <textarea> has no per-character DOM nodes to measure, so the
// standard technique is a hidden "mirror" <div> that copies every style
// property affecting text layout (font, padding, border, wrapping) and
// contains the same text up to the target offset plus a marker <span> —
// the marker's measured position is then exactly where that character
// renders inside the real textarea.
function _cypherTextareaCaretPixelPos(ta, offset) {
  var style  = window.getComputedStyle(ta);
  var mirror = document.createElement('div');
  var propsToCopy = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'
  ];
  propsToCopy.forEach(function(p) { mirror.style[p] = style[p]; });
  mirror.style.position   = 'absolute';
  mirror.style.top        = '0px';
  mirror.style.left       = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap   = 'break-word';
  mirror.style.overflow   = 'hidden';
  mirror.style.height     = 'auto';

  var text    = ta.value;
  var clamped = Math.max(0, Math.min(offset, text.length));
  mirror.appendChild(document.createTextNode(text.substring(0, clamped)));
  var marker = document.createElement('span');
  marker.textContent = '​'; // zero-width space so the span has a measurable box
  mirror.appendChild(marker);
  mirror.appendChild(document.createTextNode(text.substring(clamped) || ' '));

  document.body.appendChild(mirror);
  var mirrorRect = mirror.getBoundingClientRect();
  var markerRect = marker.getBoundingClientRect();
  var left = markerRect.left - mirrorRect.left;
  var top  = markerRect.top  - mirrorRect.top;
  document.body.removeChild(mirror);

  return {
    left:       ta.offsetLeft + left - ta.scrollLeft,
    top:        ta.offsetTop  + top  - ta.scrollTop,
    lineHeight: parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.2)
  };
}

// Show the marker at the character position named in a Cypher error message,
// with the full error text as its native hover tooltip. No-op (and hides any
// existing marker) if the message doesn't name a position.
function showCypherErrorMarker(errMsg) {
  var ta   = document.getElementById('cypher-input');
  var wrap = ta && ta.parentElement; // the position:relative div holding textarea + autocomplete
  if (!ta || !wrap) return;
  var offset = _parseCypherErrorOffset(errMsg);
  if (offset === null) { hideCypherErrorMarker(); return; }

  var pos    = _cypherTextareaCaretPixelPos(ta, offset);
  var marker = document.getElementById('cypher-error-marker');
  if (!marker) return;
  if (marker.parentElement !== wrap) wrap.appendChild(marker);
  marker.title         = errMsg;
  marker.style.left    = pos.left + 'px';
  marker.style.top     = pos.top + 'px';
  marker.style.height  = pos.lineHeight + 'px';
  marker.style.display = 'block';
}

function hideCypherErrorMarker() {
  var marker = document.getElementById('cypher-error-marker');
  if (marker) marker.style.display = 'none';
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
  hideCypherErrorMarker(); // the old error position is no longer meaningful once the text changes
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
  // Consecutive dots — but NOT a Cypher variable-length relationship range like
  // [*1..2], [*..5], [*3..], which is valid syntax (the ".." there is a range
  // separator, not a property-access typo). Strip those out first so e.g.
  // "GeneticChange*1..2" doesn't false-positive as "consecutive dots".
  var noRanges = stripped.replace(/\*\s*\d*\.\.\d*/g, '');
  if (/\w\.\.[\w]/.test(noRanges))
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
  // The "hub" side is whichever endpoint role — source or target, across ALL
  // returned edges — has FEWER distinct nodes. For a classic single-hub query
  // (MATCH (hub)-[r]-(n) ...) that's exactly one node, so behavior matches the
  // old highest-degree-single-node approach. But when a query legitimately
  // returns several hub-like nodes on one side (e.g. an ontology-expanded set
  // of processes, each with many activators pointing at it), ALL of them now
  // become the combined hub — previously only the single highest-degree node
  // was kept and every edge to the OTHER hub-like nodes was silently dropped.
  var srcIdSet = new Set(), tgtIdSet = new Set();
  gEdges.forEach(function(e) {
    srcIdSet.add(String(e.startNodeId));
    tgtIdSet.add(String(e.endNodeId));
  });
  var anchorSet = (srcIdSet.size <= tgtIdSet.size) ? srcIdSet : tgtIdSet;
  var nodeById = {};
  gNodes.forEach(function(n) { nodeById[String(n.id)] = n; });

  var _skipL = { Entity:1, Named:1, Validated:1, Object:1 };
  function primaryLabel(node) {
    var ls = (node || {}).labels || [];
    return ls.find(function(l) { return !_skipL[l]; }) || ls[0] || 'Unknown';
  }

  var anchorName;
  if (anchorSet.size <= 1) {
    var _onlyId = anchorSet.size ? anchorSet.values().next().value : null;
    var _p = (nodeById[_onlyId] || {}).properties || {};
    anchorName = _p.Name || _p.name || _onlyId || 'Hub';
  } else {
    // Several hub-side nodes — describe them collectively (e.g. "49 CellProcess")
    // instead of arbitrarily naming just one and hiding the rest.
    var _hubLabelCounts = {};
    anchorSet.forEach(function(id) {
      var lbl = primaryLabel(nodeById[id]);
      _hubLabelCounts[lbl] = (_hubLabelCounts[lbl] || 0) + 1;
    });
    anchorName = Object.keys(_hubLabelCounts).sort().map(function(l) {
      return _hubLabelCounts[l] + ' ' + l;
    }).join(' + ') + ' (' + anchorSet.size + ' nodes)';
  }

  // ── Aggregate groups + collect raw edge/node metadata ────────────────────
  // upstream key  = "entityLabel|||effect|||relType"
  // downstream key= "relType|||effect|||entityLabel"
  var upAgg = {}, downAgg = {};
  var upMeta = {}, downMeta = {};   // key → { edgeCount, nodeSet, edgeIdSet }

  gEdges.forEach(function(e) {
    var src = String(e.startNodeId), tgt = String(e.endNodeId);
    if (src === tgt) return;
    var srcIsAnchor = anchorSet.has(src), tgtIsAnchor = anchorSet.has(tgt);
    if (srcIsAnchor === tgtIsAnchor) return; // both or neither on the hub side — ambiguous, skip
    var isDown = srcIsAnchor, isUp = tgtIsAnchor;
    var otherId  = isDown ? tgt : src;
    var anchorId = isDown ? src : tgt;  // the SPECIFIC hub-side node this edge touches
    var other    = nodeById[otherId];
    if (!other) return;
    var label   = primaryLabel(other);
    var effect  = (e.properties || {}).Effect || 'unknown';
    var relType = e.type || 'Unknown';
    var rv      = valueProp ? (e.properties || {})[valueProp] : null;
    var value   = (rv != null && isFinite(parseFloat(rv)) && parseFloat(rv) > 0) ? parseFloat(rv) : 1;
    var eid     = String(e.id !== undefined ? e.id : (e.elementId || (src+'_'+tgt)));
    // Reference count is tracked independently of `value` above (which follows
    // whatever "Value prop" the user picked) so the tooltip can always show the
    // true literature reference sum regardless of that setting.
    var refsN = parseFloat((e.properties || {}).RelationNumberOfReferences);
    if (!isFinite(refsN) || refsN < 0) refsN = 0;
    if (isUp) {
      var k = label+'|||'+effect+'|||'+relType;
      upAgg[k] = (upAgg[k] || 0) + value;
      if (!upMeta[k]) upMeta[k] = { edgeCount:0, refSum:0, nodeSet:new Set(), otherSet:new Set(), edgeIdSet:new Set() };
      upMeta[k].edgeCount++; upMeta[k].refSum += refsN;
      upMeta[k].nodeSet.add(otherId); upMeta[k].nodeSet.add(anchorId);
      upMeta[k].otherSet.add(otherId);
      upMeta[k].edgeIdSet.add(eid);
    } else {
      var k = relType+'|||'+effect+'|||'+label;
      downAgg[k] = (downAgg[k] || 0) + value;
      if (!downMeta[k]) downMeta[k] = { edgeCount:0, refSum:0, nodeSet:new Set(), otherSet:new Set(), edgeIdSet:new Set() };
      downMeta[k].edgeCount++; downMeta[k].refSum += refsN;
      downMeta[k].nodeSet.add(otherId); downMeta[k].nodeSet.add(anchorId);
      downMeta[k].otherSet.add(otherId);
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
  // Append tooltip titles separately so linkSel stays as <path> selection.
  // A single rendered ribbon can merge several upAgg/downAgg groups (e.g. the
  // same entity label + effect but different relation types all feeding the
  // same node-to-node link) — d._gks lists exactly which ones, so sum their
  // relation counts and reference counts across all of them.
  linkSel.append('title').text(function(d) {
    var relCount = 0, refSum = 0;
    (d._gks || []).forEach(function(gk) {
      var meta = upMeta[gk] || downMeta[gk];
      if (meta) { relCount += meta.edgeCount; refSum += meta.refSum; }
    });
    var lines = [
      d.source.name + ' → ' + d.target.name,
      'Number of relations: ' + relCount.toLocaleString(),
      'Number of references: ' + Math.round(refSum).toLocaleString()
    ];
    // Only show the width-driving "Value" separately when it's not just the
    // reference sum again (i.e. the user picked a different "Value prop").
    if (valueProp && valueProp !== 'RelationNumberOfReferences') {
      lines.push('Value (' + valueProp + '): ' + d.value.toFixed(0));
    }
    return lines.join('\n');
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
  // Append tooltip titles separately so nodeSel stays as <rect> selection.
  // Entity-label buckets (e.g. "Protein") and the hub node itself represent
  // MANY real graph nodes collapsed into one Sankey box — show how many.
  // Relation-type/effect buckets aren't a set of graph nodes, so they just
  // show their name as before.
  function _sankeyNodeCount(key) {
    if (key === '__anchor__') return anchorSet.size;
    if (key.indexOf('up_e_') === 0 || key.indexOf('down_e_') === 0) {
      var ids = new Set();
      (nodeKeyGroups[key] || []).forEach(function(gk) {
        var meta = upMeta[gk] || downMeta[gk];
        if (meta) meta.otherSet.forEach(function(id) { ids.add(id); });
      });
      return ids.size;
    }
    return null;
  }
  nodeSel.append('title').text(function(d){
    var count = _sankeyNodeCount(d.key);
    return count == null ? d.name : (d.name + '\n' + count.toLocaleString() + ' node' + (count === 1 ? '' : 's'));
  });

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
  // Deliberately NOT using `new Blob(...)` here: some browser extensions
  // (observed with ExpressVPN's geolocation-spoofing feature) monkey-patch
  // the global Blob constructor to inject their own <script> into any Blob
  // created with type 'image/svg+xml', corrupting the exported file so it
  // fails to render when opened. A data: URI never touches Blob at all, so
  // it sidesteps that interference entirely.
  // An <svg> living inside an HTML page doesn't need an xmlns attribute (the
  // context already establishes it), so outerHTML omits it — but a standalone
  // .svg file needs the explicit namespace to be recognized as SVG rather
  // than falling back to a generic XML viewer. Add it if not already present.
  var outerSvg = svgEl.outerHTML;
  if (outerSvg.indexOf('xmlns=') === -1) {
    outerSvg = outerSvg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  var svgText = '<?xml version="1.0" standalone="no"?>\r\n' + outerSvg;
  var a = document.createElement('a');
  a.href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
  a.download = 'sankey.svg';
  a.click();
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
      style: {
        'border-width': 3, 'border-color': '#FFD700', 'border-opacity': 1,
        'overlay-color': '#FFD700', 'overlay-opacity': 0.25, 'overlay-padding': 8
      }
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
      // Previously just opacity+1px width — nearly invisible against an already
      // near-opaque line. Now a clear gold "halo" matching node:selected, plus a
      // real color/width jump so a table-driven selection is obvious at a glance.
      selector: 'edge:selected',
      style: {
        'opacity': 1,
        'width': function(ele) { return ele.data('thickness') + 2; },
        'line-color': '#FFD700',
        'target-arrow-color': '#FFD700',
        'overlay-color': '#FFD700', 'overlay-opacity': 0.25, 'overlay-padding': 6
      }
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
  // Snapshot the pre-merge state so this is undoable via the standard Undo
  // button, same as every other graph-mutating operation in the app. Without
  // this, "add to graph" (including the agent's mode:"add" render, e.g. "add
  // these ontology ancestors to the graph") left no way to revert other than
  // manually deleting the added nodes or clearing and re-running from scratch.
  pushUndo();

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
  // Fresh graph data means old edge ids no longer exist — drop any stale
  // table-selection state instead of risking it lingering onto unrelated rows.
  _selectedTableEdgeIds = new Set();
  _selectedTableNodeIds = new Set();

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

async function runQuery(mergeIntoExisting) {
  var query = getCypherQuery().trim();
  if (!query) return;
  currentQuery = query;
  hideCypherErrorMarker(); // clear any marker from a previous failed run

  // ── Pre-execution count check ──────────────────────────────
  var _limitMatch = query.match(/LIMIT\s+(\d+)\s*$/i);
  var _limitVal   = _limitMatch ? parseInt(_limitMatch[1], 10) : Infinity;
  var _edgeCount  = NaN;
  var _tooLarge   = false;

  setProgressMsg('\u23f3 Counting matching relations\u2026');

  // Run the COUNT(*) version of the query with no client-side timeout so we
  // always get the real number (the server enforces its own Neo4j timeout).
  try {
    var _countOpts = {
      method:  'POST',
      headers: { 'Content-Type': 'application/json',
                 'Authorization': authToken ? 'Bearer ' + authToken : '' },
      body: JSON.stringify({ query: query }),
    };
    var _cRes    = await fetch('/api/graph/count-query', _countOpts);
    var countRes = await _cRes.json().catch(function() { return {}; });
    if (countRes && typeof countRes.edgeCount === 'number') {
      _edgeCount = countRes.edgeCount;
      appendCypherHistory(query, _edgeCount);
    }
  } catch (countErr) {
    console.warn('count-query failed:', countErr.message);
  }
  setProgressMsg(null);

  // Intercept when we have a real count >= 1000, or when count failed but the
  // query has an explicit LIMIT >= 1000 (safe conservative assumption).
  _tooLarge = (_edgeCount >= 1000) ||
              (isNaN(_edgeCount) && _limitVal >= 1000);

  if (_tooLarge) {
    _largeQueryPending = query;
    var _countStr = isFinite(_edgeCount) ? _edgeCount.toLocaleString() : 'over 1,000';
    document.getElementById('large-query-msg').textContent =
      'The query returns ' + _countStr + ' edges. ' +
      'Results with more than 1,000 edges cannot be displayed in the App. ' +
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
      if (data.table && data.nodes.length === 0 && data.edges.length === 0) {
        showQueryResultTable(data.table);
      } else if (mergeIntoExisting && cy && cy.elements().length) {
        // "Add to graph" — merge into whatever's already on the canvas instead of
        // replacing it. mergeGraphData() dedupes nodes by URN and edges by id, so
        // re-adding something already present is a harmless no-op.
        hideQueryResultTable();
        mergeGraphData(data);
        if (document.getElementById('table-view').style.display !== 'none') {
          await loadTableData();
        }
      } else {
        updateCurrentTabName(shortQ);
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
      showCypherErrorMarker(err.message); // points at the offending character, if the error names one
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

// All history rows are fetched once per dialog open and filtered/sorted entirely
// client-side (search text, date range, dedupe, sort) — fast even for hundreds of
// entries, and avoids round-tripping to the server on every keystroke.
var _chAllRows   = [];      // raw rows from the server, each with a parsed timestamp
var _chRange     = 'all';   // 'all' | 'today' | '7d' | '30d'
var _chSortField = 'date';  // 'date' | 'count'
var _chSortDir   = 'desc';  // 'asc' | 'desc'

// Persists the scroll position in the history list across close/reopen (and
// across browser sessions, since it's localStorage) so reopening the dialog
// drops you back exactly where you left off, instead of always at the top.
var CH_SCROLL_KEY = 'cypher_history_scroll_v1';
var _chScrollListenerAttached = false;

// Which element actually scrolls depends on CSS layout details (.modal-box
// itself has overflow-y:auto from the shared modal class, and the inner
// #ch-scroll-container is a flex child that may or may not end up being the
// one that truly overflows) — rather than betting on one, track and restore
// against BOTH candidates so this keeps working regardless of which one the
// browser actually scrolls.
function _chScrollTargets() {
  var inner = document.getElementById('ch-scroll-container');
  var outer = inner ? inner.closest('.modal-box') : null;
  return [inner, outer].filter(Boolean);
}

// Guards against a browser quirk confirmed via diagnostic logging: whenever
// the row list is rebuilt (tbody.innerHTML cleared, which happens both when
// closing isn't the issue — it's the START of openCypherHistory(), which
// wipes the tbody before re-fetching) the container's scrollHeight collapses
// to ~0. Since its scrollTop was still sitting at the old (larger) value, the
// browser CLAMPS it down to the new max — usually 0 — and fires a 'scroll'
// event as a side effect. That spurious event was being saved as the "real"
// position, overwriting the correct value an instant before _chRestoreScroll()
// even ran. This flag suppresses saving during that whole rebuild sequence;
// it's released only once _chRestoreScroll() has actually applied the
// restored value (see below), so real user scrolling is never mistakenly
// suppressed once the dialog has settled.
var _chSuppressSave = false;

function _chSaveScroll(evt) {
  if (_chSuppressSave) return;
  var el = (evt && evt.target) || document.getElementById('ch-scroll-container');
  if (!el) return;
  try { localStorage.setItem(CH_SCROLL_KEY, String(el.scrollTop)); } catch(e) {}
}

function _chCloseModal() {
  _chSuppressSave = true;
  document.getElementById('cypher-history-modal').style.display = 'none';
  // Belt-and-suspenders: also suppress across the close itself in case some
  // browsers reset scrollTop on display:none. Released shortly after; the
  // NEXT openCypherHistory() call re-engages the guard again regardless.
  setTimeout(function() { _chSuppressSave = false; }, 150);
}

function _chRestoreScroll() {
  var saved = 0;
  try { saved = parseInt(localStorage.getItem(CH_SCROLL_KEY), 10) || 0; } catch(e) {}
  // Two rAFs so this runs after the browser has actually laid out and painted
  // the freshly-rendered rows — setting scrollTop before that can silently
  // no-op if scrollHeight hasn't been recomputed yet.
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      _chScrollTargets().forEach(function(el) { el.scrollTop = saved; });
      _chSuppressSave = false;  // layout has settled — re-arm real scroll saving
    });
  });
}

async function openCypherHistory() {
  var modal  = document.getElementById('cypher-history-modal');
  var status = document.getElementById('cypher-history-status');
  // Engage the guard BEFORE wiping tbody — clearing it collapses scrollHeight,
  // which clamps the (still-stale) scrollTop and fires a spurious 'scroll'
  // event that must not be saved as the real position. Released by
  // _chRestoreScroll() once the new content is laid out and the saved
  // position has actually been re-applied.
  _chSuppressSave = true;
  document.getElementById('cypher-history-tbody').innerHTML = '';
  document.getElementById('ch-search-input').value = '';
  document.getElementById('ch-dedupe').checked = false;
  _chRange     = 'all';
  _chSortField = 'date';
  _chSortDir   = 'desc';
  status.textContent = 'Loading…';
  modal.style.display = 'flex';

  if (!_chScrollListenerAttached) {
    _chScrollTargets().forEach(function(el) { el.addEventListener('scroll', _chSaveScroll); });
    _chScrollListenerAttached = true;
  }

  try {
    var data = await api('/api/cypher/history');
    _chAllRows = (data.rows || []).map(function(r) {
      var t = new Date(r.date).getTime();
      return { date: r.date, query: r.query, count: r.count, _time: isNaN(t) ? 0 : t };
    });
    _chUpdateChips();
    _chUpdateSortHeaders();
    _chRender();
    // Restore only right after the initial (default filters) render — the
    // saved position is a raw pixel offset, so it only makes sense against
    // the same "All time / Date desc / no search" list it was recorded from.
    _chRestoreScroll();
  } catch(e) {
    status.textContent = 'Error loading history: ' + e.message;
    _chSuppressSave = false;  // _chRestoreScroll() never ran to release it — don't stay stuck suppressed
  }
}

function _chSetRange(range) {
  _chRange = range;
  _chUpdateChips();
  _chRender();
}

function _chUpdateChips() {
  document.querySelectorAll('#ch-date-chips .ch-chip').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-range') === _chRange);
  });
}

function _chSetSort(field) {
  if (_chSortField === field) {
    _chSortDir = (_chSortDir === 'asc') ? 'desc' : 'asc';
  } else {
    _chSortField = field;
    _chSortDir   = 'desc';  // newest-first / highest-first by default when switching columns
  }
  _chUpdateSortHeaders();
  _chRender();
}

function _chUpdateSortHeaders() {
  var arrow   = _chSortDir === 'asc' ? ' ▲' : ' ▼';
  var dateTh  = document.getElementById('ch-th-date');
  var countTh = document.getElementById('ch-th-count');
  dateTh.textContent  = 'Date'         + (_chSortField === 'date'  ? arrow : '');
  countTh.textContent = 'Result Count' + (_chSortField === 'count' ? arrow : '');
}

function _chEscHtml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Wraps every case-insensitive occurrence of the search term in <mark class="ch-hit">.
// Escapes both sides identically first so highlighting can never re-inject raw HTML
// from the stored query text.
function _chHighlight(text, term) {
  var escaped = _chEscHtml(text);
  if (!term) return escaped;
  var escTerm = _chEscHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escTerm) return escaped;
  var re = new RegExp('(' + escTerm + ')', 'ig');
  return escaped.replace(re, '<mark class="ch-hit">$1</mark>');
}

function _chRender() {
  var status = document.getElementById('cypher-history-status');
  var tbody  = document.getElementById('cypher-history-tbody');
  var search = (document.getElementById('ch-search-input').value || '').trim().toLowerCase();
  var dedupe = document.getElementById('ch-dedupe').checked;

  var rows  = _chAllRows;
  var total = rows.length;

  // ── Date range filter ──────────────────────────────────────────────────────
  if (_chRange !== 'all') {
    var cutoff;
    if (_chRange === 'today') {
      var d0 = new Date(); d0.setHours(0, 0, 0, 0);
      cutoff = d0.getTime();
    } else if (_chRange === '7d')  cutoff = Date.now() - 7  * 24 * 3600 * 1000;
    else if (_chRange === '30d')   cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    if (cutoff !== undefined) rows = rows.filter(function(r) { return r._time >= cutoff; });
  }

  // ── Search filter ──────────────────────────────────────────────────────────
  if (search) {
    rows = rows.filter(function(r) { return (r.query || '').toLowerCase().indexOf(search) !== -1; });
  }

  // ── Dedupe: keep only the most recent run of each distinct query text ──────
  if (dedupe) {
    var latestByQuery = {};
    rows.forEach(function(r) {
      var existing = latestByQuery[r.query];
      if (!existing || r._time > existing._time) latestByQuery[r.query] = r;
    });
    rows = Object.keys(latestByQuery).map(function(k) { return latestByQuery[k]; });
  }

  var shown = rows.length;

  // ── Sort ──────────────────────────────────────────────────────────────────
  rows = rows.slice().sort(function(a, b) {
    var av = _chSortField === 'count' ? (Number(a.count) || 0) : a._time;
    var bv = _chSortField === 'count' ? (Number(b.count) || 0) : b._time;
    return _chSortDir === 'asc' ? (av - bv) : (bv - av);
  });

  status.textContent = total === 0
    ? 'No history yet.'
    : 'Showing ' + shown.toLocaleString() + ' of ' + total.toLocaleString() + ' quer' + (total === 1 ? 'y' : 'ies') +
      (shown === 0 ? ' — no matches.' : '');

  tbody.innerHTML = '';
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

    // Query text — clicking loads into Graph editor (default); search hits highlighted
    var tdQuery = document.createElement('td');
    tdQuery.innerHTML = _chHighlight(r.query, search);
    tdQuery.style.cssText = 'padding:5px 10px;border-bottom:1px solid #2a3050;font-family:monospace;font-size:12px;word-break:break-all;cursor:pointer;color:#e2e8f0;vertical-align:top';
    tdQuery.title = 'Click to open in Graph editor';
    tdQuery.addEventListener('click', function() {
      var ta = document.getElementById('cypher-input');
      if (ta) { ta.value = r.query; onCypherInput(ta); focusCypherInput(); }
      _chCloseModal();
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
      _chCloseModal();
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
}

// Balanced-bracket/quote auto-insertion for the Cypher editor: (), [], {},
// '' and "". Quotes get one extra guard brackets don't need — auto-close is
// skipped when the character right before the cursor is a word character,
// since Cypher entity names routinely contain a bare apostrophe ("Raynaud's
// phenomenon") and auto-closing on every such apostrophe would fight normal
// typing instead of helping. Typing a quote at the start of a token — after
// "(", ",", "=", whitespace, or the start of the query — still auto-closes;
// typing one right after a letter/digit (the "'s" case) does not.
var _autoPairOpenToClose = { '(': ')', '[': ']', '{': '}', "'": "'", '"': '"' };
var _autoPairCloseToOpen = { ')': '(', ']': '[', '}': '{', "'": "'", '"': '"' };
var _wordCharRe = /[A-Za-z0-9_]/;

function handleQueryKeydown(e) {
  var ta = e.target;

  // Autocomplete keyboard navigation
  if (_acHandleKey(e)) return;

  // Wrap selected text in backticks when pressed with an active selection.
  // e.g. double-click "some name" then press ` → `some name`
  // (quotes with a selection are handled by the unified pair logic below.)
  if (e.key === '`') {
    var start = ta.selectionStart, end = ta.selectionEnd;
    if (start !== end) {
      e.preventDefault();
      var selected = ta.value.substring(start, end);
      ta.setRangeText('`' + selected + '`', start, end, 'end');
      ta.selectionStart = start + 1;
      ta.selectionEnd   = start + 1 + selected.length;
      onCypherInput(ta);
      return;
    }
  }

  // Typing a closer/quote that's already sitting immediately ahead of the
  // cursor (almost certainly one just auto-inserted below) steps past it
  // instead of inserting a redundant duplicate — covers both distinct pairs
  // like "(x|)" + ")" and self-pairing quotes like "'BRCA1|'" + "'".
  // Checked BEFORE the auto-open logic below since quotes are the same
  // character on both sides — without this, closing a quote you just opened
  // would otherwise be mistaken for opening a brand-new pair.
  if (_autoPairCloseToOpen[e.key] && ta.selectionStart === ta.selectionEnd) {
    var cPos = ta.selectionStart;
    if (ta.value[cPos] === e.key) {
      e.preventDefault();
      ta.selectionStart = ta.selectionEnd = cPos + 1;
      return;
    }
  }

  // Typing an opening bracket or quote auto-inserts its matching closer, with
  // the cursor landing between the pair. With an active selection, wraps the
  // selection instead — e.g. select n:CellProcess then press ( → (n:CellProcess),
  // or select BRCA1 then press ' → 'BRCA1'.
  if (_autoPairOpenToClose[e.key]) {
    var bStart = ta.selectionStart, bEnd = ta.selectionEnd;
    var open  = e.key, close = _autoPairOpenToClose[open];
    var isQuote = (open === "'" || open === '"');
    if (bStart === bEnd && isQuote) {
      var prevForQuote = ta.value[bStart - 1];
      if (prevForQuote && _wordCharRe.test(prevForQuote)) {
        return; // mid-word apostrophe/quote (e.g. "Raynaud's") — insert plainly, no auto-close
      }
    }
    e.preventDefault();
    if (bStart !== bEnd) {
      var bSelected = ta.value.substring(bStart, bEnd);
      ta.setRangeText(open + bSelected + close, bStart, bEnd, 'end');
      ta.selectionStart = bStart + 1;
      ta.selectionEnd   = bStart + 1 + bSelected.length;
    } else {
      ta.setRangeText(open + close, bStart, bEnd, 'end');
      ta.selectionStart = ta.selectionEnd = bStart + 1; // cursor lands between the pair
    }
    onCypherInput(ta);
    return;
  }

  // Backspace immediately inside an empty auto-closed pair — e.g. "(|)" or
  // "'|'" with nothing typed between — removes both characters together
  // instead of leaving the closer stranded.
  if (e.key === 'Backspace' && ta.selectionStart === ta.selectionEnd) {
    var delPos    = ta.selectionStart;
    var prevChar  = ta.value[delPos - 1];
    var nextChar  = ta.value[delPos];
    if (prevChar !== undefined && _autoPairOpenToClose[prevChar] === nextChar) {
      e.preventDefault();
      ta.setRangeText('', delPos - 1, delPos + 1, 'end');
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
  nodeRows = [];
  _selectedTableEdgeIds = new Set();
  _selectedTableNodeIds = new Set();
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
  _syncTableSelectionFromGraph();
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
  // Escapes both quote characters (not just "), so this is safe to use
  // inside single-quoted attributes too, not only double-quoted ones —
  // see the matching note on _esc() above for the exploit shape this closes.
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

  var _hasDataForView = tableViewMode === 'node' ? graphData.nodes.length > 0 : graphData.edges.length > 0;
  if (view === 'table' && _hasDataForView) {
    if (tableViewMode === 'relation') {
      await loadRelationData();
    } else if (tableViewMode === 'node') {
      if (nodeRows.length > 0) {
        renderTableHeader();
        renderTableRows(nodeRows);
      } else {
        await loadNodeData();
      }
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
      var _src = _currentTableSourceRows();
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
  var relEl  = document.getElementById('mc-view-relation');
  var refEl  = document.getElementById('mc-view-reference');
  var nodeEl = document.getElementById('mc-view-node');
  if (relEl)  relEl.textContent  = (mode === 'relation') ? '✓' : '';
  if (refEl)  refEl.textContent  = (mode === 'reference') ? '✓' : '';
  if (nodeEl) nodeEl.textContent = (mode === 'node') ? '✓' : '';
  // Also clear the Graph checkmark when in table mode
  var grEl = document.getElementById('mc-view-graph');
  if (grEl) grEl.textContent = '';
}

async function setTableViewMode(mode) {
  tableViewMode = mode;
  syncTableModeIndicator(mode);
  columnWidths = null;
  var _hasData = mode === 'node' ? graphData.nodes.length > 0 : graphData.edges.length > 0;
  if (document.getElementById('table-view').style.display !== 'none' && _hasData) {
    if (mode === 'relation') {
      loadRelationData();
    } else if (mode === 'node') {
      if (nodeRows.length > 0) {
        renderTableHeader();
        renderTableRows(nodeRows);
      } else {
        await loadNodeData();   // await so RAF fires after data is rendered
      }
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

// Returns whichever row array backs the currently active table mode —
// centralizes the 3-way branch used throughout sorting/filtering/reload code.
function _currentTableSourceRows() {
  if (tableViewMode === 'relation') return relationRows;
  if (tableViewMode === 'node')     return nodeRows;
  return tableRows;
}

// Reloads the table for whichever mode is currently active. Used after any
// graph mutation (column changes, expand/connect actions, etc.) that could
// have invalidated the cached rows.
function _reloadCurrentTableMode() {
  if (tableViewMode === 'relation')    { loadRelationData(); }
  else if (tableViewMode === 'node')   { nodeRows = []; loadNodeData(); }
  else                                 { tableRows = []; loadTableData(); }
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

// ─── Nodes table view ─────────────────────────────────────────────────────────
// One row per node in the current graph. Base columns (Name/Node Type/URN/
// NodeID) come straight from graphData; additional property columns
// (source:'node_col') are Neo4j-native OR Postgres node/attr properties — both
// end up merged into node.properties by /api/nodes/load-properties, the same
// endpoint the Relations/References node_prop columns already use, so reading
// them at render time is uniform regardless of where the value came from.
async function loadNodeData() {
  var msg = document.getElementById('table-loading-msg');

  var nodeColCols = columnDefs.filter(function(c) { return c.source === 'node_col' && c.visible; });
  if (nodeColCols.length > 0) {
    var npNodeIds = [], npUrns = [];
    graphData.nodes.forEach(function(n) {
      var nid = n.properties && n.properties.NodeID != null ? String(n.properties.NodeID) : null;
      var urn = n.properties && n.properties.URN ? String(n.properties.URN) : null;
      if (nid && /^-?\d+$/.test(nid)) npNodeIds.push(nid);
      else if (urn) npUrns.push(urn);
    });
    if (npNodeIds.length || npUrns.length) {
      var propNames = nodeColCols.map(function(c) { return c.dbField; });
      try {
        msg.style.display = 'inline';
        msg.textContent = 'Loading node properties…';
        var npResult = await api('/api/nodes/load-properties', { nodeIds: npNodeIds, urns: npUrns, properties: propNames });
        var npById = npResult.byNodeId || {};
        var npByUrn = npResult.byUrn   || {};
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
        });
      } catch(e) {
        console.warn('Node property fetch failed:', e.message);
      }
      msg.style.display = 'none';
    }
  }

  function nodeLabel(node) {
    if (!node) return '?';
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

  nodeRows = graphData.nodes.map(function(n) {
    var row = {
      nodeId:     n.id,   // matches the live Cytoscape element id — used for selection sync
      elementId:  n.elementId || n.id,
      name:       nodeLabel(n),
      nodeType:   (n.labels && n.labels[0]) || '',
      urn:        (n.properties && n.properties.URN != null) ? String(n.properties.URN) : '',
      nodeIdProp: (n.properties && n.properties.NodeID != null) ? String(n.properties.NodeID) : '',
    };
    columnDefs.forEach(function(col) {
      if (col.source === 'node_col') {
        row[col.key] = (n.properties && n.properties[col.dbField] != null) ? String(n.properties[col.dbField]) : '';
      }
    });
    return row;
  });

  renderTableHeader();
  renderTableRows(nodeRows);
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

// Columns actually shown for the currently active table mode — the single
// source of truth used by header/row rendering AND by drag-reorder, so
// dragged indices always line up with what the header physically shows.
function _visibleColsForMode() {
  return columnDefs.filter(function(c) {
    if (!c.visible) return false;
    if (tableViewMode === 'relation') return c.source === 'graph' || c.source === 'neo4j' || c.source === 'node_prop';
    if (tableViewMode === 'node')     return c.source === 'node_graph' || c.source === 'node_col';
    return c.source === 'graph' || c.source === 'reference' || c.source === 'scopus_data' || c.source === 'node_prop';
  });
}

function renderTableHeader() {
  var thead = document.querySelector('#data-table thead tr');
  if (!thead) return;
  var visCols = _visibleColsForMode();
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
  var visCols = _visibleColsForMode();
  var tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  rows.forEach(function(row, idx) {
    var tr = document.createElement('tr');
    if (row.edgeId) {
      tr.dataset.edgeId = row.edgeId;
      if (_selectedTableEdgeIds.has(row.edgeId)) tr.classList.add('table-row-selected');
      tr.title = 'Click to select (Ctrl/Cmd = add, Shift = range) · Right-click to edit properties';
      tr.style.cursor = 'context-menu';
      tr.addEventListener('contextmenu', function(evt) {
        evt.preventDefault();
        var edge = graphData.edges.find(function(e) { return e.id === row.edgeId; });
        var props = edge ? edge.properties : {};
        var name = row.relationType + ': ' + row.regulator + ' → ' + row.target;
        // In the References table view, each row is ONE reference of the relation
        // (rows share edgeId but differ in _ref_*) — pass its unique_id through so
        // "Edit properties" can jump straight to that specific reference instead
        // of always showing the first one.
        showContextMenu(evt.clientX, evt.clientY, 'edge', row.edgeId, row.elementId, name, props, row.relId, row['_ref_unique_id']);
      });
      tr.addEventListener('click', function(evt) { _handleTableRowClick(rows, idx, evt); });
    } else if (row.nodeId) {
      tr.dataset.nodeId = row.nodeId;
      if (_selectedTableNodeIds.has(row.nodeId)) tr.classList.add('table-row-selected');
      tr.title = 'Click to select (Ctrl/Cmd = add, Shift = range) · Right-click to edit properties';
      tr.style.cursor = 'context-menu';
      tr.addEventListener('contextmenu', function(evt) {
        evt.preventDefault();
        var node = graphData.nodes.find(function(n) { return n.id === row.nodeId; });
        var props = node ? node.properties : {};
        showContextMenu(evt.clientX, evt.clientY, 'node', row.nodeId, row.elementId, row.name, props, '');
      });
      tr.addEventListener('click', function(evt) { _handleTableRowClick(rows, idx, evt); });
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

// ─── Table ⇄ graph selection sync ──────────────────────────────────────────────
// Clicking a table row selects the same edge in the Cytoscape graph (and vice
// versa) — Ctrl/Cmd+click toggles a row into/out of the selection, Shift+click
// selects a contiguous range, a plain click replaces the selection with just
// that row. Rows sharing an edgeId (the References view can have several rows
// per edge, one per reference) are always selected/deselected together.
function _handleTableRowClick(rows, idx, evt) {
  var row = rows[idx];
  if (!row) return;
  // Nodes-view rows carry nodeId instead of edgeId — same click semantics,
  // just against the node selection set / cy nodes instead of edges.
  var isNodeRow = !!row.nodeId;
  var rowKey    = isNodeRow ? 'nodeId' : 'edgeId';
  if (!row[rowKey]) return;
  var selSet = isNodeRow ? _selectedTableNodeIds : _selectedTableEdgeIds;

  if (evt.shiftKey && _lastClickedTableRowIdx != null && rows[_lastClickedTableRowIdx]) {
    // Standard range-select: REPLACE the whole selection with the span between the
    // anchor (the last row clicked WITHOUT Shift) and this row — not additive, so
    // shift-clicking a different row re-ranges from the same anchor instead of
    // accumulating every range ever shift-clicked. The anchor itself doesn't move,
    // so repeated Shift+clicks keep ranging from that same first-clicked row.
    var lo = Math.min(_lastClickedTableRowIdx, idx);
    var hi = Math.max(_lastClickedTableRowIdx, idx);
    var rangeIds = new Set();
    for (var i = lo; i <= hi; i++) {
      if (rows[i] && rows[i][rowKey]) rangeIds.add(rows[i][rowKey]);
    }
    selSet = rangeIds;
  } else if (evt.ctrlKey || evt.metaKey) {
    if (selSet.has(row[rowKey])) selSet.delete(row[rowKey]);
    else selSet.add(row[rowKey]);
    _lastClickedTableRowIdx = idx;
  } else {
    selSet = new Set([row[rowKey]]);
    _lastClickedTableRowIdx = idx;
  }

  if (isNodeRow) _selectedTableNodeIds = selSet;
  else           _selectedTableEdgeIds = selSet;

  _applyTableRowSelectionClasses();
  _syncGraphSelectionFromTable();
}

// Toggles the .table-row-selected class on already-rendered rows without a
// full re-render — cheap enough to call after every selection change.
function _applyTableRowSelectionClasses() {
  var tbody = document.getElementById('table-body');
  if (!tbody) return;
  Array.prototype.forEach.call(tbody.querySelectorAll('tr[data-edge-id]'), function(tr) {
    tr.classList.toggle('table-row-selected', _selectedTableEdgeIds.has(tr.dataset.edgeId));
  });
  Array.prototype.forEach.call(tbody.querySelectorAll('tr[data-node-id]'), function(tr) {
    tr.classList.toggle('table-row-selected', _selectedTableNodeIds.has(tr.dataset.nodeId));
  });
}

// Guards against re-entrancy between the two sync functions below. Cytoscape
// fires 'select'/'unselect' synchronously, so cy.elements().unselect() inside
// _syncGraphSelectionFromTable() — when something was already selected — used
// to trigger updateSelectionInfo() -> _syncTableSelectionFromGraph() mid-call,
// which read cy's selection at the moment everything had JUST been cleared and
// overwrote _selectedTableEdgeIds with an empty set BEFORE the loop below got a
// chance to re-select the new set. Net effect: Ctrl+click a second row and the
// first one's selection (and the graph's) would vanish instead of accumulating.
var _suppressTableGraphSync = false;

// Pushes the table's selected edge ids into the Cytoscape graph selection —
// this is the definitive selection, so it replaces whatever was selected before.
// The table's own state (_selectedTableEdgeIds, already set by the caller) must
// win regardless of whether the mirroring into cy fully succeeds — e.g. if an
// edgeId doesn't (yet) resolve to a live cy element, that should just mean the
// graph doesn't get that one selected, NOT that the table's selection gets
// wiped back to whatever cy happens to end up with. So the whole operation,
// including the final updateSelectionInfo() call, stays under the suppression
// guard — updateSelectionInfo() still refreshes the stats/menu display, it just
// can't let _syncTableSelectionFromGraph() overwrite the table's own state.
function _syncGraphSelectionFromTable() {
  if (!cy) return;
  _suppressTableGraphSync = true;
  try {
    cy.elements().unselect();
    var toSelect = cy.collection();
    // Which set drives the graph depends on which table is actually showing —
    // a node row click should select nodes, an edge/reference row click
    // should select edges, never both at once.
    var idSet = (tableViewMode === 'node') ? _selectedTableNodeIds : _selectedTableEdgeIds;
    idSet.forEach(function(id) {
      var e = cy.getElementById(id);
      if (e && e.length) toSelect = toSelect.union(e);
    });
    if (toSelect.length) toSelect.select();
    updateSelectionInfo();
  } finally {
    _suppressTableGraphSync = false;
  }
}

// Reads the graph's currently selected nodes/edges back into the table's
// selection state — called from updateSelectionInfo() so ANY graph selection
// change (click, box-select, Select All, agent-driven selection, etc.) keeps
// the table view showing the same rows highlighted, even while the table
// isn't the visible view — so switching to it never shows a stale selection.
// Both sets are always kept current regardless of the active table mode, so
// switching between Relations/References/Nodes never loses either kind.
function _syncTableSelectionFromGraph() {
  if (!cy || _suppressTableGraphSync) return;
  _selectedTableEdgeIds = new Set(cy.edges(':selected').map(function(e) { return e.id(); }));
  _selectedTableNodeIds = new Set(cy.nodes(':selected').map(function(n) { return n.id(); }));
  _applyTableRowSelectionClasses();
}

function filterTable(q) {
  var sourceRows = _currentTableSourceRows();
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
  var sourceRows = _currentTableSourceRows();
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

  var isNodeView = tableViewMode === 'node';

  // ── Graph columns — 'graph' for Relations/References, 'node_graph' for Nodes ──
  var graphList  = document.getElementById('col-graph-list');
  var graphTitle = document.getElementById('col-graph-title');
  if (graphTitle) graphTitle.textContent = isNodeView ? 'graph columns (Node view)' : 'graph columns (both views)';
  graphList.innerHTML = '';
  var graphSource = isNodeView ? 'node_graph' : 'graph';
  columnDefs.filter(function(c) { return c.source === graphSource; }).forEach(function(col) {
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
  if (refSection) refSection.style.display = (isRelationView || isNodeView) ? 'none' : '';
  if (!isRelationView && !isNodeView) {
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
  if (isRelationView || isNodeView || sdCols.length === 0) {
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

  if (!npNodeIds.length || isNodeView) {
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

  // ── Node columns (Node view only) — single column per property (no reg/tgt
  // pairing, since each row already IS one specific node). Sourced from the
  // same Postgres node/attr property list as "node properties (both views)"
  // above; Neo4j-native properties already on graphData.nodes show up here
  // too since /api/nodes/property-names reflects whatever attr rows exist.
  var nodeColSection = document.getElementById('col-nodecols-section');
  var nodeColList    = document.getElementById('col-nodecols-list');
  var nodeColNote     = document.getElementById('col-nodecols-note');
  if (nodeColList) nodeColList.innerHTML = '';
  if (nodeColNote) nodeColNote.textContent = '';

  if (!isNodeView || !npNodeIds.length) {
    if (nodeColSection) nodeColSection.style.display = 'none';
  } else {
    if (nodeColSection) nodeColSection.style.display = '';
    var existingNodeColMap = {};
    columnDefs.forEach(function(c) { if (c.source === 'node_col') existingNodeColMap[c.dbField] = c; });

    api('/api/nodes/property-names', { nodeIds: npNodeIds })
      .then(function(propNames) {
        if (!propNames || !propNames.length) {
          if (nodeColNote) nodeColNote.textContent = 'No properties found for nodes in this pathway.';
          return;
        }
        if (nodeColNote) nodeColNote.textContent = 'Data fetched automatically when the table loads.';
        propNames.forEach(function(propName) {
          if (!existingNodeColMap[propName]) {
            var nc = { key: 'nc_' + propName, label: propName, visible: false, source: 'node_col', dbField: propName };
            columnDefs.push(nc);
            existingNodeColMap[propName] = nc;
          }
          var col = existingNodeColMap[propName];
          var lb = document.createElement('label');
          lb.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap';
          lb.innerHTML = '<input type="checkbox" data-col-key="' + escHtml(col.key) + '"'
            + (col.visible ? ' checked' : '') + '> ' + escHtml(propName);
          nodeColList.appendChild(lb);
        });
      })
      .catch(function() {
        if (nodeColNote) nodeColNote.textContent = 'Could not load property list from database.';
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
  columnDefs = DEFAULT_COLUMNS.concat(DEFAULT_NODE_COLUMNS).map(function(c) { return Object.assign({}, c); });
  document.getElementById('columns-modal').style.display = 'none';
  columnWidths = null;
  if (document.getElementById('table-view').style.display !== 'none') {
    _reloadCurrentTableMode();
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
    _reloadCurrentTableMode();
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
  // Must match exactly what's rendered in the header for the CURRENT mode —
  // using the raw "visible" flag here (regardless of source) used to let a
  // column visible-but-irrelevant-to-this-mode throw off the index mapping.
  var visCols = _visibleColsForMode();
  var moved = visCols.splice(_colDragSrcIdx, 1)[0];
  visCols.splice(targetIdx, 0, moved);
  // Rebuild columnDefs: everything NOT part of this view's visible set keeps
  // its relative order, appended after the newly reordered visible set.
  var visKeys = new Set(visCols.map(function(c) { return c.key; }));
  var others = columnDefs.filter(function(c) { return !visKeys.has(c.key); });
  columnDefs = visCols.concat(others);
  saveColumnConfig();
  renderTableHeader();
  renderTableRows(_currentTableSourceRows());
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
  var visCols = _visibleColsForMode();
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
  var visCols = _visibleColsForMode();
  columnWidths = {};
  ths.forEach(function(th, i) {
    var col = visCols[i];
    if (col) columnWidths[col.key] = th.offsetWidth;
  });
}

// Returns the currently-displayed rows respecting active filter and sort state.
// Used by both export functions so exports always match what the user sees.
function getActiveTableRows() {
  var sourceRows = _currentTableSourceRows();

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
  a.download = name.replace(/[^a-z0-9_\-]/gi, '_') + '.graph.json';
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
    _reloadCurrentTableMode();
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
    _reloadCurrentTableMode();
  }
  if (added === 0) alert('No new edges could be placed (nodes not found in pathway).');
}

// ─── Shortest Path dialog (Database → Shortest path…) ───────────────────────
// Runs Neo4j's shortestPath() between every pair of currently selected nodes,
// bounded by a max hop count and restricted to user-checked relation types.
// The excluded-type set persists forever in localStorage (per browser) so the
// user's preferred filter survives reloads without having to re-check anything
// each time — new relation types default to checked since we persist the
// EXCLUDED set, not the included one.
var SP_EXCLUDED_KEY = 'shortest_path_excluded_reltypes_v1';

function _spLoadExcluded() {
  try { return new Set(JSON.parse(localStorage.getItem(SP_EXCLUDED_KEY) || '[]')); }
  catch(e) { return new Set(); }
}
function _spSaveExcluded(excludedSet) {
  try { localStorage.setItem(SP_EXCLUDED_KEY, JSON.stringify(Array.from(excludedSet))); } catch(e) {}
}

async function openShortestPathDialog() {
  if (!cy || !graphData) { alert('No pathway loaded.'); return; }
  var selectedNodes = cy.nodes(':selected').not('[?isClone]');
  if (selectedNodes.length < 2) {
    showAlignHint('Please select at least two nodes to find a shortest path between them.');
    return;
  }

  document.getElementById('sp-select-hint').style.display = 'none';
  var listEl = document.getElementById('sp-reltype-list');
  listEl.innerHTML = '<div style="color:#5a6080;font-size:12px;font-style:italic">Loading relation types…</div>';
  document.getElementById('shortest-path-modal').style.display = 'flex';

  var schema = await _loadSchema();
  var types = (schema && schema.relTypes ? schema.relTypes.slice() : []).sort();
  if (!types.length) {
    listEl.innerHTML = '<div style="color:#e05560;font-size:12px">No relation types found in the database schema.</div>';
    return;
  }

  var excluded = _spLoadExcluded();
  listEl.innerHTML = '';
  types.forEach(function(t) {
    var label = document.createElement('label');
    label.className = 'sp-reltype-row';
    label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:#c0c4d4;cursor:pointer';
    label.innerHTML = '<input type="checkbox" class="sp-reltype-cb" value="' + escHtml(t) + '"' +
      (excluded.has(t) ? '' : ' checked') + ' onchange="_spPersistExcluded()"><span>' + escHtml(t) + '</span>';
    listEl.appendChild(label);
  });
}

function _spSelectAll(checked) {
  document.querySelectorAll('.sp-reltype-cb').forEach(function(cb) { cb.checked = checked; });
  _spPersistExcluded();
}

function _spPersistExcluded() {
  var excluded = new Set();
  document.querySelectorAll('.sp-reltype-cb').forEach(function(cb) {
    if (!cb.checked) excluded.add(cb.value);
  });
  _spSaveExcluded(excluded);
}

function closeShortestPathDialog(e) {
  if (e && e.target !== document.getElementById('shortest-path-modal')) return;
  document.getElementById('shortest-path-modal').style.display = 'none';
}

async function runShortestPath() {
  var selectedNodes = cy.nodes(':selected').not('[?isClone]');
  var nodeParams = [];
  selectedNodes.forEach(function(n) {
    var urn   = n.data('URN') || n.data('urn') || '';
    var label = n.data('nodeType') || '';
    if (urn && label) nodeParams.push({ label: label, urn: urn });
  });
  if (nodeParams.length < 2) {
    alert('Selected nodes have no URN or label — cannot query database.');
    return;
  }

  var maxLength = parseInt(document.getElementById('sp-max-length').value, 10);
  if (!maxLength || maxLength < 1) maxLength = 2;

  var checkedTypes = Array.from(document.querySelectorAll('.sp-reltype-cb:checked')).map(function(cb) { return cb.value; });
  if (!checkedTypes.length) {
    document.getElementById('sp-select-hint').style.display = 'block';
    return;
  }

  document.getElementById('shortest-path-modal').style.display = 'none';

  var msg = 'Connecting selected entities with relation of types: ' + checkedTypes.join(', ') +
            ' by path no longer than: ' + maxLength;
  setProgressMsg('⏳ ' + msg);

  try {
    var result = await api('/api/graph/shortest-path', {
      nodeParams: nodeParams, maxLength: maxLength, relTypes: checkedTypes
    });
    setProgressMsg(null);

    if (result.error) { alert('Shortest path error: ' + result.error); return; }

    var newNodes = result.nodes || [];
    var newEdges = result.edges || [];
    if (!newNodes.length && !newEdges.length) {
      alert('No path found connecting the selected nodes within ' + maxLength + ' hop(s) ' +
            'using the checked relation types.');
      return;
    }

    var nodeWord = newNodes.length === 1 ? 'node' : 'nodes';
    var edgeWord = newEdges.length === 1 ? 'relation' : 'relations';
    var summary  = 'Found ' + (result.pathsFound || 0) + ' path(s). Will add ' +
                   newNodes.length + ' ' + nodeWord + ' and ' + newEdges.length + ' ' + edgeWord + '.';

    _expandPending = { nodes: newNodes, edges: newEdges };
    document.getElementById('expand-confirm-msg').textContent = summary;
    document.getElementById('expand-confirm-modal').style.display = 'flex';

  } catch(err) {
    setProgressMsg(null);
    alert('Shortest path query failed: ' + (err.message || err));
  }
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
    _reloadCurrentTableMode();
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
// For each selected node, queries Neo4j for nodes reachable via
// (p)-[:is_a*]->(parent), then merges results into the graph. `maxDepth`
// (1-5, from the menu) caps how many levels up to climb — omit for the full,
// unbounded ancestry chain. Deeper needs should go through Ontology analysis
// instead, which is why the menu only offers up to 5 levels here.
async function findOntologyParents(maxDepth) {
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

  var depthLabel = maxDepth ? (' (up to ' + maxDepth + ' level' + (maxDepth > 1 ? 's' : '') + ' up)') : '';
  setProgressMsg('⏳ Finding ontology parents' + depthLabel + '…');
  try {
    var payload = { nodeParams: nodeParams };
    if (maxDepth) payload.maxDepth = maxDepth;
    var result = await api('/api/graph/ontology-parents', payload);
    setProgressMsg(null);

    if (result.error) { alert('Ontology parents error: ' + result.error); return; }

    var newNodes = result.nodes || [];
    var newEdges = result.edges || [];

    if (!newNodes.length && !newEdges.length) {
      alert('No ontology parents found' + depthLabel + ' for the selected node' + (nodeParams.length > 1 ? 's' : '') + '.');
      return;
    }

    var nodeWord = newNodes.length === 1 ? 'node' : 'nodes';
    var edgeWord = newEdges.length === 1 ? 'is_a relation' : 'is_a relations';
    var summary  = 'Will add ' + newNodes.length + ' ' + nodeWord +
                   ' and ' + newEdges.length + ' ' + edgeWord + depthLabel + '.';

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
var _ontologyScopeIds    = null;  // Set of cy node IDs in scope when analysis was opened (null = all)
var _ontologyHideEmpty   = true;  // "Do not show empty branches" — checked by default

// graphCount is descendant-inclusive (see /api/ontology/batch-counts), so a
// branch with graphCount === 0 has NO matching nodes anywhere under it either
// — safe to skip the whole subtree without walking into it. null ("…" still
// loading) and '?' (fetch failed) are left visible rather than assumed empty.
function _ontoIsEmptyBranch(node) {
  return _ontologyHideEmpty && typeof node.graphCount === 'number' && node.graphCount === 0;
}

function toggleOntologyHideEmpty() {
  var cb = document.getElementById('ontology-hide-empty');
  _ontologyHideEmpty = cb ? cb.checked : true;
  _renderOntologyTree();
}

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
  _ontologyScopeIds = null;  // Sankey uses _ontologySourceData, not cy scope
  _openOntologyAnalysisDialog();
}

function openOntologyAnalysis() {
  if (!cy || !graphData) {
    showAlignHint('Please open a graph or run a Cypher query first.');
    return;
  }
  _ontologySourceData = null;  // use cy
  // Scope to selected nodes if any are selected; otherwise use all graph nodes
  var sel = cy.nodes(':selected').not('[?isClone]');
  if (sel.length > 0) {
    _ontologyScopeIds = new Set();
    sel.forEach(function(n) { _ontologyScopeIds.add(n.id()); });
  } else {
    _ontologyScopeIds = null;  // no selection → full graph
  }
  _openOntologyAnalysisDialog();
}

function _openOntologyAnalysisDialog() {
  var modal = document.getElementById('ontology-analysis-modal');
  if (!modal) return;

  // Reset state
  _ontologyTree      = [];
  _ontologyLayout    = 'hierarchical';
  _ontologyHideEmpty = true;
  // Reset radio buttons
  var radios = modal.querySelectorAll('input[name="ontology-layout"]');
  radios.forEach(function(r) { r.checked = r.value === 'hierarchical'; });
  var hideEmptyCb = document.getElementById('ontology-hide-empty');
  if (hideEmptyCb) hideEmptyCb.checked = true;

  modal.style.display = 'flex';

  // Show input node count in header badge
  var badge = document.getElementById('ontology-scope-badge');
  if (badge) {
    var count, label;
    if (_ontologySourceData) {
      // Sankey context
      count = (_ontologySourceData.nodes || []).length;
      label = count + ' node' + (count !== 1 ? 's' : '') + ' (Sankey)';
    } else if (_ontologyScopeIds) {
      // Graph-view selection
      count = _ontologyScopeIds.size;
      label = count + ' node' + (count !== 1 ? 's' : '') + ' selected';
    } else {
      // Full graph
      count = cy ? cy.nodes().not('[?isClone]').length : 0;
      label = count + ' node' + (count !== 1 ? 's' : '') + ' (full graph)';
    }
    badge.textContent = '— ' + label;
  }

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
    if (_ontologyScopeIds && !_ontologyScopeIds.has(n.id())) return;
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
      if (_ontoIsEmptyBranch(node)) return;  // skip the branch — descendant-inclusive count is 0
      rows.push({ node: node, level: level });
      if (node.expanded && node.children && node.children.length) collect(node.children, level + 1);
    });
  }
  collect(_ontologyTree, 0);

  if (!rows.length && _ontologyHideEmpty) {
    container.innerHTML = '<div style="color:#5a6080;font-size:12px;padding:24px;text-align:center">'
      + 'All branches are empty (0 matching nodes) — uncheck "Hide empty branches" to see them.</div>';
    return;
  }

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
      if (_ontoIsEmptyBranch(node)) return;  // skip the branch — descendant-inclusive count is 0
      var rowIdx = rows.length;
      rows.push({ node: node, level: level, rowIdx: rowIdx });
      if (node.expanded && node.children && node.children.length) collect(node.children, level + 1);
    });
  }
  collect(_ontologyTree, 0);

  if (!rows.length) {
    if (_ontologyTree.length && _ontologyHideEmpty) {
      container.innerHTML = '<div style="color:#5a6080;font-size:12px;padding:24px;text-align:center">'
        + 'All branches are empty (0 matching nodes) — uncheck "Hide empty branches" to see them.</div>';
    } else {
      container.innerHTML = '<div style="color:#5a6080;font-size:12px;padding:24px;text-align:center">Loading…</div>';
    }
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
  if (!_ontologyCtxNode) return;
  var node = _ontologyCtxNode;

  // ── "Copy ontology tree" — full hierarchy from root to entity leaves ─────
  if (action === 'copy-tree') {
    setProgressMsg('⏳ Fetching ontology subtree…');
    try {
      var graphUrns = _getGraphUrns();
      if (!graphUrns.length) {
        showAlignHint('No graph nodes in scope.');
        setProgressMsg(null);
        return;
      }
      var subtree = await api('/api/ontology/subtree', { urn: node.urn, graphUrns: graphUrns });
      setProgressMsg(null);

      var snodes = subtree.nodes || [], sedges = subtree.edges || [];
      if (!snodes.length) {
        showAlignHint('No ontology nodes found for "' + node.name + '".');
        return;
      }

      // Assign hierarchical (tree) layout positions.
      // Build adjacency: parent → [children] where edges go child → parent (is_a/part_of).
      var idToNode = {};
      snodes.forEach(function(n) { idToNode[n.id] = n; });

      var children = {};  // parentId → [childId]
      sedges.forEach(function(e) {
        // e.startId is child, e.endId is parent (is_a / part_of direction)
        if (!children[e.endId]) children[e.endId] = [];
        children[e.endId].push(e.startId);
      });

      // Find root (node matching the selected ontology group URN)
      var rootId = null;
      snodes.forEach(function(n) {
        var u = n.props && (n.props.URN || n.props.urn);
        if (u && String(u) === String(node.urn)) rootId = n.id;
      });
      if (!rootId && snodes.length) rootId = snodes[0].id;

      // BFS to assign depth levels
      var depth = {};
      var queue = [rootId];
      depth[rootId] = 0;
      while (queue.length) {
        var cur = queue.shift();
        (children[cur] || []).forEach(function(cid) {
          if (depth[cid] === undefined) {
            depth[cid] = depth[cur] + 1;
            queue.push(cid);
          }
        });
      }

      // Group nodes by depth level
      var byLevel = {};
      snodes.forEach(function(n) {
        var d = depth[n.id] !== undefined ? depth[n.id] : 999;
        if (!byLevel[d]) byLevel[d] = [];
        byLevel[d].push(n.id);
      });

      // Assign x/y positions
      var positions = {};
      var levelGapY = 120, nodeGapX = 160;
      Object.keys(byLevel).sort(function(a,b){return a-b;}).forEach(function(lv) {
        var ids = byLevel[lv];
        var totalWidth = (ids.length - 1) * nodeGapX;
        ids.forEach(function(id, i) {
          positions[id] = { x: i * nodeGapX - totalWidth / 2, y: lv * levelGapY };
        });
      });

      // Build clipboard nodes
      var clipNodes = snodes.map(function(n) {
        var urn = n.props && (n.props.URN || n.props.urn);
        var label = n.props && n.props.Name || n.props && n.props.name || (n.labels[0] || 'Node');
        var pos = positions[n.id] || { x: 0, y: 0 };
        // Determine whether this is an entity node (in graphUrns) or an ontology node
        var isEntity = urn && graphUrns.indexOf(String(urn)) !== -1;
        return {
          data: {
            id:       n.id,
            label:    label,
            nodeType: n.labels[0] || 'Unknown',
            URN:      urn ? String(urn) : undefined,
            color:    isEntity ? getNodeColor(n.labels) : '#2a4070'
          },
          position: pos,
          raw: { id: n.id, elementId: n.id, labels: n.labels, properties: n.props }
        };
      });

      // Build clipboard edges (is_a / part_of only). These are structural
      // ontology edges with no literature backing (RelationNumberOfReferences
      // is always 0), so they must render with the thinnest line available —
      // set the same cy data fields _buildCyEdgeData() would (thickness,
      // color, lineStyle) instead of leaving them undefined, which previously
      // made Cytoscape fall back to its default (much thicker) edge width.
      var clipEdges = sedges.map(function(e) {
        return {
          data: {
            id:        e.id,
            source:    e.startId,
            target:    e.endId,
            relType:   e.relType,
            label:     e.relType,
            numRefs:   0,
            thickness: getEdgeThickness(0),
            color:     getTypeColor(e.relType),
            lineStyle: DIRECT_TYPES.has(e.relType || '') ? 'solid' : 'dashed'
          },
          raw: null
        };
      });

      graphClipboard = { nodes: clipNodes, edges: clipEdges };

      var mi = document.getElementById('mi-paste');
      if (mi) mi.classList.remove('disabled');
      var msg = clipNodes.length + ' node' + (clipNodes.length !== 1 ? 's' : '') +
                ' and ' + clipEdges.length + ' edge' + (clipEdges.length !== 1 ? 's' : '') +
                ' from "' + node.name + '" ontology tree copied.';
      var statsEl = document.getElementById('graph-stats');
      if (statsEl) statsEl.innerHTML = '<span style="color:#2a9d2a">' + msg + '</span>';
      showAlignHint('✓ ' + msg);
    } catch(e) {
      setProgressMsg(null);
      alert('Copy ontology tree failed: ' + (e.message || e));
    }
    return;
  }

  if (!cy) return;
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
        // Restrict neighborhood to nodes that were in scope when the analysis was opened.
        // Without this, neighbors from the full graph get included, producing a copy of
        // the entire pathway instead of just the ontology-group subtree.
        var scopeNodes = _ontologyScopeIds
          ? cy.nodes().not('[?isClone]').filter(function(n) { return _ontologyScopeIds.has(n.id()); })
          : cy.nodes().not('[?isClone]');
        var neighbors = matchedNodes.neighborhood('node').not('[?isClone]').filter(function(n) {
          return scopeNodes.has(n);
        });
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
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button onclick="rcEditRef()" title="Edit reference" ' +
        'style="background:#1a2a50;border:1px solid #3a3f55;border-radius:5px;color:#4f8ef7;padding:4px 12px;font-size:12px;cursor:pointer">✎ Edit</button>' +
      '<div style="flex:1"></div>' +
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
function openPairRelationDialogForEdge(cyEdge, targetRefUniqueId) {
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
  // When set (right-clicked a specific row in the References table), rcPairLoadRefs()
  // jumps refIdx to this reference once the batch fetch resolves, instead of index 0.
  _rcPair.targetRefUniqueId = targetRefUniqueId || null;

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
    // Right-clicked a specific row in the References table — auto-open the
    // References panel now that we have a RelationID to fetch refs for, so
    // the user lands directly on that reference instead of needing an extra
    // click plus manual navigation. Guarded by !refsVisible so this only
    // fires once (rcPairCalcRelId also re-runs on every property edit).
    if (_rcPair.targetRefUniqueId && !_rcPair.refsVisible && !_rcPair.refsLoaded) {
      rcPairToggleRefs();
    }
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

  // Jump to the specific reference that was right-clicked in the References
  // table, if any — falls back to the first reference when not found (e.g.
  // it was deleted since the table was loaded) or when opened normally.
  _rcPair.refIdx = 0;
  if (_rcPair.targetRefUniqueId) {
    var foundIdx = _rcPair.refs.findIndex(function(r) {
      return r.unique_id != null && String(r.unique_id) === String(_rcPair.targetRefUniqueId);
    });
    if (foundIdx >= 0) _rcPair.refIdx = foundIdx;
    _rcPair.targetRefUniqueId = null;  // one-shot — manual navigation takes over after this
  }

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
  html += '<div style="display:flex;gap:8px;align-items:center">'
    + '<button onclick="rcPairEditRef()" style="background:#1a2a50;border:1px solid #3a3f55;border-radius:5px;color:#4f8ef7;padding:4px 12px;font-size:12px;cursor:pointer">✎ Edit</button>'
    + '<div style="flex:1"></div>'
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

// ─── Neo4j endpoint dialog (admin only) ──────────────────────────────────────
// Only the shared URL lives here now — database/username/password moved to
// each user's own "My Connection" dialog below. The menu item itself is
// hidden for non-admins (see showApp()), so this dialog assumes admin.
async function openNeo4jSettings() {
  var errEl = document.getElementById('neo4j-settings-error');
  var okEl  = document.getElementById('neo4j-settings-success');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  try {
    var s = await api('/api/settings/neo4j');
    document.getElementById('ns-url').value = s.url || '';
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
  var url = document.getElementById('ns-url').value.trim();
  if (!url) { errEl.textContent = 'URL is required.'; errEl.style.display = 'block'; return; }

  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    var result = await api('/api/settings/neo4j', { url: url }, 'POST');
    okEl.textContent = result.warning || 'Saved! Every user reconnects with their own credentials.';
    okEl.style.display = 'block';
    setTimeout(function() { document.getElementById('neo4j-settings-modal').style.display = 'none'; }, 1800);
    _invalidateSchemaCache(); // reset schema autocomplete for new connection
  } catch(err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

// ─── Postgres endpoint dialog (admin only) ───────────────────────────────────
async function openPostgresSettings() {
  var errEl = document.getElementById('pg-settings-error');
  var okEl  = document.getElementById('pg-settings-success');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  try {
    var s = await api('/api/settings/postgres');
    document.getElementById('pgs-host').value = s.host || '';
    document.getElementById('pgs-port').value = s.port || 5432;
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
    host: document.getElementById('pgs-host').value.trim(),
    port: parseInt(document.getElementById('pgs-port').value) || 5432
  };
  if (!payload.host) { errEl.textContent = 'Host is required.'; errEl.style.display = 'block'; return; }

  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    var result = await api('/api/settings/postgres', payload, 'POST');
    okEl.textContent = result.warning || 'Saved! Every user reconnects with their own credentials.';
    okEl.style.display = 'block';
    setTimeout(function() { document.getElementById('postgres-settings-modal').style.display = 'none'; }, 1800);
  } catch(err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

// ─── My Neo4j Connection dialog (every role) ─────────────────────────────────
// Each user's OWN database/username/password — separate from their Graph
// Explorer login (which stays personal and is what createdBy/updatedBy stamps
// use). The URL is shown read-only here for visibility/sync with whatever the
// admin has configured.
async function openMyNeo4jSettings() {
  var errEl = document.getElementById('my-neo4j-error');
  var okEl  = document.getElementById('my-neo4j-success');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  try {
    var s = await api('/api/settings/my-neo4j');
    document.getElementById('mns-url').value      = s.url      || '';
    document.getElementById('mns-database').value = s.database || '';
    document.getElementById('mns-username').value = s.username || '';
    document.getElementById('mns-password').value = '';  // never pre-fill password
  } catch(e) { /* show empty form */ }
  document.getElementById('my-neo4j-modal').style.display = 'flex';
}
function closeMyNeo4jSettingsModal(e) {
  if (!e || e.target === document.getElementById('my-neo4j-modal'))
    document.getElementById('my-neo4j-modal').style.display = 'none';
}
async function saveMyNeo4jSettings() {
  var errEl = document.getElementById('my-neo4j-error');
  var okEl  = document.getElementById('my-neo4j-success');
  var btn   = document.getElementById('mns-save-btn');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  var payload = {
    database: document.getElementById('mns-database').value.trim(),
    username: document.getElementById('mns-username').value.trim(),
    password: document.getElementById('mns-password').value  // blank = keep current
  };
  if (!payload.database || !payload.username) {
    errEl.textContent = 'Database and username are required.';
    errEl.style.display = 'block'; return;
  }
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    await api('/api/settings/my-neo4j', payload, 'POST');
    okEl.textContent = 'Saved! Your Neo4j connection is ready.';
    okEl.style.display = 'block';
    setTimeout(function() { document.getElementById('my-neo4j-modal').style.display = 'none'; }, 1500);
    _invalidateSchemaCache();
  } catch(err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Test & Save';
  }
}

// ─── My Postgres Connection dialog (every role) ──────────────────────────────
async function openMyPostgresSettings() {
  var errEl = document.getElementById('my-pg-error');
  var okEl  = document.getElementById('my-pg-success');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  try {
    var s = await api('/api/settings/my-postgres');
    document.getElementById('mpgs-host').value     = s.host     || '';
    document.getElementById('mpgs-port').value     = s.port     || 5432;
    document.getElementById('mpgs-database').value = s.database || '';
    document.getElementById('mpgs-schema').value   = s.schema   || '';
    document.getElementById('mpgs-username').value = s.username || '';
    document.getElementById('mpgs-password').value = '';  // never pre-fill password
  } catch(e) { /* show empty form */ }
  document.getElementById('my-postgres-modal').style.display = 'flex';
}
function closeMyPostgresSettingsModal(e) {
  if (!e || e.target === document.getElementById('my-postgres-modal'))
    document.getElementById('my-postgres-modal').style.display = 'none';
}
async function saveMyPostgresSettings() {
  var errEl = document.getElementById('my-pg-error');
  var okEl  = document.getElementById('my-pg-success');
  var btn   = document.getElementById('mpgs-save-btn');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  var payload = {
    database: document.getElementById('mpgs-database').value.trim(),
    schema:   document.getElementById('mpgs-schema').value.trim(),
    username: document.getElementById('mpgs-username').value.trim(),
    password: document.getElementById('mpgs-password').value
  };
  if (!payload.database || !payload.schema || !payload.username) {
    errEl.textContent = 'Database, schema, and username are required.';
    errEl.style.display = 'block'; return;
  }
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    await api('/api/settings/my-postgres', payload, 'POST');
    okEl.textContent = 'Saved! Your Postgres connection is ready.';
    okEl.style.display = 'block';
    setTimeout(function() { document.getElementById('my-postgres-modal').style.display = 'none'; }, 1500);
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
function showContextMenu(x, y, type, id, elementId, displayName, properties, relId, refUniqueId) {
  contextTarget = { type: type, id: id, elementId: elementId, displayName: displayName, properties: properties, relId: relId || '', refUniqueId: refUniqueId || '' };
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
        // Standard 2-node relation → Create/Edit Relation (pair dialog).
        // refUniqueId (set when right-clicking a row in the References table)
        // tells the dialog which specific reference to jump to once loaded.
        openPairRelationDialogForEdge(cyEdge, contextTarget.refUniqueId);
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
    nodeRows:             [],
    currentSubgraphName:  '',
    currentLayout:        'cose',
    currentStyle:         'default',
    currentQuery:         '',
    positions:            {},
    tableViewMode:        'reference',
    activeView:           'graph',
    tableSortCol:         null,
    tableSortAsc:         true,
    loadedPropertyNames:  [],
    selectedEdgeIds:      [],
    selectedNodeIds:      []
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
    nodeRows:            JSON.parse(JSON.stringify(nodeRows)),
    currentSubgraphName: currentSubgraphName,
    currentLayout:       currentLayout,
    currentStyle:        currentStyle,
    currentQuery:        getCypherQuery() || currentQuery,
    positions:           positions,
    tableViewMode:       tableViewMode,
    activeView:          activeView,
    tableSortCol:        tableSortCol,
    tableSortAsc:        tableSortAsc,
    loadedPropertyNames: Array.from(_loadedPropertyNames),
    selectedEdgeIds:     Array.from(_selectedTableEdgeIds),
    selectedNodeIds:     Array.from(_selectedTableNodeIds)
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
    nodeRows   = [];
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
    nodeRows   = s.nodeRows  ? JSON.parse(JSON.stringify(s.nodeRows))  : [];
  }
  columnWidths = s.columnWidths ? Object.assign({}, s.columnWidths) : null;
  tableViewMode = s.tableViewMode || 'reference';
  tableSortCol  = s.tableSortCol  || null;
  tableSortAsc  = s.tableSortAsc  !== undefined ? s.tableSortAsc : true;
  syncTableModeIndicator(tableViewMode);

  // Restore the table/graph selection this tab had when it was last left —
  // renderGraph() above reset it (fresh graph data may have stale edge ids),
  // so re-apply it now from the snapshot and push it into the freshly-rendered
  // cy elements, then update the table's row highlighting to match.
  _selectedTableEdgeIds = new Set(Array.isArray(s.selectedEdgeIds) ? s.selectedEdgeIds : []);
  _selectedTableNodeIds = new Set(Array.isArray(s.selectedNodeIds) ? s.selectedNodeIds : []);
  _syncGraphSelectionFromTable();
  _applyTableRowSelectionClasses();
  updateSelectionInfo();

  // Restore the view the user was on when they left this tab.
  // Graph view was already set above (required for cy to render correctly);
  // switch to table now if that's where the user was.
  var restoredView = s.activeView || 'graph';
  var _restoredHasData = tableViewMode === 'node' ? graphData.nodes.length > 0 : graphData.edges.length > 0;
  if (restoredView === 'table' && _restoredHasData) {
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
  nodeRows = [];
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

// ================================================================================
// AGENTIC AI — frontend module
// ================================================================================

// ── State ────────────────────────────────────────────────────────────────────
var _agentPanelOpen    = false;
var _agentChatHistory    = [];   // [{role,content}]
var _agentLastCypher     = null;
var _agentMatchingEntities = false;  // true while async /highlights fetch is in flight
var _agentLibraryFiles = [];
var _llmProviders      = [];   // [{name, url}] loaded from server (admin-configured)
var _agentConfig = (function() {
  // Restore persisted LLM config from localStorage on page load.
  // apikey is deliberately NEVER read from (or written to) localStorage —
  // it now persists server-side per-user via /api/settings/my-llm instead
  // (see saveLLMSettings() and _initAgenticAI()), which is authenticated and
  // access-controlled the same way the Neo4j/Postgres per-user credentials
  // already are. localStorage is readable by any script on the page and
  // never expires, so it's not an appropriate place to keep an API key
  // (this was flagged by CodeQL as js/clear-text-storage-of-sensitive-data).
  try {
    var saved = JSON.parse(localStorage.getItem('agent_user_config_v1') || '{}');
    return {
      provider_name: saved.provider_name || '',
      url:           saved.url           || '',
      apikey:        '',
      model_name:    saved.model_name    || '',
      temperature:   saved.temperature   !== undefined ? saved.temperature : 0.2,
      top_p:         saved.top_p         !== undefined ? saved.top_p         : 0.9,
      json_mode:     saved.json_mode     || false,
    };
  } catch(e) { return { apikey: '', model_name: '', temperature: 0.2, top_p: 0.9, json_mode: false }; }
})();
var _agentWorkflow     = [];
var _agentStatusTimer  = null;
var _agentLastStatusOk    = null;   // null = unknown yet, true/false = last polled state
var _agentPendingResume   = false;  // true when a loaded conversation still needs auto-confirmation
var _agentResumeRetryCount = 0;     // caps automatic resume retries so a persistent failure doesn't loop forever

// ── Panel open/close ─────────────────────────────────────────────────────────
function _initAgenticAI() {
  // Show AI Agent button for non-admin roles; LLM settings visible to all
  var btn = document.getElementById('agentic-ai-btn');
  if (btn) btn.style.display = (currentRole === 'admin') ? 'none' : 'inline-block';
  var llmItem = document.getElementById('settings-llm-item');
  if (llmItem) llmItem.style.display = 'block';

  // Load provider list + global defaults from server, then overlay user's saved prefs.
  // Non-sensitive fields come from localStorage (restored at declaration time)
  // AND from the server-side per-user record (GET /api/settings/my-llm) — the
  // server copy wins when present, since it's authoritative across devices/
  // browsers. The API key itself is never fetched back to the browser (the
  // GET endpoint only returns a masked indicator); the agent service resolves
  // it directly from users.json per-request instead (see agent_service.py's
  // _resolve_llm_cfg), so there is nothing for the frontend to push here.
  api('/api/settings/llm', null, 'GET').then(function(d) {
    _llmProviders = (d.providers || []).slice();

    return api('/api/settings/my-llm', null, 'GET').then(function(mine) {
      if (mine) {
        if (mine.provider_name) _agentConfig.provider_name = mine.provider_name;
        if (mine.url)           _agentConfig.url            = mine.url;
        if (mine.model_name)    _agentConfig.model_name     = mine.model_name;
        if (mine.temperature !== undefined) _agentConfig.temperature = mine.temperature;
        if (mine.top_p       !== undefined) _agentConfig.top_p       = mine.top_p;
        if (mine.json_mode   !== undefined) _agentConfig.json_mode   = mine.json_mode;
      }
    }).catch(function() { /* no per-user record yet — fine, use localStorage/defaults */ });
  }).then(function() {
    // resolve provider URL now that we have the server list
    if (_agentConfig.provider_name) {
      var prov = _llmProviders.find(function(p) { return p.name === _agentConfig.provider_name; });
      if (prov) _agentConfig.url = prov.url;
    }

    // Push resolved (non-secret) config to agent service so status bar shows
    // correct model immediately — the agent resolves the actual API key
    // itself from the trusted server-side per-user record, not from this push.
    if (_agentConfig.model_name || _agentConfig.url) {
      var payload = { model_name:  _agentConfig.model_name  || null,
                      url:         _agentConfig.url          || null,
                      temperature: _agentConfig.temperature,
                      top_p:       _agentConfig.top_p,
                      json_mode:   _agentConfig.json_mode    || false };
      api('/api/agent/llm-config', payload)
        .catch(function(e) { console.warn('Agent LLM config push failed:', e); });
    }
  }).catch(function(e) { console.warn('Failed to load LLM settings:', e); });
}

function toggleAgenticPanel() {
  var panel = document.getElementById('agentic-panel');
  _agentPanelOpen = !_agentPanelOpen;
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
    .then(function(r) {
      var label = r.llm_model || 'connected';
      if (!r.has_anthropic)  label = 'anthropic package missing';
      else if (!r.neo4j_url) label = 'Neo4j not configured';
      _agentSetStatus(true, label);
      var lbl = document.getElementById('agent-status-label');
      if (lbl && r.schema_chars != null)
        lbl.title = 'Schema: ' + r.schema_chars + ' chars (~' + Math.round(r.schema_chars / 4) + ' tokens)';
    })
    .catch(function(e) {
      _agentSetStatus(false, 'service unavailable — ' + (e.message || 'check console'));
    });
  _agentStatusTimer = setTimeout(_agentPollStatus, 10000);
}


function _agentSetStatus(ok, label) {
  var dot = document.getElementById('agent-status-dot');
  var lbl = document.getElementById('agent-status-label');
  if (dot) dot.style.background = ok ? '#3a9c66' : '#c0392b';
  if (lbl) lbl.textContent = label;

  // Announce the service coming back (or becoming ready for the first time
  // this session) in the chat panel too — the header dot is easy to miss.
  // Only fires on a genuine false→true transition, not on every healthy poll.
  if (ok && _agentLastStatusOk === false) {
    _agentAppendMessage('assistant', '✓ Agentic AI service is ready' + (label ? ' (' + label + ')' : '') + '.');
    if (_agentPendingResume) {
      _agentPendingResume = false;
      _agentResumeContext();
    }
  }
  _agentLastStatusOk = ok;
}

// ── Chat ─────────────────────────────────────────────────────────────────────
function agentInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); }
}

// Shown whenever the backend had to drop the oldest turns of a long conversation
// to fit the LLM's context budget (see _HISTORY_TOKEN_BUDGET in agent_service.py).
// This only affects what was SENT to the model for that one request — nothing is
// deleted from _agentChatHistory, so the full conversation is still there to view
// or save again.
function _agentNoteHistoryTrim(result) {
  var dropped = result && result.dropped_history_turns;
  if (dropped) {
    _agentAppendMessage('assistant', 'Note: this conversation is long, so the oldest ' + dropped +
      ' message(s) were left out of what was sent to the agent this turn to stay within its context ' +
      'limit. Nothing was deleted — your full history is still here and in any file you save.');
  }
}

// Gives the agent real visibility into what's actually on the user's screen right
// now — without this, the LLM has no way to know whether e.g. "BRCA1" is already
// in the graph and can only guess from conversation history, which is exactly how
// it can confidently state something false ("BRCA1 already exists in the graph")
// when the graph view is actually empty.
//
// IMPORTANT: the edge list is not optional detail — an earlier version of this
// summary sent only node names, and the agent (reasonably but wrongly) treated
// "both endpoint names are somewhere in the graph" as "this relation is shown in
// the graph". Two nodes can both be visible without the specific edge between
// them being part of the current view (e.g. AURKA and AKT1 both shown for
// unrelated reasons, with no AURKA→AKT1 edge actually rendered) — only the
// explicit edge list below tells the agent which relations truly are on screen.
//
// Both lists are capped so a huge graph doesn't bloat every chat request — the
// agent is told explicitly when either has been truncated. The cap is set to
// match the app's own hard rendering limit (see the "> 1,000 edges cannot be
// displayed" check before loading a query into the graph view) rather than an
// arbitrary smaller number — the graph view itself can never hold more than
// this many edges, so at this cap the agent always sees the FULL current
// graph, never a partial view of what the user is actually looking at.
var _AGENT_GRAPH_STATE_NODE_CAP = 1000;
var _AGENT_GRAPH_STATE_EDGE_CAP = 1000;
function _currentGraphSummary() {
  var nodes = (graphData && graphData.nodes) || [];
  var edges = (graphData && graphData.edges) || [];

  var nodeById = {};
  nodes.forEach(function(n) { nodeById[n.id] = n; });
  function nameOf(n) {
    if (!n) return '?';
    var p = n.properties || {};
    return p.Name || p.name || '?';
  }

  var cappedNodes = nodes.slice(0, _AGENT_GRAPH_STATE_NODE_CAP).map(function(n) {
    var p = n.properties || {};
    return { name: p.Name || p.name || '', label: (n.labels && n.labels[0]) || '' };
  });
  var cappedEdges = edges.slice(0, _AGENT_GRAPH_STATE_EDGE_CAP).map(function(e) {
    var p        = e.properties || {};
    var relId    = p.RelationID != null ? String(p.RelationID) : null;
    var effect   = p.Effect || p.effect || null;
    var edgeInfo = {
      relationId: relId,
      source:     nameOf(nodeById[e.startNodeId]),
      target:     nameOf(nodeById[e.endNodeId]),
      type:       e.type || '',
      effect:     effect
    };
    // If this edge's supporting sentences are already sitting in refsCache (fetched
    // earlier — via a tooltip hover, "Colorize sentences", loading a saved subgraph
    // with inline references, etc.) or inline on the edge itself, include them here
    // for edges missing Effect. This is opportunistic only — never triggers a new
    // fetch — so the agent can use what's already loaded instead of re-querying
    // Postgres for data the app already has in memory. Capped per-edge so this
    // doesn't balloon the payload for a graph with hundreds of missing-Effect edges.
    if (!effect && relId) {
      var cachedRefs = (refsCache && refsCache[relId]) ||
                        (Array.isArray(p.references) ? p.references : null);
      if (cachedRefs && cachedRefs.length) {
        edgeInfo.sentences = cachedRefs.slice(0, 2)
          .map(function(r) { return (r && r.msrc) ? String(r.msrc).slice(0, 300) : null; })
          .filter(Boolean);
        if (!edgeInfo.sentences.length) delete edgeInfo.sentences;
      }
    }
    return edgeInfo;
  });

  return {
    nodeCount:     nodes.length,
    edgeCount:     edges.length,
    nodes:         cappedNodes,
    edges:         cappedEdges,
    nodesTruncated: nodes.length > _AGENT_GRAPH_STATE_NODE_CAP,
    edgesTruncated: edges.length > _AGENT_GRAPH_STATE_EDGE_CAP
  };
}

async function agentSend() {
  var input = document.getElementById('agent-input');
  var msg = (input.value || '').trim();
  if (!msg) return;
  input.value = '';

  _agentAppendMessage('user', msg);
  _agentChatHistory.push({ role: 'user', content: msg });

  var sendBtn  = document.getElementById('agent-send-btn');
  var thinking = document.getElementById('agent-thinking-indicator');
  sendBtn.disabled = true;

  // Show elapsed-time counter so the user knows the agent is working
  var _agentStartTime = Date.now();
  var _agentTimerInterval = setInterval(function() {
    var secs = Math.floor((Date.now() - _agentStartTime) / 1000);
    var mins = Math.floor(secs / 60);
    var s    = secs % 60;
    var label = mins > 0 ? (mins + ':' + (s < 10 ? '0' : '') + s) : (secs + 's');
    if (thinking) { thinking.textContent = '⏳ Thinking… ' + label; thinking.style.display = 'inline'; }
  }, 1000);
  if (thinking) { thinking.textContent = '⏳ Thinking…'; thinking.style.display = 'inline'; }

  // Abort the request if the server takes longer than 130 s
  var _agentAbort = new AbortController();
  var _agentAbortTimer = setTimeout(function() { _agentAbort.abort(); }, 130000);

  try {
    var res = await fetch('/api/agent/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
      body:    JSON.stringify({ message: msg, history: _agentChatHistory.slice(0, -1), llm: _agentConfig,
                                 current_graph: _currentGraphSummary() }),
      signal:  _agentAbort.signal,
    });
    var result = await res.json().catch(function() { return {}; });
    if (!res.ok) throw new Error(result.error || ('HTTP ' + res.status));
    _agentNoteHistoryTrim(result);

    var reply    = result.reply || '(no reply)';
    var histTurn = { role: 'assistant', content: reply };
    // Keep whatever Cypher this turn produced attached to it, so it survives
    // save/reload and still shows its own clickable box when restored.
    if (result.generated_cypher) histTurn.cypher = result.generated_cypher;
    else if (result.render && result.render.cypher) histTurn.cypher = result.render.cypher;
    _agentChatHistory.push(histTurn);

    // ── Display reply immediately — don't wait for entity matching ────────────
    var bubble = _agentAppendMessage('assistant', reply, result.generated_cypher, result.cypher_results);

    if (result.generated_cypher) {
      _agentLastCypher = result.generated_cypher;
    }

    // ── Render hook — agent requested a visualization or export ──────────────
    if (result.render && result.render.tool) {
      _agentRenderResult(result.render);
    }

    // ── Write relation hook — agent wants to create a relation ────────────────
    if (result.write_relation && result.write_relation.relation_id) {
      _agentShowWriteRelModal(result.write_relation);
    }

    // ── Batch update hook — agent proposes multiple property changes ─────────
    // (also fires when there are ONLY conflicts and nothing resolved to a value)
    if (result.batch_update && (
          (result.batch_update.updates   && result.batch_update.updates.length) ||
          (result.batch_update.conflicts && result.batch_update.conflicts.length)
        )) {
      _agentShowBatchUpdateCard(result.batch_update);
    }

  } catch(err) {
    var errMsg = err.name === 'AbortError'
      ? 'Request timed out after 130 seconds. The LLM may be overloaded — please retry.'
      : 'Error: ' + (err.message || String(err));
    _agentAppendMessage('error', errMsg);
  } finally {
    clearInterval(_agentTimerInterval);
    clearTimeout(_agentAbortTimer);
    sendBtn.disabled = false;
    if (thinking) { thinking.textContent = '⏳ Thinking…'; thinking.style.display = 'none'; }
  }
}

function _agentAppendMessage(role, content, cypher, results) {
  var container = document.getElementById('agent-chat-messages');
  if (!container) return null;

  var bubble = document.createElement('div');
  var baseStyle = 'max-width:96%;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;';
  if (role === 'user')        bubble.style.cssText = baseStyle + 'align-self:flex-end;background:#2a4a7f;color:#e0e8ff;border-bottom-right-radius:3px';
  else if (role === 'error')  bubble.style.cssText = baseStyle + 'align-self:flex-start;background:#4a1c1c;color:#ffaaaa;border-bottom-left-radius:3px';
  else                        bubble.style.cssText = baseStyle + 'align-self:flex-start;background:#1e2a45;color:#c8d0e8;border-bottom-left-radius:3px';

  bubble.textContent = content;

  if (cypher) {
    var cypherBox = document.createElement('div');
    cypherBox.style.cssText = 'margin-top:8px;background:#0d1220;border:1px solid #2a4a7f;border-radius:6px;padding:8px 10px;font-family:monospace;font-size:11px;color:#a0cfff;white-space:pre-wrap;word-break:break-all;cursor:pointer;user-select:text';
    cypherBox.title = 'Click to load into Query Bar';
    cypherBox.textContent = cypher;
    var _hintEl = document.createElement('div');
    _hintEl.style.cssText = 'font-size:10px;color:#4a5580;margin-top:4px;font-family:sans-serif';
    _hintEl.textContent = 'Click to load into Query Bar';
    cypherBox.appendChild(_hintEl);
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
  return bubble;  // caller can use this to apply highlights later
}

// ── Batch update checkbox card ───────────────────────────────────────────────
// Rendered inline in the chat any time the agent proposes multiple property
// changes at once (e.g. inferred Effect signs from supporting sentences). Every
// row defaults to checked; the user can uncheck any assertion they disagree
// with before applying. The actual write happens via /api/agent/batch-write
// for just the checked subset — the agent itself never executes this write.
var _agentBatchCardSeq = 0;
var _agentBatchCards   = {};  // cardId -> { property, updates }

function _agentShowBatchUpdateCard(bu) {
  var container = document.getElementById('agent-chat-messages');
  var updates   = (bu && bu.updates)   || [];
  var conflicts = (bu && bu.conflicts) || [];
  if (!container || !bu || (!updates.length && !conflicts.length)) return;

  var cardId    = 'agent-batch-card-' + (++_agentBatchCardSeq);
  var itemClass = cardId + '-item';   // shared by both update and conflict checkboxes
  _agentBatchCards[cardId] = { property: bu.property || 'Effect', updates: updates.slice(), conflicts: conflicts.slice() };

  var card = document.createElement('div');
  card.id = cardId;
  card.style.cssText = 'align-self:flex-start;max-width:96%;background:#1e2a45;border:1px solid #2a4a7f;' +
    'border-radius:10px;padding:10px 12px;font-size:12px;color:#c8d0e8';

  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:10px';
  var title = document.createElement('div');
  title.style.cssText = 'font-weight:600;color:#e0e8ff';
  var countParts = [];
  if (updates.length)   countParts.push(updates.length + ' suggestion' + (updates.length !== 1 ? 's' : ''));
  if (conflicts.length) countParts.push(conflicts.length + ' conflict' + (conflicts.length !== 1 ? 's' : ''));
  title.textContent = (bu.description || ('Proposed ' + bu.property + ' updates')) + ' — ' + countParts.join(', ');
  header.appendChild(title);

  var selAllWrap = document.createElement('label');
  selAllWrap.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11px;color:#9aa2c0;cursor:pointer;white-space:nowrap;flex-shrink:0';
  var selAllCb = document.createElement('input');
  selAllCb.type = 'checkbox';
  selAllCb.checked = true;
  selAllWrap.appendChild(selAllCb);
  selAllWrap.appendChild(document.createTextNode('Select all'));
  header.appendChild(selAllWrap);
  card.appendChild(header);

  var list = null;
  if (updates.length) {
    list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:360px;overflow-y:auto;margin-bottom:10px';

    updates.forEach(function(u, i) {
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;background:#151b2e;border-radius:6px;padding:6px 8px;cursor:pointer';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.className = itemClass;
      cb.dataset.kind = 'update';
      cb.dataset.idx = i;
      cb.style.cssText = 'margin-top:2px;flex-shrink:0';
      row.appendChild(cb);

      var body = document.createElement('div');
      body.style.cssText = 'flex:1;min-width:0';

      var valStr = String(u.value || '');
      var valColor = /positive/i.test(valStr) ? '#4caf50' : (/negative/i.test(valStr) ? '#e57373' : '#b0b8d0');
      var line1 = document.createElement('div');
      line1.style.cssText = 'color:#e0e8ff';
      line1.innerHTML = '<b>' + _esc(u.source || '?') + '</b> → <b>' + _esc(u.target || '?') + '</b>' +
        (u.relationType ? ' <span style="color:#7a8099">(' + _esc(u.relationType) + ')</span>' : '') +
        ' — ' + _esc(bu.property || 'Effect') + ': ' +
        '<span style="color:' + valColor + ';font-weight:600">' + _esc(valStr) + '</span>';
      body.appendChild(line1);

      if (u.sentence) {
        var sentEl = document.createElement('div');
        sentEl.style.cssText = 'margin-top:3px;color:#8a92ad;font-style:italic;font-size:11px;line-height:1.4';
        sentEl.textContent = '“' + u.sentence + '”';
        body.appendChild(sentEl);
      }
      row.appendChild(body);
      list.appendChild(row);
    });
    card.appendChild(list);
  }

  // ── Conflicting evidence — the agent deliberately did not pick a side.
  // Each row gets its own Positive/Negative/Unknown dropdown (defaulting to
  // Unknown) plus a checkbox (checked by default, like the updates above) so
  // "Apply" can include or skip it the same way as an inferred suggestion.
  var conflictSelectClass = cardId + '-conflict-select';
  if (conflicts.length) {
    var conflictWrap = document.createElement('div');
    conflictWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:360px;overflow-y:auto;margin-bottom:10px';

    var conflictHeader = document.createElement('div');
    conflictHeader.style.cssText = 'color:#e0b34a;font-size:11px;font-weight:600;display:flex;align-items:center;gap:5px';
    conflictHeader.textContent = '⚠ Conflicting evidence — you decide';
    conflictWrap.appendChild(conflictHeader);

    conflicts.forEach(function(c, i) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;background:#2a2214;border:1px solid #4a3c1a;border-radius:6px;padding:6px 8px';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.className = itemClass;
      cb.dataset.kind = 'conflict';
      cb.dataset.idx = i;
      cb.style.cssText = 'margin-top:2px;flex-shrink:0';
      row.appendChild(cb);

      var body = document.createElement('div');
      body.style.cssText = 'flex:1;min-width:0';

      var line1 = document.createElement('div');
      line1.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;color:#e0e8ff;flex-wrap:wrap';

      var label = document.createElement('span');
      label.innerHTML = '<b>' + _esc(c.source || '?') + '</b> → <b>' + _esc(c.target || '?') + '</b>' +
        (c.relationType ? ' <span style="color:#7a8099">(' + _esc(c.relationType) + ')</span>' : '');
      line1.appendChild(label);

      var select = document.createElement('select');
      select.className = conflictSelectClass;
      select.dataset.idx = i;
      select.style.cssText = 'background:#151b2e;border:1px solid #4a3c1a;border-radius:5px;color:#e0e8ff;font-size:11px;padding:3px 6px;cursor:pointer';
      ['Positive', 'Negative', 'Unknown'].forEach(function(v) {
        var o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        select.appendChild(o);
      });
      select.value = 'Unknown';  // default choice
      line1.appendChild(select);
      body.appendChild(line1);

      (c.sentences || []).forEach(function(s) {
        var dirStr = String(s.direction || '');
        var dirColor = /positive/i.test(dirStr) ? '#4caf50' : (/negative/i.test(dirStr) ? '#e57373' : '#b0b8d0');
        var sentEl = document.createElement('div');
        sentEl.style.cssText = 'margin-top:4px;font-size:11px;line-height:1.4';
        sentEl.innerHTML = '<span style="color:' + dirColor + ';font-weight:600">' + _esc(dirStr || '?') + '</span>' +
          ' <span style="color:#8a92ad;font-style:italic">“' + _esc(s.text || '') + '”</span>';
        body.appendChild(sentEl);
      });
      row.appendChild(body);
      conflictWrap.appendChild(row);
    });
    card.appendChild(conflictWrap);
  }

  var footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;align-items:center';
  var statusEl = document.createElement('span');
  statusEl.style.cssText = 'font-size:11px;color:#7a8099;margin-right:auto';
  footer.appendChild(statusEl);

  var dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.style.cssText = 'background:none;border:1px solid #3a4570;color:#a0a8c8;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer';
  dismissBtn.onclick = function() { card.remove(); };
  footer.appendChild(dismissBtn);

  var applyBtn = document.createElement('button');
  applyBtn.style.cssText = 'background:#2a6f4a;border:none;color:#eafff0;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600';
  applyBtn.onclick = function() { _agentApplyBatchUpdate(cardId, applyBtn, statusEl, card, dismissBtn, selAllCb); };
  footer.appendChild(applyBtn);

  function _allCheckboxes() { return card.querySelectorAll('input.' + itemClass); }

  function _refreshSelectAll() {
    var all     = _allCheckboxes();
    var checked = card.querySelectorAll('input.' + itemClass + ':checked');
    selAllCb.checked = all.length > 0 && checked.length === all.length;
    selAllCb.indeterminate = checked.length > 0 && checked.length < all.length;
  }

  function _updateApplyLabel() {
    var n = card.querySelectorAll('input.' + itemClass + ':checked').length;
    applyBtn.textContent = 'Apply selected (' + n + ')';
    applyBtn.disabled = (n === 0);
    applyBtn.style.opacity = (n === 0) ? '0.5' : '1';
  }

  selAllCb.onclick = function() {
    _allCheckboxes().forEach(function(cb2) { cb2.checked = selAllCb.checked; });
    _updateApplyLabel();
  };
  card.addEventListener('change', function(e) {
    if (e.target && e.target.classList.contains(itemClass)) {
      _refreshSelectAll();
      _updateApplyLabel();
    }
  });
  _updateApplyLabel();

  card.appendChild(footer);
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
}

async function _agentApplyBatchUpdate(cardId, btn, statusEl, card, dismissBtn, selAllCb) {
  var entry = _agentBatchCards[cardId];
  if (!entry) return;
  var conflictSelectClass = cardId + '-conflict-select';

  var updates = [];
  card.querySelectorAll('input[type=checkbox]:checked').forEach(function(cb) {
    if (cb.dataset.idx === undefined) return;
    var i = parseInt(cb.dataset.idx, 10);
    if (cb.dataset.kind === 'conflict') {
      var c = (entry.conflicts || [])[i];
      if (!c) return;
      var select = card.querySelector('select.' + conflictSelectClass + '[data-idx="' + i + '"]');
      var value  = select ? select.value : 'Unknown';
      updates.push({ relationId: c.relationId, value: value, relationType: c.relationType || '' });
    } else {
      var u = entry.updates[i];
      if (!u) return;
      // relationType lets the backend scope its MATCH to one relationship type
      // instead of scanning every relationship in the database.
      updates.push({ relationId: u.relationId, value: u.value, relationType: u.relationType || '' });
    }
  });

  if (!updates.length) {
    statusEl.style.color = '#e5a13a';
    statusEl.textContent = 'Nothing selected.';
    return;
  }

  var totalProposed = (entry.updates ? entry.updates.length : 0) + (entry.conflicts ? entry.conflicts.length : 0);

  btn.disabled = true;
  btn.textContent = 'Applying…';
  statusEl.style.color = '#7a8099';
  statusEl.textContent = '';

  try {
    var result = await api('/api/agent/batch-write', { property: entry.property, updates: updates, username: currentUser || '' });
    var updated = (result && typeof result.updatedCount === 'number') ? result.updatedCount : updates.length;
    statusEl.style.color = '#4caf50';
    statusEl.textContent = '✓ Updated ' + updated + ' relation(s).';
    btn.textContent = 'Applied ✓';

    // Reflect the change in the currently displayed graph immediately — the
    // write above only touched Neo4j, so without this the tooltip, Edit
    // Properties dialog, and Effect-based arrow shapes would keep showing
    // stale values until the user re-ran a query.
    _applyBatchUpdateToLocalGraph(entry.property, updates);

    // Lock the card so it can't be re-applied by accident
    card.querySelectorAll('input[type=checkbox], select.' + conflictSelectClass).forEach(function(el) { el.disabled = true; });
    if (selAllCb) selAllCb.disabled = true;
    if (dismissBtn) dismissBtn.textContent = 'Close';

    // Echo into chat history so a save/reload of the conversation keeps a record
    _agentChatHistory.push({
      role: 'assistant',
      content: '✓ Applied ' + entry.property + ' update to ' + updated + ' relation(s) (' +
        updates.length + ' selected of ' + totalProposed + ' proposed).'
    });
  } catch (err) {
    statusEl.style.color = '#e57373';
    statusEl.textContent = 'Failed: ' + (err.message || String(err));
    btn.disabled = false;
    btn.textContent = 'Apply selected (' + updates.length + ')';
  }
}

// Patch graphData + the live Cytoscape elements so a just-applied batch_update
// shows up immediately (tooltip, Edit Properties dialog, Effect arrow shapes)
// without requiring the user to re-run a query. Matches by RelationID, and
// also checks the list-valued RelationIDs some merged relations carry.
function _applyBatchUpdateToLocalGraph(property, updates) {
  if (!updates || !updates.length) return;
  var byId = {};
  updates.forEach(function(u) { byId[String(u.relationId)] = u.value; });

  function matchesAny(rid, ridList) {
    if (rid != null && byId.hasOwnProperty(String(rid))) return byId[String(rid)];
    if (Array.isArray(ridList)) {
      for (var i = 0; i < ridList.length; i++) {
        if (byId.hasOwnProperty(String(ridList[i]))) return byId[String(ridList[i])];
      }
    }
    return undefined;
  }

  // graphData — source of truth for context-menu / re-render paths
  if (graphData && Array.isArray(graphData.edges)) {
    graphData.edges.forEach(function(e) {
      var p = e.properties || {};
      var val = matchesAny(p.RelationID, p.RelationIDs);
      if (val !== undefined) {
        e.properties[property] = val;
        e.properties[property.toLowerCase()] = val;  // some readers check the lowercase key
      }
    });
  }

  // Live Cytoscape elements — so tooltip / arrow shape / Edit Properties dialog
  // (all of which read cy edge .data() directly) update without a re-render.
  if (cy) {
    cy.edges().forEach(function(ele) {
      var val = matchesAny(ele.data('relId'), ele.data('relIds'));
      if (val === undefined) return;
      var dataKey = property.charAt(0).toLowerCase() + property.slice(1);  // Effect -> effect
      ele.data(dataKey, property === 'Effect' ? normEffectDisplay(val) : val);
    });
  }
}

function agentLoadCypherToBar() {
  if (!_agentLastCypher) return;
  // Ensure the query bar is visible
  var bar = document.getElementById('query-bar');
  if (bar && bar.style.display === 'none') bar.style.display = '';
  // Load into textarea and trigger auto-resize
  var input = document.getElementById('cypher-input') || document.querySelector('textarea[placeholder*="Cypher"]');
  if (input) {
    input.value = _agentLastCypher;
    if (typeof cypherAutoResize === 'function') cypherAutoResize(input);
    input.dispatchEvent(new Event('input'));
    setTimeout(function() { input.focus(); }, 50);
  }
  if (window.cypherEditor && window.cypherEditor.setValue) window.cypherEditor.setValue(_agentLastCypher);
}

function agentClearChat() {
  _agentChatHistory = [];
  _agentLastCypher  = null;
  var container = document.getElementById('agent-chat-messages');
  if (container) container.innerHTML = '<div style="text-align:center;color:#5a6080;font-size:12px;padding:20px 0">Ask anything about your graph &mdash; I can translate natural language to Cypher, run queries, and chain multi-step workflows.</div>';
}

// ── Save / load conversation to a local file ──────────────────────────────────
// Lets the user archive a chat and later reload it (in this session or a future
// one, on any machine) to continue where they left off — the agent is primed
// with the restored history automatically (see _agentResumeContext below).
function agentSaveConversation() {
  if (!_agentChatHistory.length) { alert('No conversation to save yet.'); return; }

  var saveData = {
    type:       'graph-explorer-agent-conversation',
    version:    2,   // v2 adds lastCypher + per-turn cypher on messages
    savedAt:    new Date().toISOString(),
    model:      _agentConfig.model_name || '',
    lastCypher: _agentLastCypher || null,
    messages:   _agentChatHistory
  };

  var blob = new Blob([JSON.stringify(saveData, null, 2)], { type: 'application/json' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  var stamp = saveData.savedAt.replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = 'agent-conversation_' + stamp + '.chat.json';
  a.click();
  URL.revokeObjectURL(url);
}

function agentTriggerLoadConversation() {
  var input = document.getElementById('agent-load-conv-input');
  if (input) input.click();
}

function agentLoadConversationFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  event.target.value = '';  // allow re-selecting the same file later

  var reader = new FileReader();
  reader.onload = function(e) {
    var data;
    try {
      data = JSON.parse(e.target.result);
    } catch (err) {
      alert('Could not parse this file as JSON: ' + err.message);
      return;
    }

    // Accept either the { messages: [...] } format this app saves, or a bare
    // array of {role, content} turns (in case a file was hand-edited/exported).
    var raw = Array.isArray(data.messages) ? data.messages : (Array.isArray(data) ? data : null);
    if (!raw || !raw.length) {
      alert('This file does not contain a saved conversation.');
      return;
    }
    var messages = raw.filter(function(m) {
      return m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant');
    });
    if (!messages.length) {
      alert('No valid messages found in this file.');
      return;
    }

    _agentChatHistory = messages;

    // Restore the last developed Cypher query. Prefer the explicit top-level
    // field (saved by the current app version); fall back to scanning the
    // messages for the most recent one that carried a `cypher` field, for
    // files saved before that field existed.
    var restoredCypher = data.lastCypher || null;
    if (!restoredCypher) {
      for (var i = messages.length - 1; i >= 0; i--) {
        if (messages[i].cypher) { restoredCypher = messages[i].cypher; break; }
      }
    }
    _agentLastCypher = restoredCypher || null;

    // Re-render the chat panel with the restored turns (including each
    // turn's own Cypher box, if it had one)
    var container = document.getElementById('agent-chat-messages');
    if (container) container.innerHTML = '';
    messages.forEach(function(m) { _agentAppendMessage(m.role, m.content, m.cypher); });

    if (!_agentPanelOpen) toggleAgenticPanel();

    // Load the last query straight into the Query Bar so it's one click
    // (▶ Run) away — no need to dig through the chat to re-run it.
    var cypherNote = '';
    if (_agentLastCypher) {
      agentLoadCypherToBar();
      cypherNote = ' The last Cypher query from this conversation has been loaded into the Query Bar — click ▶ Run to re-execute it.';
    }

    var savedLabel = data.savedAt ? ' (saved ' + new Date(data.savedAt).toLocaleString() + ')' : '';
    _agentAppendMessage('assistant', 'Conversation restored — ' + messages.length + ' message(s)' + savedLabel + '.' + cypherNote + ' Asking the agent to confirm it has the context…');

    _agentPendingResume    = false;
    _agentResumeRetryCount = 0;
    _agentResumeContext();
  };
  reader.readAsText(file);
}

// After loading a saved conversation, silently prime the agent with the full
// restored history so it can "read" the context before the user types anything.
// The priming turn is added to _agentChatHistory (so it stays part of the
// record and is included if the conversation is saved again), but the request
// text itself is not shown as its own chat bubble — only the agent's reply is.
async function _agentResumeContext() {
  var thinking = document.getElementById('agent-thinking-indicator');
  if (thinking) { thinking.textContent = '⏳ Reading restored context…'; thinking.style.display = 'inline'; }

  var cypherNote = _agentLastCypher
    ? ('\n\nFor reference, the last Cypher query developed in this conversation was:\n```\n' +
       _agentLastCypher + '\n```\nIt has already been loaded into the app\'s Query Bar for the user ' +
       'to re-run — you do not need to regenerate it unless the user asks for changes.')
    : '';
  var resumeMsg = '[This conversation was just restored from a saved file. Briefly confirm in ' +
    'one or two sentences what we were discussing based on the history above, then wait for my ' +
    'next message — do not run any new queries or actions yet.]' + cypherNote;
  _agentChatHistory.push({ role: 'user', content: resumeMsg });

  try {
    var res = await fetch('/api/agent/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
      body:    JSON.stringify({
        message: resumeMsg,
        history: _agentChatHistory.slice(0, -1),
        llm:     _agentConfig,
        current_graph: _currentGraphSummary(),
      }),
    });
    var result = await res.json().catch(function() { return {}; });
    if (!res.ok) throw new Error(result.error || ('HTTP ' + res.status));
    _agentNoteHistoryTrim(result);

    var reply = result.reply || '(no reply)';
    _agentChatHistory.push({ role: 'assistant', content: reply });
    _agentAppendMessage('assistant', reply);
  } catch (err) {
    // Restoring the history itself already succeeded — only the automatic
    // confirmation round-trip failed. The user can still just start typing;
    // the full restored history will go out with their next message.
    _agentChatHistory.pop();  // drop the un-answered priming turn

    var msg = err.message || String(err);
    var isStarting = /starting|unavailable/i.test(msg);
    if (isStarting && _agentResumeRetryCount < 3) {
      // Service isn't up yet — wait for the next health poll to flip to "ready"
      // (see _agentSetStatus) and retry automatically instead of leaving a
      // stale error the user has to notice and act on themselves.
      _agentResumeRetryCount++;
      _agentPendingResume = true;
      _agentAppendMessage('assistant', 'Agentic AI service is still starting — I\'ll automatically finish confirming the restored context as soon as it\'s ready.');
    } else {
      _agentAppendMessage('error', 'Could not auto-confirm context with the agent: ' + msg +
        '. The history is still restored — you can continue the conversation normally.');
    }
  } finally {
    if (thinking) { thinking.textContent = '⏳ Thinking…'; thinking.style.display = 'none'; }
  }
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
    if (data.workflow && data.workflow.length) { _agentWorkflow = data.workflow; _syncWorkflowBtn(); }
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

// ── Cypher Examples browser ───────────────────────────────────────────────────
// Exposes cypher_examples.json (the file that seeds the agent's "Cypher Query
// Examples" system-prompt section) so users know it exists and can grow it —
// add patterns/rules the agent keeps missing — without hand-editing a file on disk.
var _agentExamplesCache  = [];   // in-memory mirror of cypher_examples.json
var _agentExampleEditIdx = -1;   // -1 = adding new, >=0 = editing that index

function openAgentExamples() {
  document.getElementById('agent-examples-modal').style.display = 'flex';
  agentExamplesRefresh();
}
function closeAgentExamples() {
  document.getElementById('agent-examples-modal').style.display = 'none';
}

async function agentExamplesRefresh() {
  var list = document.getElementById('agent-examples-list');
  list.innerHTML = '<div style="color:#5a6080;font-size:12px;text-align:center;padding:20px">Loading…</div>';
  document.getElementById('aex-search-input').value = '';
  document.getElementById('aex-sort-select').value  = 'rule';
  try {
    var data = await api('/api/agent/examples', null, 'GET');
    _agentExamplesCache = data.examples || [];
    _aexRender();
  } catch(e) {
    list.innerHTML = '<div style="color:#ff6b6b;font-size:12px;padding:10px">Failed to load examples: ' + e.message + '</div>';
  }
}

// Wraps every case-insensitive occurrence of `term` in <mark class="aex-hit">,
// escaping both sides identically first so highlighting can't re-inject HTML.
function _aexHighlight(text, term) {
  var escaped = escHtml(text || '');
  if (!term) return escaped;
  var escTerm = escHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escTerm) return escaped;
  return escaped.replace(new RegExp('(' + escTerm + ')', 'ig'), '<mark class="aex-hit">$1</mark>');
}

function _aexRender() {
  var list    = document.getElementById('agent-examples-list');
  var status  = document.getElementById('agent-examples-status');
  var countEl = document.getElementById('agent-examples-count');
  var search  = (document.getElementById('aex-search-input').value || '').trim().toLowerCase();
  var sortBy  = document.getElementById('aex-sort-select').value;

  var total = _agentExamplesCache.length;
  if (countEl) countEl.textContent = total + (total === 1 ? ' example' : ' examples');

  // Carry the ORIGINAL index through filtering/sorting — Edit/Delete and the
  // "Rule #N" badge must always refer back to the true position in
  // _agentExamplesCache, not the position in this filtered/sorted view.
  var rows = _agentExamplesCache.map(function(ex, idx) { return { idx: idx, ex: ex }; });

  if (search) {
    rows = rows.filter(function(r) {
      var haystack = [r.ex.question, r.ex.notes, r.ex.cypher].concat(r.ex.tags || [])
        .join(' \n ').toLowerCase();
      return haystack.indexOf(search) !== -1;
    });
  }

  var shown = rows.length;
  status.textContent = total === 0 ? '' :
    'Showing ' + shown.toLocaleString() + ' of ' + total.toLocaleString() + ' example' + (total === 1 ? '' : 's') +
    (shown === 0 ? ' — no matches.' : '');

  if (sortBy === 'alpha') {
    rows.sort(function(a, b) { return (a.ex.question || '').localeCompare(b.ex.question || ''); });
  } else {
    rows.sort(function(a, b) { return a.idx - b.idx; });
  }

  if (!total) {
    list.innerHTML = '<div style="color:#5a6080;font-size:12px;text-align:center;padding:20px">No examples yet — click "+ Add example" to teach the agent a query pattern.</div>';
    return;
  }
  if (!shown) {
    list.innerHTML = '<div style="color:#5a6080;font-size:12px;text-align:center;padding:20px">No examples match your filters.</div>';
    return;
  }

  list.innerHTML = '';
  rows.forEach(function(r) {
    var idx = r.idx, ex = r.ex;
    var row = document.createElement('div');
    row.style.cssText = 'background:#252a40;border:1px solid #2a3050;border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:6px';
    var title = ex.question ? _aexHighlight(ex.question, search) : '<span style="color:#5a6080">(no question set)</span>';
    var ruleTag = '<span style="font-size:10px;font-weight:700;color:#a0cfff;background:#0d1220;border:1px solid #2a4a7f;border-radius:9px;padding:1px 8px;flex-shrink:0">Rule #' + (idx + 1) + '</span>';
    row.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + ruleTag +
          '<span style="font-size:13px;color:#e0e0e0;font-weight:500">' + title + '</span></div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0">' +
          '<button onclick="agentExampleEdit(' + idx + ')" style="padding:3px 9px;background:#1e2235;border:1px solid #3a3f55;border-radius:4px;color:#c0c4d4;font-size:11px;cursor:pointer">Edit</button>' +
          '<button onclick="agentExampleDelete(' + idx + ')" style="padding:3px 9px;background:transparent;border:1px solid #4a1c1c;border-radius:4px;color:#ff6b6b;font-size:11px;cursor:pointer">Delete</button>' +
        '</div>' +
      '</div>' +
      '<div style="background:#0d1220;border-radius:5px;padding:6px 9px;font-family:monospace;font-size:11px;color:#a0cfff;white-space:pre-wrap;word-break:break-all;max-height:110px;overflow-y:auto">' +
        _aexHighlight(ex.cypher || '', search) + '</div>' +
      (ex.notes ? '<div style="font-size:11px;color:#7a8099">' + _aexHighlight(ex.notes, search) + '</div>' : '') +
      ((ex.tags && ex.tags.length) ? '<div style="display:flex;gap:5px;flex-wrap:wrap">' +
        ex.tags.map(function(tag) {
          return '<span style="font-size:10px;color:#c0c4d4;background:#1e2235;border:1px solid #3a3f55;border-radius:8px;padding:1px 8px">' + _aexHighlight(tag, search) + '</span>';
        }).join('') + '</div>' : '');
    list.appendChild(row);
  });
}

function agentExampleAddNew() {
  _agentExampleEditIdx = -1;
  document.getElementById('aex-modal-title').textContent = 'Add Cypher Example';
  document.getElementById('aex-question').value = '';
  document.getElementById('aex-cypher').value   = '';
  document.getElementById('aex-notes').value    = '';
  document.getElementById('aex-tags').value     = '';
  document.getElementById('aex-error').style.display = 'none';
  document.getElementById('agent-example-edit-modal').style.display = 'flex';
}

function agentExampleEdit(idx) {
  var ex = _agentExamplesCache[idx];
  if (!ex) return;
  _agentExampleEditIdx = idx;
  document.getElementById('aex-modal-title').textContent = 'Edit Cypher Example';
  document.getElementById('aex-question').value = ex.question || '';
  document.getElementById('aex-cypher').value   = ex.cypher   || '';
  document.getElementById('aex-notes').value    = ex.notes    || '';
  document.getElementById('aex-tags').value     = (ex.tags || []).join(', ');
  document.getElementById('aex-error').style.display = 'none';
  document.getElementById('agent-example-edit-modal').style.display = 'flex';
}

function closeAgentExampleEdit() {
  document.getElementById('agent-example-edit-modal').style.display = 'none';
}

async function agentExampleSave() {
  var question = document.getElementById('aex-question').value.trim();
  var cypher   = document.getElementById('aex-cypher').value.trim();
  var notes    = document.getElementById('aex-notes').value.trim();
  var tags     = document.getElementById('aex-tags').value.split(',')
                   .map(function(t) { return t.trim(); }).filter(Boolean);
  var errEl    = document.getElementById('aex-error');
  errEl.style.display = 'none';

  if (!cypher) {
    errEl.textContent = 'Cypher query is required.';
    errEl.style.display = 'block';
    return;
  }

  var entry = { question: question, cypher: cypher, notes: notes, tags: tags };
  var next  = _agentExamplesCache.slice();
  if (_agentExampleEditIdx >= 0) next[_agentExampleEditIdx] = entry;
  else next.push(entry);

  var saveBtn = document.getElementById('aex-save-btn');
  saveBtn.disabled = true;
  try {
    await api('/api/agent/examples', { examples: next }, 'PUT');
    _agentExamplesCache = next;
    closeAgentExampleEdit();
    _aexRender();
  } catch(e) {
    errEl.textContent = 'Save failed: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    saveBtn.disabled = false;
  }
}

async function agentExampleDelete(idx) {
  var ex = _agentExamplesCache[idx];
  if (!ex) return;
  if (!confirm('Delete this example?\n\n' + (ex.question || (ex.cypher || '').slice(0, 80)))) return;

  var next = _agentExamplesCache.slice();
  next.splice(idx, 1);
  try {
    await api('/api/agent/examples', { examples: next }, 'PUT');
    _agentExamplesCache = next;
    _aexRender();
  } catch(e) {
    alert('Delete failed: ' + e.message);
  }
}

// ── Config dialog ─────────────────────────────────────────────────────────────
var _AGENT_USER_CONFIG_KEY = 'agent_user_config_v1';

function _loadUserConfig() {
  try { return JSON.parse(localStorage.getItem(_AGENT_USER_CONFIG_KEY) || '{}'); }
  catch(e) { return {}; }
}
function _saveUserConfig(obj) {
  // apikey is intentionally excluded — see the _agentConfig initializer
  // comment above for why it must not be cached in localStorage.
  var toStore = { provider_name: obj.provider_name, url: obj.url, model_name: obj.model_name,
                  temperature: obj.temperature, top_p: obj.top_p, json_mode: obj.json_mode };
  try { localStorage.setItem(_AGENT_USER_CONFIG_KEY, JSON.stringify(toStore)); } catch(e) {}
}

function openAgentConfig() {
  _renderWorkflowSteps();
  document.getElementById('agent-config-modal').style.display = 'flex';
}

function closeAgentConfig() {
  document.getElementById('agent-config-modal').style.display = 'none';
}

function _syncWorkflowBtn() {
  var btn = document.getElementById('agent-run-workflow-btn');
  if (btn) btn.style.display = _agentWorkflow.length ? 'inline-block' : 'none';
}

function _renderWorkflowSteps() {
  var container = document.getElementById('acfg-workflow-steps');
  container.innerHTML = '';
  _syncWorkflowBtn();
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

// ── LLM Settings modal (admin) ─────────────────────────────────────────────────
var _llmsProviderRows = [];   // [{name, url}] — draft state while dialog is open

function llmsRenderProviders() {
  var container = document.getElementById('llms-providers-list');
  if (!container) return;
  container.innerHTML = '';
  if (!_llmsProviderRows.length) {
    container.innerHTML = '<div style="color:#5a6080;font-size:12px;padding:8px 0">No providers configured. Click "+ Add provider" to add one.</div>';
    return;
  }
  _llmsProviderRows.forEach(function(row, idx) {
    var div = document.createElement('div');
    div.style.cssText = 'display:grid;grid-template-columns:1fr 2fr auto;gap:8px;align-items:center;background:#252a40;border:1px solid #2a3050;border-radius:6px;padding:8px 10px';
    div.innerHTML =
      '<input type="text" placeholder="Name (e.g. Google Gemini)" value="' + escHtml(row.name) + '"' +
        ' oninput="_llmsUpdateRow(' + idx + ',\'name\',this.value)"' +
        ' style="background:#1e2235;border:1px solid #3a3f55;border-radius:4px;color:#e0e0e0;font-size:12px;padding:5px 8px;outline:none">' +
      '<input type="text" placeholder="Base URL (e.g. https://…/v1/)" value="' + escHtml(row.url) + '"' +
        ' oninput="_llmsUpdateRow(' + idx + ',\'url\',this.value)"' +
        ' style="background:#1e2235;border:1px solid #3a3f55;border-radius:4px;color:#e0e0e0;font-size:12px;padding:5px 8px;outline:none">' +
      '<button onclick="_llmsRemoveRow(' + idx + ')" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:18px;padding:0;line-height:1" title="Remove">×</button>';
    container.appendChild(div);
  });
}

function _llmsUpdateRow(idx, key, value) {
  if (_llmsProviderRows[idx]) _llmsProviderRows[idx][key] = value;
}
function _llmsRemoveRow(idx) {
  _llmsProviderRows.splice(idx, 1);
  llmsRenderProviders();
}
function llmsAddProvider() {
  _llmsProviderRows.push({ name: '', url: '' });
  llmsRenderProviders();
}

async function openLLMSettings() {
  document.getElementById('llm-settings-error').style.display   = 'none';
  document.getElementById('llm-settings-success').style.display = 'none';

  // Show/hide admin section based on role
  var adminSec = document.getElementById('llms-admin-section');
  if (adminSec) adminSec.style.display = (currentRole === 'admin') ? 'block' : 'none';

  try {
    var data = await api('/api/settings/llm', null, 'GET');
    _llmProviders = (data.providers || []);

    // Populate user provider dropdown from server list
    var sel = document.getElementById('llms-user-provider');
    sel.innerHTML = '<option value="">— Select provider —</option>';
    _llmProviders.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      sel.appendChild(opt);
    });

    // Restore user's saved LLM config into the dialog. The API key itself is
    // never held in _agentConfig outside of an active save/test action (see
    // the _agentConfig initializer comment) — fetch the per-user record here
    // so the field shows a masked placeholder when a key is already saved,
    // same convention as the Neo4j/Postgres password fields, rather than
    // looking blank/unset.
    var cfg = _agentConfig;
    var mine = {};
    try { mine = await api('/api/settings/my-llm', null, 'GET') || {}; } catch(e) { /* none saved yet */ }
    sel.value = mine.provider_name || cfg.provider_name || '';
    document.getElementById('llms-user-apikey').value      = mine.apikey      || '';
    document.getElementById('llms-user-model').value       = mine.model_name || cfg.model_name  || '';
    document.getElementById('llms-user-temperature').value = mine.temperature !== undefined ? mine.temperature : (cfg.temperature !== undefined ? cfg.temperature : 0.2);
    document.getElementById('llms-user-top-p').value       = mine.top_p       !== undefined ? mine.top_p       : (cfg.top_p       !== undefined ? cfg.top_p       : 0.9);
    document.getElementById('llms-user-json-mode').checked = mine.json_mode !== undefined ? !!mine.json_mode : !!cfg.json_mode;
    document.getElementById('llms-user-ping-result').textContent = '';

    // Admin section
    if (currentRole === 'admin') {
      _llmsProviderRows = _llmProviders.map(function(p) { return { name: p.name || '', url: p.url || '' }; });
      document.getElementById('llms-temperature').value = data.temperature !== undefined ? data.temperature : 0.2;
      document.getElementById('llms-top-p').value       = data.top_p      !== undefined ? data.top_p      : 0.9;
      document.getElementById('llms-json-mode').checked = !!data.json_mode;
      llmsRenderProviders();
    }
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

function llmsUserProviderChanged() {
  // Clear model list when provider changes
  document.getElementById('llms-user-model-list').innerHTML = '';
  document.getElementById('llms-user-model').value = '';
  document.getElementById('llms-user-models-status').textContent = '';
}

async function llmsUserFetchModels() {
  var provName = document.getElementById('llms-user-provider').value;
  var apikey   = document.getElementById('llms-user-apikey').value.trim();
  var statusEl = document.getElementById('llms-user-models-status');
  if (!provName) { statusEl.textContent = 'Select a provider first.'; return; }
  var prov = _llmProviders.find(function(p) { return p.name === provName; });
  if (!prov) { statusEl.textContent = 'Provider not found.'; return; }
  statusEl.textContent = 'Fetching…';
  try {
    var data = await api('/api/agent/list-models', { url: prov.url, apikey: apikey });
    var models = data.models || [];
    var dl = document.getElementById('llms-user-model-list');
    dl.innerHTML = models.map(function(m) { return '<option value="' + escHtml(m) + '">'; }).join('');
    statusEl.textContent = models.length + ' model' + (models.length !== 1 ? 's' : '') + ' available';
  } catch(e) {
    statusEl.textContent = 'Fetch failed: ' + e.message;
  }
}

async function llmsUserTestConnection() {
  var pingEl = document.getElementById('llms-user-ping-result');
  pingEl.textContent = '⏳ Testing…';
  var provName = document.getElementById('llms-user-provider').value;
  var prov = _llmProviders.find(function(p) { return p.name === provName; }) || {};
  var cfg = {
    url:        prov.url || '',
    apikey:     document.getElementById('llms-user-apikey').value.trim(),
    model_name: document.getElementById('llms-user-model').value.trim(),
    temperature: parseFloat(document.getElementById('llms-user-temperature').value) || 0.2,
    top_p:       parseFloat(document.getElementById('llms-user-top-p').value) || 0.9,
    json_mode:   document.getElementById('llms-user-json-mode').checked,
  };
  try {
    var res = await api('/api/agent/ping-llm', { llm: cfg });
    pingEl.style.color = res.ok ? '#4caf50' : '#ff6b6b';
    pingEl.textContent = res.ok ? ('✓ ' + (res.model || 'Connected')) : ('✗ ' + (res.error || 'Failed'));
  } catch(e) {
    pingEl.style.color = '#ff6b6b';
    pingEl.textContent = '✗ ' + e.message;
  }
}

async function saveLLMSettings() {
  var errEl   = document.getElementById('llm-settings-error');
  var okEl    = document.getElementById('llm-settings-success');
  var saveBtn = document.getElementById('llms-save-btn');
  errEl.style.display = 'none';
  okEl.style.display  = 'none';
  saveBtn.disabled    = true;

  // Save user LLM config: non-secret fields cache in localStorage for instant
  // UI restore; the full config (including apikey) persists server-side via
  // /api/settings/my-llm — see the _agentConfig initializer comment above for
  // why the API key itself must not go into localStorage.
  var provName = document.getElementById('llms-user-provider').value;
  var prov = _llmProviders.find(function(p) { return p.name === provName; }) || {};
  _agentConfig.provider_name = provName;
  _agentConfig.url           = prov.url || _agentConfig.url || '';
  _agentConfig.apikey        = document.getElementById('llms-user-apikey').value.trim();
  _agentConfig.model_name    = document.getElementById('llms-user-model').value.trim();
  _agentConfig.temperature   = parseFloat(document.getElementById('llms-user-temperature').value) || 0.2;
  _agentConfig.top_p         = parseFloat(document.getElementById('llms-user-top-p').value) || 0.9;
  _agentConfig.json_mode     = document.getElementById('llms-user-json-mode').checked;
  _saveUserConfig(_agentConfig);
  try {
    await api('/api/settings/my-llm', {
      provider_name: _agentConfig.provider_name,
      url:           _agentConfig.url,
      apikey:        _agentConfig.apikey,
      model_name:    _agentConfig.model_name,
      temperature:   _agentConfig.temperature,
      top_p:         _agentConfig.top_p,
      json_mode:     _agentConfig.json_mode,
    });
  } catch(e) {
    errEl.textContent = 'Save failed: ' + e.message;
    errEl.style.display = 'block';
    saveBtn.disabled = false;
    return;
  }

  // Admin: also save provider list + global defaults to server
  if (currentRole === 'admin') {
    var adminPayload = {
      providers:   _llmsProviderRows.filter(function(r) { return r.name.trim() && r.url.trim(); }),
      temperature: parseFloat(document.getElementById('llms-temperature').value) || 0.2,
      top_p:       parseFloat(document.getElementById('llms-top-p').value) || 0.9,
      json_mode:   document.getElementById('llms-json-mode').checked,
    };
    try {
      await api('/api/settings/llm', adminPayload);
      _llmProviders = adminPayload.providers.slice();
    } catch(e) {
      errEl.textContent = 'Admin save failed: ' + e.message;
      errEl.style.display = 'block';
      saveBtn.disabled = false;
      return;
    }
  }

  // Push the active user config to the agent service. apikey is deliberately
  // NOT included here — it was just persisted server-side above via
  // /api/settings/my-llm, and agent_service.py now resolves it per-user from
  // that same trusted store (see _resolve_llm_cfg). Sending it from here
  // would risk forwarding the literal "••••••••" mask (when the field was
  // left untouched because a key was already saved) as if it were a real key.
  var pushPayload = { model_name:  _agentConfig.model_name  || null,
                      url:         _agentConfig.url          || null,
                      temperature: _agentConfig.temperature,
                      top_p:       _agentConfig.top_p,
                      json_mode:   _agentConfig.json_mode    || false };
  api('/api/agent/llm-config', pushPayload)
    .catch(function(e) { console.warn('Agent LLM config push failed:', e); });

  okEl.textContent   = 'Settings saved.';
  okEl.style.display = 'block';
  saveBtn.disabled = false;
}

// ── Agent write-relation confirmation ────────────────────────────────────────

var _awrPending = null;   // current write_relation payload awaiting user confirmation
var _awrRefs    = [];     // mutable reference list shown in the confirmation modal

function _agentShowWriteRelModal(wr) {
  _awrPending = wr;
  _awrRefs    = (wr.references || []).map(function(r) { return Object.assign({}, r); });

  var src   = wr.source_node  || {};
  var tgt   = wr.target_node  || {};
  var props = wr.properties   || {};

  document.getElementById('awr-src-name').textContent    = src.name  || src.node_id || '—';
  document.getElementById('awr-src-label').textContent   = src.node_label || '';
  document.getElementById('awr-tgt-name').textContent    = tgt.name  || tgt.node_id || '—';
  document.getElementById('awr-tgt-label').textContent   = tgt.node_label || '';
  document.getElementById('awr-rel-type').textContent    = wr.relation_type || '—';
  document.getElementById('awr-relation-id').textContent = wr.relation_id || '';
  document.getElementById('awr-source').value     = props.source    || '';
  document.getElementById('awr-effect').value     = props.Effect    || '';
  document.getElementById('awr-mechanism').value  = props.Mechanism || '';
  document.getElementById('awr-ontology').value   = props.Ontology  || '';

  _awrRenderRefs();

  var statusEl = document.getElementById('awr-status');
  statusEl.style.display = 'none';
  statusEl.textContent = '';

  // Adjust modal title and button label based on mode
  var isAddRefs = (wr.mode === 'add_references');
  var titleEl = document.getElementById('awr-modal-title');
  if (titleEl) {
    titleEl.textContent = isAddRefs
      ? 'Add References to Existing Relation'
      : 'Create New Relation';
  }
  var modeNoteEl = document.getElementById('awr-mode-note');
  if (modeNoteEl) {
    if (isAddRefs) {
      modeNoteEl.textContent = 'This relation already exists in the graph. Only new references (not already in the database) will be added.';
      modeNoteEl.style.display = 'block';
    } else {
      modeNoteEl.style.display = 'none';
    }
  }

  var btn = document.getElementById('awr-confirm-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = isAddRefs ? 'Add References' : 'Save to Database';
  }

  document.getElementById('agent-write-rel-modal').style.display = 'flex';
}

function _awrRenderRefs() {
  var section  = document.getElementById('awr-refs-section');
  var listEl   = document.getElementById('awr-refs-list');
  var countEl  = document.getElementById('awr-refs-count');

  if (!_awrRefs.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'flex';
  countEl.textContent = _awrRefs.length + ' reference' + (_awrRefs.length !== 1 ? 's' : '');

  listEl.innerHTML = _awrRefs.map(function(ref, i) {
    var title   = _esc(ref.title   || ref.pmid || '(no title)');
    var authors = _esc(ref.authors || '');
    var year    = _esc(String(ref.pubyear || ref.year || ''));
    var journal = _esc(ref.journal || '');
    var pmid    = ref.pmid ? '<a href="https://pubmed.ncbi.nlm.nih.gov/' + _esc(ref.pmid) + '/" target="_blank" style="color:#8ab4f8;font-size:10px">PMID ' + _esc(ref.pmid) + '</a>' : '';
    return (
      '<div style="background:#252a40;border-radius:6px;padding:8px 10px;display:flex;gap:10px;align-items:flex-start">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;color:#e0e0e0;line-height:1.4;margin-bottom:2px">' + title + '</div>' +
          (authors ? '<div style="font-size:10px;color:#7a8099">' + authors + (year ? ' (' + year + ')' : '') + '</div>' : '') +
          (journal ? '<div style="font-size:10px;color:#7a8099;font-style:italic">' + journal + '</div>' : '') +
          (pmid    ? '<div style="margin-top:3px">' + pmid + '</div>' : '') +
        '</div>' +
        '<button onclick="_awrRemoveRef(' + i + ')" title="Remove this reference" ' +
          'style="background:none;border:none;color:#7a8099;font-size:16px;cursor:pointer;padding:0;line-height:1;flex-shrink:0">×</button>' +
      '</div>'
    );
  }).join('');
}

function _awrRemoveRef(idx) {
  _awrRefs.splice(idx, 1);
  _awrRenderRefs();
}

function _agentWriteRelCancel() {
  document.getElementById('agent-write-rel-modal').style.display = 'none';
  _awrPending = null;
}

async function _agentWriteRelConfirm() {
  if (!_awrPending) return;
  var wr    = _awrPending;
  var src   = wr.source_node || {};
  var tgt   = wr.target_node || {};
  var btn   = document.getElementById('awr-confirm-btn');
  var statusEl = document.getElementById('awr-status');

  // Collect (possibly edited) property values from the modal
  var props = Object.assign({}, wr.properties || {}, {
    Effect:    document.getElementById('awr-effect').value    || '',
    Mechanism: document.getElementById('awr-mechanism').value || '',
    Ontology:  document.getElementById('awr-ontology').value  || '',
    source:    document.getElementById('awr-source').value    || wr.properties.source || '',
  });
  // Remove empty strings to keep Neo4j clean
  Object.keys(props).forEach(function(k) { if (props[k] === '') delete props[k]; });

  btn.disabled    = true;
  btn.textContent = 'Saving…';
  statusEl.style.display = 'none';

  try {
    var payload = {
      sourceNode:   { nodeId: src.node_id, nodeLabel: src.node_label },
      targetNode:   { nodeId: tgt.node_id, nodeLabel: tgt.node_label },
      relationType: wr.relation_type,
      properties:   props,
      relationId:   wr.relation_id,
      isNew:        true,
      references:   _awrRefs.slice(),   // snapshot of the (possibly trimmed) reference list
    };

    var result = await api('/api/curation/write-relation', payload);

    if (result && result.success) {
      var isAddRefs = (wr.mode === 'add_references');
      statusEl.style.cssText = 'display:block;color:#4caf50;background:#1a3a1a;border-radius:5px;padding:8px 12px;font-size:12px';
      statusEl.textContent = isAddRefs
        ? '✓ References added — RelationID: ' + (result.relationId || wr.relation_id)
        : '✓ Relation saved — RelationID: ' + (result.relationId || wr.relation_id);
      btn.textContent = 'Saved ✓';

      // Echo success back into the chat
      var refNote = _awrRefs.length
        ? '\n' + _awrRefs.length + ' reference' + (_awrRefs.length !== 1 ? 's' : '') + ' added.'
        : '';
      var chatMsg = isAddRefs
        ? ('✅ References added to existing relation.\n' +
           '**' + (src.name || src.node_id) + '** → **' + wr.relation_type + '** → **' + (tgt.name || tgt.node_id) + '**\n' +
           'RelationID: `' + (result.relationId || wr.relation_id) + '`' + refNote)
        : ('✅ Relation created successfully.\n' +
           '**' + (src.name || src.node_id) + '** → **' + wr.relation_type + '** → **' + (tgt.name || tgt.node_id) + '**\n' +
           'RelationID: `' + (result.relationId || wr.relation_id) + '`  source: `' + (props.source || '') + '`' + refNote);
      _agentAppendMessage('assistant', chatMsg);

      // Close modal after short delay
      setTimeout(function() {
        document.getElementById('agent-write-rel-modal').style.display = 'none';
        _awrPending = null;
      }, 1800);
    } else {
      throw new Error((result && result.error) || 'Server returned failure');
    }
  } catch(err) {
    statusEl.style.cssText = 'display:block;color:#e57373;background:#3a1c1c;border-radius:5px;padding:8px 12px;font-size:12px';
    statusEl.textContent = '✗ Save failed: ' + (err.message || String(err));
    btn.disabled    = false;
    btn.textContent = 'Retry';
  }
}

// ── Agent visualization render hook ──────────────────────────────────────────

var _RENDER_LABELS = {
  'graph':                  'Graph view',
  'sankey':                 'Sankey diagram',
  'relations_table':        'Relations table',
  'references_table':       'References table',
  'export_excel_relations': 'Excel export (relations)',
  'export_excel_references':'Excel export (references)',
  'export_csv_relations':   'CSV export (relations)',
  'export_csv_references':  'CSV export (references)',
};

async function _agentRenderResult(action) {
  if (!action || !action.tool) return;
  var tool        = action.tool;
  var cypher      = (action.cypher || '').trim();
  var label       = _RENDER_LABELS[tool] || tool;
  var wantsNewTab = !!action.new_tab;

  if (cypher) {
    _agentLastCypher = cypher;
  }

  if (tool === 'graph' || tool === 'relations_table' || tool === 'references_table') {
    if (cypher) {
      // "new_tab" — user asked for a new window/tab instead of replacing the current view.
      // Graph Explorer has no separate browser window for results, so a new tab is the
      // equivalent: open one, then run the query into it (runQuery() always targets
      // whichever tab is currently active).
      if (wantsNewTab && typeof createNewTab === 'function') {
        createNewTab('Agent result');
        _agentAppendMessage('assistant', 'Opened a new tab for this result.');
      }
      agentLoadCypherToBar();
      // Give the query-bar textarea's 'input' event (dispatched by agentLoadCypherToBar)
      // a moment to settle before running — matches the previous setTimeout-based timing,
      // just awaited so we can reliably act once the graph has actually finished loading.
      await new Promise(function(resolve) { setTimeout(resolve, 100); });
      // "mode": "add" — the user asked to ADD to the current graph ("add BRCA1 to
      // the graph") rather than replace it. Only meaningful for the graph tool —
      // tables always just show the query's own results.
      var _wantsAdd = tool === 'graph' && action.mode === 'add';
      await runQuery(_wantsAdd);

      // Show the actual query that populated the graph as its own visible,
      // clickable code box in the chat log. Without this, a turn that runs a
      // separate "cypher" action first (for the chat-text report) and then a
      // "render" action (for the graph itself) only ever shows the FIRST
      // query's box (see result.generated_cypher in the main chat handler) —
      // the render action's own cypher is used to populate the Query Bar and
      // run silently, with no visible record of what it actually was. That
      // made a real render-query bug (a discovery-shaped query mistakenly
      // reused for rendering, producing far fewer nodes/edges than expected)
      // impossible for the user to diagnose, since the only cypher visible in
      // the chat was the earlier, unrelated discovery query.
      _agentAppendMessage('assistant', 'Rendered the graph using this query:', cypher);

      // Optional "layout" hint on the render block — e.g. the user asked for a
      // hierarchical/tree/circular arrangement instead of the default force-directed
      // one. Only meaningful for the graph view (tables have no layout concept).
      // Validated against the same layout names applyLayout() actually supports, so
      // a hallucinated value is silently ignored rather than throwing.
      if (tool === 'graph' && action.layout) {
        var _layoutName = String(action.layout).trim().toLowerCase();
        var _validLayouts = ['cose', 'dagre', 'circle', 'concentric', 'grid', 'klay'];
        if (_validLayouts.indexOf(_layoutName) !== -1 && typeof applyLayout === 'function') {
          applyLayout(_layoutName);
        } else if (_layoutName) {
          console.warn('Agent requested unknown layout "' + action.layout + '" — ignored.');
        }
      }

      // Optional "edge_references" — sentence-mining / keyword-filtered results. Maps
      // RelationID (string) -> an array of reference rows the agent already found (e.g. via
      // a Postgres keyword search). Pre-loading refsCache with these means the edge tooltip
      // shows ONLY the matched sentence(s) instead of fetching and showing the relation's
      // full, unfiltered reference list on hover. runQuery() (awaited above) already reset
      // refsCache for the new graph, so it's safe to populate it here.
      if (action.edge_references && typeof action.edge_references === 'object') {
        var _refCount = 0;
        Object.keys(action.edge_references).forEach(function(relId) {
          var refs = action.edge_references[relId];
          if (Array.isArray(refs)) { refsCache[relId] = refs; _refCount++; }
        });
        if (_refCount > 0) {
          _agentAppendMessage('assistant', 'Loaded keyword-matched reference(s) into the tooltip for ' +
            _refCount + ' edge' + (_refCount !== 1 ? 's' : '') + ' — hover an edge to see them.');
        }
      }
    }
  } else if (tool === 'sankey') {
    if (cypher) {
      // Actually open the Sankey dialog first — it's a hidden modal (#sankey-modal),
      // not part of the tab canvas, so it needs to be shown explicitly before its
      // textarea can be used. (This branch previously looked for a "#sankey-query-input"
      // element that never existed — the real id is "#sankey-cypher" — so it always
      // silently fell through to loading the query into the main Query Bar instead of
      // ever showing the Sankey diagram.)
      if (typeof openSankeyDialog === 'function') openSankeyDialog();
      var sankeyInput = document.getElementById('sankey-cypher');
      if (sankeyInput) {
        sankeyInput.value = cypher;
        await runSankeyQuery();
      } else {
        agentLoadCypherToBar();
        _agentAppendMessage('assistant', 'Sankey query loaded into the Query Bar.');
      }
    }
  } else if (tool === 'export_excel_relations' || tool === 'export_csv_relations') {
    if (cypher) exportQueryRelations(cypher);
  } else if (tool === 'export_excel_references' || tool === 'export_csv_references') {
    if (cypher) exportQueryReferences(cypher);
  } else {
    _agentAppendMessage('assistant', 'Render tool "' + label + '" is not yet supported.');
  }
}

// ── Vocabulary manager ────────────────────────────────────────────────────────
// Recovered from backup/cypher_examples.zip — this implementation existed before
// a prior editing session (predating this one) truncated it out of app.js, leaving
// just this stub comment and a dead "🧠 Vocabulary" button. The HTML modal in
// index.html (#agent-vocab-modal etc.) was never lost — only these functions were.
var _vocabData = [];

async function openAgentVocabulary() {
  var modal = document.getElementById('agent-vocab-modal');
  modal.style.display = 'flex';
  await agentVocabRefresh();
}

function closeAgentVocabulary() {
  document.getElementById('agent-vocab-modal').style.display = 'none';
}

async function agentVocabRefresh() {
  var tbody = document.getElementById('agent-vocab-rows');
  tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:#7a8099">Loading…</td></tr>';
  try {
    var data = await api('/api/agent/vocabulary', null, 'GET');
    _vocabData = data.mappings || [];
    _renderVocabRows();
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:#e57373">Failed to load: ' + e.message + '</td></tr>';
  }
}

function _renderVocabRows() {
  var tbody = document.getElementById('agent-vocab-rows');
  if (!_vocabData.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:#7a8099">No vocabulary yet — start chatting and the agent will learn your terminology automatically.</td></tr>';
    return;
  }
  tbody.innerHTML = _vocabData.map(function(m, i) {
    var tick    = m.confirmed ? '<span style="color:#4caf50;font-weight:700">✓</span>' : '<span style="color:#7a8099">○</span>';
    var btnConf = m.confirmed ? '' :
      '<button onclick="agentVocabConfirm(' + i + ')" style="padding:2px 8px;background:#2e5d3a;border:1px solid #4caf50;border-radius:4px;color:#4caf50;font-size:11px;cursor:pointer">✓ Confirm</button>';
    return '<tr style="border-bottom:1px solid #2a2f45">' +
      '<td style="padding:7px 8px;color:#e0e0e0">' + _esc(m.user_term) + '</td>' +
      '<td style="padding:7px 8px;color:#8ab4f8;font-family:monospace">' + _esc(m.neo4j_name) + '</td>' +
      '<td style="padding:7px 8px;color:#7a8099;font-size:11px">' + _esc(m.neo4j_label || '') + '</td>' +
      '<td style="padding:7px 8px;text-align:center;color:#aaa">' + tick + ' ' + (m.use_count || 1) + '</td>' +
      '<td style="padding:7px 8px;text-align:center;display:flex;gap:6px;justify-content:center">' +
        btnConf +
        '<button onclick="agentVocabDelete(' + i + ')" style="padding:2px 8px;background:#3a1c1c;border:1px solid #e57373;border-radius:4px;color:#e57373;font-size:11px;cursor:pointer">✕</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function _esc(s) {
  // Escapes both quote characters, not just &/</> — this is used to build
  // HTML attribute values (e.g. href="..."), and previously did NOT escape
  // '"' at all, so a PubMed reference field (pmid/title/etc, which can
  // reach this from external data, e.g. article metadata) containing a
  // double-quote could break out of a double-quoted attribute and inject
  // arbitrary attributes/event handlers (CodeQL: incomplete HTML attribute
  // sanitization). Escaping both quote characters makes this safe regardless
  // of whether the call site happens to use single- or double-quoted
  // attributes.
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function agentVocabConfirm(idx) {
  var m = _vocabData[idx];
  if (!m) return;
  try {
    await api('/api/agent/vocabulary/confirm', { user_term: m.user_term, neo4j_name: m.neo4j_name, neo4j_label: m.neo4j_label || '' }, 'PUT');
    m.confirmed = true;
    m.use_count = (m.use_count || 1) + 1;
    _renderVocabRows();
  } catch(e) { alert('Failed: ' + e.message); }
}

async function agentVocabDelete(idx) {
  var m = _vocabData[idx];
  if (!m) return;
  if (!confirm('Remove mapping "' + m.user_term + '" → ' + m.neo4j_name + '?')) return;
  try {
    var qs = '?user_term=' + encodeURIComponent(m.user_term) + '&neo4j_name=' + encodeURIComponent(m.neo4j_name);
    await apiDelete('/api/agent/vocabulary' + qs);
    _vocabData.splice(idx, 1);
    _renderVocabRows();
  } catch(e) { alert('Failed: ' + e.message); }
}

async function agentVocabAdd() {
  var term  = (document.getElementById('vocab-new-term').value  || '').trim();
  var name  = (document.getElementById('vocab-new-name').value  || '').trim();
  var label = (document.getElementById('vocab-new-label').value || '').trim();
  if (!term || !name) { alert('Please fill in both "Your term" and "Neo4j name".'); return; }
  try {
    await api('/api/agent/vocabulary', { user_term: term, neo4j_name: name, neo4j_label: label, confirmed: true }, 'POST');
    document.getElementById('vocab-new-term').value  = '';
    document.getElementById('vocab-new-name').value  = '';
    document.getElementById('vocab-new-label').value = '';
    await agentVocabRefresh();
  } catch(e) { alert('Failed: ' + e.message); }
}
