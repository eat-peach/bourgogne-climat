#!/usr/bin/env python3
"""Remove sub-centimetre overlay slivers from the existing display export.

Only display parcel geometry is changed. Source scenes remain immutable.
The 2 cm cartographic clearance prevents repeated GEOS overlays from leaving
tiny shared faces; it is far below the source/display map resolution.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import gzip
import json
from pathlib import Path
from shapely.geometry import GeometryCollection, Polygon, MultiPolygon
from shapely.ops import unary_union
from shapely.strtree import STRtree
import make_exclusive_parcels as base

CLEARANCE_M = 0.02

def read(path):
    return json.loads(gzip.decompress(path.read_bytes()))

def display_geometry(parcel):
    """Read canonical exported rings without repeatedly unioning valid parts."""
    polygons = [Polygon(part[0], part[1:]) for part in parcel.get('rings', []) if part]
    if not polygons:
        return None
    geometry = polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)
    return geometry if geometry.is_valid else base.polygonal(geometry)

def non_parcel_payload(scene):
    """Return scene metadata with annotation-only climat facts removed."""
    payload = {k: v for k, v in scene.items() if k not in ('parcels', 'displayClassification')}
    payload['climats'] = [
        {k: v for k, v in feature.items() if k not in ('factsKey', 'factsVillageId')}
        for feature in payload.get('climats', [])
    ]
    return payload

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('--source-dir', type=Path, default=base.SOURCE_SCENES,
                        help='scene directory corresponding to the export; defaults to raw source-scenes')
    args = parser.parse_args()
    base.SOURCE_SCENES = args.source_dir.resolve()
    paths = sorted(base.DIST_SCENES.glob('*.json.gz'))
    assert len(paths) == 376, len(paths)
    groups = defaultdict(list)
    for i, path in enumerate(paths, 1):
        for parcel in read(path).get('parcels', []):
            geometry = display_geometry(parcel)
            if geometry is not None:
                groups[base.classification(parcel)].append(geometry)
        if i % 100 == 0:
            print(f"Read {i}/376 display scenes", flush=True)
    print('Indexing individual source display polygons', flush=True)
    trees = {cls: STRtree(parts) for cls, parts in groups.items() if parts}
    final = defaultdict(list)
    changed_scenes = changed_parcels = empty = 0
    untouched_fields = True
    for i, path in enumerate(paths, 1):
        scene = read(path)
        source = json.loads((base.SOURCE_SCENES / path.name[:-3]).read_text(encoding='utf-8'))
        if non_parcel_payload(scene) != non_parcel_payload(source):
            untouched_fields = False
        output = []
        changed = False
        for parcel in scene.get('parcels', []):
            cls = base.classification(parcel)
            geometry = display_geometry(parcel)
            if geometry is None:
                raise ValueError(f'Empty parcel geometry: {path.name}')
            if not args.check_only:
                nearby = {}
                for higher in base.RANK[:base.RANK.index(cls)]:
                    if higher in trees:
                        for index in trees[higher].query(geometry, predicate='intersects'):
                            candidate = groups[higher][int(index)]
                            nearby[candidate.wkb] = candidate
                # Tiny faces repeated across scene copies can exceed the
                # aggregate audit tolerance, so repair every positive face.
                if nearby and any(geometry.intersection(candidate).area > 0 for candidate in nearby.values()):
                    # Apply each neighbouring mask directly. Unioning many
                    # touching masks can itself lose a microscopic face.
                    for candidate in nearby.values():
                        if geometry is None or geometry.is_empty:
                            break
                        guarded = candidate.buffer(CLEARANCE_M)
                        if geometry.intersects(guarded):
                            geometry = base.difference_geometry(geometry, guarded)
                    if geometry is None or not geometry.equals(display_geometry(parcel)):
                        changed = True
                        changed_parcels += 1
                        if geometry is None or geometry.is_empty:
                            empty += 1
                            continue
                        parcel['rings'] = base.as_rings(geometry)
                        area_m2 = round(float(geometry.area), 2)
                        parcel['displayAreaM2'] = area_m2
                        verification = parcel.get('aocVerification')
                        if isinstance(verification, dict):
                            verification['displayAreaM2'] = area_m2
                            verification['displayAreaScope'] = 'precision-cleared serialized display geometry'
            output.append(parcel)
            final[cls].append(display_geometry(parcel))
        if changed:
            scene['parcels'] = output
            scene['displayClassification']['precisionClearanceMetres'] = CLEARANCE_M
            base.atomic_gzip(path, json.dumps(scene, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))
            changed_scenes += 1
        if i % 50 == 0:
            print(f"Checked {i}/376 scenes; repaired {changed_parcels} parcels", flush=True)
    final_trees = {cls:STRtree(parts) for cls,parts in final.items() if parts}
    overlaps = {}
    # Compare actual individual polygons via spatial indexes. This avoids a
    # global union simplifying a tiny face away before it can be checked.
    for i, cls in enumerate(base.RANK):
        if cls not in final_trees:
            continue
        for lower in base.RANK[i+1:]:
            area = 0.0
            for g in final.get(lower, []):
                for index in final_trees[cls].query(g, predicate='intersects'):
                    area += g.intersection(final[cls][int(index)]).area
            overlaps[f'{cls} intersection {lower}'] = area
    positive = {k:v for k,v in overlaps.items() if v > base.PAIR_TOLERANCE_M2}
    report = {'sceneCount':len(paths), 'nonParcelFieldsUnchanged':untouched_fields,
              'changedScenes':changed_scenes, 'precisionRepairedParcels':changed_parcels,
              'emptyParcelsRemoved':empty, 'clearanceMetres':CLEARANCE_M,
              'interTierOverlapAreaUpperBoundsM2':overlaps, 'positiveOverlapUpperBoundsM2':positive,
              'parcelCounts':{c:len(final.get(c,[])) for c in base.RANK},
              'method':'actual serialized display geometry; direct spatial-indexed polygon intersections, including across scenes'}
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,indent=2),flush=True)
    if positive or not untouched_fields:
        raise SystemExit('Exclusive display geometry validation failed')

if __name__ == '__main__':
    main()
