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

            # Multi-valent? (>1 participant on either side, or any in-out)
            total = len(in_refs) + len(out_refs) + len(inout_refs)
            multivalent = (len(in_refs) > 1 or len(out_refs) > 1 or
                           len(inout_refs) > 0 or total > 2)

            if multivalent:
                # Virtual reaction node
                rxn_id = eid + ':rxn'
                nodes_map[rxn_id] = {
                    'id':        rxn_id,
                    'elementId': rxn_id,
                    'labels':    ['Reaction'],
                    'properties': {
                        'NodeType':    'Reaction',
                        'Name':        '',
                        'ControlType': control_type,
                        'URN':         eid,
                        'NumRefs':     len(references),
                        'references':  references
                    }
                }
                ref_props = {
                    'RelationID': eid,
                    'Effect':     effect,
                    'NumRefs':    len(references),
                    'references': references
                }
                # Substrate edges: in_ref → rxn (no arrowhead)
                for i, ref in enumerate(in_refs):
                    edge_id = eid + ':sub:' + str(i)
                    edges_map[edge_id] = {
                        'id': edge_id, 'elementId': edge_id,
                        'type': 'Substrate',
                        'startNodeId': ref, 'endNodeId': rxn_id,
                        'properties': ref_props
                    }
                # Product edges: rxn → out_ref (arrowhead at out_ref)
                for i, ref in enumerate(out_refs):
                    edge_id = eid + ':prod:' + str(i)
                    edges_map[edge_id] = {
                        'id': edge_id, 'elementId': edge_id,
                        'type': 'Product',
                        'startNodeId': rxn_id, 'endNodeId': ref,
                        'properties': ref_props
                    }
                # Cofactor edges: inout_ref ↔ rxn (dashed, no arrow)
                for i, ref in enumerate(inout_refs):
                    edge_id = eid + ':cof:' + str(i)
                    edges_map[edge_id] = {
                        'id': edge_id, 'elementId': edge_id,
                        'type': 'Cofactor',
                        'startNodeId': ref, 'endNodeId': rxn_id,
                        'properties': {'RelationID': eid, 'Effect': '', 'NumRefs': 0, 'references': []}
                    }
            else:
                # Simple binary edge (existing logic)
                if in_refs and out_refs:
                    start, end = in_refs[0], out_refs[0]
                elif len(inout_refs) >= 2:
                    start, end = inout_refs[0], inout_refs[1]
                else:
                    continue
                edges_map[eid] = {
                    'id': eid, 'elementId': eid,
                    'type': control_type,
                    'startNodeId': start, 'endNodeId': end,
                    'properties': {
                        'RelationID': eid,
                        'Effect':     effect,
                        'NumRefs':    len(references),
                        'references': references
                    }
                }

    # -- Layout / positions ---------------------------------------------------
    positions = {}
    attachments_el = resnet.find('attachments')
    if attachments_el is not None:
        layout_el = attachments_el.find('layout')
        if layout_el is not None:
            scene_el = layout_el.find('scene')
            if scene_el is not None:
                vobjs_el = scene_el.find('vobjs')
                if vobjs_el is not None:
                    for vobj in vobjs_el.findall('vobj'):
                        if vobj.get('type') != 'Node':
                            continue
                        ref = vobj.get('ref')
                        if not ref:
                            continue
                        for attr in vobj.findall('attr'):
                            if attr.get('name') == 'Position':
                                parts = attr.get('value', '').split()
                                if len(parts) == 2:
                                    try:
                                        positions[ref] = {
                                            'x':  float(parts[0]) * 80,
                                            'y': -float(parts[1]) * 80
                                        }
                                    except ValueError:
                                        pass

    # Compute centroid positions for virtual reaction nodes
    for nid, node in nodes_map.items():
        if 'Reaction' not in node.get('labels', []):
            continue
        neighbors = []
        for e in edges_map.values():
            if e['startNodeId'] == nid and e['endNodeId'] in positions:
                neighbors.append(positions[e['endNodeId']])
            elif e['endNodeId'] == nid and e['startNodeId'] in positions:
                neighbors.append(positions[e['startNodeId']])
        if neighbors:
            positions[nid] = {
                'x': sum(p['x'] for p in neighbors) / len(neighbors),
                'y': sum(p['y'] for p in neighbors) / len(neighbors)
            }

    # -- Assemble output ------------------------------------------------------
    out = {
        'name':      resnet_name,
        'savedAt':   datetime.now(timezone.utc).isoformat(),
        'layout':    'preset' if positions else 'dagre',
        'positions': positions,
        'graphData': {
            'nodes': list(nodes_map.values()),
            'edges': list(edges_map.values())
        }
    }

    fname = safe_filename(resnet_name) + '.json'
    out_path = os.path.join(out_dir, fname)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    n_rxn = sum(1 for n in nodes_map.values() if 'Reaction' in n.get('labels',[]))
    print(f"  OK  '{resnet_name}'")
    print(f"      nodes={len(nodes_map)} (rxn={n_rxn})  edges={len(edges_map)}  positions={len(positions)}")
    print(f"      -> {out_path}")

def convert(input_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tree = ET.parse(input_path)
    root = tree.getroot()
    resnets = root.findall('resnet')
    print(f"Found {len(resnets)} resnet(s) in {os.path.basename(input_path)}")
    for resnet in resnets:
        convert_resnet(resnet, out_dir)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python rnef_to_json.py <input.rnef> <output_dir>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
