"""
rnef_index.py - walk a pathway-collection directory ONCE and extract
lightweight per-pathway METADATA for the Pathway Collection Search feature
(indexing only -- does NOT build the full render-ready graph JSON that
rnef_to_json.py produces).

Runs as a single process for the whole directory (rather than one process
per file) since spawning a fresh Python interpreter per file dominated
runtime in testing versus the actual XML parsing work, which is
comparatively fast.

PERFORMANCE NOTE: real pathway collections can contain individual .rnef
files hundreds of MB in size (one observed sample was 555MB). A plain
ET.parse() (full in-memory DOM) on a file that size is slow and memory-
heavy. This script instead uses iterparse() in streaming mode: each
top-level <resnet> is fully built (so extract_pathway() can still use the
normal ElementTree API on it), then immediately processed and discarded via
root.clear() so memory never holds more than one resnet's worth of DOM at a
time, regardless of total file size.

A single RNEF file is almost always a <batch> containing multiple <resnet>
elements: real named pathways/groups (type="Pathway" or type="Group") AND
auxiliary, unnamed "folder structure" resnets (Folder-type nodes linked by
MemberOf controls, describing where a pathway lives in the source system's
own folder tree -- redundant with this file's actual location on disk,
which is what we use instead). Only named, type="Pathway" resnets are
indexed as searchable pathways; everything else is skipped.

Symlinks (REQ-1.02): a symlinked .rnef/.graph.json file is followed and
indexed once under whichever path os.walk visits first; symlinked
directories are followed too (os.walk passes followlinks=True) but guards
against symlink cycles via a visited-realpath set.

Usage:
    python rnef_index.py <root_directory> [output_file.json]
If output_file.json is given, the result is written directly to that file
(streamed via json.dump) instead of printed to stdout — the caller (see
server.js) should always pass one for a real collection: a large collection
can produce enough JSON that piping it through a parent process's stdout
buffer risks "RangeError: Invalid string length" (V8's own max string-length
limit, independent of and sometimes smaller than any subprocess maxBuffer
setting) — writing straight to disk avoids that entirely. Result shape:
{
  "pathways": [ {
      "name": str,
      "resnetType": str,        -- 'Pathway' or 'Group' (a named member-list
                                    resnet with no <controls> at all, e.g. a
                                    "..._group.rnef" gene/protein list) -- both
                                    are indexed for Browse/Text Search, but
                                    server.js excludes 'Group' entries from the
                                    urn -> pathway map (Entity/Combined Search),
                                    since a large generic gene list would
                                    otherwise match nearly any selection
      "properties": {attrName: value, ...},   -- everything found under this
                                                  resnet's <properties> (e.g.
                                                  Description, Notes) captured
                                                  generically, not hardcoded
                                                  to specific field names
      "anatomy": {category: [term, ...], ...},  -- Anatomy Index annotation
                                                    fields (Organ, Organ
                                                    System, Organelle, Tissue,
                                                    CellType), deduplicated
                                                    per pathway
      "nodeUrns": [str, ...],   -- every node's URN in this pathway, for the
                                    urn -> pathway index (Entity Search)
      "sourceFile": str, "subfolder": str
  }, ... ],
  "filesScanned": int, "filesFailed": int,
  "errors": [ {"file": str, "error": str}, ... ],
  "nodeTypeCounts": {NodeType: count, ...}   -- GLOBAL, unique per urn across
                                                the whole collection (REQ-3.72);
                                                NOT a per-pathway breakdown and
                                                NOT a sum of each pathway's own
                                                counts (which would multiply-
                                                count any node shared by more
                                                than one pathway)
  "totalUniqueEntities": int   -- count of DISTINCT urns across the whole
                                  collection (len of the same seen_urns set
                                  used for nodeTypeCounts) -- the background
                                  population size (REQ-3.24) an Entity
                                  Search Fisher exact test needs
  "relationTypeCounts": {ControlType: count, ...}   -- GLOBAL, deduplicated
                                  per type (REQ-3.72): a relation is keyed by
                                  its (sorted endpoint URNs by role,
                                  ControlType, Effect), so the same relation
                                  copy-pasted into multiple pathways counts
                                  once, matching how redundant/identical
                                  relations actually occur in this data
  "totalUniqueReferences": int -- count of DISTINCT DOI-else-PMID reference
                                  ids across the whole collection (REQ-3.73)
  "totalSupportingSentences": int -- total count of (relation, reference)
                                  pairs with a non-empty supporting Sentence
                                  (REQ-3.72), summed across the collection
}

Progress reporting: WHILE running, this script also prints one JSON-lines
event per completed file to stdout (flushed immediately), so the caller can
show live progress without waiting for the whole run to finish:
    {"type": "start", "filesTotal": int}
    {"type": "progress", "filesProcessed": int, "filesRemaining": int,
     "filesTotal": int, "currentFile": str, "currentSubfolder": str,
     "pathwayNamesInFile": [str, ...], "pathwaysIndexedSoFar": int}
"currentFile"/"currentSubfolder" describe the most recently COMPLETED file,
not one truly in-flight -- files are parsed concurrently across a worker
pool, and imap_unordered only surfaces a result once a worker finishes an
entire file, so true "currently processing" visibility per in-progress file
would need extra cross-process signaling for little practical benefit (with
several workers running, the completed-file stream still updates
frequently). Pathway progress isn't reported directly since the total
pathway count isn't known until every file has been parsed -- file counts
are known upfront instead, which is what "remaining" is based on.
These lines are ONLY emitted when out_path is given -- the CLI's own
stdout-fallback branch (no out_path) still prints the final result as a
single JSON blob, so mixing that with progress lines would break parsing;
that fallback is for manual testing only, server.js always passes out_path.
"""

