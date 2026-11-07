# Data templates

The atlas data is not published here. Each data family under `dist/data/` (Burgundy) and `dist/rhone/data/` (Rhône)
has one skeleton below: the same file path and the same keys as the real files, with values replaced by
`<string>`, `<number>` or `<boolean>`. Lookup tables keyed by ids show one `<id>` entry; arrays show one element.
Gzipped JSON (`.json.gz`) is shown uncompressed. Build the real files with the scripts in `scripts/`
(for example `build_terroir.py`, `build_geology.py`) from the public sources named on the site's Sources page.

| Site data | Folder | Files | Count | Template |
|---|---|---|---|---|
| `dist/data` | `.` | `communes.json.gz` | 1 | [JSON skeleton](dist/data/communes.json) |
| `dist/data` | `.` | `context-terrain.json.gz` | 1 | [JSON skeleton](dist/data/context-terrain.json) |
| `dist/data` | `.` | `cru-index.json` | 1 | [JSON skeleton](dist/data/cru-index.json) |
| `dist/data` | `.` | `index-0.json` | 1 | [JSON skeleton](dist/data/index-0.json) |
| `dist/data` | `.` | `index-1.json` | 1 | [JSON skeleton](dist/data/index-1.json) |
| `dist/data` | `.` | `index-2.json` | 1 | [JSON skeleton](dist/data/index-2.json) |
| `dist/data` | `.` | `index-3.json` | 1 | [JSON skeleton](dist/data/index-3.json) |
| `dist/data` | `.` | `index.json` | 1 | [JSON skeleton](dist/data/index.json) |
| `dist/data` | `.` | `qa.json` | 1 | [JSON skeleton](dist/data/qa.json) |
| `dist/data` | `.` | `texture-manifest.json` | 1 | [JSON skeleton](dist/data/texture-manifest.json) |
| `dist/data` | `.` | `wine-region-assignments.js` | 1 | [JSON skeleton (from JS module)](dist/data/wine-region-assignments.js.json) |
| `dist/data` | `.` | `wine-region-assignments.json` | 1 | [JSON skeleton](dist/data/wine-region-assignments.json) |
| `dist/data` | `.` | `wine-regions.json` | 1 | [JSON skeleton](dist/data/wine-regions.json) |
| `dist/data` | `cadastre` | `#.json.gz` | 376 | [JSON skeleton](dist/data/cadastre/_template.json) |
| `dist/data` | `cadastre` | `manifest.json` | 1 | [JSON skeleton](dist/data/cadastre/manifest.json) |
| `dist/data` | `context-textures` | `#.avif` | 24 | binary (not templated) |
| `dist/data` | `context-textures` | `#.jpg` | 24 | binary (not templated) |
| `dist/data` | `feature-facts` | `#.json.gz` | 376 | [JSON skeleton](dist/data/feature-facts/_template.json) |
| `dist/data` | `geology` | `#.json` | 376 | [JSON skeleton](dist/data/geology/_template.json) |
| `dist/data` | `geology` | `legend.json` | 1 | [JSON skeleton](dist/data/geology/legend.json) |
| `dist/data` | `geology/tiles` | `#.json` | 331 | [JSON skeleton](dist/data/geology/tiles/_template.json) |
| `dist/data` | `navigator` | `#.json` | 376 | [JSON skeleton](dist/data/navigator/_template.json) |
| `dist/data` | `navigator` | `overview.json` | 1 | [JSON skeleton](dist/data/navigator/overview.json) |
| `dist/data` | `ownership` | `#.json.gz` | 376 | [JSON skeleton](dist/data/ownership/_template.json) |
| `dist/data` | `ownership` | `manifest.json` | 1 | [JSON skeleton](dist/data/ownership/manifest.json) |
| `dist/data` | `ownership` | `owner-crus.json.gz` | 1 | [JSON skeleton](dist/data/ownership/owner-crus.json) |
| `dist/data` | `ownership` | `owners.json.gz` | 1 | [JSON skeleton](dist/data/ownership/owners.json) |
| `dist/data` | `rainfields` | `#.bounds.json` | 305 | [JSON skeleton](dist/data/rainfields/_template.bounds.json) |
| `dist/data` | `rainfields` | `#.webp` | 610 | binary (not templated) |
| `dist/data` | `rainfields` | `index.json` | 1 | [JSON skeleton](dist/data/rainfields/index.json) |
| `dist/data` | `scenes` | `#.json.gz` | 376 | [JSON skeleton](dist/data/scenes/_template.json) |
| `dist/data` | `streams` | `#.json.gz` | 306 | [JSON skeleton](dist/data/streams/_template.json) |
| `dist/data` | `streams` | `index.json` | 1 | [JSON skeleton](dist/data/streams/index.json) |
| `dist/data` | `terroir` | `#.json` | 376 | [JSON skeleton](dist/data/terroir/_template.json) |
| `dist/data` | `terroir` | `scale.json` | 1 | [JSON skeleton](dist/data/terroir/scale.json) |
| `dist/data` | `textures` | `#.avif` | 376 | binary (not templated) |
| `dist/data` | `textures` | `#.jpg` | 376 | binary (not templated) |
| `dist/rhone/data` | `.` | `communes.json.gz` | 1 | [JSON skeleton](dist/rhone/data/communes.json) |
| `dist/rhone/data` | `.` | `context-terrain.json.gz` | 1 | [JSON skeleton](dist/rhone/data/context-terrain.json) |
| `dist/rhone/data` | `.` | `cru-index.json` | 1 | [JSON skeleton](dist/rhone/data/cru-index.json) |
| `dist/rhone/data` | `.` | `index.json` | 1 | [JSON skeleton](dist/rhone/data/index.json) |
| `dist/rhone/data` | `.` | `region.json` | 1 | [JSON skeleton](dist/rhone/data/region.json) |
| `dist/rhone/data` | `.` | `texture-manifest.json` | 1 | [JSON skeleton](dist/rhone/data/texture-manifest.json) |
| `dist/rhone/data` | `cadastre` | `#.json.gz` | 46 | [JSON skeleton](dist/rhone/data/cadastre/_template.json) |
| `dist/rhone/data` | `cadastre` | `manifest.json` | 1 | [JSON skeleton](dist/rhone/data/cadastre/manifest.json) |
| `dist/rhone/data` | `context-textures` | `#.avif` | 6 | binary (not templated) |
| `dist/rhone/data` | `context-textures` | `#.jpg` | 6 | binary (not templated) |
| `dist/rhone/data` | `geology` | `#.json` | 46 | [JSON skeleton](dist/rhone/data/geology/_template.json) |
| `dist/rhone/data` | `geology` | `legend.json` | 1 | [JSON skeleton](dist/rhone/data/geology/legend.json) |
| `dist/rhone/data` | `geology/tiles` | `#.json` | 52 | [JSON skeleton](dist/rhone/data/geology/tiles/_template.json) |
| `dist/rhone/data` | `navigator` | `#.json` | 46 | [JSON skeleton](dist/rhone/data/navigator/_template.json) |
| `dist/rhone/data` | `navigator` | `overview.json` | 1 | [JSON skeleton](dist/rhone/data/navigator/overview.json) |
| `dist/rhone/data` | `ownership` | `#.json.gz` | 46 | [JSON skeleton](dist/rhone/data/ownership/_template.json) |
| `dist/rhone/data` | `ownership` | `manifest.json` | 1 | [JSON skeleton](dist/rhone/data/ownership/manifest.json) |
| `dist/rhone/data` | `ownership` | `owner-crus.json.gz` | 1 | [JSON skeleton](dist/rhone/data/ownership/owner-crus.json) |
| `dist/rhone/data` | `ownership` | `owners.json.gz` | 1 | [JSON skeleton](dist/rhone/data/ownership/owners.json) |
| `dist/rhone/data` | `rainfields` | `index.json` | 1 | [JSON skeleton](dist/rhone/data/rainfields/index.json) |
| `dist/rhone/data` | `scenes` | `#.json.gz` | 46 | [JSON skeleton](dist/rhone/data/scenes/_template.json) |
| `dist/rhone/data` | `streams` | `index.json` | 1 | [JSON skeleton](dist/rhone/data/streams/index.json) |
| `dist/rhone/data` | `terroir` | `#.json` | 46 | [JSON skeleton](dist/rhone/data/terroir/_template.json) |
| `dist/rhone/data` | `terroir` | `scale.json` | 1 | [JSON skeleton](dist/rhone/data/terroir/scale.json) |
| `dist/rhone/data` | `textures` | `#.avif` | 46 | binary (not templated) |
| `dist/rhone/data` | `textures` | `#.jpg` | 46 | binary (not templated) |
| `scripts/data` | `.` | `feature-facts.json` | 1 | [JSON skeleton](scripts/data/feature-facts.json) |
| `scripts/data` | `.` | `sirene_names.json` | 1 | [JSON skeleton](scripts/data/sirene_names.json) |
