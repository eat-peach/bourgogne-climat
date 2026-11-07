import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMosaicScene } from '../dist/scene-mosaic.js';

const scene = { id: 'v', bounds: [0, 0, 10, 10], gridSize: 2, heights: [1, 1, 1, 1] };
const entry = { id: 'v', texture: 'data/textures/v.jpg?v=1', textureAvif: 'data/textures/v.avif?v=1' };

test('mosaic tiles prefer AVIF and keep the JPEG as fallback', () => {
  const [tile] = buildMosaicScene({ bounds: [0, 0, 10, 10], sources: [{ id: 'v', entry, scene }], gridSize: 2, preferAvif: true }).textureTiles;
  assert.equal(tile.url, 'data/textures/v.avif?v=1');
  assert.equal(tile.fallbackUrl, 'data/textures/v.jpg?v=1');
});

test('without AVIF support mosaic tiles use the JPEG only', () => {
  const [tile] = buildMosaicScene({ bounds: [0, 0, 10, 10], sources: [{ id: 'v', entry, scene }], gridSize: 2 }).textureTiles;
  assert.equal(tile.url, 'data/textures/v.jpg?v=1');
  assert.equal(tile.fallbackUrl, null);
});
