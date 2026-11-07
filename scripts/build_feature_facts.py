"""Build a provenance-first facts catalog for selectable source features.

The atlas displays clipped geometry after scene composition.  This catalog is
computed from the untouched source-scene geometry so its mapped area remains
stable and is never confused with an official planted-vineyard area.
"""
from __future__ import annotations

import argparse
import json
import math
from shapely.geometry import Polygon
from shapely.ops import unary_union
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENES = ROOT / "website" / "corrected-source-scenes"
DEFAULT_OUT = ROOT / "website" / "scripts" / "data" / "feature-facts.json"
def ring_area(points):
    return abs(sum(float(a[0]) * float(b[1]) - float(b[0]) * float(a[1])
                   for a, b in zip(points, points[1:])) / 2.0)


def geom_area(feature):
    total = 0.0
    # Scene compact geometry: rings = [polygon rings], each polygon has outer
    # ring followed by holes.  Be tolerant of a single polygon shape.
    polygons = feature.get("rings") or []
    # Most atlas source features use ``rings = [outer-ring, ...]`` where each
    # item is an independent polygon part.  Also accept GeoJSON-like
    # ``rings = [[outer, hole], ...]`` for future source exports.
    if polygons and polygons[0] and isinstance(polygons[0][0][0], (int, float)):
        return sum(ring_area(part) for part in polygons)
    for polygon in polygons:
        if not polygon:
            continue
        total += ring_area(polygon[0])
        total -= sum(ring_area(hole) for hole in polygon[1:])
    return max(0.0, total)


def representative_point(feature):
    polygons = feature.get("rings") or []
    if polygons and polygons[0] and isinstance(polygons[0][0][0], (int, float)):
        parts = [Polygon(part) for part in polygons if len(part) >= 4]
    else:
        parts = [Polygon(poly[0], poly[1:]) for poly in polygons if poly and len(poly[0]) >= 4]
    valid = [part for part in parts if not part.is_empty and part.is_valid]
    if not valid:
        return None
    point = unary_union(valid).representative_point()
    return [float(point.x), float(point.y)]


def sample_height(scene, point):
    """Nearest source-grid estimate; explicitly not a survey/parcel altitude."""
    if not point or not scene.get("heights") or not scene.get("bounds"):
        return None, None
    if scene.get("coverage", {}).get("terrainEdgeFillUsed"):
        return None, None
    x0, y0, x1, y1 = map(float, scene["bounds"])
    n = int(scene.get("gridSize") or 0)
    if n < 2:
        return None, None
    # Do not clamp a centroid outside the actual source terrain extent; that
    # would silently turn an unavailable sample into an edge value.
    if not (x0 <= point[0] <= x1 and y0 <= point[1] <= y1):
        return None, None
    fx = max(0.0, min(n - 1.0, (point[0] - x0) / (x1 - x0) * (n - 1)))
    fy = max(0.0, min(n - 1.0, (point[1] - y0) / (y1 - y0) * (n - 1)))
    ix, iy = round(fx), round(fy)
    value = scene["heights"][iy * n + ix]
    if value is None or not math.isfinite(float(value)):
        return None, None
    resolution = max((x1 - x0) / (n - 1), (y1 - y0) / (n - 1))
    return round(float(value), 1), round(resolution, 1)


def source_url(feature, layer):
    if feature.get("source"):
        return feature["source"]
    if layer == "climats" and feature.get("id") is not None:
        return f"https://bourgogne-maps.fr/geo/lieuxdit/{feature['id']}.geojson"
    return None


def build(out: Path):
    records = []
    counts = {"climats": 0, "parcels": 0}
    for path in sorted(SCENES.glob("*.json")):
        scene = json.loads(path.read_text(encoding="utf-8"))
        scene_id = str(scene.get("id") or path.stem)
        scene_name = scene.get("name") or path.stem
        for layer in ("climats", "parcels"):
            for ordinal, feature in enumerate(scene.get(layer) or []):
                if not feature.get("rings"):
                    continue
                p = representative_point(feature)
                altitude, resolution = sample_height(scene, p)
                source_id = str(feature.get("id") or ordinal)
                # Ordinal is required because INAO source IDs repeat for
                # multipart/clipped records and across communes.
                key = f"{layer}:{scene_id}:{source_id}:{ordinal}"
                row = {
                    "key": key,
                    "layer": layer,
                    "sourceId": source_id,
                    "sourceVillageId": scene_id,
                    "sourceVillageName": scene_name,
                    "name": feature.get("name") or feature.get("nom") or None,
                    "mappedAreaM2": round(geom_area(feature), 2),
                    "mappedAreaStatus": "available" if geom_area(feature) > 0 else "not_available",
                    "mappedAreaBasis": "original source-scene geometry in EPSG:2154; holes subtracted; display clipping excluded",
                    "altitude": {
                        "valueM": altitude,
                        "method": "nearest source-scene terrain-grid cell at Shapely representative point inside original source geometry",
                        "resolutionM": resolution,
                        "source": "IGN RGE ALTI terrain already sampled into source scene",
                        "status": "estimate" if altitude is not None else "not_available",
                    },
                    "sourceUrl": source_url(feature, layer),
                }
                if layer == "parcels":
                    for field in ("classification", "appellation", "sourceAppellation", "officialAppellation", "officialDenomination", "idApp", "idDenom", "insee", "legalAreaM2", "displayAreaM2", "geometryScope", "eligibleAppellations", "aocVerification", "sourceUrl", "legalAocEligibility", "physicalScopeStatus", "physicalScopeEvidence", "physicalScopeAreaM2"):
                        if feature.get(field) is not None:
                            row[field] = feature[field]
                    row["sourceUrl"] = "https://www.data.gouv.fr/datasets/delimitation-parcellaire-des-aoc-viticoles-de-linao"
                records.append(row)
                counts[layer] += 1
    payload = {
        "schemaVersion": 1,
        "generatedFrom": "website/corrected-source-scenes/*.json (derived from immutable website/source-scenes/*.json)",
        "generatedAt": "2026-10-22",
        "featureKey": "layer:sourceVillageId:sourceId:ordinal",
        "notes": [
            "mappedAreaM2 is the area of original source geometry in EPSG:2154, not an official planted-vineyard/hectare statistic",
            "altitude is a nearest-cell estimate from the scene terrain grid and is not a parcel survey",
        ],
        "citations": {
            "terrain": {"title": "IGN RGE ALTI", "url": "https://geoservices.ign.fr/rgealti"},
            "namedPlaces": {"title": "Bourgogne Maps lieux-dits", "url": "https://bourgogne-maps.fr/"},
            "aoc": {"title": "INAO parcel delimitation of viticultural AOCs", "url": "https://www.data.gouv.fr/datasets/delimitation-parcellaire-des-aoc-viticoles-de-linao"},
        },
        "counts": counts,
        "features": records,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"out": str(out), "counts": counts, "total": len(records)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    build(parser.parse_args().out)
