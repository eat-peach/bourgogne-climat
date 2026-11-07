#!/usr/bin/env python3
"""Write an AVIF copy of every aerial texture next to its JPEG.

Modern browsers load the AVIF (about a third smaller at equal or better fidelity);
the JPEG stays as the fallback for browsers without AVIF decoding. Run after
build_textures.py. Records `urlAvif` in texture-manifest.json and `textureAvif`
in index.json. Requires Pillow 11+ built with AVIF support.
"""
from __future__ import annotations

import argparse
import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, features

SITE = Path(__file__).resolve().parents[1]
DATA = SITE / "dist" / "data"
TEXTURES = DATA / "textures"
AVIF_QUALITY = 60
AVIF_SPEED = 4


def encode(jpg: Path, force: bool) -> tuple[str, int, int]:
    out = jpg.with_suffix(".avif")
    if force or not out.exists() or out.stat().st_mtime < jpg.stat().st_mtime:
        with Image.open(jpg) as image:
            image.convert("RGB").save(out, format="AVIF", quality=AVIF_QUALITY, speed=AVIF_SPEED)
    return jpg.stem, jpg.stat().st_size, out.stat().st_size


def strip_query(url: str) -> str:
    return url.split("?", 1)[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="re-encode even when the AVIF is newer than the JPEG")
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    if not features.check("avif"):
        raise SystemExit("Pillow was built without AVIF support")

    jpgs = sorted(TEXTURES.glob("*.jpg"))
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(encode, jpgs, [args.force] * len(jpgs)))
    jpg_total = sum(r[1] for r in results)
    avif_total = sum(r[2] for r in results)

    manifest_path = DATA / "texture-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for item in manifest.values():
        if isinstance(item, dict) and str(item.get("url", "")).split("?")[0].endswith(".jpg"):
            avif = strip_query(item["url"])[:-4] + ".avif"
            if (SITE / "dist" / avif).exists():
                item["urlAvif"] = avif
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    index_path = DATA / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    for village in index.get("villages", []):
        texture = strip_query(str(village.get("texture") or ""))
        if texture.endswith(".jpg") and (SITE / "dist" / (texture[:-4] + ".avif")).exists():
            village["textureAvif"] = texture[:-4] + ".avif"
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"{len(results)} textures: JPEG {jpg_total / 1048576:.1f} MiB -> AVIF {avif_total / 1048576:.1f} MiB ({100 * avif_total / max(1, jpg_total):.0f}%)")


if __name__ == "__main__":
    main()
