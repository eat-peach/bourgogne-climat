import test from 'node:test';
import assert from 'node:assert/strict';
import { entityDomaine, entityLabel, cruHoldings, cruOwnerSummary } from '../dist/holdings.js';

const data = {
  checked: '2026-11-21',
  entities: { A1: { domaine: 'Domaine A', basis: 'address' }, A2: { domaine: 'Domaine A', basis: 'name' } },
  holdings: { 7: { checked: '2026-11-21', rows: [{ domaine: 'Domaine R', ha: 0.5, basis: 'reported', by: 'importer', url: 'https://x' }, { domaine: 'Domaine A', ha: 9, basis: 'reported' }] } },
};

test('register entities show under their linked domaine', () => {
  assert.equal(entityDomaine(data, 'A1').domaine, 'Domaine A');
  assert.equal(entityDomaine(data, 'nope'), null);
  assert.equal(entityLabel(data, { name: 'SCI X', siren: 'zz' }, n => n.toLowerCase()), 'sci x');
  assert.equal(entityLabel(data, { name: 'SCI X', siren: 'A2' }), 'Domaine A');
  assert.equal(cruHoldings(data, 8).length, 0);
});

test('a cru summary merges a domaine\'s companies, counts co-owned parcels once and adds reported holdings', () => {
  const areas = new Map([['p1', 6000], ['p2', 2000], ['p3', 2000], ['p4', 10000]]);
  const owners = { total: 20000, areas, entities: [
    { o: { name: 'SCI A1', siren: 'A1' }, ids: ['p1', 'p2'] },
    { o: { name: 'SA A2', siren: 'A2' }, ids: ['p2'] },
    { o: { name: 'GFA B', siren: 'B' }, ids: ['p3'] },
  ] };
  const s = cruOwnerSummary(owners, data, 7);
  assert.equal(s.recordedM2, 10000);
  assert.equal(s.recordedShare, .5);
  const a = s.rows.find(r => r.name === 'Domaine A');
  assert.equal(a.areaM2, 8000);
  assert.deepEqual(a.registered, ['SCI A1', 'SA A2']);
  assert.equal(s.rows.filter(r => r.name === 'Domaine A').length, 1, 'a reported row for a domaine already on record is dropped');
  assert.equal(s.reportedM2, 5000);
  assert.equal(s.knownShare, .75);
  assert.deepEqual(s.rows.map(r => r.name), ['Domaine A', 'Domaine R', 'GFA B']);
  assert.equal(cruOwnerSummary({ total: 1000, areas: new Map(), entities: [] }, { holdings: { 7: { rows: [{ domaine: 'Big', ha: 1 }] } } }, 7).knownShare, 1, 'capped at 100%');
});
