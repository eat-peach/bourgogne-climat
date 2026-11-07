"""Bedrock and surface geology for the atlas, from BRGM's harmonised 1:50,000 geological maps (BD Charm-50).

Source: BRGM, BD Charm-50, harmonised département maps (GEO050K_HARM_<dep>.zip), Licence Ouverte / Open Licence 2.0.
        https://infoterre.brgm.fr/telechargements/BDCharm50/GEO050K_HARM_<dep>.zip
        Only the polygon layer S_FGEOL is used (one polygon per mapped formation, EPSG:2154).
        The archives are read in place (no unpacking, no GIS libraries): put them in GEOLOGY_SRC.

Outputs (under <site>/data/geology/):
  legend.json          every formation that appears, keyed '<département>:<legend code>': notation, BRGM description (French), English gloss, age, colour
  tiles/<tx>_<ty>.json the formation polygons cut to 4 km tiles (only tiles under a village scene), for the map layer
  <village>.json       for each lieu-dit and AOC area, the formations under it with their share of its area

Method
  Polygons are simplified (Douglas-Peucker, 2.5 m; the source is drawn at 1:50,000, where a line is ~25 m wide on
  the ground) and cut to tile squares. Shares: the formations are drawn on a 5 m grid over the village scene,
  largest first so formations mapped inside another overwrite it, and counted inside each feature. Shares below 3 %
  are dropped. The source scale means boundaries are good to a few tens of metres: small lieux-dits near a contact
  can show the neighbouring formation.

Usage:  python scripts/build_geology.py [--only <village-id>]
        Rhône page: GEOLOGY_SITE=dist/rhone python scripts/build_geology.py
"""
from __future__ import annotations
import argparse, glob, gzip, json, math, os, re, struct, sys, unicodedata, zipfile
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / 'website'
DATA = Path(os.environ.get('GEOLOGY_SITE', SITE / 'dist')) / 'data'
SRC = Path(os.environ.get('GEOLOGY_SRC', ROOT / 'work' / 'geology' / 'zips'))
SCENES = DATA / 'scenes'
OUT = DATA / 'geology'
TILE = 4000.0
CELL = 5.0
SIMPLIFY = 2.5
MIN_SHARE = 3.0
SOURCE = 'BRGM, BD Charm-50 (harmonised 1:50,000 geological maps), Licence Ouverte 2.0'


# ---- reading the archives -------------------------------------------------------------------------------------

def read_dbf(data):
    n, hl, rl = struct.unpack('<IHH', data[4:12])
    fields = []
    for i in range(32, hl - 1, 32):
        f = data[i:i + 32]
        if f[0] == 0x0D: break
        fields.append((f[:11].split(b'\0')[0].decode('ascii'), f[16]))
    rows = []
    for r in range(n):
        rec = data[hl + r * rl: hl + (r + 1) * rl]; p = 1; row = {}
        for name, ln in fields:
            row[name] = rec[p:p + ln].decode('cp1252', 'replace').strip(); p += ln
        rows.append(row)
    return rows


def read_shp(data):
    """Polygon records -> list of (bbox, [ring arrays]). Handles Polygon, PolygonZ and PolygonM."""
    out = []; off = 100; size = len(data)
    while off + 8 <= size:
        clen = struct.unpack('>i', data[off + 4:off + 8])[0] * 2
        rec = data[off + 8: off + 8 + clen]; off += 8 + clen
        st = struct.unpack('<i', rec[:4])[0]
        if st == 0 or len(rec) < 44: out.append(None); continue
        bbox = struct.unpack('<4d', rec[4:36]); nparts, npts = struct.unpack('<2i', rec[36:44])
        parts = list(struct.unpack(f'<{nparts}i', rec[44:44 + 4 * nparts])) + [npts]
        pts = np.frombuffer(rec, '<f8', npts * 2, 44 + 4 * nparts).reshape(-1, 2)
        out.append((bbox, [pts[parts[i]:parts[i + 1]] for i in range(nparts)]))
    return out


def cmyk(row):
    try: c, m, y, k = (float(row[f]) for f in ('C_FOND', 'M_FOND', 'J_FOND', 'N_FOND'))
    except ValueError: return None
    if min(c, m, y, k) < 0: return None
    r, g, b = (round(255 * (1 - v / 100) * (1 - k / 100)) for v in (c, m, y))
    return f'#{r:02x}{g:02x}{b:02x}'