import xml.etree.ElementTree as ET
import json, sys, os, re
import multiprocessing as mp
from collections import Counter

# Shared with rnef_to_json.py so a pathway's edited-and-saved .graph.json
# filename and the dedup grouping key below (see _dedupe_pathways()) are
# always computed the SAME way -- otherwise a save could produce a file that
# this script's own dedup logic fails to recognize as the same identity as
# the .rnef it was edited from.
from rnef_to_json import safe_filename

# Anatomy Index (Phase 3): RNEF <properties> attr names that annotate a
# pathway's anatomical context, mapped (case-insensitively) to the fixed set
# of categories the index groups by. "Organelle" is sometimes authored as
# "Cell object" instead, matching Neo4j's CellObject node label -- both map
# to the same "Organelle" category so they show up together in the index.
_ANATOMY_FIELD_ALIASES = {
    'organ': 'Organ',
    'organ system': 'Organ System',
    'organelle': 'Organelle',
    'cell object': 'Organelle',
    'tissue': 'Tissue',
    'celltype': 'CellType',
    'cell type': 'CellType',
}
# Raw values look like "pancreas {Organ urn:agi-ncimorgan:C1278931}" -- strips
# the trailing brace tag to leave just the human-readable term.
_ANATOMY_TERM_SUFFIX_RE = re.compile(r'\s*\{[^}]*\}\s*$')


