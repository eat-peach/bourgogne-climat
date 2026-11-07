"""Precompute rain streams for each village from the IGN RGE ALTI 1 m terrain, for the atlas's Rain mode.

For every village the 1 m terrain is averaged to a 5 m grid over the village's box plus a 1 km margin (so streams
entering from just outside still carry water from upslope). Hollows are filled (priority flood), every cell drains to
its steepest lower neighbour (D8), and for each cell the script adds up how much of each ground type drains through it,
using the same six ground types as the browser (simulation.js LAND_COVER): AOC areas = vineyard, then woods, water,
paved and gravel roads, and buildings painted over them; the rest is meadow or fields. Water's travel time from the
farthest point upslope uses the USDA TR-55 shallow-flow speed 4.9 √s m/s (at least 0.1 m/s), as in the browser.

Mapped watercourses and ponds are first cut BURN_M into the terrain (stream burning), so water passes through road and
railway embankments where real culverts carry the mapped streams. Channels are cells draining at least MIN_AREA_M2; each is traced from its head to the stream it joins (running two cells
on into it), smoothed with a five-cell running average, simplified (Douglas-Peucker, SIMPLIFY_M) and clipped to the
village box. Output: dist/data/streams/<village>.json.gz with, per stream, vertex positions in metres from the box's
south-west corner and, per vertex, the upslope area of each ground type (m²), travel time (s), slope (‰) and flow length (m).

It also writes the ground fields the rain shading uses, at FIELD_CELL metres over the village box, as two lossless WebP
images (dist/data/rainfields/<village>-a.webp and -b.webp, listed with their bounds in rainfields/index.json):
  a = downhill direction x, z (0.5 ± 0.5) · slope (0–30 %) · hollow depth (0–4 m)
  b = wetness index ln(a / tan β), as (index − 2) / 14 · minutes for water to arrive (0–255) · log10 of the upslope
      area in m² / 7 · 255 where the terrain is valid
The same scales are used for the coarse fields the browser works out itself, so the two blend seamlessly.

Usage: python scripts/build_streams.py [village-id ...] [--workers N]   (no ids: every village in the index)
Needs numpy and Pillow only.
"""
from __future__ import annotations
import argparse, gzip, heapq, json, math, sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

WEB = Path(__file__).resolve().parents[1]
DIST = WEB / 'dist'
TERRAIN = WEB.parent / 'burgundy_full' / '03_terrain' / 'rgealti_mnt_1m'
OUT = DIST / 'data' / 'streams'
FIELDS = DIST / 'data' / 'rainfields'
FIELD_CELL = 10.0     # metres per pixel of the rain field images
CELL = 5.0            # metres per grid cell
MARGIN = 1000.0       # metres of terrain read around the village box
MIN_AREA_M2 = 25000.0  # smallest upslope area kept as a channel (2.5 ha); smaller rills on smooth slopes come out as straight grid lines, and the ground film shows that water instead
SIMPLIFY_M = 1.5
BURN_M = 3.0          # depth mapped watercourses are cut into the terrain before routing (stream burning)
NODATA = -99999.0
K = 6                 # ground types: open, vines, forest, built, road, water (same order as simulation.js)


def load_index():
    villages = []
    for path in sorted(DIST.glob('data/index-*.json')):
        villages += json.loads(path.read_text('utf8'))['villages']
    return {v['id']: v for v in villages}


def read_scene(village):
    path = DIST / (village['scene'] + '.gz')
    if not path.exists(): path = DIST / village['scene']
    raw = path.read_bytes()
    if raw[:2] == b'\x1f\x8b': raw = gzip.decompress(raw)
    return json.loads(raw)


