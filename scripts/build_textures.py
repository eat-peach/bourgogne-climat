#!/usr/bin/env python3
"""Build RGB aerial previews from the indexed IGN 1 km orthophoto tiles.

This script deliberately writes only dist/data/textures/*.jpg and the separate
texture-manifest.json. The data pipeline can merge that manifest later without
having its scene/index JSON files modified while geometry is being generated.
"""
from __future__ import annotations

import argparse
import json
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCENE_DIR = ROOT / "website" / "dist" / "data" / "scenes"
OUT_DIR = ROOT / "website" / "dist" / "data" / "textures"
ORTHO_DIR = ROOT / "burgundy_full" / "05_orthophoto"
MANIFEST_PATH = ROOT / "website" / "dist" / "data" / "texture-manifest.json"
NEUTRAL = (188, 178, 162)
MAX_IMAGE_EDGE = 1280
JPEG_QUALITY = 72
JPEG_SUBSAMPLING = 0
ALGORITHM_VERSION = "ortho-rgb-mosaic-v3-web-1280-q72-rgb"


def tile_path(x: int, y: int) -> Path:
    return ORTHO_DIR / f"ign_ortho_epsg2154_{x}_{y}_025m.tif"


def scene_bounds(path: Path) -> tuple[str, list[float]] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        bounds = data.get("bounds")
        if not isinstance(bounds, list) or len(bounds) != 4:
            return None
        bounds = [float(value) for value in bounds]
        if not (bounds[2] > bounds[0] and bounds[3] > bounds[1]):
            return None
        return str(data.get("id") or path.stem), bounds
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def read_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.is_file():
        return {}
    try:
        value = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def healthy_existing(scene_id: str, bounds: list[float], manifest: dict[str, Any]) -> bool:
    item = manifest.get(scene_id)
    if not isinstance(item, dict) or item.get("bounds") != bounds or item.get("algorithmVersion") != ALGORITHM_VERSION:
        return False
    output = OUT_DIR / f"{scene_id}.jpg"
    return output.is_file() and output.stat().st_size < 25 * 1024 * 1024 and item.get("url") == f"data/textures/{scene_id}.jpg"


def build_one(scene: tuple[str, list[float]], manifest: dict[str, Any], force: bool = False) -> tuple[str, dict[str, Any]]:
    scene_id, bounds = scene
    if not force and healthy_existing(scene_id, bounds, manifest):
        return scene_id, manifest[scene_id]
    xmin, ymin, xmax, ymax = bounds
    max_dim_km = max(xmax - xmin, ymax - ymin) / 1000.0
    tile_pixels = max(128, min(1024, math.ceil(MAX_IMAGE_EDGE / max_dim_km)))
    if max_dim_km <= 4.0:
        tile_pixels = max(tile_pixels, 512)
    x0, x1 = math.floor(xmin / 1000), math.ceil(xmax / 1000)
    y0, y1 = math.floor(ymin / 1000), math.ceil(ymax / 1000)
    xs = list(range(x0, x1)); ys = list(range(y0, y1))
    canvas = Image.new("RGB", (len(xs) * tile_pixels, len(ys) * tile_pixels), NEUTRAL)
    found = 0
    coverage_area = 0.0
    scene_area = (xmax - xmin) * (ymax - ymin)
    for x in xs:
        for y in ys:
            source = tile_path(x, y)
            if not source.is_file():
                continue
            with Image.open(source) as image:
                tile = image.convert("RGB").resize((tile_pixels, tile_pixels), Image.Resampling.LANCZOS)
            # GeoTIFF rows are north-to-south; mosaic rows are north-to-south.
            canvas.paste(tile, ((x - x0) * tile_pixels, (y1 - 1 - y) * tile_pixels))
            found += 1
            coverage_area += max(0.0, min(xmax, (x + 1) * 1000) - max(xmin, x * 1000)) * max(0.0, min(ymax, (y + 1) * 1000) - max(ymin, y * 1000))
    total = len(xs) * len(ys)
    left = round((xmin - x0 * 1000) / 1000 * tile_pixels)
    top = round((y1 * 1000 - ymax) / 1000 * tile_pixels)
    right = round((xmax - x0 * 1000) / 1000 * tile_pixels)
    bottom = round((y1 * 1000 - ymin) / 1000 * tile_pixels)
    image = canvas.crop((left, top, right, bottom))
    image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    output = OUT_DIR / f"{scene_id}.jpg"
    image.save(output, format="JPEG", quality=JPEG_QUALITY, optimize=True, subsampling=JPEG_SUBSAMPLING)
    return scene_id, {
        "url": f"data/textures/{scene_id}.jpg",
        "bounds": bounds,
        "algorithmVersion": ALGORITHM_VERSION,
        "coverageFraction": coverage_area / scene_area if scene_area else 0.0,
        "width": image.width,
        "height": image.height,
        "sourceTileCount": found,
        "sourceTileTotal": total,
        "sourceSamplingMetres": 0.25,
        "displayPixelsPerTile": tile_pixels,
    }


def reencode_existing(scene: tuple[str, list[float]], manifest: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Resize an existing derived JPEG without rebuilding its source mosaic."""
    scene_id, bounds = scene
    item = manifest.get(scene_id)
    if not isinstance(item, dict) or item.get("bounds") != bounds:
        raise ValueError(f"Missing or mismatched manifest entry for {scene_id}")
    output = OUT_DIR / f"{scene_id}.jpg"
    if not output.is_file():
        raise FileNotFoundError(output)
    with Image.open(output) as source:
        image = source.convert("RGB")
        image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
        image.save(output, format="JPEG", quality=JPEG_QUALITY, optimize=True, subsampling=JPEG_SUBSAMPLING)
        width, height = image.size
    updated = dict(item)
    updated.update({"algorithmVersion": ALGORITHM_VERSION, "width": width, "height": height})
    return scene_id, updated


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--reencode-existing", action="store_true", help="Resize existing derived JPEGs without rebuilding source mosaics")
    args = parser.parse_args()
    scenes = [result for path in sorted(SCENE_DIR.glob("*.json")) if (result := scene_bounds(path))]
    if not scenes:
        raise SystemExit(f"No scene JSON files with valid bounds under {SCENE_DIR}")
    manifest = read_manifest()
    results: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=max(1, min(4, args.workers))) as pool:
        worker = reencode_existing if args.reencode_existing else build_one
        futures = [pool.submit(worker, scene, manifest) if args.reencode_existing else pool.submit(worker, scene, manifest, args.force) for scene in scenes]
        for future in as_completed(futures):
            scene_id, item = future.result()
            results[scene_id] = item
            print(f"{scene_id}: {item.get('sourceTileCount', 0)}/{item.get('sourceTileTotal', 0)} tiles, {item.get('width')}x{item.get('height')}", flush=True)
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(dict(sorted(results.items())), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(results)} texture manifest entries to {MANIFEST_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