def _emit_progress(obj):
    """Print one JSON-lines progress event to stdout and flush immediately,
    so the parent process (server.js, reading this child's stdout as it
    streams) sees it right away rather than whenever Python's own stdout
    buffer happens to fill or the process exits."""
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def extract_pathway(resnet):
    """Name (the pathway's own resnet attribute) plus every attribute found
    in its <properties> section (Description, Notes, and any other attr
    present there, captured generically rather than hardcoded), each node's
    URN and NodeType, and now (for Statistics, REQ-3.72/3.73) a LIGHTWEIGHT
    pass over <controls>: a dedup key per relation (endpoint URNs by role +
    ControlType + Effect), and per-reference DOI-else-PMID id + whether a
    Sentence is present. None of this is stored per pathway in the final
    output -- see the *Local fields below, which extract_pathways_from_file()
    /walk_directory() merge into GLOBAL accumulators and then discard, the
    same pattern already used for node types. An earlier version of this
    script DID persist full reference id LISTS per pathway -- a single
    real-world pathway was observed with over 30,000 of those, and across a
    whole collection the resulting index was large enough to crash Node's
    execFile stdout handling outright. Collecting the same underlying data
    but only ever merging it into small global counters/sets (never
    serializing a per-pathway list) avoids repeating that mistake."""
    # Real exported files aren't consistent about attribute capitalization --
    # most use lowercase "name", but a real, substantial share (roughly a
    # quarter of named resnets in this collection) use "Name" instead. Only
    # checking the lowercase form silently dropped every one of those
    # pathways from the entire index (Text/Entity/Combined Search, Browse,
    # Alphabetical/Anatomy Index, Statistics -- all of it), with no error or
    # warning, since a resnet with no recognized name looks identical to a
    # genuine unnamed folder-structure resnet that's SUPPOSED to be skipped.
    name = resnet.get('name') or resnet.get('Name')
    rtype = resnet.get('type', '')
    # The pathway's OWN identifying URN (e.g. "urn:agi-pathway:uuid-...") is an
    # attribute of the <resnet> element itself, not something that shows up
    # among its <nodes> -- confirmed against real data (a resnet's own urn=
    # attribute is a totally separate thing from any node's urn inside it).
    # Never previously captured anywhere; needed so a "Pathway Alias" /
    # symlink manifest elsewhere in the collection (see
    # _extract_alias_records() below) can be resolved back to the real
    # pathway it references, by matching THAT reference urn against this
    # field across the index.
    pathway_urn = resnet.get('urn') or resnet.get('URN')
    # "Group" resnets are pure member lists (e.g. "Genes with Mutations
    # Associated with X_group.rnef") -- named, with normal <properties>
    # metadata, but no <controls> at all (just <nodes>, no relations). They
    # should be searchable/browsable like any other entry, but their node
    # lists are typically large, generic gene/protein sets that would match
    # almost any Entity Search selection -- so they're tagged with their own
    # resnetType here and excluded from the urn -> pathway map specifically
    # (see server.js's buildPathwaySearchStructures()), not from indexing.
    if not name or rtype not in ('Pathway', 'Group'):
        return None  # unnamed folder-structure resnet, or some other non-pathway type

    properties = {}
    # Anatomy annotation fields (Organ, Organ System, Organelle, Tissue,
    # CellType) for the Anatomy Index feature -- category -> [term, ...],
    # deduplicated per pathway. Unlike Description/Notes (single-valued,
    # last-one-wins is fine), a pathway can carry SEVERAL values for the
    # same field -- e.g. four separate <attr name="CellType" .../> entries
    # for four different cell types -- as repeated <attr> elements sharing
    # the same name, not a delimited list within one value. "Organelle" is
    # sometimes authored as "Cell object"/"Cell Object" instead (matching
    # Neo4j's CellObject node label), so both names map to the same
    # "Organelle" category. Each raw value looks like
    # "pancreas {Organ urn:agi-ncimorgan:C1278931}" -- the human-readable
    # term is just the part before that trailing brace tag.
    anatomy = {}
    properties_el = resnet.find('properties')
    if properties_el is not None:
        for attr in properties_el.findall('attr'):
            n, v = attr.get('name'), attr.get('value', '')
            if not n:
                continue
            properties[n] = v
            category = _ANATOMY_FIELD_ALIASES.get(n.strip().lower())
            if category and v:
                term = _ANATOMY_TERM_SUFFIX_RE.sub('', v).strip()
                if term:
                    terms = anatomy.setdefault(category, [])
                    if term not in terms:
                        terms.append(term)

    node_urns = []
    node_types = {}       # urn -> NodeType, LOCAL to this one pathway only -- see
                          # walk_directory() for why this needs a GLOBAL, not
                          # per-pathway-summed, dedup (a node like TP53 can appear
                          # in many different pathways and must count once overall).
    local_id_to_urn = {}  # a <link ref="..."> refers to a node's local_id, which
                          # is NOT always the same string as its urn (e.g. a
                          # pathway's own self-node commonly has local_id="P0"
                          # but a real urn:agi-pathway:... urn) -- needed to
                          # resolve control links back to stable urns below.
    nodes_el = resnet.find('nodes')
    if nodes_el is not None:
        for node in nodes_el.findall('node'):
            nurn = node.get('urn') or node.get('local_id')
            if not nurn:
                continue
            node_urns.append(nurn)
            local_id = node.get('local_id')
            if local_id:
                local_id_to_urn[local_id] = nurn
            ntype = 'Unknown'
            for attr in node.findall('attr'):
                if attr.get('name') == 'NodeType':
                    ntype = attr.get('value', 'Unknown')
                    break
            node_types[nurn] = ntype

    # Pathways commonly contain redundant/identical relations (the same
    # curated fact copy-pasted into more than one pathway document), so
    # "Number of Relations (grouped by Relation Type)" needs deduplication,
    # not a raw count of <control> elements. calcRelationId() in server.js
    # (used by the Create/Edit relation dialog) computes Neo4j's real
    # RelationID from a tuple of (sorted endpoint NodeIDs, ControlType,
    # ontology, relationship, effect, mechanism) -- but RNEF files don't
    # carry Neo4j's internal NodeID at all (only NodeType/Name/URN), so an
    # identical hash isn't reproducible from RNEF data alone without a live
    # Neo4j lookup per node. Instead, this builds an equivalent dedup key
    # from what RNEF actually has: each endpoint's stable URN (sorted per
    # role) + ControlType + Effect -- same practical effect (two relations
    # with the same endpoints, type, and effect collapse to one), without
    # requiring database connectivity during indexing.
    relation_dedup_keys = set()
    # References/sentences need global dedup too (REQ-3.73 explicitly:
    # unique identifiers, DOI else PMID) -- the same paper can be cited to
    # support relations in many different pathways.
    reference_ids = set()
    sentence_count = 0
    controls_el = resnet.find('controls')
    if controls_el is not None:
        for ctrl in controls_el.findall('control'):
            ctype = 'Regulation'
            effect = ''
            refs_by_idx = {}
            in_refs, out_refs, inout_refs = [], [], []
            for link in ctrl.findall('link'):
                lt  = link.get('type', '')
                ref = link.get('ref')
                if not ref:
                    continue
                resolved = local_id_to_urn.get(ref, ref)
                if lt == 'in':
                    in_refs.append(resolved)
                elif lt == 'out':
                    out_refs.append(resolved)
                elif lt == 'in-out':
                    inout_refs.append(resolved)
            for attr in ctrl.findall('attr'):
                n, v, idx = attr.get('name', ''), attr.get('value', ''), attr.get('index')
                if n == 'ControlType':
                    ctype = v
                elif n == 'Effect':
                    effect = v
                elif idx is not None:
                    refs_by_idx.setdefault(idx, {})[n] = v
            if not effect:
                # Same fallback rnef_to_json.py uses: some RNEF exports encode
                # effect in the control's own local_id rather than as an attr.
                m = re.search(r':(positive|negative|unknown):', ctrl.get('local_id', ''), re.IGNORECASE)
                if m:
                    effect = m.group(1)

            relation_dedup_keys.add((
                tuple(sorted(in_refs)), tuple(sorted(inout_refs)), tuple(sorted(out_refs)),
                ctype, effect.lower(),
            ))
            for ref_attrs in refs_by_idx.values():
                doi, pmid = ref_attrs.get('DOI', ''), ref_attrs.get('PMID', '')
                if doi:
                    reference_ids.add('doi:' + doi)
                elif pmid:
                    reference_ids.add('pmid:' + pmid)
                if ref_attrs.get('Sentence'):
                    sentence_count += 1

    return {
        'name': name,
        'resnetType': rtype,   # 'Pathway' or 'Group' -- see server.js's urn2pathway map building
        'pathwayUrn': pathway_urn,   # see comment above -- used to resolve Pathway Alias targets
        'properties': properties,
        'anatomy': anatomy,    # category -> [term, ...], persisted per pathway (Anatomy Index)
        'nodeUrns': node_urns,
        # Everything below is stripped out again in walk_directory() after
        # being merged into global accumulators -- never persisted per
        # pathway in the final index.
        'nodeTypesLocal': node_types,
        'relationDedupKeysLocal': relation_dedup_keys,
        'referenceIdsLocal': reference_ids,
        'sentenceCountLocal': sentence_count,
    }


