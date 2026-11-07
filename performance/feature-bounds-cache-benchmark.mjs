import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const nodePath = process.execPath;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const modulePath = path.join(root, 'dist', 'scene-mosaic.js');
const index = JSON.parse(await fs.readFile(path.join(root, 'dist/data/index.json'), 'utf8'));
const scenarios = ['beaune-21054', 'meursault-21412', 'chassagne-montrachet-21150', 'auxerre-89024'];
const entries = index.villages.filter(entry => scenarios.includes(entry.id));
const views = Object.fromEntries(entries.map(entry => [entry.id, {
  easting: (entry.bounds2154[0] + entry.bounds2154[2]) / 2,
  northing: (entry.bounds2154[1] + entry.bounds2154[3]) / 2,
  radiusMetres: 1800,
}]));

const loadScene = async entry => JSON.parse(gunzipSync(await fs.readFile(path.join(root, `dist/data/scenes/${entry.id}.json.gz`)), 'utf8'));
const contextPayload = JSON.parse(gunzipSync(await fs.readFile(path.join(root, 'dist/data/context-terrain.json.gz')), 'utf8'));
const contextSources = contextPayload.tiles || [];

const source = await fs.readFile(modulePath, 'utf8');
const noCacheSource = source
  .replace("const featureBoundsCache = new WeakMap();\n\n", '')
  .replace("  if (feature && typeof feature === 'object' && featureBoundsCache.has(feature)) return featureBoundsCache.get(feature);\n", '')
  .replace("  if (feature && typeof feature === 'object') featureBoundsCache.set(feature, result);\n", '');
if (noCacheSource === source || noCacheSource.includes('featureBoundsCache')) throw new Error('failed to construct cache-disabled module variant');

const cachedModule = await import(`${pathToFileURL(modulePath).href}?cache-benchmark=cached`);
const uncachedModule = await import(`data:text/javascript;base64,${Buffer.from(noCacheSource).toString('base64')}`);

const outputHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function runVariant(label, module) {
  const results = {};
  const sceneCache = new Map();
  const cachedLoadScene = async entry => {
    if (!sceneCache.has(entry.id)) sceneCache.set(entry.id, await loadScene(entry));
    return sceneCache.get(entry.id);
  };
  const mosaic = new module.SceneMosaic({ index, loadScene: cachedLoadScene, backgroundSources: contextSources, maxLoadedScenes: 8, cacheLimit: 12, gridSize: 193 });
  for (const id of scenarios) {
    const view = views[id];
    const coldStart = performance.now();
    const cold = await mosaic.compose(view, { focusId: id });
    const coldMs = performance.now() - coldStart;
    const warmMs = [];
    let last = cold;
    for (let i = 0; i < 12; i += 1) {
      const start = performance.now();
      last = await mosaic.compose(view, { focusId: id });
      warmMs.push(performance.now() - start);
    }
    results[id] = { label, coldMs, warmMs, warmP50Ms: median(warmMs), outputHash: outputHash(last.scene), loadedSources: last.sources.map(source => source.id) };
  }
  return results;
}

// Run the uncached implementation first, then the cached implementation. Each
// variant gets the same scene objects and exact view bounds; only the WeakMap
// lookup/store lines differ.
const before = await runVariant('without-feature-bounds-cache', uncachedModule);
const after = await runVariant('with-feature-bounds-cache', cachedModule);
const scenariosReport = Object.fromEntries(scenarios.map(id => {
  const b = before[id], a = after[id];
  return [id, {
    before: b,
    after: a,
    warmP50DeltaMs: a.warmP50Ms - b.warmP50Ms,
    warmP50ReductionPercent: ((b.warmP50Ms - a.warmP50Ms) / b.warmP50Ms) * 100,
    outputEqual: a.outputHash === b.outputHash,
  }];
}));
const report = {
  node: process.version,
  executable: nodePath,
  gridSize: 193,
  warmIterations: 12,
  contextSourceCount: contextSources.length,
  module: path.relative(root, modulePath),
  variant: 'cache-disabled source transform removes only featureBounds WeakMap lookup/store',
  outputEqual: Object.values(scenariosReport).every(item => item.outputEqual),
  scenarios: scenariosReport,
};
const outputPath = path.join(here, 'feature-bounds-cache-benchmark.json');
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, outputEqual: report.outputEqual, scenarios: scenariosReport }, null, 2));
