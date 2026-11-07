#!/usr/bin/env python3
"""Give lieux-dits the official cru name when they are the same place as an INAO cru.

Bourgogne Maps and INAO sometimes spell the same vineyard differently:
"Clos de Vougeot ou Clos Vougeot" vs "Clos de Vougeot", "LES CHARMES" vs "Charmes".
The map then labels one place twice. This script records the official INAO
denomination as `displayName` on the lieu-dit (the source `name` is kept) when
BOTH conditions hold:

1. the names match exactly once accents, case and punctuation are ignored, either
   as they are (official spelling), after splitting the source name on " ou " /
   "/" (alternative names), or after dropping one leading article (le, la, les,
   l', au, aux); and
2. the polygons are the same place: the smaller of the two lies at least
   MIN_CONTAINED inside the other, and the overlap is at least MIN_SHARED of
   the larger.

Pairs that match by name but fail the geometry test are reported and left alone.
Usage: harmonise_cru_names.py [--write] [--report work/cru-name-harmonisation.json]
Run after the scene payloads are final and before stamp_asset_version.py.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import unicodedata
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
SCENES = SITE / "dist" / "data" / "scenes"
MIN_CONTAINED = 0.6
MIN_SHARED = 0.25
SAMPLES = 40  # per axis over the smaller polygon's bounding box
ARTICLE = re.compile(r"^(les|le|la|l|aux|au)(?=[a-z0-9])")


def fold(text: str) -> str:
    text = unicodedata.normalize("NFD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", text)


def fold_words(text: str) -> list[str]:
    text = unicodedata.normalize("NFD", text).encode("ascii", "ignore").decode().lower()
    return [w for w in re.split(r"[^a-z0-9]+", text) if w]


def without_article(text: str) -> str:
    words = fold_words(text)
    if len(words) > 1 and words[0] in {"les", "le", "la", "l", "aux", "au"}:
        words = words[1:]
    return "".join(words)


def cru_label(name: str) -> str:
    if re.search(r"\bpremier cru\b", name, re.I):
        return re.sub(r"^.*?\bpremier cru\b\s*", "", name, flags=re.I).strip()
    return name.strip()


def polygons(rings) -> list[list[list[list[float]]]]:
    """Normalise nested rings to [[outer, hole...], ...]."""
    out = []

    def visit(value):
        if not isinstance(value, list) or not value:
            return
        if isinstance(value[0], (int, float)):
            return
        if isinstance(value[0], list) and value[0] and isinstance(value[0][0], (int, float)):
            out.append([value])
            return
        if isinstance(value[0], list) and value[0] and isinstance(value[0][0], list) and value[0][0] and isinstance(value[0][0][0], (int, float)):
            out.append(value)
            return
        for item in value:
            visit(item)

    visit(rings)
    return out


def inside_ring(x: float, y: float, ring) -> bool:
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            hit = not hit
        j = i
    return hit


def inside(x: float, y: float, polys) -> bool:
    for poly in polys:
        if inside_ring(x, y, poly[0]) and not any(inside_ring(x, y, hole) for hole in poly[1:]):
            return True
    return False


def ring_area(ring) -> float:
    return abs(sum((ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]) for i, j in zip(range(len(ring)), [len(ring) - 1, *range(len(ring) - 1)])) / 2)


def area(polys) -> float:
    return sum(ring_area(p[0]) - sum(ring_area(h) for h in p[1:]) for p in polys)


def bbox(polys):
    xs = [v[0] for p in polys for v in p[0]]
    ys = [v[1] for p in polys for v in p[0]]
    return min(xs), min(ys), max(xs), max(ys)


def overlap(small, large, small_area) -> float:
    """Approximate area of small ∩ large by sampling a grid over small's bounding box."""
    x0, y0, x1, y1 = bbox(small)
    cell = ((x1 - x0) / SAMPLES) * ((y1 - y0) / SAMPLES)
    inside_small = shared = 0
    for i in range(SAMPLES):
        for j in range(SAMPLES):
            x = x0 + (i + 0.5) * (x1 - x0) / SAMPLES
            y = y0 + (j + 0.5) * (y1 - y0) / SAMPLES
            if inside(x, y, small):
                inside_small += 1
                if inside(x, y, large):
                    shared += 1
    if not inside_small:
        return 0.0
    # Scale the sampled fraction by the exact area of the small polygon.
    return small_area * shared / inside_small


