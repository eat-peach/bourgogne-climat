import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { featureArea, placeHeading } from '../dist/feature-panel.js';
import { mergeFeatureFacts, featureIdentity } from '../dist/aoc-facts.js';

const scene = id => JSON.parse(gunzipSync(readFileSync(new URL(`../dist/data/scenes/${id}.json.gz`, import.meta.url))));

// Lieux-dits are cadastral (Etalab); ids are "<commune INSEE>:<name slug>".
test('a Meursault premier cru keeps its commune, independent of the appellation wording', () => {
  const p = scene('meursault-21412').climats.find(c => c.id === '21412:les-santenots-du-milieu');
  assert.deepEqual(p.featureCommunes, ['Meursault']);
  assert.equal(p.classification, 'premier-cru');
  assert.equal(featureIdentity(p).aocEligibility, 'Meursault premier cru Les Santenots du Milieu');
  assert.equal(featureIdentity(p).tier, 'Premier Cru');
});

test('Romanée-Saint-Vivant keeps Grand Cru, Vosne and full legal area in a neighbouring scene', () => {
  for (const id of ['vougeot-21716', 'vosne-roman-e-21714', 'flagey-ech-zeaux-21267', 'nuits-saint-georges-21464']) {
    const p = scene(id).climats.find(c => c.id === '21714:romanee-saint-vivant');
    assert.equal(p.aocVerification.officialTier, 'Grand Cru', id);
    assert.deepEqual(p.featureCommunes, ['Vosne-Romanée'], id);
    assert.equal(featureArea(p).value, 94426.61, id);
    assert.ok(p.mappedAreaM2 > 94000, id);
    assert.equal(placeHeading(p.displayName, p.featureCommunes.join(' / ')), 'Romanée-Saint-Vivant – Vosne-Romanée');
  }
});

test('Clos de Vougeot uses the complete legal denomination rather than a scene fragment', () => {
  const p = scene('vougeot-21716').climats.find(c => c.id === '21716:clos-de-vougeot');
  assert.equal(p.aocVerification.officialTier, 'Grand Cru');
  assert.ok(featureArea(p).value > 500000);
  assert.notEqual(p.aocVerification.displayAreaM2, featureArea(p).value);
});

test('Bonnes Mares, split by the cadastre at the commune line, reads as grand cru on both sides', () => {
  const chambolle = scene('chambolle-musigny-21133');
  const west = chambolle.climats.find(c => c.id === '21133:les-bonnes-mares');
  assert.equal(west.aocVerification.officialTier, 'Grand Cru');
  assert.deepEqual(new Set(west.featureCommunes), new Set(['Chambolle-Musigny', 'Morey-Saint-Denis']));
  assert.deepEqual(featureIdentity(west, 'climats'), { placeType: 'Lieu-dit', tier: 'Grand Cru', aocEligibility: 'Bonnes-Mares' });
  // The Morey lieu-dit also takes in a strip of Clos de Tart: both grand crus are named, with their shares.
  const east = chambolle.climats.find(c => c.id === '21442:les-bonnes-mares');
  assert.equal(featureIdentity(east, 'climats').tier, 'Grand Cru');
  assert.match(featureIdentity(east, 'climats').aocEligibility, /^Bonnes-Mares on \d+% of the vineyard land; Clos de Tart on the rest$/);
  assert.equal(east.displayName, 'Bonnes Mares');
});

test('audited source area and commune cannot be replaced by stale fragment facts', () => {
  const current = { mappedAreaM2: 94400, mappedAreaStatus: 'available', featureCommunes: ['Vosne-Romanée'] };
  const merged = mergeFeatureFacts(current, { mappedAreaM2: 25000, featureCommunes: ['Vougeot'] });
  assert.equal(featureArea(merged).value, 94400);
  assert.deepEqual(merged.featureCommunes, ['Vosne-Romanée']);
});

test('Blagny shared Premier Cru eligibility retains both appellations and counts overlap once', () => {
  const p = scene('meursault-21412').climats.find(c => c.id === '21412:la-jeunellotte');
  assert.equal(p.aocVerification.officialTier, 'Premier Cru');
  assert.equal(p.classification, 'premier-cru');
  assert.ok(p.aocVerification.eligibleAppellations.includes('Blagny'));
  assert.ok(p.aocVerification.eligibleAppellations.includes('Meursault'));
  assert.match(featureArea(p).label, /shared eligibility/);
});
