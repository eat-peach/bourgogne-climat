#!/usr/bin/env python3
"""Create corrected scene inputs from immutable source-scenes.

This is a metadata repair only.  It never edits the raw scene directory and
does not alter parcel rings.  The output is a derived directory consumed by
the scene/exclusive export pipeline and carries the source and interpretation
provenance needed to distinguish legal AOC eligibility from display class.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import unicodedata
from pathlib import Path
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.geometry import box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_exclusive_parcels import as_rings as serialize_rings  # noqa: E402
from make_exclusive_parcels import source_geometry  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "website" / "source-scenes"
DEFAULT_OUT = ROOT / "website" / "corrected-source-scenes"
CLASS_FILE = ROOT / "website" / "scripts" / "appellation_classes.json"
INAO_URL = "https://www.data.gouv.fr/datasets/delimitation-parcellaire-des-aoc-viticoles-de-linao"
REPAIR_VERSION = 1


def norm(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return re.sub(r"[\s-]+", " ", text.casefold()).strip()


def source_code_value(value: object) -> str | None:
    """DBF missing strings can arrive as truthy float NaN values."""
    text = str(value).strip() if value is not None else ""
    return None if text.casefold() in {"", "nan", "none", "null", "<na>"} else text


def load_classes() -> tuple[dict[str, str], dict[str, str]]:
    payload = json.loads(CLASS_FILE.read_text(encoding="utf-8"))
    by_key: dict[str, str] = {}
    canonical: dict[str, str] = {}
    for entry in payload.get("entries", []):
        name = str(entry["name"])
        category = str(entry["category"]).casefold().replace(" ", "-")
        by_key[norm(name)] = category
        canonical[norm(name)] = name
        for alias in entry.get("aliases", []):
            by_key[norm(alias)] = category
            canonical[norm(alias)] = name
    return by_key, canonical


def classify(parcel: dict, classes: dict[str, str]) -> str:
    # Only explicit INAO designation fields may trigger a tier; a place name
    # alone never promotes a feature.
    text = " ".join(str(parcel.get(k) or "") for k in ("type_denom", "categorie", "signe", "denom", "app")).casefold()
    if "premier cru" in text or "1er cru" in text:
        return "premier-cru"
    if "grand cru" in text:
        return "grand-cru"
    for key in ("appellation", "name", "app", "denom"):
        category = classes.get(norm(parcel.get(key)))
        if category:
            # Keep Beaujolais communal crus in the atlas village display bucket;
            # retain their official tier separately in aocVerification.
            return "village" if category == "beaujolais-cru" else category
    if "village" in text or "communal" in text:
        return "village"
    if "regional" in text or "bourgogne" in text:
        return "regional"
    return "unclassified"


def repair(source: Path, out: Path) -> dict:
    source = source.resolve(); out = out.resolve()
    site_root = (ROOT / "website").resolve()
    if out == source or site_root not in out.parents or out.name == "source-scenes":
        raise ValueError(f"Refusing unsafe derived output path: {out}")
    classes, canonical = load_classes()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    counts: dict[str, int] = {}
    aliases: list[dict[str, str]] = []
    scenes = sorted(source.glob("*.json"))
    repaired_scenes = []
    for path in scenes:
        scene = json.loads(path.read_text(encoding="utf-8"))
        for parcel in scene.get("parcels", []):
            if not isinstance(parcel, dict):
                continue
            original_name = str(parcel.get("appellation") or parcel.get("name") or "")
            key = norm(original_name)
            if key in canonical and original_name != canonical[key]:
                aliases.append({"scene": path.name, "from": original_name, "to": canonical[key]})
                parcel["appellation"] = canonical[key]
                # Keep the source label for provenance while exposing a stable
                # canonical label to selectors and facts.
                parcel["sourceAppellation"] = original_name
            cls = classify(parcel, classes)
            parcel["classification"] = cls
            parcel["legalAocEligibility"] = {
                "status": "eligible",
                "appellation": parcel.get("appellation") or parcel.get("name"),
                "source": INAO_URL,
                "scope": "INAO parcel-delimitation AOC record; legal eligibility metadata, not an exclusive physical climat boundary",
            }
            parcel["physicalScopeStatus"] = "unknown"
            counts[cls] = counts.get(cls, 0) + 1
        # Parent AOC/physical-scope interpretation applies to named-place
        # records too.  Chambertin is the one verified physical split: the
        # effective cahier names Chambertin and Clos de Bèze as the two lieux-
        # dits, and the residual is corroborated by the Coates map/area note.
        for feature in scene.get("climats", []):
            name = norm(feature.get("name") or feature.get("nom"))
            feature["physicalScopeStatus"] = "unknown"
            feature["legalAocEligibility"] = {
                "status": "parent_or_named_place_reference",
                "appellation": feature.get("name") or feature.get("nom"),
                "source": INAO_URL,
                "scope": "named-place geometry is not itself proof of an exclusive legal AOC boundary",
            }
            if name in {"charmes chambertin", "mazoyeres chambertin", "corton", "corton charlemagne", "chablis grand cru"}:
                feature["physicalScopeStatus"] = "unknown_legal_parent_or_overlap"
            elif name == "chambertin":
                feature["physicalScopeStatus"] = "verified_physical_climat_scope"
                feature["physicalScopeEvidence"] = {
                    "method": "INAO Chambertin AOC minus Clos de Bèze named-climat geometry",
                    "support": [
                        "effective Chambertin cahier des charges names both lieux-dits",
                        "Coates 2008 Chambertin climat area 12.9 ha",
                        "official 2026-10-19 extract and local comparison audit",
                    ],
                    "caveat": "the geometry is a derived physical-climat display scope; subtraction alone is not legal-boundary proof",
                }
        repaired_scenes.append(scene)
    # Use the union of verified Clos de Bèze named-place geometry to derive the
    # Chambertin display scope without touching parcels/legal AOC footprints.
    beze = []
    for scene in repaired_scenes:
        for feature in scene.get("climats", []):
            if norm(feature.get("name") or feature.get("nom")) in {"chambertin clos de beze", "clos de beze"}:
                g = source_geometry(feature)
                if g is not None and not g.is_empty:
                    beze.append(g)
    beze_union = unary_union(beze) if beze else GeometryCollection()
    for scene in repaired_scenes:
        for feature in scene.get("climats", []):
            if norm(feature.get("name") or feature.get("nom")) == "chambertin" and not beze_union.is_empty:
                g = source_geometry(feature)
                if g is not None:
                    clipped = g.difference(beze_union).buffer(0)
                    feature["rings"] = serialize_rings(clipped)
                    feature["physicalScopeAreaM2"] = round(float(clipped.area), 2)
        scene["aocDataRepair"] = {
            "version": REPAIR_VERSION,
            "source": "website/source-scenes/*.json",
            "sourceDate": "2026-10-19",
            "classificationTable": "website/scripts/appellation_classes.json",
            "inaoParcelSource": INAO_URL,
            "legalEligibilityField": "legalAocEligibility",
            "physicalScopeField": "physicalScopeStatus",
            "physicalScopePolicy": "unknown unless a separately verified named-climat boundary is supplied; legal parent overlap is retained as metadata",
            "displayPolicy": "display class may be made tier-exclusive downstream; same-tier overlaps are preserved",
        }
    for scene, path in zip(repaired_scenes, scenes):
        (out / path.name).write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # Correct the named-place display scope globally after all scene clips are
    # available. Legal parcel rings above remain full official eligibility
    # records; only the named-place highlight is derived here.
    output_scenes = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(out.glob("*.json"))]
    beze = []
    for scene in output_scenes:
        for feature in scene.get("climats", []):
            if norm(feature.get("name") or feature.get("nom")) in {"chambertin clos de beze", "clos de beze"}:
                geom = source_geometry(feature)
                if geom is not None and not geom.is_empty:
                    beze.append(geom)
    beze_union = unary_union(beze) if beze else GeometryCollection()
    for scene in output_scenes:
        for feature in scene.get("climats", []):
            name = norm(feature.get("name") or feature.get("nom"))
            feature.setdefault("physicalScopeStatus", "unknown")
            feature.setdefault("legalAocEligibility", {"status": "parent_or_named_place_reference", "source": INAO_URL})
            if name == "chambertin" and not beze_union.is_empty:
                geom = source_geometry(feature)
                if geom is not None:
                    clipped = geom.difference(beze_union).buffer(0)
                    feature["rings"] = serialize_rings(clipped)
                    feature["physicalScopeStatus"] = "verified_physical_climat_scope"
                    feature["physicalScopeAreaM2"] = round(float(clipped.area), 2)
                    feature["physicalScopeEvidence"] = {"method": "official Chambertin AOC minus Clos de Bèze named-climat geometry",
                        "caveat": "derived display scope; subtraction alone is not legal-boundary proof"}
        (out / f"{scene.get('id')}.json").write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = {"version": REPAIR_VERSION, "source": str(source), "output": str(out), "sceneCount": len(scenes), "parcelCounts": counts, "aliasCorrections": aliases}
    report_path = ROOT / "work" / "aoc-data-repair-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def repair_from_official_shp(source: Path, out: Path, shp: Path) -> dict:
    """Build corrected scenes with the 2026-10-19 official parcel rows.

    Geometry is clipped only to each scene's existing contextual bounds. The
    full official feature area is retained as ``legalAreaM2`` metadata.
    """
    import geopandas as gpd
    source = source.resolve(); out = out.resolve()
    site_root = (ROOT / "website").resolve()
    if out == source or site_root not in out.parents or out.name == "source-scenes":
        raise ValueError(f"Refusing unsafe derived output path: {out}")
    classes, canonical = load_classes()
    all_official = gpd.read_file(shp, encoding="utf-8").to_crs(2154)
    all_official["_effective_insee"] = all_official.apply(
        lambda row: source_code_value(row.get("insee")) or source_code_value(row.get("insee2011")) or "", axis=1)
    fallback_count = int(all_official["insee"].isna().sum()) if "insee" in all_official else 0
    scenes = sorted(source.glob("*.json"))
    scope_codes = {str(p.stem).rsplit("-", 1)[-1] for p in scenes}
    # INSEE retired 69159 in favor of 69114 for Porte des Pierres Dorées;
    # retain the atlas/current code while accepting the official 2020 code.
    code_aliases = {"69114": "69159", "71042": "71492"}
    code_aliases_multi = {"69114": {"69114", "69159"}, "71042": {"71042", "71492"}}
    official_scope_codes = scope_codes | set(code_aliases.values())
    for values in code_aliases_multi.values():
        official_scope_codes |= values
    official = all_official
    official = official[official["_effective_insee"].isin(official_scope_codes)].copy()
    scoped_identities = set(zip(official["app"].astype(str), official["denom"].astype(str))) if len(official) else set()
    known_keys = set(classes)
    outside_rows = []
    for _, row in all_official.iterrows():
        row_code = str(row.get("_effective_insee") or "")
        if row_code in official_scope_codes:
            continue
        if norm(row.get("app")) in known_keys or norm(row.get("denom")) in known_keys:
            outside_rows.append({"insee": row_code, "app": str(row.get("app") or ""),
                                 "denom": str(row.get("denom") or ""), "idApp": str(row.get("id_app") or ""),
                                 "idDenom": str(row.get("id_denom") or "")})
    legal_areas = {}
    full_for_identities = all_official[all_official.apply(lambda row: (str(row.get("app")), str(row.get("denom"))) in scoped_identities, axis=1)]
    for key, group in full_for_identities.groupby(["app", "denom"], dropna=False):
        geom = unary_union([g for g in group.geometry if g is not None and not g.is_empty])
        legal_areas[tuple(str(x) for x in key)] = float(geom.area)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    counts: dict[str, int] = {}
    for path in scenes:
        scene = json.loads(path.read_text(encoding="utf-8"))
        bounds = scene.get("bounds") or []
        code = str(scene.get("id") or path.stem).rsplit("-", 1)[-1]
        # Export each official row into its owning atlas commune. This keeps
        # the 3,383-row official scope deterministic while legalAreaM2 below
        # remains a global AOC union across all scoped communes.
        source_codes = code_aliases_multi.get(code, {code})
        frame = official[official["_effective_insee"].isin(source_codes)]
        parcels = []
        for index, row in frame.iterrows():
            full = row.geometry
            # Preserve the complete official owning-commune parcel geometry.
            # Scene bounds remain terrain/context bounds; AOC coverage can
            # extend beyond them and is exposed through a separate index field.
            clipped = full
            if clipped.is_empty:
                continue
            app_name = str(row.get("app") or "")
            denom_name = str(row.get("denom") or "")
            name = denom_name or app_name
            key = norm(name)
            display_name = canonical.get(key, name)
            row_data = {"appellation": app_name, "name": denom_name, "app": app_name, "denom": denom_name,
                        "type_denom": row.get("type_denom"), "categorie": row.get("categorie"), "signe": row.get("signe")}
            aoc_key = (app_name, denom_name)
            display_class = classify(row_data, classes)
            explicit_premier = bool(re.search(r"premier cru|1er cru", f"{app_name} {denom_name}", re.I))
            category = classes.get(key) or classes.get(norm(app_name))
            if explicit_premier:
                official_tier = "Premier Cru"
            elif category == "beaujolais-cru":
                official_tier = "Beaujolais Cru"
            elif key == "coteaux du lyonnais":
                official_tier = "AOC (outside Burgundy hierarchy)"
            elif category == "regional":
                official_tier = "Regional"
            elif category == "village":
                official_tier = "Village"
            elif category == "grand-cru":
                official_tier = "Grand Cru"
            elif category == "premier-cru":
                official_tier = "Premier Cru"
            else:
                official_tier = "Unknown"
            legal_area = round(legal_areas.get(aoc_key, float(full.area)), 2)
            display_area = round(float(clipped.area), 2)
            verification = {
                "snapshot": "2026-10-19",
                "officialAppellation": app_name,
                "officialDenomination": denom_name,
                "officialTier": official_tier,
                "geometryScope": "legal-aoc" if norm(app_name) == norm(denom_name) else "legal-denomination",
                "verificationStatus": "official-source-matched",
                "physicalStatus": "unverified",
                "legalAreaM2": legal_area,
                "displayAreaM2": display_area,
                "eligibleAppellations": [display_name],
                "sourceUrl": INAO_URL,
                "evidenceUrls": [INAO_URL],
                "note": "Official AOC legal geometry and eligibility are matched to the 2026-10-19 source snapshot; this does not prove an exclusive named-climat boundary.",
            }
            data = {"id": str(row.get("id_aire") or row.get("id_app") or index),
                    "name": display_name, "appellation": display_name,
                    "officialAppellation": app_name, "officialDenomination": denom_name,
                    "idApp": str(row.get("id_app") or ""), "idDenom": str(row.get("id_denom") or ""),
                    "insee": str(row.get("_effective_insee") or ""),
                    "sourceCommuneCode": {"insee2020": source_code_value(row.get("insee")),
                                          "insee2011": source_code_value(row.get("insee2011")),
                                          "basis": "insee" if source_code_value(row.get("insee")) else "insee2011-fallback"},
                    "sourceAppellation": name if display_name != name else None,
                    "rings": serialize_rings(clipped), "classification": display_class,
                    "sourceOfficialId": str(row.get("id_aire") or row.get("id_app") or index),
                    "legalAreaM2": legal_area,
                    "displayAreaM2": display_area,
                    "geometryScope": verification["geometryScope"],
                    "eligibleAppellations": [display_name],
                    "sourceUrl": INAO_URL,
                    "aocVerification": verification,
                    "legalAocEligibility": {"status": "eligible", "appellation": display_name, "source": INAO_URL,
                                             "scope": "official 2026-10-19 INAO parcel geometry; legal eligibility metadata"},
                    "physicalScopeStatus": "unknown"}
            data = {k: v for k, v in data.items() if v is not None}
            parcels.append(data)
            counts[data["classification"]] = counts.get(data["classification"], 0) + 1
        # Preserve all non-parcel layers and metadata while replacing parcel
        # rows with the official snapshot for this commune.
        scene["parcels"] = parcels
        scene["aocDataRepair"] = {"version": REPAIR_VERSION, "source": "2026-10-19 official INAO SHP",
                                   "sourcePath": str(shp), "sourceDate": "2026-10-19",
                                   "classificationTable": "website/scripts/appellation_classes.json",
                                   "legalEligibilityField": "legalAocEligibility",
                                   "physicalScopeField": "physicalScopeStatus",
                                   "physicalScopePolicy": "legal parent overlaps retained; named physical boundaries require separate evidence",
                                   "displayPolicy": "display class may be tier-exclusive downstream; same-tier overlaps are preserved"}
        (out / path.name).write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = {"version": REPAIR_VERSION, "source": str(shp), "output": str(out), "sceneCount": len(scenes), "parcelCounts": counts,
              "insee2011FallbackRows": fallback_count,
              "outOfAtlasOfficialRows": {"count": len(outside_rows), "sample": outside_rows[:200],
                                          "policy": "reported for root review; never silently discarded from the official source catalog"}}
    report_path = ROOT / "work" / "aoc-data-repair-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def update_index_aoc_bounds(out: Path) -> None:
    """Add only ``aocBounds2154`` to the existing static index."""
    index_path = ROOT / "website" / "dist" / "data" / "index.json"
    if not index_path.exists():
        return
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    for village in payload.get("villages", []):
        scene_name = Path(str(village.get("scene") or "")).name.replace(".json.gz", ".json")
        scene_path = out / scene_name
        if not scene_path.exists():
            continue
        scene = json.loads(scene_path.read_text(encoding="utf-8"))
        geometries = [source_geometry(parcel) for parcel in scene.get("parcels", [])]
        geometries = [g for g in geometries if g is not None and not g.is_empty]
        if geometries:
            boxes = [g.bounds for g in geometries]
            village["aocBounds2154"] = [round(float(x), 2) for x in (
                min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes))]
    index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--official-shp", type=Path)
    parser.add_argument("--update-index", action="store_true", help="add only aocBounds2154 to dist/data/index.json")
    args = parser.parse_args()
    result = repair_from_official_shp(args.source, args.out, args.official_shp) if args.official_shp else repair(args.source, args.out)
    if args.update_index:
        update_index_aoc_bounds(args.out.resolve())
    print(json.dumps(result, ensure_ascii=True))
