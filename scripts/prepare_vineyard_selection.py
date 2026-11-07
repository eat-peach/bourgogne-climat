"""Prepare legal selection outlines without replacing the full lieu-dit layer.

Vosne village-place identities are checked against the BIVB's explicit list,
not inferred from a commune name or the largest polygon overlap. Other spatial
identities are used only when one highest-tier AOC covers >=98% of the place.
"""
import gzip
import json
from collections import defaultdict
from pathlib import Path
import geopandas as gpd
from shapely import STRtree, make_valid
from shapely.geometry import box
from shapely.ops import unary_union
from make_exclusive_parcels import source_geometry, as_rings, atomic_gzip
from refine_aoc_interpretations import norm

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / 'website'
OFFICIAL = ROOT / 'work/reference-audit/official/2026-10-19-extracted/2026-10-19_delim-parcellaire-aoc-shp.shp'
SOURCE = ROOT / 'burgundy_full/06_scope_extension/09_climats/bourgogne_maps_climats_lieuxdits_render_ready_epsg2154.gpkg'
BIVB = 'https://www.vins-bourgogne.fr/vins-et-terroirs/la-bourgogne-et-ses-appellations/vosne-romanee%2C2377%2C9170.html?args=Y29tcF9pZD0yMjA1JmFjdGlvbj12aWV3RmljaGUmaWQ9NDA4Jnw%3D'
VOSNE_NAMES = '''Au-Dessus de la Rivière|Aux Champs Perdrix|Aux Communes|Aux Genaivrières|Aux Jachées|Aux Ormes|Aux Raviolles|Aux Réas|Aux Saules|Bossières|Champs Goudins|La Colombière|La Croix Blanche|La Montagne|Le Pré de la Folie|Les Barreaux|Les Beaux Monts Hauts Rougeots|Les Chalandins|Les Damaudes|Les Jacquines|Les Violettes|Maizières Basses|Maizières Hautes|Porte-Feuilles|Murailles du Clos|Vigneux|Village'''.split('|')
RANK = {'Grand Cru':4, 'Premier Cru':3, 'Village':2, 'Beaujolais Cru':2, 'Regional':1}


def main():
    original = gpd.read_file(SOURCE)
    places = {str(r.source_id):r for r in original.itertuples(index=False)}
    raw = gpd.read_file(OFFICIAL)
    rows = list(raw.itertuples(index=False))
    geoms = [r.geometry if r.geometry.is_valid else make_valid(r.geometry) for r in rows]
    tree = STRtree(geoms)
    samples = {}
    for path in sorted((WEB / 'refined-source-scenes').glob('*.json')):
        for c in json.loads(path.read_text('utf8'))['climats']:
            samples.setdefault(str(c['id']), c)
    names = {norm(n): n for n in VOSNE_NAMES}
    derived, reference_ids = {}, []
    for identity, sample in samples.items():
        row = places[identity]
        full = row.geometry
        v = sample.get('aocVerification') or {}
        if v.get('physicalStatus') == 'derived-supported':
            continue
        matches = sample.get('spatialAocEligibility', {}).get('matches', [])
        ref = None
        if str(row.inventory_insee) in ('21714','21267') and norm(row.nom) in names:
            if any(m['appellation']=='Vosne-Romanée' and m['coverageFraction'] > .01 for m in matches):
                ref = {'verificationStatus':'official-named-place-listed', 'officialAppellation':'Vosne-Romanée',
                       'officialTier':'Village', 'nameAsListed':names[norm(row.nom)], 'sourceUrl':BIVB, 'checkedOn':'2026-10-24'}
                reference_ids.append(identity)
        if v:
            denominations = set(v.get('officialDenomination','').split(' / '))
            # A verified named denomination uses the complete official area.
            parts = [g for r,g in zip(rows,geoms) if r.denom in denominations]
            if parts:
                derived[identity] = {'geometry':unary_union(parts), 'fullLegalDenomination':True}
            continue
        if ref:
            chosen = [m for m in matches if m['appellation']=='Vosne-Romanée' and m['denomination']=='Vosne-Romanée']
        else:
            covered = [m for m in matches if m['coverageFraction'] >= .98]
            highest = max((RANK.get(m['tier'],0) for m in covered), default=0)
            chosen = [m for m in covered if RANK.get(m['tier'],0)==highest]
            if len({m['appellation'] for m in chosen}) != 1:
                continue
        keys = {(m['appellation'],m['denomination']) for m in chosen}
        intersections = [full.intersection(geoms[int(i)]) for i in tree.query(full)
                         if (rows[int(i)].app,rows[int(i)].denom) in keys]
        if not intersections:
            continue
        geometry = unary_union(intersections)
        if geometry.is_empty:
            continue
        derived[identity] = {'geometry':geometry, 'aocDelimitedAreaM2':round(geometry.area,2)}
        if ref:
            derived[identity]['aocIdentityReference'] = ref
    changed, copies = 0, 0
    for path in sorted((WEB / 'refined-source-scenes').glob('*.json')):
        dist_path = WEB / 'dist/data/scenes' / (path.name+'.gz')
        scene = json.loads(path.read_text('utf8'))
        old_dist = gzip.decompress(dist_path.read_bytes())
        served = json.loads(old_dist)
        for payload in (scene,served):
            for c in payload['climats']:
                data = derived.get(str(c['id']))
                if data is None:
                    continue
                if 'aocIdentityReference' in data:
                    c['aocIdentityReference'] = data['aocIdentityReference']
                if 'aocDelimitedAreaM2' in data:
                    c['aocDelimitedAreaM2'] = data['aocDelimitedAreaM2']
                clipped = data['geometry'].intersection(box(*payload['bounds']))
                c['aocSelectionRings'] = as_rings(clipped)
                if payload is served:
                    copies += 1
        scene_bytes = json.dumps(scene,ensure_ascii=False,separators=(',',':')).encode('utf8')
        if scene_bytes != path.read_bytes():
            path.write_bytes(scene_bytes)
        output = json.dumps(served,ensure_ascii=False,separators=(',',':')).encode('utf8')
        if output != old_dist:
            atomic_gzip(dist_path,output); changed += 1
    report = {'derivedSelectionIdentities':len(derived), 'annotatedCopies':copies, 'changedScenes':changed,
              'bivbNamedPlaceReferences':len(reference_ids), 'referenceIds':reference_ids,
              'sourceUrl':BIVB, 'officialSnapshot':'2026-10-19', 'method':__doc__}
    (ROOT / 'work/aoc-full-audit/vineyard-selection-preparation.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report,ensure_ascii=True))


if __name__=='__main__':
    main()
