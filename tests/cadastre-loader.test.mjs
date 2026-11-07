import test from 'node:test';
import assert from 'node:assert/strict';
import { CadastreLoader, cadastreTargets } from '../dist/cadastre-loader.js';

const manifest = { crs: 'EPSG:2154', release: '2026-09-01', communes: {
  a: { bounds: [0, 0, 100, 100], sourceDate: '2026-09-01', sourceUrl: 'https://example.test/a' },
  b: { bounds: [10000, 0, 10100, 100] },
} };
const near = { easting: 50, northing: 50, radiusMetres: 300 };
const far = { ...near, radiusMetres: 6000 };
const payload = { parcels: [{ id: 'p', cadastralAreaM2: null }], sourceDate: '2026-09-01' };
function setup(overrides = {}) {
  const published = [], statuses = [];
  const loader = new CadastreLoader({ fetchManifest: async () => manifest, fetchCommune: async () => payload,
    publish: (features, meta) => published.push({ features, meta }), status: (message, mode) => statuses.push({ message, mode }), ...overrides });
  return { loader, published, statuses };
}

test('nearby selection uses matching bounding boxes and prefers focus proximity', () => {
  assert.deepEqual(cadastreTargets(manifest, near).map(row => row.code), ['a']);
});
test('zoom out and back republishes cached parcels, without a second download', async () => {
  let downloads = 0;
  const { loader, published } = setup({ fetchCommune: async () => { downloads++; return payload; } });
  await loader.update(near); await loader.update(near);
  assert.equal(published.length, 1);
  await loader.update(far);
  assert.equal(published.at(-1).features.length, 0);
  await loader.update(near);
  assert.equal(published.at(-1).features[0].id, 'p');
  assert.equal(downloads, 1);
  assert.equal(published.at(-1).features[0].__cadastreMeta.sourceDate, '2026-09-01');
});
test('disabling while a request is pending prevents stale publication', async () => {
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  const { loader, published, statuses } = setup({ fetchCommune: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const pending = loader.update(near); await began;
  await loader.update(near, false); finish(payload); await pending;
  assert.equal(published.length, 0);
  assert.equal(statuses.at(-1).mode, 'hidden');
});
test('manifest fetch failures can be retried', async () => {
  let attempts = 0;
  const { loader, published } = setup({ fetchManifest: async () => { if (++attempts === 1) throw new Error('offline'); return manifest; } });
  await loader.update(near); await loader.update(near);
  assert.equal(attempts, 2); assert.equal(published.length, 1);
});
test('a failed neighbour does not discard valid parcels and is reported', async () => {
  const both = { ...manifest, communes: { a: manifest.communes.a, bad: { bounds: [100, 0, 200, 100], fail: true } } };
  const { loader, published, statuses } = setup({ fetchManifest: async () => both, fetchCommune: async meta => { if (meta.fail) throw new Error('missing'); return payload; } });
  await loader.update(near);
  assert.equal(published.at(-1).features.length, 1);
  assert.equal(statuses.at(-1).mode, 'partial');
  assert.match(statuses.at(-1).message, /1 unavailable/);
});
