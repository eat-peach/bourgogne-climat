# Bourgogne living atlas

This is a buildless static Three.js viewer. Serve `dist/` over HTTP so ES modules, compressed scene payloads, textures, and the import map resolve correctly.

```powershell
cd "E:\Burgundy Map\website"
python scripts/serve.py
```

Open the URL printed by the server. The viewer loads `dist/data/index.json`; each `villages[]` entry must include `id`, `name`, `department`, WGS84 `center`, and a relative `scene` URL. The scene JSON uses EPSG:2154 metre coordinates, `bounds: [xmin, ymin, xmax, ymax]`, `gridSize: 129`, flat row-major `heights`, `minElevation`, `maxElevation`, and optional `texture`, `parcels`, `climats`, `forests`, `roads`, and `buildings` arrays. Polygon features use nested `rings`; road features use numeric `coordinates`.

Terrain sources use fresh IGN WMS scene-grid extraction for the 21 scenes requiring it, with RGE ALTI® and coarse overview terrain for the remaining coverage. Aerial textures come from the prepared orthophoto assets. The web previews are RGB JPEGs capped at a 1280px edge and encoded at quality 72; the source orthophoto assets remain at their original resolution outside this site. AOC parcel classifications come from the INAO data; lieux-dits come from the DGFiP cadastre distributed by Etalab (Licence Ouverte 2.0); buildings, roads, and forest masks come from IGN BD TOPO®. Display overlays use one class per area for clear viewing; the retained source scenes keep the original INAO names and classifications. Source gaps and informative boundary limits are documented in the Sources panel.

The `window.atlasDebug` object exposes the currently loaded village, renderer stats, and resource errors for browser QA.

Map labels come from two sources: grand and premier crus from the INAO AOC layer (shown at every zoom; premier cru names drop their appellation prefix) and lieux-dits from the DGFiP cadastre via Etalab (those inside an AOC area from a 5 km view radius, the rest from 2.5 km). Labels are ranked by tier, the smallest grand crus first so Romanée-Conti is not crowded out by its larger neighbours, and placed without overlapping the toolbar, rails, Move pad or open panels. Capitalised source names are shown in title case. Labels use Source Serif 4, self-hosted in `dist/vendor/fonts/source-serif-4/` under the SIL Open Font License (`OFL.txt`), so no request goes to a third-party font service.

Clicking a named climat label or mapped boundary selects that feature and outlines its complete polygon without rebuilding the terrain. A click callback receives the feature, its layer (`climats` or `parcels`), and provenance metadata when available (`factsKey` and `factsVillageId`); drag gestures are ignored.

Exclusive display geometry is checked across scene boundaries as well as within each scene. The export removes tiny clipping slivers with a 2 cm display-only clearance where needed; original source geometry is retained. Run `scripts/make_exclusive_parcels.py --audit-only` to check the saved payloads and write `work/exclusive-classification-audit.json`.

The viewer supports continuous regional browsing: left-drag rotates by default, Shift-drag pans across communes, right-drag rotates, and scroll zooms. The compact Left drag control switches the left button between Rotate and Pan; the right button remains Rotate. The always-visible screen-relative Move pad and Arrow keys also pan the map; they do not represent cardinal north/south directions when the camera is rotated. Terrain exaggeration is available at 1×, 2×, 3×, and 4×; the initial view uses 3× terrain and 25% AOC fill. AOC classes use one consistent color for each class and are rendered as a filled overlay over aerial imagery, with the existing class controls and opacity behavior. The Layers menu names the INAO AOC boundaries separately from the cadastral lieux-dits. When the view moves beyond fine village imagery or terrain coverage, the atlas uses neutral 200 m IGN context terrain and labels that context coverage in the view.

Feature facts regeneration runs after the exclusive display export so source geometry remains the area basis:

```powershell
$env:PYTHONPATH = 'E:\Burgundy Map\work\pydeps'
python website/scripts/build_feature_facts.py
python website/scripts/export_feature_facts_payloads.py
python website/scripts/annotate_scene_feature_facts.py
```

