import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aocFactLines, factScopeWarning, featureIdentity, mergeFeatureFacts, spatialAocIdentity, spatialAocMatches } from '../dist/aoc-facts.js';

test('regional official names retain the full Bourgogne Aligoté name', () => {
  const identity = featureIdentity({ aocVerification: {
    officialAppellation: 'Bourgogne Aligoté',
    officialDenomination: 'Bourgogne Aligoté',
    officialTier: 'Regional',
    verificationStatus: 'official-source-matched',
  }}, 'parcels');
  assert.equal(identity.aocEligibility, 'Bourgogne Aligoté');
  assert.equal(identity.tier, 'Regional appellation');
  assert.equal(featureIdentity({ aocVerification: { officialTier: 'Village', verificationStatus: 'official-source-matched', officialDenomination: 'Bourgogne' } }, 'parcels').tier, 'Village appellation');
});

test('unmatched named places remain Lieu-dits with unverified AOC status', () => {
  const identity = featureIdentity({ classification: 'grand-cru', classificationStatus: 'unmatched', aocVerification: { officialTier: 'Grand Cru', officialDenomination: 'Not verified', verificationStatus: 'unverified' } }, 'climats');
  assert.deepEqual(identity, { placeType: 'Lieu-dit', tier: null, aocEligibility: 'AOC identification under review' });
});

test('matched Grand Cru keeps place type separate from verified tier', () => {
  const identity = featureIdentity({ aocVerification: {
    officialDenomination: 'Romanée-Saint-Vivant', officialTier: 'Grand Cru', verificationStatus: 'official-name-and-location-matched',
  }}, 'climats');
  assert.equal(identity.placeType, 'Lieu-dit');
  assert.equal(identity.tier, 'Grand Cru');
  assert.equal(identity.aocEligibility, 'Romanée-Saint-Vivant');
});

test('AOC facts preserve physical, legal, exclusive, and production scopes', () => {
  const lines = aocFactLines({ productionAreaHa: 14.888, productionYear: 2024, aocVerification: {
    snapshot: '2026-10-19', officialAppellation: 'Chambertin', officialTier: 'Grand Cru',
    geometryScope: 'physical-climat', physicalStatus: 'derived-supported', physicalAreaM2: 128850,
    legalAreaM2: 282340, displayAreaM2: 128850, eligibleAppellations: ['Chambertin', 'Chambertin-Clos de Bèze'],
  }});
  assert.deepEqual(lines.map(line => line.label), [
    'Official appellation', 'Official tier', 'Geometry scope', 'Physical named-vineyard area',
    'Legal AOC eligibility area', 'Exclusive display area', 'Eligible appellations',
    'Declared production area', 'Verification', 'Source snapshot',
  ]);
  assert.match(lines.find(line => line.label === 'Physical named-vineyard area').value, /12\.89 ha/);
  assert.match(lines.find(line => line.label === 'Legal AOC eligibility area').value, /28\.23 ha/);
  assert.match(lines.find(line => line.label === 'Declared production area').value, /2024 campaign/);
});

test('fixed aocVerification contract keeps legal scope separate from physical scope', () => {
  const lines = aocFactLines({ aocVerification: {
    snapshot: '2026-10-19', officialAppellation: 'Chambertin', officialTier: 'Grand Cru',
    geometryScope: 'legal-aoc', physicalStatus: 'unverified', physicalAreaM2: 128850,
    legalAreaM2: 282340, displayAreaM2: 128850, eligibleAppellations: ['Chambertin', 'Chambertin-Clos de Bèze'],
    sourceUrl: 'https://example.test/inao', note: 'Legal footprint is not an exclusive physical vineyard boundary.',
  }});
  assert.match(lines.find(x => x.label === 'Physical named-vineyard area').value, /12\.89 ha/);
  assert.match(lines.find(x => x.label === 'Legal AOC eligibility area').value, /28\.23 ha/);
  assert.equal(lines.find(x => x.label === 'Source snapshot').value, '2026-10-19');
  assert.match(factScopeWarning({ aocVerification: { geometryScope: 'legal-aoc' }}), /not an exclusive physical vineyard boundary/);
});

test('invalid areas fail closed and production remains scoped', () => {
  const withProduction = aocFactLines({ productionAreaHa: 14.888, productionYear: 2024, aocVerification: {
    snapshot: '2026-10-19', physicalAreaM2: '', legalAreaM2: 'bad', displayAreaM2: NaN,
    physicalStatus: 'unverified', geometryScope: 'shared-eligibility',
  }});
  assert.equal(withProduction.some(line => /null/.test(line.value)), false);
  assert.equal(withProduction.find(line => line.label === 'Physical named-vineyard area').value, 'unverified');
  assert.equal(withProduction.find(line => line.label === 'Legal AOC eligibility area').value, 'not available');
  assert.match(withProduction.find(line => line.label === 'Declared production area').value, /14\.888 ha · 2024 campaign/);

  const withoutProduction = aocFactLines({ aocVerification: { snapshot: '2026-10-19' }});
  assert.equal(withoutProduction.some(line => line.label === 'Declared production area'), false);
});

