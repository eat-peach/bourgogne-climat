"""Read back all public metadata; independently sample the original INAO SHP."""
import gzip
import json
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / 'work/aoc-full-audit'
OFFICIAL = ROOT / 'work/reference-audit/official/2026-10-19-extracted/2026-10-19_delim-parcellaire-aoc-shp.shp'


def main():
    expected = {str(r['sourceId']): r for r in json.loads((REPORT / 'spatial-aoc-source-results.json').read_text('utf8'))}
    errors, seen = [], {}
    copies, direct = 0, set()
    paths = list((ROOT / 'website/dist/data/scenes').glob('*.json.gz'))
    for path in paths:
        scene = json.loads(gzip.decompress(path.read_bytes()))
        for c in scene['climats']:
            copies += 1
            identity = str(c['id'])
            spatial = c.get('spatialAocEligibility')
            if not spatial:
                errors.append([path.name, identity, 'missing coverage check']); continue
            e = expected[identity]
            if spatial['status'] != e['status'] or spatial['matches'] != e['matches']:
                errors.append([path.name, identity, 'does not match full-source result'])
            if identity in seen and seen[identity] != spatial:
                errors.append([path.name, identity, 'inconsistent scene copies'])
            seen[identity] = spatial
            if c.get('aocVerification'):
                direct.add(identity)
            for match in spatial['matches']:
                fraction = match['coverageFraction']
                if not 0 < fraction <= 1.000001:
                    errors.append([path.name, identity, 'invalid coverage fraction'])
                if abs(match['intersectionAreaM2'] - fraction * spatial['mappedAreaM2']) > spatial['mappedAreaM2'] * .000001 + .03:
                    errors.append([path.name, identity, 'inconsistent area and fraction'])
    from build_etalab_lieux_dits import load_sources
    sources = {r['source_id']: r for r in sum(load_sources(), [])}
    independent = []
    # A spread of grand cru, premier cru, village and partial-coverage lieux-dits, plus one author sub-climat.
    for identity in ['21714:aux-communes', '21714:la-tache', '21133:les-bonnes-mares', '21412:les-santenots-du-milieu',
                     '21295:la-justice', '71416:atlas:les-crays-de-boye', '89068:les-clos']:
        if identity not in sources or identity not in expected:
            errors.append([identity, 'sample lieu-dit missing from the source or results']); continue
        row = sources[identity]
        geom = row['geometry']
        raw = gpd.read_file(OFFICIAL, bbox=geom.bounds)
        groups = defaultdict(list)
        for item in raw.itertuples(index=False):
            intersection = geom.intersection(item.geometry)
            if not intersection.is_empty:
                groups[(item.app, item.denom)].append(intersection)
        actual = {key: unary_union(parts).area for key, parts in groups.items()}
        checked = 0
        for match in expected[identity]['matches']:
            area = actual.get((match['appellation'], match['denomination']), 0)
            if abs(area - match['intersectionAreaM2']) > max(10, geom.area * .001):
                errors.append([identity, match['denomination'], 'original INAO geometry differs above 0.1%/10m2 tolerance'])
            checked += 1
        if expected[identity]['status'] == 'no-overlap' and any(area >= max(10, geom.area * .001) for area in actual.values()):
            errors.append([identity, 'no-overlap contradicted by original INAO source'])
        independent.append({'sourceId':identity, 'name':row['nom'], 'officialMatchesChecked':checked,
                            'status':expected[identity]['status']})
    report = {'scenes':len(paths), 'selectableCopies':copies, 'uniqueRenderedPlaces':len(seen),
              'directIdentityPlaces':len(direct), 'renderedCoverageStatuses':dict(Counter(x['status'] for x in seen.values())),
              'originalInaoShapefileSamples':independent, 'errors':errors}
    (REPORT / 'spatial-aoc-readback-validation.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf8')
    print(json.dumps(report, ensure_ascii=True))
    assert not errors, errors[:10]


if __name__ == '__main__':
    main()