The final annotation step matches served fragments to original source geometry; it must run after exclusive parcel generation. Mapped area is source geometry area, not official planted hectares. Terrain altitude is an interior terrain-grid estimate. Soil and geology stay explicitly unavailable unless an authoritative source matches the exact feature scope; the six Vosne Grand Cru named features use the cited BIVB Grand Cru sheet.

Some scene buffers extend beyond the available terrain source. Where `coverage.terrainEdgeFillUsed` is true, those samples use the nearest available source elevation; the scene metadata may provide `terrainEdgeFillCount` for the affected cells.

When rebuilding the atlas, run `scripts/build_atlas.py`, then `scripts/build_textures.py`, then `scripts/finalize_atlas.py`. Run `scripts/repair_terrain_wms.py` last, after finalization, so its actual IGN source terrain caches replace the affected 21 generated grids. Then run `scripts/compress_scene_payloads.py` to gzip the 376 scene payloads and move their exact raw JSON into `source-scenes/` for source retention. After compression, run `scripts/make_exclusive_parcels.py` to rebuild mutually exclusive display geometry in the gzip payloads while leaving `source-scenes/` unchanged. Run `scripts/validate_site.py` only after both compression and exclusive display geometry; rebuilding the atlas afterward would overwrite repaired grids and requires compression again.

After any texture rebuild, run `scripts/build_avif_textures.py` to write the AVIF copies (the viewer loads AVIF where the browser supports it and falls back to the JPEG). Then run `scripts/harmonise_cru_names.py --write`: where a cadastral lieu-dit is the same place as an INAO cru but spelled differently (capitals without accents, or "X ou Y" alternatives), it records the official name as `displayName` and keeps the source `name`. It only acts when the names match exactly as alternatives (or after dropping one article) **and** the polygons coincide (smaller one at least 60% inside the other); its report, `work/cru-name-harmonisation.json`, lists both the applied changes and the name matches it rejected on geometry. After **any** data change, run `scripts/stamp_asset_version.py` last: it stamps `index.json` with an `assetVersion` hash of every data file. The viewer requests scenes, textures, cadastre, ownership and feature facts with `?v=<assetVersion>`, and `dist/_headers` lets browsers keep those folders for a year, so skipping this step would leave visitors on cached copies.

## Wine-region navigation

The village index can be browsed in seven north-to-south navigation groups: Chablis & Grand Auxerrois, Châtillonnais, Côte de Nuits & Hautes Côtes, Côte de Beaune & Hautes Côtes, Côte Chalonnaise & Couchois, Mâconnais, and Beaujolais. Villages within each group are ordered by descending WGS84 latitude, with the explicit ID assignment in `dist/data/wine-region-assignments.json` serving as the source of truth.

These are browsing groups based on the BIVB regional sequence and named commune evidence. They are not legal appellation boundaries. Some communes overlap wine areas: the Beaujolais group includes the documented southern Saône-et-Loire extension, while Chasselas, Leynes, Chaintré, Chânes, and Saint-Vérand remain in the Mâconnais navigation group with that overlap recorded in `dist/data/wine-regions.json`. Boundary sources and reviewed transition communes are documented in that file.


## Lieux-dits

