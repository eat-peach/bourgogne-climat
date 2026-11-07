#!/usr/bin/env python3
"""Apply verified AOC interpretation metadata to a complete scene export.

The source scenes and the official extract are inputs.  This script writes a
new directory and only changes display rings for the verified physical
Chambertin climat; legal geometry and source identifiers remain in metadata.
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Iterable

from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, box, shape, mapping
from shapely import make_valid
from shapely.ops import unary_union
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_exclusive_parcels import source_geometry as canonical_source_geometry

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OFFICIAL = ROOT / "work" / "reference-audit" / "official" / "2026-10-19-inao-burgundy-grand-crus.geojson"
INAO_DATASET = "https://www.data.gouv.fr/datasets/delimitation-parcellaire-des-aoc-viticoles-de-linao"
CHAMBERTIN_CAHIER = "https://info.agriculture.gouv.fr/gedei/site/bo-agri/document_administratif-7b3c14e3-4105-489a-91a6-3e8b7ee78017/telechargement"
SNAPSHOT = "2026-10-19"


def norm(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", re.sub(r"[-–—]+", " ", text.casefold())).strip()


def _polygonal(geometry):
    if geometry is None or geometry.is_empty:
        return GeometryCollection()
    try:
        geometry = make_valid(geometry)
    except Exception:
        try:
            geometry = geometry.buffer(0)
        except Exception:
            return GeometryCollection()
    if isinstance(geometry, (Polygon, MultiPolygon)):
        return geometry
    parts = [_polygonal(g) for g in getattr(geometry, "geoms", ())]
    parts = [g for g in parts if not g.is_empty]
    return unary_union(parts) if parts else GeometryCollection()


def geometry_from_rings(rings: Any):
    return canonical_source_geometry({"rings": rings}) or GeometryCollection()


def geometry_from_record(record: dict[str, Any]):
    if record.get("geometry"):
        return _polygonal(shape(record["geometry"]))
    return geometry_from_rings(record.get("rings"))


def rings_from_geometry(geometry) -> list:
    geometry = _polygonal(geometry)
    if geometry.is_empty:
        return []
    parts = list(geometry.geoms) if isinstance(geometry, MultiPolygon) else [geometry]
    return [[list(map(list, polygon.exterior.coords))] + [list(map(list, ring.coords)) for ring in polygon.interiors] for polygon in parts]


def load_official(path: Path) -> tuple[dict[tuple[str, str], list], dict[tuple[str, str], float]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    grouped: dict[tuple[str, str], list] = {}
    for feature in payload.get("features", []):
        props = feature.get("properties") or {}
        key = (norm(props.get("app")), norm(props.get("denom")))
        if not key[0] or not key[1]:
            continue
        grouped.setdefault(key, []).append(feature)
    unions = {}
    for key, rows in grouped.items():
        unions[key] = _polygonal(unary_union([_polygonal(shape(row["geometry"])) for row in rows]))
    return grouped, {key: float(geom.area) for key, geom in unions.items()}


CHAMBERTIN = ("chambertin", "chambertin")
BEZE = ("chambertin clos de beze", "chambertin clos de beze")
FAMILY_SCOPE = {
    "charmes chambertin": ("shared-eligibility", ["Charmes-Chambertin", "Mazoyères-Chambertin"]),
    "mazoyeres chambertin": ("shared-eligibility", ["Charmes-Chambertin", "Mazoyères-Chambertin"]),
    "corton": ("legal-aoc", ["Corton", "Corton-Charlemagne", "Charlemagne"]),
    "corton charlemagne": ("legal-aoc", ["Corton", "Corton-Charlemagne", "Charlemagne"]),
    "charlemagne": ("legal-aoc", ["Corton", "Corton-Charlemagne", "Charlemagne"]),
    "chablis grand cru": ("legal-aoc", ["Chablis Grand Cru"]),
}
CHABLIS_NAMED = {"blanchot", "bougros", "grenouilles", "les clos", "preuses", "valmur", "vaudesir"}


def _official_key(record: dict[str, Any]) -> tuple[str, str]:
    app = record.get("officialAppellation") or record.get("app") or record.get("appellation") or ""
    denom = record.get("officialDenomination") or record.get("denom") or record.get("name") or app
    return norm(app), norm(denom)


def _contract(*, app: str, denom: str, tier: str, scope: str, status: str,
              physical_status: str, physical_area: float | None, legal_area: float | None,
              display_area: float, eligible: list[str], note: str, evidence: list[str]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "snapshot": SNAPSHOT, "officialAppellation": app, "officialDenomination": denom,
        "officialTier": tier, "geometryScope": scope, "verificationStatus": status,
        "physicalStatus": physical_status, "legalAreaM2": round(float(legal_area or 0), 2),
        "displayAreaM2": round(float(display_area), 2), "eligibleAppellations": eligible,
        "sourceUrl": INAO_DATASET, "evidenceUrls": evidence, "note": note,
    }
    if physical_area is not None:
        result["physicalAreaM2"] = round(float(physical_area), 2)
    return result


def _tier(record: dict[str, Any], official_props: dict[str, Any]) -> str:
    nested = record.get("aocVerification")
    if isinstance(nested, dict) and nested.get("officialTier"):
        return str(nested["officialTier"])
    existing = str(record.get("officialTier") or "").strip()
    if existing:
        return existing
    text = " ".join(str(record.get(k) or "") for k in ("type_denom", "categorie", "signe", "classification"))
    text += " " + " ".join(str(official_props.get(k) or "") for k in ("type_denom", "categorie", "signe", "grp_name1"))
    lowered = text.casefold()
    if "beaujolais" in lowered:
        return "Beaujolais Cru"
    if "regional" in lowered or norm(record.get("appellation")) in {"bourgogne", "bourgogne aligote"}:
        return "AOC (outside Burgundy hierarchy)"
    if "premier" in lowered:
        return "Premier Cru"
    explicit = str(official_props.get("officialTier") or "").strip()
    return explicit or "Grand Cru"


def refine(source: Path, out: Path, official_path: Path = DEFAULT_OFFICIAL) -> dict[str, Any]:
    source = source.resolve()
    out = out.resolve()
    website_root = (ROOT / "website").resolve()
    immutable_source = (ROOT / "website" / "source-scenes").resolve()
    immutable_official = official_path.resolve()
    if out == source:
        raise ValueError("source and out must be different directories")
    if out == immutable_source or out == immutable_official:
        raise ValueError("refusing to write over immutable source data")
    if website_root not in out.parents and source.parent.name != "website":
        raise ValueError(f"output must be inside {website_root}")
    if out.exists():
        raise FileExistsError(f"output already exists; choose a new directory: {out}")
    rows, legal_areas = load_official(official_path)
    if CHAMBERTIN not in legal_areas or BEZE not in legal_areas:
        raise ValueError("official extract lacks Chambertin or Chambertin-Clos de Bèze")
    chambertin_union = _polygonal(unary_union([_polygonal(shape(f["geometry"])) for f in rows[CHAMBERTIN]]))
    beze_geometry = _polygonal(unary_union([_polygonal(shape(f["geometry"])) for f in rows[BEZE]]))
    physical_chambertin = _polygonal(chambertin_union.difference(beze_geometry))
    physical_area = float(physical_chambertin.area)
    beze_area = float(beze_geometry.area)
    out.mkdir(parents=True)
    updated = 0
    physical_count = 0
    for path in sorted(source.glob("*.json")):
        scene = json.loads(path.read_text(encoding="utf-8"))
        bounds = scene.get("bounds") or []
        extent = box(*map(float, bounds)) if len(bounds) == 4 else None
        for collection_name in ("parcels", "climats"):
            for record in scene.get(collection_name, []):
                if not isinstance(record, dict):
                    continue
                app, denom = _official_key(record)
                key_name = norm(record.get("name") or record.get("appellation") or denom)
                # Named-climat records in the scene export may not carry the
                # official app/denom columns; exact known names are still
                # matched against the official subset.
                if key_name == "chambertin":
                    app, denom = CHAMBERTIN
                elif key_name in {"chambertin clos de beze", "clos de beze"}:
                    app, denom = BEZE
                official_rows = rows.get((app, denom), [])
                official_props = (official_rows[0].get("properties") or {}) if official_rows else {}
                display_geom = geometry_from_record(record)
                physical = key_name == "chambertin" and (app, denom) == CHAMBERTIN
                physical_beze = key_name in {"chambertin clos de beze", "clos de beze"} and (app, denom) == BEZE
                if physical:
                    record["legalRings"] = rings_from_geometry(chambertin_union)
                    display_geom = physical_chambertin.intersection(extent) if extent else physical_chambertin
                    record["physicalRings"] = rings_from_geometry(display_geom)
                    record["rings"] = record["physicalRings"]
                    physical_count += 1
                elif physical_beze:
                    record["legalRings"] = rings_from_geometry(beze_geometry)
                    display_geom = beze_geometry.intersection(extent) if extent else beze_geometry
                    record["physicalRings"] = rings_from_geometry(display_geom)
                    record["rings"] = record["physicalRings"]
                area = float(display_geom.area)
                if not official_rows:
                    # Preserve local named-climat records, but do not claim an
                    # official match merely because a name resembles an AOC.
                    continue
                official_app = str(official_props.get("app") or record.get("officialAppellation") or record.get("appellation") or "")
                official_denom = str(official_props.get("denom") or record.get("officialDenomination") or record.get("name") or official_app)
                scope, overlap_family = FAMILY_SCOPE.get(app, ("legal-denomination", []))
                eligible = [official_app]
                if app == "chablis grand cru" and denom != "chablis grand cru":
                    scope, eligible = "legal-denomination", ["Chablis Grand Cru"]
                if physical or physical_beze:
                    scope, eligible = "physical-climat", ["Chambertin"]
                    if physical_beze:
                        eligible = ["Chambertin", "Chambertin-Clos de Bèze"]
                elif app in {"charmes chambertin", "mazoyeres chambertin"}:
                    eligible = ["Charmes-Chambertin", "Mazoyères-Chambertin"]
                legal = legal_areas.get((app, denom))
                note = "The display area covers this mapped fragment."
                if physical:
                    note += " Physical Chambertin is the official Chambertin AOC union minus official Chambertin-Clos de Bèze; derived-supported and corroborated by the effective cahier des charges and Coates 2008 12.9 ha climat figure."
                elif physical_beze:
                    note += f" Physical Chambertin-Clos de Bèze retains the official {beze_area / 10000:.4f} ha named-climat union from the snapshot; the paired Chambertin physical display is its official AOC residual."
                elif app in FAMILY_SCOPE:
                    note += " Overlapping same-tier legal eligibility is retained; no arbitrary physical partition is asserted."
                record["geometryScope"] = scope
                record["eligibleAppellations"] = eligible
                if overlap_family:
                    record["overlapFamily"] = overlap_family
                record["legalAreaM2"] = round(float(legal), 2)
                record["displayAreaM2"] = round(area, 2)
                record["sourceUrl"] = INAO_DATASET
                source_text = " ".join(str(official_props.get(k) or "") for k in ("type_denom", "categorie", "signe", "denom"))
                if "premier cru" in source_text.casefold() or "1er cru" in source_text.casefold():
                    record["classification"] = "premier-cru"
                record["aocVerification"] = _contract(app=official_app, denom=official_denom, tier=_tier(record, official_props), scope=scope,
                    status="official-source-matched", physical_status="derived-supported" if (physical or physical_beze) else "unverified",
                    physical_area=physical_area if physical else (beze_area if physical_beze else None), legal_area=legal, display_area=area,
                    eligible=eligible, note=note, evidence=[INAO_DATASET, CHAMBERTIN_CAHIER] if physical else [INAO_DATASET])
                updated += 1
        (out / path.name).write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"source": str(source), "output": str(out), "sceneCount": len(list(source.glob("*.json"))),
            "updatedRecords": updated, "physicalChambertinRecords": physical_count,
            "physicalChambertinAreaM2": round(physical_area, 2)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--official", type=Path, default=DEFAULT_OFFICIAL)
    args = parser.parse_args()
    print(json.dumps(refine(args.source, args.out, args.official), ensure_ascii=True))


if __name__ == "__main__":
    main()
