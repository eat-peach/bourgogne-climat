/*
 * Cross-commune scene composition.
 *
 * Scene heights are absolute EPSG:2154 elevations.  Source grids and the
 * generated grid use row 0 at the north edge and increase southward.  The
 * renderer must use validMask when building terrain triangles: null samples
 * are source gaps and are never replacement elevations.
 */

export const MOSAIC_GRID_SIZE = 193, DETAIL_MAX_VIEW_M = 4200, DETAIL_TILE_LIMIT = 48;
export const DEFAULT_MAX_SOURCES = 8;
export const DEFAULT_CACHE_LIMIT = 12;

const LAYERS = [
  'climats', 'parcels', 'buildings', 'roads', 'forests', 'forest',
  'waterSurfaces', 'waterLines', 'water', 'labels', 'appellations',
];

function finite(value) { return value != null && value !== '' && Number.isFinite(Number(value)); }
function num(value, fallback = null) { return finite(value) ? Number(value) : fallback; }

export function normalizeBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length < 4 || !bounds.slice(0, 4).every(finite)) return null;
  const x0 = Number(bounds[0]), y0 = Number(bounds[1]), x1 = Number(bounds[2]), y1 = Number(bounds[3]);
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

export function boundsArea(bounds) {
  const b = normalizeBounds(bounds);
  return b ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0;
}

export function boundsIntersects(a, b, epsilon = 0) {
  const aa = normalizeBounds(a), bb = normalizeBounds(b);
  return Boolean(aa && bb && aa[0] <= bb[2] + epsilon && aa[2] >= bb[0] - epsilon && aa[1] <= bb[3] + epsilon && aa[3] >= bb[1] - epsilon);
}

export function expandBounds(bounds, margin) {
  const b = normalizeBounds(bounds);
  const m = Math.max(0, num(margin, 0));
  return b ? [b[0] - m, b[1] - m, b[2] + m, b[3] + m] : null;
}

export function boundsCenter(bounds) {
  const b = normalizeBounds(bounds);
  return b ? { easting: (b[0] + b[2]) / 2, northing: (b[1] + b[3]) / 2 } : null;
}

export function pointInBounds(easting, northing, bounds, epsilon = 1e-7) {
  const b = normalizeBounds(bounds);
  return Boolean(b && Number(easting) >= b[0] - epsilon && Number(easting) <= b[2] + epsilon && Number(northing) >= b[1] - epsilon && Number(northing) <= b[3] + epsilon);
}

export function distanceToBounds(easting, northing, bounds) {
  const b = normalizeBounds(bounds);
  if (!b || !finite(easting) || !finite(northing)) return Infinity;
  const dx = Math.max(b[0] - Number(easting), 0, Number(easting) - b[2]);
  const dy = Math.max(b[1] - Number(northing), 0, Number(northing) - b[3]);
  return Math.hypot(dx, dy);
}

export function sceneBounds(scene, entry = null) {
  return normalizeBounds(scene?.bounds || scene?.bounds2154 || entry?.bounds || entry?.bounds2154);
}

function gridOf(scene) {
  const heights = scene?.heights || scene?.heightGrid || scene?.terrain?.heights;
  const grid = Number(scene?.gridSize || scene?.terrain?.gridSize || Math.sqrt(Array.isArray(heights) ? heights.length : 0));
  return Number.isInteger(grid) && grid > 1 ? grid : 0;
}

const preparedSceneCache = new WeakMap();

function sourceArray(scene) {
  const values = scene?.heights || scene?.heightGrid || scene?.terrain?.heights;
  if (!Array.isArray(values)) return null;
  const flat = Array.isArray(values[0]) ? values.flat() : values;
  return flat.length === gridOf(scene) ** 2 ? flat : null;
}

function sourceMask(scene, index) {
  const mask = scene?.validMask || scene?.coverage?.validMask || scene?.terrain?.validMask;
  if (!mask) return true;
  if (Array.isArray(mask) || ArrayBuffer.isView(mask)) return mask[index] !== false && mask[index] !== 0;
  if (typeof mask === 'string') return mask[index] !== '0';
  return true;
}

