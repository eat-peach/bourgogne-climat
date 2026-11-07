"""Sharp terrain tiles for the compare view: one small height tile per grand and premier cru (Burgundy).

The compare panel draws each cru as a static 3D view. The village scene's terrain grid (~25 m) is too soft at that
zoom, so this cuts a tile around every grand and premier cru from IGN RGE ALTI 1 m, averaged to 5 m (coarser only for
very large crus, so a tile stays at most 512 cells across), with a margin wide enough for the view when the cru is
compared with a much larger one. Cells outside the 1 m coverage are filled from the 25 m overview.

Source: IGN RGE ALTI (1 m and 25 m), the same tiles as build_terroir.py. Geometry: the AOC areas in the dist scenes,
joined across communes (a cru split between villages is stored once per village with the same id).

Output: dist/data/cruterrain/<id>.png  heights as 16-bit decimetres above the tile minimum, packed in red (high byte)
                                       and green (low byte) of an opaque RGB PNG
        dist/data/cruterrain/index.json {"<id>": [x0, y1, cell, width, height, minimum metres]}  (EPSG:2154, x0/y1 = the
                                       tile's west and north edges)
Usage:  python scripts/build_cru_terrain.py [--only <cru id>]
"""
from __future__ import annotations
import argparse, gzip, json, math, sys
from pathlib import Path
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_terroir as bt  # noqa: E402  (shares the terrain tile readers)

DATA = bt.DATA
OUT = DATA / 'cruterrain'
CELL = 5.0
MAX_CELLS = 512
CLASSES = {'grand-cru', 'premier-cru'}


def scene(vid):
    raw = (DATA / 'scenes' / f'{vid}.json.gz').read_bytes()
    return json.loads(gzip.decompress(raw) if raw[:2] == bytes([0x1f, 0x8b]) else raw)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--only'); a = ap.parse_args()
    crus = json.loads((DATA / 'cru-index.json').read_text('utf8'))['crus']
    by_id = {}
    for c in crus:
        if c.get('class') in CLASSES: by_id.setdefault(str(c['id']), set()).add(c['village'])
    if a.only: by_id = {a.only: by_id[a.only]}
    bt._T1 = bt.tile_index(bt.T1, '*.tif'); bt._T25 = bt.tile_index(bt.T25, '*.tif')
    res1 = next(iter(bt._T1.values()))[4]
    scenes = {}
    OUT.mkdir(parents=True, exist_ok=True)
    index = json.loads((OUT / 'index.json').read_text('utf8')) if a.only and (OUT / 'index.json').exists() else {}
    total = 0
    for n, (cid, villages) in enumerate(sorted(by_id.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0), 1):
        pts = []
        for vid in villages:
            if vid not in scenes: scenes[vid] = scene(vid)
            for f in scenes[vid].get('parcels', []):
                if str(f.get('id')) == cid:
                    for poly in bt.polygons(f.get('rings')): pts.extend(poly[0])
        if not pts: continue
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        size = max(max(xs) - min(xs), max(ys) - min(ys))
        margin = max(450.0, size * .75)
        x0, x1 = min(xs) - margin, max(xs) + margin; y0, y1 = min(ys) - margin, max(ys) + margin
        cell = max(CELL, math.ceil(max(x1 - x0, y1 - y0) / MAX_CELLS / res1) * res1)
        cell = math.ceil(cell / CELL) * CELL
        x0 = math.floor(x0 / cell) * cell; y0 = math.floor(y0 / cell) * cell
        x1 = math.ceil(x1 / cell) * cell; y1 = math.ceil(y1 / cell) * cell
        grid, _, _ = bt.mosaic(bt._T1, (x0, y0, x1, y1), cell, reduce='block')
        if np.isnan(grid).any():  # outside the 1 m coverage: the 25 m overview, nearest cell
            ov, ovb = bt.overview((x0 - 50, y0 - 50, x1 + 50, y1 + 50))
            rr, cc = np.nonzero(np.isnan(grid))
            X = x0 + (cc + .5) * cell; Y = y1 - (rr + .5) * cell
            oc = np.clip(((X - ovb[0]) / 25).astype(int), 0, ov.shape[1] - 1); orr = np.clip(((ovb[3] - Y) / 25).astype(int), 0, ov.shape[0] - 1)
            grid[rr, cc] = ov[orr, oc]
        if np.isnan(grid).all(): continue
        grid = np.where(np.isnan(grid), np.nanmin(grid), grid)
        lo = float(np.floor(np.nanmin(grid)))
        dm = np.clip(np.round((grid - lo) * 10), 0, 65535).astype(np.uint16)
        rgb = np.zeros(dm.shape + (3,), np.uint8); rgb[..., 0] = dm >> 8; rgb[..., 1] = dm & 255
        path = OUT / f'{cid}.png'
        Image.fromarray(rgb, 'RGB').save(path, optimize=True)
        total += path.stat().st_size
        index[cid] = [round(x0, 1), round(y1, 1), cell, int(dm.shape[1]), int(dm.shape[0]), lo]
        if n % 50 == 0: print(f'{n}/{len(by_id)} {total/1e6:.1f} MB', flush=True)
    (OUT / 'index.json').write_text(json.dumps(index, separators=(',', ':')), 'utf8')
    print(f'{len(index)} tiles, {total/1e6:.1f} MB')


if __name__ == '__main__':
    main()
