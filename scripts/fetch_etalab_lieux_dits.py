#!/usr/bin/env python3
"""Download Etalab cadastre lieux-dits for every atlas commune (same release as the parcels).

Files are kept unmodified under ../work/cadastre/<release>/geojson/communes/<dept>/<code>/.
Licence Ouverte 2.0 — DGFiP cadastral data distributed by Etalab (cadastre.data.gouv.fr).
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

from build_cadastre import RELEASE, RAW_ROOT, download, read_index

BASE_URL = "https://cadastre.data.gouv.fr/data/etalab-cadastre/{release}/geojson/communes/{dept}/{code}/cadastre-{code}-lieux_dits.json.gz"


def target(code: str):
    dept = code[:2]
    return BASE_URL.format(release=RELEASE, dept=dept, code=code), RAW_ROOT / "geojson" / "communes" / dept / code / f"cadastre-{code}-lieux_dits.json.gz"


def fetch(code: str):
    url, path = target(code)
    try:
        download(url, path)
        return code, "ok", path.stat().st_size
    except Exception as error:  # report and continue: a missing commune must be visible, not fatal
        return code, f"failed: {error}", 0


def main() -> None:
    codes = sorted({str(v["id"]).rsplit("-", 1)[1] for v in read_index()})
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(fetch, codes))
    failed = [r for r in results if r[1] != "ok"]
    print(json.dumps({"release": RELEASE, "communes": len(codes), "downloaded": len(codes) - len(failed),
                      "bytes": sum(r[2] for r in results), "failed": failed}, ensure_ascii=False))


if __name__ == "__main__":
    main()
