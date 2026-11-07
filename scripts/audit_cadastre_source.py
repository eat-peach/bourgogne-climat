#!/usr/bin/env python3
"""Audit published cadastre exports against the pinned Etalab source release.

This is read-only with respect to the source and published data.  It compares
all parcel attributes, counts invalid source geometries for every feature, and
independently reprojects a deterministic sample with pyproj/shapely.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import sys
from collections import Counter
from pathlib import Path
from urllib.request import Request, urlopen

from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform as shapely_transform

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
RELEASE = "2026-09-01"
BASE = "https://cadastre.data.gouv.fr/data/etalab-cadastre/{release}/geojson/communes/{dept}/{code}/cadastre-{code}-parcelles.json.gz"
TRANSFORMER = Transformer.from_crs("EPSG:4326", "EPSG:2154", always_xy=True)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def raw_path(code: str, dept: str) -> Path:
    return PROJECT / "work" / "cadastre" / RELEASE / "geojson" / "communes" / dept / code / f"cadastre-{code}-parcelles.json.gz"


def source_url(code: str, dept: str) -> str:
    return BASE.format(release=RELEASE, code=code, dept=dept)


def download(url: str, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    req = Request(url, headers={"User-Agent": "burgundy-map-cadastre-audit/1.0"})
    with urlopen(req, timeout=90) as response, dst.open("wb") as out:
        while block := response.read(1024 * 1024):
            out.write(block)


def load_gz(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def sample_feature(code: str, feature_index: int, sample_mod: int) -> bool:
    # Stable across Python versions and process order; at least one feature per commune.
    return feature_index == 0 or ((feature_index * 1103515245 + int(code)) % sample_mod == 0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample-mod", type=int, default=100, help="sample one feature per N (plus first) for independent geometry checks")
    ap.add_argument("--fresh", action="store_true", help="download four named official files into the audit folder")
    args = ap.parse_args()
    if args.sample_mod < 1:
        raise SystemExit("--sample-mod must be positive")

    cad = ROOT / "dist" / "data" / "cadastre"
    manifest = json.loads((cad / "manifest.json").read_text(encoding="utf-8"))
    index = json.loads((ROOT / "dist" / "data" / "index.json").read_text(encoding="utf-8"))
    dept_by_code = {str(v["id"]).rsplit("-", 1)[-1]: str(v.get("department", "")) for v in index["villages"]}
    codes = sorted(manifest["communes"])
    result = {
        "release": RELEASE, "exportedCommunes": len(codes), "exportedParcels": 0,
        "sourceFeatureCount": 0, "attribute": {}, "geometry": {}, "areas": {},
        "freshOfficial": {}, "limitations": [
            "Independent geometry checks use a deterministic sample (first feature and every Nth feature; N is recorded below).",
            "This validates data lineage and geometry processing; it is not a ground survey, title search, ownership determination, or AOC validation.",
        ],
    }
    attr = Counter({"sectionMismatch": 0, "numberMismatch": 0, "contenanceMismatch": 0, "missingFromExport": 0, "extraInExport": 0, "duplicateSourceIds": 0}); geom = Counter({"sampleMappedAreaMismatch": 0, "sampleGeometryMismatch": 0, "sampleRepairFailed": 0, "sampleTransformErrors": 0}); area_deltas = []; notable = []; area_notable = []
    sample_n = 0; source_invalid = 0; source_empty = 0; source_errors = 0; total_cadastral = 0.0; total_mapped = 0.0; invalid_ids = []; invalid_effects = []
    for n, code in enumerate(codes, 1):
        dept = dept_by_code.get(code, code[:2])
        exp_path = cad / f"{code}.json.gz"
        source_path = raw_path(code, dept)
        exported = load_gz(exp_path)
        source = load_gz(source_path)
        ep = {str(p["id"]): p for p in exported.get("parcels", [])}
        sf = source.get("features", [])
        result["exportedParcels"] += len(ep); result["sourceFeatureCount"] += len(sf)
        ids = [str(f.get("id") or (f.get("properties") or {}).get("id") or "") for f in sf]
        source_ids = set(ids); export_ids = set(ep)
        attr["missingFromExport"] += len(source_ids - export_ids)
        attr["extraInExport"] += len(export_ids - source_ids)
        attr["duplicateSourceIds"] += len(ids) - len(source_ids)
        for i, f in enumerate(sf):
            fid = ids[i]; props = f.get("properties") or {}; p = ep.get(fid)
            if p is None: continue
            if str(props.get("section") or "") != str(p.get("section") or ""): attr["sectionMismatch"] += 1
            if str(props.get("numero") or "") != str(p.get("number") or ""): attr["numberMismatch"] += 1
            if props.get("contenance") != p.get("cadastralAreaM2"): attr["contenanceMismatch"] += 1
            g = f.get("geometry")
            if not g:
                source_empty += 1; continue
            try:
                geom0 = shape(g)
                if geom0.is_empty: source_empty += 1
                if not geom0.is_valid:
                    source_invalid += 1; invalid_ids.append({"commune": code, "id": fid})
                    projected0 = shapely_transform(TRANSFORMER.transform, geom0)
                    before = float(projected0.area)
                    repaired0 = projected0 if projected0.is_valid else projected0.buffer(0)
                    invalid_effects.append({"commune": code, "id": fid, "sourceAreaM2": round(before, 3), "repairedAreaM2": round(float(repaired0.area), 3), "repairSucceeded": bool(repaired0.is_valid and not repaired0.is_empty)})
                if sample_feature(code, i, args.sample_mod):
                    sample_n += 1
                    g2 = shapely_transform(TRANSFORMER.transform, geom0)
                    if g2.is_empty: geom["sampleEmpty"] += 1
                    if not g2.is_valid: geom["sampleInvalidAfterTransform"] += 1
                    repaired = g2 if g2.is_valid else g2.buffer(0)
                    if not repaired.is_valid or repaired.is_empty: geom["sampleRepairFailed"] += 1
                    expected_area = round(float(repaired.area), 2)
                    got_area = p.get("mappedAreaM2")
                    if got_area is None or abs(expected_area - float(got_area)) > 0.01:
                        geom["sampleMappedAreaMismatch"] += 1
                        if len(notable) < 20: notable.append({"commune": code, "id": fid, "expected": expected_area, "exported": got_area})
                    try:
                        rings = p.get("rings") or []
                        exported_geom = shape({"type": "Polygon", "coordinates": rings[0]}) if len(rings) == 1 else shape({"type": "MultiPolygon", "coordinates": rings})
                        symmetric_area = float(repaired.symmetric_difference(exported_geom).area)
                        if symmetric_area > 0.01 or not repaired.equals_exact(exported_geom, 1e-6):
                            geom["sampleGeometryMismatch"] += 1
                            if len(notable) < 20: notable.append({"commune": code, "id": fid, "symmetricDifferenceM2": round(symmetric_area, 6), "geometryEqualWithin1e-6": False})
                    except Exception:
                        geom["sampleGeometryMismatch"] += 1
                    if g2.geom_type not in {"Polygon", "MultiPolygon"}: geom["sampleUnsupportedType"] += 1
            except Exception as exc:
                source_errors += 1
                if sample_feature(code, i, args.sample_mod): geom["sampleTransformErrors"] += 1
            if isinstance(p.get("mappedAreaM2"), (int, float)) and isinstance(p.get("cadastralAreaM2"), (int, float)):
                delta = float(p["mappedAreaM2"]) - float(p["cadastralAreaM2"])
                area_deltas.append(delta)
                total_cadastral += float(p["cadastralAreaM2"])
                total_mapped += float(p["mappedAreaM2"])
                if abs(delta) >= 1000 and len(area_notable) < 20: area_notable.append({"commune": code, "id": fid, "cadastralM2": p["cadastralAreaM2"], "mappedM2": p["mappedAreaM2"], "deltaM2": round(delta, 2)})
        if n % 25 == 0: print(f"audited {n}/{len(codes)} communes", file=sys.stderr, flush=True)

    result["attribute"] = dict(attr)
    result["geometry"] = {"method": "pyproj Transformer EPSG:4326->EPSG:2154 + shapely", "sampleMod": args.sample_mod, "sampleFeatures": sample_n, "sourceInvalidFeatures": source_invalid, "sourceInvalidIds": invalid_ids, "sourceInvalidRepairEffects": invalid_effects, "sourceEmptyFeatures": source_empty, "sourceGeometryErrors": source_errors, **dict(geom), "notableGeometryDiscrepancies": notable[:20]}
    result["areas"]["notableRecordedVsMapped"] = area_notable
    if area_deltas:
        sa = sorted(area_deltas)
        result["areas"] = {"parcelCountWithBothAreas": len(area_deltas), "totalCadastralM2": round(total_cadastral, 2), "totalMappedM2": round(total_mapped, 2), "totalDeltaM2": round(sum(area_deltas), 2), "meanDeltaM2": round(sum(area_deltas) / len(area_deltas), 3), "minDeltaM2": round(sa[0], 2), "maxDeltaM2": round(sa[-1], 2), "absDeltaOver1000M2": sum(abs(x) >= 1000 for x in area_deltas)}

    if args.fresh:
        fresh_root = PROJECT / "work" / "cadastre-source-audit-fresh"
        for code, dept in [("21295", "21"), ("21133", "21"), ("21714", "21"), ("89068", "89")]:
            dst = fresh_root / dept / code / f"cadastre-{code}-parcelles.json.gz"
            try:
                download(source_url(code, dept), dst)
                result["freshOfficial"][code] = {"url": source_url(code, dept), "freshPath": str(dst), "freshSha256": sha256(dst), "cachedPath": str(raw_path(code, dept)), "cachedSha256": sha256(raw_path(code, dept)), "sameBytes": sha256(dst) == sha256(raw_path(code, dept))}
            except Exception as exc:
                result["freshOfficial"][code] = {"url": source_url(code, dept), "error": str(exc)}

    out = PROJECT / "work" / "cadastre-source-audit.json"; out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md = PROJECT / "work" / "cadastre-source-audit.md"
    md.write_text("# Cadastre source audit\n\n" + f"Pinned release `{RELEASE}`; `{len(codes)}` communes, `{result['exportedParcels']:,}` exported parcels, `{result['sourceFeatureCount']:,}` source features.\n\n" + f"All-source attribute checks: `{json.dumps(dict(attr), sort_keys=True)}`.\n\nGeometry: source invalid features `{source_invalid:,}`, empty `{source_empty:,}`, errors `{source_errors:,}`; independent sample `{sample_n:,}` features using EPSG:4326 → EPSG:2154 and Shapely (first feature plus every `{args.sample_mod}`th). Sample findings: `{json.dumps(dict(geom), sort_keys=True)}`.\n\nRecorded versus mapped area: `{json.dumps(result['areas'], sort_keys=True)}`.\n\nFresh official hashes: `{json.dumps(result['freshOfficial'], sort_keys=True)}`.\n\nScope: lineage and geometry processing only; no ground survey, title or ownership determination, or AOC validation.\n", encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__": raise SystemExit(main())
