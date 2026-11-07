# Rendering and interaction performance assessment

This assessment measures the current served payloads in `website/dist`: the gzip-compressed scene files under `dist/data/scenes/` and `dist/data/context-terrain.json.gz`. The compose harness uses Node v24.19, a 193×193 mosaic grid, four representative views, and 12 warm iterations after one cold compose. Results are CPU timings only; they do not measure browser layout, WebGL buffer upload, GPU rendering, frame rate, or input latency.

## Measured compose cost

| View | Cold compose | Warm p50 | Warm max |
| --- | ---: | ---: | ---: |
| Beaune | 494 ms | 92.9 ms | 122.6 ms |
| Meursault | 435 ms | 81.6 ms | 113.2 ms |
| Chassagne-Montrachet | 514 ms | 123.5 ms | 204.5 ms |
| Auxerre | 160 ms | 28.4 ms | 44.4 ms |

The profile isolates terrain from feature work. A 193×193 terrain-only build is about 10 ms p50, while the same five-source Beaune feature set is about 81 ms p50. Changing the grid from 97×97 to 257×257 changes the same build from roughly 73 ms to 91 ms p50, so terrain resolution is not the first optimization target.

The main compose cost is feature filtering in `dist/scene-mosaic.js:339-353`. Every source/layer feature is tested with `featureIntersects()` (`:170-173`), which recomputes recursive coordinate bounds through `featureBounds()` (`:163-167`). Matching features may then be recursively serialized by `featureKey()` (`:214-234`). In the Beaune profile, the largest isolated layer costs were buildings ~25.7 ms p50, roads ~22.8 ms, parcels ~22.8 ms despite only 79 output parcels, and forests ~16.8 ms. This points to geometry traversal and allocation, rather than terrain sampling, as the first compose hotspot.

## Renderer-side findings

The renderer profile in `renderer-cpu-profile.md` measures current gzip scene and cadastre inputs without WebGL. `setVillage()` takes about 511 ms median for Beaune; `build()` accounts for essentially all of that and `addFeatures()` about 498 ms. The full rebuild is synchronous at `dist/atlas-renderer.js:85`, with `build()` calling `addFeatures()` around `:197`.

Cadastre bucket changes are also synchronous: the control path is at `atlas-renderer.js:82`, and `updateCadastreLOD()` at `:206` scans, sorts, selects up to 5,000 records, and rebuilds the line mesh. The measured forced close-range update is about 71 ms for a 251,004-vertex mesh; repeated calls in the same bucket return in about 0.0008 ms.

The browser interaction path has additional work outside this Node profile. `app.js:75` recreates the navigator commune paths and all 376 village markers/title/listener bindings on its callback. `atlas-renderer.js:237` performs label `offsetWidth` reads interleaved with style writes, which can force layout during rendering. These observations require browser frame instrumentation before assigning FPS impact.

## Recommended order

1. Cache feature bounds during scene ingestion, or consume precomputed bounds from the payload. Cache feature identity keys as well. This removes repeated coordinate walks during `buildMosaicScene()` while preserving the exact legal geometry.
2. Reuse unchanged candidate/source selections and defer or coalesce compose and renderer rebuilds until an input-idle/frame boundary. Keep the prior scene visible until the replacement is ready.
3. For cadastre, retain the existing mesh while preparing a new LOD mesh. Add a spatial lookup over feature bounds to avoid scanning all 14,936 records on each bucket transition. Preserve the current 150 m center bucket, 250 m radius, and 5,000-feature cap.
4. Cache draped/projected vertices by feature identity plus terrain/exaggeration version. This targets repeated `drapedPoints()` work without simplifying source geometry.
5. Move large scene/cadastre preparation to a worker where practical, then swap groups/buffers at a frame boundary. Preserve existing tile and geometry buffers when inputs have not changed.
6. Cache navigator DOM nodes and update only changed state. Batch label reads before writes to reduce forced layout.

The benchmark scripts are `compose-benchmark.mjs` and `compose-profile.mjs`; the latest detailed profile is `compose-profile-output.json`. No runtime or source data was changed for this assessment.
