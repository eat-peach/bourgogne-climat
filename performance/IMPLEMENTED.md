# Implemented performance work

This report records the scoped performance changes currently implemented in the website.

## Renderer

- `dist/atlas-renderer.js` caches `featureIdentity()` results for immutable feature objects.
- Cadastre LOD candidate membership is reused when the same identities remain visible, even if camera distance changes their draw order.
- Heavy non-forced cadastre LOD work is coalesced behind a short 70 ms idle timer during controls changes.
- Existing cadastre mesh and pick visibility remain active until the deferred replacement is applied.
- OrbitControls gesture start/end state delays LOD application while a pointer gesture or damping sequence is active.
- `clear()`, `dispose()`, cadastre ingestion, and forced LOD updates cancel pending timers and invalidate stale callbacks.
- Selection restoration runs after the applied LOD state so stale cadastre selections are not retained.
- No terrain resolution, legal geometry, or layer detail was reduced. The existing 193-grid terrain, exact boundary geometry, roads, buildings, 3x exaggeration, and 25% AOC fill remain unchanged.

## Mosaic and application coordination

The scene-mosaic feature-bounds cache is isolated to its own implementation. The before/after CPU benchmark in [`feature-bounds-cache-benchmark.json`](feature-bounds-cache-benchmark.json) reports equal output hashes and warm P50 reductions of 68.6% for Beaune and 77.1% for Meursault. The benchmark uses Node CPU timings with 193-grid source data; it does not establish browser frame-rate or GPU-upload improvements.

Application coordination now includes static navigator reuse, held-gesture and wheel/damping coalescing, in-flight stream aborts, and queued cadastre publish replay. The initial full scene rebuild remains synchronous, so this work does not eliminate every interaction stall.

## Validation

The renderer runtime and contract suite covers identity reuse, order-only candidate changes, deferred gesture behavior, lifecycle cancellation, forced-update cancellation, pick precedence, terrain preservation, and pan settling. Run it with:

```text
C:\Users\Eat_Peach\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe --test tests\renderer-runtime.test.mjs tests\renderer-contract.test.mjs
```

The supporting profile is [`renderer-cpu-profile.md`](renderer-cpu-profile.md), and the benchmark driver is [`feature-bounds-cache-benchmark.mjs`](feature-bounds-cache-benchmark.mjs).
