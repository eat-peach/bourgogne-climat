import assert from 'node:assert/strict';
import test from 'node:test';
import index from '../dist/data/index.json' with { type: 'json' };
import assignmentLists from '../dist/data/wine-region-assignments.json' with { type: 'json' };
import {
  WINE_REGIONS,
  assertWineRegionCoverage,
  groupVillagesByWineRegion,
  findWineRegion
} from '../dist/regional-navigation.js';

test('every atlas village belongs to one wine region', () => {
  const result = assertWineRegionCoverage(index.villages);
  assert.equal(result.count, index.villages.length);
  assert.equal(result.groups.length, 7);
  assert.equal(result.groups.reduce((sum, group) => sum + group.villages.length, 0), 376);
});

test('the auditable assignment file covers the same IDs exactly once', () => {
  const ids = Object.values(assignmentLists).flat();
  assert.equal(ids.length, index.villages.length);
  assert.equal(new Set(ids).size, index.villages.length);
  assert.deepEqual(new Set(ids), new Set(index.villages.map(village => village.id)));
});

test('regions and villages are north to south', () => {
  const groups = groupVillagesByWineRegion(index.villages);
  assert.deepEqual(groups.map(group => group.id), WINE_REGIONS.map(region => region.id));
  for (const group of groups) {
    for (let i = 1; i < group.villages.length; i += 1) {
      assert.ok(group.villages[i - 1].center[1] >= group.villages[i].center[1], `${group.id} latitude order`);
    }
  }
});

test('officially named Beaujolais extension communes stay distinguishable', () => {
  for (const name of ['Saint-Amour-Bellevue', 'Romanèche-Thorins', 'Pruzilly']) {
    const village = index.villages.find(entry => entry.name === name && entry.department === '71');
    assert.ok(village, `fixture contains ${name}`);
    assert.equal(findWineRegion(village).id, 'beaujolais');
  }
  for (const name of ['Chasselas', 'Leynes', 'Chaintré', 'Chânes', 'Saint-Vérand']) {
    const village = index.villages.find(entry => entry.name === name && entry.department === '71');
    assert.ok(village, `fixture contains ${name}`);
    assert.equal(findWineRegion(village).id, 'maconnais');
  }
  assert.equal(findWineRegion(index.villages.find(entry => entry.id === 'sennecey-le-grand-71512')).id, 'maconnais');
  assert.equal(findWineRegion(index.villages.find(entry => entry.id === 'm-con-71270')).id, 'maconnais');
});

test('north-to-south BIVB sequence has expected anchor villages', () => {
  const regionOf = id => findWineRegion(index.villages.find(entry => entry.id === id)).id;
  assert.equal(regionOf('joigny-89206'), 'chablis-grand-auxerrois');
  assert.equal(regionOf('gomm-ville-21302'), 'chatillonnais');
  assert.equal(regionOf('gevrey-chambertin-21295'), 'cote-de-nuits');
  assert.equal(regionOf('beaune-21054'), 'cote-de-beaune');
  assert.equal(regionOf('givry-71221'), 'cote-chalonnaise-couchois');
  assert.equal(regionOf('fuiss-71210'), 'maconnais');
  assert.equal(regionOf('fleurie-69084'), 'beaujolais');
});

test('named transition communes use reviewed navigation assignments', () => {
  const regionOf = id => findWineRegion(index.villages.find(entry => entry.id === id)).id;
  assert.equal(regionOf('daix-21223'), 'cote-de-nuits');
  assert.equal(regionOf('corgoloin-21194'), 'cote-de-nuits');
  assert.equal(regionOf('chevronne-21241'), 'cote-de-beaune');
  assert.equal(regionOf('cheilly-l-s-maranges-71122'), 'cote-de-beaune');
  assert.equal(regionOf('cr-ot-71151'), 'cote-chalonnaise-couchois');
  assert.equal(regionOf('remigny-71369'), 'cote-de-beaune');
});
