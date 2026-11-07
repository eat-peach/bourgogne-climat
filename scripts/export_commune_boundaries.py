"""Export the physical commune boundaries used by the atlas map.

The source layer is already in Lambert-93 (EPSG:2154), so this exporter does
not reproject it.  It keeps every polygon part and interior ring, while using
Shapely's topology-preserving 5 metre simplifier to keep the browser payload
small.  The original geometry centroid is retained as a stable map anchor;
it is intentionally calculated before simplification.

The gzip stream is written with a zero timestamp and the communes are sorted
by INSEE code, making repeated exports byte-for-byte deterministic.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import math
from pathlib import Path
from typing import Iterable

import geopandas as gpd
from shapely.geometry import MultiPolygon, Polygon


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = (
    ROOT
    / "burgundy_full"
    / "06_scope_extension"
    / "08_map_ready"
    / "combined_bivb_physical_communes_376_epsg2154.gpkg"
)
DEFAULT_OUTPUT = ROOT / "website" / "dist" / "data" / "communes.json.gz"
SIMPLIFY_METRES = 5.0


def _polygons(geometry) -> list[Polygon]:
    """Return polygon parts for a Polygon or MultiPolygon geometry."""
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return list(geometry.geoms)
    return [part for part in getattr(geometry, "geoms", ()) if isinstance(part, Polygon)]


def _finite(value: float) -> float:
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"non-finite coordinate: {value!r}")
    return value


def _ring(ring: Iterable[tuple[float, float]]) -> list[list[float]]:
    result = [[round(_finite(x), 2), round(_finite(y), 2)] for x, y in ring]
    if len(result) < 4 or result[0] != result[-1]:
        raise ValueError("polygon ring is not closed or has fewer than four vertices")
    return result


def _rings(geometry) -> list[list[list[list[float]]]]:
    """Encode polygons as ``[polygon [outer, hole, ...], ...]``."""
    encoded: list[list[list[list[float]]]] = []
    for polygon in _polygons(geometry):
        if polygon.is_empty or polygon.area <= 0:
            raise ValueError("empty or zero-area polygon after simplification")
        rings = [_ring(polygon.exterior.coords)]
        rings.extend(_ring(hole.coords) for hole in polygon.interiors)
        encoded.append(rings)
    if not encoded:
        raise ValueError("geometry has no polygon parts")
    return encoded


def _bounds(geometry) -> list[float]:
    bounds = [_finite(value) for value in geometry.bounds]
    if bounds[0] > bounds[2] or bounds[1] > bounds[3]:
        raise ValueError(f"invalid bounds: {bounds!r}")
    return [round(value, 2) for value in bounds]


def build_payload(source: Path, tolerance: float = SIMPLIFY_METRES) -> dict:
    """Read, validate, simplify, and encode the commune source layer."""
    frame = gpd.read_file(source)
    if frame.crs is None or frame.crs.to_epsg() != 2154:
        raise ValueError(f"expected source CRS EPSG:2154, got {frame.crs}")
    required = {"insee", "commune_name", "geometry"}
    missing = required.difference(frame.columns)
    if missing:
        raise ValueError(f"source is missing required columns: {sorted(missing)}")
    if len(frame) != 376:
        raise ValueError(f"expected 376 source communes, got {len(frame)}")

    rows = []
    seen_codes: set[str] = set()
    for row in frame.sort_values("insee", key=lambda values: values.astype(str)).itertuples():
        code = str(row.insee)
        if code in seen_codes:
            raise ValueError(f"duplicate INSEE code: {code}")
        seen_codes.add(code)
        source_geometry = row.geometry
        if source_geometry is None or source_geometry.is_empty or not source_geometry.is_valid:
            raise ValueError(f"invalid source geometry for {code}")
        source_parts = _polygons(source_geometry)
        if not source_parts:
            raise ValueError(f"source geometry has no polygon parts for {code}")
        centroid = [round(_finite(source_geometry.centroid.x), 2), round(_finite(source_geometry.centroid.y), 2)]

        simplified = source_geometry.simplify(tolerance, preserve_topology=True)
        if simplified.is_empty or not simplified.is_valid:
            raise ValueError(f"invalid simplified geometry for {code}")
        simplified_parts = _polygons(simplified)
        # A physical commune may consist of disconnected pieces.  Do not let
        # simplification silently hide one of those pieces.
        if len(simplified_parts) != len(source_parts):
            raise ValueError(
                f"simplification changed part count for {code}: "
                f"{len(source_parts)} -> {len(simplified_parts)}"
            )
        rows.append(
            {
                "code": code,
                "name": str(row.commune_name),
                # Keep source bounds so a simplified extreme vertex cannot
                # exclude a boundary point during browser culling.
                "bounds": _bounds(source_geometry),
                "rings": _rings(simplified),
                "centroid": centroid,
            }
        )

    if len(rows) != 376 or len({row["code"] for row in rows}) != 376:
        raise ValueError("export did not produce 376 unique communes")
    return {"crs": "EPSG:2154", "communes": rows}


def write_deterministic_gzip(payload: dict, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    raw = text.encode("utf-8")
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode="wb", filename="", mtime=0) as compressed:
        compressed.write(raw)
    output.write_bytes(stream.getvalue())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--tolerance", type=float, default=SIMPLIFY_METRES)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.tolerance <= 0 or not math.isfinite(args.tolerance):
        raise SystemExit("--tolerance must be a positive finite metre value")
    payload = build_payload(args.source, args.tolerance)
    write_deterministic_gzip(payload, args.output)
    print(f"wrote {args.output} ({args.output.stat().st_size} bytes, {len(payload['communes'])} communes)")


if __name__ == "__main__":
    main()