# ── Pathway Alias ("symlink") manifests ───────────────────────────────────────
# A curated collection can reuse the SAME pathway across multiple disease/
# process folders without duplicating its content, via a sidecar
# "<FolderName>_symlinks.rnef" file: a <resnet> with NO name/type of its own
# (so extract_pathway() above returns None for it -- it isn't a pathway),
# whose <nodes> list the ALIASED pathways (NodeType="Pathway", each carrying
# the REAL pathway's own urn) and a Folder node for the containing folder,
# joined by <control ControlType="MemberOf"> links carrying
# <attr name="Relationship" value="symlink"/>. Confirmed against the real
# file at CuratedPathways\Biological Process\Aging Biology\
# Aging Related Diseases\Aging Related Diseases_symlinks.rnef.
#
# Each alias becomes its own lightweight index entry (resnetType 'Alias',
# see _resolve_alias_targets()) -- NOT a full pathway, just a name + a
# pointer (aliasTargetUrn) to the real one, resolved against every real
# pathway's own pathwayUrn (see extract_pathway() above) once the whole
# collection has been walked.
def _extract_alias_records(resnet):
    """Returns a list of {'name': str, 'aliasTargetUrn': str} for every
    Relationship="symlink" MemberOf control in this resnet, or [] if this
    isn't an alias manifest at all (the overwhelmingly common case -- most
    nameless resnets are just ordinary folder-structure bookkeeping, see
    extract_pathway()'s own docstring). Only called for resnets that already
    failed extract_pathway()'s name check, so there's no risk of a real named
    pathway being reinterpreted as an alias manifest even if it happens to
    ALSO have symlink-flagged controls somewhere (it wouldn't, in practice --
    real pathway content and alias manifests are always separate resnets/
    files in this collection -- but the ordering makes it impossible either way).
    """
    nodes_el = resnet.find('nodes')
    if nodes_el is None:
        return []
    node_info = {}   # local_id -> {'name': str, 'urn': str}
    for node in nodes_el.findall('node'):
        local_id = node.get('local_id')
        if not local_id:
            continue
        node_name = None
        for attr in node.findall('attr'):
            if attr.get('name') in ('Name', 'name'):
                node_name = attr.get('value')
                break
        node_info[local_id] = {
            'name': node_name,
            'urn': node.get('urn') or local_id,
        }

    controls_el = resnet.find('controls')
    if controls_el is None:
        return []

    aliases = []
    for ctrl in controls_el.findall('control'):
        is_symlink = False
        for attr in ctrl.findall('attr'):
            if attr.get('name') == 'Relationship' and attr.get('value', '').lower() == 'symlink':
                is_symlink = True
                break
        if not is_symlink:
            continue
        # The aliased pathway is the "in" endpoint (mirrors the real file:
        # <link type="in" ref="P0"/> pointing at the Pathway node,
        # <link type="out" ref="F0"/> pointing at the containing Folder).
        for link in ctrl.findall('link'):
            if link.get('type') != 'in':
                continue
            ref = link.get('ref')
            info = node_info.get(ref)
            if info and info['name'] and info['urn']:
                aliases.append({'name': info['name'], 'aliasTargetUrn': info['urn']})
    return aliases


_CLONE_SUFFIX_RE = re.compile(r'__clone__.*$')


def _base_urn(node_id):
    """Strip rnef_to_json.py's '__clone__<local_id>' suffix so a clone's own
    edges are attributed to the same base entity as its original for the
    relation-dedup key below -- mirrors how extract_pathway() already keys
    RNEF-sourced relations on stable urns, never a per-visual-instance id."""
    return _CLONE_SUFFIX_RE.sub('', node_id or '')


