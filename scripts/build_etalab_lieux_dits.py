#!/usr/bin/env python3
"""Rebuild the lieu-dit layer of the served scenes from Etalab cadastre lieux-dits.

Replaces the Bourgogne Maps (BIVB) lieu-dit layer, whose licence does not allow
public reuse. Inputs, all open data or the atlas author's own definitions:

* Etalab cadastre lieux-dits, release 2026-09-01 (fetch_etalab_lieux_dits.py).
  Pieces with the same name in a commune are one lieu-dit and are joined.
* work/lieu-dit-parcels.csv: sub-climats the author defined as sets of cadastral
  parcels (rows marked yes). Their outline is the union of those parcels.
* INAO AOC delimitation (corrected-source-scenes parcels and the pinned official
  SHP), used exactly as the previous pipeline used it: spatial AOC eligibility
  (attach_spatial_aoc_eligibility), cru identity by name + >=98% containment
  (audit_named_feature_identity) and legal selection outlines (the panel's
  vineyard-land rule; no BIVB name lists).

Only lieux-dits that touch an AOC area are kept (vineyard land), plus the
author's sub-climats. Every served scene receives the lieux-dits intersecting its
bounds, clipped to them. Feature-facts payloads drop their (unused) lieu-dit rows.
Run after the scene payloads are final, then harmonise_cru_names.py --write and
stamp_asset_version.py.
"""
from __future__ import annotations

import csv
import gzip
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd
from shapely import STRtree, make_valid
from shapely.geometry import box
from shapely.ops import unary_union

from attach_spatial_aoc_eligibility import FULL_THRESHOLD, MIN_COVERAGE, MIN_OVERLAP_M2, SNAPSHOT, SOURCE_URL, build_matches, load_official, polygonal
from build_cadastre import RAW_ROOT, RELEASE, read_index
from make_exclusive_parcels import as_rings, atomic_gzip, source_geometry
from prepare_vineyard_selection import OFFICIAL, RANK
from refine_aoc_interpretations import norm

WEB = Path(__file__).resolve().parents[1]
ROOT = WEB.parent
SCENES = WEB / "dist" / "data" / "scenes"
FACTS = WEB / "dist" / "data" / "feature-facts"
CADASTRE = WEB / "dist" / "data" / "cadastre"
OVERRIDES = WEB / "work" / "lieu-dit-parcels.csv"
REPORT = WEB / "work" / "etalab-lieux-dits-report.json"
ETALAB_URL = "https://cadastre.data.gouv.fr/data/etalab-cadastre/{release}/geojson/communes/{dept}/{code}/cadastre-{code}-lieux_dits.json.gz"
SOURCE_NAME = f"DGFiP cadastre via Etalab, release {RELEASE} (Licence Ouverte 2.0)"
DISPLAY_SIMPLIFY_M = 0.5
MIN_CLIPPED_M2 = 1.0


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFD", text).encode("ascii", "ignore").decode().lower()).strip("-")


def clean_name(text) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


PARTICLES = {"de", "du", "des", "la", "le", "les", "et", "ou", "en", "au", "aux", "sur", "sous", "lès", "les", "à", "a"}
LOWER_AFTER_HYPHEN = PARTICLES | {"dessus", "dessous"}


def display_name(name: str) -> str:
    """Cadastral names are capitals without accents; show them in French title case."""
    if name != name.upper():
        return name
    def cap(word: str) -> str:
        return word[:1].upper() + word[1:]
    words = []
    for i, word in enumerate(name.lower().split(" ")):
        if i and word in PARTICLES:
            words.append(word)
        elif re.match(r"^[ld]['’].", word):
            # "l'hopital" -> "l'Hopital" inside a name, "L'Echanneaux" at the start
            words.append((cap(word[0]) if not i else word[0]) + "'" + cap(word[2:]))
        else:
            words.append("-".join(part if j and part in LOWER_AFTER_HYPHEN else cap(part) for j, part in enumerate(word.split("-"))))
    return " ".join(words)


def rounded_rings(geometry) -> list:
    return [[[[round(x, 2), round(y, 2)] for x, y in ring] for ring in part] for part in as_rings(geometry)]