function prepareSourceGrid(scene, entry = null) {
  if (!scene || typeof scene !== 'object') return null;
  const cached = preparedSceneCache.get(scene);
  if (cached) return cached;
  const values = sourceArray(scene);
  const grid = gridOf(scene);
  const bounds = sceneBounds(scene, entry);
  if (!values || !bounds || grid < 2) return null;
  const rawMask = scene?.validMask || scene?.coverage?.validMask || scene?.terrain?.validMask;
  const mask = rawMask == null ? null : (Array.isArray(rawMask) || ArrayBuffer.isView(rawMask) || typeof rawMask === 'string' ? rawMask : null);
  const prepared = { scene, values, grid, bounds, mask };
  preparedSceneCache.set(scene, prepared);
  return prepared;
}

function preparedMask(prepared, index) {
  const mask = prepared.mask;
  if (!mask) return true;
  if (Array.isArray(mask) || ArrayBuffer.isView(mask)) return mask[index] !== false && mask[index] !== 0;
  if (typeof mask === 'string') return mask[index] !== '0';
  return true;
}

function pointInPreparedBounds(easting, northing, bounds) {
  return Number(easting) >= bounds[0] - 1e-7 && Number(easting) <= bounds[2] + 1e-7 && Number(northing) >= bounds[1] - 1e-7 && Number(northing) <= bounds[3] + 1e-7;
}

/** Bilinear sample from a source grid prepared once for a composition. */
function samplePreparedScene(prepared, easting, northing) {
  if (!prepared || !pointInPreparedBounds(easting, northing, prepared.bounds)) return null;
  const [xmin, ymin, xmax, ymax] = prepared.bounds;
  const col = Math.max(0, Math.min(prepared.grid - 1, (Number(easting) - xmin) / (xmax - xmin) * (prepared.grid - 1)));
  const row = Math.max(0, Math.min(prepared.grid - 1, (ymax - Number(northing)) / (ymax - ymin) * (prepared.grid - 1)));
  const c0 = Math.floor(col), r0 = Math.floor(row), c1 = Math.min(prepared.grid - 1, c0 + 1), r1 = Math.min(prepared.grid - 1, r0 + 1);
  const tx = col - c0, ty = row - r0;
  const at = (r, c) => {
    const i = r * prepared.grid + c;
    const value = prepared.values[i];
    return preparedMask(prepared, i) && finite(value) ? Number(value) : null;
  };
  const samples = [at(r0, c0), at(r0, c1), at(r1, c0), at(r1, c1)];
  if (samples.some(value => value == null)) return null;
  return (samples[0] * (1 - tx) + samples[1] * tx) * (1 - ty) + (samples[2] * (1 - tx) + samples[3] * tx) * ty;
}

/** Bilinear sample in EPSG:2154. Source rows are north-to-south. */
export function sampleScene(scene, easting, northing) {
  return samplePreparedScene(prepareSourceGrid(scene), easting, northing);
}

export function sourceResolution(scene, entry = null) {
  const b = sceneBounds(scene, entry), g = gridOf(scene);
  if (!b || g < 2) return Infinity;
  return Math.max(b[2] - b[0], b[3] - b[1]) / (g - 1);
}

function featureGeometry(feature) {
  const geometry = feature?.geometry || feature;
  if (!geometry) return [];
  if (geometry.type === 'Feature') return featureGeometry(geometry);
  if (geometry.type === 'FeatureCollection') return geometry.features?.flatMap(featureGeometry) || [];
  if (geometry.type === 'Polygon') return geometry.coordinates || [];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates?.flat(1) || [];
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') return geometry.coordinates || [];
  const rings = geometry.rings || geometry.coordinates || geometry.ring;
  return Array.isArray(rings) ? rings : [];
}

function walkCoordinates(value, callback) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && finite(value[0]) && finite(value[1])) { callback(Number(value[0]), Number(value[1])); return; }
  value.forEach(item => walkCoordinates(item, callback));
}

const featureBoundsCache = new WeakMap();

