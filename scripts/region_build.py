"""Build the static scene payloads for a region atlas (website/regions/<id>/region.json) into dist/<site>/data/.

Reads the downloads made by region_fetch.py and writes the same formats as the Burgundy atlas, so the shared
viewer reads them unchanged:

  index.json, texture-manifest.json, region.json         page index, scene textures, classes and groups
  scenes/<id>.json.gz                                     terrain grid, AOC areas, lieux-dits, landscape
  textures/<id>.jpg|.avif                                 orthophoto texture, 1280 px on the long edge

AOC areas keep their full legal geometry for areas; the coloured display geometry is exclusive (one class per
place: higher rank first, then the smaller appellation, so Château-Grillet shows inside Condrieu). Lieux-dits
come from the cadastre, joined by name within each commune and kept where they touch an AOC area, with the
same spatial eligibility record the Burgundy panel reads.

Usage: python region_build.py rhone-nord [--only 69007]
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.merge import merge
from shapely import STRtree, make_valid
from shapely.geometry import box
from shapely.ops import unary_union

from build_atlas import lines, raster_for, rings
from build_etalab_lieux_dits import display_name

WEB = Path(__file__).resolve().parents[1]
ROOT = WEB.parent
INAO_URL = "https://www.data.gouv.fr/datasets/delimitation-parcellaire-des-aoc-viticoles-de-linao"
CADASTRE_URL = "https://cadastre.data.gouv.fr/data/etalab-cadastre/2026-09-01/geojson/communes/{dept}/{insee}/cadastre-{insee}-lieux_dits.json.gz"
CADASTRE_SOURCE = "DGFiP cadastre via Etalab, release 2026-09-01 (Licence Ouverte 2.0)"
SCENE_BUFFER_M = 500
TEXTURE_EDGE = 1280
MIN_OVERLAP_M2, MIN_FRACTION, FULL_FRACTION = 10.0, 0.001, 0.98
TO_WGS84 = Transformer.from_crs(2154, 4326, always_xy=True)


def slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def valid(g):
    return g if g.is_valid else make_valid(g)


def read_geojson_gz(path: Path) -> gpd.GeoDataFrame:
    data = json.loads(gzip.decompress(path.read_bytes()))
    return gpd.GeoDataFrame.from_features(data["features"], crs=4326).to_crs(2154) if data["features"] else gpd.GeoDataFrame(geometry=[], crs=2154)


class Region:
    def __init__(self, region_id: str):
        self.cfg = json.loads((WEB / "regions" / region_id / "region.json").read_text("utf8"))
        self.raw = ROOT / "regions" / region_id / "raw"
        self.out = WEB / "dist" / self.cfg["site"] / "data"
        self.by_app = {app: c for c in self.cfg["classes"] for app in c["apps"]}
        self.load_aoc()
        self.load_communes()
        self.load_lieux_dits()
        self.terrain = sorted((self.raw / "terrain").glob("*.tif"))
        self.ortho = sorted((self.raw / "ortho").glob("*.tif"))

    def load_aoc(self):
        df = gpd.read_file(self.raw / "inao.gpkg")
        df = df[df["app"].isin(self.by_app)].copy()
        df["geometry"] = [valid(g) for g in df.geometry]
        df["cls"] = [self.by_app[a]["key"] for a in df["app"]]
        df["rank"] = [self.by_app[a]["rank"] for a in df["app"]]
        # Exclusive display: higher rank first, then the smaller appellation (total legal area).
        app_area = df.dissolve("app").geometry.area
        df["priority"] = [(-r, app_area[a]) for r, a in zip(df["rank"], df["app"])]
        df = df.sort_values("priority").reset_index(drop=True)
        taken, display = None, []
        for g in df.geometry:
            display.append(g if taken is None else g.difference(taken))
            taken = g if taken is None else taken.union(g)
        df["display"] = display
        self.aoc = df
        self.aoc_tree = STRtree(list(df.geometry))
        self.aoc_union = unary_union(list(df.geometry))
        print("AOC rows", len(df), dict(df["cls"].value_counts()), flush=True)

    def load_communes(self):
        rows = []
        names_file = self.raw / "commune-names.json"  # official spelling (region_fetch.py); cadastre names are capitals
        names = json.loads(names_file.read_text("utf8")) if names_file.exists() else {}
        for insee in self.cfg["communes"]:
            gdf = read_geojson_gz(self.raw / "cadastre" / insee / f"cadastre-{insee}-communes.json.gz")
            rows.append({"insee": insee, "name": names.get(insee) or str(gdf.iloc[0].get("nom")), "geometry": unary_union(gdf.geometry)})
        self.communes = gpd.GeoDataFrame(rows, crs=2154)
        self.commune_names = dict(zip(self.communes.insee, self.communes.name))

    def load_lieux_dits(self):
        records, ids = [], set()
        for insee in self.cfg["communes"]:
            gdf = read_geojson_gz(self.raw / "cadastre" / insee / f"cadastre-{insee}-lieux_dits.json.gz")
            if gdf.empty:
                continue
            gdf["nom"] = gdf["nom"].astype(str).str.strip()
            for nom, part in gdf.groupby("nom"):
                geom = valid(unary_union(part.geometry))
                if not nom or geom.is_empty or not geom.intersects(self.aoc_union):
                    continue  # only lieux-dits that touch AOC land are shown
                base = f"{insee}:{slug(nom)}"
                fid, n = base, 2
                while fid in ids:
                    fid, n = f"{base}-{n}", n + 1
                ids.add(fid)
                record = self.lieu_dit_record(fid, insee, nom, geom, len(part))
                if not record["spatialAocEligibility"]["matches"]:
                    ids.discard(fid)  # only grazes AOC land along its edge: not a vineyard place
                    continue
                records.append(record)
        self.lieux = records
        self.lieux_tree = STRtree([r["_geom"] for r in records])
        print("lieux-dits on AOC land", len(records), flush=True)

    def lieu_dit_record(self, fid, insee, nom, geom, pieces):
        area = geom.area
        by_app = defaultdict(float)
        for i in self.aoc_tree.query(geom):
            row = self.aoc.iloc[int(i)]
            by_app[row["app"]] += geom.intersection(row.geometry).area
        matches = []
        for app, inter in by_app.items():
            frac = inter / area if area else 0
            if inter >= MIN_OVERLAP_M2 and frac >= MIN_FRACTION:
                c = self.by_app[app]
                matches.append({"appellation": c["label"], "denomination": c["label"], "tier": c["tier"], "intersectionAreaM2": round(inter, 2),
                                "coverageFraction": round(min(1.0, frac), 6), "areaM2": round(inter, 2)})
        matches.sort(key=lambda m: -m["coverageFraction"])
        status = "spatial-full-coverage" if matches and matches[0]["coverageFraction"] >= FULL_FRACTION else "spatial-partial-coverage"
        return {"id": fid, "name": nom, "displayName": display_name(nom), "source": CADASTRE_SOURCE,
                "sourceUrl": CADASTRE_URL.format(dept=insee[:2], insee=insee), "identityAudit": "etalab-cadastre-v1", "sourceFeatureId": fid,
                "cadastralPieces": pieces, "mappedAreaM2": round(area, 4), "mappedAreaStatus": "available", "mappedAreaScope": "full-source-named-place",
                "featureCommunes": [self.commune_names[insee]], "featureCommuneCodes": [insee], "insee": insee,
                "spatialAocEligibility": {"basis": "full-source-polygon", "sourceUrl": INAO_URL, "snapshot": self.cfg["inaoSnapshot"],
                                          "threshold": {"fullCoverageFraction": FULL_FRACTION, "minimumOverlapM2": MIN_OVERLAP_M2, "minimumCoverageFraction": MIN_FRACTION},
                                          "mappedAreaM2": round(area, 2), "status": status, "matches": matches},
                "_geom": geom}

    def parcel_record(self, row, extent):
        c = self.by_app[row["app"]]
        display = row["display"].intersection(extent)
        legal = round(row.geometry.area, 2)
        verification = {"snapshot": self.cfg["inaoSnapshot"], "officialAppellation": c["label"], "officialDenomination": c["label"], "officialTier": c["tier"],
                        "inaoName": row["app"], "geometryScope": "legal-denomination", "verificationStatus": "official-source-matched", "physicalStatus": "unverified",
                        "legalAreaM2": legal, "displayAreaM2": round(display.area, 2), "eligibleAppellations": [c["label"]], "sourceUrl": INAO_URL,
                        "evidenceUrls": [INAO_URL], "note": "The legal area is this appellation's delimitation in this commune; the coloured shape is exclusive display geometry.",
                        "displayAreaScope": "rank-exclusive masked display geometry"}
        return {"id": str(row["id_aire"] or f"{row['insee']}:{c['key']}"), "name": c["label"], "appellation": c["label"], "officialAppellation": c["label"],
                "officialDenomination": c["label"], "insee": row["insee"], "classification": c["key"], "displayClassification": c["key"],
                "legalAreaM2": legal, "displayAreaM2": verification["displayAreaM2"], "geometryScope": "legal-denomination", "eligibleAppellations": [c["label"]],
                "sourceUrl": INAO_URL, "aocVerification": verification, "featureCommunes": [self.commune_names.get(row["insee"], row["nomcom"])],
                "rings": rings(display, .35)}

    def landscape(self, name, bounds, columns):
        frames = []
        for path in (self.raw / "bdtopo").glob(f"{name}_*.geojson"):
            m = re.search(r"_(\d+)_(\d+)\.geojson$", path.name)
            size = self.cfg["fetch"]["wfsTileM"]
            x, y = int(m.group(1)) * size, int(m.group(2)) * size
            if box(*bounds).intersects(box(x, y, x + size, y + size)):
                gdf = gpd.read_file(path, bbox=bounds)
                if len(gdf):
                    frames.append(gdf[[c for c in columns if c in gdf.columns] + ["geometry"]])
        if not frames:
            return gpd.GeoDataFrame(geometry=[], crs=2154)
        return gpd.GeoDataFrame(gpd.pd.concat(frames, ignore_index=True), crs=frames[0].crs).to_crs(2154)

    def texture(self, scene_id, bounds):
        chosen = []
        for p in self.ortho:
            with rasterio.open(p) as ds:
                if box(*bounds).intersects(box(*ds.bounds)):
                    chosen.append(p)
        if not chosen:
            return None
        span_x, span_y = bounds[2] - bounds[0], bounds[3] - bounds[1]
        res = max(span_x, span_y) / TEXTURE_EDGE
        sources = [rasterio.open(p) for p in chosen]
        try:
            arr, _ = merge(sources, bounds=bounds, res=(res, res), resampling=Resampling.bilinear)
        finally:
            for s in sources:
                s.close()
        missing = np.all(arr == 0, axis=0)
        rgb = np.clip(arr[:3], 0, 255).astype(np.uint8)
        rgb[:, missing] = np.array([[190], [182], [165]], dtype=np.uint8)  # neutral fill where no photo exists
        image = Image.fromarray(np.moveaxis(rgb, 0, -1), "RGB")
        tex = self.out / "textures"
        tex.mkdir(parents=True, exist_ok=True)
        image.save(tex / f"{scene_id}.jpg", quality=72, optimize=True)
        image.save(tex / f"{scene_id}.avif", format="AVIF", quality=60, speed=4)
        return {"url": f"data/textures/{scene_id}.jpg", "urlAvif": f"data/textures/{scene_id}.avif", "bounds": [round(b, 2) for b in bounds],
                "algorithmVersion": "region-ortho-rgb-1280-q72", "coverageFraction": round(float(1 - missing.mean()), 4), "width": image.width,
                "height": image.height, "sourceTileCount": len(chosen), "sourceSamplingMetres": self.cfg["fetch"]["orthoResM"]}

    def build_scene(self, commune):
        insee, name, geom = commune.insee, commune["name"], commune.geometry
        wine = self.aoc[self.aoc.geometry.intersects(geom)]
        focus = unary_union([g.intersection(geom) for g in wine.geometry]) if len(wine) else geom
        bounds = tuple(round(v, 2) for v in focus.buffer(SCENE_BUFFER_M).bounds)
        extent = box(*bounds)
        scene_id = f"{slug(name)}-{insee}"
        parcels = [self.parcel_record(row, extent) for _, row in self.aoc[self.aoc.geometry.intersects(extent)].iterrows()]
        parcels = [p for p in parcels if p["rings"]]
        climats = []
        for i in self.lieux_tree.query(extent):
            rec = self.lieux[int(i)]
            rr = rings(rec["_geom"].intersection(extent), .5)
            if rr:
                climats.append({**{k: v for k, v in rec.items() if k != "_geom"}, "rings": rr})
        b = self.landscape("buildings", bounds, ["hauteur"])
        b = b[b.geometry.intersects(extent)].copy()
        b["_area"] = b.geometry.area
        buildings = []
        for _, r in b.sort_values("_area", ascending=False).head(1500).iterrows():
            rr = rings(r.geometry.intersection(extent), .6)
            if rr:
                h = r.get("hauteur")
                buildings.append({"rings": rr, "height": round(float(h), 1)} if h is not None and np.isfinite(h) else {"rings": rr, "heightUnknown": True})
        rd = self.landscape("roads", bounds, ["nature"])
        roads = [{"coordinates": q, "kind": str(r.get("nature") or "road")} for _, r in rd.iterrows() for q in lines(r.geometry.intersection(extent), 1.5) if len(q) > 1]
        veg = self.landscape("vegetation", bounds, ["nature"])
        veg = veg[veg["nature"].astype(str).str.contains("Forêt|Bois|forêt", regex=True)] if "nature" in veg else veg
        forests = [{"rings": rr} for g in veg.geometry for rr in rings(g.intersection(extent), 1.0)]
        ws = self.landscape("water_surface", bounds, [])
        water_surfaces = [{"rings": rr} for g in ws.geometry for rr in rings(g.intersection(extent), .8)]
        wl = self.landscape("water_lines", bounds, [])
        water_lines = [{"coordinates": q} for g in wl.geometry for q in lines(g.intersection(extent), 1.0) if len(q) > 1]
        fine = [p for p in self.terrain if box(*bounds).intersects(box(*rasterio.open(p).bounds))]
        heights, mn, mx, terr, edge_fill = raster_for(bounds, fine, [], [], return_meta=True)
        manifest = self.texture(scene_id, bounds)
        scene = {"id": scene_id, "name": name, "bounds": list(bounds), "gridSize": 129, "heights": heights, "minElevation": mn, "maxElevation": mx,
                 "parcels": parcels, "climats": climats, "buildings": buildings, "roads": roads, "forests": forests, "waterSurfaces": water_surfaces,
                 "waterLines": water_lines,
                 "stats": {"parcelCount": len(parcels), "climatCount": len(climats), "namedPlaceCount": len(climats), "buildingCount": len(buildings),
                           "roadCount": len(roads), "forestCount": len(forests), "waterSurfaceCount": len(water_surfaces), "waterLineCount": len(water_lines),
                           "terrainSource": f"rgealti_{self.cfg['fetch']['terrainResM']}m", "textureCoverage": bool(manifest)},
                 "sources": {"aoc": f"INAO {self.cfg['inaoSnapshot']}", "lieuxDits": CADASTRE_SOURCE, "terrain": "IGN RGE ALTI", "orthophoto": "IGN BD ORTHO",
                             "landscape": "IGN BD TOPO", "crs": "EPSG:2154"},
                 "coverage": {"commune": insee, "texture": "orthophoto" if manifest else "cartographic_background", "terrain": terr, "terrainEdgeFillUsed": bool(edge_fill),
                              "terrainEdgeFillCount": int(edge_fill)}}
        scenes = self.out / "scenes"
        scenes.mkdir(parents=True, exist_ok=True)
        (scenes / f"{scene_id}.json.gz").write_bytes(gzip.compress(json.dumps(scene, ensure_ascii=False, separators=(",", ":")).encode("utf8"), 9))
        aoc_bounds = focus.bounds
        lon, lat = TO_WGS84.transform(geom.centroid.x, geom.centroid.y)
        entry = {"id": scene_id, "name": name, "department": insee[:2], "region": self.cfg["title"], "center": [round(lon, 6), round(lat, 6)],
                 "bounds2154": list(bounds), "scene": f"data/scenes/{scene_id}.json.gz", "texture": manifest["url"] if manifest else None,
                 "textureAvif": manifest["urlAvif"] if manifest else None, "areaKm2": round(geom.area / 1e6, 4), "aocBounds2154": [round(v, 2) for v in aoc_bounds]}
        return entry, manifest, len(climats), len(parcels)

    def write_search_index(self, index):
        """Sidebar search: each cru (its largest piece) and every lieu-dit lying mostly on one cru's land."""
        scene_of = {e["id"][-5:]: e["id"] for e in index}
        entries = []
        crus = self.aoc[self.aoc["rank"] >= 3].assign(area=lambda d: d.geometry.area).sort_values("area", ascending=False)
        for app, row in crus.groupby("app").head(1).set_index("app").iterrows():
            c = self.by_app[app]
            entries.append({"name": c["label"], "full": app, "class": c["key"], "village": scene_of[row["insee"]], "id": str(row["id_aire"]), "layer": "parcels"})
        for rec in self.lieux:
            crus_here = [m for m in rec["spatialAocEligibility"]["matches"] if m["tier"] != "Regional"]
            if not crus_here or rec["insee"] not in scene_of:
                continue
            land = max(m["coverageFraction"] for m in rec["spatialAocEligibility"]["matches"])
            best = crus_here[0]
            if best["coverageFraction"] >= .5 * land:
                key = next(c["key"] for c in self.cfg["classes"] if c["label"] == best["appellation"])
                entries.append({"name": rec["displayName"], "full": rec["name"], "class": key, "village": scene_of[rec["insee"]], "id": rec["id"], "layer": "climats"})
        entries.sort(key=lambda e: (e["layer"] != "parcels", e["name"]))
        (self.out / "cru-index.json").write_text(json.dumps({"crus": entries}, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
        return len(entries)

    def write_communes(self):
        """Commune outlines for the navigator mini-map and region boundaries (same format as the Burgundy atlas)."""
        communes = [{"code": r.insee, "name": r["name"], "bounds": [round(v, 2) for v in r.geometry.bounds], "rings": rings(r.geometry, 5.0)}
                    for _, r in self.communes.iterrows()]
        payload = {"crs": "EPSG:2154", "communes": communes}
        (self.out / "communes.json.gz").write_bytes(gzip.compress(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf8"), 9))

    def write_context(self):
        """Background terrain around the region: 50 km tiles of 251 x 251 nodes every 200 m, north row first."""
        tiles = []
        for path in sorted((self.raw / "context").glob("rgealti_*_200m.tif")):
            x, y = (int(v) for v in re.search(r"rgealti_(\d+)_(\d+)_200m", path.name).groups())
            with rasterio.open(path) as ds:
                data = ds.read(1).astype("float64")
            valid = np.isfinite(data) & (data > -1000)
            if not valid.any():
                continue
            heights = np.where(valid, np.round(data, 1), 0.0)
            tiles.append({"id": f"rgealti-{x}-{y}", "bounds": [x * 50000.0, y * 50000.0, (x + 1) * 50000.0, (y + 1) * 50000.0], "gridSize": int(data.shape[0]),
                          "heights": heights.reshape(-1).tolist(), "validMask": valid.astype(np.uint8).reshape(-1).tolist(),
                          "minElevation": round(float(data[valid].min()), 1), "maxElevation": round(float(data[valid].max()), 1)})
        payload = {"version": 1, "crs": "EPSG:2154", "samplingMetres": 200, "sourceResolutionMetres": 200, "inputResolutionMetres": 200,
                   "gridSemantics": "nodes-at-bounds-inclusive", "tiles": tiles}
        (self.out / "context-terrain.json.gz").write_bytes(gzip.compress(json.dumps(payload, separators=(",", ":")).encode("utf8"), 9))
        return len(tiles)

    def write_region(self, index):
        ids = {e["id"][-5:]: e["id"] for e in index}
        groups = [{"id": g["id"], "label": g["label"], "villages": [ids[c] for c in g["communes"] if c in ids]} for g in self.cfg["groups"]]
        public = {k: self.cfg[k] for k in ("id", "title", "brand", "description", "classes", "inaoSnapshot", "terrainExaggeration", "latLon", "terms", "owners", "photoTiles", "closeViewHalfSize") if k in self.cfg}
        public["classes"] = [{k: c[k] for k in ("key", "label", "tier", "rank", "colour")} for c in self.cfg["classes"]]
        public["groups"] = groups
        (self.out / "region.json").write_text(json.dumps(public, ensure_ascii=False, indent=1), encoding="utf8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("region")
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    region = Region(args.region)
    region.out.mkdir(parents=True, exist_ok=True)
    index, manifest = [], {}
    for _, commune in region.communes.iterrows():
        if args.only and commune.insee != args.only:
            continue
        entry, tex, n_climats, n_parcels = region.build_scene(commune)
        index.append(entry)
        if tex:
            manifest[entry["id"]] = tex
        print(f"{entry['id']}: {n_parcels} AOC areas, {n_climats} lieux-dits, texture {'yes' if tex else 'no'}", flush=True)
    if args.only:
        return
    index.sort(key=lambda e: e["id"])
    named = len({c["id"] for c in region.lieux})
    (region.out / "index.json").write_text(json.dumps({"version": 1, "crs": "EPSG:2154", "count": len(index), "namedPlaceCount": named,
                                                       "region": region.cfg["id"], "villages": index}, ensure_ascii=False, indent=1), encoding="utf8")
    (region.out / "texture-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf8")
    # Rain streams from 1 m terrain (scripts/build_streams.py) exist only for Burgundy; an empty index tells the page
    # to use its own coarser streams without asking for files that are not there.
    streams = region.out / "streams"; streams.mkdir(exist_ok=True)
    if not (streams / "index.json").exists(): (streams / "index.json").write_text(json.dumps({"villages": []}), encoding="utf8")
    fields = region.out / "rainfields"; fields.mkdir(exist_ok=True)
    if not (fields / "index.json").exists(): (fields / "index.json").write_text(json.dumps({"villages": {}}), encoding="utf8")
    region.write_region(index)
    region.write_communes()
    print("context terrain tiles", region.write_context(), flush=True)
    searchable = region.write_search_index(index)
    print("built", len(index), "scenes,", named, "lieux-dits,", searchable, "search entries", flush=True)


if __name__ == "__main__":
    sys.exit(main())
