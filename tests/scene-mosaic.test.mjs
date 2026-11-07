import assert from 'node:assert/strict';
import {
  SceneMosaic,
  boundsIntersects,
  buildMosaicScene,
  featureBounds,
  featureIntersects,
  featureKey,
  nearestVillage,
  sampleScene,
} from '../dist/scene-mosaic.js';

const scene = (bounds, heights, extra = {}) => ({ bounds, gridSize: 3, heights, minElevation: 10, maxElevation: 18, ...extra });

// North-to-south rows: the north-west corner is 10 and south-east is 18.
assert.equal(sampleScene(scene([0, 0, 2, 2], [10, 11, 12, 13, 14, 15, 16, 17, 18]), 0, 2), 10);
assert.equal(sampleScene(scene([0, 0, 2, 2], [10, 11, 12, 13, 14, 15, 16, 17, 18]), 2, 0), 18);
assert.equal(sampleScene(scene([0, 0, 1, 1], [null, 1, 1, 1], { gridSize: 2 }), 0, 1), null, 'unmasked null source samples remain no-data');
assert.equal(sampleScene(scene([0, 0, 2, 2], [10, 11, 12, 13, 14, 15, 16, 17, 18], { validMask: [1, 1, 1, 1, 0, 1, 1, 1, 1] }), 1, 1), null);
assert.equal(boundsIntersects([0, 0, 1, 1], [1, 1, 2, 2]), true);
assert.equal(boundsIntersects([0, 0, 1, 1], [1.01, 1, 2, 2]), false);

const left = scene([0, 0, 2, 2], [10, 11, 12, 13, 14, 15, 16, 17, 18], { id: 'left', texture: 'left.jpg', climats: [{ id: 'same', rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }] });
const right = scene([2, 0, 4, 2], [20, 21, 22, 23, 24, 25, 26, 27, 28], { id: 'right', texture: 'right.jpg', climats: [{ id: 'same', rings: [[[2, 0], [3, 0], [3, 1], [2, 0]]] }] });
const merged = buildMosaicScene({ bounds: [0, 0, 4, 2], gridSize: 5, sources: [{ id: 'left', scene: left }, { id: 'left-copy', scene: left }, { id: 'right', scene: right }] });
assert.equal(merged.gridSize, 5);
assert.equal(merged.rowOrder, 'north-to-south');
assert.equal(merged.validMask.every(Boolean), true);
assert.equal(merged.textureTiles.length, 2);
assert.equal(merged.climats.length, 2, 'same source id with different clipped geometry must retain both pieces');
assert.ok(merged.heights.some(value => value === 24));
assert.match(featureKey({ id: 'same', geometry: { type: 'Point', coordinates: [1, 2] } }, 'climats'), /^climats:same:/);

const multipart = {
  type: 'Feature',
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [[[10, 10], [12, 10], [12, 12], [10, 10]]],
      [[[20, 20], [22, 20], [22, 22], [20, 20]], [[20.5, 20.5], [21, 20.5], [21, 21], [20.5, 20.5]]],
    ],
  },
};
assert.deepEqual(featureBounds(multipart), [10, 10, 22, 22], 'multipart bounds must include every polygon');
assert.equal(featureIntersects(multipart, [21, 21, 23, 23]), true, 'multipart geometry remains selectable by its outer bounds');
assert.equal(featureIntersects({ geometry: { type: 'Polygon', coordinates: [[[100, 100], [102, 100], [102, 102], [100, 100]], [[100.25, 100.25], [101, 100.25], [101, 101], [100.25, 100.25]]] } }, [0, 0, 1, 1]), false, 'polygon holes do not expand feature bounds');
// The cached result is tied to feature identity, so repeated filtering does not walk coordinates again.
assert.strictEqual(featureBounds(multipart), featureBounds(multipart), 'feature bounds should be cached per feature object');

const fineGap = scene([1, 1, 3, 3], [10, 10, 10, 10, 10, 10, 10, 10, 10], { validMask: [1, 1, 1, 1, 0, 1, 1, 1, 1] });
const coarse = scene([0, 0, 4, 4], [100, 100, 100, 100, 100, 100, 100, 100, 100]);
const fallback = buildMosaicScene({ bounds: [0, 0, 4, 4], gridSize: 5, sources: [{ id: 'fine-gap', scene: fineGap }], backgroundSources: [{ id: 'coarse-context', scene: coarse }] });
assert.equal(fallback.heights[12], 100, 'coarse context should fill a fine-source no-data hole');
assert.equal(fallback.heights[8], 10, 'fine source should win wherever it has coverage');
assert.equal(fallback.coverage.contextTerrainUsed, true);
const noData = buildMosaicScene({ bounds: [0, 0, 2, 2], gridSize: 3, sources: [{ id: 'fine-empty', scene: scene([0, 0, 2, 2], [10, 10, 10, 10, 10, 10, 10, 10, 10], { validMask: [0, 0, 0, 0, 0, 0, 0, 0, 0] }) }], backgroundSources: [{ id: 'coarse-empty', scene: scene([0, 0, 2, 2], [100, 100, 100, 100, 100, 100, 100, 100, 100], { validMask: [0, 0, 0, 0, 0, 0, 0, 0, 0] }) }] });
assert.equal(noData.validMask.some(Boolean), false, 'no-data in both source tiers must remain blank');