test('overall verification is distinct from physical geometry status', () => {
  const lines = aocFactLines({ aocVerification: {
    physicalStatus: 'unverified', verificationStatus: 'official-source-matched',
    geometryScope: 'legal-aoc', legalAreaM2: 282340,
  }});
  assert.equal(lines.find(line => line.label === 'Physical named-vineyard area').value, 'unverified');
  assert.equal(lines.find(line => line.label === 'Verification').value, 'official source matched');
});

test('current feature verification wins over stale cached source facts', () => {
  const merged = mergeFeatureFacts({ properties: {
    name: 'Chambertin', aocVerification: { physicalAreaM2: 128850, geometryScope: 'physical-climat' },
  }}, { mappedAreaM2: 282340, aocVerification: { physicalAreaM2: 999999 } });
  assert.equal(merged.mappedAreaM2, 282340);
  assert.equal(merged.aocVerification.physicalAreaM2, 128850);
  assert.equal(aocFactLines(merged).find(line => line.label === 'Physical named-vineyard area').value, '12.89 ha');
});

const spatial = (status, matches = [], extra = {}) => ({
  spatialAocEligibility: {
    basis: 'full-source-polygon', sourceUrl: 'https://example.test/inao', snapshot: '2026-10-19',
    threshold: { fullCoverageFraction: .98, minimumOverlapM2: 10, minimumCoverageFraction: .001 },
    mappedAreaM2: 100000, status, matches, ...extra,
  },
});

test('a Premier Cru parent and its named denomination do not repeat the AOC in the summary', () => {
  const data = spatial('spatial-full-coverage', [
    { appellation: 'Volnay', denomination: 'Volnay premier cru', tier: 'Premier Cru', coverageFraction: .999 },
    { appellation: 'Volnay', denomination: 'Volnay premier cru Santenots', tier: 'Premier Cru', coverageFraction: .999 },
  ]);
  assert.equal((featureIdentity(data).aocEligibility.match(/Volnay/g) || []).length, 1);
  assert.equal(spatialAocMatches(data).length, 2);
});

// Classification uses the lieu-dit's AOC (vineyard) land only; roads, houses and woods never dilute it.
test('a lieu-dit whose vineyard land is all one cru is named outright, without a percentage', () => {
  const data = spatial('spatial-partial-coverage', [
    { appellation: 'Musigny', denomination: 'Musigny', tier: 'Grand Cru', coverageFraction: .934 },
    { appellation: 'Chambolle-Musigny', denomination: 'Chambolle-Musigny premier cru', tier: 'Premier Cru', coverageFraction: .935 },
    { appellation: 'Bourgogne', denomination: 'Bourgogne', tier: 'Regional', coverageFraction: .935 },
  ]);
  const identity = featureIdentity(data, 'climats');
  assert.deepEqual(identity, { placeType: 'Lieu-dit', tier: 'Grand Cru', aocEligibility: 'Musigny' });
  const lines = aocFactLines(data);
  assert.equal(lines.find(x => x.label === 'Grand Cru').value, 'Musigny · all of the vineyard land');
  assert.match(lines.find(x => x.label === 'Vineyard (AOC) land').value, /9\.35 ha of the 10 ha lieu-dit/);
  assert.match(lines.find(x => x.label === 'Also eligible').value, /Chambolle-Musigny premier cru, Bourgogne/);
  assert.equal(lines.some(x => /93/.test(x.value)), false);
});

test('roads and buildings in the outline do not turn a village lieu-dit into partial coverage', () => {
  const identity = featureIdentity(spatial('spatial-partial-coverage', [
    { appellation: 'Vosne-Romanée', denomination: 'Vosne-Romanée', tier: 'Village', coverageFraction: .781 },
    { appellation: 'Bourgogne', denomination: 'Bourgogne', tier: 'Regional', coverageFraction: .7834 },
  ]), 'climats');
  assert.equal(identity.tier, 'Village appellation');
  assert.equal(identity.aocEligibility, 'Vosne-Romanée');
});

test('a tiny higher-tier sliver is a boundary artefact, not a split', () => {
  const identity = spatialAocIdentity(spatial('spatial-partial-coverage', [
    { appellation: 'Vosne-Romanée', tier: 'Village', coverageFraction: .9 },
    { appellation: 'Romanée-Conti', tier: 'Grand Cru', coverageFraction: .001 },
  ]));
  assert.equal(identity.status, 'classified');
  assert.equal(identity.eligibility, 'Vosne-Romanée');
});

test('genuinely split vineyard land names both parts as shares of the vineyard land', () => {
  const identity = featureIdentity(spatial('spatial-partial-coverage', [
    { appellation: 'Vosne-Romanée', denomination: 'Vosne-Romanée', tier: 'Village', coverageFraction: .9 },
    { appellation: 'Vosne-Romanée', denomination: 'Vosne-Romanée premier cru Les Beaux Monts', tier: 'Premier Cru', coverageFraction: .45 },
  ]), 'climats');
  assert.equal(identity.tier, 'Premier Cru / Village appellation');
  assert.equal(identity.aocEligibility, 'Vosne-Romanée premier cru Les Beaux Monts on 50% of the vineyard land; Vosne-Romanée on the rest');
});

