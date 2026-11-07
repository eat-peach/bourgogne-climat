"""Which cru and lieu-dit each owned parcel lies in, for the owner cards in the atlas search.

For every commune with ownership data, every parcel that has a recorded legal-entity owner is placed by a point inside
it (the centre of its outline when that falls inside, otherwise a point on a horizontal line through the middle) and
tested against that commune's village scene:
  - the grand and premier crus of the cru index (the same INAO areas the cru search flies to), and
  - the lieux-dits (DGFiP / Etalab named places).
Output: data/ownership/owner-crus.json.gz
  {"parcels": {parcelId: [cruId or "", climatId or ""]}, "crus": {cruId: [name, class, village]},
   "climats": {climatId: name}}
This says where a parcel lies; it does not say who farms it or whose label the wine goes under.

Usage: python scripts/build_owner_crus.py dist            (or dist/rhone for a region site)
"""
from __future__ import annotations
import gzip, json, sys
from pathlib import Path


def rings_of(value):
    """Polygons as [outer, *holes] lists of [x, y], from any nesting of rings."""
    out = []
    def visit(v):
        if not isinstance(v, list) or not v: return
        if isinstance(v[0], list) and v[0] and isinstance(v[0][0], (int, float)): out.append([v]); return
        if isinstance(v[0], list) and v[0] and isinstance(v[0][0], list) and v[0][0] and isinstance(v[0][0][0], (int, float)): out.append(v); return
        for item in v: visit(item)
    visit(value)
    return out


def inside_ring(x, y, ring):
    hit = False; n = len(ring); j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]; xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi: hit = not hit
        j = i
    return hit


def inside(x, y, polygons):
    return any(inside_ring(x, y, poly[0]) and not any(inside_ring(x, y, hole) for hole in poly[1:]) for poly in polygons)


def bbox(polygons):
    xs = [p[0] for poly in polygons for p in poly[0]]; ys = [p[1] for poly in polygons for p in poly[0]]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def point_in(polygons):
    """A point inside the parcel: its outline's centre if that lies inside, else the middle of the first inside span
    on a horizontal line through the middle of its bounding box."""
    if not polygons: return None
    outer = max((poly[0] for poly in polygons), key=len)
    cx = sum(p[0] for p in outer) / len(outer); cy = sum(p[1] for p in outer) / len(outer)
    if inside(cx, cy, polygons): return cx, cy
    b = bbox(polygons); y = (b[1] + b[3]) / 2; xs = []
    for poly in polygons:
        for ring in poly:
            for i in range(len(ring)):
                (x1, y1), (x2, y2) = ring[i - 1][:2], ring[i][:2]
                if (y1 > y) != (y2 > y): xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
    xs.sort()
    return ((xs[0] + xs[1]) / 2, y) if len(xs) >= 2 else (cx, cy)


def load(path):
    raw = path.read_bytes()
    return json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)


def main(site: Path):
    data = site / 'data'
    index = json.loads((data / 'index.json').read_text('utf8'))['villages']
    by_code = {str(v['id']).rsplit('-', 1)[-1]: v for v in index}
    cru_index = json.loads((data / 'cru-index.json').read_text('utf8'))['crus'] if (data / 'cru-index.json').exists() else []
    crus_by_village = {}
    for c in cru_index: crus_by_village.setdefault(c['village'], {})[str(c['id'])] = c
    cad_manifest = json.loads((data / 'cadastre' / 'manifest.json').read_text('utf8'))['communes']
    out_parcels, out_crus, out_climats = {}, {}, {}
    for own_path in sorted((data / 'ownership').glob('[0-9]*.json.gz')):
        code = own_path.name.split('.')[0]
        owned = set(load(own_path).get('parcels', {}))
        village, meta = by_code.get(code), cad_manifest.get(code)
        if not owned or not village or not meta: continue
        scene_path = site / (village['scene'].split('?')[0])
        if not scene_path.exists(): scene_path = data / 'scenes' / f"{village['id']}.json.gz"
        scene = load(scene_path)
        wanted = crus_by_village.get(village['id'], {})
        crus = [(str(p['id']), rings_of(p.get('rings'))) for p in scene.get('parcels', []) if str(p.get('id')) in wanted]
        crus = [(i, r, bbox(r)) for i, r in crus if r]
        climats = [(str(c['id']), c.get('displayName') or c.get('name') or '', rings_of(c.get('rings'))) for c in scene.get('climats', [])]
        climats = [(i, n, r, bbox(r)) for i, n, r in climats if r]
        cad = load(site / meta['url'].lstrip('./'))
        for parcel in cad.get('parcels', []):
            pid = str(parcel.get('id'))
            if pid not in owned: continue
            point = point_in(rings_of(parcel.get('rings')))
            if not point: continue
            x, y = point
            cru = next((i for i, r, b in crus if b[0] <= x <= b[2] and b[1] <= y <= b[3] and inside(x, y, r)), '')
            climat = next((i for i, n, r, b in climats if b[0] <= x <= b[2] and b[1] <= y <= b[3] and inside(x, y, r)), '')
            if not cru and not climat: continue
            out_parcels[pid] = [cru, climat]
            if cru and cru not in out_crus: c = wanted[cru]; out_crus[cru] = [c['name'], c['class'], village['id']]
            if climat and climat not in out_climats: out_climats[climat] = next(n for i, n, r, b in climats if i == climat)
        print(code, len(owned), 'owned parcels', flush=True)
    body = {'schemaVersion': 1, 'method': 'a point inside each owned parcel, tested against the cru index areas and the lieux-dits of its commune',
            'parcels': out_parcels, 'crus': out_crus, 'climats': out_climats}
    (data / 'ownership' / 'owner-crus.json.gz').write_bytes(gzip.compress(json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf8'), 9))
    print('placed', len(out_parcels), 'parcels;', len(out_crus), 'crus;', len(out_climats), 'lieux-dits')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
