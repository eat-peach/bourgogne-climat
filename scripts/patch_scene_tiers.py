"""Apply explicit official designation tiers to an existing corrected export."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENES = ROOT / "website" / "corrected-source-scenes"
count = 0
for path in sorted(SCENES.glob("*.json")):
    scene = json.loads(path.read_text(encoding="utf-8"))
    for parcel in scene.get("parcels", []):
        designation = str(parcel.get("officialDenomination") or "")
        if re.search(r"premier cru|1er cru", designation, re.I):
            parcel["classification"] = "premier-cru"
            verification = parcel.setdefault("aocVerification", {})
            verification["officialTier"] = "Premier Cru"
            verification["verificationStatus"] = "official-source-matched"
            count += 1
    path.write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print({"premierCruRows": count, "sceneCount": len(list(SCENES.glob("*.json")))})