# ---- English gloss --------------------------------------------------------------------------------------------

ROCKS = [  # (French stem, English) in the order a reader would want them; matched on accent-free lower case
    ('remblai', 'made ground'), ('depots anthropiques', 'made ground'), ('eboulis', 'scree'), ('glissement', 'landslip'),
    ('colluvion', 'colluvium'), ('alluvion', 'alluvium'), ('terrasse', 'river terrace'), ('loess', 'loess'), ('lœss', 'loess'),
    ('limon', 'silt'), ('tuf carbonate', 'tufa'), ('tuff carbonate', 'tufa'), ('craie', 'chalk'), ('entroque', 'crinoidal limestone'),
    ('oolithe ferrugineuse', 'oolitic ironstone'), ('calcaire oolithique', 'oolitic limestone'), ('oolithe blanche', 'oolitic limestone'),
    ('calcaire', 'limestone'), ('calcarenite', 'limestone'), ('dolomie', 'dolomite'),
    ('marne', 'marl'), ('argile', 'clay'), ('sable', 'sand'), ('gres', 'sandstone'), ('arkose', 'arkose'),
    ('gravier', 'gravel'), ('galet', 'pebbles'), ('cailloutis', 'gravel'), ('conglomerat', 'conglomerate'), ('breche', 'breccia'),
    ('meuliere', 'millstone grit'), ('silex', 'flint'), ('chaille', 'chert'), ('houill', 'coal measures'),
    ('leucogranite', 'leucogranite'), ('microgranite', 'microgranite'), ('granodiorite', 'granodiorite'), ('granite', 'granite'),
    ('granitoide', 'granite'), ('diorite', 'diorite'), ('gabbro', 'gabbro'), ('migmatite', 'migmatite'), ('anatexite', 'anatexite'),
    ('gneiss', 'gneiss'), ('micaschiste', 'mica schist'), ('schiste', 'schist'), ('corneenne', 'hornfels'), ('leptyn', 'leptynite (fine gneiss)'),
    ('rhyolit', 'rhyolite'), ('tuf', 'tuff'), ('basalte', 'basalt'), ('filons de quartz', 'quartz veins'), ('filon de quartz', 'quartz veins'),
    ('quartz filonien', 'quartz veins'), ('quartz', 'quartz veins'), ('quartzite', 'quartzite'), ('amphibolite', 'amphibolite'), ('phyllonite', 'crushed rock (phyllonite)'),
    ('serpentin', 'serpentinite'), ('lac', 'water'), ('etang', 'water'), ('reseau hydro', 'water'),
    ('cones de dejection', 'alluvial fan'), ('formations de versant', 'slope deposits'), ('cryoclastique', 'frost-shattered scree'),
    ('poudingue', 'conglomerate'), ('molasse', 'molasse'), ('lumachelle', 'shelly limestone'), ('marbre', 'marble'),
    ('grauwacke', 'greywacke'), ('siltite', 'siltstone'), ('chloritoschiste', 'chlorite schist'), ('monzogranite', 'granite (monzogranite)'),
    ('monzonit', 'monzonite'), ('alaskite', 'granite (alaskite)'), ('micro-alaskite', 'granite (alaskite)'), ('pegmatite', 'pegmatite'),
    ('lamprophyre', 'lamprophyre'), ('microdiorite', 'microdiorite'), ('trondhjemite', 'trondhjemite'), ('dolerite', 'dolerite'),
    ('lave', 'lava'), ('volcan', 'volcanic rocks'), ('ortholeptynite', 'leptynite (fine gneiss)'), ('anatecti', 'anatexite'),
    ("formation d'alteration", 'weathered rock'), ('epandage', 'spread deposits'),
]

