"""Independently reconcile published ownership payloads with raw DGFiP columns."""
import csv, gzip, json
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parents[2]
directory = ROOT / 'website/dist/data/ownership'
manifest = json.loads((directory / 'manifest.json').read_text('utf8'))
actual = {}
for code in manifest['communes']:
    with gzip.open(directory / f'{code}.json.gz', 'rt', encoding='utf8') as stream:
        payload = json.load(stream)
    assert payload['communeCode'] == code
    for ident, holders in payload['parcels'].items():
        assert len(ident) == 14
        actual[ident] = {tuple(h.get(k, '') for k in ('entityName', 'siren', 'rightsCode', 'rightsLabel')) for h in holders}

expected = defaultdict(set)
rows = 0
for path in sorted((ROOT / 'work/ownership/raw-2025').glob('*.csv')):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        for r in csv.DictReader(stream, delimiter=';'):
            rows += 1
            ident = (r['Département'].strip().zfill(2) + r['Code Commune'].strip().zfill(3)
                     + r['Préfixe'].strip().zfill(3) + r['Section'].strip().zfill(2)
                     + r['N° plan'].strip().zfill(4))
            if ident not in actual:
                continue
            rights = r['Code droit - par'].strip().partition('-')
            expected[ident].add((r['Dénomination - par'].strip(), r['N° SIREN - par'].strip(), rights[0].strip(), rights[2].strip()))
errors = [ident for ident in actual if actual[ident] != expected[ident]]
report = {'sourceAsOf': manifest['sourceAsOf'], 'communes': len(manifest['communes']),
          'rawRowsRead': rows, 'matchedParcels': len(actual), 'holderRecords': sum(map(len, actual.values())),
          'mismatchCount': len(errors), 'mismatches': errors[:20],
          'method': 'Independent named-column parser; exact cadastral ID and full legal-entity/right tuples; all published matches compared',
          'status': 'pass' if not errors and len(actual) == 222908 else 'fail'}
(ROOT / 'work/ownership/validation.json').write_text(json.dumps(report, indent=2), encoding='utf8')
print(json.dumps(report))
assert report['status'] == 'pass'