export function featureBounds(feature) {
  if (feature && typeof feature === 'object' && featureBoundsCache.has(feature)) return featureBoundsCache.get(feature);
  const coordinates = featureGeometry(feature);
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  walkCoordinates(coordinates, (x, y) => { xmin = Math.min(xmin, x); ymin = Math.min(ymin, y); xmax = Math.max(xmax, x); ymax = Math.max(ymax, y); });
  const result = Number.isFinite(xmin) ? [xmin, ymin, xmax, ymax] : null;
  if (feature && typeof feature === 'object') featureBoundsCache.set(feature, result);
  return result;
}

export function featureIntersects(feature, bounds) {
  const fb = featureBounds(feature);
  return Boolean(fb && boundsIntersects(fb, bounds));
}

function boundaryRings(boundary) {
  const geometry = boundary?.geometry || boundary;
  if (geometry?.type === 'Feature') return boundaryRings(geometry);
  if (geometry?.type === 'Polygon') return geometry.coordinates || [];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates?.flat(1) || [];
  const rings = geometry?.rings || geometry?.coordinates || geometry?.ring;
  const out = [];
  const visit = value => {
    if (!Array.isArray(value) || !value.length) return;
    if (value.length >= 3 && Array.isArray(value[0]) && finite(value[0][0]) && finite(value[0][1])) { out.push(value); return; }
    value.forEach(visit);
  };
  visit(rings);
  return out;
}

function pointInRing(easting, northing, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]), yi = Number(ring[i][1]), xj = Number(ring[j][0]), yj = Number(ring[j][1]);
    if (!Number.isFinite(xi + yi + xj + yj)) continue;
    const crossing = ((yi > northing) !== (yj > northing)) && easting < (xj - xi) * (northing - yi) / ((yj - yi) || 1e-12) + xi;
    if (crossing) inside = !inside;
  }
  return inside;
}

function pointInBoundary(easting, northing, boundary) {
  const bounds = boundary?.bounds || boundary?.bounds2154;
  if (bounds && !pointInBounds(easting, northing, bounds)) return false;
  const rings = boundaryRings(boundary);
  if (!rings.length) return Boolean(bounds && pointInBounds(easting, northing, bounds));
  // Even-odd parity handles holes and disjoint multipolygon parts without
  // requiring a particular winding order from the boundary export.
  let inside = false;
  for (const ring of rings) if (pointInRing(easting, northing, ring)) inside = !inside;
  return inside;
}

// A compact fingerprint of a feature's coordinates (FNV-1a over centimetre-rounded
// values). Identifies the same feature repeated across neighbouring scenes without
// serialising its whole geometry to a string.
function geometryDigest(geometry) {
  let hash = 0x811c9dc5, count = 0;
  const mix = value => { let v = Math.round(value * 100) | 0; for (let k = 0; k < 4; k++) { hash ^= v & 0xff; hash = Math.imul(hash, 0x01000193); v >>>= 8; } };
  walkCoordinates(featureGeometry(geometry), (x, y) => { mix(x); mix(y); count++; });
  return `${count}:${(hash >>> 0).toString(36)}`;
}

const featureKeyCache = new WeakMap();

export function featureKey(feature, layer = '') {
  const p = feature?.properties || feature || {};
  const id = p.id ?? p.ID ?? p.code ?? p.code_insee ?? feature?.id;
  if (feature && typeof feature === 'object') {
    let byLayer = featureKeyCache.get(feature);
    if (!byLayer) { byLayer = new Map(); featureKeyCache.set(feature, byLayer); }
    if (byLayer.has(layer)) return byLayer.get(layer);
    const key = `${layer}:${id != null ? String(id) : 'anonymous'}:${geometryDigest(feature)}`;
    byLayer.set(layer, key);
    return key;
  }
  return `${layer}:${id != null ? String(id) : 'anonymous'}:${geometryDigest(feature)}`;
}

function collection(scene, layer) {
  if (layer === 'forest') return scene?.forest || scene?.forests || scene?.forestMask || [];
  if (layer === 'water') return scene?.water || scene?.waterSurfaces || scene?.waterLines || [];
  return scene?.[layer] || [];
}

function sourceDistance(entry, center) {
  const b = normalizeBounds(entry.coverageBounds || entry.entry?.aocBounds2154 || entry.aocBounds2154 || sceneBounds(entry.scene || entry, entry));
  return distanceToBounds(center.easting, center.northing, b);
}

