#!/usr/bin/env python3
"""Move raw scene JSON out of the deploy tree and publish deterministic gzip payloads."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "website"
DIST = SITE / "dist"
SCENES = DIST / "data" / "scenes"
RAW_SCENES = SITE / "source-scenes"
INDEX_PATH = DIST / "data" / "index.json"
GZIP_LEVEL = 9


def gzip_bytes(payload: bytes) -> bytes:
    return gzip.compress(payload, compresslevel=GZIP_LEVEL, mtime=0)


def replace_file(path: Path, payload: bytes) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def scene_payloads() -> list[Path]:
    return sorted(path for path in SCENES.glob("*.json") if path.is_file())


def update_index() -> int:
    index = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    records = index.get("villages", [])
    if not isinstance(records, list):
        raise ValueError("index.json villages must be an array")
    changed = 0
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("scene"), str):
            raise ValueError("index.json contains a record without a scene URL")
        scene = record["scene"]
        if scene.endswith(".json"):
            record["scene"] = scene + ".gz"
            changed += 1
        elif not scene.endswith(".json.gz"):
            raise ValueError(f"unsupported scene URL: {scene}")
    replace_file(INDEX_PATH, (json.dumps(index, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return changed


def compress_scene(path: Path) -> tuple[str, int, int]:
    payload = path.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    raw_path = RAW_SCENES / path.name
    gz_path = path.with_name(path.name + ".gz")
    compressed = gzip_bytes(payload)
    if gzip.decompress(compressed) != payload:
        raise ValueError(f"gzip round-trip mismatch for {path.name}")

    RAW_SCENES.mkdir(parents=True, exist_ok=True)
    replace_file(gz_path, compressed)
    os.replace(path, raw_path)
    if hashlib.sha256(raw_path.read_bytes()).hexdigest() != digest:
        raise ValueError(f"raw source checksum mismatch for {path.name}")
    if gzip.decompress(gz_path.read_bytes()) != raw_path.read_bytes():
        raise ValueError(f"published gzip mismatch for {path.name}")
    return path.stem, len(payload), len(compressed)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-count", type=int, default=376)
    args = parser.parse_args()
    paths = scene_payloads()
    if len(paths) != args.expected_count:
        raise SystemExit(f"Expected {args.expected_count} raw scene JSON files, found {len(paths)}")
    results = [compress_scene(path) for path in paths]
    changed = update_index()
    print(f"Compressed {len(results)} scenes at gzip level {GZIP_LEVEL}; updated {changed} index URLs")
    print(f"Raw bytes: {sum(raw for _, raw, _ in results)}")
    print(f"Compressed bytes: {sum(compressed for _, _, compressed in results)}")
    print(f"Raw sources: {RAW_SCENES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