Lieux-dits come from the DGFiP cadastre distributed by Etalab (`scripts/fetch_etalab_lieux_dits.py`, release 2026-09-01, Licence Ouverte 2.0). They replaced the Bourgogne Maps layer, whose BIVB terms only allow private use. `scripts/build_etalab_lieux_dits.py` joins same-name cadastral pieces in each commune, keeps the lieux-dits that touch an AOC area, adds the sub-climats the atlas author defined from cadastral parcels in `work/lieu-dit-parcels.csv` (rows marked yes), and recomputes AOC eligibility, cru identity and selection outlines from the INAO data exactly as the earlier scripts did. It then writes the lieu-dit layer of every served scene. Run it after the scene payloads are final, then `harmonise_cru_names.py --write`, `build_cru_index.py` (the grand and premier crus offered by the sidebar search) and `stamp_asset_version.py`. The AOC coverage step takes about 25 minutes; when only the identity, naming or writing steps change, `--reuse-spatial` reuses the saved coverage results (`../work/aoc-full-audit/spatial-aoc-source-results.json`). Display names are French title case ("Les Crays de Boye"); cru names take the official INAO spelling with accents through `harmonise_cru_names.py`, but other cadastral names stay without accents because the cadastre does not record them. The older `attach_spatial_aoc_eligibility.py`, `audit_named_feature_identity.py` and `prepare_vineyard_selection.py` still read the Bourgogne Maps GeoPackage and must not be rerun on the served scenes.

## Cadastral parcels

The optional, default-on Cadastral parcels layer uses the pinned 2026-09-01 Cadastre Etalab release: DGFiP cadastral data transformed and distributed by Etalab/DINUM under Licence Ouverte 2.0. It contains 1,043,101 parcel records across all 376 indexed communes. It is independent of INAO appellation and named climat boundaries.

Boundaries appear below a 2,200 m view radius. The loader requests up to six nearby communes, keeps eight in memory, and the renderer batches up to 5,000 nearby parcel outlines. Clicking a parcel shows its reference, recorded cadastral area, calculated geometry area, dataset release and original source URL. The release is not a per-parcel survey date; cadastral parcels do not establish vineyard ownership or wine classification.

Regenerate with `python scripts/build_cadastre.py` using the GIS Python dependencies. Original compressed GeoJSON is retained under `../work/cadastre/2026-09-01/`; compact EPSG:2154 exports and the source manifest live in `dist/data/cadastre/`. Run `python scripts/validate_cadastre.py` to check coverage and exported records without downloading again. This update is served locally by the existing preview server.

## AOC verification

The atlas AOC reference audit covers 376 communes and the 2026-10-19 INAO parcel snapshot. Legal AOC records, parent appellations, Premier Cru denominations, and exclusive physical climat display geometry are tracked separately. See [`work/aoc-full-audit/VERIFICATION.md`](../work/aoc-full-audit/VERIFICATION.md) for scope, historical INSEE crosswalks, overlap families, and primary references.

## Recorded parcel rights

Cadastral selections lazily load the DGFiP legal-entity parcel-rights release as of **1 January 2025**, the latest release listed by the official portal when checked on 24 October 2026. Exact 14-character parcel IDs match 222,908 of the 1,043,101 displayed parcels, with 233,788 distinct entity/right records across all 376 communes. A separate named-column parser compared every published match to the four original departmental CSVs (21, 69, 71, 89), finding zero mismatches; proof is in `../work/ownership/validation.json`.

The source omits individuals, unipersonal companies and individual entrepreneurs. An unmatched parcel does not establish its owner's identity or legal status. A recorded right is dated and does not establish current ownership or vineyard operation. Multiple rights are preserved. Non-numeric substitute identifiers in the source SIREN field are labelled DGFiP entity identifiers.

Source: https://data.economie.gouv.fr/explore/dataset/fichiers-des-locaux-et-des-parcelles-des-personnes-morales/

Reproduce with `scripts/acquire_dgfip_ranges.py`, then `scripts/build_parcel_ownership.py --ownership-root ../work/ownership/raw-2025`, and `scripts/validate_parcel_ownership.py`. Payloads are cached for up to eight communes; failed downloads remain distinct from successful searches without a match.

For the verified AOC export, use `scripts/repair_aoc_data.py --official-shp <pinned INAO SHP> --update-index`, then `scripts/refine_aoc_interpretations.py --source corrected-source-scenes --out <new derived directory>`, and `scripts/make_exclusive_parcels.py --source-dir <derived directory>`. The original source scenes are immutable. Run the legal validator against corrected source rings, before the intentional display masks.