def load_lieux_dits() -> list[dict]:
    records = []
    for village in read_index():
        code = village["code"]
        path = RAW_ROOT / "geojson" / "communes" / code[:2] / code / f"cadastre-{code}-lieux_dits.json.gz"
        collection = json.loads(gzip.decompress(path.read_bytes()))
        if not collection.get("features"):
            continue
        frame = gpd.GeoDataFrame.from_features(collection["features"], crs=4326)
        frame = frame.to_crs(2154)
        groups = defaultdict(list)
        for row in frame.itertuples(index=False):
            name = clean_name(getattr(row, "nom", ""))
            if name and row.geometry is not None and not row.geometry.is_empty:
                groups[name].append(row)
        for name, rows in groups.items():
            geometry = polygonal(unary_union([make_valid(r.geometry) for r in rows]))
            if geometry.is_empty or geometry.area <= 0:
                continue
            records.append({"source_id": f"{code}:{slug(name)}", "nom": name, "insee": code, "origin": "etalab",
                            "cadastralPieces": len(rows),
                            "sourceUrl": ETALAB_URL.format(release=RELEASE, dept=code[:2], code=code), "geometry": geometry})
    return records


def load_overrides() -> list[dict]:
    chosen = defaultdict(set)
    for row in csv.DictReader(OVERRIDES.open(encoding="utf-8-sig")):
        if row["Include? (yes/no)"].strip().lower() == "yes":
            chosen[(row["INSEE"], row["Place"])].add(row["Parcel ID"])
    records, parcels_by_code = [], {}
    for (code, name), ids in sorted(chosen.items()):
        if code not in parcels_by_code:
            payload = json.loads(gzip.decompress((CADASTRE / f"{code}.json.gz").read_bytes()))
            parcels_by_code[code] = {p["id"]: p for p in payload["parcels"]}
        shapes = [source_geometry(parcels_by_code[code][pid]) for pid in sorted(ids) if pid in parcels_by_code[code]]
        geometry = polygonal(unary_union([make_valid(g) for g in shapes if g is not None]))
        if geometry.is_empty:
            continue
        records.append({"source_id": f"{code}:atlas:{slug(name)}", "nom": clean_name(name), "insee": code, "origin": "atlas-author",
                        "parcelIds": sorted(ids), "sourceUrl": None, "geometry": geometry})
    return records


def load_sources() -> tuple[list[dict], list[dict]]:
    """Etalab lieux-dits and author sub-climats with unique ids (also used by the validators)."""
    lieux, overrides = load_lieux_dits(), load_overrides()
    # Names that differ only by punctuation ("BEL AIR" / "BEL-AIR") are distinct lieux-dits: keep their ids distinct.
    seen = Counter()
    for record in lieux + overrides:
        seen[record["source_id"]] += 1
        if seen[record["source_id"]] > 1:
            record["source_id"] = f"{record['source_id']}-{seen[record['source_id']]}"
    return lieux, overrides


