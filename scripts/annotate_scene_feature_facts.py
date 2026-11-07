"""Attach stable facts keys to served source features without changing geometry.

Matching is conservative: a served feature must be a polygonal subset of one
source feature with the same layer, source id, and name. Bounding boxes are
used nowhere in the decision, so overlapping candidates become unmatched.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from make_exclusive_parcels import source_geometry

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = ROOT / "website/source-scenes"
DEFAULT_DIST = ROOT / "website/dist/data/scenes"
MATCH_TOLERANCE_M2 = 0.01
FACT_FIELDS = ("factsKey", "factsVillageId")


def feature_name(feature: dict[str, Any]) -> str:
    return str(feature.get("name") or feature.get("nom") or "")


def feature_group_key(feature: dict[str, Any]) -> tuple[str, str]:
    return str(feature.get("id") or ""), feature_name(feature)


def source_candidates(source: dict[str, Any], layer: str) -> dict[tuple[str, str], list[tuple[int, dict[str, Any]]]]:
    groups: dict[tuple[str, str], list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for ordinal, feature in enumerate(source.get(layer) or []):
        groups[feature_group_key(feature)].append((ordinal, feature))
    return groups


def matching_source_ordinal(feature: dict[str, Any], candidates: list[tuple[int, dict[str, Any]]]) -> tuple[int | None, str]:
    display = source_geometry(feature)
    if display is None or display.is_empty or display.area <= 0:
        return None, "invalid_display_geometry"
    matches: list[int] = []
    for ordinal, original in candidates:
        source = source_geometry(original)
        if source is None or source.is_empty or source.area <= 0:
            continue
        try:
            outside = float(display.difference(source).area)
            overlap = float(display.intersection(source).area)
        except Exception:
            continue
        if outside <= MATCH_TOLERANCE_M2 and overlap > MATCH_TOLERANCE_M2:
            matches.append(ordinal)
    if len(matches) == 1:
        return matches[0], "matched"
    if len(matches) > 1:
        return None, "ambiguous_candidates"
    return None, "no_containing_source"


def annotate_scene(scene: dict[str, Any], source: dict[str, Any], scene_id: str) -> dict[str, int]:
    stats = Counter()
    for layer in ("climats", "parcels"):
        groups = source_candidates(source, layer)
        for feature in scene.get(layer) or []:
            for field in FACT_FIELDS:
                feature.pop(field, None)
            sid = str(feature.get("id") or "")
            ordinal, status = matching_source_ordinal(feature, groups.get((sid, feature_name(feature)), []))
            stats[status] += 1
            if ordinal is None:
                continue
            source_id = sid or str(ordinal)
            feature["factsKey"] = f"{layer}:{scene_id}:{source_id}:{ordinal}"
            feature["factsVillageId"] = scene_id
    return dict(stats)


def load_gzip_json(path: Path) -> dict[str, Any]:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def write_gzip_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    fd, temporary = tempfile.mkstemp(prefix=path.stem, suffix=".tmp", dir=path.parent)
    os.close(fd)
    try:
        with open(temporary, "wb") as raw:
            with gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=9, mtime=0) as compressed:
                with io.TextIOWrapper(compressed, encoding="utf-8") as stream:
                    json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def annotate_all(source_dir: Path = DEFAULT_SOURCE, dist_dir: Path = DEFAULT_DIST) -> dict[str, Any]:
    summary = Counter()
    scenes = 0
    for path in sorted(dist_dir.glob("*.json.gz")):
        scene_id = path.name[:-8]
        source_path = source_dir / f"{scene_id}.json"
        if not source_path.exists():
            summary["missing_source"] += 1
            continue
        source = json.loads(source_path.read_text(encoding="utf-8"))
        scene = load_gzip_json(path)
        summary.update(annotate_scene(scene, source, scene_id))
        write_gzip_json_atomic(path, scene)
        scenes += 1
    summary["scenes"] = scenes
    return dict(summary)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--dist-dir", type=Path, default=DEFAULT_DIST)
    args = parser.parse_args()
    print(json.dumps(annotate_all(args.source_dir, args.dist_dir), sort_keys=True))


if __name__ == "__main__":
    main()