def extract_pathway_from_json_file(path):
    """A pathway saved back to disk as <name>.graph.json (currently only via
    the app's Pathway Annotation "Edit" save flow -- see server.js) is a
    self-contained JSON document already shaped like rnef_to_json.py's own
    output, not RNEF XML -- but still needs to appear in Browse/Search/
    Anatomy Index/Statistics exactly like any RNEF-sourced pathway. Returns
    a list (like extract_pathways_from_file()) so a malformed/nameless file
    can just yield [] rather than needing a separate None-vs-list contract.

    Relation/reference/sentence counts here are an APPROXIMATION relative to
    extract_pathway()'s RNEF-based dedup key: rnef_to_json.py's own hyperedge
    splitting (one N-participant relation becomes several 2-endpoint
    sub-edges to a synthetic hub node) means a hyperedge-heavy pathway's
    relation count here can be an over-count relative to its original RNEF
    form. This only affects the collection-wide Statistics counters (not
    Browse/Search/Anatomy Index, which use name/properties/anatomy/nodeUrns
    unaffected by this), and only for a pathway that has actually been
    edited and re-saved as JSON -- an acceptable trade-off for not having to
    shell back out to RNEF-specific parsing for a JSON-native file.
    """
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    name = data.get('name')
    if not name:
        return []

    properties = data.get('properties') or {}
    anatomy = {}
    for n, v in properties.items():
        if not v:
            continue
        category = _ANATOMY_FIELD_ALIASES.get(str(n).strip().lower())
        if category:
            term = _ANATOMY_TERM_SUFFIX_RE.sub('', str(v)).strip()
            if term:
                terms = anatomy.setdefault(category, [])
                if term not in terms:
                    terms.append(term)

    graph_data = data.get('graphData') or {}
    nodes = graph_data.get('nodes') or []
    node_urns, node_types, seen = [], {}, set()
    for node in nodes:
        # A clone shares its original's URN by design (see rnef_to_json.py)
        # -- counting it again here would double-count the same real-world
        # entity, the same reasoning extract_pathway()'s RNEF-side node loop
        # relies on implicitly (RNEF's own <nodes> list has no clones at all;
        # cloning only happens during rnef_to_json.py's own conversion).
        if node.get('isClone'):
            continue
        # A HyperEdge hub is a SYNTHETIC node rnef_to_json.py itself created
        # to represent a >2-participant relation (see its own comments) --
        # it has no counterpart in the raw RNEF's own <nodes> section at
        # all, so extract_pathway()'s RNEF-side loop never counts one as a
        # real entity. Counting it here too would silently inflate
        # totalUniqueEntities/nodeTypeCounts for any pathway that's ever
        # been saved as JSON and happens to contain a hyperedge (confirmed
        # directly: a real pathway's totalUniqueEntities count went from
        # 124 to 125 across an RNEF-vs-its-own-saved-JSON comparison, off
        # by exactly its one hyperedge hub, before this exclusion).
        if node.get('labels') == ['HyperEdge']:
            continue
        nprops = node.get('properties') or {}
        urn = nprops.get('URN') or node.get('id')
        if not urn or urn in seen:
            continue
        seen.add(urn)
        node_urns.append(urn)
        labels = node.get('labels') or []
        node_types[urn] = labels[0] if labels else nprops.get('NodeType', 'Unknown')

    edges = graph_data.get('edges') or []
    relation_dedup_keys, reference_ids = set(), set()
    sentence_count = 0
    for edge in edges:
        eprops = edge.get('properties') or {}
        ctype = edge.get('type', 'Regulation')
        effect = str(eprops.get('Effect', '')).lower()
        start = _base_urn(edge.get('startNodeId', ''))
        end = _base_urn(edge.get('endNodeId', ''))
        # rnef_to_json.py flattens RNEF's in/out/in-out roles down to a
        # plain start/end pair plus a `directed` flag -- reconstructed here
        # into the same 5-tuple shape extract_pathway() uses (in_refs,
        # inout_refs, out_refs, ControlType, Effect) so relation_type_counts'
        # `key[3]` lookup works identically regardless of which extractor a
        # given relation came from.
        if eprops.get('directed', True):
            in_refs, out_refs, inout_refs = [start], [end], []
        else:
            in_refs, out_refs, inout_refs = [], [], [start, end]
        relation_dedup_keys.add((
            tuple(sorted(in_refs)), tuple(sorted(inout_refs)), tuple(sorted(out_refs)),
            ctype, effect,
        ))
        for ref in (eprops.get('references') or []):
            doi, pmid = ref.get('doi', ''), ref.get('pmid', '')
            if doi:
                reference_ids.add('doi:' + doi)
            elif pmid:
                reference_ids.add('pmid:' + pmid)
            if ref.get('msrc'):
                sentence_count += 1

    return [{
        'name': name,
        'resnetType': data.get('resnetType') or 'Pathway',
        'pathwayUrn': data.get('urn'),   # present if rnef_to_json.py's output carried it forward
        'properties': properties,
        'anatomy': anatomy,
        'nodeUrns': node_urns,
        'nodeTypesLocal': node_types,
        'relationDedupKeysLocal': relation_dedup_keys,
        'referenceIdsLocal': reference_ids,
        'sentenceCountLocal': sentence_count,
    }]


def extract_alias_file(path):
    """Parses an app-created "<name>.alias.json" sidecar (see server.js's
    /api/pathways/save-alias-as) -- the app-authored equivalent of a curated
    "<FolderName>_symlinks.rnef" manifest, just one alias per file instead of
    a whole folder's worth batched together, and JSON instead of RNEF XML (far
    simpler to write correctly than mutating/appending to RNEF XML, and
    produces an index entry that looks IDENTICAL to a curated symlink once
    resolved -- see _resolve_alias_targets()). Returns a single alias dict
    (not yet resolved against a target sourceFile), or None if malformed.
    """
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    name = data.get('name')
    target_urn = data.get('aliasTargetUrn')
    if not name or not target_urn:
        return None
    return {'name': name, 'aliasTargetUrn': target_urn}