The local static dataset is about 407 MB. The existing 256 MiB publication-size gate therefore fails; source, scene and JavaScript structural checks passed. Hosting would require separating bulk GIS payloads from the site bundle. No publication was performed.

## Selected-feature presentation

The information drawer leads with area (hectares, km² and acres), an approximate elevation and dated legal-entity rights. Cadastral area is the primary parcel measurement; the separate mapped-polygon calculation remains under Sources & details. Physical vineyard area, mapped named-place area and legal AOC eligibility retain their distinct labels. Identifiers, alternative area scopes, source dates and caveats are expandable rather than repeated in the main summary.

Where a feature lacks an existing elevation fact, its bounding-box centre is sampled from available IGN source grids using the existing gap-aware bilinear sampler. This is labelled an approximate elevation near the mapped centre, with the grid spacing. It is neither a measured parcel elevation nor a parcel-wide elevation range. Terrain exaggeration does not change the estimate. No soil/geology information is displayed.

The selected-place panel uses a separate cru and village title line, a primary hectare measurement with aligned km²/acre columns, an elevation summary, and recorded ownership. Legal-entity capitalization and source dates are formatted for reading in the summary; original legal names, identifiers and ISO dates remain in Sources & details.


All soil/geology content and its citations have been removed from the public feature-facts payloads and the generator. The information panel now presents area, elevation and ownership in a consistent left-aligned layout. Raw reference documents are retained outside the public site.

## Feedback and correction requests

Visitors can send general feedback (top bar → Feedback) or a correction for a selected lieu-dit, AOC area or cadastral parcel (info panel → Suggest a correction). Both accept up to three photos. Submissions are private: they are stored in Cloudflare D1 (text) and R2 (photos) and reviewed at `/admin`.

The site is deployed as a Cloudflare Worker with static assets (`wrangler.jsonc`). Only `/api/*` runs `worker/index.js`; everything else is served from `dist/`. With the Python dev server the atlas works as before and the forms report that submissions are unavailable.

Safeguards:

- Cloudflare Turnstile on every submission, verified server-side (including the expected action).
- Same-origin check, multipart-only, 14 MB request cap, a hidden honeypot field.
- Photo storage is capped at 5 GB (`LIMITS.photoStorageBytes`, summed from `photo_bytes`); once full the form hides its photo field and text submissions still work.
- Rate limits: 5 per hour and 15 per day per visitor, 300 per day site-wide (`worker/submissions.js` `LIMITS`).
- Text is normalised, stripped of control/bidi characters, length-limited, and link-heavy messages are rejected. Correction targets are whitelisted fields only.
- Photos are re-encoded in the browser (max 2000 px JPEG), which removes EXIF/GPS metadata; the Worker accepts only files whose bytes are JPEG, PNG or WebP, max 4 MB each.
- IP addresses are stored only as a salted SHA-256 hash. Nothing submitted is ever shown on the public site; the admin page renders it as plain text.
- `/admin` signs in with a password. The Worker keeps only its salted PBKDF2 hash (`ADMIN_PASSWORD_HASH`, made by `scripts/hash_admin_password.mjs`); a correct password returns a signed 12-hour session token, and 5 failed sign-ins per IP within 15 minutes lock that IP out for the rest of the window (`admin_failures` table). Photos are served only to the admin, with a sandboxing CSP. Consider also putting Cloudflare Access in front of `/admin*`.

Local development:

```powershell
cd "E:\Burgundy Map\website"
copy .dev.vars.example .dev.vars   # then fill IP_HASH_SALT with 32+ random characters and ADMIN_PASSWORD_HASH (see below)
wrangler d1 migrations apply bourgogne-climat-feedback --local
wrangler dev --port 8787
```

The local setup uses Cloudflare's always-pass Turnstile test keys. Before deploying: create a Turnstile widget for the production hostname, put its site key in `wrangler.jsonc` (`TURNSTILE_SITE_KEY`), then