function sourceCoverageBounds(source) {
  return normalizeBounds(source?.coverageBounds || source?.entry?.aocBounds2154 || source?.aocBounds2154 || source?.bounds);
}

/** Compose a viewport scene from the loaded source scenes. */
export function buildMosaicScene({ bounds, sources = [], backgroundSources = [], gridSize = MOSAIC_GRID_SIZE, textureManifest = {}, textureBase = '', maxFeaturesPerLayer = 4000, focusId = null, preferAvif = false, detailTiles = null } = {}) {
  const viewport = normalizeBounds(bounds);
  if (!viewport || !Number.isInteger(gridSize) || gridSize < 2) throw new Error('Mosaic viewport requires valid bounds and grid size');
  const loaded = sources.map(item => {
    const scene = item.scene || item;
    const prepared = prepareSourceGrid(scene, item.entry || item);
    const sceneB = prepared?.bounds || sceneBounds(scene, item.entry || item);
    return sceneB && prepared ? { ...item, scene, prepared, bounds: sceneB, resolution: sourceResolution(scene, item.entry || item) } : null;
  }).filter(Boolean);
  const contextCandidates = backgroundSources.map(item => {
    const scene = item.scene || item;
    const prepared = prepareSourceGrid(scene, item.entry || item);
    const sceneB = prepared?.bounds || sceneBounds(scene, item.entry || item);
    return sceneB && prepared ? { ...item, scene, prepared, bounds: sceneB, resolution: sourceResolution(scene, item.entry || item), isContext: true } : null;
  }).filter(Boolean);
  const contextSourceCount = contextCandidates.length;
  const context = contextCandidates.filter(source => boundsIntersects(source.bounds, viewport));
  // Resolution is the primary source priority. A fixed order avoids sorting
  // a candidate list for every one of the output grid's samples.
  loaded.sort((a, b) => a.resolution - b.resolution);
  context.sort((a, b) => a.resolution - b.resolution);
  const center = boundsCenter(viewport);
  const heights = new Array(gridSize * gridSize).fill(null);
  const validMask = new Array(gridSize * gridSize).fill(false);
  const selectedSourceIds = new Set();
  const elevations = [];
  let contextTerrainUsed = false;
  for (let row = 0; row < gridSize; row++) {
    const northing = viewport[3] - (row / (gridSize - 1)) * (viewport[3] - viewport[1]);
    for (let col = 0; col < gridSize; col++) {
      const easting = viewport[0] + (col / (gridSize - 1)) * (viewport[2] - viewport[0]);
      let source = null, value = null;
      for (const candidate of loaded) {
        if (!pointInPreparedBounds(easting, northing, candidate.bounds)) continue;
        const sampled = samplePreparedScene(candidate.prepared, easting, northing);
        if (sampled != null) { source = candidate; value = sampled; break; }
      }
      if (value == null) for (const candidate of context) {
        if (!pointInPreparedBounds(easting, northing, candidate.bounds)) continue;
        const sampled = samplePreparedScene(candidate.prepared, easting, northing);
        if (sampled != null) { source = candidate; value = sampled; break; }
      }
      const i = row * gridSize + col;
      if (value != null) {
        heights[i] = value;
        validMask[i] = true;
        elevations.push(value);
        contextTerrainUsed ||= Boolean(source.isContext);
        if (!source.isContext) selectedSourceIds.add(source.id || source.entry?.id || source.scene?.id);
      }
    }
  }
  const output = {
    id: focusId ? `mosaic:${focusId}` : 'mosaic',
    name: 'Burgundy regional view',
    bounds: viewport,
    bounds2154: viewport,
    gridSize,
    rowOrder: 'north-to-south',
    heights,
    validMask,
    // a loop, not Math.min(...elevations): spreading 66 000 values overflows the smaller stack of a worker
    minElevation: elevations.length ? elevations.reduce((a, b) => (b < a ? b : a), Infinity) : null,
    maxElevation: elevations.length ? elevations.reduce((a, b) => (b > a ? b : a), -Infinity) : null,
    textureTiles: [],
    sourceIds: [...selectedSourceIds],
    coverage: {
      sourceCount: loaded.length,
      contextSourceCount,
      validSampleFraction: validMask.filter(Boolean).length / validMask.length,
      contextTerrainUsed,
      contextSamplingMetres: (() => { const values = context.map(source => source.resolution).filter(Number.isFinite); return values.length ? Math.min(...values) : null; })(),
      sourceCoverageHint: context.length ? 'Context terrain beyond aerial coverage uses the prepared coarse IGN source where fine village terrain is absent.' : loaded.length ? 'Terrain is drawn only where an atlas source covers the viewport.' : 'No source terrain covers this viewport.',
      terrainEdgeFillUsed: false,
    },
  };
  const seenTextures = new Set();
  // Background photos go first so the scene photos paint over them; optional, so a failed one never blocks the rest.
  const resolveUrl = value => value && textureBase ? new URL(value, textureBase).href : value;
  for (const source of context) {
    const manifest = textureManifest[source.id] || {};
    const url = (preferAvif && manifest.urlAvif) || manifest.url;
    if (!url || seenTextures.has(url)) continue;
    seenTextures.add(url);
    output.textureTiles.push({ url: resolveUrl(url), fallbackUrl: manifest.urlAvif && manifest.url ? resolveUrl(manifest.url) : null, bounds: manifest.bounds || source.bounds, sourceId: source.id, optional: true });
  }
  for (const source of loaded) {
    if (!boundsIntersects(source.bounds, viewport)) continue;
    const manifest = textureManifest[source.id] || textureManifest[source.entry?.id] || {};
    const jpeg = source.scene.textureFallback || source.scene.texture || source.entry?.texture || manifest.url;
    const avif = preferAvif ? source.entry?.textureAvif || manifest.urlAvif : null;
    const url = avif || jpeg;
    if (!url || seenTextures.has(url)) continue;
    seenTextures.add(url);
    output.textureTiles.push({ url: resolveUrl(url), fallbackUrl: avif && jpeg ? resolveUrl(jpeg) : null, bounds: source.bounds, sourceId: source.id || source.entry?.id || source.scene?.id });
  }
  // Sharp photos for close views (a region's data/photo-tiles/): the tiles under a small assembled view are drawn over
  // the village photos, nearest the middle first, at most DETAIL_TILE_LIMIT. Optional, so a missing one shows the
  // village photo beneath.
  if (detailTiles?.tiles?.length && viewport) {
    const T = Number(detailTiles.tileSize) || 500, span = Math.max(viewport[2] - viewport[0], viewport[3] - viewport[1]);
    if (span <= (Number(detailTiles.maxViewM) || DETAIL_MAX_VIEW_M)) {
      const have = detailTiles._set || (detailTiles._set = new Set(detailTiles.tiles)), cx = (viewport[0] + viewport[2]) / 2, cy = (viewport[1] + viewport[3]) / 2, near = [];
      for (let x = Math.floor(viewport[0] / T); x < Math.ceil(viewport[2] / T); x++) for (let y = Math.floor(viewport[1] / T); y < Math.ceil(viewport[3] / T); y++)
        if (have.has(`${x}_${y}`)) near.push({ x, y, d: Math.hypot((x + .5) * T - cx, (y + .5) * T - cy) });
      near.sort((a, b) => a.d - b.d);
      for (const { x, y } of near.slice(0, DETAIL_TILE_LIMIT).reverse())  // farthest first, so the middle paints last
        output.textureTiles.push({ url: resolveUrl(String(detailTiles.url).replace('{x}', x).replace('{y}', y)), bounds: [x * T, y * T, (x + 1) * T, (y + 1) * T], sourceId: `detail:${x}_${y}`, optional: true, detail: true });
    }
  }
  if (output.textureTiles.length === 1) output.texture = output.textureTiles[0].url;
  const featureSets = new Map(LAYERS.map(layer => [layer, []]));
  const seen = new Map(LAYERS.map(layer => [layer, new Set()]));
  for (const source of loaded) {
    if (!boundsIntersects(sourceCoverageBounds(source), viewport)) continue;
    for (const layer of LAYERS) {
      const list = collection(source.scene, layer);
      if (!Array.isArray(list)) continue;
      for (const feature of list) {
        if (!featureIntersects(feature, viewport)) continue;
        if (layer !== 'parcels' && !boundsIntersects(source.bounds, viewport)) continue;
        const key = featureKey(feature, layer);
        if (seen.get(layer).has(key)) continue;
        seen.get(layer).add(key);
        featureSets.get(layer).push(feature);
        if (featureSets.get(layer).length >= maxFeaturesPerLayer) break;
      }
    }
  }
  for (const layer of LAYERS) if (featureSets.get(layer).length) output[layer] = featureSets.get(layer);
  // The renderer historically consumes `forest` while source scenes use
  // `forests`; retain both names so the contract is explicit and compatible.
  if (output.forests && !output.forest) output.forest = output.forests;
  const stats = {};
  for (const layer of LAYERS) stats[`${layer.replace(/s$/, '')}Count`] = (output[layer] || []).length;
  output.stats = stats;
  return output;
}

