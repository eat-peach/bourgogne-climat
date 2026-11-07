#!/usr/bin/env python3
"""Publish mutually exclusive AOC parcel display geometry.

The source scene JSON files are the immutable input.  This script builds one
global union per source classification, then rereads each source scene and
subtracts the union of every higher-priority classification before writing a
deterministic gzip payload to ``dist/data/scenes``.

The output keeps the source parcel metadata and classification at the top
level.  ``rings`` is the display geometry consumed by the current scene
format, and ``displayClassification`` records the classification used by the
mask.  Raw ``source-scenes`` files are never modified.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import tempfile
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.validation import explain_validity
from shapely import make_valid, set_precision


ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "website"
SOURCE_SCENES = SITE / "source-scenes"
DIST_SCENES = SITE / "dist" / "data" / "scenes"
EXPECTED_SCENES = 376
RANK = ("grand-cru", "premier-cru", "village", "regional", "unclassified")
PAIR_TOLERANCE_M2 = 1e-6
SOURCE_GRID_M = 0.01


def is_pair(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) >= 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    )


def polygonal(value: BaseGeometry | None) -> BaseGeometry | None:
    """Return only polygonal components from a valid or invalid result."""
    if value is None or value.is_empty:
        return None
    try:
        value = make_valid(value)
    except Exception:
        try:
            value = value.buffer(0)
        except Exception:
            return None
    if value.is_empty:
        return None
    if isinstance(value, (Polygon, MultiPolygon)):
        try:
            # Source scene coordinates are emitted to centimetres.  Applying
            # that same precision model before global unions both prevents
            # invalid-edge slivers and keeps the expensive regional union
            # tractable.
            value = set_precision(value, grid_size=SOURCE_GRID_M, mode="valid_output")
        except Exception:
            pass
        return value
    if isinstance(value, GeometryCollection):
        pieces = [polygonal(g) for g in value.geoms]
        pieces = [g for g in pieces if g is not None and not g.is_empty]
        if not pieces:
            return None
        return unary_union(pieces)
    return None


def _polygon_from_rings(rings: Any) -> BaseGeometry | None:
    if not isinstance(rings, list) or not rings:
        return None
    # One source part is [shell, hole, ...].
    if is_pair(rings[0]):
        parts = [rings]
    elif isinstance(rings[0], list) and rings[0] and is_pair(rings[0][0]):
        parts = [rings]
    else:
        parts = rings
    polygons: list[Polygon] = []
    for part in parts:
        if not isinstance(part, list) or not part:
            continue
        if is_pair(part[0]):
            shell = part
            holes: list[Any] = []
        else:
            shell = part[0] if part else []
            holes = part[1:] if len(part) > 1 else []
        if not isinstance(shell, list) or len(shell) < 4:
            continue
        holes = [h for h in holes if isinstance(h, list) and len(h) >= 4]
        try:
            polygons.append(Polygon(shell, holes))
        except Exception:
            continue
    if not polygons:
        return None
    # Valid disjoint parts already describe the intended polygonal geometry.
    # Unioning every valid source feature is unnecessary and substantially
    # slows regional exports; retain the repair path for malformed sources.
    candidate = polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)
    if candidate.is_valid:
        return candidate
    repaired = [polygonal(p) for p in polygons]
    repaired = [p for p in repaired if p is not None and not p.is_empty]
    if not repaired:
        return None
    try:
        return polygonal(unary_union(repaired))
    except Exception:
        # A malformed source ring can still make GEOS reject a union even
        # after individual repair.  Buffer-zero is the final local repair;
        # source JSON itself remains untouched.
        repaired = [p.buffer(0) for p in repaired]
        return polygonal(unary_union(repaired))


def source_geometry(parcel: dict[str, Any]) -> BaseGeometry | None:
    """Read the existing scene geometry without changing its metadata."""
    geometry = parcel.get("geometry")
    if isinstance(geometry, dict):
        kind = geometry.get("type")
        coords = geometry.get("coordinates")
        if kind == "Polygon":
            return _polygon_from_rings(coords)
        if kind == "MultiPolygon":
            return _polygon_from_rings(coords)
    return _polygon_from_rings(parcel.get("rings"))


def as_rings(value: BaseGeometry | None) -> list[Any]:
    """Serialize polygonal geometry in the atlas' existing rings format."""
    value = polygonal(value)
    if value is None or value.is_empty:
        return []
    polygons = list(value.geoms) if isinstance(value, MultiPolygon) else [value]
    polygons = [p for p in polygons if isinstance(p, Polygon) and p.area > 1e-8]
    # Stable component ordering makes repeated exports byte-for-byte stable.
    polygons.sort(key=lambda p: tuple(round(float(x), 6) for x in p.bounds))

    def ring_coords(ring: Any) -> list[list[float]]:
        # Difference vertices are often intersections between source edges.
        # Keep the full GEOS precision so serialization cannot reintroduce a
        # sliver overlap that was absent from the actual mask.
        return [[float(x), float(y)] for x, y in ring.coords]

    output: list[Any] = []
    for p in polygons:
        part = [ring_coords(p.exterior)]
        holes = list(p.interiors)
        holes.sort(key=lambda h: tuple(round(float(x), 6) for x in h.bounds))
        part.extend(ring_coords(h) for h in holes)
        output.append(part)
    return output