# chronostratigraphic stages (French names as BRGM writes them, accents removed) -> English name and epoch (ICS)
STAGES = {
    'holocene': ('Holocene', 'Quaternary'), 'pleistocene': ('Pleistocene', 'Quaternary'), 'wurm': ('Würm', 'Quaternary'),
    'riss': ('Riss', 'Quaternary'), 'mindel': ('Mindel', 'Quaternary'), 'villafranchien': ('Villafranchian', 'Pliocene–Pleistocene'),
    'pliocene': ('Pliocene', 'Neogene'), 'miocene': ('Miocene', 'Neogene'), 'messinien': ('Messinian', 'Miocene'),
    'tortonien': ('Tortonian', 'Miocene'), 'serravallien': ('Serravallian', 'Miocene'), 'langhien': ('Langhian', 'Miocene'),
    'burdigalien': ('Burdigalian', 'Miocene'), 'aquitanien': ('Aquitanian', 'Miocene'), 'oligocene': ('Oligocene', 'Paleogene'),
    'chattien': ('Chattian', 'Oligocene'), 'stampien': ('Stampian', 'Oligocene'), 'rupelien': ('Rupelian', 'Oligocene'),
    'sannoisien': ('Sannoisian', 'Oligocene'), 'eocene': ('Eocene', 'Paleogene'), 'ludien': ('Ludian', 'Eocene'),
    'priabonien': ('Priabonian', 'Eocene'), 'bartonien': ('Bartonian', 'Eocene'), 'lutetien': ('Lutetian', 'Eocene'),
    'ypresien': ('Ypresian', 'Eocene'), 'maastrichtien': ('Maastrichtian', 'Late Cretaceous'), 'campanien': ('Campanian', 'Late Cretaceous'),
    'santonien': ('Santonian', 'Late Cretaceous'), 'coniacien': ('Coniacian', 'Late Cretaceous'), 'turonien': ('Turonian', 'Late Cretaceous'),
    'cenomanien': ('Cenomanian', 'Late Cretaceous'), 'albien': ('Albian', 'Early Cretaceous'), 'aptien': ('Aptian', 'Early Cretaceous'),
    'barremien': ('Barremian', 'Early Cretaceous'), 'hauterivien': ('Hauterivian', 'Early Cretaceous'),
    'valanginien': ('Valanginian', 'Early Cretaceous'), 'berriasien': ('Berriasian', 'Early Cretaceous'),
    'tithonien': ('Tithonian', 'Late Jurassic'), 'portlandien': ('Portlandian', 'Late Jurassic'), 'kimmeridgien': ('Kimmeridgian', 'Late Jurassic'),
    'oxfordien': ('Oxfordian', 'Late Jurassic'), 'rauracien': ('Rauracian', 'Late Jurassic'), 'argovien': ('Argovian', 'Late Jurassic'),
    'sequanien': ('Sequanian', 'Late Jurassic'), 'callovien': ('Callovian', 'Middle Jurassic'), 'bathonien': ('Bathonian', 'Middle Jurassic'),
    'bajocien': ('Bajocian', 'Middle Jurassic'), 'aalenien': ('Aalenian', 'Middle Jurassic'), 'toarcien': ('Toarcian', 'Early Jurassic'),
    'domerien': ('Domerian', 'Early Jurassic'), 'carixien': ('Carixian', 'Early Jurassic'), 'pliensbachien': ('Pliensbachian', 'Early Jurassic'),
    'lotharingien': ('Lotharingian', 'Early Jurassic'), 'sinemurien': ('Sinemurian', 'Early Jurassic'), 'hettangien': ('Hettangian', 'Early Jurassic'),
    'rhetien': ('Rhaetian', 'Late Triassic'), 'norien': ('Norian', 'Late Triassic'), 'carnien': ('Carnian', 'Late Triassic'),
    'keuper': ('Keuper', 'Triassic'), 'muschelkalk': ('Muschelkalk', 'Triassic'), 'ladinien': ('Ladinian', 'Middle Triassic'),
    'anisien': ('Anisian', 'Middle Triassic'), 'trias': ('Triassic', 'Triassic'), 'autunien': ('Autunian', 'Early Permian'),
    'saxonien': ('Saxonian', 'Permian'), 'permien': ('Permian', 'Permian'), 'stephanien': ('Stephanian', 'Late Carboniferous'),
    'westphalien': ('Westphalian', 'Late Carboniferous'), 'namurien': ('Namurian', 'Carboniferous'), 'visean': ('Visean', 'Early Carboniferous'),
    'viseen': ('Visean', 'Early Carboniferous'), 'tournaisien': ('Tournaisian', 'Early Carboniferous'), 'dinantien': ('Dinantian', 'Early Carboniferous'),
    'carbonifere': ('Carboniferous', 'Carboniferous'), 'devonien': ('Devonian', 'Devonian'), 'silurien': ('Silurian', 'Silurian'),
    'ordovicien': ('Ordovician', 'Ordovician'), 'cambrien': ('Cambrian', 'Cambrian'), 'lias': ('Lias', 'Early Jurassic'),
}
NOTATION_ERA = [  # BRGM notation letters, used only when the description names no stage
    # only plain sedimentary notations; crystalline rocks use symbol-font notations that do not read reliably
    (r'^(Fz|Fy|Fx|Fw|Fv|E|C|LP|X|GP|Uy|COE)\d?[a-e]?(-[a-z]\d?)?$', 'Quaternary'), (r'^(OE|J)[v-z]', 'Quaternary'),
    (r'^j[1-4][a-dO]?(-j?[1-4][a-d]?)?$', 'Middle Jurassic'), (r'^j[5-9][a-c]?(-j?[5-9][a-c]?)?$', 'Late Jurassic'),
    (r'^l[1-6][a-c]?(-l?[1-6][a-c]?)?$', 'Early Jurassic'), (r'^n[1-7]', 'Early Cretaceous'), (r'^c[1-7]', 'Late Cretaceous'),
]
QUATERNARY_STEMS = ('wurm', 'würm', 'post-wurm', 'mindel', 'riss', 'gunz', 'günz', 'holocen', 'pleistocen', 'quaternaire')


