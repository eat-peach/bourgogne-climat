#!/usr/bin/env python3
"""Acquire exact 129x129 IGN terrain rasters for scenes with zero samples."""
from __future__ import annotations

import hashlib, io, json, math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from urllib.parse import urlencode
from urllib.request import Request, urlopen
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SCENES = ROOT / "website" / "dist" / "data" / "scenes"
OUT = ROOT / "website" / "source-terrain"
WMS = "https://data.geopf.fr/wms-r/wms"
LAYER = "RGEALTI-MNT_PYR-ZIP_FXX_LAMB93_WMS"
IDS = [
    "arnas-69013", "blac-69023", "change-71085", "chapelle-vaupelteigne-89081",
    "chitry-89108", "couchey-21200", "daix-21223", "dijon-21231", "fixin-21265",
    "lignorelles-89226", "lugny-71267", "maligny-89242", "morey-saint-denis-21442",
    "plombi-res-l-s-dijon-21485", "rochepot-21527", "saint-cyr-le-chatoux-69192",
    "salles-arbuissonnas-en-beaujolais-69172", "serrigny-89393", "talant-21617",
    "vaux-en-beaujolais-69257", "venoy-89438"
]

def now(): return datetime.now(timezone.utc).isoformat()
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def fetch(scene_id):
    scene = json.loads((SCENES / f"{scene_id}.json").read_text(encoding="utf-8"))
    bounds = [float(x) for x in scene["bounds"]]
    params = {"SERVICE":"WMS", "VERSION":"1.3.0", "REQUEST":"GetMap", "LAYERS":LAYER,
              "FORMAT":"image/geotiff", "STYLES":"normal", "CRS":"EPSG:2154",
              "BBOX":",".join(str(x) for x in bounds), "WIDTH":129, "HEIGHT":129}
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f"{scene_id}.tif"
    request = Request(WMS + "?" + urlencode(params), headers={"User-Agent":"BurgundyAtlasTerrain/1.0"})
    with urlopen(request, timeout=240) as response: content = response.read()
    with Image.open(io.BytesIO(content)) as image:
        if image.size != (129, 129): raise RuntimeError(f"grid {image.size}")
        values = [float(value) for value in image.getdata()]
    finite = [value for value in values if math.isfinite(value)]
    if len(finite) != 129 * 129 or any(value <= 0 for value in finite): raise RuntimeError(f"valid={len(finite)} min={min(finite) if finite else None}")
    target.write_bytes(content)
    return {"id":scene_id,"path":str(target.relative_to(ROOT)),"bounds":bounds,"grid":[129,129],"validCount":len(finite),"min":min(finite),"max":max(finite),"crs":"EPSG:2154","verticalReference":"IGN69","sha256":sha(target),"bytes":target.stat().st_size,"source":WMS,"layer":LAYER,"retrievedAt":now()}

def main():
    results=[]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(fetch, scene_id): scene_id for scene_id in IDS}
        for future in as_completed(futures):
            item=future.result(); results.append(item); print(item["id"],item["validCount"],item["min"],item["max"],flush=True)
    results.sort(key=lambda x:x["id"]); OUT.mkdir(parents=True,exist_ok=True)
    (OUT/"manifest.json").write_text(json.dumps({"version":1,"count":len(results),"grid":[129,129],"source":WMS,"layer":LAYER,"results":results},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("ACQUIRED",len(results))

if __name__ == "__main__": main()