const entries = [
  { id: 'left', bounds2154: [0, 0, 2, 2] },
  { id: 'right', bounds2154: [2, 0, 4, 2] },
];
const loaderCalls = [];
const mosaic = new SceneMosaic({ index: { villages: entries }, loadScene: async entry => { loaderCalls.push(entry.id); return entry.id === 'left' ? left : right; }, maxLoadedScenes: 2, cacheLimit: 2 });
const result = await mosaic.compose({ easting: 3, northing: 1, radiusMetres: 1 }, { focusId: 'right' });
assert.equal(result.sources.length, 2);
assert.deepEqual(new Set(loaderCalls), new Set(['left', 'right']));
assert.equal((await mosaic.compose({ easting: 3, northing: 1, radiusMetres: 1 }, { focusId: 'right' })).sources.length, 2);
assert.equal(loaderCalls.length, 2, 'source scenes should be served from the bounded cache');

const boundaryVillages = [{ id: 'barizey-21048', name: 'Barizey', bounds2154: [0, 0, 10, 10] }];
const boundary = [{ code: '21048', name: 'Barizey', bounds: [0, 0, 10, 10], rings: [[[1, 1], [4, 1], [4, 4], [1, 1]]] }, { code: 'wrong', name: 'Wrong', bounds: [0, 0, 10, 10], rings: [[[6, 6], [9, 6], [9, 9], [6, 6]]] }];
assert.equal(nearestVillage(boundaryVillages, 2, 2, { boundaries: boundary })?.id, 'barizey-21048');
assert.equal(nearestVillage(boundaryVillages, 8, 8, { boundaries: boundary })?.id, 'barizey-21048', 'an overlapping boundary bbox must not select the wrong commune');

const raceMosaic = new SceneMosaic({ index: { villages: entries }, loadScene: async entry => { await new Promise(resolve => setTimeout(resolve, entry.id === 'left' ? 25 : 0)); return entry.id === 'left' ? left : right; }, maxLoadedScenes: 2 });
const stale = raceMosaic.compose({ easting: 1, northing: 1, radiusMetres: 1 }, { focusId: 'left' });
const fresh = raceMosaic.compose({ easting: 3, northing: 1, radiusMetres: 1 }, { focusId: 'right' });
assert.ok((await fresh)?.scene, 'the latest view should win the compose race');
assert.equal(await stale, null, 'a stale compose must not publish after a newer view');

const aocFeature = { id: 'aoc-outside-fine', properties: { name: 'AOC parcel' }, geometry: { type: 'Polygon', coordinates: [[[400, 400], [600, 400], [600, 600], [400, 400]]] } };
const fineOnly = scene([0, 0, 2, 2], [10, 10, 10, 10, 10, 10, 10, 10, 10], { parcels: [aocFeature] });
const aocEntry = { id: 'fine-village', bounds2154: [0, 0, 2, 2], aocBounds2154: [0, 0, 1000, 1000] };
const aocContext = scene([0, 0, 1000, 1000], new Array(9).fill(100));
const aocMosaic = new SceneMosaic({ index: { villages: [aocEntry] }, loadScene: async () => fineOnly, backgroundSources: [{ ...aocContext, id: 'context' }], maxLoadedScenes: 1 });
const aocResult = await aocMosaic.compose({ easting: 500, northing: 500, radiusMetres: 100 }, { focusId: aocEntry.id });
assert.equal(aocResult.sources.length, 1, 'AOC coverage should load a source outside its fine terrain bounds');
assert.equal(aocResult.scene.parcels.length, 1, 'parcel features should remain selectable within AOC coverage');
assert.equal(aocResult.scene.textureTiles.length, 0, 'fine textures must not stretch across AOC-only coverage');
assert.equal(aocResult.scene.coverage.contextTerrainUsed, true, 'terrain outside the fine grid should come from context terrain');
const aocHeights = aocResult.scene.heights.filter(value => value != null);
assert.ok(aocHeights.length > 0 && aocHeights.every(value => value === 100), 'outside-fine terrain should use context elevations where sampled');

console.log('scene-mosaic tests passed');