```powershell
wrangler secret put TURNSTILE_SECRET_KEY
$env:ADMIN_PASSWORD='...'; node scripts/hash_admin_password.mjs | wrangler secret put ADMIN_PASSWORD_HASH; Remove-Item Env:ADMIN_PASSWORD
wrangler secret put IP_HASH_SALT
wrangler deploy                      # creates the D1 database and R2 bucket on first deploy
wrangler d1 migrations apply bourgogne-climat-feedback --remote
```

`dist/_headers` sets security headers and long-term caching for the versioned data folders; `dist/.assetsignore` keeps leftover `*.tmp` files out of uploads.


## Region atlases (Northern Rhône pilot)

Other wine regions are separate pages on the same site and engine: `dist/rhone/` is the Northern Rhône pilot
(46 communes, the eight crus from Côte Rôtie to Saint-Péray), served at `/rhone/`. A region is described by
`regions/<id>/region.json`: its communes, its appellation classes (key, label, tier, rank, colour; the map is
coloured by cru, with Côtes du Rhône as the regional layer), and its sidebar groups. The shared viewer reads the
page's `<meta name="atlas-region">` and `data/region.json` (`dist/region.js`); without them it is the Burgundy atlas.

Build a region, all from open data under Licence Ouverte 2.0:

```powershell
$env:PYTHONPATH = 'E:\Burgundy Map\work\pydeps'
python scripts/region_fetch.py rhone-nord        # INAO rows, cadastre, names, IGN terrain/photos/BD TOPO -> ../regions/rhone-nord/raw (resumable)
python scripts/region_build.py rhone-nord        # scenes, textures, lieux-dits, search index, communes, context terrain -> dist/rhone/data
python scripts/build_cadastre.py --site rhone --raw-root ../regions/rhone-nord/raw
python scripts/acquire_dgfip_ranges.py <DGFiP 01-56 zip URL> --departments 07,26,42 --extract-dir ../regions/rhone-nord/raw/ownership
python scripts/build_parcel_ownership.py --ownership-root ../regions/rhone-nord/raw/ownership --cadastre-root dist/rhone/data/cadastre --out dist/rhone/data/ownership --departments 07,26,42,69
python scripts/region_page.py rhone-nord         # dist/rhone/index.html from dist/index.html (rerun after page changes)
```

The header's site name opens the list of atlases. The list lives once, in `dist/index.html` (`<nav aria-label="Atlases">`); `region_page.py` relinks it for each region page. To add a region, add one link there and rerun the script.

Photos are fetched at 1 m and terrain at 5 m (the web textures are 1280 px and the terrain grid ~26 m, so finer
sources add nothing on screen). AOC display geometry is exclusive by rank, then by smaller appellation
(Château-Grillet shows inside Condrieu); legal areas keep the full INAO geometry. Lieux-dits are cadastral
lieux-dits with AOC land; the panel classifies them by that land with the same rule as Burgundy (tier "Cru").
INAO publishes no Champagne parcel delimitation, so Champagne would need a different, village-level model.

## Background beyond the detailed area

Around the detailed scenes the terrain is the coarse 200 m context grid. `scripts/build_context_textures.py [--site rhone]` gives each 50 km context tile a muted aerial photo of about 24 m per pixel (originals kept in `../regions/context-photos/`, adjustable with `--saturation` and `--haze`; run `stamp_asset_version.py` afterwards for Burgundy). The muting is baked into the images because iOS Safari has no canvas filters. `scene-mosaic.js` paints them beneath the scene photos as optional tiles, so a failed one never blocks the rest. `updateHaze()` in the renderer fades distant land into the sky colour just before the terrain mesh ends, keeps a clear zone around the view centre, and the screen-space lines fade with it.

## Data

This repository holds the code only. The data payloads under `dist/data/` and `dist/rhone/data/` are not included; [data-templates/](data-templates/README.md) shows the layout and keys of every data file, and the scripts in `scripts/` build them from public sources.
