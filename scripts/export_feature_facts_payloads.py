"""Export lazy per-scene gzip payloads consumed by the feature detail panel."""
from __future__ import annotations

import gzip
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "website/scripts/data/feature-facts.json"
OUT = ROOT / "website/dist/data/feature-facts"

payload = json.loads(CATALOG.read_text(encoding="utf-8"))
groups = {}
for row in payload["features"]:
    groups.setdefault(row["sourceVillageId"], []).append(row)
OUT.mkdir(parents=True, exist_ok=True)
for village, rows in groups.items():
    target = OUT / f"{village}.json.gz"
    body = {"schemaVersion": payload["schemaVersion"], "sourceVillageId": village,
            "featureKey": payload["featureKey"], "features": rows,
            "citations": payload["citations"]}
    with gzip.open(target, "wt", encoding="utf-8", compresslevel=9) as stream:
        json.dump(body, stream, ensure_ascii=False, separators=(",", ":"))
print(f"wrote {len(groups)} payloads to {OUT}")