def extract_pathways_from_file(path):
    """Stream-parse one RNEF file, return list of pathway dicts (may be empty).
    Uses iterparse so a single huge file (100s of MB) never needs its full
    DOM held in memory at once -- only one <resnet> subtree at a time.

    A resnet that isn't a real named pathway (extract_pathway() returns None
    for it) might still be a Pathway Alias manifest -- _extract_alias_records()
    is tried on exactly those, and any aliases found are appended to the same
    output list, tagged '_isAlias': True so callers (_parse_one() below) can
    split them from real pathway entries before either goes through its own
    (very different) further processing."""
    out = []
    # Sample data confirms <resnet> elements are always direct, non-nested
    # children of <batch> (or the file's own root) -- no depth tracking
    # needed. Each is fully built by iterparse's 'end' event, processed, then
    # cleared immediately so memory never holds more than one resnet's DOM.
    for event, elem in ET.iterparse(path, events=('end',)):
        if elem.tag in ('thumbnail', 'schema'):
            # Never read by extract_pathway() -- a <thumbnail> in particular
            # is a base64-encoded preview image that can be enormous (one
            # observed file was ~200MB almost entirely because of a single
            # embedded thumbnail). Clear it the moment it's parsed rather
            # than waiting for its parent <resnet>/<batch> to finish, so
            # peak memory never includes that unused content at all.
            elem.clear()
        elif elem.tag == 'resnet':
            p = extract_pathway(elem)
            if p:
                out.append(p)
            else:
                for a in _extract_alias_records(elem):
                    a['_isAlias'] = True
                    out.append(a)
            elem.clear()
        elif elem.tag == 'batch':
            elem.clear()
    return out


def _collect_files(root_dir):
    """Fast directory walk (no parsing) -- returns [(fpath, subfolder), ...]."""
    files = []
    visited_realdirs = set()
    for dirpath, dirnames, filenames in os.walk(root_dir, followlinks=True):
        real = os.path.realpath(dirpath)
        if real in visited_realdirs:
            dirnames[:] = []
            continue
        visited_realdirs.add(real)

        # os.path.relpath() returns OS-native separators (backslashes on
        # Windows) -- normalized to forward slashes here so consumers (the
        # frontend's folder-tree browser in particular, which splits this
        # value on '/') get a consistent representation regardless of what
        # OS actually did the indexing.
        subfolder = os.path.relpath(dirpath, root_dir).replace(os.sep, '/')
        if subfolder == '.':
            subfolder = ''

        for fname in filenames:
            lower = fname.lower()
            # .graph.json -- a pathway saved back to disk after editing its
            # annotation in the app (see server.js's pathway-annotation save
            # endpoint) -- is indexed alongside .rnef/.xml so Browse/Search/
            # Anatomy Index/Statistics see edited pathways too. Matched on
            # this exact compound suffix (not a bare ".json") so an unrelated
            # JSON file someone happens to drop in the collection isn't
            # mistaken for a pathway.
            # .alias.json -- an app-created Pathway Alias (see server.js's
            # /api/pathways/save-alias-as and extract_alias_file() above) --
            # matched on this exact compound suffix for the same reason
            # .graph.json is: so a bare, unrelated ".json" file dropped in the
            # collection is never mistaken for one.
            if lower.endswith('.rnef') or lower.endswith('.xml') or lower.endswith('.graph.json') or lower.endswith('.alias.json'):
                files.append((os.path.join(dirpath, fname), subfolder))
    return files


def _parse_one(args):
    """Worker function for the process pool: parse a single file, return
    (fpath, subfolder, pathways, error_or_None). Kept as a module-level
    function (not a closure/lambda) since multiprocessing must be able to
    pickle it for worker processes on platforms using 'spawn'."""
    fpath, subfolder = args
    try:
        lower = fpath.lower()
        if lower.endswith('.alias.json'):
            a = extract_alias_file(fpath)
            found = []
            if a:
                a['_isAlias'] = True
                found = [a]
        elif lower.endswith('.graph.json'):
            found = extract_pathway_from_json_file(fpath)
        else:
            found = extract_pathways_from_file(fpath)
        return (fpath, subfolder, found, None)
    except (ET.ParseError, OSError, ValueError) as e:
        # ValueError also covers json.JSONDecodeError, a subclass of it.
        return (fpath, subfolder, [], str(e))


def _safe_mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0


def _dedupe_pathways(pathways):
    """Two files can describe the SAME pathway identity -- most commonly an
    original curated <name>.rnef alongside a <name>.graph.json produced by
    editing that pathway's annotation in the app (see server.js's pathway
    annotation-save endpoint, and extract_pathway_from_json_file() above).
    Showing both in Browse/Search/Anatomy Index would be confusing, and
    letting both contribute to the global Statistics counters would double-
    count that pathway's own nodes/relations -- so only the file with the
    latest mtime survives per identity, the same way saving a .graph.json
    edit is meant to supersede the .rnef it was edited from.

    Grouped by the PATHWAY's own name (sanitized via safe_filename(), same
    as rnef_to_json.py/the annotation-save endpoint use to NAME a saved
    .graph.json), not by the source FILE's own name -- a single RNEF file is
    often a <batch> of several distinctly-named pathways, and each one can
    independently pick up its own edited .graph.json later, so the source
    file's name alone isn't a reliable identity key. Two pathways with the
    same name in DIFFERENT subfolders are still distinct identities.
    """
    groups = {}
    order = []  # preserve first-seen order of each group for stable output
    for p in pathways:
        key = (p.get('subfolder', ''), safe_filename(p.get('name', '')))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(p)
    result = []
    for key in order:
        group = groups[key]
        best = group[0] if len(group) == 1 else max(group, key=lambda p: _safe_mtime(p['sourceFile']))
        result.append(best)
    return result


