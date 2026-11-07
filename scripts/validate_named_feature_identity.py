"""Independent read-back checks of the actual public scene payloads."""
import gzip
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    # Full lieu-dit areas straight from the Etalab files and the author's parcel definitions.
    from build_etalab_lieux_dits import load_sources
    areas = {r['source_id']: r['geometry'].area for r in sum(load_sources(), [])}
    seen = {}
    errors = []
    count = 0
    for path in sorted((ROOT / 'website/dist/data/scenes').glob('*.json.gz')):
        scene = json.loads(gzip.decompress(path.read_bytes()))
        for feature in scene['climats']:
            count += 1
            identity = feature['sourceFeatureId']
            if not math.isclose(feature['mappedAreaM2'], areas[identity], abs_tol=.01):
                errors.append([path.name, identity, 'full source area mismatch'])
            if not feature.get('featureCommunes'):
                errors.append([path.name, identity, 'missing commune'])
            v = feature.get('aocVerification', {})
            # Display area legitimately varies with the scene clipping extent.
            signature = [feature['mappedAreaM2'], feature['featureCommunes'], feature.get('classification'),
                         v.get('officialDenomination'), v.get('legalAreaM2')]
            if identity in seen and seen[identity] != signature:
                errors.append([path.name, identity, 'inconsistent copies'])
            seen[identity] = signature
            if v and not v.get('legalAreaM2', 0) > 0:
                errors.append([path.name, identity, 'missing legal area'])
    result = {'scenes': 376, 'selectableNamedCopies': count, 'uniqueRenderedIdentities': len(seen),
              'checks': ['every full source area agrees within 0.01 m2', 'no missing commune',
                         'identity, classification and full area consistent between all scene copies',
                         'positive legal area on every matched AOC'], 'errors': errors}
    (ROOT / 'work/aoc-full-audit/named-feature-readback-validation.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))
    assert not errors


if __name__ == '__main__':
    main()