def classification(parcel: dict[str, Any]) -> str:
    value = str(parcel.get("classification") or "unclassified").strip().lower()
    aliases = {
        "grand cru": "grand-cru",
        "grand_cru": "grand-cru",
        "premier cru": "premier-cru",
        "premier_cru": "premier-cru",
        "regional/unknown": "regional",
        "beaujolais cru": "beaujolais-cru",
        "beaujolais_cru": "beaujolais-cru",
    }
    value = aliases.get(value, value)
    return value if value in RANK else "unclassified"


def source_paths() -> list[Path]:
    return sorted(SOURCE_SCENES.glob("*.json"), key=lambda p: p.name)


def iter_scene_parcels(path: Path) -> Iterable[tuple[dict[str, Any], BaseGeometry]]:
    scene = json.loads(path.read_text(encoding="utf-8"))
    for parcel in scene.get("parcels", []):
        if not isinstance(parcel, dict):
            continue
        geometry = source_geometry(parcel)
        if geometry is not None and not geometry.is_empty and geometry.area > 1e-8:
            yield parcel, geometry


def build_global_unions(paths: list[Path]) -> tuple[dict[str, BaseGeometry], dict[str, Any]]:
    by_class: dict[str, list[BaseGeometry]] = defaultdict(list)
    counts: Counter[str] = Counter()
    sample: dict[str, Any] | None = None
    # A class only needs a global union when a lower-ranked class will be
    # masked by it.  This avoids the expensive regional union when there is no
    # unclassified geometry below it (the normal atlas export case).
    present: set[str] = set()
    scene_payloads: dict[Path, dict[str, Any]] = {}
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        scene_payloads[path] = payload
        for parcel in payload.get("parcels", []):
            if isinstance(parcel, dict):
                present.add(classification(parcel))
                counts[classification(parcel)] += 1
    needed = {cls for index, cls in enumerate(RANK) if any(lower in present for lower in RANK[index + 1:])}
    for path in paths:
        payload = scene_payloads[path]
        scene_parts: dict[str, list[BaseGeometry]] = defaultdict(list)
        for parcel in payload.get("parcels", []):
            if not isinstance(parcel, dict):
                continue
            cls = classification(parcel)
            if cls not in needed:
                continue
            geometry = source_geometry(parcel)
            if geometry is None or geometry.is_empty or geometry.area <= 1e-8:
                continue
            by_class[cls].append(geometry)
            scene_parts[cls].append(geometry)
        # Capture the strongest real Grand Cru overlap for the audit.  Prefer
        # a scene containing every lower class, but retain the best partial
        # candidate when no scene has all four classes.
        if scene_parts.get("grand-cru"):
            grand = unary_union(scene_parts["grand-cru"])
            overlaps = {c: unary_union(scene_parts[c]) for c in RANK[1:] if scene_parts.get(c)}
            areas = {c: float(grand.intersection(overlaps[c]).area) if c in overlaps else 0.0 for c in RANK[1:]}
            score = sum(areas.values()) + (1e12 if all(v > PAIR_TOLERANCE_M2 for v in areas.values()) else 0.0)
            if score > (sample["score"] if sample else -1.0):
                sample = {"scene": path.name, "beforeAreasM2": areas, "score": score}
    unions: dict[str, BaseGeometry] = {}
    for cls in RANK:
        parts = by_class.get(cls, [])
        unions[cls] = polygonal(unary_union(parts)) if parts else GeometryCollection()
    sample_report = {
        "scene": sample["scene"] if sample else None,
        "beforeAreasM2": sample["beforeAreasM2"] if sample else {},
    }
    return unions, {"parcelCounts": dict(counts), "sample": sample_report}


def higher_masks(unions: dict[str, BaseGeometry]) -> dict[str, BaseGeometry]:
    masks: dict[str, BaseGeometry] = {}
    accumulated: BaseGeometry = GeometryCollection()
    for cls in RANK:
        masks[cls] = accumulated
        if accumulated.is_empty:
            accumulated = unions[cls]
        elif not unions.get(cls, GeometryCollection()).is_empty:
            accumulated = polygonal(unary_union([accumulated, unions[cls]])) or GeometryCollection()
    return masks


