"""Export a compact, source-backed coarse terrain underlay for the atlas.

The collected RGE ALTI overview tiles are 25 m EPSG:2154 rasters covering
50 km cells.  This exporter samples each cell at 200 m-spaced nodes (251 by
251, including both cell edges) and keeps source nodata as an explicit mask.
No values are filled from neighbouring tiles or invented outside the source.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import re
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from shapely.geometry import box


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "burgundy_full" / "03_terrain" / "overview_rgealti_25m"
COMMUNES = ROOT / "burgundy_full" / "06_scope_extension" / "08_map_ready" / "combined_bivb_physical_communes_376_epsg2154.gpkg"
DEFAULT_OUTPUT = ROOT / "website" / "dist" / "data" / "context-terrain.json.gz"
SOURCE_RESOLUTION_METRES = 25.0
SAMPLING_METRES = 200.0
GRID_SIZE = 251
TILE_SIZE_METRES = 50_000.0


def _finite(value: float) -> float:
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"non-finite terrain value: {value!r}")
    return value


def _tile_bounds(path: Path) -> tuple[float, float, float, float]:
    with rasterio.open(path) as dataset:
        if dataset.crs is None or dataset.crs.to_epsg() != 2154:
            raise ValueError(f"{path.name}: expected EPSG:2154, got {dataset.crs}")
        left, bottom, right, top = map(_finite, dataset.bounds)
        if dataset.width != 2000 or dataset.height != 2000:
            raise ValueError(f"{path.name}: expected 2000x2000 source raster")
        if tuple(round(float(value), 6) for value in dataset.res) != (25.0, 25.0):
            raise ValueError(f"{path.name}: expected 25 m source raster, got {dataset.res}")
    return left, bottom, right, top


def _tile_id(path: Path) -> str:
    match = re.search(r"OVERVIEW_(\d+)_(\d+)_25M_EPSG2154", path.stem)
    if not match:
        raise ValueError(f"unexpected source tile name: {path.name}")
    return f"rgealti-{match.group(1)}-{match.group(2)}"


def _sample_nodes(dataset: rasterio.DatasetReader, bounds: tuple[float, float, float, float]):
    """Sample exact 200 m-spaced nodes, preserving nodata neighborhoods.

    Raster pixels are cell-centred.  The fractional source indices below
    therefore subtract 0.5 before bilinear interpolation.  At the outer tile
    edges, indices are clamped to the nearest source pixel; this samples the
    supplied raster edge rather than extending it with a fabricated value.
    """
    left, bottom, right, top = bounds
    source = dataset.read(1, masked=True).astype(np.float64)
    values = np.asarray(source.filled(0.0), dtype=np.float64)
    valid = ~np.ma.getmaskarray(source)
    rows, cols = np.indices((GRID_SIZE, GRID_SIZE), dtype=np.float64)
    x = left + cols * SAMPLING_METRES
    y = top - rows * SAMPLING_METRES
    col = (x - left) / SOURCE_RESOLUTION_METRES - 0.5
    row = (top - y) / SOURCE_RESOLUTION_METRES - 0.5
    col = np.clip(col, 0.0, values.shape[1] - 1.0)
    row = np.clip(row, 0.0, values.shape[0] - 1.0)

    row0 = np.floor(row).astype(np.int64)
    col0 = np.floor(col).astype(np.int64)
    row1 = np.minimum(row0 + 1, values.shape[0] - 1)
    col1 = np.minimum(col0 + 1, values.shape[1] - 1)
    row_weight = row - row0
    col_weight = col - col0

    valid_mask = valid[row0, col0] & valid[row0, col1] & valid[row1, col0] & valid[row1, col1]
    top_values = values[row0, col0] * (1.0 - col_weight) + values[row0, col1] * col_weight
    bottom_values = values[row1, col0] * (1.0 - col_weight) + values[row1, col1] * col_weight
    sampled = top_values * (1.0 - row_weight) + bottom_values * row_weight
    sampled[~valid_mask] = 0.0
    return sampled, valid_mask


def _encode_tile(path: Path) -> dict:
    bounds = _tile_bounds(path)
    left, bottom, right, top = bounds
    if not math.isclose(right - left, TILE_SIZE_METRES, abs_tol=0.01) or not math.isclose(top - bottom, TILE_SIZE_METRES, abs_tol=0.01):
        raise ValueError(f"{path.name}: expected 50 km tile bounds, got {bounds}")
    with rasterio.open(path) as dataset:
        sampled, valid_mask = _sample_nodes(dataset, bounds)
    if not np.any(valid_mask):
        raise ValueError(f"{path.name}: no valid source terrain samples")
    if not np.isfinite(sampled[valid_mask]).all():
        raise ValueError(f"{path.name}: non-finite valid terrain sample")
    heights = np.round(sampled, 1)
    mask = valid_mask.astype(np.uint8)
    return {
        "id": _tile_id(path),
        "bounds": [round(value, 2) for value in bounds],
        "gridSize": GRID_SIZE,
        "heights": heights.reshape(-1).tolist(),
        "validMask": mask.reshape(-1).tolist(),
        "minElevation": round(float(sampled[valid_mask].min()), 1),
        "maxElevation": round(float(sampled[valid_mask].max()), 1),
    }


def _roi_bounds() -> tuple[float, float, float, float]:
    communes = gpd.read_file(COMMUNES)
    if len(communes) != 376 or communes.crs is None or communes.crs.to_epsg() != 2154:
        raise ValueError("commune ROI must contain 376 EPSG:2154 features")
    return tuple(map(_finite, communes.total_bounds))


def build_payload(source_dir: Path = SOURCE_DIR) -> dict:
    source_tiles = sorted(source_dir.glob("RGEALTI_OVERVIEW_*_25M_EPSG2154.tif"))
    if len(source_tiles) != 30:
        raise ValueError(f"expected 30 collected 25 m source tiles, found {len(source_tiles)}")
    roi = box(*_roi_bounds())
    selected = [path for path in source_tiles if roi.intersects(box(*_tile_bounds(path)))]
    if not selected:
        raise ValueError("commune ROI does not intersect any collected terrain tile")
    tiles = [_encode_tile(path) for path in selected]
    tiles.sort(key=lambda tile: tile["id"])
    return {
        "version": 1,
        "crs": "EPSG:2154",
        "samplingMetres": 200,
        # This names the output source resolution; inputResolutionMetres
        # records the native resolution of the collected source GeoTIFFs.
        "sourceResolutionMetres": 200,
        "inputResolutionMetres": 25,
        "gridSemantics": "nodes-at-bounds-inclusive",
        "tiles": tiles,
    }


def write_deterministic_gzip(payload: dict, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode="wb", filename="", mtime=0) as compressed:
        compressed.write(raw)
    output.write_bytes(stream.getvalue())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=SOURCE_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = build_payload(args.source_dir)
    write_deterministic_gzip(payload, args.output)
    size = args.output.stat().st_size
    if size > 10_000_000:
        raise SystemExit(f"output exceeds 10 MB limit: {size} bytes")
    print(f"wrote {args.output} ({size} bytes, {len(payload['tiles'])} tiles, grid {GRID_SIZE}x{GRID_SIZE})")


if __name__ == "__main__":
    main()
