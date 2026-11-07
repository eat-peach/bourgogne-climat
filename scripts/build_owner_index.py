"""Build data/ownership/owners.json.gz (the owner search index) from a site's existing per-commune ownership files.

build_parcel_ownership.py writes this index itself for Burgundy; this script makes it for a region whose ownership files
were built without it (e.g. dist/rhone). Names are cleaned with owner_names.py; areas are used when the files carry them.

Usage: python scripts/build_owner_index.py dist/rhone/data/ownership
"""
from __future__ import annotations
import gzip, json, sys
from collections import defaultdict
from pathlib import Path

from owner_names import display_name


def main(folder: Path):
    owners = {}
    as_of = ''
    for path in sorted(folder.glob('[0-9]*.json.gz')):
        payload = json.loads(gzip.decompress(path.read_bytes()))
        code = str(payload.get('communeCode') or path.name.split('.')[0]); as_of = payload.get('sourceAsOf') or as_of
        for ident, holders in (payload.get('parcels') or {}).items():
            for h in holders:
                name = h.get('displayName') or display_name(h.get('entityName', ''), h.get('legalForm', ''))
                key = h.get('siren') or h.get('entityName')
                entry = owners.setdefault(key, {'name': name, 'siren': h.get('siren', ''), 'form': h.get('legalForm', ''), 'area': 0, 'vines': 0, 'parcels': defaultdict(list)})
                if ident not in entry['parcels'][code]:
                    entry['parcels'][code].append(ident); area = int(h.get('areaM2') or 0); entry['area'] += area
                    if any(str(land).startswith('VI') for land in h.get('land') or []): entry['vines'] += area
    listed = sorted(owners.values(), key=lambda e: (-e['area'], -sum(len(v) for v in e['parcels'].values())))
    body = {'schemaVersion': 1, 'sourceAsOf': as_of, 'source': 'DGFiP personnes morales parcel release', 'fields': ['name', 'siren', 'legalForm', 'areaM2', 'vinesM2', 'parcelsByCommune'],
            'owners': [[e['name'], e['siren'], e['form'], e['area'], e['vines'], {c: ','.join(ids) for c, ids in e['parcels'].items()}] for e in listed]}
    (folder / 'owners.json.gz').write_bytes(gzip.compress(json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf8'), 9))
    print(folder / 'owners.json.gz', len(listed), 'owners')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
