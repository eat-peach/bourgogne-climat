import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnershipLoader, formatOwnershipFacts, ownershipRows, ownershipTargets } from '../dist/ownership-loader.js';

const parcel = { id: 'p-1', communeCode: '21054' };

test('ownership join preserves all legal-entity rights and excludes addresses', () => {
  const manifest = { communes: { '21054': { url: './21054.json.gz' } } };
  assert.equal(ownershipTargets(manifest, parcel).length, 1);
  const rows = ownershipRows({ sourceAsOf: '2025-01-01', parcels: { 'p-1': [
    { entityName: 'Domaine A', siren: '123', rightsCode: 'P', rightsLabel: 'Owner', address: 'redacted' },
    { entityName: 'Domaine B', siren: '456', rightsCode: 'L', rightsLabel: 'Leaseholder' },
  ] } }, parcel);
  assert.equal(rows.length, 2);
  assert.equal(Object.hasOwn(rows[0], 'address'), false);
  assert.deepEqual(formatOwnershipFacts(rows)[1].details, ['DGFiP entity identifier 456', 'Rights code L', 'Leaseholder', 'As of 2025-01-01']);
});

test('DGFiP substitute identifiers are not presented as registered SIRENs', () => {
  const facts = formatOwnershipFacts([{ siren: 'U21396650' }, { siren: '216900019' }]);
  assert.equal(facts[0].details[0], 'DGFiP entity identifier U21396650');
  assert.equal(facts[1].details[0], 'SIREN 216900019');
});

test('ownership loader caches successes, retries failures, and guards concurrent loads', async () => {
  let payloadCalls = 0, fail = true;
  const loader = new OwnershipLoader({ fetchManifest: async () => ({ communes: { '21054': { url: './x' } } }), fetchPayload: async () => { payloadCalls++; if (fail) { fail = false; throw new Error('temporary'); } return { sourceAsOf: '2025-01-01', parcels: { 'p-1': [{ entityName: 'Domaine A' }] } }; } });
  const failed = await loader.loadForParcel(parcel);
  assert.equal(failed.status, 'unavailable');
  const [a, b] = await Promise.all([loader.loadForParcel(parcel), loader.loadForParcel(parcel)]);
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.equal(payloadCalls, 2);
  assert.equal((await loader.loadForParcel(parcel)).status, 'ok');
  assert.equal(payloadCalls, 2);
});

test('concurrent parcels in one commune each receive their own rows', async () => {
  const loader = new OwnershipLoader({ fetchManifest: async () => ({ communes: { '21054': { path: './x', sourceUrl: 'https://example.test/release' } } }), fetchPayload: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { sourceAsOf: '2025-01-01', parcels: { 'p-1': [{ entityName: 'Domaine A' }], 'p-2': [{ entityName: 'Domaine B' }] } }; } });
  const [first, second] = await Promise.all([loader.loadForParcel({ id: 'p-1', communeCode: '21054' }), loader.loadForParcel({ id: 'p-2', communeCode: '21054' })]);
  assert.equal(first.rows[0].entityName, 'Domaine A');
  assert.equal(second.rows[0].entityName, 'Domaine B');
  assert.equal(first.meta.sourceUrl, 'https://example.test/release');
});

test('an unavailable payload cannot be reported as a successful search without a match', async () => {
  const loader = new OwnershipLoader({ fetchManifest: async () => ({ communes: { '21054': { path: './x' } } }), fetchPayload: async () => null });
  assert.equal((await loader.loadForParcel(parcel)).status, 'unavailable');
});