def fold(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn').lower()


def gloss(descr):
    f = fold(descr); hits = []
    for stem, en in ROCKS:
        m = re.search(r'(?<![a-z])' + re.escape(stem), f)   # whole-word start: 'granite' not inside 'leucogranite'
        i = m.start() if m else -1
        if stem == 'quartz' and 'filon' not in f: continue
        if i >= 0 and en not in [h[1] for h in hits]:
            if stem == 'tuf' and ('tuf carbonate' in f or 'tuff carbonate' in f): continue
            if stem == 'calcaire' and any(h[1] in ('crinoidal limestone', 'oolitic limestone') for h in hits): continue
            if stem == 'calcaire oolithique' and 'limestone' in [h[1] for h in hits]: continue
            if stem in ('lac', 'etang') and not re.search(r"\b(lacs?|etangs?)\b", f): continue
            hits.append((i, en))
    hits.sort()
    words = [en for _, en in hits]
    if 'frost-shattered scree' in words and 'scree' in words: words.remove('scree')
    words = words[:3]
    return ', '.join(words)[:1].upper() + ', '.join(words)[1:] if words else ''


def age(descr, notation):
    if notation == 'Hydro': return ''
    f = fold(descr); found = []
    scan = re.sub(r'(?<![a-z])(ante|anti|post|infra)-[a-z]+', ' ', f.replace('mio-pliocene', 'miocene pliocene'))   # 'anté-dévonien' is not Devonian
    for m in re.finditer(r'[a-z]+', scan):
        w = m.group(0)
        if w in STAGES and STAGES[w] not in found: found.append(STAGES[w])
    if found:
        names = [s for s, _ in found]; epochs = []
        for _, e in found:
            if e not in epochs: epochs.append(e)
        stage = names[0] if len(names) == 1 else f'{names[0]}–{names[-1]}'
        epoch = epochs[0] if len(epochs) == 1 else f'{epochs[0]}–{epochs[-1]}'
        return stage if stage == epoch else f'{stage}, {epoch}'
    if any(re.search(r'(?<![a-z])' + q, f) for q in QUATERNARY_STEMS): return 'Quaternary'
    if not re.fullmatch(r'[A-Za-z0-9\-]+', notation or ''): return ''
    for pat, era in NOTATION_ERA:
        if re.match(pat, notation or ''): return era
    return ''


# ---- geometry -------------------------------------------------------------------------------------------------

def simplify(pts, tol):
    if len(pts) < 5: return pts
    keep = np.zeros(len(pts), bool); keep[0] = keep[-1] = True; stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1: continue
        seg = pts[b] - pts[a]; L = math.hypot(*seg); rel = pts[a + 1:b] - pts[a]
        d = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / L if L > 0 else np.hypot(rel[:, 0], rel[:, 1])
        i = int(np.argmax(d))
        if d[i] > tol: k = a + 1 + i; keep[k] = True; stack += [(a, k), (k, b)]
    return pts[keep]


def clip(ring, x0, y0, x1, y1):
    """Sutherland-Hodgman against an axis-aligned box (numpy, one edge at a time)."""
    p = ring
    for axis, val, keep_ge in ((0, x0, True), (0, x1, False), (1, y0, True), (1, y1, False)):
        if len(p) == 0: return p
        q = np.roll(p, -1, 0)
        ins_p = p[:, axis] >= val if keep_ge else p[:, axis] <= val
        ins_q = q[:, axis] >= val if keep_ge else q[:, axis] <= val
        out = []
        denom = q[:, axis] - p[:, axis]
        with np.errstate(divide='ignore', invalid='ignore'):
            t = np.where(denom != 0, (val - p[:, axis]) / denom, 0)
        inter = p + (q - p) * t[:, None]
        for i in range(len(p)):
            if ins_p[i]:
                out.append(p[i])
                if not ins_q[i]: out.append(inter[i])
            elif ins_q[i]: out.append(inter[i])
        p = np.array(out) if out else np.zeros((0, 2))
    return p


def ring_area(r):
    if len(r) < 3: return 0.0
    x, y = r[:, 0], r[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


# ---- build ----------------------------------------------------------------------------------------------------

def load_sources():
    units, unit_key, polys = [], {}, []
    zips = sorted(glob.glob(str(SRC / 'GEO050K_HARM_*.zip')))
    if not zips: sys.exit(f'no BD Charm-50 archives in {SRC}')
    for zp in zips:
        dep = re.search(r'HARM_(\w+)\.zip', zp).group(1)
        z = zipfile.ZipFile(zp)
        names = {n for n in z.namelist() if '_S_FGEOL_' in n}
        shp = next(n for n in names if n.lower().endswith('.shp')); dbf = next(n for n in names if n.lower().endswith('.dbf'))
        rows = read_dbf(z.read(dbf)); shapes = read_shp(z.read(shp))
        for row, sh in zip(rows, shapes):
            if sh is None: continue
            key = f"{dep}:{row.get('CODE_LEG') or row.get('CODE')}"
            if key not in unit_key:
                notation = row.get('NOTATION', '')
                descr = re.sub(r'\s+', ' ', row.get('DESCR', '')).strip().rstrip('.').strip()
                unit_key[key] = len(units)
                units.append({'id': key, 'notation': notation if re.fullmatch(r'[A-Za-z0-9\-\.]+', notation or '') else '',
                              'descr': descr, 'en': gloss(descr), 'age': age(descr, notation), 'colour': cmyk(row) or '#d9d4c7',
                              'water': row.get('NOTATION') == 'Hydro'})
            polys.append((sh[0], sh[1], unit_key[key]))
        print(f'{dep}: {len(shapes)} polygons', flush=True)
    bboxes = np.array([p[0] for p in polys])
    return units, polys, bboxes


def polygons_of(value):
    out = []
    def visit(v):
        if not isinstance(v, list) or not v: return
        if isinstance(v[0], list) and v[0] and isinstance(v[0][0], (int, float)): out.append([v]); return
        if isinstance(v[0], list) and v[0] and isinstance(v[0][0], list) and v[0][0] and isinstance(v[0][0][0], (int, float)): out.append(v); return
        for item in v: visit(item)
    visit(value)
    return out


def cut(polys, bboxes, box):
    x0, y0, x1, y1 = box
    sel = np.nonzero((bboxes[:, 0] < x1) & (bboxes[:, 2] > x0) & (bboxes[:, 1] < y1) & (bboxes[:, 3] > y0))[0]
    out = []
    for i in sel:
        _, rings, u = polys[i]
        parts = []
        for r in rings:
            # shapefile rings: outer rings run clockwise (negative signed area), holes anticlockwise
            hole = signed_area(r) > 0
            c = clip(simplify(r, SIMPLIFY), x0, y0, x1, y1)
            if len(c) >= 3 and ring_area(c) > 1: parts.append((c, hole))
        if any(not h for _, h in parts): out.append((u, parts))
    # largest first: a formation mapped inside another (in its hole) is drawn after it
    out.sort(key=lambda t: -max(ring_area(r) for r, h in t[1] if not h))
    return out


def signed_area(r):
    x, y = r[:, 0], r[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def scene_of(vid):
    raw = (SCENES / f'{vid}.json.gz').read_bytes()
    return json.loads(gzip.decompress(raw) if raw[:2] == bytes([0x1f, 0x8b]) else raw)


def village(vid, units, polys, bboxes):
    scene = scene_of(vid)
    b = [float(v) for v in scene['bounds']]
    b = (math.floor(b[0] / CELL) * CELL, math.floor(b[1] / CELL) * CELL, math.ceil(b[2] / CELL) * CELL, math.ceil(b[3] / CELL) * CELL)
    nx, ny = int((b[2] - b[0]) / CELL), int((b[3] - b[1]) / CELL)
    img = Image.new('I', (nx, ny), -1); d = ImageDraw.Draw(img)
    px = lambda r: [((x - b[0]) / CELL, (b[3] - y) / CELL) for x, y in r]
    for u, parts in cut(polys, bboxes, b):
        for r, hole in parts:
            if not hole: d.polygon(px(r), fill=u)
        for r, hole in parts:
            if hole: d.polygon(px(r), fill=-1)
    grid = np.array(img, np.int32)
    feats = [('parcels', f) for f in scene.get('parcels', [])] + [('climats', f) for f in scene.get('climats', [])]
    out = {}
    for layer, f in feats:
        ps = polygons_of(f.get('rings'))
        if not ps: continue
        m = Image.new('L', (nx, ny), 0); md = ImageDraw.Draw(m)
        for poly in ps:
            if len(poly[0]) >= 3: md.polygon(px(poly[0]), fill=1)
            for h in poly[1:]:
                if len(h) >= 3: md.polygon(px(h), fill=0)
        mask = np.array(m, bool)
        if not mask.any():
            x, y = ps[0][0][0][:2]; r, c = int((b[3] - y) / CELL), int((x - b[0]) / CELL)
            if 0 <= r < ny and 0 <= c < nx: mask[r, c] = True
            else: continue
        vals = grid[mask]; vals = vals[vals >= 0]
        if not len(vals): continue
        ids, counts = np.unique(vals, return_counts=True)
        order = np.argsort(-counts); total = counts.sum()
        shares = [[units[int(ids[i])]['id'], round(float(counts[i]) / total * 100)] for i in order if counts[i] / total * 100 >= MIN_SHARE][:4]
        if shares: out[f'{layer}:{f.get("id")}'] = shares
    return b, out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--only'); a = ap.parse_args()
    units, polys, bboxes = load_sources()
    ids = [a.only] if a.only else sorted(p.name[:-len('.json.gz')] for p in SCENES.glob('*.json.gz'))
    OUT.mkdir(parents=True, exist_ok=True); (OUT / 'tiles').mkdir(exist_ok=True)
    used, tiles = set(), set()
    for i, vid in enumerate(ids, 1):
        b, out = village(vid, units, polys, bboxes)
        for v in out.values(): used.update(u for u, _ in v)   # unit ids
        for tx in range(int(b[0] // TILE), int(b[2] // TILE) + 1):
            for ty in range(int(b[1] // TILE), int(b[3] // TILE) + 1): tiles.add((tx, ty))
        body = {'schemaVersion': 1, 'village': vid, 'source': SOURCE, 'features': out}
        (OUT / f'{vid}.json').write_text(json.dumps(body, separators=(',', ':')), 'utf8')
        print(f'{i}/{len(ids)} {vid} {len(out)}', flush=True)
    if a.only:  # keep the existing tiles and legend; just make sure this village's tiles exist
        legend_path = OUT / 'legend.json'
        if legend_path.exists():
            print('kept legend and tiles (run without --only to rebuild them)'); return
    for tx, ty in sorted(tiles):
        box = (tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE)
        cut_polys = cut(polys, bboxes, box)
        for u, _ in cut_polys: used.add(units[u]['id'])
        body = {'tile': [tx, ty], 'size': TILE,
                # [unit, [flat x,y ring, ...]]; drawn with the even-odd rule, so holes need no flag
                'polygons': [[units[u]['id'], [np.round(r).astype(int).ravel().tolist() for r, _ in parts]] for u, parts in cut_polys]}
        (OUT / 'tiles' / f'{tx}_{ty}.json').write_text(json.dumps(body, separators=(',', ':')), 'utf8')
    legend = {'schemaVersion': 1, 'source': SOURCE, 'sourceUrl': 'https://infoterre.brgm.fr/telechargements/BDCharm50/',
              'licence': 'Licence Ouverte / Open Licence 2.0 (Etalab)', 'tileSize': TILE,
              'tiles': sorted(f'{tx}_{ty}' for tx, ty in tiles),
              # keyed by BRGM département + legend code, so tiles and village files never depend on load order
              'units': {u['id']: {k: v for k, v in u.items() if k != 'id'} for u in units if u['id'] in used}}
    (OUT / 'legend.json').write_text(json.dumps(legend, ensure_ascii=False, separators=(',', ':')), 'utf8')
    print(f'{len(tiles)} tiles, {len(used)} formations used of {len(units)}')


if __name__ == '__main__':
    main()