def walk_directory(root_dir, workers=None, report_progress=False):
    """Parses every .rnef/.xml file under root_dir. XML parsing is CPU-bound
    and files are fully independent, so this uses a process pool (one worker
    per CPU core by default) to parse multiple files concurrently -- with
    500+ files, some hundreds of MB each, single-threaded parsing alone can
    take well over ten minutes.

    Also computes several GLOBAL statistics (REQ-3.72/3.73/3.24). Worker
    processes each only see their own file(s), so all of this merging
    happens here, in the single main process, as results stream back via
    imap_unordered:
      - node_type_counts: a `seen_urns` set tracks every distinct node URN
        across the WHOLE collection, and a NodeType is only tallied the
        first time its URN is seen -- a node that legitimately appears in
        many different pathways (a common protein like TP53, say) is still
        counted exactly once overall, never once per pathway.
      - seen_relation_keys: pathways commonly contain redundant/identical
        relations (the same curated fact copy-pasted into more than one
        pathway document), so relation counts are deduplicated too, via a
        (sorted endpoint URNs by role, ControlType, Effect) key -- see
        extract_pathway() for why this mirrors, but can't exactly reproduce,
        calcRelationId()'s real Neo4j RelationID hash. relation_type_counts
        is derived from this set at the very end, by grouping the already-
        deduplicated keys by their ControlType component.
      - seen_reference_ids: same dedup approach as seen_urns, but for
        DOI-else-PMID reference identifiers (REQ-3.73 explicitly requires
        unique identifiers here, since the same paper can support relations
        in many different pathways).
      - total_sentences: a running sum of how many (relation, reference)
        pairs have a non-empty supporting Sentence.
    Doing all of this incrementally as pathways stream in would keep memory
    down to just the sets/counters themselves, but can't be done until AFTER
    duplicate pathways have been resolved (see _dedupe_pathways() below) --
    a stale duplicate's nodes/relations must never reach these global
    accumulators at all, not be merged in and then somehow subtracted back
    out. So raw pathway dicts (Local fields still attached) are collected
    for every file first, deduped once as a whole, and only THEN merged into
    the accumulators below -- still bounded well below full-file-size
    memory (proportional to the number of distinct nodes/relations/
    references in the collection, not file sizes), just not quite as tight
    as the previous fully-streaming merge.

    report_progress=True prints one JSON-lines progress event per completed
    file to stdout (see module docstring for the exact shape) -- must only
    be enabled when the final result is going to a file, not stdout (see
    main()), since mixing progress lines with the final single-blob JSON
    result would make stdout unparseable."""
    file_list = _collect_files(root_dir)
    all_pathways, all_aliases, errors = [], [], []
    files_total = len(file_list)

    stats = {
        'nodeTypeCounts': {}, 'relationTypeCounts': {},
        'totalUniqueEntities': 0, 'totalUniqueReferences': 0,
        'totalSupportingSentences': 0,
    }

    if report_progress:
        _emit_progress({'type': 'start', 'filesTotal': files_total})

    if not file_list:
        return all_pathways, 0, errors, stats

    nworkers = workers or min(mp.cpu_count(), len(file_list))
    files_done = 0
    with mp.Pool(processes=nworkers) as pool:
        for fpath, subfolder, found, err in pool.imap_unordered(_parse_one, file_list):
            files_done += 1
            if err is not None:
                errors.append({'file': fpath, 'error': err})
            else:
                for p in found:
                    p['sourceFile'] = fpath
                    p['subfolder'] = subfolder
                    if p.pop('_isAlias', False):
                        all_aliases.append(p)
                    else:
                        all_pathways.append(p)
            if not report_progress:
                continue
            _emit_progress({
                'type': 'progress',
                'filesProcessed': files_done,
                'filesRemaining': files_total - files_done,
                'filesTotal': files_total,
                'currentFile': os.path.basename(fpath),
                'currentSubfolder': subfolder,
                'pathwayNamesInFile': [] if err is not None else [p['name'] for p in found],
                'pathwaysIndexedSoFar': len(all_pathways),
            })

    # Same pathway identity described by more than one file on disk (an
    # original curated <name>.rnef alongside a <name>.graph.json produced by
    # editing that pathway's annotation -- see server.js) collapses to just
    # the most-recently-modified file's copy BEFORE anything below reads
    # nodeTypesLocal/relationDedupKeysLocal/etc, so a stale duplicate never
    # contributes its nodes/relations to the global counts even transiently.
    pathways = _dedupe_pathways(all_pathways)

    seen_urns = set()
    node_type_counts = Counter()
    seen_relation_keys = set()  # deduplicated (endpoints, ControlType, Effect) tuples, whole collection
    seen_reference_ids = set()
    total_sentences = 0
    for p in pathways:
        for urn, ntype in p.pop('nodeTypesLocal').items():
            if urn not in seen_urns:
                seen_urns.add(urn)
                node_type_counts[ntype] += 1
        seen_relation_keys.update(p.pop('relationDedupKeysLocal'))
        seen_reference_ids.update(p.pop('referenceIdsLocal'))
        total_sentences += p.pop('sentenceCountLocal')

    # Each key in seen_relation_keys is already deduplicated (it's a set), so
    # grouping by its ControlType component (index 3) gives the count of
    # DISTINCT relations per type across the whole collection -- redundant/
    # identical relations copy-pasted into multiple pathways collapse to one.
    relation_type_counts = Counter(key[3] for key in seen_relation_keys)

    stats = {
        'nodeTypeCounts': dict(node_type_counts),
        'relationTypeCounts': dict(relation_type_counts),
        # Background population size (REQ-3.24) for Entity Search's Fisher
        # exact test, computed for free alongside nodeTypeCounts.
        'totalUniqueEntities': len(seen_urns),
        'totalUniqueReferences': len(seen_reference_ids),
        'totalSupportingSentences': total_sentences,
    }

    # Resolve every Pathway Alias's aliasTargetUrn against every REAL
    # pathway's own pathwayUrn (deliberately done AFTER dedup above, using
    # the already-deduplicated `pathways` list -- an alias should point at
    # whichever copy survived dedup, not a stale duplicate that lost out to
    # a newer .graph.json edit). Left as None/None/None when the referenced
    # pathway isn't present in this particular collection at all (the
    # curated source system this data was exported from may have it under a
    # folder that was never included here, or it may simply not exist yet)
    # -- Browse/the frontend are expected to show that plainly rather than
    # silently omitting the alias or crashing on a missing target.
    urn_to_pathway = {p['pathwayUrn']: p for p in pathways if p.get('pathwayUrn')}
    for a in all_aliases:
        a['resnetType'] = 'Alias'
        a['isAlias'] = True
        a.setdefault('properties', {})
        a.setdefault('anatomy', {})
        a.setdefault('nodeUrns', [])
        target = urn_to_pathway.get(a.get('aliasTargetUrn'))
        if target:
            a['aliasTargetSourceFile'] = target['sourceFile']
            a['aliasTargetSubfolder'] = target['subfolder']
            a['aliasTargetName'] = target['name']
        else:
            a['aliasTargetSourceFile'] = None
            a['aliasTargetSubfolder'] = None
            a['aliasTargetName'] = None

    pathways = pathways + all_aliases
    return pathways, len(file_list), errors, stats


