"""Audit full named-place identities before enriching their clipped scene copies.

Original GIS inputs are immutable. Areas use EPSG:2154, holes included. A name
match alone never assigns an AOC: >=98% of the full source polygon must be in
one uniquely matching official denomination. Scene fragments are not vineyards.
"""
import csv
import gzip
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd
from shapely import STRtree, make_valid
from shapely.ops import unary_union
from make_exclusive_parcels import source_geometry, atomic_gzip
from refine_aoc_interpretations import norm

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / 'website'
REPORT = ROOT / 'work/aoc-full-audit'
SOURCE = ROOT / 'burgundy_full/06_scope_extension/09_climats/bourgogne_maps_climats_lieuxdits_render_ready_epsg2154.gpkg'


def main():
    communes = json.loads(gzip.decompress((WEB / 'dist/data/communes.json.gz').read_bytes()))['communes']
    geometries = [source_geometry(c) for c in communes]
    tree = STRtree(geometries)
    official = {}
    aliases = defaultdict(set)
    for path in sorted((WEB / 'corrected-source-scenes').glob('*.json')):
        scene = json.loads(path.read_text('utf8'))
        for p in scene['parcels']:
            if p['classification'] not in ('grand-cru', 'premier-cru'):
                continue
            key = (str(p['idApp']), str(p['idDenom']))
            entry = official.setdefault(key, {'facts': p['aocVerification'], 'geometries': [], 'codes': set()})
            entry['geometries'].append(source_geometry(p))
            entry['codes'].add(str(p['insee']))
            name = norm(p['aocVerification']['officialDenomination'])
            names = {name, norm(p['name'])}
            names.update(re.split(r'\s+ou\s+', name))
            short = re.split(r'\s+(?:premier|1er|grand) cru\s+', name, maxsplit=1)
            if len(short) == 2:
                names.add(short[1])
            for alias in names:
                aliases[alias].add(key)
    print('Official identity references loaded', flush=True)
    canonical = {}
    rows = []
    for _, row in gpd.read_file(SOURCE).iterrows():
        key = (str(row.source_id), norm(row.nom))
        if key in canonical:
            raise ValueError(f'Duplicate source identity: {key}')
        geometry = make_valid(row.geometry)
        area = geometry.area
        if not area > 0:
            raise ValueError(f'Invalid source area: {key}')
        overlaps = []
        for i in tree.query(geometry):
            overlap = geometry.intersection(geometries[i]).area
            # Ignore tiny digitization slivers at commune boundaries.
            if overlap >= max(10, area * .001):
                overlaps.append((overlap, communes[i]['name'], communes[i]['code']))
        overlaps.sort(reverse=True)
        names = [x[1] for x in overlaps]
        codes = [x[2] for x in overlaps]
        matches = []
        for identity in aliases.get(norm(row.nom), ()):
            entry = official[identity]
            if 'geometry' not in entry:
                entry['geometry'] = unary_union(entry['geometries'])
            covered = geometry.intersection(entry['geometry']).area / area
            if covered >= .98:
                matches.append((identity, entry, covered))
        facts = {'identityAudit': 'full-source-v1', 'sourceFeatureId': str(row.source_id),
                 'mappedAreaM2': round(area, 4), 'mappedAreaStatus': 'available',
                 'mappedAreaScope': 'full-source-named-place',
                 'featureCommunes': names, 'featureCommuneCodes': codes,
                 'communeBasis': 'full source polygon intersected with commune boundaries; slivers below 0.1% or 10 m2 omitted',
                 'sourceUrl': row.source_endpoint,
                 'classificationStatus': 'unmatched' if not matches else 'ambiguous' if len(matches) > 1 else 'official-name-and-location-matched'}
        if len(matches) == 1:
            identity, entry, covered = matches[0]
            v = dict(entry['facts'])
            v.update(geometryScope='named-place-reference', physicalStatus='unverified',
                     verificationStatus='official-name-and-location-matched',
                     legalAreaM2=round(entry['geometry'].area, 2),
                     fullSourceCoveredFraction=round(covered, 6),
                     note='Name and full source polygon location match this official denomination. The primary area is the complete legal denomination, not this clipped display polygon or planted production area.')
            v.pop('physicalAreaM2', None)
            facts.update(aocVerification=v, classification='grand-cru' if v['officialTier'] == 'Grand Cru' else 'premier-cru')
            facts['mappedSourceCommunes'] = names
            facts['featureCommunes'] = [c['name'] for c in communes if c['code'] in entry['codes']]
            facts['featureCommuneCodes'] = sorted(entry['codes'])
            facts['communeBasis'] = 'communes of the matched full official denomination, not the current scene'
        elif matches and len({entry['facts']['officialTier'] for _, entry, _ in matches}) == 1:
            # Blagny red / Meursault or Puligny white eligibility can share a
            # named climat. Preserve every match rather than guessing one AOC.
            entries = [entry for _, entry, _ in matches]
            tier = entries[0]['facts']['officialTier']
            union = unary_union([entry['geometry'] for entry in entries])
            v = dict(entries[0]['facts'])
            appellations = sorted({e['facts']['officialAppellation'] for e in entries})
            denominations = sorted({e['facts']['officialDenomination'] for e in entries})
            v.update(officialAppellation=' / '.join(appellations), officialDenomination=' / '.join(denominations),
                     eligibleAppellations=appellations, geometryScope='named-place-reference', physicalStatus='unverified',
                     verificationStatus='shared-eligibility-name-and-location-matched',
                     legalAreaM2=round(union.area, 2), areaLabel='Full legal denominations · shared eligibility',
                     note='This name and full source location match multiple official denominations at the same tier. All matches are retained. Area is their geometric union; overlap is counted once.')
            v.pop('physicalAreaM2', None)
            facts.update(aocVerification=v, classification='grand-cru' if tier == 'Grand Cru' else 'premier-cru',
                         classificationStatus='shared-eligibility-name-and-location-matched')
        canonical[key] = facts
        rows.append({'sourceId': key[0], 'name': row.nom, 'areaM2': facts['mappedAreaM2'],
                     'communes': ' / '.join(facts['featureCommunes']), 'status': facts['classificationStatus'],
                     'officialDenomination': facts.get('aocVerification', {}).get('officialDenomination', '')})
    print(f'Canonical source identities audited: {len(canonical)}', flush=True)
    counts = Counter()
    failures = []
    for path in sorted((WEB / 'refined-source-scenes').glob('*.json')):
        source_scene = json.loads(path.read_text('utf8'))
        dist_path = WEB / 'dist/data/scenes' / (path.name + '.gz')
        previous = gzip.decompress(dist_path.read_bytes())
        served = json.loads(previous)
        for scene in (source_scene, served):
            for c in scene.get('climats', []):
                key = (str(c['id']), norm(c.get('name')))
                facts = canonical.get(key)
                if facts is None:
                    failures.append([path.name, key]); continue
                physical = c.get('aocVerification', {}).get('physicalStatus') == 'derived-supported'
                retained = c.get('aocVerification') if physical else None
                if scene is served:
                    counts['selectableNamedCopies'] += 1
                    if not c.get('aocVerification') and facts.get('aocVerification'):
                        counts['classificationRestored'] += 1
                    counts['areasAvailable'] += 1
                c.pop('aocVerification', None)
                c.pop('classification', None)
                c.update(facts)
                if retained:
                    c['aocVerification'] = retained
                    c['classification'] = 'grand-cru'
                v = c.get('aocVerification')
                if v:
                    c['aocVerification'] = {**v, 'displayAreaM2': round(source_geometry(c).area, 2)}
            for p in scene.get('parcels', []):
                identity = (str(p.get('idApp')), str(p.get('idDenom')))
                entry = official.get(identity)
                # AOC rows can span communes: use complete identity communes for GC/PC.
                codes = entry['codes'] if entry else {str(p.get('insee', ''))}
                codes = {{'71492': '71042', '69159': '69114'}.get(code, code) for code in codes}
                p['featureCommunes'] = [c['name'] for c in communes if c['code'] in codes]
                if entry and 'geometry' in entry:
                    p['aocVerification']['legalAreaM2'] = round(entry['geometry'].area, 2)
        path.write_text(json.dumps(source_scene, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
        output = json.dumps(served, ensure_ascii=False, separators=(',', ':')).encode('utf8')
        if output != previous:
            atomic_gzip(dist_path, output)
    if failures:
        raise ValueError(f'Unresolved scene identities: {failures[:20]}')
    with (REPORT / 'named-feature-identity-audit.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    report = {'sourceIdentities': len(canonical), **counts, 'statuses': dict(Counter(r['status'] for r in rows)),
              'missingCommuneIdentities': sum(not r['communes'] for r in rows),
              'source': str(SOURCE.relative_to(ROOT)), 'officialSnapshot': '2026-10-19',
              'method': __doc__, 'unresolvedSceneIdentities': failures}
    previous_report = REPORT / 'named-feature-identity-audit.json'
    if previous_report.exists():
        report['classificationRestored'] = max(report.get('classificationRestored', 0), json.loads(previous_report.read_text('utf8')).get('classificationRestored', 0))
    (REPORT / 'named-feature-identity-audit.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
