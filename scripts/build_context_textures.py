"""Write low-resolution, muted aerial photos for the background terrain of an atlas.

Each 50 km tile of data/context-terrain.json.gz gets an IGN orthophoto of about 24 m per pixel, muted here rather
than in the browser (iOS Safari has no canvas filters) so the sharp vineyard area stays the focus. The originals
are kept in ../regions/context-photos/ so the muting can be changed without downloading again. Entries are added
to data/texture-manifest.json under the tile id; scene-mosaic.js paints them beneath the scene photos.

Usage: python build_context_textures.py [--site rhone] [--saturation .62] [--haze .22]
Run stamp_asset_version.py afterwards for the Burgundy atlas.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

from region_fetch import WMS_URL, atomic, get

WEB = Path(__file__).resolve().parents[1]
PIXELS = 2048
PAPER = np.array([0xd9, 0xd0, 0xc3], dtype=np.float32)  # the atlas sky colour, so distant land melts into it


def fetch_photo(tile: dict, cache: Path) -> Path:
    path = cache / f"{tile['id']}.jpg"
    if not path.exists():
        x0, y0, x1, y1 = (int(v) for v in tile["bounds"])
        params = {"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": "ORTHOIMAGERY.ORTHOPHOTOS", "STYLES": "", "CRS": "EPSG:2154",
                  "BBOX": f"{x0},{y0},{x1},{y1}", "WIDTH": PIXELS, "HEIGHT": PIXELS, "FORMAT": "image/jpeg"}
        atomic(path, get(WMS_URL, params, expect="image", timeout=240).content)
    return path


def mute(path: Path, saturation: float, haze: float) -> Image.Image:
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    grey = rgb @ np.array([.299, .587, .114], dtype=np.float32)
    rgb = rgb * saturation + grey[..., None] * (1 - saturation)
    rgb = rgb * (1 - haze) + PAPER * haze
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="", help="region site folder under dist/ (e.g. rhone); default is the Burgundy atlas")
    ap.add_argument("--saturation", type=float, default=.62)
    ap.add_argument("--haze", type=float, default=.22)
    args = ap.parse_args()
    data = WEB / "dist" / args.site / "data"
    tiles = json.loads(gzip.decompress((data / "context-terrain.json.gz").read_bytes()))["tiles"]
    cache = WEB.parent / "regions" / "context-photos" / (args.site or "bourgogne")
    out = data / "context-textures"
    out.mkdir(parents=True, exist_ok=True)

    def one(tile):
        image = mute(fetch_photo(tile, cache), args.saturation, args.haze)
        image.save(out / f"{tile['id']}.jpg", quality=68, optimize=True)
        image.save(out / f"{tile['id']}.avif", format="AVIF", quality=50, speed=4)
        return tile["id"], {"url": f"data/context-textures/{tile['id']}.jpg", "urlAvif": f"data/context-textures/{tile['id']}.avif",
                            "bounds": tile["bounds"], "context": True, "algorithmVersion": f"context-ortho-{PIXELS}-s{args.saturation}-h{args.haze}"}

    with ThreadPoolExecutor(max_workers=4) as pool:
        entries = dict(pool.map(one, tiles))
    manifest_path = data / "texture-manifest.json"
    manifest = json.loads(manifest_path.read_text("utf8"))
    manifest.update(entries)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf8")
    size = sum(f.stat().st_size for f in out.glob("*.avif")) / 1e6
    print(f"{len(entries)} background photos, AVIF {size:.1f} MB, JPEG {sum(f.stat().st_size for f in out.glob('*.jpg')) / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