def terrain_grid(box):
    """Mean of the 1 m terrain over CELL × CELL blocks; NaN where there is no data."""
    x0, y0, x1, y1 = box
    cols, rows = int(round((x1 - x0) / CELL)), int(round((y1 - y0) / CELL))
    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    f = int(CELL)
    for tx in range(int(x0 // 1000), int(math.ceil(x1 / 1000))):
        for ty in range(int(y0 // 1000), int(math.ceil(y1 / 1000))):
            # Tiles are named by the kilometre of their south-west corner; the file's own tie point (its top-left corner)
            # is checked so a tile can never be placed in the wrong square.
            path = TERRAIN / f'RGEALTI_MNT_{tx:04d}_{ty:04d}_1M_EPSG2154.tif'
            if not path.exists(): continue
            img = Image.open(path)
            tie = img.tag_v2.get(33922)
            if not tie or abs(tie[3] - tx * 1000) > .5 or abs(tie[4] - (ty + 1) * 1000) > .5:
                raise ValueError(f'{path.name}: tie point {tie} does not match its name')
            a = np.array(img, dtype=np.float32)
            a[a <= NODATA + 1] = np.nan
            blocks = a.reshape(1000 // f, f, 1000 // f, f).mean(axis=(1, 3))  # row 0 is the tile's north edge
            # place the tile (x tx*1000.., y from (ty+1)*1000 down) into the grid (row 0 = north edge y1)
            c0 = int(round((tx * 1000 - x0) / CELL)); r0 = int(round((y1 - (ty + 1) * 1000) / CELL))
            n = 1000 // f
            rs, cs = max(0, r0), max(0, c0); re, ce = min(rows, r0 + n), min(cols, c0 + n)
            if rs >= re or cs >= ce: continue
            grid[rs:re, cs:ce] = blocks[rs - r0:re - r0, cs - c0:ce - c0]
    return grid


def land_cover(box, shape, scenes):
    """Ground type per cell, painted from the scenes' map layers (later layers win)."""
    x0, y0, x1, y1 = box
    rows, cols = shape
    img = Image.new('L', (cols, rows), 0)
    draw = ImageDraw.Draw(img)
    px = lambda p: ((p[0] - x0) / CELL, (y1 - p[1]) / CELL)

    def rings(feature):
        g = feature.get('rings') if isinstance(feature, dict) else None
        out = []
        def visit(v):
            if not isinstance(v, list) or not v: return
            if isinstance(v[0], (int, float)): return
            if isinstance(v[0], list) and v[0] and isinstance(v[0][0], (int, float)): out.append(v); return
            for item in v: visit(item)
        visit(g if g is not None else feature.get('coordinates') if isinstance(feature, dict) else feature)
        return out

    def fill(features, k):
        for feature in features or []:
            parts = rings(feature)
            for j, ring in enumerate(parts):
                if len(ring) >= 3: draw.polygon([px(p) for p in ring], fill=k if j == 0 or k != 0 else 0)

    def stroke(lines, k, metres):
        w = max(1, int(round(metres / CELL)))
        for line in lines or []:
            coords = line.get('coordinates') if isinstance(line, dict) else line
            if isinstance(coords, list) and len(coords) >= 2 and isinstance(coords[0], list) and isinstance(coords[0][0], (int, float)):
                draw.line([px(p) for p in coords], fill=k, width=w)

    for s in scenes: fill(s.get('parcels'), 1)
    for s in scenes: fill(s.get('forests') or s.get('forest'), 2)
    for s in scenes: fill(s.get('waterSurfaces'), 5); stroke(s.get('waterLines'), 5, 4)
    for s in scenes:
        roads = s.get('roads') or []
        stroke([r for r in roads if 'chauss' in str(r.get('kind', '')).lower()], 4, 6)
        stroke([r for r in roads if 'empierr' in str(r.get('kind', '')).lower()], 4, 4)
    for s in scenes: fill(s.get('buildings'), 3)
    return np.array(img, dtype=np.uint8)


def route(h):
    """Priority flood (with a small rise so flats drain), D8 receivers, topological order."""
    rows, cols = h.shape
    valid = ~np.isnan(h)
    filled = np.where(valid, h, np.inf).astype(np.float64)
    closed = ~valid
    heap = []
    edge = np.zeros_like(valid)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    pad = np.pad(~valid, 1, constant_values=True)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr or dc: edge |= pad[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols]
    edge &= valid
    for r, c in zip(*np.nonzero(edge)):
        closed[r, c] = True; heapq.heappush(heap, (filled[r, c], int(r) * cols + int(c)))
    flat_h = filled.ravel(); flat_closed = closed.ravel()
    offsets = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    order = []
    while heap:
        z, i = heapq.heappop(heap); order.append(i)
        r, c = divmod(i, cols)
        for dr, dc in offsets:
            rr, cc = r + dr, c + dc
            if rr < 0 or cc < 0 or rr >= rows or cc >= cols: continue
            j = rr * cols + cc
            if flat_closed[j]: continue
            flat_closed[j] = True
            if flat_h[j] <= z: flat_h[j] = z + 1e-3
            heapq.heappush(heap, (flat_h[j], j))
    filled = flat_h.reshape(rows, cols)
    # D8: steepest drop per unit distance to a valid neighbour
    best = np.full((rows, cols), -1, dtype=np.int64); steepest = np.zeros((rows, cols))
    fpad = np.pad(filled, 1, constant_values=np.inf)
    idx = np.arange(rows * cols).reshape(rows, cols)
    for dr, dc in offsets:
        nb = fpad[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols]
        with np.errstate(invalid="ignore"): drop = (filled - nb) / (math.hypot(dr, dc) * CELL)
        better = np.isfinite(nb) & (drop > steepest) & valid
        rr = np.clip(np.arange(rows)[:, None] + dr, 0, rows - 1); cc = np.clip(np.arange(cols)[None, :] + dc, 0, cols - 1)
        best = np.where(better, idx[rr, cc], best); steepest = np.where(better, drop, steepest)
    return filled, best.ravel(), np.array(order, dtype=np.int64)  # order: lowest first (pop order); reverse for upslope-first


def douglas_peucker(points, tol):
    if len(points) < 3: return list(range(len(points)))
    keep = [0, len(points) - 1]; stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop(); ax, ay = points[a]; bx, by = points[b]; dx, dy = bx - ax, by - ay; L = math.hypot(dx, dy) or 1e-9
        far, fd = -1, tol
        for i in range(a + 1, b):
            d = abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / L
            if d > fd: far, fd = i, d
        if far >= 0: keep.append(far); stack += [(a, far), (far, b)]
    return sorted(set(keep))


def write_fields(village_id, vb, box, h, filled, total, arrival, valid):
    """Rain shading fields for the village box at FIELD_CELL metres (see the module docstring)."""
    rows, cols = h.shape
    f = int(FIELD_CELL / CELL)
    c0 = int((vb[0] - box[0]) // FIELD_CELL * f); r0 = int((box[3] - vb[3]) // FIELD_CELL * f)
    c1 = min(cols, int(math.ceil((vb[2] - box[0]) / FIELD_CELL)) * f); r1 = min(rows, int(math.ceil((box[3] - vb[1]) / FIELD_CELL)) * f)
    c1 -= (c1 - c0) % f; r1 -= (r1 - r0) % f
    sl = (slice(r0, r1), slice(c0, c1))
    hv = np.where(np.isnan(h), np.nanmean(h), h)
    gz, gx = np.gradient(hv, CELL)                        # gz along rows (south), gx along columns (east)
    slope = np.hypot(gx, gz)
    fil = filled.reshape(rows, cols); tot = total.reshape(rows, cols); arr = arrival.reshape(rows, cols); ok = valid.reshape(rows, cols)
    pond = np.where(ok, np.maximum(0, fil - hv - .01), 0)
    twi = np.log(np.maximum(tot, CELL * CELL) / CELL / np.maximum(slope, .005))
    def block(a, how):
        a = a[sl]; R, C = a.shape[0] // f, a.shape[1] // f; b = a[:R * f, :C * f].reshape(R, f, C, f)
        return b.mean(axis=(1, 3)) if how == 'mean' else b.max(axis=(1, 3)) if how == 'max' else b.min(axis=(1, 3))
    gxm, gzm, sm = block(gx, 'mean'), block(gz, 'mean'), block(slope, 'mean')
    norm = np.hypot(gxm, gzm); dx = np.where(norm > 1e-6, -gxm / np.maximum(norm, 1e-9), 0); dz = np.where(norm > 1e-6, -gzm / np.maximum(norm, 1e-9), 1)
    byte = lambda a: np.clip(np.round(a * 255), 0, 255).astype(np.uint8)
    a_img = np.dstack([byte(dx * .5 + .5), byte(dz * .5 + .5), byte(sm / .3), byte(block(pond, 'max') / 4)])
    # Wetness and gathered area are averaged and softened over 3 × 3 pixels: per-cell D8 routing leaves parallel streaks and
    # fans on smooth slopes that would otherwise show through the wet-ground shading.
    def soften(a):
        pad = np.pad(a, 1, mode='edge'); return sum(pad[1 + dr:1 + dr + a.shape[0], 1 + dc:1 + dc + a.shape[1]] for dr in (-1, 0, 1) for dc in (-1, 0, 1)) / 9
    b_img = np.dstack([byte((soften(block(twi, 'mean')) - 2) / 14), np.clip(np.round(block(arr, 'max') / 60), 0, 255).astype(np.uint8), byte(soften(np.log10(np.maximum(block(tot, 'max'), 1))) / 7), np.where(block(ok.astype(np.float32), 'min') > .5, 255, 0).astype(np.uint8)])
    FIELDS.mkdir(parents=True, exist_ok=True)
    Image.fromarray(a_img, 'RGBA').save(FIELDS / f'{village_id}-a.webp', lossless=True, exact=True, quality=100, method=4)
    Image.fromarray(b_img, 'RGBA').save(FIELDS / f'{village_id}-b.webp', lossless=True, exact=True, quality=100, method=4)
    x0 = box[0] + c0 * CELL; y1 = box[3] - r0 * CELL
    (FIELDS / f'{village_id}.bounds.json').write_text(json.dumps([x0, y1 - a_img.shape[0] * FIELD_CELL, x0 + a_img.shape[1] * FIELD_CELL, y1]), 'utf8')


def build(village_id, index):
    village = index[village_id]
    vb = village['bounds2154']
    box = [math.floor((vb[0] - MARGIN) / 1000) * 1000, math.floor((vb[1] - MARGIN) / 1000) * 1000, math.ceil((vb[2] + MARGIN) / 1000) * 1000, math.ceil((vb[3] + MARGIN) / 1000) * 1000]
    h = terrain_grid(box)
    if np.isnan(h).all(): return village_id, 0, 'no terrain'
    rows, cols = h.shape
    neighbours = [v for v in index.values() if v['bounds2154'][0] < box[2] and v['bounds2154'][2] > box[0] and v['bounds2154'][1] < box[3] and v['bounds2154'][3] > box[1]]
    scenes = [read_scene(v) for v in neighbours]
    cover = land_cover(box, h.shape, scenes).ravel()
    # Stream burning: mapped watercourses and ponds (IGN) are cut BURN_M into the terrain before routing. Roads and the
    # railway sit on embankments in the 1 m terrain, but water passes under them through culverts where a mapped stream
    # crosses; without this, water would pond behind them and run along them instead.
    burned = h - BURN_M * (cover.reshape(h.shape) == 5)
    filled, receiver, order = route(burned)
    n = rows * cols
    valid = ~np.isnan(h.ravel())
    up = order[::-1]  # highest first
    areas = np.zeros((n, K), dtype=np.float64); areas[np.arange(n), cover] = CELL * CELL; areas[~valid] = 0
    arrival = np.zeros(n); length = np.zeros(n)
    fl = filled.ravel()
    for i in up:
        to = receiver[i]
        if to < 0: continue
        areas[to] += areas[i]
        d = math.hypot(i // cols - to // cols, i % cols - to % cols) * CELL
        v = max(.1, 4.9 * math.sqrt(max(0.0, fl[i] - fl[to]) / d))
        if arrival[i] + d / v > arrival[to]: arrival[to] = arrival[i] + d / v
        if length[i] + d > length[to]: length[to] = length[i] + d
    total = areas.sum(axis=1)
    channel = (total >= MIN_AREA_M2) & (receiver >= 0)
    upstream = np.zeros(n, dtype=np.int32)
    np.add.at(upstream, receiver[channel], 1)
    hr = h.ravel()
    slope = np.zeros(n)
    for i in np.nonzero(channel)[0]:
        to = receiver[i]; d = math.hypot(i // cols - to // cols, i % cols - to % cols) * CELL
        slope[i] = max(0.0, (hr[i] - hr[to]) / d) if not np.isnan(hr[to]) else 0.0
    visited = np.zeros(n, dtype=bool)
    xy = lambda i: (box[0] + (i % cols + .5) * CELL, box[3] - (i // cols + .5) * CELL)
    inside = lambda p: vb[0] - 50 <= p[0] <= vb[2] + 50 and vb[1] - 50 <= p[1] <= vb[3] + 50
    streams = []
    heads = np.nonzero(channel & (upstream == 0))[0]
    heads = heads[np.argsort(-fl[heads])]
    for head in heads:
        if visited[head]: continue
        path = [int(head)]; visited[head] = True; c = int(head); joined = False
        while True:
            to = int(receiver[c])
            if to < 0: break
            path.append(to)
            if visited[to]: joined = True; c = to; break
            visited[to] = True; c = to
        source = list(path)
        if joined and len(path) > 1:
            own = path[-2]; source[-1] = own
            for _ in range(2):
                if receiver[c] < 0: break
                c = int(receiver[c]); path.append(c); source.append(own)
        if len(path) < 7: continue
        pts = [xy(i) for i in path]
        sm = [pts[0]] + [tuple(sum(pts[min(len(pts) - 1, max(0, k + d))][a] * (3 - abs(d)) for d in range(-2, 3)) / 9 for a in (0, 1)) for k in range(1, len(pts) - 1)] + [pts[-1]]
        keep = douglas_peucker(sm, SIMPLIFY_M)
        run = []
        for k in keep:
            if inside(sm[k]): run.append(k)
            elif run:
                if len(run) >= 2: streams.append((sm, source, run))
                run = []
        if len(run) >= 2: streams.append((sm, source, run))
    out = []
    for sm, source, run in streams:
        p, a, t, s, l = [], [], [], [], []
        for k in run:
            i = source[k]
            p += [round(sm[k][0] - vb[0], 1), round(sm[k][1] - vb[1], 1)]
            a += [int(round(v)) for v in areas[i]]; t.append(int(round(arrival[i]))); s.append(int(round(slope[i] * 1000))); l.append(int(round(length[i])))
        out.append({'p': p, 'a': a, 't': t, 's': s, 'l': l})
    OUT.mkdir(parents=True, exist_ok=True)
    write_fields(village_id, vb, box, h, filled.ravel(), total, arrival, valid)
    payload = {'id': village_id, 'origin': [vb[0], vb[1]], 'bounds': vb, 'cellMetres': CELL, 'minAreaM2': MIN_AREA_M2, 'groundTypes': ['open', 'vines', 'forest', 'built', 'road', 'water'], 'source': 'IGN RGE ALTI 1 m, averaged to 5 m', 'streams': out}
    (OUT / f'{village_id}.json.gz').write_bytes(gzip.compress(json.dumps(payload, separators=(',', ':')).encode('utf8'), 9))
    return village_id, len(out), 'ok'


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('ids', nargs='*'); ap.add_argument('--workers', type=int, default=1); args = ap.parse_args()
    index = load_index()
    ids = args.ids or sorted(index)
    if args.workers > 1:
        with ProcessPoolExecutor(args.workers) as pool:
            for vid, count, status in pool.map(build, ids, [index] * len(ids)): print(vid, count, status, flush=True)
    else:
        for vid in ids: print(*build(vid, index), flush=True)
    # The browser only asks for villages listed here, so places without precomputed streams cause no failed requests.
    available = sorted(path.name[:-len('.json.gz')] for path in OUT.glob('*.json.gz'))
    fields = {path.name[:-len('.bounds.json')]: json.loads(path.read_text('utf8')) for path in FIELDS.glob('*.bounds.json')}
    (FIELDS / 'index.json').write_text(json.dumps({'cellMetres': FIELD_CELL, 'source': 'IGN RGE ALTI 1 m', 'villages': fields}, separators=(',', ':')), 'utf8')
    (OUT / 'index.json').write_text(json.dumps({'source': 'IGN RGE ALTI 1 m, averaged to 5 m', 'villages': available}, separators=(',', ':')), 'utf8')


if __name__ == '__main__':
    main()
