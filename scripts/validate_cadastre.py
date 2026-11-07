"""Validate the compact cadastral export without network or GIS dependencies."""
import gzip
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
directory = ROOT / 'dist/data/cadastre'
manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
index = json.loads((ROOT / 'dist/data/index.json').read_text(encoding='utf-8'))
expected = {str(v['id']).rsplit('-', 1)[-1] for v in index['villages']}
assert set(manifest['communes']) == expected, 'Commune coverage mismatch'
total = 0
for code, entry in manifest['communes'].items():
    with gzip.open(directory / f'{code}.json.gz', 'rt', encoding='utf-8') as stream:
        payload = json.load(stream)
    assert payload['communeCode'] == code
    assert payload['crs'] == 'EPSG:2154'
    assert payload['sourceDate'] == manifest['release'] == entry['sourceDate']
    assert payload['sourceUrl'] == entry['sourceUrl']
    parcels = payload['parcels']
    assert len(parcels) == entry['parcelCount'] == payload['validation']['sourceFeatureCount']
    assert payload['validation']['skippedFeatureCount'] == 0
    assert len({p['id'] for p in parcels}) == len(parcels)
    for parcel in parcels:
        assert parcel['communeCode'] == code
        bounds = parcel['bounds']
        assert len(bounds) == 4 and all(math.isfinite(v) for v in bounds)
        assert bounds[0] <= bounds[2] and bounds[1] <= bounds[3]
        assert parcel['mappedAreaM2'] >= 0
        for polygon in parcel['rings']:
            assert polygon
            for ring in polygon:
                assert len(ring) >= 4 and ring[0] == ring[-1]
                for point in ring:
                    assert len(point) == 2 and all(math.isfinite(v) for v in point)
                    assert bounds[0] - .01 <= point[0] <= bounds[2] + .01
                    assert bounds[1] - .01 <= point[1] <= bounds[3] + .01
    total += len(parcels)
report = {'release': manifest['release'], 'communes': len(expected), 'parcels': total,
          'skipped': 0, 'result': 'passed',
          'checks': ['coverage', 'source counts', 'release and URLs', 'unique IDs per commune',
                     'finite projected coordinates', 'closed rings', 'geometry bounds']}
destination = ROOT / 'work/cadastre-validation.json'
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
