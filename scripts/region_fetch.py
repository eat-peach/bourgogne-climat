"""Download the open source data for a region atlas (see website/regions/<id>/region.json).

Writes only under E:\\Burgundy Map\\regions\\<id>\\raw\\ and is resumable: finished files are kept.

  inao.gpkg                         INAO AOC delimitation rows for the region's communes (pinned snapshot)
  cadastre/<insee>/...json.gz       Etalab cadastre: commune outline, parcels, lieux-dits (release 2026-09-01)
  terrain/rgealti_<x>_<y>.tif       IGN RGE ALTI via Géoplateforme WMS, 1 km tiles at fetch.terrainResM
  ortho/ortho_<x>_<y>.tif           IGN orthophotos via Géoplateforme WMS, 1 km tiles at fetch.orthoResM
  bdtopo/<layer>_<x>_<y>.geojson    IGN BD TOPO via Géoplateforme WFS, 10 km tiles

Usage: python region_fetch.py rhone-nord [--only inao,cadastre,terrain,ortho,bdtopo] [--workers 6]
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.transform import from_origin
from shapely.geometry import box
from shapely.ops import unary_union

WEB = Path(__file__).resolve().parents[1]
ROOT = WEB.parent
INAO_SHP = ROOT / "work/reference-audit/official/2026-10-19-extracted/2026-10-19_delim-parcellaire-aoc-shp.shp"
CADASTRE_RELEASE = "2026-09-01"
CADASTRE_URL = "https://cadastre.data.gouv.fr/data/etalab-cadastre/{release}/geojson/communes/{dept}/{insee}/cadastre-{insee}-{layer}.json.gz"
WMS_URL = "https://data.geopf.fr/wms-r/wms"
WFS_URL = "https://data.geopf.fr/wfs/ows"
UA = "BourgogneClimat-RegionFetch/1.0 (open-data atlas; climat.daoyizhang.com)"
BDTOPO = {"buildings": "BDTOPO_V3:batiment", "roads": "BDTOPO_V3:troncon_de_route", "vegetation": "BDTOPO_V3:zone_de_vegetation",
          "water_surface": "BDTOPO_V3:surface_hydrographique", "water_lines": "BDTOPO_V3:troncon_hydrographique"}


def log(*parts):
    print(*parts, flush=True)


def get(url, params=None, expect=None, timeout=120):
    """GET with retries; `expect` checks the content type ("image", "json", "gzip")."""
    last = None
    for attempt in range(1, 6):
        try:
            r = requests.get(url, params=params, headers={"User-Agent": UA}, timeout=timeout)
            ctype = r.headers.get("content-type", "").lower()
            if r.status_code == 404 and expect == "gzip":
                return None
            if r.status_code != 200 or (expect and expect not in ctype and not (expect == "gzip" and r.content[:2] == b"\x1f\x8b")):
                raise RuntimeError(f"HTTP {r.status_code} {ctype}: {r.text[:160] if 'text' in ctype or 'xml' in ctype else ''}")
            return r
        except Exception as exc:  # transient service errors are retried
            last = exc
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"{url} failed after retries: {last}")


def atomic(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(path)


def stage_inao(cfg, raw: Path) -> gpd.GeoDataFrame:
    out = raw / "inao.gpkg"
    raw.mkdir(parents=True, exist_ok=True)
    if not out.exists():
        df = gpd.read_file(INAO_SHP, where="insee IN (%s)" % ",".join(f"'{c}'" for c in cfg["communes"])).to_crs(2154)
        tmp = out.with_name("inao.part.gpkg")
        df.to_file(tmp, driver="GPKG")
        tmp.replace(out)
        log("INAO", len(df), "rows", sorted(set(df["app"])))
    return gpd.read_file(out)


def stage_cadastre(cfg, raw: Path, workers: int):
    jobs = [(insee, layer) for insee in cfg["communes"] for layer in ("communes", "parcelles", "lieux_dits")]
    def one(job):
        insee, layer = job
        path = raw / "cadastre" / insee / f"cadastre-{insee}-{layer}.json.gz"
        if path.exists() and path.stat().st_size > 50:
            return "kept"
        r = get(CADASTRE_URL.format(release=CADASTRE_RELEASE, dept=insee[:2], insee=insee, layer=layer), expect="gzip")
        if r is None:
            return "missing"
        json.loads(gzip.decompress(r.content))  # must be valid GeoJSON
        atomic(path, r.content)
        return "saved"
    run(jobs, one, workers, "cadastre")


def stage_names(cfg, raw: Path):
    """Official commune names with accents and hyphens (the cadastre and INAO use capitals without accents)."""
    out = raw / "commune-names.json"
    names = json.loads(out.read_text("utf8")) if out.exists() else {}
    for insee in cfg["communes"]:
        if insee not in names:
            names[insee] = get(f"https://geo.api.gouv.fr/communes/{insee}", {"fields": "nom"}, expect="json").json()["nom"]
    atomic(out, json.dumps(names, ensure_ascii=False, indent=1).encode("utf8"))
    log("names", len(names))


def footprint(cfg, raw: Path, inao: gpd.GeoDataFrame):
    """Every scene rectangle (AOC land inside each commune, buffered, as region_build.py frames it) plus the
    buffered AOC land itself: terrain and photos must cover the whole rectangle a scene shows."""
    parts, scenes = [], []
    for insee in cfg["communes"]:
        path = raw / "cadastre" / insee / f"cadastre-{insee}-communes.json.gz"
        commune = gpd.GeoDataFrame.from_features(json.loads(gzip.decompress(path.read_bytes()))["features"], crs=4326).to_crs(2154)
        geom = unary_union(commune.geometry)
        rows = inao[inao.geometry.intersects(geom)]
        local = [g.intersection(geom) for g in rows.geometry]
        parts += local
        scenes.append(box(*unary_union(local).buffer(500).bounds))
    return unary_union([unary_union(parts).buffer(cfg["fetch"]["aocBufferM"]), *scenes])


def km_tiles(area, size_m=1000):
    x0, y0, x1, y1 = area.bounds
    tiles = []
    for x in range(int(math.floor(x0 / size_m)), int(math.floor(x1 / size_m)) + 1):
        for y in range(int(math.floor(y0 / size_m)), int(math.floor(y1 / size_m)) + 1):
            if area.intersects(box(x * size_m, y * size_m, (x + 1) * size_m, (y + 1) * size_m)):
                tiles.append((x, y))
    return tiles


def wms_tile(layer, tile, res, fmt):
    x, y = tile
    n = int(round(1000 / res))
    params = {"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": layer, "STYLES": "normal" if "RGEALTI" in layer else "",
              "CRS": "EPSG:2154", "BBOX": f"{x * 1000},{y * 1000},{(x + 1) * 1000},{(y + 1) * 1000}", "WIDTH": n, "HEIGHT": n, "FORMAT": fmt}
    return get(WMS_URL, params, expect="image"), n


def stage_terrain(cfg, raw: Path, tiles, workers: int):
    res = cfg["fetch"]["terrainResM"]
    def one(tile):
        path = raw / "terrain" / f"rgealti_{tile[0]}_{tile[1]}.tif"
        if path.exists():
            return "kept"
        r, n = wms_tile("RGEALTI-MNT_PYR-ZIP_FXX_LAMB93_WMS", tile, res, "image/geotiff")
        with rasterio.open(io.BytesIO(r.content)) as src:
            data = src.read(1).astype("float32")
        if not np.isfinite(data).any() or float(np.nanmax(data)) <= -1000:
            return "nodata"
        profile = {"driver": "GTiff", "width": n, "height": n, "count": 1, "dtype": "float32", "crs": "EPSG:2154", "nodata": -99999.0,
                   "transform": from_origin(tile[0] * 1000, (tile[1] + 1) * 1000, res, res), "compress": "deflate", "predictor": 3}
        buf = io.BytesIO()
        with rasterio.open(buf, "w", **profile) as dst:
            dst.write(data, 1)
        atomic(path, buf.getvalue())
        return "saved"
    run(tiles, one, workers, "terrain")


def stage_ortho(cfg, raw: Path, tiles, workers: int):
    res = cfg["fetch"]["orthoResM"]
    def one(tile):
        path = raw / "ortho" / f"ortho_{tile[0]}_{tile[1]}.tif"
        if path.exists():
            return "kept"
        r, n = wms_tile("ORTHOIMAGERY.ORTHOPHOTOS", tile, res, "image/jpeg")
        rgb = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype=np.uint8)
        if rgb.shape != (n, n, 3) or float(rgb.std()) < 0.5:
            raise RuntimeError(f"blank or wrong-size ortho tile {tile}")
        profile = {"driver": "GTiff", "width": n, "height": n, "count": 3, "dtype": "uint8", "crs": "EPSG:2154",
                   "transform": from_origin(tile[0] * 1000, (tile[1] + 1) * 1000, res, res), "compress": "JPEG", "jpeg_quality": 90, "photometric": "YCbCr"}
        buf = io.BytesIO()
        with rasterio.open(buf, "w", **profile) as dst:
            dst.write(np.moveaxis(rgb, -1, 0))
        atomic(path, buf.getvalue())
        return "saved"
    run(tiles, one, workers, "ortho")


def stage_context(cfg, raw: Path, area, workers: int):
    """Coarse terrain around the whole region (background hills), 50 km tiles sampled every 200 m."""
    size, spacing, margin = 50_000, 200, 15_000
    x0, y0, x1, y1 = area.buffer(margin).bounds
    tiles = [(x, y) for x in range(int(x0 // size), int(x1 // size) + 1) for y in range(int(y0 // size), int(y1 // size) + 1)]
    n = size // spacing + 1  # nodes at both edges, like the Burgundy context grid
    def one(tile):
        x, y = tile
        path = raw / "context" / f"rgealti_{x}_{y}_200m.tif"
        if path.exists():
            return "kept"
        half = spacing / 2  # pixel centres on the grid nodes
        params = {"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": "RGEALTI-MNT_PYR-ZIP_FXX_LAMB93_WMS", "STYLES": "normal",
                  "CRS": "EPSG:2154", "BBOX": f"{x * size - half},{y * size - half},{(x + 1) * size + half},{(y + 1) * size + half}",
                  "WIDTH": n, "HEIGHT": n, "FORMAT": "image/geotiff"}
        atomic(path, get(WMS_URL, params, expect="image").content)
        return "saved"
    run(tiles, one, workers, "context")


def stage_bdtopo(cfg, raw: Path, area, workers: int):
    size = cfg["fetch"]["wfsTileM"]
    tiles = km_tiles(area, size)
    jobs = [(name, layer, t) for name, layer in BDTOPO.items() for t in tiles]
    def one(job):
        name, layer, (x, y) = job
        path = raw / "bdtopo" / f"{name}_{x}_{y}.geojson"
        if path.exists():
            return "kept"
        feats, start = {}, 0
        while True:
            params = {"SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": layer, "OUTPUTFORMAT": "application/json",
                      "SRSNAME": "EPSG:2154", "BBOX": f"{x * size},{y * size},{(x + 1) * size},{(y + 1) * size},EPSG:2154", "STARTINDEX": start, "COUNT": 5000}
            page = get(WFS_URL, params, expect="json", timeout=240).json().get("features", [])
            for f in page:
                feats[f.get("id") or json.dumps(f, sort_keys=True)[:200]] = f
            if len(page) < 5000:
                break
            start += 5000
        atomic(path, json.dumps({"type": "FeatureCollection", "features": list(feats.values())}).encode())
        return f"saved {len(feats)}"
    run(jobs, one, workers, "bdtopo")


def run(jobs, fn, workers, label):
    done, errors = 0, []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fn, j): j for j in jobs}
        for f in as_completed(futures):
            done += 1
            try:
                status = f.result()
                if done % 25 == 0 or done == len(jobs):
                    log(f"{label} {done}/{len(jobs)} {status}")
            except Exception as exc:
                errors.append(f"{futures[f]}: {exc}")
                log(f"{label} ERROR {futures[f]}: {exc}")
    log(f"{label} finished: {len(jobs)} jobs, {len(errors)} errors")
    if errors:
        raise SystemExit(f"{label}: {len(errors)} failed; rerun to retry")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("region")
    ap.add_argument("--only", default="inao,cadastre,names,terrain,ortho,context,bdtopo")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    cfg = json.loads((WEB / "regions" / args.region / "region.json").read_text("utf8"))
    raw = ROOT / "regions" / args.region / "raw"
    stages = set(args.only.split(","))
    inao = stage_inao(cfg, raw)
    if "cadastre" in stages:
        stage_cadastre(cfg, raw, args.workers)
    if "names" in stages or "cadastre" in stages:
        stage_names(cfg, raw)
    area = footprint(cfg, raw, inao)
    tiles = km_tiles(area)
    (raw / "footprint.json").write_text(json.dumps({"tiles1km": len(tiles), "bounds": [round(v) for v in area.bounds], "areaKm2": round(area.area / 1e6, 1)}))
    log("footprint", round(area.area / 1e6, 1), "km2,", len(tiles), "1 km tiles")
    if "terrain" in stages:
        stage_terrain(cfg, raw, tiles, args.workers)
    if "ortho" in stages:
        stage_ortho(cfg, raw, tiles, args.workers)
    if "context" in stages:
        stage_context(cfg, raw, area, args.workers)
    if "bdtopo" in stages:
        stage_bdtopo(cfg, raw, area, max(2, args.workers // 2))


if __name__ == "__main__":
    sys.exit(main())
