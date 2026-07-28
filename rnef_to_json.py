import xml.etree.ElementTree as ET
import json, sys, os, re
from datetime import datetime, timezone

# Matching a <control>'s own saved diagram position -- see convert_resnet()'s
# "Match each control to its own saved diagram position" comment below for
# the full story on why this can't just be an exact string comparison
# between a control's local_id and a vobj's ref. Both ElementTree .get()
# calls return plain str (never bytes), even when parsing from a bytes
# source, so these operate on str.
_VOBJ_URN_AFTER_ROLE_RE = re.compile(r'(?:in-out|in|out):(urn:[^:]+:[^:]+)')
_VOBJ_CONTROL_TYPE_RE = re.compile(r'^urn:[^-]+-([A-Za-z]+)')

# RNEF "Shape" values (from <style><attr name="Shape" ...>) whose look is
# distinctly different from any of this app's own NodeType-based default
# shapes -- collection-wide, every .rnef file uses one of exactly 15 Shape
# values (Rectangle, Circle, Hexagon, Ellipse, Sickle-vertex, Stick-vertex,
# O-vertex, Rhomb, Ellipses, 2Triangles, Star-vertex, Image, III-vertex, Wave,
# BarrelUp). Rectangle/Circle/Ellipse(s)/Hexagon already resemble one of this
# app's own default per-NodeType shapes closely enough that preserving them
# would just repaint the graph without adding real information, so only this
# set gets its custom color captured too (rnefShape itself is still captured
# for ANY non-ellipse shape below, unchanged) -- see the matching Cytoscape
# selectors in public/app.js's getCyStyle() for how each one is rendered.
EXOTIC_SHAPES = {
    'sickle-vertex', 'stick-vertex', 'o-vertex', 'rhomb', '2triangles',
    'star-vertex', 'image', 'iii-vertex', 'wave', 'barrelup'
}

_RNEF_HEX_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{8}$')

def _rnef_hex_color(value):
    """RNEF stores colors as an 8-hex-digit string, e.g. '#00FFFEFC' -- the
    FIRST 6 digits are a normal #RRGGBB and the TRAILING byte is the one
    that's discarded (an alpha/reserved byte this app has no use for), NOT
    the leading byte as originally assumed. Confirmed against real style
    data: style S31's FillColor "#00FFFEFC" renders in Pathway Studio as
    RGB(0,255,254) -- i.e. R=0x00, G=0xFF, B=0xFE, discarding the trailing
    0xFC -- not RGB(255,254,252), which is what reading the LAST 6 digits
    would give. (The earlier leading-byte assumption looked right for style
    S75 purely by coincidence: S75's FillColor "#00FDFDFD" has three equal
    trailing digit-pairs, so which 6-digit window you read barely changes
    the resulting shade -- it wasn't actually a confirming data point.)
    Returns None for anything that doesn't match this exact shape rather
    than guessing at yet another byte order."""
    if not value or not _RNEF_HEX_COLOR_RE.match(value):
        return None
    return value[:7]   # '#' + first 6 hex digits; the trailing byte is dropped

def safe_filename(name):
    s = re.sub(r'[\\/:*?"<>|]', '_', name)
    return s.strip() or 'unnamed'

