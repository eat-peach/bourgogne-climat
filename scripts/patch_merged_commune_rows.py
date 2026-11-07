#!/usr/bin/env python3
"""Append official rows from a historically merged commune to one scene.

Used after the normal corrected export for Saint-Ythaire (71492), merged into
Bonnay-Saint-Ythaire (71042). It does not rebuild global geometry or terrain.
"""
from __future__ import annotations
import argparse, copy, json, sys
from pathlib import Path
import geopandas as gpd
from shapely.ops import unary_union
sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_exclusive_parcels import as_rings, source_geometry

ROOT = Path(__file__).resolve().parents[2]
SHP = ROOT / "work/reference-audit/official/2026-10-19-extracted/2026-10-19_delim-parcellaire-aoc-shp.shp"
SCENES = ROOT / "website/corrected-source-scenes"
INAO_URL = "https://www.data.gouv.fr/datasets/delimitation-parcellaire-des-aoc-viticoles-de-linao"

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-shp", type=Path, default=SHP)
    ap.add_argument("--scene", type=Path, default=SCENES / "bonnay-saint-ythaire-71042.json")
    ap.add_argument("--update-index", action="store_true")
    args = ap.parse_args()
    scene_path = args.scene.resolve()
    scene = json.loads(scene_path.read_text(encoding="utf-8"))
    # Read only the two historical-source rows; the source code is part of
    # identity because the merged commune can reuse id_aire/id_denom values.
    shp = gpd.read_file(args.source_shp, where="insee = '71492'", encoding="utf-8").to_crs(2154)
    rows = shp
    existing = {(str(p.get("sourceCommuneCode") or p.get("insee") or ""),
                 str(p.get("idDenom")), str(p.get("sourceOfficialId")))
                for p in scene.get("parcels", [])}
    templates = {str(p.get("idDenom")): p for p in scene.get("parcels", []) if p.get("idDenom")}
    appended = []
    for idx, row in rows.iterrows():
        rid = str(row.get("id_aire") or row.get("id_app") or idx)
        id_denom = str(row.get("id_denom") or "")
        if ("71492", id_denom, rid) in existing:
            continue
        template = templates.get(id_denom)
        if template is None:
            continue
        item = copy.deepcopy(template)
        item["id"] = rid
        item["sourceOfficialId"] = rid
        item["idApp"] = str(row.get("id_app") or "")
        item["idDenom"] = id_denom
        item["insee"] = "71492"
        item["sceneCommuneCode"] = "71042"
        item["inseeOriginal"] = "71492"
        item["inseeSource"] = "historical merged commune code"
        item["sourceCommuneCode"] = "71492"
        item["officialAppellation"] = str(row.get("app") or "")
        item["officialDenomination"] = str(row.get("denom") or "")
        item["rings"] = as_rings(row.geometry)
        item["displayAreaM2"] = round(float(row.geometry.area), 2)
        item["aocVerification"]["displayAreaM2"] = item["displayAreaM2"]
        item["aocVerification"]["sourceUrl"] = INAO_URL
        item["aocVerification"]["note"] = "Historical INSEE 71492 row appended to current 71042 scene; legalAreaM2 inherited from full AOC identity union."
        scene.setdefault("parcels", []).append(item)
        appended.append({"sourceOfficialId": rid, "idApp": item["idApp"], "idDenom": id_denom})
    scene_path.write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if args.update_index:
        index_path = ROOT / "website/dist/data/index.json"
        if index_path.exists():
            payload = json.loads(index_path.read_text(encoding="utf-8"))
            for village in payload.get("villages", []):
                if village.get("id") != "bonnay-saint-ythaire-71042":
                    continue
                gs = [source_geometry(p) for p in scene.get("parcels", [])]
                gs = [g for g in gs if g is not None and not g.is_empty]
                if gs:
                    u = unary_union(gs)
                    village["aocBounds2154"] = [round(float(x), 2) for x in u.bounds]
            index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    report = {"sourceInsee": "71492", "targetInsee": "71042", "appended": appended, "count": len(appended)}
    (ROOT / "work/merged-commune-row-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(report)

if __name__ == "__main__":
    main()