def identity_facts(frame: gpd.GeoDataFrame, spatial: dict) -> dict:
    """Cru identity and commune attribution, as in audit_named_feature_identity."""
    communes = json.loads(gzip.decompress((WEB / "dist/data/communes.json.gz").read_bytes()))["communes"]
    commune_geoms = [source_geometry(c) for c in communes]
    commune_tree = STRtree(commune_geoms)
    official, aliases = {}, defaultdict(set)
    for path in sorted((WEB / "corrected-source-scenes").glob("*.json")):
        for p in json.loads(path.read_text("utf8"))["parcels"]:
            if p["classification"] not in ("grand-cru", "premier-cru"):
                continue
            key = (str(p["idApp"]), str(p["idDenom"]))
            entry = official.setdefault(key, {"facts": p["aocVerification"], "geometries": [], "codes": set()})
            entry["geometries"].append(source_geometry(p))
            entry["codes"].add(str(p["insee"]))
            name = norm(p["aocVerification"]["officialDenomination"])
            names = {name, norm(p["name"])}
            names.update(re.split(r"\s+ou\s+", name))
            short = re.split(r"\s+(?:premier|1er|grand) cru\s+", name, maxsplit=1)
            if len(short) == 2:
                names.add(short[1])
            names.update({re.sub(r"^(les|le|la|l'|aux|au) ", "", n) for n in list(names)})
            for alias in names:
                aliases[alias].add(key)
    commune_by_code = {c["code"]: g for c, g in zip(communes, commune_geoms)}
    facts = {}
    for row in frame.itertuples(index=False):
        geometry, area = row.geometry, row.geometry.area
        overlaps = []
        for i in commune_tree.query(geometry):
            overlap = geometry.intersection(commune_geoms[i]).area
            if overlap >= max(10, area * .001):
                overlaps.append((overlap, communes[i]["name"], communes[i]["code"]))
        overlaps.sort(reverse=True)
        names, codes = [x[1] for x in overlaps], [x[2] for x in overlaps]
        matches = []
        # The lieu-dit's AOC (vineyard) land: a cru inside the lieu-dit only names it when it covers all of that land.
        coverage = [m["coverageFraction"] for m in spatial.get((row.source_id, row.nom), {}).get("matches", [])]
        vineyard_land = (max(coverage) if coverage else 0) * area
        name_key = norm(row.nom)
        candidates = aliases.get(name_key, set()) | aliases.get(re.sub(r"^(les|le|la|l'|aux|au) ", "", name_key), set())
        home = commune_by_code.get(row.insee)
        for identity in candidates:
            entry = official[identity]
            entry.setdefault("geometry", unary_union(entry["geometries"]))
            shared = geometry.intersection(entry["geometry"]).area
            covered = shared / area
            # Cadastral lieux-dits include roads and houses the AOC leaves out, so the cru
            # usually sits inside the lieu-dit rather than the other way round.
            # A cru spanning two communes is split by the cadastre at the commune line ("Bonnes Mares"):
            # compare with the part of the cru inside this lieu-dit's commune.
            local = entry["geometry"].intersection(home) if home is not None and len(entry["codes"]) > 1 else entry["geometry"]
            cru_inside = shared / local.area if local.area else 0
            if covered >= .98 or (cru_inside >= .9 and vineyard_land > 0 and shared >= .98 * vineyard_land):
                matches.append((identity, entry, covered))
        f = {"mappedAreaM2": round(area, 4), "mappedAreaStatus": "available", "mappedAreaScope": "full-source-named-place",
             "featureCommunes": names, "featureCommuneCodes": codes,
             "communeBasis": "full lieu-dit polygon intersected with commune boundaries; slivers below 0.1% or 10 m2 omitted",
             "classificationStatus": "unmatched" if not matches else "ambiguous" if len(matches) > 1 else "official-name-and-location-matched"}
        if len(matches) == 1:
            identity, entry, covered = matches[0]
            v = dict(entry["facts"])
            v.update(geometryScope="named-place-reference", physicalStatus="unverified", verificationStatus="official-name-and-location-matched",
                     legalAreaM2=round(entry["geometry"].area, 2), fullSourceCoveredFraction=round(covered, 6),
                     note="Name and full lieu-dit location match this official denomination. The primary area is the complete legal denomination, not this clipped display polygon or planted production area.")
            v.pop("physicalAreaM2", None)
            f.update(aocVerification=v, classification="grand-cru" if v["officialTier"] == "Grand Cru" else "premier-cru",
                     mappedSourceCommunes=names, featureCommunes=[c["name"] for c in communes if c["code"] in entry["codes"]],
                     featureCommuneCodes=sorted(entry["codes"]), communeBasis="communes of the matched full official denomination, not the current scene")
        elif matches and len({e["facts"]["officialTier"] for _, e, _ in matches}) == 1:
            entries = [e for _, e, _ in matches]
            tier = entries[0]["facts"]["officialTier"]
            union = unary_union([e["geometry"] for e in entries])
            v = dict(entries[0]["facts"])
            appellations = sorted({e["facts"]["officialAppellation"] for e in entries})
            v.update(officialAppellation=" / ".join(appellations), officialDenomination=" / ".join(sorted({e["facts"]["officialDenomination"] for e in entries})),
                     eligibleAppellations=appellations, geometryScope="named-place-reference", physicalStatus="unverified",
                     verificationStatus="shared-eligibility-name-and-location-matched", legalAreaM2=round(union.area, 2),
                     areaLabel="Full legal denominations · shared eligibility",
                     note="This name and full lieu-dit location match multiple official denominations at the same tier. All matches are retained. Area is their geometric union; overlap is counted once.")
            v.pop("physicalAreaM2", None)
            f.update(aocVerification=v, classification="grand-cru" if tier == "Grand Cru" else "premier-cru",
                     classificationStatus="shared-eligibility-name-and-location-matched")
        facts[row.source_id] = f
    return facts


