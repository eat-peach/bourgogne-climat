"""Attach spatial AOC coverage to full-source lieu-dit polygons.

The source climat polygons and corrected legal parcel scenes are read-only inputs.
Only refined scenes and their served gzip copies are updated.  Coverage is the
intersection of the complete original polygon with the union of official legal
boundaries for each (idApp, idDenom), divided by the complete original area.
This is spatial eligibility evidence and never replaces a direct named identity.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import tempfile
import sys
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd
from shapely import make_valid
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from make_exclusive_parcels import source_geometry
from refine_aoc_interpretations import norm

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "website"
SOURCE = ROOT / "burgundy_full/06_scope_extension/09_climats/bourgogne_maps_climats_lieuxdits_render_ready_epsg2154.gpkg"
SNAPSHOT = "2026-10-19"
SOURCE_URL = "https://www.data.gouv.fr/datasets/delimitation-parcellaire-des-aoc-viticoles-de-linao"
FULL_THRESHOLD = 0.98
MIN_OVERLAP_M2 = 10.0
MIN_COVERAGE = 0.001


def polygonal(value):
    if value is None or value.is_empty:
        return GeometryCollection()
    try:
        value = make_valid(value)
    except Exception:
        value = value.buffer(0)
    if isinstance(value, (Polygon, MultiPolygon)):
        return value
    parts = [polygonal(g) for g in getattr(value, "geoms", ())]
    return unary_union([g for g in parts if not g.is_empty]) if parts else GeometryCollection()


def atomic_gzip(path: Path, payload: bytes) -> None:
    fd, temporary = tempfile.mkstemp(prefix=path.stem, suffix=".tmp", dir=path.parent)
    os.close(fd)
    try:
        with open(temporary, "wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=9, mtime=0) as out:
            out.write(payload)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_official() -> tuple[list[dict], Counter]:
    rows_out: list[dict] = []
    rows = 0
    for path in sorted((WEB / "corrected-source-scenes").glob("*.json")):
        scene = json.loads(path.read_text(encoding="utf-8"))
        for parcel in scene.get("parcels", []):
            app = str(parcel.get("officialAppellation") or parcel.get("appellation") or "")
            denom = str(parcel.get("officialDenomination") or parcel.get("name") or app)
            key = (str(parcel.get("idApp") or ""), str(parcel.get("idDenom") or ""))
            if not key[0] or not key[1]:
                continue
            geom = polygonal(source_geometry(parcel))
            if geom.is_empty or geom.area <= 0:
                continue
            rows += 1
            rows_out.append({"key": key, "appellation": app, "denomination": denom, "tier": None, "sourceUrl": None, "geometry": geom})
            entry = rows_out[-1]
            av = parcel.get("aocVerification") or {}
            entry["tier"] = entry["tier"] or av.get("officialTier") or parcel.get("officialTier")
            entry["sourceUrl"] = entry["sourceUrl"] or av.get("sourceUrl") or parcel.get("sourceUrl")
    identities = {entry["key"] for entry in rows_out}
    return rows_out, Counter(rows=rows, identities=len(identities))


def build_matches(official: list[dict], source_frame) -> tuple[dict[tuple[str, str], dict], Counter]:
    tree = STRtree([e["geometry"] for e in official])
    by_identity: dict[tuple[str, str], dict] = {}
    stats = Counter()
    for ordinal, row in enumerate(source_frame.itertuples(index=False), 1):
        key = (str(row.source_id), str(row.nom))
        geom = polygonal(row.geometry)
        area = float(geom.area)
        if area <= 0:
            continue
        grouped: dict[tuple[str, str], dict] = {}
        for idx in tree.query(geom):
            entry = official[int(idx)]
            intersection = geom.intersection(entry["geometry"])
            overlap = float(intersection.area)
            if overlap <= 0:
                continue
            fraction = overlap / area
            target = grouped.setdefault(entry["key"], {"key": entry["key"], "appellation": entry["appellation"], "denomination": entry["denomination"], "tier": entry["tier"], "intersectionAreaM2": 0.0, "geometries": []})
            target["intersectionAreaM2"] += overlap
            target["geometries"].append(intersection)
        matches = []
        for target in grouped.values():
            # Union only the local intersections for this source polygon and
            # official identity; this avoids intersecting every polygon with
            # a country-scale regional union.
            intersection = polygonal(unary_union(target.pop("geometries")))
            overlap = float(intersection.area)
            fraction = overlap / area
            if overlap < max(MIN_OVERLAP_M2, area * MIN_COVERAGE):
                continue
            target.update({"coverageFraction": round(fraction, 6), "intersectionAreaM2": round(overlap, 2), "areaM2": round(overlap, 2)})
            target.pop("key", None)
            matches.append(target)
        matches.sort(key=lambda item: (-item["coverageFraction"], item["appellation"], item["denomination"]))
        status = "no-overlap" if not matches else "spatial-full-coverage" if any(m["coverageFraction"] >= FULL_THRESHOLD for m in matches) else "spatial-partial-coverage"
        if status == "no-overlap": stats["noSourceMatch"] += 1
        elif status == "spatial-full-coverage": stats["fullCovered"] += 1
        else: stats["partialCovered"] += 1
        by_identity[key] = {"status": status, "matches": matches, "mappedAreaM2": round(area, 2)}
        if ordinal % 500 == 0:
            print(json.dumps({"stage": "source-polygons", "processed": ordinal, "total": len(source_frame)}, ensure_ascii=False), flush=True)
    return by_identity, stats


def attach() -> dict:
    report_dir = ROOT / 'work/aoc-full-audit'
    source_frame = gpd.read_file(SOURCE)
    if '--reuse-computed' in sys.argv:
        cache = report_dir / 'spatial-aoc-source-results.json'
        inputs = [SOURCE, *list((WEB / 'corrected-source-scenes').glob('*.json'))]
        assert cache.stat().st_mtime >= max(p.stat().st_mtime for p in inputs), 'Spatial cache predates an input'
        previous_report = json.loads((report_dir / 'spatial-aoc-coverage-audit.json').read_text('utf8'))
        assert previous_report['snapshot'] == SNAPSHOT
        spatial = {(r['sourceId'], r['name']): {k:v for k,v in r.items() if k not in ('sourceId','name')}
                   for r in json.loads(cache.read_text('utf8'))}
        stats = Counter({'fullCovered':sum(r['status']=='spatial-full-coverage' for r in spatial.values()),
                         'partialCovered':sum(r['status']=='spatial-partial-coverage' for r in spatial.values()),
                         'noSourceMatch':sum(r['status']=='no-overlap' for r in spatial.values())})
        official_stats = {'rows':previous_report['officialParcelRows'], 'identities':previous_report['officialIdentities']}
    else:
        print('Loading official legal rows', flush=True)
        official, official_stats = load_official()
        print(json.dumps({'stage':'official-loaded', **official_stats}), flush=True)
        spatial, stats = build_matches(official, source_frame)
    (report_dir / 'spatial-aoc-source-results.json').write_text(json.dumps([
        {'sourceId':key[0], 'name':key[1], **value} for key,value in spatial.items()
    ], ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    print(json.dumps({'stage':'coverage-computed', **stats}), flush=True)
    direct = Counter()
    updated = 0
    for path in sorted((WEB / "refined-source-scenes").glob("*.json")):
        scene = json.loads(path.read_text(encoding="utf-8"))
        for climat in scene.get("climats", []):
            key = (str(climat.get("id") or ""), str(climat.get("name") or ""))
            audit = climat.get("aocVerification") or {}
            direct_status = str(audit.get("verificationStatus") or "")
            if direct_status in {"official-name-and-location-matched", "shared-eligibility-name-and-location-matched"}:
                direct[direct_status] += 1
            result = spatial.get(key)
            if result is None:
                continue
            climat["spatialAocEligibility"] = {
                "basis": "full-source-polygon", "sourceUrl": SOURCE_URL, "snapshot": SNAPSHOT,
                "threshold": {"fullCoverageFraction": FULL_THRESHOLD, "minimumOverlapM2": MIN_OVERLAP_M2, "minimumCoverageFraction": MIN_COVERAGE},
                "mappedAreaM2": result["mappedAreaM2"], "status": result["status"], "matches": result["matches"],
            }
            updated += 1
        path.write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        dist_path = WEB / "dist/data/scenes" / (path.name + ".gz")
        if not dist_path.exists():
            continue
        served = json.loads(gzip.decompress(dist_path.read_bytes()))
        changed = False
        for climat in served.get("climats", []):
            key = (str(climat.get("id") or ""), str(climat.get("name") or ""))
            audit = climat.get("aocVerification") or {}
            direct_status = str(audit.get("verificationStatus") or "")
            result = spatial.get(key)
            if result is None:
                continue
            value = {"basis": "full-source-polygon", "sourceUrl": SOURCE_URL, "snapshot": SNAPSHOT,
                     "threshold": {"fullCoverageFraction": FULL_THRESHOLD, "minimumOverlapM2": MIN_OVERLAP_M2, "minimumCoverageFraction": MIN_COVERAGE},
                     "mappedAreaM2": result["mappedAreaM2"], "status": result["status"], "matches": result["matches"]}
            if climat.get("spatialAocEligibility") != value:
                climat["spatialAocEligibility"] = value
                changed = True
        if changed:
            atomic_gzip(dist_path, json.dumps(served, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    report = {"sourcePolygons": len(source_frame), "officialParcelRows": official_stats["rows"], "officialIdentities": official_stats["identities"], "updatedClimats": updated, "directMatches": dict(direct), **stats,
              'snapshot':SNAPSHOT, 'method':__doc__, 'communeAndAocIndependent':True}
    (report_dir / 'spatial-aoc-coverage-audit.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    return report


if __name__ == "__main__":
    print(json.dumps(attach(), ensure_ascii=False, sort_keys=True))