export function viewportBounds({ easting, northing, radiusMetres } = {}) {
  const x = num(easting), y = num(northing), r = Math.max(100, num(radiusMetres, 1800));
  if (x == null || y == null) return null;
  return [x - r, y - r, x + r, y + r];
}

export function villageCenter(village, scene = null) {
  if (Array.isArray(village?.bounds2154) && village.bounds2154.length >= 4) return boundsCenter(village.bounds2154);
  if (sceneBounds(scene, village)) return boundsCenter(sceneBounds(scene, village));
  if (Array.isArray(village?.center) && village.center.length >= 2) return { easting: Number(village.center[0]), northing: Number(village.center[1]) };
  return null;
}

export function nearestVillage(villages, easting, northing, { boundaries = null } = {}) {
  if (!Array.isArray(villages) || !villages.length || !finite(easting) || !finite(northing)) return null;
  const boundaryList = Array.isArray(boundaries) ? boundaries : [];
  const match = boundaryList.find(commune => pointInBoundary(easting, northing, commune));
  if (match) {
    const p = match.properties || match;
    const code = p.id || p.code || p.code_insee || p.insee || p.communeId;
    const byCode = code == null ? null : villages.find(village => String(village.code || village.insee || village.inseeCode || '').toLowerCase() === String(code).toLowerCase() || String(village.id || '').endsWith(`-${code}`));
    const resolved = villages.find(village => String(village.id) === String(code)) || byCode || villages.find(village => foldVillageName(village.name) === foldVillageName(p.name || p.nom));
    if (resolved) return resolved;
  }
  return villages.map(village => {
    const center = villageCenter(village);
    const bounds = village.bounds2154;
    return { village, distance: center ? Math.hypot(center.easting - easting, center.northing - northing) : distanceToBounds(easting, northing, bounds) };
  }).sort((a, b) => a.distance - b.distance)[0]?.village || null;
}