def main(root_dir, out_path=None):
    """If out_path is given, the result JSON is written directly to that file
    (streamed by json.dump, never held as one giant Python string, and never
    passed back through a parent process's stdout pipe). This avoids Node's
    execFile(): it buffers a child process's stdout as a list of chunks and
    joins them into a single JS string once the process exits, which can
    throw "RangeError: Invalid string length" (V8's own max-string-length
    limit) for a real, large pathway collection — independent of and often
    smaller than any maxBuffer setting on the Node side. Printing to stdout
    is kept as a fallback for direct CLI use without an output path."""
    empty_stats = {
        'nodeTypeCounts': {}, 'relationTypeCounts': {},
        'totalUniqueEntities': 0, 'totalUniqueReferences': 0,
        'totalSupportingSentences': 0,
    }
    if not os.path.isdir(root_dir):
        sys.stderr.write('rnef_index: not a directory: {}\n'.format(root_dir))
        result = dict(pathways=[], filesScanned=0, filesFailed=0,
                       errors=[{'file': root_dir, 'error': 'not a directory'}],
                       **empty_stats)
        if out_path:
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False)
        else:
            print(json.dumps(result, ensure_ascii=False))
        sys.exit(1)

    pathways, files_scanned, errors, stats = walk_directory(root_dir, report_progress=bool(out_path))
    result = dict(
        pathways=pathways,
        filesScanned=files_scanned,
        filesFailed=len(errors),
        errors=errors,
        **stats,  # nodeTypeCounts, relationTypeCounts, totalUniqueEntities,
                  # totalUniqueReferences, totalSupportingSentences
    )
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)
        sys.stderr.write('rnef_index: wrote {} pathways to {}\n'.format(len(pathways), out_path))
    else:
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    # On Windows, stdout/stderr default to the system console codepage (e.g.
    # cp1252) rather than UTF-8 — real pathway data can contain characters
    # outside that codepage (a zero-width space and other copy/paste
    # artifacts have both been observed in real curated pathway text), which
    # raises UnicodeEncodeError the moment such a character is printed.
    # Reconfiguring both streams to UTF-8 up front (Python 3.7+) makes this
    # script's output encoding match what it actually is (ensure_ascii=False
    # UTF-8 JSON) regardless of the host console's codepage, and matches what
    # Node's execFile() expects to decode on the other end.
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding='utf-8')
        except AttributeError:
            pass  # Python < 3.7 — unlikely, but don't hard-fail over it

    if len(sys.argv) < 2:
        sys.stderr.write('Usage: python rnef_index.py <root_directory> [output_file.json]\n')
        sys.exit(1)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
