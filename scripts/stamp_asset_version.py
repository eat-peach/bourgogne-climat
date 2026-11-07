#!/usr/bin/env python3
"""Stamp dist/data/index.json with an assetVersion derived from every data file.

The viewer appends ?v=<assetVersion> to scene, texture, cadastre, ownership and
feature-facts requests, and dist/_headers lets browsers cache those folders for a
year. Run this LAST after any data change: a new version makes every visitor
fetch the updated files instead of a cached copy.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
DATA = SITE / "dist" / "data"
INDEX = DATA / "index.json"


def main() -> None:
    digest = hashlib.sha256()
    files = sorted(p for p in DATA.rglob("*") if p.is_file() and p != INDEX and p.suffix != ".tmp")
    for path in files:
        file_hash = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                file_hash.update(chunk)
        digest.update(path.relative_to(DATA).as_posix().encode())
        digest.update(file_hash.digest())
    version = digest.hexdigest()[:12]
    raw = INDEX.read_text(encoding="utf-8")
    index = json.loads(raw)
    index["assetVersion"] = version
    INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=2) + ("\n" if raw.endswith("\n") else ""), encoding="utf-8")
    print(f"assetVersion {version} from {len(files)} files")


if __name__ == "__main__":
    main()
