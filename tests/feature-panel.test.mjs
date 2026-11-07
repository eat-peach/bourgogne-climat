import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaUnits, areaText, featureArea, placeHeading, displayEntityName, displayRecordDate } from '../dist/feature-panel.js';

test('small cadastral areas retain useful precision in all three units', () => {
  assert.deepEqual(areaUnits(1442), { ha: '0.144', km2: '0.00144', acres: '0.356' });
  assert.equal(areaText(4046.8564224).split(' · ').at(-1), '1 acres');
  assert.deepEqual(areaUnits(1000000), { ha: '100', km2: '1', acres: '247.1' });
  assert.deepEqual(areaUnits(69149), { ha: '6.91', km2: '0.0691', acres: '17.1' });
});

test('missing or invalid area cannot become a misleading zero', () => {
  for (const value of [null, undefined, '', NaN, Infinity, -1]) assert.equal(areaUnits(value), null);
  assert.equal(areaUnits(0).ha, '0');
});

test('AOC-delimited area is distinct from the full named-place area', () => {
  const area = featureArea({ mappedAreaM2: 77352.86, mappedAreaStatus: 'available', aocDelimitedAreaM2: 60408.89 });
  assert.equal(area.value, 60408.89);
  assert.match(area.label, /AOC-delimited/);
});

test('physical, legal, and mapped reference areas stay explicitly separate', () => {
  const aoc = { physicalAreaM2: 128832, legalAreaM2: 282308, displayAreaM2: 90000, physicalStatus: 'derived-supported' };
  assert.equal(featureArea({ aocVerification: aoc }).value, 128832);
  assert.equal(featureArea({ aocVerification: { ...aoc, physicalStatus: 'unverified', geometryScope: 'legal-aoc' } }).value, 282308);
  const reference = featureArea({ aocVerification: { ...aoc, physicalStatus: 'unverified', geometryScope: 'named-place-reference' } });
  assert.equal(reference.value, 282308);
  assert.match(reference.label, /Full legal denomination/);
});

test('place headings combine cru and village without duplicating village AOC names', () => {
  assert.equal(placeHeading('Romanée-Saint-Vivant', 'Vosne-Romanée'), 'Romanée-Saint-Vivant – Vosne-Romanée');
  assert.equal(placeHeading('Gevrey-Chambertin', 'Gevrey-Chambertin'), 'Gevrey-Chambertin');
  assert.equal(placeHeading('', 'Vosne-Romanée'), 'Vosne-Romanée');
});

test('display formatting preserves legal acronyms and existing brand capitalization', () => {
  assert.equal(displayEntityName('SCI DOM LEROY'), 'SCI Dom Leroy');
  assert.equal(displayEntityName('DOMAINE DE LA ROMANEE CONTI'), 'Domaine de la Romanee Conti');
  assert.equal(displayEntityName('Domaine Armand Rousseau'), 'Domaine Armand Rousseau');
});

test('record dates are human readable and invalid dates do not get silently normalized', () => {
  assert.equal(displayRecordDate('2025-01-01'), '1 Jan 2025');
  assert.equal(displayRecordDate('2025-02-31'), '');
  assert.equal(displayRecordDate(null), '');
});