def difference_geometry(geometry: BaseGeometry, mask: BaseGeometry) -> BaseGeometry | None:
    if mask is None or mask.is_empty:
        return geometry
    try:
        return polygonal(geometry.difference(mask))
    except Exception:
        repaired = polygonal(geometry)
        try:
            return polygonal(repaired.difference(mask)) if repaired is not None else None
        except Exception:
            return None


def atomic_gzip(path: Path, payload: bytes) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as stream:
                stream.write(payload)
            raw.flush()
            os.fsync(raw.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    return path.stat().st_size


def export(paths: list[Path], masks: dict[str, BaseGeometry]) -> dict[str, Any]:
    output_geoms: dict[str, list[BaseGeometry]] = defaultdict(list)
    output_bytes = 0
    raw_bytes = 0
    empty = 0
    written = 0
    for path in paths:
        scene = json.loads(path.read_text(encoding="utf-8"))
        output_parcels: list[dict[str, Any]] = []
        for parcel in scene.get("parcels", []):
            if not isinstance(parcel, dict):
                continue
            cls = classification(parcel)
            geometry = source_geometry(parcel)
            display = difference_geometry(geometry, masks[cls]) if geometry is not None else None
            parcel["displayClassification"] = cls
            if display is None or display.is_empty or display.area <= 1e-8:
                empty += 1
                continue
            parcel["rings"] = as_rings(display)
            if not parcel["rings"]:
                empty += 1
                continue
            verification = parcel.get("aocVerification")
            if isinstance(verification, dict):
                verification["displayAreaM2"] = round(float(display.area), 2)
                verification["displayAreaScope"] = "tier-exclusive masked display geometry"
            output_parcels.append(parcel)
        scene["parcels"] = output_parcels
        scene["displayClassification"] = {
            "version": 1,
            "field": "classification",
            "displayField": "displayClassification",
            "geometryField": "rings",
            "hierarchy": list(RANK),
            "maskScope": "global-source-scenes",
            "sourceGeometry": SOURCE_SCENES.name,
        }
        payload = json.dumps(scene, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        raw_bytes += len(payload)
        output_bytes += atomic_gzip(DIST_SCENES / (path.name + ".gz"), payload)
        # Audit the geometry that was actually serialized, rather than the
        # pre-serialization GEOS object.
        for parcel in output_parcels:
            geometry = source_geometry(parcel)
            if geometry is not None and not geometry.is_empty:
                output_geoms[classification(parcel)].append(geometry)
        written += 1
    return {
        "writtenScenes": written,
        "emptyMaskedParcels": empty,
        "rawBytes": raw_bytes,
        "compressedBytes": output_bytes,
        "outputGeometries": output_geoms,
    }


def union_area_by_class(geometries: dict[str, list[BaseGeometry]]) -> dict[str, BaseGeometry]:
    return {
        cls: (polygonal(unary_union(parts)) if parts else GeometryCollection())
        for cls, parts in geometries.items()
    }


def overlap_report(unions: dict[str, BaseGeometry]) -> dict[str, float]:
    report: dict[str, float] = {}
    for i, left in enumerate(RANK):
        for right in RANK[i + 1 :]:
            report[f"{left}∩{right}"] = float(unions.get(left, GeometryCollection()).intersection(unions.get(right, GeometryCollection())).area)
    return report


def audit(paths: list[Path], source_unions: dict[str, BaseGeometry], output: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    display_unions = union_area_by_class(output["outputGeometries"])
    before = overlap_report(source_unions)
    after = overlap_report(display_unions)
    sample_scene = metadata["sample"]["scene"]
    sample_after: dict[str, float] = {}
    if sample_scene:
        scene_path = DIST_SCENES / (sample_scene + ".gz")
        with gzip.open(scene_path, "rt", encoding="utf-8") as stream:
            scene = json.load(stream)
        scene_by_class: dict[str, list[BaseGeometry]] = defaultdict(list)
        for parcel in scene.get("parcels", []):
            geometry = source_geometry(parcel)
            if geometry is not None:
                scene_by_class[classification(parcel)].append(geometry)
        if scene_by_class.get("grand-cru"):
            grand = unary_union(scene_by_class["grand-cru"])
            for cls in RANK[1:]:
                if scene_by_class.get(cls):
                    sample_after[cls] = float(grand.intersection(unary_union(scene_by_class[cls])).area)
    positive_after = {k: v for k, v in after.items() if v > PAIR_TOLERANCE_M2}
    return {
        "sceneCount": len(paths),
        "parcelCounts": metadata["parcelCounts"],
        "writtenScenes": output["writtenScenes"],
        "emptyMaskedParcels": output["emptyMaskedParcels"],
        "rawBytes": output["rawBytes"],
        "compressedBytes": output["compressedBytes"],
        "compressionRatio": round(output["compressedBytes"] / output["rawBytes"], 6) if output["rawBytes"] else 0,
        "beforeInterTierOverlapM2": before,
        "afterInterTierOverlapM2": after,
        "positiveAfterInterTierOverlapM2": positive_after,
        "grandCruSample": {
            "scene": sample_scene,
            "beforeAreasM2": metadata["sample"]["beforeAreasM2"],
            "afterAreasM2": sample_after,
        },
    }


def audit_saved(paths: list[Path]) -> dict[str, Any]:
    """Audit the actual gzip deliverables without regenerating geometry."""
    geometries: dict[str, list[BaseGeometry]] = defaultdict(list)
    counts: Counter[str] = Counter()
    errors: list[str] = []
    retained_fields_equal = True
    sample: dict[str, Any] = {}
    for index, path in enumerate(paths, 1):
        with gzip.open(DIST_SCENES / (path.name + ".gz"), "rt", encoding="utf-8") as stream:
            scene = json.load(stream)
        source = json.loads(path.read_text(encoding="utf-8"))
        if {k: v for k, v in scene.items() if k not in ("parcels", "displayClassification")} != {k: v for k, v in source.items() if k != "parcels"}:
            retained_fields_equal = False
            errors.append(f"Non-parcel fields changed: {path.name}")
        if scene.get("displayClassification", {}).get("maskScope") != "global-source-scenes":
            errors.append(f"Missing global exclusion metadata: {path.name}")
        scene_geometries: dict[str, list[BaseGeometry]] = defaultdict(list)
        for parcel in scene.get("parcels", []):
            geometry = source_geometry(parcel)
            if geometry is None or geometry.is_empty:
                errors.append(f"Empty display geometry: {path.name}")
                continue
            cls = classification(parcel)
            counts[cls] += 1
            geometries[cls].append(geometry)
            scene_geometries[cls].append(geometry)
        if path.name == "aloxe-corton-21010.json" and scene_geometries.get("grand-cru"):
            local_unions = {cls: unary_union(scene_geometries.get(cls, [])) for cls in RANK}
            point = local_unions["grand-cru"].representative_point()
            sample = {"scene": path.name, "grandCruPoint": [point.x, point.y], "classesAtPoint": [cls for cls in RANK if local_unions[cls].covers(point)], "interTierOverlapM2": overlap_report(local_unions)}
        if index % 50 == 0:
            print(f"Audited {index}/{len(paths)} gzip scenes", flush=True)
    unions = {}
    for cls in RANK:
        print(f"Checking global {cls} display union", flush=True)
        unions[cls] = polygonal(unary_union(geometries.get(cls, []))) or GeometryCollection()
    overlaps = overlap_report(unions)
    positive = {key: value for key, value in overlaps.items() if value > PAIR_TOLERANCE_M2}
    report = {"sceneCount": len(paths), "parcelCounts": dict(counts), "nonParcelFieldsUnchanged": retained_fields_equal, "afterInterTierOverlapM2": overlaps, "positiveAfterInterTierOverlapM2": positive, "toleranceM2": PAIR_TOLERANCE_M2, "grandCruSample": sample, "errors": errors}
    return report


def main() -> int:
    global SOURCE_SCENES
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-count", type=int, default=EXPECTED_SCENES)
    parser.add_argument("--source-dir", type=Path, default=SOURCE_SCENES,
                        help="derived scene input directory; raw source-scenes is immutable")
    parser.add_argument("--audit-only", action="store_true", help="audit existing gzip scenes without regenerating them")
    parser.add_argument("--report", type=Path, help="save the final JSON audit report")
    args = parser.parse_args()
    SOURCE_SCENES = args.source_dir
    paths = source_paths()
    if len(paths) != args.expected_count:
        raise SystemExit(f"Expected {args.expected_count} source scenes, found {len(paths)}")
    if not args.audit_only:
        unions, metadata = build_global_unions(paths)
        masks = higher_masks(unions)
        output = export(paths, masks)
        del unions, masks, output
    report_path = args.report or (ROOT / 'work' / 'exclusive-classification-audit.json')
    command = [sys.executable, str(Path(__file__).with_name('repair_exclusive_precision.py')), '--report', str(report_path), '--source-dir', str(SOURCE_SCENES)]
    if args.audit_only:
        command.append('--check-only')
    for attempt in range(4 if not args.audit_only else 1):
        result = subprocess.run(command, check=False)
        if result.returncode == 0:
            return 0
        if not report_path.exists():
            return result.returncode
        report = json.loads(report_path.read_text(encoding='utf-8'))
        if not report.get('nonParcelFieldsUnchanged') or not report.get('positiveOverlapUpperBoundsM2'):
            return result.returncode
        print(f'Rechecking remaining overlay faces after precision pass {attempt + 1}', flush=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