def boxes_touch(a, b) -> bool:
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def name_match(source: str, official: str) -> str | None:
    target = fold(official)
    if fold(source) == target:
        # Same letters: only capitals or accents differ ("LES SUCHOTS" vs "Les Suchots").
        return None if source == official else "official-spelling"
    alternatives = [part for part in re.split(r"\s+ou\s+|/", source, flags=re.I) if part.strip()]
    if len(alternatives) > 1 and any(fold(part) == target for part in alternatives):
        return "alternate-name"
    if without_article(source) == without_article(official):
        return "article-variant"
    return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="update the scene payloads (default: report only)")
    parser.add_argument("--report", default=str(SITE / "work" / "cru-name-harmonisation.json"))
    args = parser.parse_args()

    applied, rejected = {}, []
    for path in sorted(SCENES.glob("*.json.gz")):
        raw = gzip.decompress(path.read_bytes())
        scene = json.loads(raw)
        crus = []
        for parcel in scene.get("parcels", []):
            if parcel.get("classification") not in ("grand-cru", "premier-cru"):
                continue
            label = cru_label(str(parcel.get("name") or parcel.get("officialDenomination") or ""))
            polys = polygons(parcel.get("rings"))
            if label and polys:
                crus.append({"label": label, "polys": polys, "box": bbox(polys), "area": area(polys), "parcel": parcel})
        for climat in scene.get("climats", []):
            source = str(climat.get("name") or "")
            polys = polygons(climat.get("rings"))
            if not source or not polys:
                continue
            box, climat_area = bbox(polys), area(polys)
            best = None
            for cru in crus:
                basis = name_match(source, cru["label"])
                if not basis or not boxes_touch(box, cru["box"]):
                    continue
                small, large, small_area, large_area = (polys, cru["polys"], climat_area, cru["area"]) if climat_area <= cru["area"] else (cru["polys"], polys, cru["area"], climat_area)
                shared = overlap(small, large, small_area)
                contained, of_larger = shared / small_area if small_area else 0, shared / large_area if large_area else 0
                record = {"scene": path.name, "lieuDitId": climat.get("id"), "sourceName": source, "officialName": cru["label"], "classification": cru["parcel"].get("classification"),
                          "inaoId": cru["parcel"].get("idDenom") or cru["parcel"].get("id"), "basis": basis, "contained": round(contained, 3), "sharedOfLarger": round(of_larger, 3)}
                # Spelling-only matches (same letters) need one polygon inside the other, not similar sizes:
                # a premier cru often covers only part of the lieu-dit it is named after.
                if contained >= MIN_CONTAINED and (of_larger >= MIN_SHARED or basis == "official-spelling"):
                    if not best or contained > best["contained"]:
                        best = record
                else:
                    rejected.append(record)
            if best and best["lieuDitId"] is not None and str(best["lieuDitId"]) not in applied:
                applied[str(best["lieuDitId"])] = best

    # Lieux-dits are copied into every neighbouring commune's scene; give all copies the same name.
    copies = 0
    for path in sorted(SCENES.glob("*.json.gz")):
        scene = json.loads(gzip.decompress(path.read_bytes()))
        changed = False
        for climat in scene.get("climats", []):
            match = applied.get(str(climat.get("id")))
            if not match:
                continue
            copies += 1
            basis = f"{match['basis']}; same place as INAO {match['classification']} {match['officialName']} ({match['contained']:.0%} contained)"
            if args.write and (climat.get("displayName") != match["officialName"] or climat.get("displayNameBasis") != basis):
                climat["displayName"] = match["officialName"]
                climat["displayNameBasis"] = basis
                changed = True
        if args.write and changed:
            path.write_bytes(gzip.compress(json.dumps(scene, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), compresslevel=9, mtime=0))

    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps({"applied": list(applied.values()), "copiesUpdated": copies, "rejected": rejected, "thresholds": {"minContained": MIN_CONTAINED, "minSharedOfLarger": MIN_SHARED}}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{'Applied' if args.write else 'Would apply'} {len(applied)} harmonised names to {copies} scene copies; rejected {len(rejected)} name matches on geometry. Report: {args.report}")


if __name__ == "__main__":
    main()