def convert_resnet(resnet, out_dir):
    # Real exported files aren't consistent about attribute capitalization --
    # most use lowercase "name", but a real share use "Name" instead (see the
    # same fix in rnef_index.py's extract_pathway() for the full story).
    resnet_name = resnet.get('name') or resnet.get('Name') or 'unnamed'
    # The pathway's own identifying URN (e.g. "urn:agi-pathway:uuid-...") --
    # an attribute of the <resnet> element itself, same field rnef_index.py's
    # extract_pathway() now also captures as pathwayUrn. Carried into this
    # file's own output (and from there into a saved .graph.json, and read
    # back by rnef_index.py's extract_pathway_from_json_file()) so a
    # currently-open pathway can be "Saved As" a Pathway Alias elsewhere in
    # the collection -- the alias needs something stable to point back at.
    resnet_urn = resnet.get('urn') or resnet.get('URN')

    # -- Properties (Description, Notes, or anything else present) -----------
    # Captured generically (same approach as rnef_index.py's extract_pathway())
    # so "View Annotation" in the app can show whatever this pathway actually
    # has, rather than a hardcoded field list.
    properties = {}
    properties_el = resnet.find('properties')
    if properties_el is not None:
        for attr in properties_el.findall('attr'):
            n, v = attr.get('name'), attr.get('value', '')
            if n:
                properties[n] = v

    # -- Nodes ----------------------------------------------------------------
    nodes_map = {}
    nodes_el = resnet.find('nodes')
    if nodes_el is not None:
        for node in nodes_el.findall('node'):
            # nid stays the node's local_id (never its urn) because every
            # <control><link ref="..."> below refers to a node by local_id,
            # not urn -- rnef_index.py's extract_pathway() documents this
            # same fact for its own local_id_to_urn resolution. nodes_map
            # MUST stay keyed on the same identifier space controls link
            # against, or every edge would fail to resolve to its endpoints.
            nid = node.get('local_id')
            props = {}
            for attr in node.findall('attr'):
                props[attr.get('name')] = attr.get('value')
            node_type = props.get('NodeType', 'Unknown')
            # The real, globally-stable identifier is the node's own `urn`
            # attribute -- previously this unconditionally overwrote it with
            # local_id instead, which happened to be harmless for files where
            # a node's local_id IS already formatted as its urn (e.g.
            # local_id="urn:agi-llid:207" urn="urn:agi-llid:207", common
            # across this collection), but silently imported the wrong value
            # for any file using short, file-local ids (e.g.
            # local_id="N1" urn="urn:agi-ncimorgan:C0229167", confirmed in
            # "Lacrimal gland anatomical concepts.rnef" and ~11% of nodes
            # sampled across the wider collection) -- breaking Neo4j
            # enrichment, Entity Search, and ontology matching for every one
            # of those nodes, since all of that keys strictly on the URN
            # property, never on this internal local_id/id field.
            if nid:
                props['URN'] = node.get('urn') or nid
            if nid and nid not in nodes_map:
                nodes_map[nid] = {
                    'id': nid,
                    'elementId': nid,
                    'labels': [node_type],
                    'properties': props
                }

    # -- Controls (edges) -----------------------------------------------------
    # Nodes are fully loaded above (this whole <resnet> is already parsed
    # into memory by the time we get here regardless -- ET.fromstring()/
    # iterparse()'s 'end' event both guarantee that -- but this map makes the
    # ordering an explicit, deliberate DEPENDENCY rather than an incidental
    # side effect of how the XML happens to be parsed) so every <link
    # ref="..."> below -- always a node's local_id, never its urn -- can be
    # resolved to that node's real, stable urn wherever one is actually
    # needed (see participant_urns just below for exactly why).
    local_id_to_urn = {lid: info['properties'].get('URN', lid) for lid, info in nodes_map.items()}

    edges_map = {}
    # (eid, ControlType, frozenset(participant URNs)) per control, in
    # document order -- used after the layout section is parsed to match
    # each control to its own saved diagram position (see the "Match each
    # control..." step further down for why this key, not an exact string
    # comparison, is what actually works against real RNEF exports). Built
    # from local_id_to_urn-RESOLVED urns, not the raw local_id <link ref>
    # values -- the vobj side of this same match key (vobj_urns, built by
    # _VOBJ_URN_AFTER_ROLE_RE below) is always extracted from REAL urn:...
    # strings encoded in the vobj's own ref, so comparing it against raw
    # local_ids would silently never match for any file where a node's
    # local_id differs from its urn (confirmed to occur for ~11% of nodes
    # sampled across this collection -- see the URN-property fix above for
    # the same underlying local_id/urn mixup, just surfacing here instead as
    # a possible saved-position miss rather than a wrong URN value).
    control_position_keys = []
    controls_el = resnet.find('controls')
    if controls_el is not None:
        for ctrl in controls_el.findall('control'):
            eid = ctrl.get('local_id')
            if eid in edges_map:
                continue

            in_refs, out_refs, inout_refs = [], [], []
            for link in ctrl.findall('link'):
                lt  = link.get('type', '')
                ref = link.get('ref')
                if lt == 'in':       in_refs.append(ref)
                elif lt == 'out':    out_refs.append(ref)
                elif lt == 'in-out': inout_refs.append(ref)

            control_type = 'Regulation'
            effect = ''
            refs_by_idx = {}
            for attr in ctrl.findall('attr'):
                name  = attr.get('name', '')
                value = attr.get('value', '')
                index = attr.get('index')
                if name == 'ControlType':
                    control_type = value
                elif name == 'Effect':
                    effect = value
                elif index is not None:
                    refs_by_idx.setdefault(int(index), {})[name] = value

            if eid:
                participant_urns = frozenset(
                    local_id_to_urn.get(r, r) for r in (in_refs + out_refs + inout_refs) if r
                )
                control_position_keys.append((eid, control_type, participant_urns))

            if not effect and eid:
                m = re.search(r':(positive|negative|unknown):', eid, re.IGNORECASE)
                if m:
                    effect = m.group(1).capitalize()

            references = []
            for idx in sorted(refs_by_idx):
                r = refs_by_idx[idx]
                references.append({
                    'pmid':    r.get('PMID', ''),
                    'doi':     r.get('DOI', ''),
                    'title':   r.get('Title', ''),
                    'pubyear': r.get('PubYear', ''),
                    'authors': r.get('Authors', ''),
                    'journal': r.get('Journal', ''),
                    'msrc':    r.get('Sentence', ''),
                    'celltype': r.get('CellType', ''),
                    'celllinename': r.get('CellLineName', ''),
                    'tissue': r.get('Tissue', ''),
                    'organ': r.get('Organ', '')
                })

            # Hyperedge = a control connecting MORE THAN TWO nodes -- Cytoscape
            # (like Neo4j) only has plain binary edges, so a hyperedge needs a
            # synthetic hub NODE in the middle, with one real edge from each
            # participant to that hub, to render at all. Detected structurally
            # (total participant count > 2) rather than by a hardcoded
            # ControlType name, so it correctly handles a hyperedge of ANY
            # relation type -- not just ChemicalReaction (the only type that
            # happens to ever exceed 2 participants in samples seen so far,
            # but nothing here is specific to it).
            total_participants = len(in_refs) + len(inout_refs) + len(out_refs)
            if total_participants > 2:
                # The hub node's NodeType is always exactly "HyperEdge" (so the
                # app can recognize and style it uniformly regardless of which
                # relation type it represents), and its Name is the control's
                # own ControlType (e.g. "ChemicalReaction") -- giving it a
                # human-readable label without hardcoding that specific value.
                # in/in-out participants  -> hub  (substrate/input side)
                # hub -> out participants        (product/output side)
                # Every edge to/from the hub carries ControlType as its own
                # relation type too, so all of them (both sides) render and
                # query as the SAME relation type as the original control.
                nodes_map[eid] = {
                    'id': eid,
                    'elementId': eid,
                    'labels': ['HyperEdge'],
                    'properties': {
                        'NodeType': 'HyperEdge',
                        'Name': control_type,
                        'URN': eid
                    }
                }
                ec = 0
                for ref in in_refs + inout_refs:
                    if not ref:
                        continue
                    sub_eid = eid + '__s' + str(ec)
                    edges_map[sub_eid] = {
                        'id': sub_eid, 'elementId': sub_eid,
                        'type': control_type,
                        'startNodeId': ref, 'endNodeId': eid,
                        'properties': {
                            'URN': eid, 'Effect': '',
                            'NumRefs': len(references),
                            'references': references,
                            'directed': True
                        }
                    }
                    ec += 1
                for ref in out_refs:
                    if not ref:
                        continue
                    prod_eid = eid + '__p' + str(ec)
                    edges_map[prod_eid] = {
                        'id': prod_eid, 'elementId': prod_eid,
                        'type': control_type,
                        'startNodeId': eid, 'endNodeId': ref,
                        'properties': {
                            'URN': eid, 'Effect': '',
                            'NumRefs': len(references),
                            'references': references,
                            'directed': True
                        }
                    }
                    ec += 1

            else:
                # All other control types: single directed/undirected edge.
                directed = True
                if in_refs and out_refs:
                    start, end = in_refs[0], out_refs[0]
                elif len(inout_refs) >= 2:
                    start, end = inout_refs[0], inout_refs[1]
                    directed = False   # in-out means no direction / no arrowhead
                elif in_refs and inout_refs:
                    start, end = in_refs[0], inout_refs[0]
                elif out_refs and inout_refs:
                    start, end = inout_refs[0], out_refs[0]
                else:
                    continue
                edges_map[eid] = {
                    'id': eid, 'elementId': eid, 'type': control_type,
                    'startNodeId': start, 'endNodeId': end,
                    'properties': {
                        'URN': eid, 'Effect': effect,
                        'NumRefs': len(references), 'references': references,
                        'directed': directed
                    }
                }

    # -- Layout / positions ---------------------------------------------------
    # A node ref appearing >1 time in the vobj list is a "clone":
    # the same database entity shown at multiple canvas positions.
    vobj_nodes   = []   # [(ref, local_id, x, y), ...]
    ctrl_pos_map = {}   # eid -> (x, y), populated by the matching step below
    # Every <vobj type="Control"> found, kept as (ControlType, participant
    # URN set, position) rather than written straight into ctrl_pos_map by
    # its own `ref` string -- see the matching step below for why.
    vobj_control_positions = []

    attachments_el = resnet.find('attachments')
    if attachments_el is not None:
        layout_el = attachments_el.find('layout')
        if layout_el is not None:
            # -- Build style map (Shape only — colors are ignored) -----------------
            styles_map = {}   # style_id -> {attr_name: attr_value, ...}
            styles_el = layout_el.find('styles')
            if styles_el is not None:
                for style in styles_el.findall('style'):
                    sid = style.get('local_id', '')
                    styles_map[sid] = {
                        a.get('name'): a.get('value')
                        for a in style.findall('attr')
                    }

            scene_el = layout_el.find('scene')
            if scene_el is not None:
                vobjs_el = scene_el.find('vobjs')
                if vobjs_el is not None:
                    for vobj in vobjs_el.findall('vobj'):
                        vtype  = vobj.get('type')
                        ref    = vobj.get('ref')
                        lid    = vobj.get('local_id', '')
                        sref   = vobj.get('style_ref', '')
                        style  = styles_map.get(sref, {})
                        if not ref:
                            continue
                        node_size = None
                        for attr in vobj.findall('attr'):
                            if attr.get('name') == 'Position':
                                parts = attr.get('value', '').split()
                                if len(parts) == 2:
                                    try:
                                        x =  float(parts[0]) * 80
                                        y = -float(parts[1]) * 80
                                        if vtype == 'Node':
                                            vobj_nodes.append((ref, lid, x, y))
                                        elif vtype == 'Control':
                                            vobj_ctype_m = _VOBJ_CONTROL_TYPE_RE.match(ref)
                                            vobj_ctype = vobj_ctype_m.group(1) if vobj_ctype_m else None
                                            vobj_urns = frozenset(_VOBJ_URN_AFTER_ROLE_RE.findall(ref))
                                            vobj_control_positions.append((vobj_ctype, vobj_urns, (x, y)))
                                    except ValueError:
                                        pass
                            elif attr.get('name') == 'Size':
                                # Same unit -> pixel conversion factor as
                                # Position above, so a node's rendered size
                                # stays proportional to the canvas distances
                                # between nodes exactly as drawn in the
                                # original diagram (e.g. a node curated as a
                                # long, flat rectangle -- width far exceeding
                                # height, such as an anatomical structure
                                # label -- renders that way here too, rather
                                # than every node defaulting to its NodeType's
                                # standard size regardless of how it was
                                # actually drawn).
                                parts = attr.get('value', '').split()
                                if len(parts) == 2:
                                    try:
                                        node_size = (float(parts[0]) * 80, float(parts[1]) * 80)
                                    except ValueError:
                                        pass
                        # -- Preserve shape, custom size, and (for distinctly ---
                        # -- different shapes only) custom color -----------------
                        if vtype == 'Node' and ref in nodes_map:
                            shape = style.get('Shape', '').lower()
                            if shape and shape != 'ellipse':
                                nodes_map[ref]['properties']['rnefShape'] = shape
                                # Ordinary shapes (Rectangle, Circle, Ellipses,
                                # Hexagon) already resemble one of this app's own
                                # NodeType default shapes closely enough that
                                # their own color would just repaint the graph
                                # without adding real information -- only the
                                # genuinely unusual "vertex glyph" shapes get
                                # their curated color preserved, to make them
                                # stand out the same way they did in the
                                # original diagram.
                                if shape in EXOTIC_SHAPES:
                                    fill   = _rnef_hex_color(style.get('FillColor'))
                                    border = _rnef_hex_color(style.get('BorderColor'))
                                    if fill:   nodes_map[ref]['properties']['rnefFillColor']   = fill
                                    if border: nodes_map[ref]['properties']['rnefBorderColor'] = border
                                    # FillMode ("Flat"/"Gradient"/"V-Gradient") changes
                                    # how FillColor/BorderColor combine visually in
                                    # Pathway Studio -- a gradient mode blends from
                                    # FillColor at the center out to BorderColor at
                                    # the edge, which for e.g. a near-white fill and
                                    # near-black border reads as "black with a white
                                    # center" rather than a flat white fill with a
                                    # thin black outline. Rendered in app.js.
                                    fill_mode = style.get('FillMode', '').lower()
                                    if fill_mode:
                                        nodes_map[ref]['properties']['rnefFillMode'] = fill_mode
                            if node_size:
                                nodes_map[ref]['properties']['nodeWidth']  = round(node_size[0], 1)
                                nodes_map[ref]['properties']['nodeHeight'] = round(node_size[1], 1)

    # Match each control to its own saved diagram position. This can't be a
    # plain exact-string comparison between a <control>'s local_id and the
    # <vobj type="Control" ref="..."> that's supposed to point back at it --
    # real RNEF exports have been found to be inconsistent between the two:
    # local_id always uses "::" between the ControlType and the first link
    # role, while the vobj's ref commonly uses a single ":" there instead,
    # AND often has an extra trailing ":<effect>[:<mechanism>]" that never
    # appears in local_id at all. Even the per-endpoint role markers
    # ("in"/"out"/"in-out") embedded in these strings aren't fully
    # trustworthy -- one observed vobj ref said "in-out" for an endpoint
    # whose actual <link type="..."> was really just "in". An exact-string
    # lookup against this data silently found a saved position for only a
    # small minority of controls in a real file (11 of 41 in one observed
    # pathway); every other control's clone resolution then had nothing to
    # anchor on at all.
    #
    # Matching on (ControlType, frozenset of participant URNs) instead --
    # ignoring both the exact punctuation and the not-fully-reliable role
    # markers -- correctly identified a saved position for every control in
    # that same file. The only remaining ambiguity is two genuinely
    # distinct relations of the same type connecting the exact same
    # participants (e.g. two different MolTransport relations between the
    # same two entities) sharing one key; candidate positions for a key are
    # consumed in document order so each real saved position still gets
    # assigned to exactly one control rather than reused for all of them.
    vobj_positions_by_key = {}
    for vobj_ctype, vobj_urns, pos in vobj_control_positions:
        vobj_positions_by_key.setdefault((vobj_ctype, vobj_urns), []).append(pos)
    for eid, control_type, participant_urns in control_position_keys:
        candidates = vobj_positions_by_key.get((control_type, participant_urns))
        if candidates:
            ctrl_pos_map[eid] = candidates.pop(0)

    positions  = {}
    clone_map  = {}   # original_ref -> [clone_id, ...]
    ref_seen   = set()

    for ref, lid, x, y in vobj_nodes:
        if ref not in ref_seen:
            positions[ref] = {'x': x, 'y': y}
            clone_map[ref] = []
            ref_seen.add(ref)
        else:
            safe_lid = re.sub(r'[^A-Za-z0-9._-]', '_', lid)
            clone_id = ref + '__clone__' + safe_lid
            if ref in nodes_map:
                orig = nodes_map[ref]
                nodes_map[clone_id] = {
                    'id': clone_id, 'elementId': clone_id,
                    'labels': orig['labels'][:],
                    'isClone': True, 'cloneOf': ref,
                    'properties': dict(orig['properties'])
                }
            positions[clone_id] = {'x': x, 'y': y}
            clone_map.setdefault(ref, []).append(clone_id)

    # Add positions for HyperEdge hub nodes (synthetic centres for any
    # relation type with more than 2 participants, not just ChemicalReaction)
    for ctrl_ref, (x, y) in ctrl_pos_map.items():
        if ctrl_ref in nodes_map and nodes_map[ctrl_ref].get('labels') == ['HyperEdge']:
            if ctrl_ref not in positions:
                positions[ctrl_ref] = {'x': x, 'y': y}

    # Fallback for a HyperEdge hub whose own <vobj type="Control"> entry is
    # missing from the RNEF layout entirely (seen in real data -- a reaction
    # that was added/edited without ever saving a diagram position for it).
    # Without SOME position here, two things go wrong: the hub renders
    # wherever Cytoscape/app.js's own unpositioned-node fallback happens to
    # dump it, visually disconnected from its actual reactants/products; and
    # -- more importantly -- the clone-resolution loop just below has no
    # anchor position to judge which VISUAL COPY of a cloned participant
    # (e.g. the same small molecule drawn more than once in this diagram)
    # each of the hub's own edges should connect to.
    #
    # Approximating the hub's position as a simple centroid of every
    # participant's ORIGINAL (non-clone) position is biased whenever some
    # participants are cloned: those originals might sit in a completely
    # different part of the diagram from where this specific reaction was
    # actually drawn (e.g. near a clone cluster instead), pulling the
    # estimate toward the wrong neighbourhood and making the clone
    # resolution below pick the original anyway -- exactly the failure mode
    # this fallback exists to avoid. Seeding the centroid from only the
    # UNAMBIGUOUS participants (the ones with no clone at all, so their
    # position can't be "the wrong instance") avoids that bias whenever any
    # exist; only once every participant is itself cloned does this fall
    # back to using original positions for all of them. Each ambiguous
    # participant is then resolved to whichever of its own instances sits
    # closest to that seed, and the centroid is recomputed from those
    # resolved positions so it reflects where this reaction was actually
    # likely drawn, not just where the bare originals happen to be.
    for hub_id, hub_node in nodes_map.items():
        if hub_node.get('labels') != ['HyperEdge'] or hub_id in ctrl_pos_map:
            continue
        participant_refs = set()
        for edge in edges_map.values():
            if edge['startNodeId'] == hub_id:
                participant_refs.add(edge['endNodeId'])
            elif edge['endNodeId'] == hub_id:
                participant_refs.add(edge['startNodeId'])
        if not participant_refs:
            continue

        def _centroid(refs):
            pts = [positions[r] for r in refs if r in positions]
            if not pts:
                return None
            return (sum(p['x'] for p in pts) / len(pts), sum(p['y'] for p in pts) / len(pts))

        unambiguous = [r for r in participant_refs if not clone_map.get(r)]
        seed = _centroid(unambiguous) or _centroid(participant_refs)
        if seed is None:
            continue
        scx, scy = seed

        chosen_positions = []
        for ref in participant_refs:
            candidates = [(ref, positions.get(ref))]
            for cid in clone_map.get(ref, []):
                candidates.append((cid, positions.get(cid)))
            candidates = [(nid, p) for nid, p in candidates if p]
            if not candidates:
                continue
            best = min(candidates, key=lambda c: (c[1]['x']-scx)**2 + (c[1]['y']-scy)**2)
            chosen_positions.append(best[1])

        if chosen_positions:
            cx = sum(p['x'] for p in chosen_positions) / len(chosen_positions)
            cy = sum(p['y'] for p in chosen_positions) / len(chosen_positions)
            ctrl_pos_map[hub_id] = (cx, cy)
            if hub_id not in positions:
                positions[hub_id] = {'x': cx, 'y': cy}

    # Same missing-position problem as HyperEdge hubs above, but for a
    # REGULAR (2-participant) edge whose own control also has no saved vobj
    # position -- common throughout real files, not just for hyperedges.
    # Without this, clone resolution is skipped for such an edge entirely
    # (see the loop below), so it silently keeps whichever ref its <link>
    # pointed to -- always the stable/original ref, since RNEF links have
    # no notion of "this specific visual instance" -- leaving a cloned
    # endpoint with fewer (or zero) edges than it should have while its
    # original absorbs all of them instead. Wherever at least one endpoint
    # is NOT itself cloned, that endpoint's own position is an unambiguous
    # anchor letting the same clone-resolution logic below pick the correct
    # instance for the OTHER (cloned) endpoint.
    for edge in edges_map.values():
        start = edge['startNodeId']
        end   = edge['endNodeId']
        has_cs = bool(clone_map.get(start))
        has_ce = bool(clone_map.get(end))
        if not has_cs and not has_ce:
            continue
        relation_id = edge['properties'].get('URN', edge['id'])
        if relation_id in ctrl_pos_map:
            continue
        anchor = None
        if not has_cs and start in positions:
            anchor = positions[start]
        elif not has_ce and end in positions:
            anchor = positions[end]
        if anchor:
            ctrl_pos_map[relation_id] = (anchor['x'], anchor['y'])

    # Clone resolution: use RelationID to find control position for both
    # regular edges and ChemicalReaction sub-edges.
    #
    # A node ref with clones can be claimed by MULTIPLE edges/controls at
    # once (e.g. one enzyme catalyzing several distinct reactions, each
    # drawn near a different one of its visual copies). Resolving each
    # claim independently via "whichever instance is nearest ME" can have
    # two different controls both pick the SAME instance when their
    # positions happen to be closer to each other than to the other
    # instances, leaving that instance with multiple edges while another
    # instance -- often the original -- ends up with none at all. Seen
    # directly in real data: HSD3B2 (urn:agi-llid:3284) has 3 drawn
    # instances and 3 catalyzed reactions, but two reactions' controls
    # both resolved to the same clone (2.31 vs 2.84 squared-distance, a
    # margin of only ~0.5), leaving the original instance with zero edges.
    #
    # Fix: collect every resolution request for a given base ref together,
    # then assign them to instances GREEDILY BY GLOBAL ASCENDING DISTANCE
    # instead of one request at a time -- so once the closest (request,
    # instance) pair anywhere in the group is taken, that instance is off
    # the table for every other request in the same group. This naturally
    # produces a 1-to-1 assignment whenever there are at least as many
    # instances as requests, matching how these diagrams are actually laid
    # out (each visual copy of a node sits next to the one reaction it
    # participates in). Only if requests outnumber instances do leftover
    # requests fall back to plain nearest-with-reuse.
    requests_by_ref = {}
    for edge_id, edge in edges_map.items():
        start = edge['startNodeId']
        end   = edge['endNodeId']
        has_cs = bool(clone_map.get(start))
        has_ce = bool(clone_map.get(end))
        if not has_cs and not has_ce:
            continue
        relation_id = edge['properties'].get('URN', edge_id)
        effect_stripped = re.sub(r':(positive|negative|unknown)$', '', relation_id, flags=re.IGNORECASE)
        cp = ctrl_pos_map.get(relation_id) or ctrl_pos_map.get(effect_stripped)
        if not cp:
            continue
        cx, cy = cp
        if has_cs:
            requests_by_ref.setdefault(start, []).append((edge, 'startNodeId', cx, cy))
        if has_ce:
            requests_by_ref.setdefault(end, []).append((edge, 'endNodeId', cx, cy))

    for ref, reqs in requests_by_ref.items():
        candidates = [(ref, positions.get(ref), False)]  # False = the original
        for cid in clone_map.get(ref, []):
            candidates.append((cid, positions.get(cid), True))  # True = a clone
        candidates = [(nid, p, is_clone) for nid, p, is_clone in candidates if p]
        if not candidates:
            continue

        # Every (request, candidate) pair, sorted by squared distance; ties
        # (e.g. a request equidistant from the original and a clone) prefer
        # the clone first, same rationale as before -- clones exist to hold
        # a visually distinct subset of a busy node's edges.
        pairs = []
        for ri, (edge, role, cx, cy) in enumerate(reqs):
            for ci, (nid, p, is_clone) in enumerate(candidates):
                d2 = (p['x'] - cx) ** 2 + (p['y'] - cy) ** 2
                pairs.append((d2, not is_clone, ri, ci))
        pairs.sort(key=lambda t: (t[0], t[1]))

        assigned_request   = [False] * len(reqs)
        assigned_candidate = [False] * len(candidates)
        for d2, _, ri, ci in pairs:
            if assigned_request[ri] or assigned_candidate[ci]:
                continue
            assigned_request[ri] = True
            assigned_candidate[ci] = True
            edge, role, cx, cy = reqs[ri]
            edge[role] = candidates[ci][0]

        # More requests than available instances -- leftovers fall back to
        # plain nearest, allowing reuse (matches the old single-request
        # behaviour rather than leaving a request unresolved).
        for ri, (edge, role, cx, cy) in enumerate(reqs):
            if assigned_request[ri]:
                continue
            best = min(candidates, key=lambda c: ((c[1]['x'] - cx) ** 2 + (c[1]['y'] - cy) ** 2, not c[2]))
            edge[role] = best[0]

    # -- Assemble output ------------------------------------------------------
    n_clones = sum(len(v) for v in clone_map.values())
    n_hyperedge = sum(1 for n in nodes_map.values() if n.get('labels') == ['HyperEdge'])
    out = {
        'name':    resnet_name,
        'urn':     resnet_urn,
        'savedAt': datetime.now(timezone.utc).isoformat(),
        'layout':  'preset' if positions else 'dagre',
        'positions': positions,
        'properties': properties,
        'graphData': {
            'nodes': list(nodes_map.values()),
            'edges': list(edges_map.values())
        }
    }

    fname    = safe_filename(resnet_name) + '.json'
    out_path = os.path.join(out_dir, fname)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    sys.stderr.write(
        "  OK  '{}'\n"
        "      nodes={} (clones={} hyperedge_hubs={})  edges={}  positions={}\n"
        "      -> {}\n".format(
            resnet_name, len(nodes_map), n_clones, n_hyperedge,
            len(edges_map), len(positions), out_path
        )
    )


