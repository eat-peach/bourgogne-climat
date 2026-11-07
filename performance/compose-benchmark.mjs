import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { SceneMosaic } from '../dist/scene-mosaic.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const index = JSON.parse(await fs.readFile(path.join(root, 'dist/data/index.json'), 'utf8'));
const sourceDir = path.join(root, 'source-scenes');

const scenarios = ['beaune-21054', 'meursault-21412', 'chassagne-montrachet-21150', 'auxerre-89024'];
const entries = index.villages.filter((entry) => scenarios.includes(entry.id));
const centers = Object.fromEntries(entries.map((entry) => [entry.id, {
  easting: (entry.bounds2154[0] + entry.bounds2154[2]) / 2,
  northing: (entry.bounds2154[1] + entry.bounds2154[3]) / 2,
  radiusMetres: 1800,
}]));

const loadScene = async (entry) => JSON.parse(gunzipSync(await fs.readFile(path.join(root, `dist/data/scenes/${entry.id}.json.gz`)), 'utf8'));
const stats = (scene) => Object.fromEntries(['parcels', 'climats', 'buildings', 'roads', 'forests', 'waterSurfaces', 'waterLines', 'labels', 'appellations']
  .map((layer) => [layer, Array.isArray(scene[layer]) ? scene[layer].length : 0]));

const contextPayload = JSON.parse(gunzipSync(await fs.readFile(path.join(root, 'dist/data/context-terrain.json.gz')), 'utf8'));
const contextSources = contextPayload.tiles || [];
const mosaic = new SceneMosaic({ index, loadScene, backgroundSources: contextSources, maxLoadedScenes: 8, cacheLimit: 12, gridSize: 193 });
const report = { node: process.version, gridSize: 193, iterations: 12, contextSources: contextSources.length, scenarios: [] };

for (const id of scenarios) {
  const view = centers[id];
  const coldStart = performance.now();
  const cold = await mosaic.compose(view, { focusId: id });
  const coldMs = performance.now() - coldStart;
  const warmMs = [];
  let last = cold;
  for (let i = 0; i < report.iterations; i += 1) {
    const start = performance.now();
    last = await mosaic.compose(view, { focusId: id });
    warmMs.push(performance.now() - start);
  }
  const sorted = [...warmMs].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const output = last.scene;
  report.scenarios.push({
    id,
    view,
    coldMs,
    warmMs,
    warmP50Ms: p50,
    warmMaxMs: Math.max(...warmMs),
    loadedSources: last.sources.map((source) => source.id),
    sourceBytes: await Promise.all(last.sources.map(async (source) => (await fs.stat(path.join(root, `dist/data/scenes/${source.id}.json.gz`))).size)),
    outputFeatures: stats(output),
    outputTerrainSamples: output.validMask.filter(Boolean).length,
    outputTextureTiles: output.textureTiles.length,
  });
}

console.log(JSON.stringify(report, null, 2));
