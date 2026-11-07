"""Terroir facts for every lieu-dit (climat) and AOC area: slope, aspect, elevation and modelled sunshine.

Sources (already in the project, no new downloads):
  - IGN RGE ALTI 1 m terrain tiles   burgundy_full/03_terrain/rgealti_mnt_1m   (vineyard footprint)
  - IGN RGE ALTI 25 m overview       burgundy_full/03_terrain/overview_rgealti_25m (for distant hills)
  - the atlas's own feature geometry website/dist/data/scenes/<village>.json.gz (EPSG:2154): its AOC areas and
                                     Etalab lieux-dits, with the same ids the map uses

Method
  Terrain: the 1 m tiles are averaged to a 5 m grid (single 1 m cells pick up walls, terraces and road cuts).
  Elevation range uses the 1 m minimum and maximum inside the feature.
  Slope and aspect: central differences on the 5 m grid. Mean slope is the mean of the cell slopes; aspect is the
  slope-weighted circular mean of the downhill directions (compass degrees, 0 = north, 90 = east).
  Sunshine (a model, clear sky): up to 60 points spread over the feature. For each point the horizon is traced in
  36 directions out to 8 km on the 25 m overview. The sun's path is computed every 10 minutes on every 4th day from
  1 April to 30 September (the growing season). A point counts as in direct sun when the sun is above its horizon
  and shines on the slope's face. Direct-sun hours are the season total; "energy" is the direct beam (simple
  clear-sky air-mass model) falling on the slope, as a percentage of what level, unshaded ground receives.
  No cloud, haze or diffuse light: it compares places, it does not forecast weather.

Output: dist/data/terroir/<village>.json  {"features": {"climats:<id>" | "parcels:<id>": {...}}}
Usage:  python scripts/build_terroir.py [--only <village-id>] [--workers 6]
        Rhône page: TERROIR_SITE=dist/rhone TERROIR_T1=../regions/rhone-nord/raw/terrain TERROIR_T25=../regions/rhone-nord/raw/context python scripts/build_terroir.py
        (there the terrain is 5 m, so elevation ranges come from 5 m cells)
"""
from __future__ import annotations
import argparse, glob, json, math, os, re, sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / 'website'
DATA = Path(os.environ.get('TERROIR_SITE', SITE / 'dist')) / 'data'   # dist, or dist/rhone for the Rhône page
SCENES = DATA / 'scenes'
T1 = Path(os.environ.get('TERROIR_T1', ROOT / 'burgundy_full' / '03_terrain' / 'rgealti_mnt_1m'))        # fine terrain tiles
T25 = Path(os.environ.get('TERROIR_T25', ROOT / 'burgundy_full' / '03_terrain' / 'overview_rgealti_25m'))  # wide-area terrain
OUT = DATA / 'terroir'
CELL = 5.0                      # metres, analysis grid
MARGIN = 60.0                   # metres around the village for slope at the edges
HORIZON_KM = 8.0
AZIMUTHS = np.arange(0, 360, 10.0)
SEASON = (91, 273)              # day of year: 1 April .. 30 September (non-leap)
DAY_STEP, MIN_STEP = 4, 10
POINTS = 60
NODATA = -1000.0


def tile_index(folder, pattern):
    out = {}
    for f in glob.glob(str(folder / pattern)):
        im = Image.open(f); t = im.tag_v2; sc = t[33550]; tp = t[33922]
        out[f] = (tp[3], tp[4] - im.size[1] * sc[1], tp[3] + im.size[0] * sc[0], tp[4], sc[0])
    return out


_T1, _T25 = None, None


