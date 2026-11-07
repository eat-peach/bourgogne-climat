"""Write dist/data/cru-index.json: every grand and premier cru AOC area, for the sidebar search.

Each cru is listed once, under the scene of its own commune (scenes also carry
their neighbours' crus). Umbrella areas such as "Vosne-Romanee premier cru"
without a climat name are left out. Run after the scenes are final, before
stamp_asset_version.py.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
DATA = WEB / "dist" / "data"
OUT = DATA / "cru-index.json"


def short_name(p: dict) -> str:
    """'Vosne-Romanee premier cru Les Gaudichots' -> 'Les Gaudichots'; grand crus keep their name."""
    name = str(p.get("name") or "").strip()
    marker = " premier cru "
    i = name.lower().find(marker)
    return name[i + len(marker):].strip() if i >= 0 else name


def main() -> None:
    index = json.loads((DATA / "index.json").read_text("utf8"))
    crus, seen = [], set()
    for village in index["villages"]:
        code = village["id"].rsplit("-", 1)[1]
        scene = json.loads(gzip.decompress((WEB / "dist" / village["scene"]).read_bytes()))
        for p in scene.get("parcels", []):
            cls = p.get("classification")
            if cls not in ("grand-cru", "premier-cru") or str(p.get("insee")) != code:
                continue
            name = short_name(p)
            if not name or name.lower().endswith("premier cru"):
                continue
            key = (p.get("id"), code)
            if key in seen:
                continue
            seen.add(key)
            crus.append({"name": name, "full": p.get("name"), "class": cls, "village": village["id"], "id": p.get("id")})
    crus.sort(key=lambda c: (c["class"] != "grand-cru", c["name"]))
    OUT.write_text(json.dumps({"crus": crus}, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
    print(json.dumps({"crus": len(crus), "grandCrus": sum(c["class"] == "grand-cru" for c in crus), "bytes": OUT.stat().st_size}))


if __name__ == "__main__":
    main()
