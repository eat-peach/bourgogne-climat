"""Attach conservative name/location references without certifying climat geometry."""
import gzip, json, re, sys
from pathlib import Path
from collections import defaultdict
from shapely.ops import unary_union
from make_exclusive_parcels import source_geometry, atomic_gzip
from refine_aoc_interpretations import norm

ROOT = Path(__file__).resolve().parents[2]
by_name = defaultdict(dict)
for path in (ROOT / 'website/corrected-source-scenes').glob('*.json'):
    for p in json.loads(path.read_text('utf8'))['parcels']:
        if p['classification'] not in ('grand-cru', 'premier-cru'):
            continue
        v = p['aocVerification']; name = norm(v['officialDenomination'])
        names = {name}
        short = re.split(r'\s+(?:premier|1er) cru\s+', name, maxsplit=1)
        if len(short) == 2:
            names.add(short[1])
        identity = (p['idApp'], p['idDenom'])
        for alias in names:
            entry = by_name[alias].setdefault(identity, {'facts': v, 'geometries': []})
            entry['geometries'].append(source_geometry(p))

updated = 0
for path in (ROOT / 'website/refined-source-scenes').glob('*.json'):
    scene = json.loads(path.read_text('utf8')); changed = False
    for c in scene.get('climats', []):
        if c.get('aocVerification'):
            continue
        candidates = by_name.get(norm(c.get('name')), {})
        if not candidates:
            continue
        geometry = source_geometry(c)
        if geometry is None or geometry.is_empty or geometry.area <= 0:
            continue
        matches = []
        for entry in candidates.values():
            if 'union' not in entry:
                entry['union'] = unary_union([g for g in entry['geometries'] if g is not None])
            covered = geometry.intersection(entry['union']).area / geometry.area
            if covered >= .98:
                matches.append(entry)
        if len(matches) != 1:
            continue
        v = dict(matches[0]['facts'])
        v.update(geometryScope='named-place-reference', physicalStatus='unverified',
                 verificationStatus='official-name-and-location-matched', displayAreaM2=round(geometry.area, 2),
                 note='The name and location match this official denomination. This named-place polygon is not certified as its legal or physical boundary.')
        v.pop('physicalAreaM2', None)
        c['aocVerification'] = v
        c['classification'] = 'grand-cru' if v['officialTier'] == 'Grand Cru' else 'premier-cru'
        updated += 1; changed = True
    for group in ('parcels', 'climats'):
        for feature in scene.get(group, []):
            v = feature.get('aocVerification')
            if not v:
                continue
            note = v.get('note', '')
            clean = note.replace("DisplayAreaM2 is this feature's current scene fragment, not the full regional total.", 'The display area covers this mapped fragment.').replace('15.349 ha named-climat union', '15.3476 ha named-climat union')
            if clean != note:
                v['note'] = clean; changed = True
    if changed:
        path.write_text(json.dumps(scene, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
        dist = ROOT / 'website/dist/data/scenes' / (path.name + '.gz')
        payload = json.loads(gzip.decompress(dist.read_bytes()))
        payload['climats'] = scene['climats']
        for feature in payload.get('parcels', []):
            v = feature.get('aocVerification')
            if v:
                feature['displayAreaM2'] = v['displayAreaM2']
                v['note'] = v.get('note', '').replace("DisplayAreaM2 is this feature's current scene fragment, not the full regional total.", 'The display area covers this mapped fragment.').replace('15.349 ha named-climat union', '15.3476 ha named-climat union')
        atomic_gzip(dist, json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf8'))
report = {'updatedNamedPlaceReferences': updated, 'minimumCoveredFraction': .98,
          'method': 'Unique exact normalized denomination or Premier Cru suffix, and at least 98% polygon coverage by that official denomination',
          'physicalBoundariesCertified': False}
(ROOT / 'work/aoc-full-audit/climat-reference-validation.json').write_text(json.dumps(report, indent=2), encoding='utf8')
print(json.dumps(report))