_LARGE_UNUSED_BLOCK_RE = re.compile(
    rb'<(thumbnail|schema)(\s[^>]*)?>.*?</\1>', re.DOTALL
)

def _strip_large_unused_blocks(raw):
    # <thumbnail> (a base64-encoded preview image) and <schema> (attr-type
    # metadata) are never read by convert_resnet() -- nothing downstream
    # uses them -- but a <thumbnail> in particular can be enormous (a single
    # embedded image has been observed to account for the bulk of a 200MB
    # RNEF file). Stripping both out of the raw bytes before handing them to
    # ET.parse() avoids ever materializing that unused content into the DOM
    # tree at all, rather than paying the memory/time cost of a full parse
    # just to ignore the result.
    return _LARGE_UNUSED_BLOCK_RE.sub(b'', raw)


def convert(input_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    with open(input_path, 'rb') as f:
        raw = f.read()
    raw = _strip_large_unused_blocks(raw)
    root = ET.fromstring(raw)
    resnets = root.findall('resnet')
    sys.stderr.write("Found {} resnet(s) in {}\n".format(len(resnets), os.path.basename(input_path)))
    for resnet in resnets:
        convert_resnet(resnet, out_dir)


if __name__ == '__main__':
    # On Windows, stdout/stderr default to the system console codepage (e.g.
    # cp1252) rather than UTF-8 — pathway/resnet names printed to stderr here
    # can contain characters outside that codepage (real curated pathway
    # text has been observed to contain a zero-width space and other
    # copy/paste artifacts), which raises UnicodeEncodeError the moment such
    # a character is written. Reconfiguring both streams to UTF-8 up front
    # (Python 3.7+) avoids that regardless of the host console's codepage.
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding='utf-8')
        except AttributeError:
            pass  # Python < 3.7 — unlikely, but don't hard-fail over it

    if len(sys.argv) < 3:
        print("Usage: python rnef_to_json.py <input.rnef> <output_dir>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])