def selection_outlines(frame: gpd.GeoDataFrame, spatial: dict, facts: dict) -> dict:
    """Legal selection outlines and AOC-delimited areas, as in prepare_vineyard_selection."""
    raw = gpd.read_file(OFFICIAL)
    rows = list(raw.itertuples(index=False))
    geoms = [r.geometry if r.geometry.is_valid else make_valid(r.geometry) for r in rows]
    tree = STRtree(geoms)
    derived = {}
    for row in frame.itertuples(index=False):
        full, v = row.geometry, facts[row.source_id].get("aocVerification") or {}
        matches = spatial.get((row.source_id, row.nom), {}).get("matches", [])
        if v:
            denominations = set(v.get("officialDenomination", "").split(" / "))
            parts = [g for r, g in zip(rows, geoms) if r.denom in denominations]
            if parts:
                derived[row.source_id] = {"geometry": unary_union(parts)}
            continue
        # Same rule as the info panel: the tier that covers all of the lieu-dit's AOC vineyard land, ignoring roads and buildings.
        land = max((m["coverageFraction"] for m in matches), default=0)
        covered = [m for m in matches if land and m["coverageFraction"] / land >= .98]
        highest = max((RANK.get(m["tier"], 0) for m in covered), default=0)
        # Several same-tier appellations can each cover the whole land; their union is still that land.
        chosen = [m for m in covered if RANK.get(m["tier"], 0) == highest]
        keys = {(m["appellation"], m["denomination"]) for m in chosen}
        pieces = [full.intersection(geoms[int(i)]) for i in tree.query(full) if (rows[int(i)].app, rows[int(i)].denom) in keys]
        geometry = unary_union(pieces) if pieces else None
        if geometry is None or geometry.is_empty:
            continue
        derived[row.source_id] = {"geometry": geometry, "aocDelimitedAreaM2": round(geometry.area, 2)}
    return derived


def retained_physical_verifications(frame: gpd.GeoDataFrame) -> dict:
    """Keep the verified physical outlines (Chambertin, Chambertin-Clos de Bèze) on the matching lieu-dit."""
    old = {}
    # The retained refined scenes keep the original verified records; the served scenes may already be rebuilt.
    for path in (WEB / "refined-source-scenes").glob("*.json"):
        for c in json.loads(path.read_text(encoding="utf-8")).get("climats", []):
            v = c.get("aocVerification") or {}
            if v.get("physicalStatus") == "derived-supported":
                old.setdefault((norm(c.get("name")), v.get("officialDenomination")), (v, polygonal(source_geometry(c))))
    kept = {}
    for row in frame.itertuples(index=False):
        for (name, _), (v, geometry) in old.items():
            if not row.geometry.intersects(geometry):
                continue
            shared = row.geometry.intersection(geometry).area
            same_name = norm(row.nom).replace("le ", "", 1) == name.replace("le ", "", 1)
            # "CLOS DE BEZE" in the cadastre is the verified Chambertin-Clos de Bèze outline.
            if same_name or shared / min(row.geometry.area, geometry.area) >= .8:
                kept[row.source_id] = v
    return kept


