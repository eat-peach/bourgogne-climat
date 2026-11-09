import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMosaicScene } from '../dist/scene-mosaic.js';

const detailTiles = { tileSize: 500, url: 'data/photo-tiles/{x}_{y}.jpg', tiles: ['2000_13000', '2001_13000', '2002_13000', '2010_13010'] };

test('a close view draws the sharp photo tiles under it, after the village photos', () => {
  const scene = buildMosaicScene({ bounds: [1000000, 6500000, 1001500, 6501500], sources: [], gridSize: 8, detailTiles, textureBase: 'http://x/' });
  const detail = scene.textureTiles.filter(t => t.detail);
  assert.equal(detail.length, 3);
  assert.deepEqual(detail.map(t => t.url).sort(), ['http://x/data/photo-tiles/2000_13000.jpg', 'http://x/data/photo-tiles/2001_13000.jpg', 'http://x/data/photo-tiles/2002_13000.jpg']);
  assert.ok(detail.every(t => t.optional && t.bounds[2] - t.bounds[0] === 500));
});

test('a wide view, or a region without tiles, uses the village photos only', () => {
  assert.equal(buildMosaicScene({ bounds: [995000, 6495000, 1005000, 6505000], sources: [], gridSize: 8, detailTiles }).textureTiles.filter(t => t.detail).length, 0);
  assert.equal(buildMosaicScene({ bounds: [1000000, 6500000, 1001500, 6501500], sources: [], gridSize: 8 }).textureTiles.length, 0);
});
