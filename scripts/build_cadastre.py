#!/usr/bin/env python3
"""Acquire and compact Etalab cadastre parcels for the local atlas.

The source GeoJSON is kept verbatim in work/cadastre/<release>/ and the
published files contain only the stable parcel attributes and EPSG:2154
geometry needed by the atlas.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform as shapely_transform

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="backslashreplace")
    sys.stderr.reconfigure(errors="backslashreplace")

RELEASE = "2026-09-01"
CRS = "EPSG:2154"
BASE_URL = "https://cadastre.data.gouv.fr/data/etalab-cadastre/{release}/geojson/communes/{dept}/{code}/cadastre-{code}-parcelles.json.gz"
ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / "dist" / "data" / "index.json"
RAW_ROOT = ROOT.parent / "work" / "cadastre" / RELEASE
OUT_ROOT = ROOT / "dist" / "data" / "cadastre"
MANIFEST_PATH = OUT_ROOT / "manifest.json"
DEPARTMENT_FILTER = {"21", "69", "71", "89"}  # Burgundy index; a region site (--site) takes every indexed commune
TRANSFORMER = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)


def read_index() -> list[dict]:
    with INDEX_PATH.open(encoding="utf-8") as fh:
        doc = json.load(fh)
    villages = doc.get("villages", [])
    result = []
    for village in villages:
        code = str(village.get("id", "")).rsplit("-", 1)[-1]
        dept = str(village.get("department", ""))
        if len(code) == 5 and (DEPARTMENT_FILTER is None or dept in DEPARTMENT_FILTER):
            result.append({**village, "code": code, "department": dept})
    return result


def source_url(dept: str, code: str) -> str:
    return BASE_URL.format(release=RELEASE, dept=dept, code=code)


def raw_path(dept: str, code: str) -> Path:
    region_layout = RAW_ROOT / "cadastre" / code / f"cadastre-{code}-parcelles.json.gz"  # region_fetch.py downloads
    return region_layout if region_layout.exists() else RAW_ROOT / "geojson" / "communes" / dept / code / f"cadastre-{code}-parcelles.json.gz"


def download(url: str, destination: Path, attempts: int = 2) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size > 32:
        return
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            req = Request(url, headers={"User-Agent": "localatlas-cadastre/1.0"})
            with urlopen(req, timeout=90) as response, NamedTemporaryFile("wb", delete=False, dir=destination.parent) as tmp:
                temp_name = tmp.name
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    tmp.write(chunk)
            os.replace(temp_name, destination)
            return
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last = exc
            try:
                if "temp_name" in locals() and os.path.exists(temp_name):
                    os.unlink(temp_name)
            except OSError:
                pass
            if attempt + 1 < attempts:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"download failed after {attempts} attempts: {url}: {last}")


def geometry_json(geom) -> list:
    """Return canonical nested rings: Polygon -> [rings], MultiPolygon -> [polygon rings]."""
    geo = mapping(geom)
    coords = geo["coordinates"]
    if geo["type"] == "Polygon":
        return [coords]
    if geo["type"] == "MultiPolygon":
        return [polygon for polygon in coords]
    raise ValueError(f"unsupported geometry type {geo['type']}")


def process(village: dict) -> dict:
    code, dept = village["code"], village["department"]
    url = source_url(dept, code)
    raw = raw_path(dept, code)
    download(url, raw)
    with gzip.open(raw, "rt", encoding="utf-8") as fh:
        doc = json.load(fh)
    features = doc.get("features", [])
    parcels = []
    skipped_features = 0
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    for feature in features:
        props = feature.get("properties") or {}
        try:
            geom4326 = shape(feature["geometry"])
            geom = shapely_transform(TRANSFORMER.transform, geom4326)
            if geom.is_empty or not geom.is_valid:
                geom = geom.buffer(0)
            if geom.is_empty:
                continue
            bounds = [round(float(v), 2) for v in geom.bounds]
            minx, miny = min(minx, bounds[0]), min(miny, bounds[1])
            maxx, maxy = max(maxx, bounds[2]), max(maxy, bounds[3])
            parcel_id = str(feature.get("id") or props.get("id") or f"{code}-{props.get('section', '')}-{props.get('numero', '')}")
            parcels.append({
                "id": parcel_id,
                "section": str(props.get("section") or ""),
                "number": str(props.get("numero") or ""),
                "communeCode": code,
                "cadastralAreaM2": props.get("contenance"),
                "mappedAreaM2": round(float(geom.area), 2),
                "bounds": bounds,
                "rings": geometry_json(geom),
            })
        except (KeyError, TypeError, ValueError):
            skipped_features += 1
            continue
    if not parcels:
        raise RuntimeError(f"no usable parcel features for {code}")
    output = {
        "schemaVersion": 1,
        "crs": CRS,
        "communeCode": code,
        "sourceDate": RELEASE,
        "sourceUrl": url,
        "validation": {"sourceFeatureCount": len(features), "skippedFeatureCount": skipped_features},
        "parcels": parcels,
    }
    out = OUT_ROOT / f"{code}.json.gz"
    out.parent.mkdir(parents=True, exist_ok=True)
    temp = out.with_suffix(out.suffix + ".tmp")
    with temp.open("wb") as raw_out:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_out, compresslevel=9, mtime=0) as zipped:
            zipped.write(json.dumps(output, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    os.replace(temp, out)
    return {"url": f"./data/cadastre/{code}.json.gz", "bounds": [round(minx, 2), round(miny, 2), round(maxx, 2), round(maxy, 2)], "parcelCount": len(parcels), "sourceUrl": url, "sourceDate": RELEASE, "skippedFeatureCount": skipped_features}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codes", nargs="*", help="INSEE commune codes; defaults to all index communes")
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--site", help="region site folder under dist/ (e.g. rhone); default is the Burgundy atlas")
    parser.add_argument("--raw-root", type=Path, help="downloaded cadastre (e.g. ../regions/rhone-nord/raw)")
    args = parser.parse_args()
    if args.site:
        global INDEX_PATH, OUT_ROOT, MANIFEST_PATH, DEPARTMENT_FILTER
        INDEX_PATH = ROOT / "dist" / args.site / "data" / "index.json"
        OUT_ROOT = ROOT / "dist" / args.site / "data" / "cadastre"
        MANIFEST_PATH, DEPARTMENT_FILTER = OUT_ROOT / "manifest.json", None
    if args.raw_root:
        global RAW_ROOT
        RAW_ROOT = args.raw_root
    villages = read_index()
    wanted = set(args.codes or [v["code"] for v in villages])
    selected = [v for v in villages if v["code"] in wanted]
    missing = sorted(wanted - {v["code"] for v in selected})
    if missing:
        raise SystemExit(f"codes not found in index: {', '.join(missing)}")
    results, failures = {}, {}
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 6))) as pool:
        jobs = {pool.submit(process, village): village for village in selected}
        for future in as_completed(jobs):
            village = jobs[future]
            try:
                results[village["code"]] = future.result()
                print(f"OK {village['code']} {village['name']}: {results[village['code']]['parcelCount']} parcels", flush=True)
            except Exception as exc:
                failures[village["code"]] = str(exc)
                print(f"FAILED {village['code']} {village['name']}: {exc}", file=sys.stderr, flush=True)
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    existing = {}
    if MANIFEST_PATH.exists():
        try:
            existing = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")).get("communes", {})
        except (OSError, ValueError):
            existing = {}
    existing.update(results)
    manifest = {"schemaVersion": 1, "crs": CRS, "release": RELEASE, "attribution": "DGFiP cadastral data / Cadastre Etalab (DINUM) (https://cadastre.data.gouv.fr/)", "license": "Licence Ouverte / Open Licence 2.0 (https://www.etalab.gouv.fr/licence-ouverte-open-licence/)", "communes": dict(sorted(existing.items()))}
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if failures:
        print(json.dumps({"failed": failures}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