test('vineyard land split between two grand crus names both, never a lower appellation', () => {
  const identity = featureIdentity(spatial('spatial-partial-coverage', [
    { appellation: 'Morey-Saint-Denis', denomination: 'Morey-Saint-Denis', tier: 'Village', coverageFraction: .97 },
    { appellation: 'Bonnes-Mares', denomination: 'Bonnes-Mares', tier: 'Grand Cru', coverageFraction: .85 },
    { appellation: 'Clos de Tart', denomination: 'Clos de Tart', tier: 'Grand Cru', coverageFraction: .13 },
    { appellation: 'Bourgogne', denomination: "Bourgogne Côte d'Or", tier: 'Regional', coverageFraction: .98 },
  ]), 'climats');
  assert.equal(identity.tier, 'Grand Cru');
  assert.equal(identity.aocEligibility, 'Bonnes-Mares on 87% of the vineyard land; Clos de Tart on the rest');
});

test('regional land is named after its place appellation, not a grape or style appellation', () => {
  const identity = featureIdentity(spatial('spatial-full-coverage', [
    { appellation: 'Bourgogne aligoté', tier: 'Regional', coverageFraction: 1 },
    { appellation: 'Bourgogne Hautes Côtes de Nuits', tier: 'Regional', coverageFraction: 1 },
    { appellation: 'Bourgogne', tier: 'Regional', coverageFraction: 1 },
  ]), 'climats');
  assert.equal(identity.tier, 'Regional appellation');
  assert.equal(identity.aocEligibility, 'Bourgogne Hautes Côtes de Nuits');
});

test('shared eligibility at the same tier keeps both appellations', () => {
  const identity = featureIdentity(spatial('spatial-full-coverage', [
    { appellation: 'Blagny', denomination: 'Blagny premier cru Sous le Puits', tier: 'Premier Cru', coverageFraction: .99 },
    { appellation: 'Puligny-Montrachet', denomination: 'Puligny-Montrachet premier cru Sous le Puits', tier: 'Premier Cru', coverageFraction: .99 },
  ]), 'climats');
  assert.equal(identity.tier, 'Premier Cru');
  assert.match(identity.aocEligibility, /Blagny premier cru Sous le Puits/);
  assert.match(identity.aocEligibility, /Puligny-Montrachet premier cru Sous le Puits/);
});

test('no AOC land is stated plainly and absent evidence stays under review', () => {
  assert.equal(featureIdentity(spatial('no-overlap'), 'climats').aocEligibility, 'No AOC vineyard land in this lieu-dit');
  assert.equal(featureIdentity({}, 'climats').aocEligibility, 'AOC identification under review');
  assert.deepEqual(spatialAocMatches(spatial('no-overlap')), []);
});

test('spatial no-overlap reports the configured tolerance and rejects impossible coverage', () => {
  const data = spatial('no-overlap', [], { threshold: { fullCoverageFraction: .98, minimumOverlapM2: 10, minimumCoverageFraction: .001 } });
  const lines = aocFactLines(data);
  assert.equal(lines.find(x => x.label === 'INAO match tolerance').value, '10 m² · 0.1% of mapped place');
  assert.deepEqual(spatialAocMatches(spatial('spatial-partial-coverage', [
    { appellation: 'Impossible', tier: 'Regional', coverageFraction: 1.01 },
    { appellation: 'Valid', tier: 'Regional', coverageFraction: 1.0000005 },
  ])).map(x => x.appellation), ['Valid']);
});

test('direct AOC identity takes precedence over spatial evidence', () => {
  const identity = featureIdentity({
    ...spatial('spatial-partial-coverage', [{ appellation: 'Bourgogne', tier: 'Regional', coverageFraction: .99 }]),
    aocVerification: { officialDenomination: 'Chambertin', officialTier: 'Grand Cru', verificationStatus: 'official-name-and-location-matched' },
  }, 'climats');
  assert.equal(identity.aocEligibility, 'Chambertin');
  assert.equal(identity.tier, 'Grand Cru');
});

test('spatial evidence replaces an unmatched verification placeholder in the facts panel', () => {
  const lines = aocFactLines({
    ...spatial('spatial-partial-coverage', [{ appellation: 'Vosne-Romanée', tier: 'Village', coverageFraction: .781 }]),
    aocVerification: { verificationStatus: 'unverified', officialDenomination: 'Not verified' },
  });
  assert.equal(lines.some(x => x.label === 'Official denomination'), false);
  assert.equal(lines.find(x => x.label === 'Classification').value, 'Village appellation · Vosne-Romanée');
});

test('a village lieu-dit keeps its appellation identity from INAO data alone, despite roads and buildings in the broad polygon', () => {
  const meta = spatial('spatial-partial-coverage', [{appellation:'Vosne-Romanée',tier:'Village',coverageFraction:.780952}]);
  assert.equal(featureIdentity(meta).tier, 'Village appellation');
  assert.equal(featureIdentity(meta).aocEligibility, 'Vosne-Romanée');
  assert.doesNotMatch(featureIdentity(meta).aocEligibility, /%|Partial/);
});
