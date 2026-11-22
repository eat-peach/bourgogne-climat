#!/usr/bin/env python3
"""Stamp each atlas's data/index.json with an assetVersion derived from every data file.

Covers Burgundy (dist/data) and every region folder with its own data (dist/<site>/data, e.g. rhone, mosel). The
viewer appends ?v=<assetVersion> to scene, texture, photo-tile, cadastre, ownership and feature-facts requests, and
dist/_headers lets browsers cache those folders for a year. Run this LAST after any data change: a new version makes
every visitor fetch the updated files instead of a cached copy.

Usage: python scripts/stamp_asset_version.py
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
DIST = SITE / "dist"


def data_folders() -> list[Path]:
    """Burgundy's data folder, then each region's (any dist/<site>/data holding an index.json)."""
    folders = [DIST / "data"]
    folders += sorted(p.parent for p in DIST.glob("*/data/index.json") if p.parent != DIST / "data")
    return [f for f in folders if (f / "index.json").is_file()]


def stamp(data: Path) -> None:
    index_path = data / "index.json"
    digest = hashlib.sha256()
    files = sorted(p for p in data.rglob("*") if p.is_file() and p != index_path and p.suffix != ".tmp")
    for path in files:
        file_hash = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                file_hash.update(chunk)
        digest.update(path.relative_to(data).as_posix().encode())
        digest.update(file_hash.digest())
    version = digest.hexdigest()[:12]
    raw = index_path.read_text(encoding="utf-8")
    index = json.loads(raw)
    index["assetVersion"] = version
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + ("\n" if raw.endswith("\n") else ""), encoding="utf-8")
    print(f"{data.relative_to(SITE).as_posix()}: assetVersion {version} from {len(files)} files")


def main() -> None:
    for data in data_folders():
        stamp(data)


if __name__ == "__main__":
    main()