def main() -> None:
    lieux, overrides = load_sources()
    frame = gpd.GeoDataFrame(lieux + overrides, geometry="geometry", crs=2154)
    print(json.dumps({"stage": "sources", "etalabLieuxDits": len(lieux), "authorSubClimats": len(overrides)}), flush=True)
    results_path = ROOT / "work/aoc-full-audit/spatial-aoc-source-results.json"
    if "--reuse-spatial" in sys.argv:
        cached = json.loads(results_path.read_text("utf8"))
        spatial = {(r["sourceId"], r["name"]): {k: v for k, v in r.items() if k not in ("sourceId", "name")} for r in cached}
        stats = Counter(r["status"] for r in cached)
        official_stats = {"reused": str(results_path.name)}
        keep = [(sid, nom) in spatial for sid, nom in zip(frame.source_id, frame.nom)]
    else:
        official, official_stats = load_official()
        spatial, stats = build_matches(official, frame)
        keep = [s == "atlas-author" or spatial.get((sid, nom), {}).get("status", "no-overlap") != "no-overlap"
                for sid, nom, s in zip(frame.source_id, frame.nom, frame.origin)]
    frame = frame[keep].reset_index(drop=True)
    print(json.dumps({"stage": "aoc-filter", "kept": len(frame), **stats}), flush=True)
    # Same file the spatial read-back validator checks the served copies against.
    kept_ids = set(zip(frame.source_id, frame.nom))
    results_path.write_text(json.dumps(
        [{"sourceId": sid, "name": nom, **value} for (sid, nom), value in spatial.items() if (sid, nom) in kept_ids],
        ensure_ascii=False, separators=(",", ":")), encoding="utf8")
    facts = identity_facts(frame, spatial)
    selection = selection_outlines(frame, spatial, facts)
    physical = retained_physical_verifications(frame)

    features = []
    for row in frame.itertuples(index=False):
        sp = spatial.get((row.source_id, row.nom))
        record = {"id": row.source_id, "name": row.nom, "displayName": display_name(row.nom),
                  "source": SOURCE_NAME if row.origin == "etalab" else "Atlas author's definition from cadastral parcels",
                  "sourceUrl": row.sourceUrl if isinstance(row.sourceUrl, str) else None, "identityAudit": "etalab-cadastre-v1", "sourceFeatureId": row.source_id,
                  **({"cadastralPieces": int(row.cadastralPieces)} if row.origin == "etalab" else {"cadastralParcelIds": list(row.parcelIds)}),
                  **facts[row.source_id]}
        if sp:
            record["spatialAocEligibility"] = {"basis": "full-source-polygon", "sourceUrl": SOURCE_URL, "snapshot": SNAPSHOT,
                                               "threshold": {"fullCoverageFraction": FULL_THRESHOLD, "minimumOverlapM2": MIN_OVERLAP_M2, "minimumCoverageFraction": MIN_COVERAGE},
                                               "mappedAreaM2": sp["mappedAreaM2"], "status": sp["status"], "matches": sp["matches"]}
        if row.source_id in physical:
            record["aocVerification"], record["classification"] = physical[row.source_id], "grand-cru"
            record["displayName"] = physical[row.source_id].get("officialDenomination") or record["displayName"]
            record["displayNameBasis"] = "verified INAO grand cru outline"
        sel = selection.get(row.source_id, {})
        if "aocDelimitedAreaM2" in sel:
            record["aocDelimitedAreaM2"] = sel["aocDelimitedAreaM2"]
        display = row.geometry.simplify(DISPLAY_SIMPLIFY_M, preserve_topology=True)
        features.append((record, display, sel.get("geometry")))
    tree = STRtree([d for _, d, _ in features])

    copies, scenes_changed, rendered_ids = 0, 0, set()
    for path in sorted(SCENES.glob("*.json.gz")):
        scene = json.loads(gzip.decompress(path.read_bytes()))
        extent = box(*scene["bounds"])
        climats = []
        for i in sorted(tree.query(extent), key=lambda i: features[int(i)][0]["name"]):
            record, display, legal = features[int(i)]
            clipped = polygonal(display.intersection(extent))
            if clipped.is_empty or clipped.area < MIN_CLIPPED_M2:
                continue
            climat = {**record, "rings": rounded_rings(clipped)}
            if record.get("aocVerification") and record["aocVerification"].get("physicalStatus") != "derived-supported":
                climat["aocVerification"] = {**record["aocVerification"], "displayAreaM2": round(clipped.area, 2)}
            if legal is not None:
                selection_rings = rounded_rings(polygonal(legal.intersection(extent)))
                if selection_rings:
                    climat["aocSelectionRings"] = selection_rings
            climats.append(climat)
        scene["climats"] = climats
        if isinstance(scene.get("stats"), dict):
            scene["stats"]["climatCount"] = scene["stats"]["namedPlaceCount"] = len(climats)
            scene["stats"]["parcelCount"] = len(scene.get("parcels", []))
        rendered_ids.update(c["id"] for c in climats)
        atomic_gzip(path, json.dumps(scene, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        copies += len(climats); scenes_changed += 1

    # Lieu-dit rows in the facts payloads were never linked from the scenes and cite the old source.
    for path in sorted(FACTS.glob("*.json.gz")):
        payload = json.loads(gzip.decompress(path.read_bytes()))
        payload["features"] = [f for f in payload.get("features", []) if f.get("layer") != "climats"]
        if isinstance(payload.get("citations"), dict):
            payload["citations"].pop("namedPlaces", None)
        atomic_gzip(path, json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    index_path = WEB / "dist" / "data" / "index.json"
    raw = index_path.read_text(encoding="utf-8")
    index = json.loads(raw)
    index["namedPlaceCount"] = len(rendered_ids)  # lieux-dits actually drawn (slivers below 1 m2 are skipped)
    index["sourceNamedPlaceCount"] = len(frame)
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + ("\n" if raw.endswith("\n") else ""), encoding="utf-8")

    report = {"release": RELEASE, "etalabLieuxDits": len(lieux), "authorSubClimats": len(overrides), "keptOnAocLand": len(frame),
              "servedCopies": copies, "scenes": scenes_changed, "spatial": dict(stats), "official": dict(official_stats),
              "classification": dict(Counter(f[0]["classificationStatus"] for f in features)),
              "selectionOutlines": len(selection), "physicalVerificationsRetained": len(physical), "method": __doc__}
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "method"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