function foldVillageName(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

export class SceneMosaic {
  // coverage: how much wider than the view the assembled area is (at least minHalfSize metres from its centre), so
  // zooming back out or panning a little needs no re-assembly. 1 = exactly the view.
  constructor({ index, loadScene, textureManifest = {}, textureBase = '', backgroundSources = [], cacheLimit = DEFAULT_CACHE_LIMIT, maxLoadedScenes = DEFAULT_MAX_SOURCES, gridSize = MOSAIC_GRID_SIZE, boundaries = [], preferAvif = false, coverage = 1, minHalfSize = 0, detailTiles = null } = {}) {
    this.detailTiles = detailTiles && Array.isArray(detailTiles.tiles) ? detailTiles : null;
    this.coverage = Math.max(1, Number(coverage) || 1); this.minHalfSize = Math.max(0, Number(minHalfSize) || 0);
    this.preferAvif = preferAvif;
    this.index = index || { villages: [] };
    this.loadScene = loadScene;
    this.textureManifest = textureManifest;
    this.textureBase = textureBase;
    this.backgroundSources = backgroundSources;
    // cacheLimit 0 means loadScene already caches scenes, so the mosaic keeps no second copy.
    this.cacheLimit = cacheLimit === 0 ? 0 : Math.max(DEFAULT_MAX_SOURCES, cacheLimit);
    this.maxLoadedScenes = Math.max(1, maxLoadedScenes);
    this.gridSize = gridSize;
    this.boundaries = boundaries;
    this.cache = new Map();
    this.active = new Map();
    this.generation = 0;
  }

  entry(id) { return this.index.villages?.find(village => String(village.id) === String(id)) || null; }
  findVillage(easting, northing) { return nearestVillage(this.index.villages || [], easting, northing, { boundaries: this.boundaries }); }
  cached(id) { const value = this.cache.get(String(id)); if (value) { this.cache.delete(String(id)); this.cache.set(String(id), value); } return value?.scene || null; }
  trimCache() {
    while (this.cache.size > this.cacheLimit) {
      const removable = [...this.cache.keys()].find(id => !this.active.has(id));
      if (removable == null) break;
      this.cache.delete(removable);
    }
  }

  async ensure(entry, signal) {
    if (!entry) return null;
    const id = String(entry.id);
    const cached = this.cached(id);
    if (cached) { this.active.set(id, cached); return { id, entry, scene: cached, bounds: sceneBounds(cached, entry), coverageBounds: normalizeBounds(entry.aocBounds2154 || entry.bounds2154 || sceneBounds(cached, entry)) }; }
    if (typeof this.loadScene !== 'function') return null;
    const scene = await this.loadScene(entry, signal);
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const record = { id, entry, scene, bounds: sceneBounds(scene, entry), coverageBounds: normalizeBounds(entry.aocBounds2154 || entry.bounds2154 || sceneBounds(scene, entry)) };
    if (this.cacheLimit) { this.cache.set(id, record); this.trimCache(); }
    this.active.set(id, scene);
    return record;
  }

  // The area assembled for a view: its centre, and a half-size of coverage × the view radius, at least minHalfSize.
  coveredView(view) { const r = Math.max(100, Number(view?.radiusMetres) || 1800); return { ...view, radiusMetres: Math.max(r * this.coverage, this.minHalfSize) }; }
  // The villages a view is assembled from: those overlapping the assembled area (plus a quarter), nearest first, at most
  // maxLoadedScenes, always including the focus village.
  chooseCandidates(view, focusId = null) {
    const bounds = viewportBounds(this.coveredView(view)); if (!bounds) return [];
    const center = boundsCenter(bounds);
    const queryBounds = expandBounds(bounds, Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 0.25);
    const candidates = (this.index.villages || []).map(entry => ({ entry, bounds: normalizeBounds(entry.aocBounds2154 || entry.bounds2154 || entry.bounds), distance: distanceToBounds(center.easting, center.northing, entry.aocBounds2154 || entry.bounds2154 || entry.bounds) })).filter(item => item.bounds && boundsIntersects(item.bounds, queryBounds));
    const focus = focusId ? this.entry(focusId) : null;
    if (focus && !candidates.some(item => item.entry.id === focus.id)) candidates.push({ entry: focus, bounds: normalizeBounds(focus.aocBounds2154 || focus.bounds2154 || focus.bounds), distance: distanceToBounds(center.easting, center.northing, focus.aocBounds2154 || focus.bounds2154 || focus.bounds) });
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates.slice(0, this.maxLoadedScenes);
  }
  // Ids of the villages nearest a view's centre that a fresh assembly would include.
  nearestIds(view, count = 6) { return this.chooseCandidates(view).slice(0, count).map(item => item.entry.id); }
  async compose(view, { focusId = null, signal } = {}) {
    const generation = ++this.generation;
    const bounds = viewportBounds(this.coveredView(view));
    if (!bounds) return null;
    const chosen = this.chooseCandidates(view, focusId);
    this.active.clear();
    const loaded = await Promise.allSettled(chosen.map(item => this.ensure(item.entry, signal)));
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    if (generation !== this.generation) return null;
    const sources = loaded.filter(result => result.status === 'fulfilled' && result.value?.scene).map(result => result.value);
    const contextSources = this.backgroundSources.filter(source => boundsIntersects(sceneBounds(source, source), bounds));
    return { scene: buildMosaicScene({ bounds, sources, backgroundSources: contextSources, gridSize: this.gridSize, textureManifest: this.textureManifest, textureBase: this.textureBase, focusId, preferAvif: this.preferAvif, detailTiles: this.detailTiles }), sources, bounds };
  }
}

export default SceneMosaic;
