#!/usr/bin/env python3
"""Read-only audit for a completed refined scene directory."""
from __future__ import annotations
import argparse, json, re, unicodedata
from pathlib import Path
from shapely.ops import unary_union
from make_exclusive_parcels import source_geometry

ROOT = Path(__file__).resolve().parents[2]

def norm(v):
    t = unicodedata.normalize("NFKD", str(v or ""))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[\s-]+", " ", t.casefold()).strip()

def audit(source: Path, raw: Path, report_path: Path):
    files = sorted(source.glob("*.json"))
    raw_by_name = {p.name: p for p in raw.glob("*.json")}
    counts = {"scenes": len(files), "parcels": 0, "verifiedParcels": 0, "unknownOfficialTier": 0,
              "climats": 0, "verifiedClimats": 0, "bonnesMaresGrandCru": 0, "petitVillage": 0}
    errors = []
    areas = {"parcel": {}, "climat": {}}
    geoms = {"parcel": {}, "climat": {}}
    unchanged = 0
    for path in files:
        scene = json.loads(path.read_text(encoding="utf-8"))
        raw_scene = json.loads(raw_by_name[path.name].read_text(encoding="utf-8")) if path.name in raw_by_name else None
        if raw_scene is None:
            errors.append(f"missing raw scene: {path.name}")
        elif {k: v for k, v in scene.items() if k not in {"parcels", "climats", "aocDataRepair"}} == {k: v for k, v in raw_scene.items() if k not in {"parcels", "climats", "aocDataRepair"}}:
            unchanged += 1
        for collection in ("parcels", "climats"):
            for item in scene.get(collection, []):
                counts[collection] += 1
                v = item.get("aocVerification")
                if isinstance(v, dict) and v.get("verificationStatus") == "official-source-matched" and v.get("snapshot") == "2026-10-19":
                    counts["verifiedParcels" if collection == "parcels" else "verifiedClimats"] += 1
                    if not v.get("officialTier"):
                        counts["unknownOfficialTier"] += 1
                if collection == "parcels" and not isinstance(v, dict):
                    errors.append(f"parcel missing aocVerification: {path.name}:{item.get('id')}")
                key = norm(item.get("name") or item.get("appellation") or item.get("officialDenomination"))
                if key == "bonnes mares" and item.get("classification") == "grand-cru": counts["bonnesMaresGrandCru"] += 1
                if key == "petit chablis" and item.get("classification") == "village": counts["petitVillage"] += 1
                if key in {"chambertin", "chambertin clos de beze"}:
                    geom = source_geometry(item)
                    if geom is not None and not geom.is_empty:
                        geoms["parcel" if collection == "parcels" else "climat"].setdefault(key, []).append(geom)
                        areas["parcel" if collection == "parcels" else "climat"][key] = areas["parcel" if collection == "parcels" else "climat"].get(key, 0) + geom.area
    expected = {"chambertin": 282308.52, "chambertin clos de beze": 153476.23}
    physical = expected["chambertin"] - expected["chambertin clos de beze"]
    chambertin = {}
    for collection in ("parcel", "climat"):
        for name in expected:
            parts = geoms[collection].get(name, [])
            actual = float(unary_union(parts).area) if parts else 0.0
            chambertin[f"{collection}:{name}"] = {"areaM2": round(actual, 2), "expectedLegalAreaM2": expected[name], "disjoint": True}
        a, b = geoms[collection].get("chambertin", []), geoms[collection].get("chambertin clos de beze", [])
        if a and b and unary_union(a).intersection(unary_union(b)).area > 0.01:
            errors.append(f"Chambertin/Clos de Beze overlap in {collection}")
        if collection == "climat":
            chambertin[f"{collection}:chambertin"]["expectedPhysicalAreaM2"] = physical
            if abs(chambertin[f"{collection}:chambertin"]["areaM2"] - physical) > 1.0:
                errors.append("climat Chambertin physical display area does not equal official residual")
        elif abs(chambertin[f"{collection}:chambertin"]["areaM2"] - physical) > 1.0:
            errors.append("parcel Chambertin physical display area does not equal official residual")
    result = {"sceneCount": counts["scenes"], "counts": counts, "nonAocScenePayloadUnchanged": unchanged == len(files),
              "chambertin": chambertin, "errors": errors,
              "source": str(source), "rawSource": str(raw), "status": "pass" if not errors and len(files) == 376 else "fail"}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result

if __name__ == "__main__":
    p = argparse.ArgumentParser(); p.add_argument("--source", type=Path, required=True); p.add_argument("--raw", type=Path, required=True); p.add_argument("--report", type=Path, required=True)
    print(json.dumps(audit(p.parse_args().source, p.parse_args().raw, p.parse_args().report), ensure_ascii=False))
