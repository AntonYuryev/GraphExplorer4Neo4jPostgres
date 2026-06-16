import xml.etree.ElementTree as ET
import json, sys, os, re
from datetime import datetime, timezone

def safe_filename(name):
    s = re.sub(r'[\\/:*?"<>|]', '_', name)
    return s.strip() or 'unnamed'

def convert_resnet(resnet, out_dir):
    resnet_name = resnet.get('name', 'unnamed')

    # -- Nodes ----------------------------------------------------------------
    nodes_map = {}
    nodes_el = resnet.find('nodes')
    if nodes_el is not None:
        for node in nodes_el.findall('node'):
            nid = node.get('local_id')
            props = {}
            for attr in node.findall('attr'):
                props[attr.get('name')] = attr.get('value')
            node_type = props.get('NodeType', 'Unknown')
            if nid:
                props['URN'] = nid
            if nid and nid not in nodes_map:
                nodes_map[nid] = {
                    'id': nid,
                    'elementId': nid,
                    'labels': [node_type],
                    'properties': props
                }

    # -- Controls (edges) -----------------------------------------------------
    edges_map = {}
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
                    'msrc':    r.get('Sentence', '')
                })

            if control_type == 'ChemicalReaction':
                # Hyperedge: create a small Reaction node + Substrate/Product edges.
                # in participants  → reaction node  (Substrate, no arrowhead)
                # reaction node    → out participants (Product, arrowhead at target)
                nodes_map[eid] = {
                    'id': eid,
                    'elementId': eid,
                    'labels': ['Reaction'],
                    'properties': {
                        'NodeType': 'Reaction',
                        'Name': '',
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
                        'type': 'Substrate',
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
                        'type': 'Product',
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
    ctrl_pos_map = {}   # control_ref -> (x, y)

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
                                            ctrl_pos_map[ref] = (x, y)
                                    except ValueError:
                                        pass
                        # -- Preserve shape only (color ignored) ------------------
                        if vtype == 'Node' and ref in nodes_map:
                            shape = style.get('Shape', '').lower()
                            if shape and shape != 'ellipse':
                                nodes_map[ref]['properties']['rnefShape'] = shape

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

    # Add positions for Reaction nodes (ChemicalReaction hyperedge centres)
    for ctrl_ref, (x, y) in ctrl_pos_map.items():
        if ctrl_ref in nodes_map and nodes_map[ctrl_ref].get('labels') == ['Reaction']:
            if ctrl_ref not in positions:
                positions[ctrl_ref] = {'x': x, 'y': y}

    def nearest_node_id(node_ref, cx, cy):
        candidates = [(node_ref, positions.get(node_ref))]
        for cid in clone_map.get(node_ref, []):
            candidates.append((cid, positions.get(cid)))
        valid = [(nid, p) for nid, p in candidates if p]
        if not valid:
            return node_ref
        return min(valid, key=lambda c: (c[1]['x']-cx)**2 + (c[1]['y']-cy)**2)[0]

    # Clone resolution: use RelationID to find control position for both
    # regular edges and ChemicalReaction sub-edges.
    for edge_id, edge in list(edges_map.items()):
        start = edge['startNodeId']
        end   = edge['endNodeId']
        has_cs = bool(clone_map.get(start))
        has_ce = bool(clone_map.get(end))
        if not has_cs and not has_ce:
            continue
        relation_id = edge['properties'].get('URN', edge_id)
        effect_stripped = re.sub(r':(positive|negative|unknown)$', '', relation_id, flags=re.IGNORECASE)
        cp = ctrl_pos_map.get(relation_id) or ctrl_pos_map.get(effect_stripped)
        if cp:
            cx, cy = cp
            if has_cs:
                edge['startNodeId'] = nearest_node_id(start, cx, cy)
            if has_ce:
                edge['endNodeId']   = nearest_node_id(end, cx, cy)

    # -- Assemble output ------------------------------------------------------
    n_clones = sum(len(v) for v in clone_map.values())
    n_rxn    = sum(1 for n in nodes_map.values() if n.get('labels') == ['Reaction'])
    out = {
        'name':    resnet_name,
        'savedAt': datetime.now(timezone.utc).isoformat(),
        'layout':  'preset' if positions else 'dagre',
        'positions': positions,
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
        "      nodes={} (clones={} reaction_nodes={})  edges={}  positions={}\n"
        "      -> {}\n".format(
            resnet_name, len(nodes_map), n_clones, n_rxn,
            len(edges_map), len(positions), out_path
        )
    )


def convert(input_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tree = ET.parse(input_path)
    root = tree.getroot()
    resnets = root.findall('resnet')
    sys.stderr.write("Found {} resnet(s) in {}\n".format(len(resnets), os.path.basename(input_path)))
    for resnet in resnets:
        convert_resnet(resnet, out_dir)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python rnef_to_json.py <input.rnef> <output_dir>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
