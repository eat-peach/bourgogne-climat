"""Write dist/<site>/index.html for a region atlas, derived from the Burgundy page (dist/index.html).

The region page runs the same engine one folder down: shared code, styles and vendor files are referenced from
the parent folder, data comes from dist/<site>/data/ (region_build.py), and <meta name="atlas-region"> makes
app.js load the region's classes, groups and names. Rerun after changing dist/index.html.

Usage: python region_page.py rhone-nord
"""
from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]


def main(region_id: str) -> None:
    cfg = json.loads((WEB / "regions" / region_id / "region.json").read_text("utf8"))
    page = (WEB / "dist" / "index.html").read_text("utf8")
    title, brand, desc = html.escape(cfg["title"]), html.escape(cfg["brand"]), html.escape(cfg["description"], quote=True)
    replacements = [
        ("<title>Bourgogne Climat</title>", f"<title>{title}</title>"),
        ('content="Interactive 3D atlas of Burgundy villages, terrain, vineyards, and mapped source layers."', f'content="{desc}"'),
        ('"three":"./vendor/three.module.js","three/addons/":"./vendor/"', '"three":"../vendor/three.module.js","three/addons/":"../vendor/"'),
        ('<link rel="stylesheet" href="./style.css" />', f'<link rel="stylesheet" href="../style.css" />\n  <meta name="atlas-region" content="data/region.json" />'),
        ('src="./app.js"', 'src="../app.js"'),
        ('href="./legal.html"', 'href="../legal.html"', "all"),
        ('aria-label="Bourgogne Climat: choose an atlas"><span>BOURGOGNE CLIMAT</span>', f'aria-label="{title}: choose an atlas"><span>{brand}</span>'),
        ("BOURGOGNE CLIMAT / 2026", f"{brand} / 2026"),
        ('placeholder="Search villages and crus…"', 'placeholder="Search villages and lieux-dits…"'),
    ]
    # Region wording (region.json "terms"): e.g. communes instead of villages, areas instead of wine regions.
    t = {k: html.escape(v) for k, v in cfg.get("terms", {}).items()}
    if t:
        replacements += [
            ("Village index", f"{t['Village']} index", "all"), ("village index", f"{t['village']} index", "all"),
            ("Search villages", f"Search {t['villages']}", "all"), ("Selected village", f"Selected {t['village']}", "all"),
            ("Village & terrain context", f"{t['Village']} & terrain context"), ('aria-label="Villages"', f'aria-label="{t["Villages"]}"'),
            ("relief of the village", f"relief of the {t['village']}"), ("navigable village scene", f"navigable {t['village']} scene"),
            ("All wine regions", t["allWineRegions"], "all"), ("Wine region filter", f"{t['WineRegion']} filter", "all"), (">Wine region<", f">{t['WineRegion']}<"),
        ]
    replacements += [(old, html.escape(new), "all") for old, new in cfg.get("pageReplacements", [])]
    for old, new, *mode in replacements:
        count = page.count(old)
        if count == 0 or (count > 1 and mode != ["all"]):
            raise SystemExit(f"expected {'at least' if mode else 'exactly'} one {old!r} in dist/index.html; update region_page.py")
        page = page.replace(old, new)
    # The atlas list stays in dist/index.html: seen from a region folder, every link moves up one level, and this
    # region's own entry becomes the current page.
    def relink(match):
        links = re.sub(r'href="\./', 'href="../', match.group(0)).replace(' aria-current="page"', "")
        here = f'<a href="../{cfg["site"]}/">'
        if links.count(here) != 1 and cfg.get("pilot"):  # a local pilot is not in the public list: only its own page lists it
            links = links.replace("</nav>", f'{here}{html.escape(cfg["title"])}</a></nav>')
        if links.count(here) != 1:
            raise SystemExit(f"add {cfg['site']} to the atlas list in dist/index.html")
        return links.replace(here, '<a href="./" aria-current="page">')
    page, found = re.subn(r'<nav aria-label="Atlases">.*?</nav>', relink, page, flags=re.S)
    if found != 1:
        raise SystemExit("atlas list not found in dist/index.html; update region_page.py")
    out = WEB / "dist" / cfg["site"] / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf8")
    print("wrote", out.relative_to(WEB))


if __name__ == "__main__":
    main(sys.argv[1])
