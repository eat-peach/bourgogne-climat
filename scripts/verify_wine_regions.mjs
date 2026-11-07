import assert from 'node:assert/strict';
import index from '../dist/data/index.json' with { type: 'json' };
import { assertWineRegionCoverage, groupVillagesByWineRegion } from '../dist/regional-navigation.js';

const { groups, count } = assertWineRegionCoverage(index.villages);
assert.equal(count, index.villages.length);
assert.deepEqual(groups.map(group => group.order), [1, 2, 3, 4, 5, 6, 7]);
console.log(`Verified ${count} villages across ${groups.length} wine regions.`);
for (const group of groups) console.log(`${group.order}. ${group.label}: ${group.villages.length}`);
