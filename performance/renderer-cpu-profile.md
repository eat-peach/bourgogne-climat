# Renderer CPU performance assessment

Profiled `dist/atlas-renderer.js` with the existing `tests/renderer-runtime.test.mjs` import pattern and real gzip-compressed scene/cadastre payloads. This is a Node CPU profile without WebGL, browser layout, GPU upload, or actual frame timing.

Command:

```text
C:\Users\Eat_Peach\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe website/performance/renderer-cpu-profile.mjs
```

The runtime harness passes all 22 tests. Representative medians varied with normal Node GC and machine load:

| Operation | Real input | Median CPU time | Work observed |
| --- | --- | ---: | --- |
| `addFeatures()` | Priss: 354 climats, 2,419 roads, 1,500 buildings | 303 ms | 10,592 indexed features |
| `addFeatures()` | Beaune: 340 climats, 6,474 roads, 1,500 buildings | 260 ms | 5,639 indexed features |
| `addFeatures()` | Meursault: 315 climats, 1,624 roads, 1,500 buildings | 244 ms | 5,288 indexed features |
| `setCadastralParcels()` | Beaune: 14,936 source/deduped parcels | 95 ms | Reindexes the current cadastre layer |
| forced close-range `updateCadastreLOD()` | Beaune, 14,936 indexed, 5,000 allowed | 71 ms (run-to-run range was 71–92 ms) | Sorts candidates and rebuilds a 251,004-vertex line mesh |
| same-bucket `updateCadastreLOD()` | Same camera bucket | 0.0008 ms | Early return |
| `setVillage()` | Beaune, preserve view | 511 ms | `build()` 511 ms; `addFeatures()` 498 ms; `clear()` 0.18 ms; AOC overlay ~6 ms |

The runtime code confirms the likely interaction bottlenecks. `setVillage()` calls `clear()` and then `build()` synchronously (`atlas-renderer.js:85`); `build()` calls `addFeatures()` (`:197`). `addDraped()` samples and interpolates every ring edge through `drapedPoints()` and appends ordinary JS arrays (`:201`, `:207`). `updateCadastreLOD()` scans all indexed cadastre items, deduplicates, computes bounds distance, sorts, selects up to 5,000, and calls `buildCadastreBatch()` (`:206`); the batch then resamples all candidate rings and recreates the line geometry (`:205`).

Prioritized sequence:

1. Keep the current cadastre mesh while a new LOD mesh is prepared. Move candidate selection and geometry preparation off the control-change call stack, ideally to a worker, or at minimum chunk it across animation frames. Apply the completed mesh at a frame boundary. Keep the existing 150 m center / 250 m radius bucket policy and 5,000 cap.
2. Add a spatial lookup for cadastre bounds (grid or R-tree) and precompute each feature's identity, bounds, and projected ring data once during ingestion. This removes the full 14,936-item scan and repeated `distanceToBounds` calculations on each bucket transition while preserving source ring geometry.
3. Cache draped/projected vertices for static scene features and cadastral rings. `elevationAt()` and the 30 m edge resampling currently run again for every rebuild. A cache keyed by feature identity plus terrain/exaggeration version can reduce both `addFeatures()` and LOD rebuild work without simplifying legal geometry.
4. Prepare a new village scene incrementally or in a worker, then swap scene groups once complete. The measured `setVillage()` pause is almost entirely `addFeatures()`; disposal is negligible. Reusing the old scene until the replacement is ready would avoid a half-second main-thread stall.
5. Reduce allocation pressure in `screenLineGeometry()` (`:208`): `segments.slice()` plus spread pushes four vertices per segment into multiple growing JS arrays. Typed-array sizing or a two-pass builder would reduce garbage collection during large cadastre rebuilds.

For interaction smoothness, the same-bucket early return is already effective. The remaining browser-side risks are outside this CPU harness: synchronous geometry work when a bucket changes, WebGL buffer upload for the 251k-vertex batch, and per-frame label placement in `renderScene()` (`:237`), which interleaves `offsetWidth` reads with style writes. Confirm those with browser frame instrumentation before changing label behavior or GPU limits.
