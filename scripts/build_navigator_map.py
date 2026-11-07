"""Light map data for the sidebar navigator, drawn in the style of a printed wine map.

From each village scene it keeps, simplified:
  - the AOC areas by class (grand cru, premier cru, village; regional areas only in the overview), plus premier and
    grand cru lieux-dits,
  - forests,
  - main roads (dual carriageways and motorways as "major", single-carriageway roads as "minor").
Output
  data/navigator/<villageId>.json   {"aoc": [[class, rings, featureId, layer, name]], "forest": [rings], "roads": [[kind, line]]}
                                    (featureId and layer find the same feature in the 3D scene, so a click can open it)
                                    coordinates are Lambert-93 metres rounded to 1 m, simplified to about 6 m
  data/navigator/overview.json      {"best": {villageId: best appellation class in the commune}}, so the regional overview
                                    can shade whole communes, as printed regional maps do.

Usage: python scripts/build_navigator_map.py dist          (or dist/rhone)
"""
from __future__ import annotations
import gzip, json, sys
from pathlib import Path

LOCAL_TOL = 6.0
KEEP_CLASSES = {'grand-cru', 'premier-cru', 'village'}
RANK = {'grand-cru': 0, 'premier-cru': 1, 'village': 2, 'regional': 3}  # other (Rhône) appellations rank as village-level
MAJOR, MINOR = {'Type autoroutier', 'Route à 2 chaussées', 'Bretelle'}, {'Route à 1 chaussée'}


def simplify(points, tol):
    """Douglas-Peucker on a list of [x, y] (iterative, keeps the end points)."""
    if len(points) < 3: return points
    if points[0][:2] == points[-1][:2]:
        # a closed ring: split at the point farthest from the start, simplify both halves
        x0, y0 = points[0][:2]; far = max(range(len(points)), key=lambda i: (points[i][0] - x0) ** 2 + (points[i][1] - y0) ** 2)
        if far in (0, len(points) - 1): return points
        return simplify(points[:far + 1], tol)[:-1] + simplify(points[far:], tol)
    keep = [False] * len(points); keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop(); ax, ay = points[a][:2]; bx, by = points[b][:2]
        dx, dy = bx - ax, by - ay; norm = (dx * dx + dy * dy) ** .5 or 1e-9
        best, index = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i][:2]; d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best: best, index = d, i
        if best > tol: keep[index] = True; stack += [(a, index), (index, b)]
    return [p for p, k in zip(points, keep) if k]


def ring_area(ring):
    return abs(sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring)))) / 2


def polygons(value):
    """Any nesting of rings -> list of polygons, each [outer, *holes]."""
    out = []
    def visit(v):
        if not isinstance(v, list) or not v: return
        if isinstance(v[0], list) and v[0] and isinstance(v[0][0], (int, float)): out.append([v]); return
        if isinstance(v[0], list) and v[0] and isinstance(v[0][0], list) and v[0][0] and isinstance(v[0][0][0], (int, float)): out.append(v); return
        for item in v: visit(item)
    visit(value)
    return out


def simple_rings(value, tol, min_area):
    rings = []
    for poly in polygons(value):
        for k, ring in enumerate(poly):
            if ring_area(ring) < (min_area if k == 0 else min_area * 2):
                if k == 0: break
                continue
            s = simplify(ring, tol)
            if len(s) >= 4: rings.append([[round(p[0]), round(p[1])] for p in s])
    return rings


def main(site: Path):
    data = site / 'data'; out_dir = data / 'navigator'; out_dir.mkdir(exist_ok=True)
    villages = json.loads((data / 'index.json').read_text('utf8'))['villages']
    overview, total = {}, 0
    for v in villages:
        path = site / v['scene'].split('?')[0]
        if not path.exists(): path = data / 'scenes' / f"{v['id']}.json.gz"
        if not path.exists(): continue
        raw = path.read_bytes(); scene = json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)
        aoc, coarse = [], []
        for p in scene.get('parcels', []):
            cls = p.get('displayClassification') or p.get('classification')
            if not cls: continue
            # the overview keeps regional areas too (they make the broad wine-region bands); the local map does not
            coarse.append(cls)
            if cls == 'regional' or (site.name != 'rhone' and cls not in KEEP_CLASSES): continue
            rings = simple_rings(p.get('rings'), LOCAL_TOL, 200)
            if rings: aoc.append([cls, rings, str(p.get('id') or ''), 'parcels', p.get('name') or ''])
        # premier and grand cru lieux-dits: on the 3D map these carry the class colour where the AOC layer has no
        # separate premier-cru area (the part inside the AOC, aocSelectionRings, when given)
        for c in scene.get('climats', []):
            cls = c.get('classification')
            if cls not in ('grand-cru', 'premier-cru'): continue
            rings = simple_rings(c.get('aocSelectionRings') or c.get('rings'), LOCAL_TOL, 200)
            if rings: aoc.append([cls, rings, str(c.get('id') or ''), 'climats', c.get('displayName') or c.get('name') or ''])
            coarse.append(cls)
        forest = [r for f in scene.get('forests', []) for r in simple_rings(f.get('rings'), 15, 5000)]
        roads = []
        for road in scene.get('roads', []):
            kind = 'major' if road.get('kind') in MAJOR else 'minor' if road.get('kind') in MINOR else None
            line = road.get('coordinates') or []
            if kind and len(line) >= 2:
                s = simplify(line, LOCAL_TOL if kind == 'major' else 14); roads.append([kind, [[round(p[0]), round(p[1])] for p in s]])
        body = json.dumps({'aoc': aoc, 'forest': forest, 'roads': roads}, separators=(',', ':'), ensure_ascii=False)
        (out_dir / f"{v['id']}.json").write_text(body, 'utf8'); total += len(body)
        if coarse: overview[v['id']] = min(coarse, key=lambda c: RANK.get(c, 1.5))
    ov = json.dumps({'schemaVersion': 2, 'best': overview}, separators=(',', ':'), ensure_ascii=False)
    (out_dir / 'overview.json').write_text(ov, 'utf8')
    print(len(villages), 'villages;', round(total / 1e6, 1), 'MB local files;', round(len(ov) / 1e3), 'KB overview')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