def mosaic(index, bounds, cell, reduce=None):
    """A grid over bounds (x0, y0, x1, y1) at `cell` metres from the tiles in index; NaN where there is no data.
    reduce='block' averages source cells into the grid (source resolution finer than cell) and also returns the
    block minimum and maximum."""
    x0, y0, x1, y1 = bounds
    nx, ny = int(math.ceil((x1 - x0) / cell)), int(math.ceil((y1 - y0) / cell))
    grid = np.full((ny, nx), np.nan, np.float32)
    gmin = np.full((ny, nx), np.nan, np.float32) if reduce else None
    gmax = np.full((ny, nx), np.nan, np.float32) if reduce else None
    for f, (tx0, ty0, tx1, ty1, res) in index.items():
        if tx1 <= x0 or tx0 >= x1 or ty1 <= y0 or ty0 >= y1: continue
        a = np.array(Image.open(f), np.float32)
        a[a <= NODATA] = np.nan
        if reduce:
            k = int(round(cell / res)); h, w = a.shape[0] // k * k, a.shape[1] // k * k
            blocks = a[:h, :w].reshape(h // k, k, w // k, k)
            with np.errstate(all='ignore'):
                mean, mn, mx = np.nanmean(blocks, axis=(1, 3)), np.nanmin(blocks, axis=(1, 3)), np.nanmax(blocks, axis=(1, 3))
            src_cell = cell
        else:
            mean, src_cell = a, res
        # place: rows run north to south
        c0 = int(round((tx0 - x0) / cell)); r0 = int(round((y1 - ty1) / cell))
        rr0, cc0 = max(0, r0), max(0, c0)
        rr1, cc1 = min(ny, r0 + mean.shape[0]), min(nx, c0 + mean.shape[1])
        if rr1 <= rr0 or cc1 <= cc0: continue
        sl = (slice(rr0 - r0, rr1 - r0), slice(cc0 - c0, cc1 - c0))
        target = (slice(rr0, rr1), slice(cc0, cc1))
        if src_cell == cell:
            block = mean[sl]; ok = ~np.isnan(block); grid[target][ok] = block[ok]
            if reduce:
                gmin[target][ok] = mn[sl][ok]; gmax[target][ok] = mx[sl][ok]
    return grid, gmin, gmax


def overview(bounds):
    """25 m grid for horizons. From the overview tiles at their own resolution (upsampled when coarser than 25 m);
    where the overview is coarse (a region's 200 m context), the local terrain tiles averaged to 25 m replace it."""
    x0, y0, x1, y1 = bounds
    res = next(iter(_T25.values()))[4]
    step = max(25.0, res)
    x0, y0 = math.floor(x0 / step) * step, math.floor(y0 / step) * step
    x1, y1 = math.ceil(x1 / step) * step, math.ceil(y1 / step) * step
    g, _, _ = mosaic(_T25, (x0, y0, x1, y1), res)
    if res > 25:
        k = int(round(res / 25)); g = np.kron(g, np.ones((k, k), np.float32))
        local, _, _ = mosaic(_T1, (x0, y0, x1, y1), 25.0, reduce='block')
        ok = ~np.isnan(local); g[ok] = local[ok]
    return g, (x0, y0, x1, y1)


def polygons(value):
    out = []
    def visit(v):
        if not isinstance(v, list) or not v: return
        if isinstance(v[0], list) and v[0] and isinstance(v[0][0], (int, float)): out.append([v]); return
        if isinstance(v[0], list) and v[0] and isinstance(v[0][0], list) and v[0][0] and isinstance(v[0][0][0], (int, float)): out.append(v); return
        for item in v: visit(item)
    visit(value)
    return out


def rasterize(polys, bounds, shape):
    x0, y0, x1, y1 = bounds
    img = Image.new('L', (shape[1], shape[0]), 0); d = ImageDraw.Draw(img)
    to_px = lambda ring: [((p[0] - x0) / CELL, (y1 - p[1]) / CELL) for p in ring]
    for poly in polys:
        if len(poly[0]) >= 3: d.polygon(to_px(poly[0]), fill=1)
        for hole in poly[1:]:
            if len(hole) >= 3: d.polygon(to_px(hole), fill=0)
    return np.array(img, bool)


COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']


def sun_table(lat_deg):
    """Sun elevation, azimuth and clear-sky direct normal irradiance through the season (rows = time steps)."""
    lat = math.radians(lat_deg); rows = []
    for doy in range(SEASON[0], SEASON[1] + 1, DAY_STEP):
        g = 2 * math.pi / 365 * (doy - 1)
        dec = .006918 - .399912 * math.cos(g) + .070257 * math.sin(g) - .006758 * math.cos(2 * g) + .000907 * math.sin(2 * g) - .002697 * math.cos(3 * g) + .00148 * math.sin(3 * g)
        for m in range(0, 24 * 60, MIN_STEP):
            ha = math.radians((m + MIN_STEP / 2) / 4 - 180)  # solar time
            sin_el = math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(ha)
            if sin_el <= 0: continue
            el = math.asin(sin_el)
            az = math.atan2(math.sin(ha), math.cos(ha) * math.sin(lat) - math.tan(dec) * math.cos(lat)) + math.pi  # from north, clockwise
            zen = math.degrees(math.pi / 2 - el)
            am = 1 / (math.cos(math.radians(zen)) + .50572 * (96.07995 - zen) ** -1.6364)
            dni = 1361 * .7 ** (am ** .678)
            rows.append((el, az % (2 * math.pi), dni))
    return np.array(rows, np.float64)


def horizons(points_xy, h0, ov, ovb):
    """Horizon elevation angle (radians) for each point in each of AZIMUTHS, from the 25 m overview."""
    x0, y0, x1, y1 = ovb; ny, nx = ov.shape
    dists = np.geomspace(60, HORIZON_KM * 1000, 70)
    az = np.radians(AZIMUTHS)
    dx, dy = np.sin(az)[None, :, None] * dists[None, None, :], np.cos(az)[None, :, None] * dists[None, None, :]
    X = points_xy[:, 0][:, None, None] + dx; Y = points_xy[:, 1][:, None, None] + dy
    c = (X - x0) / 25 - .5; r = (y1 - Y) / 25 - .5
    c0 = np.clip(np.floor(c).astype(int), 0, nx - 2); r0 = np.clip(np.floor(r).astype(int), 0, ny - 2)
    fc, fr = np.clip(c - c0, 0, 1), np.clip(r - r0, 0, 1)
    z = (ov[r0, c0] * (1 - fc) * (1 - fr) + ov[r0, c0 + 1] * fc * (1 - fr) + ov[r0 + 1, c0] * (1 - fc) * fr + ov[r0 + 1, c0 + 1] * fc * fr)
    ang = np.arctan2(z - h0[:, None, None], dists[None, None, :])
    ang = np.where(np.isnan(ang), -1, ang)
    return np.maximum(0, ang.max(axis=2))


def village(vid):
    global _T1, _T25
    if _T1 is None: _T1 = tile_index(T1, '*.tif'); _T25 = tile_index(T25, '*.tif')
    res1 = next(iter(_T1.values()))[4]
    import gzip
    raw = (SCENES / f'{vid}.json.gz').read_bytes()
    scene = json.loads(gzip.decompress(raw) if raw[:2] == bytes([0x1f, 0x8b]) else raw)
    feats = [('parcels', p) for p in scene.get('parcels', [])] + [('climats', c) for c in scene.get('climats', [])]
    feats = [(layer, f, polygons(f.get('rings'))) for layer, f in feats]
    feats = [(l, f, p) for l, f, p in feats if p]
    if not feats: return vid, 0
    xs = [pt[0] for _, _, ps in feats for poly in ps for pt in poly[0]]; ys = [pt[1] for _, _, ps in feats for poly in ps for pt in poly[0]]
    b = (math.floor((min(xs) - MARGIN) / CELL) * CELL, math.floor((min(ys) - MARGIN) / CELL) * CELL, math.ceil((max(xs) + MARGIN) / CELL) * CELL, math.ceil((max(ys) + MARGIN) / CELL) * CELL)
    dem, dmin, dmax = mosaic(_T1, b, CELL, reduce='block')  # 1 m tiles averaged to 5 m (5 m tiles used as they are)
    ov, ovb = overview((b[0] - HORIZON_KM * 1000 - 200, b[1] - HORIZON_KM * 1000 - 200, b[2] + HORIZON_KM * 1000 + 200, b[3] + HORIZON_KM * 1000 + 200))
    # fill 1 m gaps from the overview so slopes at the coverage edge stay sensible
    if np.isnan(dem).any():
        rr, cc = np.nonzero(np.isnan(dem))
        X = b[0] + (cc + .5) * CELL; Y = b[3] - (rr + .5) * CELL
        oc = np.clip(((X - ovb[0]) / 25).astype(int), 0, ov.shape[1] - 1); orr = np.clip(((ovb[3] - Y) / 25).astype(int), 0, ov.shape[0] - 1)
        dem[rr, cc] = ov[orr, oc]
    gy, gx = np.gradient(dem.astype(np.float64), CELL)
    dzdx, dzdn = gx, -gy                                  # east, north
    slope = np.hypot(dzdx, dzdn)
    down = np.arctan2(-dzdx, -dzdn) % (2 * np.pi)          # downhill direction, compass
    lat = None
    try:
        idx = json.loads((DATA / 'index.json').read_text('utf8'))['villages']
        lat = next(float(v['center'][1]) for v in idx if v['id'] == vid)
    except Exception:
        lat = 47.0
    sun = sun_table(lat)
    s_el, s_az, s_dni = sun[:, 0], sun[:, 1], sun[:, 2]
    flat_energy = float((s_dni * np.sin(s_el)).sum())
    flat_hours = len(sun) * MIN_STEP / 60 * DAY_STEP
    out = {}
    for layer, f, ps in feats:
        m = rasterize(ps, b, dem.shape)
        if not m.any():  # very small feature: use the cell under its first vertex
            p = ps[0][0][0]; r = int((b[3] - p[1]) / CELL); c = int((p[0] - b[0]) / CELL)
            if 0 <= r < m.shape[0] and 0 <= c < m.shape[1]: m[r, c] = True
            else: continue
        sl = slope[m]; dn = down[m]; z = dem[m]
        w = sl
        ax, ay = float((np.sin(dn) * w).sum()), float((np.cos(dn) * w).sum())
        aspect = (math.degrees(math.atan2(ax, ay)) + 360) % 360
        consistency = math.hypot(ax, ay) / max(1e-9, float(w.sum()))  # 1 = all one way, 0 = mixed
        zmin = float(np.nanmin(dmin[m])) if np.isfinite(dmin[m]).any() else float(np.nanmin(z))
        zmax = float(np.nanmax(dmax[m])) if np.isfinite(dmax[m]).any() else float(np.nanmax(z))
        # sunshine at up to POINTS cells
        rr, cc = np.nonzero(m)
        pick = np.linspace(0, len(rr) - 1, min(POINTS, len(rr))).astype(int)
        rr, cc = rr[pick], cc[pick]
        pts = np.stack([b[0] + (cc + .5) * CELL, b[3] - (rr + .5) * CELL], 1)
        h0 = dem[rr, cc].astype(np.float64)
        hz = horizons(pts, h0, ov, ovb)                                       # (P, 36)
        az_idx = (s_az / np.radians(10)) % 36                                  # (T,)
        i0 = np.floor(az_idx).astype(int); fr = (az_idx - i0)[None, :]
        hz_t = hz[:, i0 % 36] * (1 - fr) + hz[:, (i0 + 1) % 36] * fr           # (P, T)
        ps_slope = np.arctan(slope[rr, cc])[:, None]; ps_down = down[rr, cc][:, None]
        cos_inc = np.sin(s_el)[None, :] * np.cos(ps_slope) + np.cos(s_el)[None, :] * np.sin(ps_slope) * np.cos(s_az[None, :] - ps_down)
        lit = (s_el[None, :] > hz_t) & (cos_inc > 0)
        hours = lit.sum(1) * MIN_STEP / 60 * DAY_STEP
        energy = (np.where(lit, cos_inc, 0) * s_dni[None, :]).sum(1)
        out[f'{layer}:{f.get("id")}'] = {
            'elevation': {'min': round(zmin, 1), 'max': round(zmax, 1), 'mean': round(float(np.nanmean(z)), 1)},
            'slopePct': round(float(np.nanmean(sl)) * 100, 1),
            'slopeMaxPct': round(float(np.nanpercentile(sl, 95)) * 100, 1),
            'aspectDeg': round(aspect), 'aspect': COMPASS[int((aspect + 11.25) // 22.5) % 16], 'aspectConsistency': round(consistency, 2),
            'sunHours': round(float(hours.mean())), 'sunHoursFlat': round(flat_hours),
            'energyPct': round(float(energy.mean()) / flat_energy * 100),
            'cells': int(m.sum()),
        }
    OUT.mkdir(parents=True, exist_ok=True)
    body = {'schemaVersion': 1, 'village': vid,
            'method': {'terrain': 'IGN RGE ALTI 1 m averaged to 5 m; elevation range from 1 m cells', 'slope': 'mean of 5 m cell slopes (percent); 95th percentile as the steep part',
                       'aspect': 'slope-weighted circular mean of downhill directions; consistency 1 = all one way, 0 = mixed',
                       'sun': f'clear-sky model, terrain horizons to {HORIZON_KM:g} km on IGN RGE ALTI 25 m; 1 Apr-30 Sep, every {DAY_STEP} days, {MIN_STEP}-minute steps; no cloud or diffuse light',
                       'energyPct': 'direct beam on the slope as a percentage of level, unshaded ground'},
            'features': out}
    (OUT / f'{vid}.json').write_text(json.dumps(body, ensure_ascii=False, separators=(',', ':')), 'utf8')
    return vid, len(out)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--only'); ap.add_argument('--scale-only', action='store_true'); ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 2))
    a = ap.parse_args()
    ids = [a.only] if a.only else sorted(p.name[:-len('.json.gz')] for p in SCENES.glob('*.json.gz'))
    if a.scale_only: write_scale(); return
    if len(ids) == 1:
        print(village(ids[0])); return
    with ProcessPoolExecutor(a.workers) as ex:
        for i, (vid, n) in enumerate(ex.map(village, ids), 1):
            print(f'{i}/{len(ids)} {vid} {n}', flush=True)
    write_scale()


def write_scale():
    """Colour-scale ends for the map shading (5th and 95th percentiles over this site's lieux-dits)."""
    sun, slope = [], []
    for f in OUT.glob('*.json'):
        if f.name == 'scale.json': continue
        for k, v in json.loads(f.read_text('utf8'))['features'].items():
            if k.startswith('climats:'): sun.append(v['sunHours']); slope.append(v['slopePct'])
    if not sun: return
    q = lambda xs, p: float(np.percentile(xs, p))
    body = {'sunHours': [round(q(sun, 5), -1), round(q(sun, 95), -1)], 'slopePct': [0, round(q(slope, 95))], 'count': len(sun)}
    (OUT / 'scale.json').write_text(json.dumps(body), 'utf8'); print('scale', body)


if __name__ == '__main__':
    main()
