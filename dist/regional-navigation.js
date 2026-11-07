/**
 * Wine-region navigation for the named-village atlas.
 *
 * The regions follow the BIVB/Bourgogne Wines north-to-south map. Explicit
 * village IDs in data/wine-region-assignments.js are the source of truth for
 * this browsing grouping; this is not an appellation boundary dataset.
 */

import { WINE_REGION_ASSIGNMENTS as WINE_REGION_ID_LISTS } from './data/wine-region-assignments.js';

export const WINE_REGION_ASSIGNMENTS = Object.freeze(Object.fromEntries(
  Object.entries(WINE_REGION_ID_LISTS).flatMap(([region, ids]) => ids.map(id => [id, region]))
));

export const WINE_REGIONS = Object.freeze([
  { id: 'chablis-grand-auxerrois', label: 'Chablis & Grand Auxerrois', shortLabel: 'Chablis / Auxerrois', order: 1 },
  { id: 'chatillonnais', label: 'Châtillonnais', shortLabel: 'Châtillonnais', order: 2 },
  { id: 'cote-de-nuits', label: 'Côte de Nuits & Hautes Côtes', shortLabel: 'Côte de Nuits', order: 3 },
  { id: 'cote-de-beaune', label: 'Côte de Beaune & Hautes Côtes', shortLabel: 'Côte de Beaune', order: 4 },
  { id: 'cote-chalonnaise-couchois', label: 'Côte Chalonnaise & Couchois', shortLabel: 'Côte Chalonnaise', order: 5 },
  { id: 'maconnais', label: 'Mâconnais', shortLabel: 'Mâconnais', order: 6 },
  { id: 'beaujolais', label: 'Beaujolais', shortLabel: 'Beaujolais', scope: 'includes documented southern Saône-et-Loire extension', order: 7 }
]);

export const WINE_REGION_BY_ID = Object.freeze(Object.fromEntries(WINE_REGIONS.map(region => [region.id, region])));

// The Burgundy groups above are the default; another region page (region.js) swaps in its own browsing groups.
let activeRegions = WINE_REGIONS, activeAssignments = WINE_REGION_ASSIGNMENTS, activeById = WINE_REGION_BY_ID;
export function setWineRegions(groups) {
  activeRegions = groups.map((group, i) => ({ id: group.id, label: group.label, shortLabel: group.label, order: i + 1 }));
  activeAssignments = Object.fromEntries(groups.flatMap(group => group.villages.map(id => [id, group.id])));
  activeById = Object.fromEntries(activeRegions.map(region => [region.id, region]));
}

function classifiedRegion(village) {
  return village?.id ? activeAssignments[village.id] ?? null : null;
}

export function findWineRegion(villageOrId, villages = []) {
  const village = typeof villageOrId === 'object'
    ? villageOrId
    : villages.find(entry => entry.id === villageOrId);
  const id = classifiedRegion(village);
  return id ? activeById[id] : null;
}

export function groupVillagesByWineRegion(villages) {
  const groups = new Map(activeRegions.map(region => [region.id, { ...region, villages: [] }]));
  for (const village of villages ?? []) {
    const id = classifiedRegion(village);
    if (id) groups.get(id).villages.push(village);
  }
  for (const group of groups.values()) {
    group.villages.sort((a, b) => Number(b.center?.[1] ?? -Infinity) - Number(a.center?.[1] ?? -Infinity)
      || String(a.name).localeCompare(String(b.name), 'fr'));
  }
  return activeRegions.map(region => groups.get(region.id));
}

export function wineRegionOptions() {
  return activeRegions.map(({ id, label }) => ({ id, label }));
}

export function assertWineRegionCoverage(villages) {
  const groups = groupVillagesByWineRegion(villages);
  const assigned = groups.flatMap(group => group.villages);
  const input = [...(villages ?? [])];
  const ids = new Set(assigned.map(village => village.id));
  const duplicates = assigned.map(village => village.id).filter((id, index, all) => all.indexOf(id) !== index);
  const missing = input.filter(village => !ids.has(village.id)).map(village => village.id);
  if (duplicates.length || missing.length || assigned.length !== input.length) {
    throw new Error(`Wine-region coverage failed: ${duplicates.length} duplicate(s), ${missing.length} missing village(s)`);
  }
  return { count: assigned.length, groups };
}

