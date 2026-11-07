import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildMosaicScene } from '../dist/scene-mosaic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = ['beaune-21054', 'pommard-21492', 'savigny-l-s-beaune-21590', 'chorey-les-beaune-21173', 'volnay-21712'];
const sources = await Promise.all(ids.map(async (id) => ({ id, scene: JSON.parse(gunzipSync(await fs.readFile(path.join(root, `dist/data/scenes/${id}.json.gz`)), 'utf8')) })));
const bounds = [837260.925, 6658560.04, 840860.925, 6662160.04];
const layers = ['parcels', 'climats', 'buildings', 'roads', 'forests', 'waterSurfaces', 'waterLines'];
const noFeatures = sources.map(({ id, scene }) => ({ id, scene: Object.fromEntries(Object.entries(scene).map(([key, value]) => layers.includes(key) ? [key, []] : [key, value])) }));
const tinyTerrain = sources.map(({ id, scene }) => ({ id, scene: { ...scene, gridSize: 2, heights: [scene.heights[0], scene.heights[128], scene.heights[scene.heights.length - 129], scene.heights.at(-1)] } }));

function run(label, input, gridSize = 193, iterations = 8) {
  const times = [];
  let output;
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    output = buildMosaicScene({ bounds, sources: input, gridSize, maxFeaturesPerLayer: 4000 });
    times.push(performance.now() - start);
  }
  const sorted = times.slice(1).sort((a, b) => a - b);
  return { label, gridSize, times, p50Ms: sorted[Math.floor(sorted.length / 2)], maxMs: Math.max(...times), featureCount: layers.reduce((n, layer) => n + (output[layer]?.length || 0), 0), validSamples: output.validMask.filter(Boolean).length };
}

const perLayer = layers.map((wanted) => run(`only-${wanted}`, sources.map(({ id, scene }) => ({ id, scene: Object.fromEntries(Object.entries(scene).map(([key, value]) => layers.includes(key) && key !== wanted ? [key, []] : [key, value])) }))));

console.log(JSON.stringify([
  run('full', sources),
  run('terrain-only', noFeatures),
  run('features-with-2x2-source-grids', tinyTerrain),
  run('full-grid-97', sources, 97),
  run('full-grid-257', sources, 257),
  ...perLayer,
], null, 2));
