// Region settings for the shared atlas engine. The Burgundy page uses the built-in defaults (four AOC tiers);
// another region page (e.g. /rhone/) ships data/region.json with its own classes, groups and names, loaded
// before the atlas starts. Classes are matched by their normalised key ("cote-rotie", "regional", ...).
export const REGION = {
  id: 'bourgogne',
  title: 'Bourgogne Climat',
  overview: 'Burgundy',
  classes: [],   // [{ key, label, tier, rank, colour }]; empty means the Burgundy tiers
  groups: null,  // [{ id, label, villages: [scene ids] }]; null means the Burgundy wine regions
  terrainExaggeration: null, // e.g. 2 for the steep Northern Rhône slopes; null keeps the page default (3x)
  latLon: [47.1, 4.9], // where the Sun & rain panel works out the sun's position; the Côte d'Or by default
  owners: true,  // false where no owner register exists (Germany): the owner search and hints are hidden
  photoTiles: false, // true where data/photo-tiles/ holds sharp photos for close views (0.5 m tiles)
  closeViewHalfSize: null, // smallest half-width of the assembled view, metres (default 3000); smaller gives sharper close views
};
const byKey = new Map();
// Wording a region may change (region.json "terms"): the Rhône says commune and lieu-dit, never village or climat.
const TERMS = { village: 'village', villages: 'villages', Village: 'Village', Villages: 'Villages', wineRegion: 'wine region', WineRegion: 'Wine region',
  allWineRegions: 'All wine regions', searchGroup: 'Crus', classificationField: 'AOC classification (Grand Cru, Premier Cru…)' };
export const term = key => TERMS[key] ?? key;

export async function loadRegion(url) {
  let data = null;
  try { const res = await fetch(url, { headers: { accept: 'application/json' } }); if (res.ok) data = await res.json(); } catch {}
  if (!data) return REGION;
  Object.assign(REGION, { id: data.id, title: data.title || REGION.title, overview: data.title || REGION.overview, classes: data.classes || [], groups: data.groups || null,
    terrainExaggeration: data.terrainExaggeration ?? null, latLon: data.latLon || REGION.latLon, owners: data.owners !== false, photoTiles: Boolean(data.photoTiles), closeViewHalfSize: Number(data.closeViewHalfSize) || null });
  Object.assign(TERMS, data.terms || {});
  byKey.clear();
  for (const c of REGION.classes) byKey.set(String(c.key), c);
  return REGION;
}

export const regionClass = key => byKey.get(String(key));
export const hasRegionClasses = () => byKey.size > 0;
