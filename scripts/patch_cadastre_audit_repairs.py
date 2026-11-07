"""Refresh projected repair metrics in an existing cadastre audit report."""
import gzip, json
from pathlib import Path
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform

P = Path(__file__).resolve().parents[2] / "work" / "cadastre-source-audit.json"
d = json.loads(P.read_text(encoding="utf-8"))
t = Transformer.from_crs("EPSG:4326", "EPSG:2154", always_xy=True)
effects=[]
for item in d["geometry"]["sourceInvalidIds"]:
    code, fid = item["commune"], item["id"]
    p = Path(__file__).resolve().parents[2] / "work" / "cadastre" / "2026-09-01" / "geojson" / "communes" / code[:2] / code / f"cadastre-{code}-parcelles.json.gz"
    src = json.load(gzip.open(p, "rt", encoding="utf-8"))
    f = next(x for x in src["features"] if str(x.get("id")) == fid)
    g = transform(t.transform, shape(f["geometry"]))
    r = g if g.is_valid else g.buffer(0)
    effects.append({"commune": code, "id": fid, "sourceAreaM2": round(float(g.area), 3), "repairedAreaM2": round(float(r.area), 3), "repairSucceeded": bool(r.is_valid and not r.is_empty)})
d["geometry"]["sourceInvalidRepairEffects"] = effects
P.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps(effects, indent=2))
