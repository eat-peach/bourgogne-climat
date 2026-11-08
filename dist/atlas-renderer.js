import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { regionClass } from './region.js';
import { classAccumulation, flowLength, LAND_COVER, landRunoffMm, rainRunoff, stormRunoffMm, wetnessFields } from './simulation.js';

export const WORLD_ORIGIN_EPSG = Object.freeze({ easting: 850000, northing: 6650000 });
export const WORLD_SCALE = 0.035;
export const WORLD_DATUM_ELEVATION = 0;
export const CADASTRE_NEIGHBOR_RADIUS_METRES = 2200;
export const CADASTRE_MAX_VIEW_RADIUS_METRES = 2200;
const HAZE_SIDE = .6, HAZE_START = .5; // radians either side of the view checked for the mesh edge; haze starts at this share of the way there
const PALETTE = { climats: 0x7b2431, parcels: 0xd6af6e, forest: 0x566553, roads: 0xe1d4c2, buildings: 0xa84b45, water: 0x6d9fb0 };
const CLASS_PALETTE = { 'Grand Cru': 0xe3b23c, 'Premier Cru': 0x4d8fd6, Village: 0x7b4051, Regional: 0x5f8668, 'grand-cru': 0xe3b23c, 'premier-cru': 0x4d8fd6, grand_cru: 0xe3b23c, premier_cru: 0x4d8fd6, village: 0x7b4051, regional: 0x5f8668, unclassified: 0x8a8277, unknown: 0x8a8277 };
const CLASS_CSS = { 'Grand Cru': '#e3b23c', 'Premier Cru': '#4d8fd6', Village: '#7b4051', Regional: '#5f8668', 'grand-cru': '#e3b23c', 'premier-cru': '#4d8fd6', village: '#7b4051', regional: '#5f8668', unclassified: '#8a8277', unknown: '#8a8277' };
const LAYERS = ['climats', 'parcels', 'cadastre', 'buildings', 'roads', 'forest', 'water'];
const EXAGGERATIONS = [1, 2, 3, 4];
const MAX_RASTER_SIZE = 2048;
// Decoded photo tiles kept for reuse. Phones get a smaller cache: 48 tiles are ~135 MB of decoded images, and on an
// iPhone that, with the 3D scene, can exhaust memory and leave the ground drawn black.
const SMALL_DEVICE = typeof window !== 'undefined' && (window.matchMedia?.('(max-width: 760px), (pointer: coarse) and (max-width: 1100px)')?.matches || /iPhone|iPad|Android/i.test(navigator.userAgent || ''));
const IMAGE_CACHE_LIMIT = SMALL_DEVICE ? 14 : 48;
// Aerial photos look flat under the map's bright, neutral lights, so their colours are strengthened in the terrain shader.
// Viewers can change brightness, lightness and saturation in Display settings, relative to the default look below.
export const DISPLAY_DEFAULTS = Object.freeze({ brightness: 1, lightness: 0, saturation: 1.7 });
export const DISPLAY_LIMITS = Object.freeze({ brightness: [.5, 1.5], lightness: [-.5, .5], saturation: [0, 3] });
// The default look: lights at 85% of full strength and photo tones slightly deepened, shown to viewers as 100% and 0.
const LIGHT_INTENSITY = 1.8 * .85;
const BASE_GAMMA = 2 ** .2;
// Sun & rain: sunlight colours by height above the horizon, and the runoff network drawn in three widths by the area
// that drains through each cell.
const SUN_LOW = new THREE.Color(0xffa45c), SUN_HIGH = new THREE.Color(0xfff3e0), SKY_NIGHT = new THREE.Color(0x7d90bb), WHITE = new THREE.Color(0xffffff);
const BACKGROUND_DAY = new THREE.Color(0xd9d0c3), BACKGROUND_NIGHT = new THREE.Color(0x3a4150);
// Flowing water after a storm. Each channel's peak flow is estimated as the water that drains through it during the
// storm, spread over the storm's length plus the time water takes to arrive from the farthest point upslope (m³/s).
// A channel shows from WATER_MIN_PEAK; its width is WATER_WIDTH × √(peak flow) metres (drawn several times wider
// than real so it can be seen), never under WATER_MIN_PX pixels. Glints drift downhill at WATER_SPEED metres per
// second (sped up for the eye, not to scale).
const WATER_COLOUR = 0x2f86e8, WATER_HIGHLIGHT = 0xe2f4ff, WATER_MIN_PEAK = .25, WATER_WIDTH = 9, WATER_MIN_PX = 1.3, WATER_SPEED = 160, WATER_SPACING = 220, WATER_MAX_RAIN_MM = 150;
const BACKGROUND_RAIN = new THREE.Color(0xaeb1b2), LIGHT_RAIN = new THREE.Color(0xe3e8ee);
// Falling rain: thin streaks in a box that follows the view; more of them show the harder it rains.
const RAIN_STREAKS = 6000, RAIN_FALL_SECONDS = 1.1;
const RAIN_VERTEX_SHADER = `
  attribute vec4 seed;
  attribute float tip;
  uniform vec3 centre;
  uniform vec3 extent;
  uniform float time;
  uniform float density;
  uniform float viewDistance;
  varying float vFade;
  void main() {
    if (seed.w > density) { gl_Position = vec4(2., 2., 2., 1.); vFade = 0.; return; }
    float h = fract(seed.y - time / ${RAIN_FALL_SECONDS.toFixed(2)});
    vec3 p = centre + vec3(seed.x * extent.x, (h - .25) * extent.y, seed.z * extent.z);
    p += tip * extent.y * vec3(.008, .028, .004);
    vec4 view = viewMatrix * vec4(p, 1.);
    // Streaks fade out close to the camera, so the rain never curtains the map in front of you.
    float near = smoothstep(viewDistance * .45, viewDistance * .85, -view.z);
    vFade = smoothstep(0., .15, h) * (1. - smoothstep(.75, 1., h)) * (.35 + .65 * tip) * near;
    gl_Position = projectionMatrix * view;
  }
`;
const RAIN_FRAGMENT_SHADER = `
  uniform float opacity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(.86, .91, .97, opacity * vFade);
    #include <colorspace_fragment>
  }
`;
const WATER_VERTEX_SHADER = `
  attribute vec3 next;
  attribute float side;
  attribute float across;
  attribute float along;
  attribute vec4 areaA;
  attribute vec2 areaB;
  attribute float tc;
  attribute float steep;
  attribute float arrive;
  uniform vec2 resolution;
  uniform vec4 qA;
  uniform vec2 qB;
  uniform float duration;
  uniform float front;
  uniform float bank;
  varying float viewDepth;
  varying float vAlong;
  varying float vStrength;
  varying float vSide;
  varying float vSteep;
  void main() {
    // areaA/areaB: cubic metres per millimetre of runoff from each ground type draining through here; qA/qB: millimetres
    // each ground type sheds in this storm. Their product is the water passing during the storm.
    float volume = dot(areaA, qA) + dot(areaB, qB), peak = volume / (duration + tc);
    vAlong = along; vSide = across; vSteep = steep; vStrength = 0.; viewDepth = 0.;
    if (peak < ${WATER_MIN_PEAK.toFixed(2)} || arrive > front + .001) { gl_Position = vec4(2., 2., 2., 1.); return; }
    vStrength = clamp(log(peak / ${WATER_MIN_PEAK.toFixed(2)}) / log(10.) / 2., 0., 1.);
    viewDepth = -(modelViewMatrix * vec4(position, 1.0)).z;
    vec4 current = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 following = projectionMatrix * modelViewMatrix * vec4(next, 1.0);
    vec2 a = current.xy / max(current.w, 0.00001);
    vec2 b = following.xy / max(following.w, 0.00001);
    vec2 delta = (b - a) * resolution;
    float deltaLength = length(delta);
    vec2 direction = deltaLength > 0.00001 ? delta / deltaLength : vec2(1.0, 0.0);
    vec2 normal = vec2(-direction.y, direction.x);
    // Width in metres turned into pixels at this distance; the damp bank under the stream is wider still.
    float metres = clamp(${WATER_WIDTH.toFixed(1)} * sqrt(peak), 1., 40.);
    float px = max(metres * ${WORLD_SCALE} * projectionMatrix[1][1] * resolution.y * .5 / max(current.w, 1e-5), ${WATER_MIN_PX.toFixed(1)});
    if (bank > .5) px = px * 2.2 + 7.;
    current.xy += normal * side * px / max(resolution, vec2(1.0)) * current.w;
    gl_Position = current;
  }
`;
const WATER_FRAGMENT_SHADER = `
  uniform vec3 color;
  uniform vec3 highlight;
  uniform float opacity;
  uniform float time;
  uniform float bank;
  uniform float hazeNear;
  uniform float hazeFar;
  uniform vec3 hazeColor;
  varying float viewDepth;
  varying float vAlong;
  varying float vStrength;
  varying float vSide;
  varying float vSteep;
  float waterHash(float i) { return fract(sin(i * 91.345) * 47453.2); }
  float waterNoise(float x) { float i = floor(x), f = fract(x); return mix(waterHash(i), waterHash(i + 1.), f * f * (3. - 2. * f)); }
  void main() {
    float body = 1. - vSide * vSide, fog = smoothstep(hazeNear, hazeFar, viewDepth);
    if (bank > .5) {
      // Damp ground along the stream: a soft darkening that fades out to the sides.
      gl_FragColor = vec4(mix(vec3(.02, .025, .03), hazeColor, fog), .34 * body * body * (.45 + .55 * vStrength));
      #include <colorspace_fragment>
      return;
    }
    // Light catching the moving water: two layers of smooth 1-D noise slide downstream along the channel, so glints
    // come and go irregularly, brightest along the middle of the stream.
    float x = (vAlong - time * ${WATER_SPEED.toFixed(1)}) / 70.;
    float n = waterNoise(x) * .6 + waterNoise(x * 2.3 + 7.1) * .4;
    float glint = smoothstep(.5, .85, n) * body * body;
    vec3 c = mix(color, highlight, glint * (.25 + .45 * vStrength) + .12 * body);
    // White water where the stream runs down steep ground: short, fast-moving flecks of foam.
    float fx = (vAlong - time * ${(WATER_SPEED * 1.6).toFixed(1)}) / 16.;
    float white = smoothstep(.06, .16, vSteep) * (.45 + .55 * vStrength) * smoothstep(.42, .8, waterNoise(fx) * .5 + waterNoise(fx * 2.7 + 3.1) * .5) * body;
    c = mix(c, vec3(.93, .97, 1.), white * .8);
    float a = opacity * (.32 + .6 * vStrength + .15 * glint + .25 * white) * smoothstep(0., .55, body);
    gl_FragColor = vec4(mix(c, hazeColor, fog), clamp(a, 0., 1.));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const blankRainTexture = () => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; };
const photoUniforms = { photoSaturation: { value: DISPLAY_DEFAULTS.saturation }, photoGamma: { value: BASE_GAMMA }, sunShade: { value: 0 },
  // Rain on the ground (see rebuildRunoff): rainOn switches it on; soak, film and pond run 0–1 with the storm; front is how
  // far down the slopes the water has travelled (0–1 of the longest travel time); the textures hold the per-cell fields.
  rainOn: { value: 0 }, rainTime: { value: 0 }, rainSoak: { value: 0 }, rainFilm: { value: 0 }, rainPond: { value: 0 }, rainFront: { value: 1 }, rainGrid: { value: 1 }, rainArrivalScale: { value: 1 }, rainTexA: { value: blankRainTexture() }, rainTexB: { value: blankRainTexture() } };
// With Sun & rain sunlight on, ground the sun reaches is warmed and ground in shade is cooled and darkened, judged from
// how much of its light comes straight from the sun, and a thin line marks the border between the two.
function saturatePhotoTexture(shader) { Object.assign(shader.uniforms, photoUniforms);
  shader.vertexShader = `attribute vec2 gridUv;
varying vec2 vGridUv;
varying vec2 vRainPos;
` + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  vGridUv = gridUv; vRainPos = position.xz;`);
  shader.fragmentShader = `uniform float photoSaturation;
uniform float photoGamma;
uniform float sunShade;
uniform float rainOn;
uniform float rainTime;
uniform float rainSoak;
uniform float rainFilm;
uniform float rainPond;
uniform float rainFront;
uniform float rainGrid;
uniform float rainArrivalScale;
uniform sampler2D rainTexA;
uniform sampler2D rainTexB;
varying vec2 vGridUv;
varying vec2 vRainPos;
float rainHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rainNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(rainHash(i), rainHash(i + vec2(1., 0.)), f.x), mix(rainHash(i + vec2(0., 1.)), rainHash(i + vec2(1., 1.)), f.x), f.y); }
` + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  diffuseColor.rgb = pow(max(mix(vec3(dot(diffuseColor.rgb, vec3(.2126, .7152, .0722))), diffuseColor.rgb, photoSaturation), 0.), vec3(photoGamma));
#endif`).replace('#include <opaque_fragment>', `if (rainOn > 0.) {
    vec2 rainUv = vec2(vGridUv.x, 1. - vGridUv.y);
    vec4 fieldA = texture2D(rainTexA, rainUv), fieldB = texture2D(rainTexB, rainUv);
    if (fieldB.a > .5) {
      vec2 downhill = fieldA.rg * 2. - 1.; float dl = length(downhill); downhill = dl > .01 ? downhill / dl : vec2(0., 1.);
      float slopeN = fieldA.b, pondN = fieldA.a, wet = fieldB.r, arrive = fieldB.g * 255. * 60. / rainArrivalScale, gathered = fieldB.b;
      float lum = dot(outgoingLight, vec3(.2126, .7152, .0722));
      // Wet ground: darker and a little richer in colour, most in valley bottoms where the soil saturates first.
      float soak = rainSoak * (.35 + .65 * wet);
      outgoingLight = max(mix(vec3(lum), outgoingLight, 1. + .3 * soak), 0.) * (1. - .32 * soak);
      // A thin film of water sliding downhill: two layers of stretched noise drift along the slope direction and
      // cross-fade, so the pattern keeps moving without ever stretching out. It only starts once water has reached the spot.
      float reached = smoothstep(arrive - .04, arrive + .01, rainFront);
      float film = rainFilm * reached * smoothstep(.04, .25, slopeN) * (.45 + .55 * gathered);
      if (film > .001) {
        // Ripples about 30 m across and 100 m long (one world unit is about 29 m); they fade out when zoomed so far
        // out that they would shrink below a few pixels and sparkle.
        vec2 across = vec2(-downhill.y, downhill.x), q = vec2(dot(vRainPos, across) * .95, dot(vRainPos, downhill) * .3);
        float run = 1. + 2.5 * slopeN, ph0 = fract(rainTime * .3), ph1 = fract(rainTime * .3 + .5), w0 = 1. - abs(1. - 2. * ph0);
        float wave = rainNoise(q - vec2(0., ph0 * run * 1.5)) * w0 + rainNoise(q + vec2(5.2, 1.3) - vec2(0., ph1 * run * 1.5)) * (1. - w0);
        float detail = 1. - smoothstep(.12, .35, fwidth(q.x));
        outgoingLight = mix(outgoingLight, outgoingLight * vec3(.76, .85, .98) + vec3(.02, .04, .07), film * .6);
        outgoingLight += vec3(.5, .66, .82) * smoothstep(.5, .9, wave) * film * .4 * detail;
      }
      // Pools: hollows, and flat wet ground, fill from their deepest part as more water runs off.
      float pool = max(pondN, (1. - smoothstep(.005, .03, slopeN)) * smoothstep(.75, 1., wet) * .4), level = 1. - rainPond;
      float cover = smoothstep(level - .04, level + .02, pool) * smoothstep(arrive - .05, arrive, rainFront) * step(.001, rainPond);
      if (cover > 0.) {
        // Muddy, sky-tinted water (colours are linear: about #36505c to #5f7787 on screen), a little see-through at the edges, with slow rain ripples.
        float ripple = rainNoise(vRainPos * 2.5 + vec2(rainTime * .5, -rainTime * .35)) * .6 + rainNoise(vRainPos * 5. - rainTime * .7) * .4;
        vec3 water = mix(vec3(.035, .065, .1), vec3(.12, .19, .25), ripple * (1. - smoothstep(.15, .5, fwidth(vRainPos.x * 5.))));
        outgoingLight = mix(outgoingLight, water, cover * (.55 + .3 * smoothstep(level, level + .2, pool)));
      }
    }
  }
  if (sunShade > 0.) {
    float direct = dot(reflectedLight.directDiffuse, vec3(.2126, .7152, .0722)), sky = dot(reflectedLight.indirectDiffuse, vec3(.2126, .7152, .0722));
    float ratio = direct / (direct + sky + 1e-4), lit = smoothstep(.34, .46, ratio);
    outgoingLight = mix(outgoingLight, outgoingLight * mix(vec3(.46, .54, .82), vec3(1.24, 1.1, .9), lit), sunShade);
    // A thin dark line along the edge between sun and shade, about 1.5 pixels wide whatever the zoom.
    float edge = 1. - smoothstep(.0, 1.5 * fwidth(ratio) + 1e-4, abs(ratio - .4));
    outgoingLight = mix(outgoingLight, vec3(.12, .1, .14), .75 * edge * sunShade);
  }
  #include <opaque_fragment>`); }
export function clampDisplay(settings = {}) { const out = {}; for (const [key, [min, max]] of Object.entries(DISPLAY_LIMITS)) { const value = Number(settings[key]); out[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DISPLAY_DEFAULTS[key]; } return out; }
const SCREEN_LINE_VERTEX_SHADER = `
  attribute vec3 next;
  attribute float side;
  uniform vec2 resolution;
  uniform float linewidth;
  varying float viewDepth;
  void main() {
    viewDepth = -(modelViewMatrix * vec4(position, 1.0)).z;
    vec4 current = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 following = projectionMatrix * modelViewMatrix * vec4(next, 1.0);
    vec2 a = current.xy / max(current.w, 0.00001);
    vec2 b = following.xy / max(following.w, 0.00001);
    vec2 delta = (b - a) * resolution;
    float deltaLength = length(delta);
    vec2 direction = deltaLength > 0.00001 ? delta / deltaLength : vec2(1.0, 0.0);
    vec2 normal = vec2(-direction.y, direction.x);
    vec2 offset = normal * side * linewidth / max(resolution, vec2(1.0));
    current.xy += offset * current.w;
    gl_Position = current;
  }
`;
const SCREEN_LINE_FRAGMENT_SHADER = `
  uniform vec3 color;
  uniform float opacity;
  uniform float hazeNear;
  uniform float hazeFar;
  uniform vec3 hazeColor;
  varying float viewDepth;
  void main() {
    // Lines fade with the land (same as THREE.Fog), or they would float over the haze.
    gl_FragColor = vec4(mix(color, hazeColor, smoothstep(hazeNear, hazeFar, viewDepth)), opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const props = feature => feature?.properties || feature || {};
const isPair = value => Array.isArray(value) && value.length >= 2 && !Array.isArray(value[0]);
function partsOf(feature) { const g = feature?.geometry || feature; const source = g?.type === 'Polygon' || g?.type === 'MultiPolygon' ? g.coordinates : (g?.rings || g?.coordinates || g?.ring || g); const out = []; const visit = value => { if (!Array.isArray(value) || !value.length) return; if (isPair(value[0])) { out.push({ ring: value }); return; } if (Array.isArray(value[0]) && isPair(value[0][0])) { out.push({ ring: value[0], holes: value.slice(1) }); return; } value.forEach(visit); }; visit(source); return out; }
const SIMPLIFY_CACHE = new WeakMap(), SIMPLIFY_METRES = 1.5;
function simplifiedRing(ring) {
  if (!Array.isArray(ring) || ring.length < 5) return ring;
  const hit = SIMPLIFY_CACHE.get(ring); if (hit) return hit;
  const keep = new Uint8Array(ring.length); keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), ax = +ring[a][0], ay = +ring[a][1], dx = +ring[b][0] - ax, dy = +ring[b][1] - ay, L = Math.hypot(dx, dy);
    let far = -1, best = SIMPLIFY_METRES;
    for (let i = a + 1; i < b; i++) { const px = +ring[i][0] - ax, py = +ring[i][1] - ay, d = L > 1e-9 ? Math.abs(px * dy - py * dx) / L : Math.hypot(px, py); if (d > best) { best = d; far = i; } }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  SIMPLIFY_CACHE.set(ring, out); return out;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function normalizeClass(value) { return String(value || 'unclassified').trim().toLowerCase().replace(/[_\s]+/g, '-'); }
function className(feature) { return props(feature).classification || props(feature).appellation || props(feature).category || 'unclassified'; }
function classKey(value) { const n = normalizeClass(value); return n === 'grand-cru' ? 'grand-cru' : n === 'premier-cru' ? 'premier-cru' : n === 'village' ? 'village' : n === 'regional' ? 'regional' : regionClass(n) ? n : 'unclassified'; }
// Display rank (higher draws on top) and colour; a region page's own classes (region.js) extend the Burgundy tiers.
const TIER_RANK = { unclassified: 0, regional: 1, village: 2, 'premier-cru': 3, 'grand-cru': 4 };
function classRank(key) { return TIER_RANK[key] ?? regionClass(key)?.rank ?? 0; }
function classCss(value) { const key = classKey(value); return regionClass(key)?.colour || CLASS_CSS[value] || CLASS_CSS[key] || CLASS_CSS.unclassified; }
function classColor(value) { const custom = regionClass(classKey(value))?.colour; return new THREE.Color(custom ?? CLASS_PALETTE[value] ?? CLASS_PALETTE[normalizeClass(value)] ?? CLASS_PALETTE.unclassified); }
function featureProperties(feature) { return props(feature); }
function featureFactsProvenance(feature) {
  const p = featureProperties(feature), nested = p.facts || p.rawPropertyFacts || p.raw_property_facts || p.rawProperties?.facts || p.raw?.facts || {};
  const factsKey = p.factsKey ?? nested.factsKey ?? nested.key;
  const factsVillageId = p.factsVillageId ?? p.facts_village_id ?? nested.factsVillageId ?? nested.villageId ?? nested.village_id;
  return { ...(factsKey != null && String(factsKey).trim() ? { factsKey: String(factsKey) } : {}), ...(factsVillageId != null && String(factsVillageId).trim() ? { factsVillageId: String(factsVillageId) } : {}) };
}
function geometrySignature(feature) {
  let hash = 2166136261, count = 0;
  for (const part of partsOf(feature)) for (const ring of [part.ring, ...(part.holes || [])]) for (const point of ring) {
    const value = `${Math.round(Number(point[0]) * 100)},${Math.round(Number(point[1]) * 100)};`;
    for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    count += 1;
  }
  return count ? `${count}-${(hash >>> 0).toString(36)}` : 'anonymous';
}
const FEATURE_IDENTITY_CACHE = new WeakMap();
function featureIdentity(feature, key = 'feature') {
  if (feature && (typeof feature === 'object' || typeof feature === 'function')) {
    let byKey = FEATURE_IDENTITY_CACHE.get(feature);
    if (!byKey) { byKey = new Map(); FEATURE_IDENTITY_CACHE.set(feature, byKey); }
    if (byKey.has(key)) return byKey.get(key);
    const identity = featureIdentityUncached(feature, key);
    byKey.set(key, identity);
    return identity;
  }
  return featureIdentityUncached(feature, key);
}
function featureIdentityUncached(feature, key = 'feature') {
  const p = featureProperties(feature), explicit = p.factsKey ?? p.featureKey ?? p.sourceKey ?? p.importKey ?? p.id ?? p.gid ?? p.fid ?? p.parcelId ?? p.parcel_id ?? p.climatId ?? p.climat_id ?? p.code ?? p.name ?? p.nom;
  return `${key}:${explicit != null && String(explicit).trim() ? String(explicit).trim() : 'anonymous'}:${geometrySignature(feature)}`;
}

// --- Map labels -------------------------------------------------------------
// Grand and premier crus come from the INAO AOC layer; lieux-dits from the DGFiP cadastre (Etalab).
// Labels are ranked by tier, then by size, and placed greedily so the most important
// visible names win when labels would overlap.
// Tier 2 is a lieu-dit inside an AOC area (a vineyard name); tier 3 lies outside, in woods, fields or the village.
const LABEL_TIERS = { 'grand-cru': 0, 'premier-cru': 1, 'lieu-dit': 2, 'lieu-dit-outside': 3 };
const LABEL_LIMIT = 220;
// View radius (metres) up to which each tier is shown: crus always, vineyard lieux-dits at mid zoom, the rest close in.
const LABEL_TIER_MAX_RADIUS = [Infinity, Infinity, 9000, 4500];
// Every label may nudge a little; labels of vineyards larger than this (m²) may slide further inside their area.
const LABEL_SHIFTABLE_AREA = 50000;
// Label steadiness while the map moves: how long a label keeps a new state, and the overlap tolerance either way.
const LABEL_DWELL_MS = 320, LABEL_HYSTERESIS_PX = 3;
const LABEL_PARTICLES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'ou', 'en', 'au', 'aux', 'sur', 'sous', 'lès', 'à']);
function labelName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text !== text.toLocaleUpperCase('fr')) return text;
  // Source names in capitals read as shouting next to the mixed-case crus: "AUX COMMUNES" becomes "Aux Communes".
  return text.toLocaleLowerCase('fr').split(' ').map((word, i) => { if (i && LABEL_PARTICLES.has(word)) return word; const cased = word.replace(/(^|[-'\u2019])(\p{L})/gu, (m, sep, letter) => sep + letter.toLocaleUpperCase('fr')); return i && /^[ld]['\u2019]/i.test(cased) ? cased[0].toLowerCase() + cased.slice(1) : cased; }).join(' ');
}
function foldLabel(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function ringArea(ring) { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (Number(ring[j][0]) + Number(ring[i][0])) * (Number(ring[j][1]) - Number(ring[i][1])); return Math.abs(a / 2); }
function insideRing(x, y, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = Number(ring[i][0]), yi = Number(ring[i][1]), xj = Number(ring[j][0]), yj = Number(ring[j][1]); if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside; } return inside; }
function edgeDistance(x, y, ring) { let best = Infinity; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const ax = Number(ring[j][0]), ay = Number(ring[j][1]), bx = Number(ring[i][0]), by = Number(ring[i][1]), dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / ((dx * dx + dy * dy) || 1))); best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy)); } return best; }
// A point well inside the largest part: the vertex average of a curved vineyard often falls outside it.
// Finding a label spot inside a shape is slow and the same vineyards come back every time the map re-assembles, so
// anchors are remembered by a cheap fingerprint of the geometry (part count, first ring's length and three of its points).
const LABEL_ANCHOR_CACHE = new Map();
function labelAnchor(feature) {
  const parts = partsOf(feature), ring = parts[0]?.ring, key = ring ? `${parts.length}|${ring.length}|${ring[0]}|${ring[ring.length >> 1]}|${ring[ring.length - 1]}|${(parts[0].holes || []).length}` : null;
  if (key && LABEL_ANCHOR_CACHE.has(key)) return LABEL_ANCHOR_CACHE.get(key);
  const anchor = computeLabelAnchor(feature);
  if (key) { if (LABEL_ANCHOR_CACHE.size > 20000) LABEL_ANCHOR_CACHE.clear(); LABEL_ANCHOR_CACHE.set(key, anchor); }
  return anchor;
}
function computeLabelAnchor(feature) {
  const p = props(feature);
  if (Array.isArray(p.labelPosition) && p.labelPosition.length >= 2) return { point: p.labelPosition.map(Number), area: Number(p.legalAreaM2 || p.mappedAreaM2) || 0 };
  let best = null;
  for (const part of partsOf(feature)) { if (part.ring.length < 3) continue; const area = ringArea(part.ring) - (part.holes || []).reduce((sum, hole) => sum + ringArea(hole), 0); if (!best || area > best.area) best = { ...part, area }; }
  if (!best) return null;
  const xs = best.ring.map(v => Number(v[0])), ys = best.ring.map(v => Number(v[1])), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let point = null, clearance = -1;
  for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
    const x = x0 + (x1 - x0) * i / 10, y = y0 + (y1 - y0) * j / 10;
    if (!insideRing(x, y, best.ring) || (best.holes || []).some(hole => insideRing(x, y, hole))) continue;
    const d = Math.min(edgeDistance(x, y, best.ring), ...(best.holes || []).map(hole => edgeDistance(x, y, hole)));
    if (d > clearance) { clearance = d; point = [x, y]; }
  }
  return { point: point || [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length], area: best.area };
}
const RING_BOXES = new WeakMap(), IN_AOC_CACHE = new Set();
function ringBox(ring) { let box = RING_BOXES.get(ring); if (box) return box; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const v of ring) { const x = +v[0], y = +v[1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } box = [x0, y0, x1, y1]; RING_BOXES.set(ring, box); return box; }
export function labelCandidates(scene) {
  const out = [];
  // Bounding boxes are worked out once per ring (with a loop: spreading big rings into Math.min was slow), and a point
  // found inside an AOC area is remembered, since the same labels come back every time the map re-assembles.
  const aocParts = (scene?.parcels || []).flatMap(feature => partsOf(feature).filter(part => part.ring.length > 2).map(part => ({ ...part, box: ringBox(part.ring) })));
  const inAoc = point => { const key = `${point[0]},${point[1]}`; if (IN_AOC_CACHE.has(key)) return true; const [x, y] = point, inside = aocParts.some(part => x >= part.box[0] && x <= part.box[2] && y >= part.box[1] && y <= part.box[3] && insideRing(x, y, part.ring) && !(part.holes || []).some(hole => insideRing(x, y, hole))); if (inside) { if (IN_AOC_CACHE.size > 50000) IN_AOC_CACHE.clear(); IN_AOC_CACHE.add(key); } return inside; };
  const consider = (feature, layer, tier, name, radius = 1200) => {
    const text = labelName(name); if (!text) return;
    const anchor = labelAnchor(feature); if (!anchor) return;
    const fold = foldLabel(text);
    // The same cru often appears as both an AOC area and a lieu-dit; keep the better-classified one nearby.
    const twin = out.find(item => item.fold === fold && Math.hypot(item.point[0] - anchor.point[0], item.point[1] - anchor.point[1]) < radius);
    if (twin) { if (twin.tier <= tier) return; out.splice(out.indexOf(twin), 1); }
    out.push({ feature, layer, tier, text, fold, point: anchor.point, area: anchor.area });
  };
  for (const feature of scene?.parcels || []) {
    const key = normalizeClass(className(feature)), p = props(feature), tier = LABEL_TIERS[key] ?? (regionClass(key)?.rank >= 3 ? LABEL_TIERS['grand-cru'] : undefined);
    if (tier == null || tier > 1) continue;
    let name = String(p.name || p.officialDenomination || '').trim();
    if (/\bpremier cru\b/i.test(name)) name = name.replace(/^.*?\bpremier cru\b\s*/i, ''); // "Vosne-Romanée premier cru Les Suchots" -> "Les Suchots"
    // A region appellation (Côte Rôtie, Saint-Joseph...) spans many communes: label it once per 4 km, not once per commune piece.
    if (name) consider(feature, 'parcels', tier, name, regionClass(key) ? 4000 : 1200);
  }
  for (const feature of scene?.labels || scene?.climats || scene?.appellations || []) { const p = props(feature), anchor = labelAnchor(feature); if (anchor) consider(feature, 'climats', inAoc(anchor.point) ? LABEL_TIERS['lieu-dit'] : LABEL_TIERS['lieu-dit-outside'], p.displayName || p.name || p.nom); }
  return out.sort((a, b) => a.tier - b.tier || (a.tier === 0 ? a.area - b.area : b.area - a.area)).slice(0, LABEL_LIMIT);
}

export class AtlasRenderer {
  constructor({ canvas, container = canvas?.parentElement, labels = null, onSelect = () => {}, onError = () => {}, onViewChange = () => {}, labelObstacles = () => [], progressiveBuild = false } = {}) {
    this.progressiveBuild = Boolean(progressiveBuild) && typeof requestAnimationFrame === 'function';
    this.labelObstacles = labelObstacles;
    // Labels are clickable, but scrolling over one should still zoom the map underneath.
    labels?.addEventListener('wheel', event => { event.preventDefault(); canvas.dispatchEvent(new WheelEvent('wheel', event)); }, { passive: false });
    if (!canvas) throw new Error('AtlasRenderer requires a canvas');
    this.canvas = canvas; this.container = container || canvas.parentElement || document.body; this.labels = labels; this.onSelect = onSelect; this.onError = onError; this.onViewChange = onViewChange;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0xd9d0c3); this.scene.fog = new THREE.Fog(0xd9d0c3, 1, 2); this.hazeUniforms = { hazeNear: { value: 1 }, hazeFar: { value: 2 }, hazeColor: { value: this.scene.fog.color } }; this.camera = new THREE.PerspectiveCamera(42, 1, .1, 1000);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, stencil: true, powerPreference: 'high-performance' }); this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.shadowMap.enabled = false; if (this.renderer.debug) this.renderer.debug.checkShaderErrors = /[?&]debug\b/.test(globalThis.location?.search || ''); this._retiredMaterials = [];
    this.controls = new OrbitControls(this.camera, canvas); this.controls.enableDamping = true; this.controls.zoomToCursor = true; /* the wheel zooms toward the point under the cursor, as in web maps */ this.controls.minDistance = 3; this.controls.maxDistance = 900; this.controls.maxPolarAngle = Math.PI / 2.02; this.controls.minAzimuthAngle = -Infinity; this.controls.maxAzimuthAngle = Infinity; this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE; this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY; this.controls.touches.ONE = THREE.TOUCH.ROTATE; this.controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    this.world = new THREE.Group(); this.scene.add(this.world); this.layers = {}; this.featureIndex = []; this.sceneJSON = null; this.indexVillage = null; this.cadastralParcels = []; this.cadastralMeta = {}; this._cadastreEnabled = true; this.exaggeration = 3; this.mode = 'aerial'; this.interaction = 'rotate'; this.aocOpacity = .3; this.classificationVisibility = {}; this.pointerDown = null; this.selectedFeature = null; this.selectionOverlay = null; this.disposed = false; this.pendingViewChange = false; this._viewTimer = 0; this._renderFrame = 0; this._panAnimation = null; this._panViewDirty = false; this.imageCache = new Map();
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2(); this.light = new THREE.HemisphereLight(0xffffff, 0xb4afa6, LIGHT_INTENSITY); this.scene.add(this.light); this.sunLight = new THREE.DirectionalLight(0xffffff, 0); this.sunLight.castShadow = true; /* soft, blurred shadow edges: hard ones show the terrain's 65–110 m triangles as stair steps that jump as the sun moves */ this.renderer.shadowMap.type = THREE.VSMShadowMap; this.sunLight.shadow.mapSize.set(2048, 2048); this.sunLight.shadow.radius = 5; this.sunLight.shadow.blurSamples = 16; this.sunLight.shadow.bias = -.0004; this.scene.add(this.sunLight, this.sunLight.target); this.sunState = null; this.runoffState = null; this.rain = null;
    this._cadastreDeferralEnabled = true; this._cadastreLodTimer = 0; this._cadastreLodGeneration = 0; this._cadastrePendingBucket = null; this._cadastreCandidateSignature = null;
    this._onPointerDown = e => { if (e.button !== 0) return; this.cancelPanAnimation('pointer'); this.pointerDown = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }; }; this._onPointerUp = e => { const down = this.pointerDown; this.pointerDown = null; if (e.button !== 0 || !down || (down.pointerId != null && e.pointerId != null && down.pointerId !== e.pointerId) || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; this.pick(e); }; this._onPointerCancel = () => { this.pointerDown = null; }; this._onDoubleClick = e => { e.preventDefault(); this.focusTerrain(e); }; this._onControlsStart = () => { this._controlsGestureActive = true; }; this._onControlsEnd = () => { this._controlsGestureActive = false; this.updateCadastreLOD(); }; this._onControlsChange = () => { this.updateCadastreLOD(); if (this._panAnimation) this._panViewDirty = true; else this.scheduleViewChange(); this.requestRender(); }; this.controls.addEventListener('start', this._onControlsStart); this.controls.addEventListener('end', this._onControlsEnd); this.controls.addEventListener('change', this._onControlsChange); this.installTouchGestures(canvas); canvas.addEventListener('pointerdown', this._onPointerDown); canvas.addEventListener('pointerup', this._onPointerUp); canvas.addEventListener('pointercancel', this._onPointerCancel); canvas.addEventListener('dblclick', this._onDoubleClick);
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null; this.resizeObserver?.observe(this.container); this.resize(); this.requestRender();
  }
  async setVillage(indexVillage, sceneJSON, { preserveView = true } = {}) { this.cancelPanAnimation('village'); const previous = preserveView ? this.captureView() : null; if (!preserveView) this.clearSelection(); try { const layerState = Object.fromEntries(Object.entries(this.layers).filter(([name]) => name !== 'cadastre').map(([name, group]) => [name, group.visible])); this.indexVillage = indexVillage || {}; this.sceneJSON = sceneJSON || {}; this.clear(); this.build(); for (const [name, visible] of Object.entries(layerState)) if (this.layers[name]) this.layers[name].visible = visible; if (this.layers.cadastre) this.layers.cadastre.visible = this._cadastreEnabled; if (this.aocMesh && this.layers.parcels) this.aocMesh.visible = this.layers.parcels.visible || Boolean(this.terroirTint || this.geologyLayer); this.restoreSelection(); if (previous && this.restoreView(previous)) this.scheduleViewChange(); else this.resetView(); } catch (error) { this.onError(error); throw error; } }
  setExaggeration(value) { const n = Number(value); const next = EXAGGERATIONS.includes(n) ? n : 1; if (next === this.exaggeration) return; this.cancelPanAnimation('exaggeration'); this.exaggeration = next; if (this.sceneJSON && this.terrain) this.updateVerticalGeometry(); }
  setInteraction(mode) { this.cancelPanAnimation('interaction'); const next = mode === 'pan' ? 'pan' : 'rotate'; this.interaction = next; this.controls.mouseButtons.LEFT = next === 'pan' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE; this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE; this.controls.touches.ONE = next === 'pan' ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE; this.requestRender(); }
  setMode(mode) { this.mode = mode === 'atlas' ? 'atlas' : 'aerial'; this.setMaterialMode(); this.requestRender(); }
  setLayer(name, visible) { const next = Boolean(visible); if (name === 'communes') { this._communesVisible = next; if (this._communeLines) this._communeLines.visible = next; this.requestRender(); return; } if (name === 'cadastre') this._cadastreEnabled = next; if (this.layers[name]) this.layers[name].visible = next; if (name === 'cadastre') this.updateCadastreLOD(true); if (name === 'parcels' && this.aocMesh) this.aocMesh.visible = next || Boolean(this.terroirTint || this.geologyLayer); if (name === 'cadastre' && !next && this.selectedFeature?.key === 'cadastre') this.clearSelection(); else if (name === this.selectedFeature?.key) this.updateSelectionOverlay(); this.requestRender(); }
  setCadastralParcels(features, meta = {}) { const seen = new Set(); this.cadastralParcels = (Array.isArray(features) ? features : []).filter(Boolean).filter(feature => { const p = props(feature), commune = p.communeCode ?? p.commune_code ?? p.codeCommune ?? '', id = p.id ?? p.parcelId ?? p.parcel_id ?? feature.id ?? ''; const key = commune && id ? `${commune}:${id}` : featureIdentity(feature, 'cadastre'); if (seen.has(key)) return false; seen.add(key); return true; }); this.cadastralMeta = { ...(meta || {}) }; if (this.layers.cadastre && this.sceneJSON) this.rebuildCadastreLayer(); this.requestRender(); }
  setClassification(name, visible) { const key = String(name), normalized = normalizeClass(key); this.classificationVisibility[key] = Boolean(visible); this.classificationVisibility[normalized] = Boolean(visible); if (normalized === 'regional') { this.classificationVisibility.unclassified = Boolean(visible); this.classificationVisibility.unknown = Boolean(visible); } if (this.sceneJSON) { this.updateParcelVisibility(); this.drawAocOverlay(); } if (this.selectedFeature?.key === 'parcels') this.updateSelectionOverlay(); this.requestRender(); }
  setAocOpacity(value) { this.aocOpacity = clamp(Number(value) || 0, 0, 1); if (this.aocMaterial) this.aocMaterial.opacity = this.aocOpacity; this.requestRender(); }
  captureView() { const t = this.controls.target; return { easting: WORLD_ORIGIN_EPSG.easting + t.x / WORLD_SCALE, northing: WORLD_ORIGIN_EPSG.northing - t.z / WORLD_SCALE, radiusMetres: this.camera.position.distanceTo(t) / WORLD_SCALE, direction: this.camera.position.clone().sub(t).normalize().toArray(), up: this.camera.up.toArray(), screenSpacePanning: this.controls.screenSpacePanning }; }
  getView() { return this.captureView(); }
  isPanAnimating() { return Boolean(this._panAnimation); }
  _now() { return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now(); }
  _prefersReducedMotion() { try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; } catch { return false; } }
  _applyPanState(target, position) { this.controls.target.copy(target); this.camera.position.copy(position); this.controls.update(); }
  _advancePanAnimation(now = this._now()) {
    const animation = this._panAnimation;
    if (!animation) return false;
    now = Math.max(Number(now), animation.lastTime || animation.start);
    animation.lastTime = now;
    const elapsed = Math.max(0, now - animation.start);
    const raw = animation.duration > 0 ? clamp(elapsed / animation.duration, 0, 1) : 1;
    const eased = raw < .5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
    const target = animation.fromTarget.clone().lerp(animation.toTarget, eased);
    const position = animation.fromPosition.clone().lerp(animation.toPosition, eased);
    this._applyPanState(target, position);
    if (raw < 1) return true;
    this._panAnimation = null;
    if (animation.queued) {
      this.panByDirection(animation.queued.direction, animation.queued.fraction);
      return true;
    }
    this._panViewDirty = false;
    this.scheduleViewChange();
    this.requestRender();
    return false;
  }
  cancelPanAnimation(reason = 'cancelled') {
    if (!this._panAnimation) return false;
    this._advancePanAnimation(this._now());
    this._panAnimation = null;
    this._panViewDirty = false;
    this.scheduleViewChange();
    this.requestRender();
    return true;
  }
  panByDirection(direction, fraction = .15) {
    const key = String(direction || '').trim().toLowerCase();
    const directions = { up: 'up', down: 'down', left: 'left', right: 'right', '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' };
    const resolved = directions[key];
    if (!resolved || !this.camera || !this.controls?.target) return false;
    const amountFraction = clamp(Number(fraction) || .15, .12, .18);
    if (this._panAnimation) this._advancePanAnimation(this._now());
    if (this._panAnimation?.direction === resolved) {
      this._panAnimation.queued ||= { direction: resolved, fraction: amountFraction };
      return true;
    }
    const target = this.controls.target;
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    right.y = 0; up.y = 0;
    if (right.lengthSq() < 1e-10 || up.lengthSq() < 1e-10) return false;
    right.normalize(); up.normalize();
    const axis = (resolved === 'left' || resolved === 'right') ? right : up;
    const sign = (resolved === 'left' || resolved === 'down') ? -1 : 1;
    const width = this.visibleGroundWidth(target.y);
    if (!(width > 0)) return false;
    const delta = axis.multiplyScalar(sign * width * amountFraction);
    const next = target.clone().add(delta);
    const nextGround = this.elevationAt?.(next.x, next.z);
    if (Number.isFinite(nextGround)) next.y = nextGround;
    else next.y = target.y;
    const translation = next.clone().sub(target);
    if (translation.lengthSq() < 1e-12) return false;
    const toPosition = this.camera.position.clone().add(translation);
    const duration = this._prefersReducedMotion() ? 70 : 420;
    if (typeof globalThis.requestAnimationFrame !== 'function' || duration === 0) {
      this._applyPanState(next, toPosition);
      this.scheduleViewChange();
      this.requestRender();
      return true;
    }
    clearTimeout(this._viewTimer);
    this.pendingViewChange = false;
    const start = this._now();
    this._panAnimation = { fromTarget: target.clone(), fromPosition: this.camera.position.clone(), toTarget: next, toPosition, start, lastTime: start, duration, direction: resolved, queued: null };
    this._panViewDirty = true;
    this.requestRender();
    return true;
  }
  visibleGroundWidth(groundY = this.controls?.target?.y || 0) {
    const projectGround = x => {
      const near = new THREE.Vector3(x, 0, -1).unproject(this.camera);
      const far = new THREE.Vector3(x, 0, 1).unproject(this.camera);
      const dy = far.y - near.y;
      if (Math.abs(dy) < 1e-8) return null;
      const t = (groundY - near.y) / dy;
      if (!Number.isFinite(t) || t < 0) return null;
      return near.add(far.sub(near).multiplyScalar(t));
    };
    const left = projectGround(-1), right = projectGround(1);
    if (left && right) {
      const width = Math.hypot(right.x - left.x, right.z - left.z);
      if (Number.isFinite(width) && width > 0) return width;
    }
    const distance = this.camera.position.distanceTo(this.controls.target);
    return distance * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * (this.camera.aspect || 1);
  }
  worldPoint(easting, northing) { return new THREE.Vector3((Number(easting) - WORLD_ORIGIN_EPSG.easting) * WORLD_SCALE, 0, -(Number(northing) - WORLD_ORIGIN_EPSG.northing) * WORLD_SCALE); }
  focusVillage() { this.resetView(); }
  rebuildPreservingState() { const view = this.captureView(); const layers = Object.fromEntries(Object.entries(this.layers).filter(([name]) => name !== 'cadastre').map(([name, group]) => [name, group.visible])); this.clear(); this.build(); for (const [name, visible] of Object.entries(layers)) if (this.layers[name]) this.layers[name].visible = visible; if (this.layers.cadastre) this.layers.cadastre.visible = this._cadastreEnabled; if (this.aocMesh && this.layers.parcels) this.aocMesh.visible = this.layers.parcels.visible || Boolean(this.terroirTint || this.geologyLayer); this.restoreSelection(); this.restoreView(view); this.requestRender(); }
  getDebug() { return { village: this.indexVillage?.id || this.indexVillage?.name || null, gridSize: this.grid, bounds: this.bounds, exaggeration: this.exaggeration, mode: this.mode, aocOpacity: this.aocOpacity, drawCalls: this.renderer.info.render.calls, features: this.featureIndex.length }; }
  build() { const d = this.sceneJSON; const bounds = d.bounds || d.bounds2154 || this.indexVillage?.bounds2154 || this.indexVillage?.bounds; if (!Array.isArray(bounds) || bounds.length !== 4) throw new Error('Scene bounds must be [xmin, ymin, xmax, ymax]'); this.bounds = bounds.map(Number); this.focusBounds = (this.indexVillage?.bounds2154 || this.indexVillage?.bounds || this.bounds).map(Number); const [xmin, ymin, xmax, ymax] = this.bounds; this.widthM = xmax - xmin; this.depthM = ymax - ymin; if (!(this.widthM > 0 && this.depthM > 0)) throw new Error('Scene bounds are invalid'); const heights = d.heights || d.heightGrid || d.terrain?.heights; this.grid = Number(d.gridSize || d.terrain?.gridSize || Math.sqrt(heights?.length || 0)); this.heightGrid = Array.isArray(heights) && Array.isArray(heights[0]) ? heights.flat() : heights; if (!Array.isArray(this.heightGrid) || this.heightGrid.length !== this.grid * this.grid) throw new Error('Scene heights must be a flat or nested square grid'); this.heightGrid = this.heightGrid.map(Number); if (this.heightGrid.some(v => !Number.isFinite(v))) throw new Error('Scene heights contain non-finite values'); this.validMask = this.readMask(d.validMask || d.terrain?.validMask); this.minElevation = Number(d.minElevation ?? Math.min(...this.heightGrid)); this.maxElevation = Number(d.maxElevation ?? Math.max(...this.heightGrid)); this.terrainHeight = Math.max(1, (this.maxElevation - this.minElevation) * WORLD_SCALE * this.exaggeration); this.terrain = this.makeTerrain(); this.sceneParent().add(this.terrain); this.addFeatures(); this.buildAocOverlay(); if (this.progressiveBuild) this.queueBuildStep(() => this.addLabels(), true); else this.addLabels(); this.setMaterialMode(); this.updateParcelVisibility(); this.updateScreenLineResolution(); this.applyLighting(); this.rebuildOwnerHighlight(this.sceneParent()); this.rebuildCompareOutlines(this.sceneParent()); this.rebuildCommuneBoundaries(this.sceneParent()); if (this.progressiveBuild) { const rain = this.runoffState; if (rain && (rain.rainMm || rain.falling)) this.queueBuildStep(() => this.rebuildRunoff(), true); } else this.scheduleRunoffRebuild(); }
  readMask(mask) { if (!Array.isArray(mask) || mask.length !== this.grid * this.grid) return new Array(this.grid * this.grid).fill(true); return mask.map(v => v === true || v === 1 || v === '1'); }
  point(c) { return this.worldPoint(Number(c?.[0]), Number(c?.[1])); }
  validAt(row, col) { return row >= 0 && row < this.grid && col >= 0 && col < this.grid && this.validMask[row * this.grid + col]; }
  drapedPoints(ring) { ring = simplifiedRing(ring); const out = []; for (let i = 0; i < ring.length - 1; i++) { const a = this.point(ring[i]), b = this.point(ring[i + 1]); const n = Math.max(1, Math.ceil(Math.hypot(a.x - b.x, a.z - b.z) / (30 * WORLD_SCALE))); for (let j = 0; j < n; j++) { const t = j / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = this.elevationAt(x, z); if (y == null) return []; out.push(new THREE.Vector3(x, y + .12, z)); } } const last = this.point(ring[ring.length - 1]), y = this.elevationAt(last.x, last.z); if (y == null) return []; out.push(new THREE.Vector3(last.x, y + .12, last.z)); return out; }
  addFeatures() { const d = this.sceneJSON; const collections = { climats: d.climats || d.appellations || d.polygons || [], parcels: d.parcels || [], roads: d.roads || [], forest: d.forest || d.forests || d.forestMask || [], buildings: d.buildings || [], water: [...(d.waterSurfaces || []), ...(d.waterLines || []), ...(d.water || [])] }; this.featureIndex = []; this.lineBuffers = {}; const parent = this.sceneParent(); for (const key of LAYERS) { const group = new THREE.Group(); group.name = key; this.layers[key] = group; parent.add(group); if (key === 'cadastre') { this.indexCadastreFeatures(); this.updateCadastreLOD(true); continue; } const list = (Array.isArray(collections[key]) ? collections[key] : []).slice(0, key === 'buildings' ? 1500 : 2000), add = feature => { if (key === 'buildings') this.addBuilding(group, feature); else this.addDraped(group, feature, key); }, finish = () => { if (key === 'buildings') this.mergeBuildings(group); else Object.keys(this.lineBuffers).filter(k => k.startsWith(`${key}:`)).forEach(k => this.flushLineBatch(group, k)); };
      if (!this.progressiveBuild) { list.forEach(add); finish(); continue; }
      for (let i = 0; i < list.length; i += 250) { const chunk = list.slice(i, i + 250); this.queueBuildStep(() => chunk.forEach(add)); }
      this.queueBuildStep(finish, true); } }
  // Work queued by a progressive build runs a few milliseconds per frame; a newer build (or clear) drops what is left.
  // Steps marked 'visible' change what is drawn, so the layer settings are reapplied after them.
  queueBuildStep(step, visible = false) {
    const queue = this._buildQueue ||= [];
    queue.push({ step, visible, generation: this._buildGeneration || 0 });
    if (this._buildFrame) return;
    const run = () => {
      this._buildFrame = 0; const start = performance.now(); let shown = false;
      while (queue.length && performance.now() - start < 6) { const item = queue.shift(); if (item.generation !== (this._buildGeneration || 0)) continue; try { item.step(); } catch (error) { this.onError(error); } shown ||= item.visible; }
      if (shown) { this.setMaterialMode(); this.updateParcelVisibility(); this.updateScreenLineResolution(); if (this.aocMesh && this.layers.parcels) this.aocMesh.visible = this.layers.parcels.visible || Boolean(this.terroirTint || this.geologyLayer); }
      if (!queue.length) this.maybeFinishSwap();
      this.requestRender();
      if (queue.length) this._buildFrame = requestAnimationFrame(run);
    };
    this._buildFrame = requestAnimationFrame(run);
  }
  indexCadastreFeatures() { for (const feature of this.cadastralParcels) { const parts = partsOf(feature), coordinates = parts.flatMap(part => part.ring), xs = coordinates.map(p => Number(p[0])), ys = coordinates.map(p => Number(p[1])); if (!parts.length || !xs.length) continue; const bounds = [xs.reduce((a, b) => Math.min(a, b), Infinity), ys.reduce((a, b) => Math.min(a, b), Infinity), xs.reduce((a, b) => Math.max(a, b), -Infinity), ys.reduce((a, b) => Math.max(a, b), -Infinity)], identity = featureIdentity(feature, 'cadastre'); for (const part of parts) this.featureIndex.push({ feature, key: 'cadastre', identity, ring: part.ring, holes: part.holes || [], classification: null, bounds, cadastreVisible: false }); } }
  rebuildCadastreLayer() { const group = this.layers.cadastre; if (!group) return; this._cancelCadastreLOD(); for (const child of [...group.children]) { this.disposeObject(child); group.remove(child); } this.featureIndex = this.featureIndex.filter(item => item.key !== 'cadastre'); this.indexCadastreFeatures(); this._cadastreLodKey = null; this._cadastreCandidateSignature = null; this.updateCadastreLOD(true); this.updateScreenLineResolution(); this.restoreSelection(); }
  buildCadastreBatch(candidates) { const group = this.layers.cadastre; if (!group) return; for (const child of [...group.children]) { this.disposeObject(child); group.remove(child); } const segments = []; for (const item of candidates) for (const part of partsOf(item.feature)) for (const ring of [part.ring, ...(part.holes || [])]) { const points = this.drapedPoints(ring); for (let i = 1; i < points.length; i++) segments.push(points[i - 1].x, points[i - 1].y, points[i - 1].z, points[i].x, points[i].y, points[i].z); } if (!segments.length) return; const geometry = this.screenLineGeometry(segments), halo = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0x403b37, width: 1.35, opacity: .34, layer: 'cadastre' })), line = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0xf2e9dc, width: .7, opacity: .56, layer: 'cadastre' })); halo.userData = { kind: 'cadastre', boundaryRole: 'halo' }; line.userData = { kind: 'cadastre', boundaryRole: 'core' }; halo.renderOrder = 22; line.renderOrder = 23; group.add(halo, line); }
  _cancelCadastreLOD() { if (this._cadastreLodTimer) { clearTimeout(this._cadastreLodTimer); this._cadastreLodTimer = 0; } this._cadastrePendingBucket = null; this._cadastreLodGeneration = (this._cadastreLodGeneration || 0) + 1; }
  _cadastreBucket() { const radiusMetres = this.camera.position.distanceTo(this.controls.target) / WORLD_SCALE, center = [WORLD_ORIGIN_EPSG.easting + this.controls.target.x / WORLD_SCALE, WORLD_ORIGIN_EPSG.northing - this.controls.target.z / WORLD_SCALE]; return { radiusMetres, center, bucket: `${Math.round(center[0] / 150)},${Math.round(center[1] / 150)},${radiusMetres > CADASTRE_MAX_VIEW_RADIUS_METRES ? 'far' : Math.round(radiusMetres / 250)}` }; }
  _applyCadastreLOD(bucketInfo) { const { radiusMetres, center, bucket } = bucketInfo, group = this.layers.cadastre; if (!group) return; const items = this.featureIndex.filter(item => item.key === 'cadastre'); this._cadastreLodKey = bucket; if (radiusMetres > CADASTRE_MAX_VIEW_RADIUS_METRES || !this._cadastreEnabled) { items.forEach(item => { item.cadastreVisible = false; }); for (const child of [...group.children]) { this.disposeObject(child); group.remove(child); } this._cadastreCandidateSignature = 'far'; group.visible = this._cadastreEnabled && radiusMetres <= CADASTRE_MAX_VIEW_RADIUS_METRES; this.updateSelectionOverlay(); return; } const unique = new Map(); for (const item of items) if (!unique.has(item.identity)) unique.set(item.identity, item); const distanceToBounds = item => { const [xmin, ymin, xmax, ymax] = item.bounds; const dx = center[0] < xmin ? xmin - center[0] : center[0] > xmax ? center[0] - xmax : 0; const dy = center[1] < ymin ? ymin - center[1] : center[1] > ymax ? center[1] - ymax : 0; return Math.hypot(dx, dy); }; const candidates = [...unique.values()].filter(item => distanceToBounds(item) <= CADASTRE_NEIGHBOR_RADIUS_METRES).sort((a, b) => distanceToBounds(a) - distanceToBounds(b) || String(a.identity).localeCompare(String(b.identity))).slice(0, 5000); const signature = [...new Set(candidates.map(item => item.identity))].sort().join('|'); const allowed = new Set(candidates); items.forEach(item => { item.cadastreVisible = allowed.has(unique.get(item.identity)); }); if (signature !== this._cadastreCandidateSignature || !group.children.length) { this.buildCadastreBatch(candidates); this._cadastreCandidateSignature = signature; } group.visible = true; this.updateScreenLineResolution(); this.updateSelectionOverlay(); }
  updateCadastreLOD(force = false) { const group = this.layers.cadastre; if (!group || !this.camera || !this.controls?.target) return; const bucketInfo = this._cadastreBucket(); if (!force && bucketInfo.bucket === this._cadastreLodKey) { if (this._cadastreLodTimer) clearTimeout(this._cadastreLodTimer); this._cadastreLodTimer = 0; this._cadastrePendingBucket = null; return; } if (!force && this._cadastreDeferralEnabled) { this._cadastrePendingBucket = bucketInfo.bucket; const generation = this._cadastreLodGeneration || 0; clearTimeout(this._cadastreLodTimer); this._cadastreLodTimer = setTimeout(() => { this._cadastreLodTimer = 0; if (this.disposed || generation !== this._cadastreLodGeneration) return; this._cadastrePendingBucket = null; if (this._controlsGestureActive) { this.updateCadastreLOD(); return; } const latest = this._cadastreBucket(); if (latest.bucket !== bucketInfo.bucket) { this.updateCadastreLOD(); return; } this._applyCadastreLOD(latest); }, 70); return; } if (force) this._cancelCadastreLOD(); this._cadastrePendingBucket = null; this._applyCadastreLOD(bucketInfo); }
  addDraped(group, feature, key) { const parts = partsOf(feature); if (!parts.length) return; const classification = className(feature), normalized = normalizeClass(classification), identity = featureIdentity(feature, key); if (key === 'parcels' && (this.classificationVisibility[classification] === false || this.classificationVisibility[normalized] === false || this.classificationVisibility[classKey(classification)] === false)) return; const batch = this.lineBuffers[`${key}:${key === 'parcels' ? classKey(classification) : 'all'}`] ||= { positions: [], colors: [] }; for (const part of parts) { if (part.ring.length < 2) continue; for (const ring of [part.ring, ...(part.holes || [])]) { if (key === 'climats') { this.addSharedEdges(batch, ring); continue; } const points = this.drapedPoints(ring); if (points.length < 2) continue; for (let i = 1; i < points.length; i++) { const a = points[i - 1], b = points[i]; batch.positions.push(a.x, a.y, a.z, b.x, b.y, b.z); } } this.featureIndex.push({ feature, key, identity, ring: part.ring, holes: part.holes || [], classification }); } }
  // Lieu-dit edges: neighbouring lieux-dits share most of their boundary vertex for vertex. Each ring used to be
  // simplified on its own, so the two copies of a shared edge came out up to 1.5 m apart and showed as a double line
  // close up. Now every source segment is drawn once (keyed by its two end points to 0.1 m) and is not simplified.
  addSharedEdges(batch, ring) { const seen = batch.seen ||= new Set(), q = v => `${Math.round(+v[0] * 10)},${Math.round(+v[1] * 10)}`;
    for (let i = 1; i < ring.length; i++) { const a0 = ring[i - 1], b0 = ring[i], ka = q(a0), kb = q(b0); if (ka === kb) continue; const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; if (seen.has(k)) continue; seen.add(k);
      const a = this.point(a0), b = this.point(b0), n = Math.max(1, Math.ceil(Math.hypot(a.x - b.x, a.z - b.z) / (30 * WORLD_SCALE))); let prev = null;
      for (let j = 0; j <= n; j++) { const t = j / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = this.elevationAt(x, z); if (y == null) { prev = null; continue; } const cur = [x, y + .12, z]; if (prev) batch.positions.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]); prev = cur; } } }
  // Each segment becomes a 4-vertex quad expanded in screen space by the vertex shader. Typed arrays are filled
  // directly: rebuilding a commune creates hundreds of thousands of vertices, and array spreading dominated the frame.
  screenLineGeometry(segments) { const count = Math.floor(segments.length / 6), positions = new Float32Array(count * 12), next = new Float32Array(count * 12), sides = new Float32Array(count * 4), indices = new Uint32Array(count * 6); for (let s = 0; s < count; s++) { const i = s * 6, p = s * 12, v = s * 4, ax = segments[i], ay = segments[i + 1], az = segments[i + 2], bx = segments[i + 3], by = segments[i + 4], bz = segments[i + 5]; positions[p] = ax; positions[p + 1] = ay; positions[p + 2] = az; positions[p + 3] = ax; positions[p + 4] = ay; positions[p + 5] = az; positions[p + 6] = bx; positions[p + 7] = by; positions[p + 8] = bz; positions[p + 9] = bx; positions[p + 10] = by; positions[p + 11] = bz; next[p] = bx; next[p + 1] = by; next[p + 2] = bz; next[p + 3] = bx; next[p + 4] = by; next[p + 5] = bz; next[p + 6] = ax; next[p + 7] = ay; next[p + 8] = az; next[p + 9] = ax; next[p + 10] = ay; next[p + 11] = az; sides[v] = -1; sides[v + 1] = 1; sides[v + 2] = 1; sides[v + 3] = -1; const k = s * 6; indices[k] = v; indices[k + 1] = v + 2; indices[k + 2] = v + 1; indices[k + 3] = v + 2; indices[k + 4] = v + 3; indices[k + 5] = v + 1; } const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geo.setAttribute('next', new THREE.BufferAttribute(next, 3)); geo.setAttribute('side', new THREE.BufferAttribute(sides, 1)); geo.setIndex(new THREE.BufferAttribute(indices, 1)); return geo; }
  screenLineMaterial({ color, width, opacity = 1, layer = null }) { const resolution = new THREE.Vector2(1, 1); const material = new THREE.ShaderMaterial({ uniforms: { resolution: { value: resolution }, linewidth: { value: width }, color: { value: new THREE.Color(color) }, opacity: { value: opacity }, ...this.hazeUniforms }, vertexShader: SCREEN_LINE_VERTEX_SHADER, fragmentShader: SCREEN_LINE_FRAGMENT_SHADER, transparent: opacity < 1, depthTest: true, depthWrite: false, side: THREE.DoubleSide }); material.userData.screenLine = true; material.userData.resolution = resolution; material.userData.baseLineWidth = width; material.userData.baseOpacity = opacity; material.userData.screenLineLayer = layer; return material; }
  flushLineBatch(group, key) { const batch = this.lineBuffers[key]; if (!batch?.positions.length) return; const layer = key.split(':')[0], classification = key.split(':')[1], styles = { climats: { color: 0xd7c9b4, width: 1, halo: 1.9, opacity: .62, haloOpacity: .22 }, parcels: { color: classColor(classification || 'unclassified').lerp(new THREE.Color(0xffffff), .22), width: 1.3, halo: 2.0, opacity: .65, haloOpacity: .22 }, roads: { color: PALETTE.roads, width: 1.8, halo: 3.0, opacity: .9, haloOpacity: .45 }, forest: { color: PALETTE.forest, width: 1.15, halo: 2.6, opacity: .46 }, water: { color: PALETTE.water, width: 1.4, halo: 3.0, opacity: .62 }, buildings: { color: PALETTE.buildings, width: 1.2, halo: 2.8, opacity: .5 } }, style = styles[layer] || styles.roads, geometry = this.screenLineGeometry(batch.positions), halo = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0x332d28, width: style.halo, opacity: style.haloOpacity ?? style.opacity * .62, layer })), line = new THREE.Mesh(geometry, this.screenLineMaterial({ color: style.color, width: style.width, opacity: style.opacity, layer })); halo.userData = { kind: layer, classification, screenLine: true, boundaryRole: 'halo' }; line.userData = { kind: layer, classification, screenLine: true, boundaryRole: 'core' }; halo.renderOrder = 20; line.renderOrder = 21; group.add(halo, line); }
  addBuilding(group, feature) { const p = props(feature), height = Number(p.height ?? p.hauteur ?? p.zmax); if (!Number.isFinite(height) || height <= 0) return; for (const part of partsOf(feature)) { if (part.ring.length < 3) continue; const q0 = this.point(part.ring[0]); if (this.elevationAt(q0.x, q0.z) == null) continue; const shape = new THREE.Shape(); part.ring.forEach((c, i) => { const q = this.point(c); i ? shape.lineTo(q.x, -q.z) : shape.moveTo(q.x, -q.z); }); for (const hole of part.holes || []) { const path = new THREE.Path(); hole.forEach((c, i) => { const q = this.point(c); i ? path.lineTo(q.x, -q.z) : path.moveTo(q.x, -q.z); }); shape.holes.push(path); } const geo = new THREE.ExtrudeGeometry(shape, { depth: height * WORLD_SCALE, bevelEnabled: false }); geo.rotateX(-Math.PI / 2); const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: PALETTE.buildings, roughness: .9 })); mesh.position.y = this.elevationAt(q0.x, q0.z); mesh.userData = { kind: 'buildings', feature }; group.add(mesh); } }
  mergeBuildings(group) { const meshes = group.children.filter(x => x.isMesh); if (meshes.length < 2) return; const positions = [], normals = [], indices = []; let offset = 0; for (const mesh of meshes) { const pos = mesh.geometry.attributes.position, nor = mesh.geometry.attributes.normal; for (let i = 0; i < pos.count; i++) { positions.push(pos.getX(i) + mesh.position.x, pos.getY(i) + mesh.position.y, pos.getZ(i) + mesh.position.z); normals.push(nor.getX(i), nor.getY(i), nor.getZ(i)); } const src = mesh.geometry.index; if (src) for (const i of src.array) indices.push(i + offset); else for (let i = 0; i < pos.count; i++) indices.push(i + offset); offset += pos.count; } const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); geo.setIndex(indices); const merged = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: PALETTE.buildings, roughness: .9 })); merged.userData.kind = 'buildings'; meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); group.remove(mesh); }); group.add(merged); }
  updateParcelVisibility() { const group = this.layers.parcels; if (!group) return; for (const object of group.children) { const classification = object.userData?.classification; if (!classification) continue; const key = classKey(classification); object.visible = this.classificationVisibility[classification] !== false && this.classificationVisibility[normalizeClass(classification)] !== false && this.classificationVisibility[key] !== false; } if (this.aocMesh) this.aocMesh.visible = group.visible !== false || Boolean(this.terroirTint || this.geologyLayer); }
  updateVerticalGeometry() { if (!this.terrain) return; this.labelItems?.forEach(item => { item.y = undefined; }); const view = this.captureView(); this.terrainHeight = Math.max(1, (this.maxElevation - this.minElevation) * WORLD_SCALE * this.exaggeration); const terrainPos = this.terrain.geometry.attributes.position; for (let row = 0; row < this.grid; row++) for (let col = 0; col < this.grid; col++) terrainPos.setY(row * this.grid + col, (this.heightGrid[row * this.grid + col] - WORLD_DATUM_ELEVATION) * WORLD_SCALE * this.exaggeration); terrainPos.needsUpdate = true; this.terrain.geometry.computeVertexNormals(); this.terrain.geometry.computeBoundingBox(); this.terrain.geometry.computeBoundingSphere(); if (this.aocMesh) { const overlayPos = this.aocMesh.geometry.attributes.position; for (let i = 0; i < overlayPos.count; i++) { const y = this.elevationAt(overlayPos.getX(i), overlayPos.getZ(i)); if (y != null) overlayPos.setY(i, y + .06); } overlayPos.needsUpdate = true; this.aocMesh.geometry.computeBoundingBox(); this.aocMesh.geometry.computeBoundingSphere(); } for (const key of LAYERS.filter(name => name !== 'buildings')) { const group = this.layers[key]; if (!group) continue; group.traverse(object => { const position = object.geometry?.attributes?.position, next = object.geometry?.attributes?.next; if (!position) return; for (let i = 0; i < position.count; i++) { const y = this.elevationAt(position.getX(i), position.getZ(i)); if (y != null) position.setY(i, y + .12); } if (next) for (let i = 0; i < next.count; i++) { const y = this.elevationAt(next.getX(i), next.getZ(i)); if (y != null) next.setY(i, y + .12); } position.needsUpdate = true; if (next) next.needsUpdate = true; object.geometry.computeBoundingBox(); object.geometry.computeBoundingSphere(); }); } this.rebuildBuildings(); this.updateSelectionOverlay(); if (this._ownerHighlight) this.rebuildOwnerHighlight(this._ownerHighlight.parent); if (this._compareGroup) this.rebuildCompareOutlines(this._compareGroup.parent); if (this._communeLines) this.rebuildCommuneBoundaries(this._communeLines.parent); this.scheduleRunoffRebuild(); this.applyLighting(); this.restoreView(view); this.requestRender(); }
  rebuildBuildings() { const group = this.layers.buildings; if (!group) return; const visible = group.visible; for (const child of [...group.children]) { this.disposeObject(child); group.remove(child); } const list = Array.isArray(this.sceneJSON?.buildings) ? this.sceneJSON.buildings : []; for (const feature of list.slice(0, 1500)) this.addBuilding(group, feature); this.mergeBuildings(group); group.visible = visible; }
  buildAocOverlay() { const size = this.rasterSize(), canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; this.aocCanvas = canvas; this.aocContext = canvas.getContext('2d'); const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; this.aocTexture = texture; this.aocMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: this.geologyLayer ? Math.max(.72, this.aocOpacity) : this.terroirTint ? Math.max(.62, this.aocOpacity) : this.aocOpacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }); this.aocMesh = new THREE.Mesh(this.terrain.geometry.clone(), this.aocMaterial); const pos = this.aocMesh.geometry.attributes.position; for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + .06); pos.needsUpdate = true; this.sceneParent().add(this.aocMesh); this.aocMesh.visible = Boolean(this.terroirTint || this.geologyLayer) || this.layers.parcels?.visible !== false; this.drawAocOverlay(); }
  // Terroir shading: fn(feature, layer) returns a CSS colour (or null) for each lieu-dit; the AOC fill shows those
  // colours instead of the AOC classes while it is set.
  setGeologyLayer(fn) { this.geologyLayer = typeof fn === 'function' ? fn : null; this.refreshOverlayMode(); }
  refreshOverlayMode() { const on = Boolean(this.terroirTint || this.geologyLayer); if (this.aocMaterial) this.aocMaterial.opacity = this.geologyLayer ? Math.max(.72, this.aocOpacity) : on ? Math.max(.62, this.aocOpacity) : this.aocOpacity; if (this.aocMesh) this.aocMesh.visible = on || this.layers.parcels?.visible !== false; this.drawAocOverlay(); this.requestRender(); }
  setTerroirTint(fn) { this.terroirTint = typeof fn === 'function' ? fn : null; this.refreshOverlayMode(); }
  drawAocOverlay() { if (!this.aocCanvas || !this.aocContext) return; const size = this.aocCanvas.width, ctx = this.aocContext; ctx.clearRect(0, 0, size, size); const sx = size / this.widthM, sy = size / this.depthM, map = c => [(Number(c[0]) - this.bounds[0]) * sx, size - (Number(c[1]) - this.bounds[1]) * sy];
    if (this.geologyLayer) { const polys = this.geologyLayer(this.bounds) || []; for (const poly of polys) { ctx.beginPath(); for (const flat of poly.rings) { for (let i = 0; i < flat.length; i += 2) { const x = (flat[i] - this.bounds[0]) * sx, y = size - (flat[i + 1] - this.bounds[1]) * sy; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); } ctx.fillStyle = poly.colour; ctx.fill('evenodd'); }
      /* lieux-dits drawn over the formations as fine lines, so the vineyards stay readable */ ctx.lineWidth = Math.max(1, size / 2048); ctx.strokeStyle = 'rgba(40,28,22,.55)'; for (const feature of this.sceneJSON?.climats || []) { ctx.beginPath(); for (const part of partsOf(feature)) for (const ring of [part.ring, ...(part.holes || [])]) { ring.forEach((p, i) => { const q = map(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); } ctx.stroke(); }
      if (this.aocTexture) this.aocTexture.needsUpdate = true; return; }
    if (this.terroirTint) { for (const feature of this.sceneJSON?.climats || []) { const colour = this.terroirTint(feature, 'climats'); if (!colour) continue; ctx.beginPath(); for (const part of partsOf(feature)) for (const ring of [part.ring, ...(part.holes || [])]) { ring.forEach((p, i) => { const q = map(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); } ctx.fillStyle = colour; ctx.fill('evenodd'); } if (this.aocTexture) this.aocTexture.needsUpdate = true; return; } const parcels = [...(this.sceneJSON?.parcels || [])].sort((a, b) => classRank(classKey(className(a))) - classRank(classKey(className(b)))); for (const feature of parcels) { const c = className(feature), key = classKey(c); if (this.classificationVisibility[c] === false || this.classificationVisibility[normalizeClass(c)] === false || this.classificationVisibility[key] === false) continue; ctx.beginPath(); for (const part of partsOf(feature)) for (const ring of [part.ring, ...(part.holes || [])]) { ring.forEach((p, i) => { const q = map(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); } ctx.fillStyle = classCss(c); ctx.fill('evenodd'); } if (this.aocTexture) this.aocTexture.needsUpdate = true; }
  // During a progressive build the new labels are made in a hidden batch and only shown when the new terrain is
  // (finishProgressiveBuild), so they never float over the old, differently sized scene.
  // A label's on-screen size, worked out from its text with canvas text metrics. One sample label per tier is measured in
  // the page once (font, height, padding, letter spacing); after that no label needs the browser to lay out the page.
  labelSize(el, tier) {
    const metrics = this._labelMetrics ||= new Map(); let m = metrics.get(el.className);
    if (!m) {
      const sample = el.cloneNode(false); sample.textContent = 'Mg'; sample.hidden = false; sample.style.visibility = 'hidden'; (this.labels || document.body).append(sample);
      const style = getComputedStyle(sample), ctx = (this._labelCanvas ||= document.createElement('canvas')).getContext('2d'); ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      m = { font: ctx.font, h: sample.offsetHeight || 16, extra: (sample.offsetWidth || 0) - ctx.measureText('Mg').width, spacing: parseFloat(style.letterSpacing) || 0 }; sample.remove(); metrics.set(el.className, m);
      if (!this._labelFontsWatched && globalThis.document?.fonts?.ready) { this._labelFontsWatched = true; document.fonts.ready.then(() => { this._labelMetrics = null; }); }
    }
    const ctx = this._labelCanvas.getContext('2d'); ctx.font = m.font; const text = el.textContent || '';
    return { w: Math.ceil(ctx.measureText(text).width + m.spacing * text.length + Math.max(0, m.extra)) || 80, h: m.h || 24 };
  }
  addLabels() { if (!this.labels) return; const pending = Boolean(this.progressiveBuild && this._incomingGroup && !this._incomingGroup.visible), holder = pending ? document.createElement('div') : this.labels; if (pending) { this._pendingLabels?.holder.remove(); holder.className = 'map-label-batch'; holder.style.visibility = 'hidden'; this.labels.append(holder); } else this.labels.replaceChildren(); this.labels.style.pointerEvents = 'none'; const tierName = ['grand-cru', 'premier-cru', 'lieu-dit', 'lieu-dit']; const items = labelCandidates(this.sceneJSON).map(({ feature, layer, tier, text, point, area }) => { const el = document.createElement('button'); el.type = 'button'; el.className = `map-label map-label--${tierName[tier]}`; el.style.pointerEvents = 'auto'; el.style.visibility = 'hidden'; el.textContent = text; el.title = tier === 0 ? `${text} · Grand Cru` : tier === 1 ? `${text} · Premier Cru` : text; el.addEventListener('click', e => { e.stopPropagation(); this.selectFeature(feature, layer); }); holder.append(el); return { el, p: this.point(point), feature, tier, area }; }); /* Sizes come from the font metrics (labelSize), so creating labels never forces the page to lay itself out. */ for (const item of items) { const size = this.labelSize(item.el, item.tier); item.w = size.w; item.h = size.h; } /* Laid out invisibly for measuring, then hidden until placed, so they never all flash at once. */ for (const item of items) { item.el.hidden = true; item.el.style.visibility = ''; } if (pending) { this._pendingLabels = { holder, items }; return; } this.labelItems = items; if (this.progressiveBuild && this.terrain) this.renderScene(); else this.requestRender(); /* placed in this same frame, so no frame shows them all hidden */ }
  clearSelection(notify = true) { const hadSelection = Boolean(this.selectedFeature); this.selectedFeature = null; this.updateSelectionOverlay(); if (notify && hadSelection) this.onSelect(null, null, { kind: null, identity: null, layer: null }); this.requestRender(); }
  selectFeature(feature, key, context = {}) { if (!feature) return; const identity = featureIdentity(feature, key), provenance = featureFactsProvenance(feature), meta = key === 'cadastre' ? { kind: 'cadastre-parcel', ...this.cadastralMeta } : { kind: key === 'parcels' ? 'aoc-parcel' : 'climat' }; this.selectedFeature = { feature, key, identity }; this.updateSelectionOverlay(); this.onSelect(feature, key, { identity, layer: key, ...meta, ...provenance, ...context }); this.requestRender(); }
  // While a new scene is still being built its features are not all there yet; the swap calls this again when they are.
  restoreSelection() { const selected = this.selectedFeature; if (!selected) return; if (this.progressiveBuild && ((this._incomingGroup && !this._incomingGroup.visible) || this._buildQueue?.length)) return; const found = this.featureIndex.find(item => item.key === selected.key && (item.identity || featureIdentity(item.feature, item.key)) === selected.identity && this.isFeatureVisible(item)); if (found) { this.selectedFeature = { ...selected, feature: found.feature }; this.updateSelectionOverlay(); } else this.clearSelection(); }
  isFeatureVisible(item) { return Boolean(item && this.layers[item.key]?.visible && (item.key !== 'parcels' || (this.classificationVisibility[item.classification] !== false && this.classificationVisibility[normalizeClass(item.classification)] !== false && this.classificationVisibility[classKey(item.classification)] !== false)) && (item.key !== 'cadastre' || item.cadastreVisible !== false)); }
  updateSelectionOverlay() { if (this.selectionOverlay) { this.world.remove(this.selectionOverlay); this.disposeObject(this.selectionOverlay); this.selectionOverlay = null; } const selected = this.selectedFeature, item = selected && this.featureIndex.find(candidate => candidate.key === selected.key && (candidate.identity || featureIdentity(candidate.feature, candidate.key)) === selected.identity); if (!selected || !this.isFeatureVisible(item)) return; const selectedProps = props(selected.feature), outline = selected.key === 'climats' && Array.isArray(selectedProps.aocSelectionRings) ? { rings: selectedProps.aocSelectionRings } : selected.feature; const parts = partsOf(outline), segments = []; for (const part of parts) for (const ring of [part.ring, ...(part.holes || [])]) { const points = this.drapedPoints(ring); for (let i = 1; i < points.length; i++) segments.push(points[i - 1].x, points[i - 1].y + .06, points[i - 1].z, points[i].x, points[i].y + .06, points[i].z); } if (!segments.length) return; const group = new THREE.Group(); group.name = 'selection'; const geometry = this.screenLineGeometry(segments), halo = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0x2b1714, width: 5.2, opacity: .92, layer: 'selection' })), line = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0xffd166, width: 2.7, opacity: 1, layer: 'selection' })); halo.renderOrder = 40; line.renderOrder = 41; group.add(halo, line); this.selectionOverlay = group; this.world.add(group); this.updateScreenLineResolution(); this.updateScreenLineStyle(); }
  // the lieu-dit under a point (smallest one when several overlap), for a parcel's terrain context
  placeFeatureAt(point) { const matches = this.featureIndex.filter(item => item.key === 'climats' && (!item.bounds || (point[0] >= item.bounds[0] && point[0] <= item.bounds[2] && point[1] >= item.bounds[1] && point[1] <= item.bounds[3])) && this.inside(point, item.ring) && !(item.holes || []).some(h => this.inside(point, h))); if (!matches.length) return null; const span = item => item.bounds ? (item.bounds[2] - item.bounds[0]) * (item.bounds[3] - item.bounds[1]) : Infinity; return matches.sort((a, b) => span(a) - span(b))[0].feature; }
  placeAt(point) {
    const matches = this.featureIndex.filter(item => item.key === 'climats' && (!item.bounds || (point[0] >= item.bounds[0] && point[0] <= item.bounds[2] && point[1] >= item.bounds[1] && point[1] <= item.bounds[3])) && this.inside(point, item.ring) && !(item.holes || []).some(h => this.inside(point, h)));
    const verified = matches.filter(item => props(item.feature).aocVerification && ['grand-cru', 'premier-cru'].includes(classKey(className(item.feature))));
    // Prefer the map's display name (official INAO spelling for crus) over the bare cadastre name.
    const names = [...new Set((verified.length ? verified : matches).map(item => String(props(item.feature).displayName || props(item.feature).name || props(item.feature).nom || '').trim()).filter(Boolean))];
    return names.length === 1 ? names[0] : null;
  }
  // Which coloured AOC areas lie under a cadastral parcel: a grid of points inside the parcel, each
  // assigned to the highest-class AOC area containing it (the smaller, more specific area on a tie).
  aocUnder(feature) {
    const aoc = this.featureIndex.filter(item => item.key === 'parcels');
    for (const item of aoc) if (!item.box) { const xs = item.ring.map(v => Number(v[0])), ys = item.ring.map(v => Number(v[1])); item.box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
    const counts = new Map(); let samples = 0;
    for (const part of partsOf(feature)) {
      if (part.ring.length < 3) continue;
      const xs = part.ring.map(v => Number(v[0])), ys = part.ring.map(v => Number(v[1])), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const step = Math.max(0.5, Math.sqrt((x1 - x0) * (y1 - y0) / 400));
      for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) {
        if (!insideRing(x, y, part.ring) || (part.holes || []).some(h => insideRing(x, y, h))) continue;
        samples++;
        let best = null, bestRank = 0, bestArea = Infinity;
        for (const item of aoc) {
          if (x < item.box[0] || x > item.box[2] || y < item.box[1] || y > item.box[3] || !insideRing(x, y, item.ring) || item.holes.some(h => insideRing(x, y, h))) continue;
          const rank = classRank(classKey(className(item.feature))), area = Number(props(item.feature).displayAreaM2) || Infinity;
          if (rank > bestRank || (rank === bestRank && area < bestArea)) { best = item.feature; bestRank = rank; bestArea = area; }
        }
        if (best) counts.set(best, (counts.get(best) || 0) + 1);
      }
    }
    return [...counts].map(([aocFeature, n]) => ({ feature: aocFeature, share: n / samples })).sort((a, b) => b.share - a.share);
  }
  pick(event) { this.cancelPanAnimation('selection'); const hit = this.raycastTerrain(event); if (!hit) return; const worldPoint = [WORLD_ORIGIN_EPSG.easting + hit.point.x / WORLD_SCALE, WORLD_ORIGIN_EPSG.northing - hit.point.z / WORLD_SCALE]; const radiusMetres = this.camera.position.distanceTo(this.controls.target) / WORLD_SCALE, close = radiusMetres <= CADASTRE_MAX_VIEW_RADIUS_METRES; const keys = close && this.layers.cadastre?.visible ? ['cadastre', 'climats', 'parcels'] : ['climats', 'parcels']; let found = null; for (const key of keys) { found = this.featureIndex.filter(item => item.key === key && this.isFeatureVisible(item) && (!item.bounds || (worldPoint[0] >= item.bounds[0] && worldPoint[0] <= item.bounds[2] && worldPoint[1] >= item.bounds[1] && worldPoint[1] <= item.bounds[3]))).find(item => this.inside(worldPoint, item.ring) && !item.holes.some(h => this.inside(worldPoint, h))); if (found) break; } if (found) this.selectFeature(found.feature, found.key, found.key === 'cadastre' ? { placeName: this.placeAt(worldPoint), placeFeature: this.placeFeatureAt(worldPoint), parcelRing: found.ring, parcelHoles: found.holes || [], placeScope: 'selected-map-point', aocUnder: this.aocUnder(found.feature) } : {}); }
  raycastTerrain(event) { const r = this.canvas.getBoundingClientRect(); this.pointer.set((event.clientX - r.left) / r.width * 2 - 1, -(event.clientY - r.top) / r.height * 2 + 1); this.raycaster.setFromCamera(this.pointer, this.camera); return this.raycaster.intersectObject(this.terrain, false)[0]; }
  focusTerrain(event) { this.cancelPanAnimation('focus'); const hit = this.raycastTerrain(event); if (!hit) return; const direction = this.camera.position.clone().sub(this.controls.target).normalize(), distance = this.camera.position.distanceTo(this.controls.target); this.controls.target.copy(hit.point); this.camera.position.copy(hit.point).add(direction.multiplyScalar(Math.max(18, distance * .7))); this.camera.position.y = Math.max(this.camera.position.y, hit.point.y + 5); this.controls.update(); this.requestRender(); }
  inside(point, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1], hit = ((yi > point[1]) !== (yj > point[1])) && point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || 1e-12) + xi; if (hit) inside = !inside; } return inside; }
  scheduleViewChange() { if (this._panAnimation) { this._panViewDirty = true; return; } if (this.pendingViewChange) return; this.pendingViewChange = true; clearTimeout(this._viewTimer); this._viewTimer = setTimeout(() => { this.pendingViewChange = false; if (this._panAnimation) { this._panViewDirty = true; return; } const v = this.captureView(); this.onViewChange({ easting: v.easting, northing: v.northing, radiusMetres: v.radiusMetres }); }, 80); }
  // Lightness bends the photo's tones with a gamma curve, so it lifts shadows and mid-tones without clipping highlights the way brightness does.
  setDisplay(settings) { const { brightness, lightness, saturation } = clampDisplay(settings); this._brightness = brightness; photoUniforms.photoSaturation.value = saturation; photoUniforms.photoGamma.value = BASE_GAMMA * 2 ** -lightness; this.applyLighting(); }
  // Sunlight for a sun position ({ elevation, azimuth } in degrees, azimuth clockwise from north), or null for the
  // usual even light. The sun casts terrain shadows; at night only a dim blue sky light is left.
  setSun(sun) { this.sunState = sun && Number.isFinite(sun.elevation) && Number.isFinite(sun.azimuth) ? { elevation: sun.elevation, azimuth: sun.azimuth } : null; this.applyLighting(); }
  applyLighting() {
    if (!this.sunLight) return;
    const brightness = this._brightness ?? 1, sun = this.sunState, light = this.sunLight, shadows = Boolean(sun && sun.elevation > -1);
    if (this.renderer.shadowMap.enabled !== shadows) { this.renderer.shadowMap.enabled = shadows; if (this.terrain) this.terrain.material.needsUpdate = true; }
    photoUniforms.sunShade.value = sun ? smoothstep(-2, 4, sun.elevation) : 0;
    const overcast = Boolean(this.runoffState?.falling); // grey, softer light while it rains
    if (!sun) { this.light.intensity = LIGHT_INTENSITY * brightness * (overcast ? .8 : 1); this.light.color.copy(overcast ? LIGHT_RAIN : WHITE); light.intensity = 0; this.aocMaterial?.color.copy(WHITE); this.scene.background.copy(overcast ? BACKGROUND_RAIN : BACKGROUND_DAY); this.scene.fog.color.copy(this.scene.background); this.requestRender(); return; }
    const day = smoothstep(-6, 8, sun.elevation);
    this.light.intensity = LIGHT_INTENSITY * brightness * (.08 + .2 * day); this.light.color.copy(SKY_NIGHT).lerp(WHITE, day);
    // Strong sun against a faint sky makes lit and shaded ground easy to tell apart; a low sun is made stronger so
    // flat ground keeps about the same brightness through the day instead of washing out at noon.
    light.intensity = LIGHT_INTENSITY * brightness * smoothstep(-1, 12, sun.elevation) / (.25 + .75 * Math.sin(Math.max(0, sun.elevation) * Math.PI / 180)); light.color.copy(SUN_LOW).lerp(SUN_HIGH, smoothstep(0, 25, sun.elevation));
    this.scene.background.copy(BACKGROUND_NIGHT).lerp(BACKGROUND_DAY, day); this.scene.fog.color.copy(this.scene.background);
    this.aocMaterial?.color.setScalar(.3 + .7 * day); // the appellation colours are unlit, so they are dimmed by hand at dusk
    if (this.bounds) {
      // The shadow camera covers the whole scene, looking from the sun.
      const [x0, y0, x1, y1] = this.bounds, centre = this.worldPoint((x0 + x1) / 2, (y0 + y1) / 2), half = Math.hypot(x1 - x0, y1 - y0) * WORLD_SCALE / 2;
      const el = Math.max(sun.elevation, 1) * Math.PI / 180, az = sun.azimuth * Math.PI / 180, cam = light.shadow.camera;
      centre.y = (this.minElevation + this.maxElevation) / 2 * WORLD_SCALE * this.exaggeration;
      light.target.position.copy(centre); light.position.copy(centre).add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(half * 2));
      cam.left = cam.bottom = -half; cam.right = cam.top = half; cam.near = .1; cam.far = half * 4; cam.updateProjectionMatrix();
      light.shadow.normalBias = half * 3 / light.shadow.mapSize.width; light.target.updateMatrixWorld();
    }
    this.requestRender();
  }
  // Rain: { rainMm } is a storm's total rainfall, falling over { durationH } hours. Each kind of ground sheds its own share
  // (landRunoffMm); the water is routed downhill over the terrain grid and drawn as streams wherever enough gathers.
  // The streams are built once and shown or hidden in the shader, so changing the storm is instant. { falling } adds rain
  // falling from the sky; { progress } (0–1) is how far through the storm we are, for watching it build up.
  setRunoff({ rainMm = 0, durationH = 1, falling = false, progress = 1 } = {}) {
    const next = { rainMm: Math.max(0, Number(rainMm) || 0), durationH: Math.max(.1, Number(durationH) || 1), falling: Boolean(falling), progress: clamp(Number(progress) || 0, 0, 1) }, before = this.runoffState;
    const wasOn = Boolean(before && (before.rainMm || before.falling)), isOn = Boolean(next.rainMm || next.falling);
    this.runoffState = next;
    if (wasOn !== isOn || (isOn && !this.layers.runoff && !this._runoffTimer)) this.rebuildRunoff(); else this.updateRunoff();
    this.applyLighting();
  }
  runoffCellMetres() { return this.grid > 1 ? Math.sqrt(this.widthM * this.depthM) / (this.grid - 1) : null; }
  // Streams precomputed from the 1 m terrain for the villages in this view, focus village first. Missing ones are
  // requested through streamLoader (set by the app); the rain is redrawn once each arrives.
  fineStreams() {
    const ids = this.sceneJSON?.sourceIds || [], focus = String(this.sceneJSON?.id || '').replace(/^mosaic:/, ''), cache = this._fineStreams ||= new Map(), out = [];
    for (const id of [...ids].sort((a, b) => (b === focus) - (a === focus))) {
      if (!cache.has(id)) {
        cache.set(id, null);
        if (typeof this.streamLoader === 'function') Promise.resolve(this.streamLoader(id)).then(data => { if (!data?.streams) return; cache.set(id, data); if (this.runoffState && (this.runoffState.rainMm || this.runoffState.falling) && !this.disposed) this.scheduleRunoffRebuild(); }).catch(() => {});
        continue;
      }
      const data = cache.get(id); if (!data?.streams || !data.bounds) continue;
      const a = this.point([data.bounds[0], data.bounds[1]]), b = this.point([data.bounds[2], data.bounds[3]]);
      out.push({ data, box: [Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z)] });
    }
    return out;
  }
  // The share of the scene each ground type covers, weighting its runoff into one figure for the readout.
  averageRunoffMm(rainMm) { const share = this._runoff?.fields?.share; const q = landRunoffMm(rainMm); return share ? share.reduce((sum, f, k) => sum + f * q[k], 0) : q[1]; }
  // Rebuilding the rain takes a noticeable moment, so after a scene change (or as stream files arrive) it waits until
  // things have been quiet for a short while; the old water stays until the new replaces it.
  scheduleRunoffRebuild(delay = 300) {
    clearTimeout(this._runoffTimer); this._runoffTimer = 0;
    const state = this.runoffState;
    if (!state || !(state.rainMm || state.falling)) { this.rebuildRunoff(); return; }
    if (typeof setTimeout !== 'function') { this.rebuildRunoff(); return; }
    this._runoffTimer = setTimeout(() => { this._runoffTimer = 0; if (!this.disposed) this.rebuildRunoff(); }, delay);
  }
  rebuildRunoff() {
    clearTimeout(this._runoffTimer); this._runoffTimer = 0;
    const old = this.layers.runoff; if (old) { old.parent?.remove(old); this.disposeObject(old); delete this.layers.runoff; } this.rain = null;
    const state = this.runoffState;
    if (!state || !(state.rainMm || state.falling) || !this.terrain) { photoUniforms.rainOn.value = 0; this.runoffSummary = { rainMm: 0, runoffMm: 0 }; this.requestRender(); return; }
    const size = this.grid, cell = this.runoffCellMetres(), n = size * size;
    // Mapped watercourses and ponds are cut 3 m into the grid before routing (stream burning), so water passes through
    // road and railway embankments where real streams do, instead of backing up behind them as a false lake.
    if (this._runoffSource !== this.heightGrid) { this._runoff?.fields?.textureA.dispose(); this._runoff?.fields?.textureB.dispose(); const cover = this.landCover(size), K = LAND_COVER.length, burned = this.heightGrid.map((h, i) => h - 3 * Math.min(1, cover[i * K + 5] * 3)); const routed = rainRunoff(burned, this.validMask, size, cell); routed.cover = cover; routed.length = flowLength(routed.receiver, routed.filled, this.validMask, size, cell); this._runoff = routed; this._runoffSource = this.heightGrid; }
    if (!this._runoff.fields) this._runoff.fields = this.rainFields(this._runoff, size, cell);
    const { receiver, accumulation, length } = this._runoff, { arrivalN, arrival, slope, classes } = this._runoff.fields, K = LAND_COVER.length;
    const perMm = cell * cell / 1000, worst = stormRunoffMm(WATER_MAX_RAIN_MM, 98);
    // Candidate channels: places that would reach the threshold in the wettest one-hour storm on hard ground.
    const isChannel = i => receiver[i] >= 0 && accumulation[i] * perMm * worst / (3600 + arrival[i]) >= WATER_MIN_PEAK;
    // The grid's eight flow directions give straight, angular paths. Each channel is traced as one line from its head
    // to where it joins a bigger one, every cell centre is nudged a little at random, and the line is rounded off
    // (a running average, then Chaikin corner cutting) and laid back onto the terrain, so the water meanders like a real stream.
    const cellWorld = cell * WORLD_SCALE, jitter = (i, k) => { const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return (h - Math.floor(h) - .5) * .4 * cellWorld; };
    const point = i => { const row = Math.floor(i / size), col = i % size; return { x: (this.bounds[0] + col / (size - 1) * this.widthM - WORLD_ORIGIN_EPSG.easting) * WORLD_SCALE + jitter(i, 1), z: -(this.bounds[3] - row / (size - 1) * this.depthM - WORLD_ORIGIN_EPSG.northing) * WORLD_SCALE + jitter(i, 2), y: (this.heightGrid[i] - WORLD_DATUM_ELEVATION) * WORLD_SCALE * this.exaggeration, a: length[i], c: i }; };
    const upstream = new Uint8Array(n), visited = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (isChannel(i)) upstream[receiver[i]]++;
    // Villages with streams worked out from the 1 m terrain (build_streams.py) use those; the grid's own channels fill
    // in everywhere else. Where village boxes overlap, the first village drawn keeps the water.
    const fine = this.fineStreams(), fineBoxes = fine.map(f => f.box), inBoxes = (q, boxes) => boxes.some(b => q.x >= b[0] && q.x <= b[2] && q.z >= b[1] && q.z <= b[3]);
    const runs = (path, boxes) => { const out = []; let run = []; for (const q of path) { if (inBoxes(q, boxes)) { if (run.length > 1) out.push(run); run = []; } else run.push(q); } if (run.length > 1) out.push(run); return out; };
    const cellAttributes = i => ({ A: [0, 1, 2, 3, 4, 5].map(j => classes[i * K + j] * perMm), tc: arrival[i], steep: slope[i], arr: arrivalN[i] });
    const paths = [];
    for (let head = 0; head < n; head++) {
      if (!isChannel(head) || upstream[head] || visited[head]) continue;
      let path = [point(head)], c = head; visited[head] = 1;
      let joined = false;
      for (;;) { const to = receiver[c]; if (to < 0) break; path.push(point(to)); if (visited[to]) { joined = true; c = to; break; } visited[to] = 1; c = to; }
      // A side stream runs on for two cells into the one it joins, keeping its own flow, so the smoothing bends it in.
      if (joined && path.length > 1) { const own = path[path.length - 2].c; path[path.length - 1].c = own; for (let extra = 0; extra < 2 && receiver[c] >= 0; extra++) { c = receiver[c]; path.push({ ...point(c), c: own }); } }
      if (path.length < 7) continue; // short side rills, side by side, read as a comb rather than water
      path = path.map((q, k) => { if (k === 0 || k === path.length - 1) return q; let x = 0, z = 0, w = 0; for (let d = -2; d <= 2; d++) { const r = path[Math.min(path.length - 1, Math.max(0, k + d))], f = 3 - Math.abs(d); x += r.x * f; z += r.z * f; w += f; } return { ...q, x: x / w, z: z / w }; });
      for (let pass = 0; pass < 2; pass++) {
        const next = [path[0]];
        for (let k = 0; k < path.length - 1; k++) { const p0 = path[k], p1 = path[k + 1]; for (const t of [.25, .75]) next.push({ x: p0.x + (p1.x - p0.x) * t, z: p0.z + (p1.z - p0.z) * t, y: p0.y + (p1.y - p0.y) * t, a: p0.a + (p1.a - p0.a) * t, c: t < .5 ? p0.c : p1.c }); }
        next.push(path[path.length - 1]); path = next;
      }
      for (const run of runs(path, fineBoxes)) paths.push(run.map(q => ({ x: q.x, z: q.z, a: q.a, ...cellAttributes(q.c) })));
    }
    // The fine streams: positions in metres from the village's south-west corner; per vertex the upslope area of each
    // ground type (m²), travel time (s), slope (‰) and flow length (m). One round of corner cutting softens them.
    const scale = this._runoff.fields.arrivalScale;
    fine.forEach((f, v) => {
      for (const stream of f.data.streams) {
        let path = [];
        for (let k = 0; k < stream.p.length / 2; k++) {
          const w = this.point([f.data.origin[0] + stream.p[k * 2], f.data.origin[1] + stream.p[k * 2 + 1]]);
          path.push({ x: w.x, z: w.z, a: stream.l[k], A: stream.a.slice(k * 6, k * 6 + 6).map(m2 => m2 / 1000), tc: stream.t[k], steep: stream.s[k] / 1000, arr: clamp(stream.t[k] / scale, 0, 1) });
        }
        if (path.length > 2) { const next = [path[0]]; for (let k = 0; k < path.length - 1; k++) { const p0 = path[k], p1 = path[k + 1]; for (const t of [.25, .75]) { const src = t < .5 ? p0 : p1; next.push({ ...src, x: p0.x + (p1.x - p0.x) * t, z: p0.z + (p1.z - p0.z) * t, a: p0.a + (p1.a - p0.a) * t }); } } next.push(path[path.length - 1]); path = next; }
        for (const run of runs(path, fineBoxes.slice(0, v))) paths.push(run);
      }
    });
    const segments = [], tangents = [], attrs = [], along = [];
    for (const path of paths) {
      for (const q of path) { const y = this.elevationAt(q.x, q.z); q.y = (y ?? 0) + .25; }
      for (let k = 0; k < path.length - 1; k++) {
        const p0 = path[k], p1 = path[k + 1];
        segments.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        // The ribbon's sideways direction comes from a longer stretch of the line, so tiny wiggles in height or
        // position do not twist short pieces across the stream.
        const t0 = path[Math.max(0, k - 2)], t1 = path[Math.min(path.length - 1, k + 3)]; tangents.push(t1.x - t0.x, t1.y - t0.y, t1.z - t0.z);
        attrs.push(p0); along.push(p0.a, p0.a, p1.a, p1.a);
      }
    }
    const group = new THREE.Group(); group.name = 'runoff'; this.layers.runoff = group; (this.layers.climats?.parent || this.world).add(group);
    this.rain = {};
    const uniforms = { resolution: { value: new THREE.Vector2(1, 1) }, linewidth: { value: 1 }, qA: { value: new THREE.Vector4() }, qB: { value: new THREE.Vector2() }, duration: { value: 3600 }, front: { value: 1 }, color: { value: new THREE.Color(WATER_COLOUR) }, highlight: { value: new THREE.Color(WATER_HIGHLIGHT) }, opacity: { value: .95 }, time: { value: 0 }, bank: { value: 0 }, ...this.hazeUniforms };
    this.rain.uniforms = uniforms;
    if (segments.length) {
      const count = attrs.length, geometry = this.screenLineGeometry(segments), next = geometry.attributes.next.array;
      for (let k = 0; k < count; k++) for (let a = 0; a < 3; a++) {
        const t = tangents[k * 3 + a], start = segments[k * 6 + a], end = segments[k * 6 + 3 + a];
        next[k * 12 + a] = next[k * 12 + 3 + a] = start + t; next[k * 12 + 6 + a] = next[k * 12 + 9 + a] = end - t;
      }
      // Per piece (the same on its four corners): water from each ground type, travel time, steepness, arrival share.
      const areaA = new Float32Array(count * 16), areaB = new Float32Array(count * 8), tc = new Float32Array(count * 4), steep = new Float32Array(count * 4), arrive = new Float32Array(count * 4), across = new Float32Array(count * 4);
      for (let k = 0; k < count; k++) {
        const q = attrs[k], A = q.A.slice(0, 4), B = q.A.slice(4, 6);
        for (let v = 0; v < 4; v++) { areaA.set(A, (k * 4 + v) * 4); areaB.set(B, (k * 4 + v) * 2); tc[k * 4 + v] = q.tc; steep[k * 4 + v] = q.steep; arrive[k * 4 + v] = q.arr; }
        across.set([-1, 1, -1, 1], k * 4); // which edge of the ribbon (the line's own 'side' flips at the far end of each piece)
      }
      for (const [name, data, width] of [['along', Float32Array.from(along), 1], ['areaA', areaA, 4], ['areaB', areaB, 2], ['tc', tc, 1], ['steep', steep, 1], ['arrive', arrive, 1], ['across', across, 1]]) geometry.setAttribute(name, new THREE.BufferAttribute(data, width));
      const make = (bank, ref, order) => {
        const material = new THREE.ShaderMaterial({ uniforms: { ...uniforms, bank: { value: bank } }, vertexShader: WATER_VERTEX_SHADER, fragmentShader: WATER_FRAGMENT_SHADER, transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
          // Each pixel takes water (or bank) once: the short pieces overlap at their joints, and blending twice striped them.
          stencilWrite: true, stencilRef: ref, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
        Object.assign(material.userData, { screenLine: true, resolution: uniforms.resolution.value, baseLineWidth: 1, baseOpacity: .95, screenLineLayer: 'runoff' });
        const mesh = new THREE.Mesh(geometry, material); mesh.renderOrder = order; mesh.frustumCulled = false; mesh.userData = { kind: 'runoff', screenLine: true }; group.add(mesh); return material;
      };
      this.rain.bank = make(1, 2, 23); this.rain.water = make(0, 1, 24);
    }
    // Falling rain: each streak is two vertices sharing a random seed (x, phase, z, rank); the shader moves them.
    const seeds = new Float32Array(RAIN_STREAKS * 8), tips = new Float32Array(RAIN_STREAKS * 2);
    for (let k = 0; k < RAIN_STREAKS; k++) { const x = Math.random() * 2 - 1, y = Math.random(), z = Math.random() * 2 - 1, rank = Math.random(); seeds.set([x, y, z, rank, x, y, z, rank], k * 8); tips[k * 2 + 1] = 1; }
    const fallGeometry = new THREE.BufferGeometry(); fallGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_STREAKS * 6), 3)); fallGeometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 4)); fallGeometry.setAttribute('tip', new THREE.BufferAttribute(tips, 1));
    const fall = new THREE.ShaderMaterial({ uniforms: { centre: { value: new THREE.Vector3() }, extent: { value: new THREE.Vector3(1, 1, 1) }, time: { value: 0 }, density: { value: 0 }, viewDistance: { value: 1 }, opacity: { value: .45 } }, vertexShader: RAIN_VERTEX_SHADER, fragmentShader: RAIN_FRAGMENT_SHADER, transparent: true, depthTest: true, depthWrite: false });
    const streaks = new THREE.LineSegments(fallGeometry, fall); streaks.frustumCulled = false; streaks.renderOrder = 30; streaks.userData = { kind: 'rainfall' }; group.add(streaks);
    this.rain.fall = fall;
    const targets = this.composeRainFields(), arrivalScale = this._runoff.fields.arrivalScale, previous = this._shownRainTargets;
    const applyRain = () => { photoUniforms.rainTexA.value = targets[0].texture; photoUniforms.rainTexB.value = targets[1].texture; photoUniforms.rainArrivalScale.value = arrivalScale; photoUniforms.rainOn.value = 1; if (previous && previous !== targets) previous.forEach(t => t.dispose()); this._shownRainTargets = targets; };
    if (this._incomingGroup && !this._incomingGroup.visible) this._pendingRainUniforms = applyRain; else applyRain();
    this.updateRunoff(); this.updateScreenLineResolution(); this.requestRender();
    this.onRunoffChange?.(); // lets the panel refresh figures that depend on the ground types, now known
  }
  updateRunoff() {
    const state = this.runoffState || { rainMm: 0, durationH: 1, falling: false, progress: 1 }, rain = this.rain, progress = state.progress ?? 1, hours = state.durationH || 1;
    // Rain so far, and what each ground type has shed so far. Nothing flows until the first rain has soaked in; from
    // then on the water travels downhill, so the front sweeps from 0 (hilltops) to 1 (the slowest-filling valley).
    const fallen = state.rainMm * progress, q = landRunoffMm(fallen), runoffMm = this.averageRunoffMm(fallen), intensity = state.rainMm / hours;
    const totalOff = this.averageRunoffMm(state.rainMm), startMm = (() => { for (let mm = 0; mm <= state.rainMm; mm += .5) if (this.averageRunoffMm(mm) > .05) return mm; return state.rainMm; })();
    const start = state.rainMm > 0 && totalOff > .05 ? startMm / state.rainMm : 1, front = start < 1 ? clamp((progress - start) / (1 - start), 0, 1) : 0;
    this.runoffSummary = { rainMm: state.rainMm, durationH: hours, fallenMm: fallen, runoffMm, front, intensity };
    if (rain?.uniforms) { const u = rain.uniforms; u.qA.value.set(q[0], q[1], q[2], q[3]); u.qB.value.set(q[4], q[5]); u.duration.value = hours * 3600; u.front.value = front; }
    photoUniforms.rainSoak.value = clamp(fallen / 25, 0, 1); photoUniforms.rainFilm.value = clamp(runoffMm / 20, 0, 1) * clamp(.35 + intensity / 25, .35, 1); photoUniforms.rainPond.value = clamp(runoffMm / 45, 0, .85); photoUniforms.rainFront.value = front;
    // Harder rain shows more streaks: a light drizzle over a day shows few, a cloudburst nearly all of them.
    if (rain?.fall) rain.fall.uniforms.density.value = state.falling ? clamp(.08 + intensity / 55, .08, .75) : 0;
    this.requestRender();
  }
  // The rain shading fields for the scene, drawn on the GPU into two targets covering its bounds: first the coarse fields
  // worked out from the scene grid, then the 10 m fields of every village in view that has them (build_streams.py), so
  // the film, pools and wet ground follow the real terrain at 10 m where it is known. Values are copied unchanged.
  composeRainFields(targets = null) {
    const fields = this._runoff?.fields; if (!fields || !this.renderer?.setRenderTarget) return [{ texture: fields?.textureA }, { texture: fields?.textureB }];
    const size = 2048, make = () => { const t = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }); t.texture.colorSpace = THREE.NoColorSpace; return t; };
    targets ||= [make(), make()];
    const material = this._fieldMaterial ||= new THREE.ShaderMaterial({ uniforms: { map: { value: null } }, blending: THREE.NoBlending, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }' });
    const camera = new THREE.OrthographicCamera(0, this.widthM, this.depthM, 0, -1, 1), n = this.grid;
    const quad = (bounds, map, uvFix) => { const g = new THREE.PlaneGeometry(bounds[2] - bounds[0], bounds[3] - bounds[1]), uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) { const [u, v] = uvFix(uv.getX(i), uv.getY(i)); uv.setXY(i, u, v); } const m = new THREE.Mesh(g, material); m.position.set((bounds[0] + bounds[2]) / 2 - this.bounds[0], (bounds[1] + bounds[3]) / 2 - this.bounds[1], 0); m.onBeforeRender = () => { material.uniforms.map.value = map; material.uniformsNeedUpdate = true; }; return m; };
    // the coarse texture holds one texel per grid point, row 0 north; the images have row 0 north and exact pixel edges
    const coarseUv = (u, v) => [.5 / n + u * (1 - 1 / n), .5 / n + (1 - v) * (1 - 1 / n)], imageUv = (u, v) => [u, 1 - v];
    const tiles = [...(this._fieldTiles || new Map()).values()].filter(t => t?.bounds && t.bounds[0] < this.bounds[2] && t.bounds[2] > this.bounds[0] && t.bounds[1] < this.bounds[3] && t.bounds[3] > this.bounds[1]);
    const previous = this.renderer.getRenderTarget(), made = [];
    [[fields.textureA, 'a'], [fields.textureB, 'b']].forEach(([coarse, key], k) => {
      const scene = new THREE.Scene(); const base = quad(this.bounds, coarse, coarseUv); scene.add(base); made.push(base);
      tiles.forEach((tile, order) => { const tex = tile[`tex${key}`] ||= Object.assign(new THREE.Texture(tile[key]), { colorSpace: THREE.NoColorSpace, flipY: false, generateMipmaps: false, minFilter: THREE.LinearFilter, needsUpdate: true }); const m = quad(tile.bounds, tex, imageUv); m.renderOrder = order + 1; scene.add(m); made.push(m); });
      this.renderer.setRenderTarget(targets[k]); this.renderer.render(scene, camera);
    });
    this.renderer.setRenderTarget(previous); for (const m of made) m.geometry.dispose();
    this.requestFieldTiles(); return targets;
  }
  // Asks fieldLoader (set by the app) for the 10 m fields of the villages in view; when they arrive the composed fields are
  // redrawn in place.
  requestFieldTiles() {
    if (typeof this.fieldLoader !== 'function') return; const tiles = this._fieldTiles ||= new Map();
    for (const id of this.sceneJSON?.sourceIds || []) {
      if (tiles.has(id)) continue; tiles.set(id, null);
      Promise.resolve(this.fieldLoader(id)).then(tile => { if (!tile) return; tiles.set(id, tile); clearTimeout(this._fieldTimer); this._fieldTimer = setTimeout(() => { const shown = this._shownRainTargets; if (shown && this._runoff?.fields && this.layers.runoff) { this.composeRainFields(shown); this.requestRender(); } }, 120); }).catch(() => {});
    }
    while (tiles.size > 60) { const [oldest, tile] = tiles.entries().next().value; tiles.delete(oldest); tile?.texa?.dispose(); tile?.texb?.dispose(); tile?.a?.close?.(); tile?.b?.close?.(); }
  }
  // Packs the wetness fields into two textures over the terrain grid (see the terrain shader):
  //  A = downhill direction x, z · slope (0–30 %) · hollow depth (0–4 m);  B = wetness index (ln a/tan β − 2) / 14 · minutes
  //  for water to arrive (0–255) · log10 of the upslope area in m² / 7 · valid cell. The same scales as the 10 m field
  //  images made by build_streams.py, which are laid over these where a village has them (composeRainFields).
  // It also works out each cell's ground types (landCover) and how much of each drains through it (classes).
  rainFields(routed, size, cell) {
    const f = wetnessFields(this.heightGrid, this.validMask, size, cell, routed), n = size * size, valid = i => !this.validMask || this.validMask[i];
    const quantile = (values, q) => { const list = []; for (let i = 0; i < n; i++) if (valid(i)) list.push(values[i]); list.sort((a, b) => a - b); return list.length ? list[Math.min(list.length - 1, Math.floor(q * list.length))] : 0; };
    const w0 = quantile(f.wetness, .05), w1 = quantile(f.wetness, .98), t1 = Math.max(1, quantile(f.arrival, .995)); let accMax = 2; for (const v of routed.accumulation) if (v > accMax) accMax = v; const logMax = Math.log(accMax);
    const a = new Uint8Array(n * 4), b = new Uint8Array(n * 4), arrivalN = new Float32Array(n), byte = v => Math.round(clamp(v, 0, 1) * 255);
    for (let i = 0; i < n; i++) {
      arrivalN[i] = clamp(f.arrival[i] / t1, 0, 1);
      if (!valid(i)) continue;
      a.set([byte(f.dirX[i] * .5 + .5), byte(f.dirZ[i] * .5 + .5), byte(f.slope[i] / .3), byte(f.pond[i] / 4)], i * 4);
      b.set([byte((f.wetness[i] - 2) / 14), Math.min(255, Math.round(f.arrival[i] / 60)), byte(Math.log10(Math.max(1, routed.accumulation[i] * cell * cell)) / 7), 255], i * 4);
    }
    const texture = data => { const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; return t; };
    const cover = routed.cover || this.landCover(size), K = LAND_COVER.length, share = new Array(K).fill(0); let counted = 0;
    for (let i = 0; i < n; i++) if (valid(i)) { counted++; for (let k = 0; k < K; k++) share[k] += cover[i * K + k]; }
    return { textureA: texture(a), textureB: texture(b), arrivalN, arrivalScale: t1, arrival: f.arrival, slope: f.slope, classes: classAccumulation(routed.receiver, routed.filled, this.validMask, size, cover, K), share: share.map(v => counted ? v / counted : 0) };
  }
  // The share of each ground type in every grid cell, from the scene's own map layers: AOC areas count as vineyard,
  // then woods, water, roads (paved about 6 m wide, gravel 4 m) and buildings are painted over them at four samples per
  // cell side. Anything left is meadow or fields. Without a canvas (tests) everything counts as meadow.
  landCover(size) {
    const K = LAND_COVER.length, n = size * size, out = new Float32Array(n * K), S = size * 4, d = this.sceneJSON || {};
    for (let i = 0; i < n; i++) out[i * K] = 1;
    const canvas = globalThis.document?.createElement?.('canvas'), ctx = canvas?.getContext?.('2d', { willReadFrequently: true });
    if (!ctx) return out;
    canvas.width = canvas.height = S;
    const [x0, , , y1] = this.bounds, px = (this.widthM / (size - 1)) / 4, toPx = ([x, y]) => [((x - x0) / this.widthM * (size - 1) + .5) * 4, ((y1 - y) / this.depthM * (size - 1) + .5) * 4];
    const colours = ['#000000', '#ff0000', '#00ff00', '#ff00ff', '#ffff00', '#0000ff'], rgb = colours.map(c => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16)));
    ctx.fillStyle = colours[0]; ctx.fillRect(0, 0, S, S);
    const fill = (features, k) => { ctx.fillStyle = colours[k]; for (const feature of features || []) for (const part of partsOf(feature)) { ctx.beginPath(); for (const ring of [part.ring, ...(part.holes || [])]) ring.forEach((p, j) => { const [u, v] = toPx(p); j ? ctx.lineTo(u, v) : ctx.moveTo(u, v); }); ctx.fill('evenodd'); } };
    const stroke = (lines, k, metres) => { ctx.strokeStyle = colours[k]; ctx.lineWidth = Math.max(1, metres / px); ctx.lineCap = 'round'; for (const line of lines) { const coords = line.coordinates || line; if (!Array.isArray(coords) || coords.length < 2) continue; ctx.beginPath(); coords.forEach((p, j) => { const [u, v] = toPx(p); j ? ctx.lineTo(u, v) : ctx.moveTo(u, v); }); ctx.stroke(); } };
    fill(d.parcels, 1); fill(d.forests || d.forest, 2); fill(d.waterSurfaces, 5); stroke(d.waterLines || [], 5, 4);
    const roads = d.roads || [], kind = r => String(r.kind || '');
    stroke(roads.filter(r => /chauss/i.test(kind(r))), 4, 6); stroke(roads.filter(r => /empierr/i.test(kind(r))), 4, 4);
    fill(d.buildings, 3);
    const pixels = ctx.getImageData(0, 0, S, S).data;
    out.fill(0);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4; let best = 0, bestD = Infinity;
      for (let k = 0; k < K; k++) { const dd = (pixels[o] - rgb[k][0]) ** 2 + (pixels[o + 1] - rgb[k][1]) ** 2 + (pixels[o + 2] - rgb[k][2]) ** 2; if (dd < bestD) { bestD = dd; best = k; } }
      const col = Math.min(size - 1, x >> 2), row = Math.min(size - 1, y >> 2); out[(row * size + col) * K + best] += 1 / 16;
    }
    return out;
  }
  // Moves the water streaks and the falling rain; each clock wraps after a whole cycle so nothing jumps.
  stepRain(timestamp) {
    const rain = this.rain; if (!rain) return; const seconds = timestamp / 1000;
    if (rain.uniforms) rain.uniforms.time.value = seconds % (WATER_SPACING / WATER_SPEED * 1000);
    photoUniforms.rainTime.value = seconds % 400; // the ground's water patterns repeat every 10/3 s, so 400 s wraps cleanly
    if (rain.fall) {
      const u = rain.fall.uniforms, distance = this.camera.position.distanceTo(this.controls.target);
      u.time.value = seconds % (RAIN_FALL_SECONDS * 1000);
      u.centre.value.copy(this.controls.target); u.viewDistance.value = distance;
      u.extent.value.set(distance * .7, distance * .9, distance * .7);
    }
  }
  // loop = true when the render loop keeps itself going; any other call means something changed and is drawn at once.
  requestRender(loop = false) { if (!loop) this._renderDirty = true; if (this.disposed || this._renderFrame) return; if (typeof requestAnimationFrame !== 'function') { this._advancePanAnimation(this._now()); this.controls.update(); this.renderScene(); return; } this._renderFrame = requestAnimationFrame(timestamp => { this._renderFrame = 0; const animating = this._advancePanAnimation(Number.isFinite(timestamp) ? timestamp : this._now()); const changed = this.controls.update(), now = Number.isFinite(timestamp) ? timestamp : this._now();
      // When only the rain is moving (nobody is moving the map), it is drawn at 30 frames a second, or 10 while the window
      // is in the background: the animation needs no more, and on integrated graphics a non-stop full-rate loop slows
      // every other tab and the map's own response to the next drag.
      if (this.rain && !animating && !changed && !this._panAnimation && !this._renderDirty) { const focused = globalThis.document?.hasFocus?.() ?? true; if (now - (this._lastRainFrame || 0) < (focused ? 33 : 100)) { this.requestRender(true); return; } }
      this._renderDirty = false; this._lastRainFrame = now;
      if (this.rain) this.stepRain(now); this.renderScene(); if (animating || changed || this._panAnimation || this.rain) this.requestRender(true); }); }
  updateScreenLineStyle() { const distance = this.camera?.position?.distanceTo(this.controls?.target) || 0, span = Math.max((this.widthM || 1) * WORLD_SCALE, (this.depthM || 1) * WORLD_SCALE), far = distance / Math.max(span * .8, 1); for (const group of [...Object.values(this.layers || {}), this.selectionOverlay].filter(Boolean)) for (const object of group.children || []) { const material = object.material, uniforms = material?.uniforms; if (!material?.userData?.screenLine || !uniforms) continue; const layer = material.userData.screenLineLayer, fade = layer === 'climats' ? clamp(1 - Math.max(0, far - 1) * .16, .2, 1) : 1; uniforms.opacity.value = material.userData.baseOpacity * fade; uniforms.linewidth.value = material.userData.baseLineWidth * (layer === 'climats' ? clamp(1 - Math.max(0, far - 1) * .08, .76, 1) : 1); } }
  // The stage size is remembered between resizes: measuring it every frame, right after the labels were moved, made the
  // browser recalculate the page layout each frame.
  renderScene() { if (this.labels && this.labelItems) { const rect = this._stageSize ||= { width: this.container.clientWidth, height: this.container.clientHeight }, placed = (this.labelObstacles?.() || []).slice(), labelVector = this._labelVector ||= new THREE.Vector3(), radiusMetres = this.camera.position.distanceTo(this.controls.target) / WORLD_SCALE; const shownFirst = this.labelItems.filter(item => !item.el.hidden).concat(this.labelItems.filter(item => item.el.hidden)), now = performance.now(); let dwelling = false;
      /* Labels keep their state between frames, so moving the map does not make them flash:
         - a shown label holds its place while it overlaps a neighbour by a few pixels; a hidden one needs a few pixels of clear space;
         - a label that just appeared or disappeared keeps that state for LABEL_DWELL_MS;
         - a label that was nudged keeps the same nudge; the screen edge and the zoom cut-off each get a small buffer. */
      for (const item of shownFirst) { const wasShown = !item.el.hidden, recent = item.since != null && now - item.since < LABEL_DWELL_MS;
        const hide = () => { if (wasShown) { item.el.hidden = true; item.since = now; } };
        if (!item.p || radiusMetres > LABEL_TIER_MAX_RADIUS[item.tier ?? 0] * (wasShown ? 1.08 : .96)) { hide(); continue; }
        if (item.y === undefined) item.y = this.elevationAt(item.p.x, item.p.z); const y = item.y; if (y == null) { hide(); continue; }
        const v = labelVector.set(item.p.x, y + 2, item.p.z).project(this.camera); if (!(v.z >= -1 && v.z <= 1)) { hide(); continue; }
        const x = (v.x * .5 + .5) * rect.width, yy = (-v.y * .5 + .5) * rect.height, width = item.w || 80, height = item.h || 24, nudge = height * .35, offsets = item.area > LABEL_SHIFTABLE_AREA ? [0, -nudge, nudge, -height, height, -1.6 * height, 1.6 * height, -2.3 * height, 2.3 * height] : [0, -nudge, nudge];
        const pad = wasShown ? -LABEL_HYSTERESIS_PX : LABEL_HYSTERESIS_PX, edge = wasShown ? 8 : -2, order = offsets.map((_, k) => k); if (item.off != null && item.off < offsets.length) { order.splice(item.off, 1); order.unshift(item.off); }
        const boxAt = k => { const top = yy + offsets[k]; return { left: x - width / 2 - 5, right: x + width / 2 + 5, top: top - height / 2 - 1, bottom: top + height / 2 + 1, ly: top }; };
        let box = null, used = null;
        for (const k of order) { const c = boxAt(k); if (c.left >= -edge && c.right <= rect.width + edge && c.top >= -edge && c.bottom <= rect.height + edge && !placed.some(p => c.left - pad < p.right && c.right + pad > p.left && c.top - pad < p.bottom && c.bottom + pad > p.top)) { box = c; used = k; break; } }
        if (box && !wasShown && recent) { dwelling = true; continue; } /* just hidden: wait before showing it again */
        if (!box && wasShown && recent) { used = item.off ?? 0; box = boxAt(used); dwelling = true; } /* just shown: keep it a moment longer */
        if (!box) { hide(); continue; }
        item.off = used; item.el.style.left = `${x}px`; item.el.style.top = `${box.ly}px`; item.el.style.transform = 'translate(-50%, -50%)'; placed.push(box);
        if (!wasShown) { item.el.hidden = false; item.since = now; } }
      if (dwelling) { clearTimeout(this._labelDwellTimer); this._labelDwellTimer = setTimeout(() => this.requestRender(), LABEL_DWELL_MS + 20); } } const north = this.container.querySelector('.north-mark'); if (north) { const azimuth = Math.atan2(this.camera.position.x - this.controls.target.x, this.camera.position.z - this.controls.target.z); north.style.transform = `rotate(${azimuth}rad)`; } this.updateScreenLineStyle(); this.updateHaze(); this.renderer.render(this.scene, this.camera); if (this.drawCrossfade(performance.now())) this.requestRender(true); this.releaseRetiredMaterials(); }
  animate() { this.requestRender(); }
  updateScreenLineResolution() { const resolution = new THREE.Vector2(this.renderer?.domElement?.width || this.canvas?.width || 1, this.renderer?.domElement?.height || this.canvas?.height || 1); for (const group of [...Object.values(this.layers || {}), this.selectionOverlay].filter(Boolean)) for (const object of group.children || []) { const material = object.material, uniform = material?.uniforms?.resolution; if (uniform) uniform.value.copy(resolution); } }
  pixelRatio() { return Math.min(globalThis.devicePixelRatio || 1, 1.5); }
  resize() { this._stageSize = null; const w = this.container.clientWidth || this.canvas.clientWidth || 800, h = this.container.clientHeight || this.canvas.clientHeight || 600; this.renderer.setPixelRatio(this.pixelRatio()); this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.updateScreenLineResolution(); this.requestRender(); }
  // Distant land fades into the sky colour. The fade ends just before the terrain mesh does, measured along the view
  // and to either side, so its edge never shows as a hard horizon; the place in focus stays clear.
  updateHaze() {
    const fog = this.scene.fog, cam = this.camera.position, d = cam.distanceTo(this.controls.target), view = this.camera.getWorldDirection(new THREE.Vector3());
    fog.near = d * 2.2; fog.far = d * 7;
    const b = this.bounds, flat = Math.hypot(view.x, view.z);
    this.hazeUniforms.hazeNear.value = fog.near; this.hazeUniforms.hazeFar.value = fog.far;
    if (!b || flat < .05) return; // looking straight down: no horizon
    const west = this.worldPoint(b[0], b[3]), east = this.worldPoint(b[2], b[1]), heading = Math.atan2(view.z, view.x);
    let edge = Infinity;
    for (const turn of [-HAZE_SIDE, 0, HAZE_SIDE]) {
      const dx = Math.cos(heading + turn), dz = Math.sin(heading + turn);
      const tx = dx > 0 ? (east.x - cam.x) / dx : dx < 0 ? (west.x - cam.x) / dx : Infinity, tz = dz > 0 ? (east.z - cam.z) / dz : dz < 0 ? (west.z - cam.z) / dz : Infinity;
      const t = Math.min(tx, tz); if (!(t > 0) || !Number.isFinite(t)) continue;
      const depth = t * (dx * view.x + dz * view.z) + (this.controls.target.y - cam.y) * view.y; // view depth, which is what fog measures
      if (depth > 0) edge = Math.min(edge, depth);
    }
    if (!Number.isFinite(edge)) return;
    // Close views end near the focus, so a clear zone wins over reaching the edge exactly: the vineyards are never hazed.
    fog.far = Math.max(edge * .96, d * 2.6); fog.near = Math.min(Math.max(fog.far * HAZE_START, d * 1.7), fog.far * .85);
    this.hazeUniforms.hazeNear.value = fog.near; this.hazeUniforms.hazeFar.value = fog.far;
  }
  rasterSize() { return Math.min(MAX_RASTER_SIZE, 2048); }
  // Decoded photo tiles are kept for reuse; the oldest are released past the limit, except any a photo being composed
  // still needs (closing one of those made the whole composed photo fail, leaving the terrain grey).
  cacheImage(key, image) { if (!image) return; if (this.imageCache.has(key)) this.imageCache.delete(key); this.imageCache.set(key, image); const busy = this._tilesInUse || new Set(); for (const oldest of [...this.imageCache.keys()]) { if (this.imageCache.size <= IMAGE_CACHE_LIMIT) break; const evicted = this.imageCache.get(oldest); if (busy.has(evicted)) continue; this.imageCache.delete(oldest); if (oldest.startsWith('tile:')) evicted?.close?.(); } }
  clear() { this._buildGeneration = (this._buildGeneration || 0) + 1; if (this._buildQueue) this._buildQueue.length = 0; const keepOld = this.progressiveBuild ? this.takeShownLayers() : null; this._panAnimation = null; this._panViewDirty = false; this._cancelCadastreLOD(); this.textureLoadToken = (this.textureLoadToken || 0) + 1; if (this._renderFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._renderFrame); this._renderFrame = 0; clearTimeout(this._viewTimer); this.pendingViewChange = false; for (const child of [...this.world.children]) this.disposeObject(child); this.world.clear(); this.layers = {}; this.selectionOverlay = null; this.terrain = null; this.terrainTexture = null; this.textureRequested = false; this.aocCanvas = null; this.aocContext = null; this.aocTexture = null; this.aocMaterial = null; this.aocMesh = null; if (keepOld) { this._fadingGroup = keepOld; this.world.add(keepOld); } else { this.labelItems = []; this.labels?.replaceChildren(); } }
  // An owner's parcels (cadastre features with rings and bounds), outlined in gold over the map. They are redrawn with
  // every new scene, and with { fit } the view moves to frame them.
  showOwnerParcels(features = [], { fit = false } = {}) {
    this._ownerParcels = Array.isArray(features) ? features : [];
    this.rebuildOwnerHighlight((this._incomingGroup?.visible ? this._incomingGroup : null) || this.world);
    if (fit && this._ownerParcels.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const f of this._ownerParcels) { const b = Array.isArray(f.bounds) ? f.bounds : null; if (!b) continue; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
      if (Number.isFinite(x0)) { const view = this.captureView(); if (this.restoreView({ ...view, easting: (x0 + x1) / 2, northing: (y0 + y1) / 2, radiusMetres: clamp(Math.max(x1 - x0, y1 - y0) * 1.1, 500, 12000) })) this.scheduleViewChange(); }
    }
    this.requestRender();
  }
  // Commune boundaries (data/communes.json.gz, the app passes them in): dashed lines draped on the terrain, like the
  // dashed commune limits of printed wine maps. Edges two communes share are drawn once.
  setCommuneBoundaries(communes = []) { this._communes = Array.isArray(communes) ? communes : []; if (this.terrain) { this.rebuildCommuneBoundaries(this._communeLines?.parent || this.sceneParent()); this.requestRender(); } }
  rebuildCommuneBoundaries(parent) {
    const old = this._communeLines; if (old) { old.parent?.remove(old); this.disposeObject(old); this._communeLines = null; }
    if (!this._communes?.length || !this.terrain || !Array.isArray(this.bounds)) return;
    const [bx0, by0, bx1, by1] = this.bounds.map(Number), DASH = 55, GAP = 35, STEP = 30, segments = [], seen = new Set();
    const key = (a, b) => { const ka = `${Math.round(a[0])},${Math.round(a[1])}`, kb = `${Math.round(b[0])},${Math.round(b[1])}`; return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };
    const drape = (x, y) => { const p = this.worldPoint(x, y), h = this.elevationAt(p.x, p.z); return h == null ? null : [p.x, h + .2, p.z]; };
    const emit = (a, b) => { const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / STEP)); let prev = drape(a[0], a[1]); for (let j = 1; j <= n; j++) { const t = j / n, next = drape(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); if (prev && next) segments.push(...prev, ...next); prev = next; } };
    for (const c of this._communes) {
      const cb = (c.bounds || c.bounds2154 || []).map(Number); if (cb.length < 4 || cb[2] < bx0 || cb[0] > bx1 || cb[3] < by0 || cb[1] > by1) continue;
      const rings = c.rings || []; const outers = Array.isArray(rings[0]?.[0]?.[0]) ? rings.map(p => p[0]) : Array.isArray(rings[0]?.[0]) ? [rings[0]] : [];
      for (const ring of outers) {
        let phase = 0; // distance into the current dash + gap cycle, carried along the ring
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1], b = ring[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!len) continue;
          const shared = seen.has(key(a, b)); seen.add(key(a, b));
          let d = 0;
          while (d < len) { const inDash = phase < DASH, room = (inDash ? DASH : DASH + GAP) - phase, step = Math.min(room, len - d);
            if (inDash && !shared) { const t0 = d / len, t1 = (d + step) / len; emit([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]); }
            d += step; phase = (phase + step) % (DASH + GAP); }
        }
      }
    }
    if (!segments.length) return;
    const group = new THREE.Group(); group.name = 'commune-boundaries'; group.visible = this._communesVisible !== false;
    const geometry = this.screenLineGeometry(segments);
    const halo = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0x2a0d08, width: 5.4, opacity: .4, layer: 'communes' })), line = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0xa8482f, width: 2.8, opacity: .9, layer: 'communes' }));
    halo.renderOrder = 30; line.renderOrder = 31; halo.userData = line.userData = { kind: 'commune-boundaries', screenLine: true }; group.add(halo, line);
    (parent || this.world).add(group); this._communeLines = group;
    for (const m of [halo, line]) m.material.uniforms.resolution.value.copy(this.renderer.getDrawingBufferSize(new THREE.Vector2()));
  }
  // Compare: the two crus outlined in their A and B colours (rings in EPSG:2154), draped like the owner highlight.
  setCompareOutlines(items = []) { this._compareOutlines = Array.isArray(items) ? items : []; this.rebuildCompareOutlines((this._incomingGroup?.visible ? this._incomingGroup : null) || this.world); this.requestRender(); }
  rebuildCompareOutlines(parent) {
    const old = this._compareGroup; if (old) { old.parent?.remove(old); this.disposeObject(old); this._compareGroup = null; }
    if (!this._compareOutlines?.length || !this.terrain) return;
    const group = new THREE.Group(); group.name = 'compare-outlines';
    for (const item of this._compareOutlines) { const segments = []; for (const part of partsOf({ rings: item.rings })) for (const ring of [part.ring, ...(part.holes || [])]) { const pts = this.drapedPoints(ring); for (let i = 1; i < pts.length; i++) segments.push(pts[i - 1].x, pts[i - 1].y + .3, pts[i - 1].z, pts[i].x, pts[i].y + .3, pts[i].z); }
      if (!segments.length) continue; const geometry = this.screenLineGeometry(segments), halo = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0x120c06, width: 8.5, opacity: .7, layer: 'owner' })), line = new THREE.Mesh(geometry, this.screenLineMaterial({ color: item.color || 0xffd257, width: 4.4, opacity: .99, layer: 'owner' }));/* transparent too, so it draws after (over) its halo */
      halo.renderOrder = 42; line.renderOrder = 43; halo.userData = line.userData = { kind: 'compare-outline', screenLine: true }; group.add(halo, line); for (const m of [halo, line]) m.material.uniforms.resolution.value.copy(this.renderer.getDrawingBufferSize(new THREE.Vector2())); }
    (parent || this.world).add(group); this._compareGroup = group;
  }
  rebuildOwnerHighlight(parent) {
    const old = this._ownerHighlight; if (old) { old.parent?.remove(old); this.disposeObject(old); this._ownerHighlight = null; }
    if (!this._ownerParcels?.length || !this.terrain) return;
    const segments = [];
    for (const feature of this._ownerParcels) for (const part of partsOf(feature)) for (const ring of [part.ring, ...(part.holes || [])]) { const pts = this.drapedPoints(ring); for (let i = 1; i < pts.length; i++) segments.push(pts[i - 1].x, pts[i - 1].y + .3, pts[i - 1].z, pts[i].x, pts[i].y + .3, pts[i].z); }
    if (!segments.length) return;
    const group = new THREE.Group(); group.name = 'owner-parcels';
    const geometry = this.screenLineGeometry(segments);
    const halo = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0x1d1408, width: 6.5, opacity: .4, layer: 'owner' })), line = new THREE.Mesh(geometry, this.screenLineMaterial({ color: 0xffd257, width: 3.4, opacity: 1, layer: 'owner' }));
    halo.renderOrder = 40; line.renderOrder = 41; halo.userData = line.userData = { kind: 'owner-parcels', screenLine: true }; group.add(halo, line);
    (parent || this.world).add(group); this._ownerHighlight = group;
    for (const m of [halo, line]) m.material.uniforms.resolution.value.copy(this.renderer.getDrawingBufferSize(new THREE.Vector2()));
  }
  // Where a build puts its objects: a hidden group in progressive mode (shown all at once when complete), else the world.
  sceneParent() { if (!this.progressiveBuild) return this.world; if (!this._incomingGroup) { this._incomingGroup = Object.assign(new THREE.Group(), { name: 'incoming-scene', visible: false }); this._swapStart = performance.now(); this.world.add(this._incomingGroup); } return this._incomingGroup; }
  // The scene now on screen, detached so clear() leaves it drawn until the next build is complete. A scene that was
  // still being built and never shown is thrown away instead.
  takeShownLayers() { this._prewarmed = false; const shown = this._incomingGroup?.visible ? this._incomingGroup : this._fadingGroup; for (const group of [this._fadingGroup, this._incomingGroup]) if (group && group !== shown) { this.world.remove(group); this.disposeObject(group); } this._incomingGroup = this._fadingGroup = null; this._pendingRainUniforms = null; this._pendingLabels?.holder.remove(); this._pendingLabels = null; if (shown) this.world.remove(shown); return shown || null; }
  // The new scene can replace the old one once all its layers are built and its aerial photo has arrived (or after
  // 8 s without it, so a missing photo cannot hold the map back for ever).
  terrainReady() { if (this.mode !== 'aerial') return true; const url = this.sceneJSON?.texture || this.indexVillage?.texture, tiles = this.sceneJSON?.textureTiles || this.indexVillage?.textureTiles; return Boolean(this.terrainTexture) || !(url || tiles?.length); }
  maybeFinishSwap() {
    clearTimeout(this._swapTimer); this._swapTimer = 0;
    const incoming = this._incomingGroup; if (!incoming || incoming.visible || this._buildQueue?.length) return;
    if (!this.terrainReady() && performance.now() - (this._swapStart || 0) < 8000) { this._swapTimer = setTimeout(() => this.maybeFinishSwap(), 80); return; }
    if (!this._prewarmed) { this._prewarmed = true; this.prewarmIncoming(); requestAnimationFrame(() => this.maybeFinishSwap()); return; }
    this._prewarmed = false; this.finishProgressiveBuild(); this.restoreSelection();
  }
  // Crossfade on the GPU: the old scene is drawn into a texture, and for 0.35 s that texture is drawn over the new scene
  // with falling opacity, so the new scene appears smoothly instead of popping in. Nothing is read back to the CPU.
  crossfadeFromCurrent() {
    if (!this.renderer?.copyFramebufferToTexture || typeof THREE.FramebufferTexture !== 'function') return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!this._fadeTexture || this._fadeTexture.image.width !== size.x || this._fadeTexture.image.height !== size.y) { this._fadeTexture?.dispose(); this._fadeTexture = new THREE.FramebufferTexture(size.x, size.y); }
    if (!this._fadeQuad) { this._fadeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); this._fadeScene = new THREE.Scene(); this._fadeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: { map: { value: null }, opacity: { value: 1 } }, transparent: true, depthTest: false, depthWrite: false,
      // The copied pixels are already exactly what was on screen, so they are drawn back unchanged (no colour conversion).
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: 'uniform sampler2D map; uniform float opacity; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, opacity); }' })); this._fadeScene.add(this._fadeQuad); }
    this._fadeQuad.material.uniforms.map.value = this._fadeTexture;
    // Draw the old scene once more and copy the screen's own pixels: drawing it again into a separate target blended the
    // transparent layers differently and made the first crossfade frame slightly brighter.
    this.renderer.render(this.scene, this.camera); this.renderer.copyFramebufferToTexture(this._fadeTexture);
    this._fadeStart = performance.now(); this._fadeUntil = this._fadeStart + 350;
  }
  // Drawn after the main scene while a crossfade runs; keeps the render loop going until it ends.
  drawCrossfade(now) {
    if (!this._fadeUntil) return false;
    const t = (now - this._fadeStart) / (this._fadeUntil - this._fadeStart);
    if (t >= 1) { this._fadeUntil = 0; return false; }
    this._fadeQuad.material.uniforms.opacity.value = 1 - t * t * (3 - 2 * t);
    const auto = this.renderer.autoClear; this.renderer.autoClear = false; this.renderer.render(this._fadeScene, this._fadeCamera); this.renderer.autoClear = auto;
    return true;
  }
  // Uploads the hidden new scene's geometry, textures and shaders to the GPU a frame ahead of the swap (drawn into a
  // 1 × 1 target nobody sees), so the swap frame itself has nothing heavy left to do.
  prewarmIncoming() {
    const incoming = this._incomingGroup; if (!incoming || !this.renderer?.setRenderTarget) return;
    this._prewarmTarget ||= new THREE.WebGLRenderTarget(1, 1);
    const fading = this._fadingGroup, fadingVisible = fading?.visible; if (fading) fading.visible = false; incoming.visible = true;
    try { this.renderer.setRenderTarget(this._prewarmTarget); this.renderer.render(this.scene, this.camera); } finally { this.renderer.setRenderTarget(null); incoming.visible = false; if (fading) fading.visible = fadingVisible; }
  }
  // Resolves once the scene being built is on screen (all layers, features and labels), so callers can look up its
  // features; resolves at once when nothing is being built.
  whenSceneReady() { if (!this._incomingGroup || this._incomingGroup.visible) return Promise.resolve(); return new Promise(resolve => (this._readyWaiters ||= []).push(resolve)); }
  // Everything swaps in one frame: the new scene appears, its rain textures take effect, the old scene is released.
  finishProgressiveBuild() { if (this._fadingGroup) this.crossfadeFromCurrent(); if (this._incomingGroup) this._incomingGroup.visible = true; this._pendingRainUniforms?.(); this._pendingRainUniforms = null; const waiters = this._readyWaiters || []; this._readyWaiters = []; queueMicrotask(() => waiters.forEach(resolve => resolve())); const labels = this._pendingLabels; this._pendingLabels = null; if (labels && this.labels) { for (const child of [...this.labels.children]) if (child !== labels.holder) child.remove(); labels.holder.style.visibility = ''; this.labelItems = labels.items; this.renderScene(); } if (this._fadingGroup) { this.world.remove(this._fadingGroup); this.disposeObject(this._fadingGroup); this._fadingGroup = null; } this.requestRender(); }
  disposeObject(object) { object.traverse(child => { child.geometry?.dispose(); for (const m of Array.isArray(child.material) ? child.material : child.material ? [child.material] : []) { if (m.map) { m.map.dispose(); m.map.userData?.renderTarget?.dispose(); } this.retireMaterial(m); } }); }
  // Materials are released after the next frame so their replacements reuse the compiled GPU programs instead of recompiling identical shaders.
  retireMaterial(material) { if (this._retiredMaterials) this._retiredMaterials.push(material); else material.dispose(); }
  // While a progressive build is still adding layers, old materials are kept: their replacements do not exist yet, and
  // releasing the old ones first would throw away the compiled programs the new ones are about to need.
  releaseRetiredMaterials() { if (this._buildQueue?.length) return; if (this._retiredMaterials?.length) for (const material of this._retiredMaterials.splice(0)) material.dispose(); }
  restoreView(view) { if (!view || !Number.isFinite(view.easting) || !Number.isFinite(view.northing)) return false; const target = this.worldPoint(view.easting, view.northing), ground = this.elevationAt(target.x, target.z); if (ground != null) target.y = ground; const direction = new THREE.Vector3(...(view.direction || [.7, .62, .7])).normalize(), radius = clamp(Number(view.radiusMetres) || 1400, 25, 30000) * WORLD_SCALE; this.controls.screenSpacePanning = view.screenSpacePanning ?? (Array.isArray(view.up) && Math.abs(Number(view.up[1])) < 0.2); this.controls.target.copy(target); this.camera.position.copy(target).add(direction.multiplyScalar(radius)); this.camera.up.fromArray(view.up || [0, 1, 0]); this.camera.near = Math.max(.1, radius / 1000); this.camera.far = Math.max(100, radius * 14); this.camera.updateProjectionMatrix(); this.controls.update(); return true; }
  localGrid(c) { const col = (Number(c.x) / WORLD_SCALE + WORLD_ORIGIN_EPSG.easting - this.bounds[0]) / this.widthM * (this.grid - 1); const northing = WORLD_ORIGIN_EPSG.northing - Number(c.z) / WORLD_SCALE; const row = (this.bounds[3] - northing) / this.depthM * (this.grid - 1); return { col, row }; }
  // Height of the terrain surface at world (x, z), bilinear between grid points; null outside the grid or beside a gap.
  // Written without temporary objects: it runs for every draped point each time a scene is built.
  elevationAt(x, z) { const grid = this.grid, last = grid - 1, col = (Number(x) / WORLD_SCALE + WORLD_ORIGIN_EPSG.easting - this.bounds[0]) / this.widthM * last, row = (this.bounds[3] - (WORLD_ORIGIN_EPSG.northing - Number(z) / WORLD_SCALE)) / this.depthM * last; if (!(col >= 0 && row >= 0 && col <= last && row <= last)) return null; const x0 = Math.floor(col), y0 = Math.floor(row), x1 = x0 < last ? x0 + 1 : last, y1 = y0 < last ? y0 + 1 : last, m = this.validMask, h = this.heightGrid, i00 = y0 * grid + x0, i01 = y0 * grid + x1, i10 = y1 * grid + x0, i11 = y1 * grid + x1; if (!m[i00] || !m[i01] || !m[i10] || !m[i11]) return null; const tx = col - x0, ty = row - y0; return ((h[i00] * (1 - tx) + h[i01] * tx) * (1 - ty) + (h[i10] * (1 - tx) + h[i11] * tx) * ty - WORLD_DATUM_ELEVATION) * WORLD_SCALE * this.exaggeration; }
  // Terrain mesh: one vertex per grid point (typed arrays, no per-point objects), two triangles per fully valid cell.
  makeTerrain() { const n = this.grid, last = n - 1, count = n * n, positions = new Float32Array(count * 3), uvs = new Float32Array(count * 2), gridUv = new Float32Array(count * 2), valid = this.validMask, k = WORLD_SCALE * this.exaggeration; for (let row = 0, i = 0; row < n; row++) { const north = this.bounds[3] - row / last * this.depthM, z = -(north - WORLD_ORIGIN_EPSG.northing) * WORLD_SCALE, v = row / last; for (let col = 0; col < n; col++, i++) { positions[i * 3] = (this.bounds[0] + col / last * this.widthM - WORLD_ORIGIN_EPSG.easting) * WORLD_SCALE; positions[i * 3 + 1] = (this.heightGrid[i] - WORLD_DATUM_ELEVATION) * k; positions[i * 3 + 2] = z; uvs[i * 2] = gridUv[i * 2] = col / last; uvs[i * 2 + 1] = 1 - v; gridUv[i * 2 + 1] = v; } } let quads = 0; const ok = i => Boolean(valid[i]); for (let r = 0; r < last; r++) for (let c = 0; c < last; c++) { const i = r * n + c; if (ok(i) && ok(i + 1) && ok(i + n) && ok(i + n + 1)) quads++; } const indices = new Uint32Array(quads * 6); let q = 0; for (let r = 0; r < last; r++) for (let c = 0; c < last; c++) { const a = r * n + c, b = a + 1, d = a + n, e = d + 1; if (!(ok(a) && ok(b) && ok(d) && ok(e))) continue; indices.set([a, d, e, a, e, b], q); q += 6; } const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2)); geo.setAttribute('gridUv', new THREE.BufferAttribute(gridUv, 2)); geo.setIndex(new THREE.BufferAttribute(indices, 1)); geo.computeVertexNormals(); const material = new THREE.MeshStandardMaterial({ color: 0x927b5f, roughness: .96, metalness: 0 }); material.onBeforeCompile = saturatePhotoTexture; const mesh = new THREE.Mesh(geo, material); mesh.receiveShadow = true; mesh.castShadow = true; mesh.userData.kind = 'terrain'; return mesh; }
  // Glides the view so a feature sits in the middle of the map area left uncovered by a bottom sheet
  // `coveredPx` tall (phones). Does nothing when it is already comfortably in view.
  revealFeature(feature, coveredPx = 0) {
    const pts = partsOf(feature).flatMap(part => part.ring); if (!pts.length || !this.sceneJSON) return;
    const xs = pts.map(v => Number(v[0])), ys = pts.map(v => Number(v[1])), centre = this.worldPoint((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
    centre.y = this.elevationAt(centre.x, centre.z) ?? 0;
    const box = this.renderer.domElement.getBoundingClientRect(), visible = Math.max(80, box.height - coveredPx), goalY = visible / 2;
    const now = centre.clone().project(this.camera), nowY = (1 - now.y) / 2 * box.height, nowX = (now.x + 1) / 2 * box.width;
    // Only move when the place is hidden behind the sheet or near an edge; otherwise changing the sheet
    // height would keep nudging the map back and forth.
    if (now.z < 1 && nowY > visible * .08 && nowY < visible - 36 && nowX > box.width * .08 && nowX < box.width * .92) return;
    // The ground point that would sit at the goal: shifting the view by (centre - that point) brings the feature there.
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(0, 1 - 2 * goalY / box.height), this.camera);
    const hit = new THREE.Vector3(); if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -centre.y), hit)) return;
    const shift = centre.clone().sub(hit); shift.y = 0;
    // Guard against near-horizon goals: never move further than the current view distance.
    if (shift.length() > this.camera.position.distanceTo(this.controls.target) * 1.2) return;
    this.cancelPanAnimation('reveal');
    // Remember the view from before the first reveal, so closing the sheet can return to it.
    if (!this._revealHome) this._revealHome = { target: this.controls.target.clone(), camera: this.camera.position.clone() };
    this.glideView(this.controls.target.clone().add(shift), this.camera.position.clone().add(shift));
  }
  // Returns to the view from before revealFeature moved it (the sheet closed). Skipped when the user has
  // panned, zoomed or rotated since: their own view wins.
  restoreRevealedView() {
    const home = this._revealHome; this._revealHome = null;
    if (home) this.glideView(home.target, home.camera);
  }
  glideView(targetTo, cameraTo, ms = 420) {
    this._revealGlideId = (this._revealGlideId || 0) + 1;
    const id = this._revealGlideId, target0 = this.controls.target.clone(), camera0 = this.camera.position.clone(), t0 = performance.now();
    if (!this._revealWatch) {
      // Only a real gesture (finger, mouse, wheel) that moves the camera counts as the user moving the map;
      // the atlas's own adjustments, such as switching to a neighbouring village, do not.
      this._revealWatch = () => { if (this._revealUserGesture && !this._revealGliding) this._revealHome = null; };
      this.controls.addEventListener('change', this._revealWatch);
      // A finger or the mouse on the map also stops a glide in progress.
      this.controls.addEventListener('start', () => { this._revealUserGesture = true; this._revealGlideId += 1; });
      this.controls.addEventListener('end', () => { this._revealUserGesture = false; });
    }
    const step = () => {
      if (id !== this._revealGlideId) return;
      const k = Math.min(1, (performance.now() - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      this._revealGliding = true;
      this.controls.target.lerpVectors(target0, targetTo, e); this.camera.position.lerpVectors(camera0, cameraTo, e); this.controls.update();
      this._revealGliding = false;
      this.requestRender();
      if (k < 1) requestAnimationFrame(step); else this.scheduleViewChange();
    };
    requestAnimationFrame(step);
  }
  // Touch gestures, as in map apps: one finger drags the ground (or orbits in Rotate mode); two fingers
  // pinch to zoom toward their midpoint, twist to rotate, or slide together vertically to tilt. A
  // two-finger gesture only starts once one movement clearly passes its dead zone, and then stays that
  // gesture, so finger drift during a pinch cannot swing the view around. Mouse input stays with OrbitControls.
  installTouchGestures(canvas) {
    const TOUCH = { tapPx: 8, tapMs: 500, pinch: .06, twist: .17, tilt: 18, twistDuringPinch: .35 };
    const touches = new Map(); let g = null, started = false;
    const point = (x, y, planeY) => {
      const box = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((x - box.left) / box.width * 2 - 1, 1 - (y - box.top) / box.height * 2), this.camera);
      const hit = new THREE.Vector3();
      return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY), hit) ? hit : null;
    };
    const distance = () => this.camera.position.distanceTo(this.controls.target);
    // Ground-anchored pan: the point under the finger(s) stays under them. Near the horizon a tiny finger
    // move maps to kilometres, so a step longer than the view distance is ignored.
    const pan = (x0, y0, x1, y1, y = this.controls.target.y) => {
      const a = point(x0, y0, y), b = point(x1, y1, y); if (!a || !b) return;
      const shift = a.sub(b); shift.y = 0; if (shift.length() > distance()) return;
      this.controls.target.add(shift); this.camera.position.add(shift);
    };
    const zoom = (x, y, factor, planeY = this.controls.target.y) => {
      const hit = point(x, y, planeY), d = distance(); if (!hit || hit.distanceTo(this.camera.position) > d * 6) return;
      const f = Math.min(this.controls.maxDistance / d, Math.max(this.controls.minDistance / d, factor));
      const keepY = this.controls.target.y;
      this.controls.target.sub(hit).multiplyScalar(f).add(hit); this.camera.position.sub(hit).multiplyScalar(f).add(hit);
      const lift = keepY - this.controls.target.y; this.controls.target.y += lift; this.camera.position.y += lift; // the orbit pivot keeps its height
    };
    const orbit = (dTheta, dPhi) => {
      const t = this.controls.target, off = this.camera.position.clone().sub(t), r = off.length();
      const phi = Math.min(this.controls.maxPolarAngle, Math.max(.08, Math.acos(Math.max(-1, Math.min(1, off.y / r))) + dPhi)), theta = Math.atan2(off.x, off.z) + dTheta;
      this.camera.position.set(t.x + r * Math.sin(phi) * Math.sin(theta), t.y + r * Math.cos(phi), t.z + r * Math.sin(phi) * Math.cos(theta));
    };
    // Camera moves apply at once (and the camera matrix is refreshed so the next finger event reads the new
    // view), but the 'change' notification, which redraws labels and streams tiles, goes out once per frame.
    let changePending = false;
    const changed = () => { this.controls.update(); this.camera.updateMatrixWorld(); if (changePending) return; changePending = true; requestAnimationFrame(() => { changePending = false; this.controls.dispatchEvent({ type: 'change' }); }); };
    // Map labels are buttons above the canvas and cover much of the Côte, so touches are taken from the
    // whole map surface: a drag that starts on a label moves the map, a clean tap on one still selects it.
    const surface = this.container || canvas.parentElement, onMap = t => t === canvas || Boolean(this.labels?.contains(t));
    const swallowNextClick = () => { const stop = ev => { ev.stopPropagation(); ev.preventDefault(); }; window.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 450); };
    const two = () => { const [a, b] = [...touches.values()]; return { d: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ay: a.y, by: b.y }; };
    const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    const groundY = (x, y) => this.raycastTerrain({ clientX: x, clientY: y })?.point?.y ?? this.controls.target.y;
    // A tap is only ever a single finger that never moved far and never became a two-finger gesture.
    const begin = tap => {
      // Drags hold the terrain height under the finger(s), so on a slope the ground stays under them.
      // Adding or lifting a finger keeps the ground height already in use: no new terrain raycast mid-gesture
      // (it is slow on a big mesh) and no change of pan plane, so the view does not jump.
      const keepY = g?.planeY;
      if (touches.size === 1) { const [t] = touches.values(); g = { n: 1, x: t.x, y: t.y, x0: t.x, y0: t.y, t0: performance.now(), tap, fromLabel: g?.fromLabel, planeY: keepY ?? groundY(t.x, t.y) }; }
      else if (touches.size === 2) { const s = two(); g = { n: 2, start: s, last: s, lock: null, twistOn: false, tap: false, fromLabel: g?.fromLabel, planeY: keepY ?? groundY(s.x, s.y) }; }
    };
    surface.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || !onMap(e.target)) return;
      e.stopImmediatePropagation();
      if (!started) { started = true; g = { fromLabel: e.target !== canvas }; this.cancelPanAnimation('touch'); this.controls.dispatchEvent({ type: 'start' }); }
      if (touches.size >= 2) return; // a third finger is ignored
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      begin(touches.size === 1);
    }, { capture: true });
    window.addEventListener('pointermove', e => {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      e.stopImmediatePropagation(); touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!g) return;
      if (g.n === 1) {
        const [t] = touches.values();
        if (g.tap && Math.hypot(t.x - g.x0, t.y - g.y0) > TOUCH.tapPx) g.tap = false;
        if (!g.tap) {
          if (this.interaction === 'pan') pan(g.x, g.y, t.x, t.y, g.planeY);
          else { const h = canvas.clientHeight || 1; orbit(-(t.x - g.x) / h * Math.PI * 1.2, -(t.y - g.y) / h * Math.PI * .9); }
          changed();
        }
        g.x = t.x; g.y = t.y; return;
      }
      const s = two(), last = g.last, start = g.start;
      if (!g.lock) {
        const scale = Math.log(s.d / start.d), twist = wrap(s.angle - start.angle), dy = s.y - start.y;
        const together = Math.sign(s.ay - start.ay) === Math.sign(s.by - start.by);
        if (Math.abs(scale) > TOUCH.pinch) g.lock = 'pinch';
        else if (Math.abs(twist) > TOUCH.twist) g.lock = 'twist';
        else if (Math.abs(dy) > TOUCH.tilt && together && Math.abs(scale) < TOUCH.pinch / 2) g.lock = 'tilt';
        // still inside the dead zone: the two fingers drag the map together (no zoom or turn yet), so the view
        // follows the hand instead of freezing and then jumping when a gesture locks in
        if (!g.lock) { pan(last.x, last.y, s.x, s.y, g.planeY); g.last = s; changed(); return; }
      }
      if (g.lock === 'pinch') {
        zoom(s.x, s.y, last.d / s.d, g.planeY);
        pan(last.x, last.y, s.x, s.y, g.planeY);
        if (!g.twistOn && Math.abs(wrap(s.angle - start.angle)) > TOUCH.twistDuringPinch) g.twistOn = true;
        if (g.twistOn) orbit(wrap(s.angle - last.angle), 0);
      } else if (g.lock === 'twist') { pan(last.x, last.y, s.x, s.y, g.planeY); orbit(wrap(s.angle - last.angle), 0); }
      else if (g.lock === 'tilt') orbit(0, -(s.y - last.y) / (canvas.clientHeight || 1) * Math.PI * .8);
      g.last = s; changed();
    }, { capture: true });
    const end = e => {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      e.stopImmediatePropagation();
      const wasTap = e.type === 'pointerup' && g?.n === 1 && g.tap && performance.now() - g.t0 < TOUCH.tapMs, fromLabel = g?.fromLabel;
      touches.delete(e.pointerId);
      if (touches.size) { begin(false); return; } // 2 -> 1: carry on dragging from where the finger is
      started = false; g = null; this.controls.dispatchEvent({ type: 'end' });
      // A tap on a label selects through the label's own click; a drag that began on one must not.
      if (wasTap) { if (!fromLabel) this.pick({ clientX: e.clientX, clientY: e.clientY }); } else if (fromLabel) swallowNextClick();
    };
    window.addEventListener('pointerup', end, { capture: true });
    window.addEventListener('pointercancel', end, { capture: true });
  }
  // Frames one feature (e.g. a cru picked in search), with the same oblique view as Home.
  focusFeature(feature) { const pts = partsOf(feature).flatMap(part => part.ring); if (!pts.length) return; const xs = pts.map(v => Number(v[0])), ys = pts.map(v => Number(v[1])), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2, half = Math.max(250, (Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2); this.resetView([cx - half, cy - half, cx + half, cy + half]); }
  resetView(bounds) { this.cancelPanAnimation('reset'); if (!this.sceneJSON) return; const b = bounds || this.focusBounds || this.bounds, center = this.worldPoint((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), ground = this.elevationAt(center.x, center.z) ?? 0, span = Math.max(b[2] - b[0], b[3] - b[1]) * WORLD_SCALE, distance = Math.max(28, span * 1.55); this.controls.screenSpacePanning = false; this.camera.up.set(0, 1, 0); center.y = ground; this.controls.target.copy(center); this.camera.position.copy(center).add(new THREE.Vector3(distance * .72, distance * .62, distance * .72)); this.camera.near = Math.max(.1, distance / 1000); this.camera.far = Math.max(200, distance * 12); this.camera.updateProjectionMatrix(); this.controls.update(); this.scheduleViewChange(); this.requestRender(); }
  topDown() { this.cancelPanAnimation('top-down'); if (!this.sceneJSON) return; const b = this.focusBounds || this.bounds, center = this.worldPoint((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), ground = this.elevationAt(center.x, center.z) ?? 0, span = Math.max(b[2] - b[0], b[3] - b[1]) * WORLD_SCALE; this.controls.screenSpacePanning = true; center.y = ground; this.controls.target.copy(center); this.camera.position.set(center.x, center.y + span * 1.35, center.z); this.camera.up.set(0, 0, -1); this.camera.near = .1; this.camera.far = span * 12; this.camera.updateProjectionMatrix(); this.controls.update(); this.requestRender(); }
  setMaterialMode() { if (!this.terrain) return; const mat = this.terrain.material; mat.color.set(this.mode === 'atlas' ? 0x9a8668 : 0xffffff); mat.map = this.mode === 'aerial' ? this.terrainTexture || null : null; mat.needsUpdate = true; const coverage = this.sceneJSON?.coverage || {}, fraction = Number(coverage.textureFraction ?? coverage.textureCoverageFraction ?? coverage.aerialCoverageFraction); const contextTerrain = coverage.contextTerrainBeyondAerialCoverage === true || coverage.contextTerrain === true || coverage.contextTerrain === 'true' || coverage.contextTerrainUrl || coverage.terrainContext || coverage.texture === 'cartographic_background' || (Number.isFinite(fraction) && fraction < .999); const hint = this.container?.querySelector('.canvas-hint'); if (hint && contextTerrain) { hint.textContent = 'Context terrain beyond aerial coverage'; hint.dataset.contextTerrain = 'true'; } const url = this.sceneJSON.texture || this.indexVillage?.texture; if (!this.terrainTexture && !this.textureRequested && (url || (this.sceneJSON?.textureTiles || this.indexVillage?.textureTiles)?.length)) this.addAerialTexture(url); if (this.terrainTexture && this._incomingGroup && !this._incomingGroup.visible) { if (this.terrainTexture !== this._uploadedTexture) { this._uploadedTexture = this.terrainTexture; try { this.renderer.initTexture?.(this.terrainTexture); } catch {} } this.maybeFinishSwap(); } this.requestRender(); }
  // Keep the public method definitions below the legacy-compatible helpers above so
  // synthetic scene payloads and future tile metadata use deterministic raster order.
  // Assembles the view's aerial photo from its tiles on the GPU: each decoded tile is uploaded once as a texture and drawn
  // as a quad into a render target that becomes the terrain's photo. Pasting the tiles on a 2D canvas instead cost up to
  // 0.3 s per large tile, and uploading that canvas stalled the page for a second or more.
  composeTilesOnGpu(items, size) {
    const target = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    target.texture.colorSpace = THREE.SRGBColorSpace; target.texture.userData.renderTarget = target;
    const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(0, this.widthM, this.depthM, 0, -1, 1), made = [];
    scene.background = new THREE.Color(0xbcb7aa);
    items.forEach((item, order) => {
      if (!item) return;
      const b = item.tile.bounds || this.bounds, w = b[2] - b[0], h = b[3] - b[1], bitmap = typeof ImageBitmap !== 'undefined' && item.image instanceof ImageBitmap;
      const texture = new THREE.Texture(item.image); texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = !bitmap; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter; texture.needsUpdate = true;
      const geometry = new THREE.PlaneGeometry(w, h); if (bitmap) { const uv = geometry.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); } // bitmaps cannot be flipped on upload
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, depthTest: false, depthWrite: false, toneMapped: false }));
      mesh.position.set((b[0] + b[2]) / 2 - this.bounds[0], (b[1] + b[3]) / 2 - this.bounds[1], 0); mesh.renderOrder = order; scene.add(mesh); made.push(mesh);
    });
    const previous = this.renderer.getRenderTarget(); this.renderer.setRenderTarget(target); this.renderer.render(scene, camera); this.renderer.setRenderTarget(previous);
    for (const mesh of made) { mesh.geometry.dispose(); mesh.material.map.dispose(); mesh.material.dispose(); }
    return target.texture;
  }
  addAerialTexture(url) { if (this.textureRequested) return; const tiles = this.sceneJSON?.textureTiles || this.indexVillage?.textureTiles; this.textureRequested = true; const token = this.textureLoadToken = (this.textureLoadToken || 0) + 1, size = this.rasterSize(); if (Array.isArray(tiles) && tiles.length) { const sources = tiles.filter(tile => tile.url || tile.texture), loaded = new Array(sources.length).fill(null); let loadedCount = 0; const finish = () => { if (loadedCount === sources.length) { for (const item of loaded) if (item) this._tilesInUse?.delete(item.image); if (this.disposed || token !== this.textureLoadToken) return; try { this.terrainTexture = this.composeTilesOnGpu(loaded, size); } catch (error) { this.onError(error); return; } this.setMaterialMode(); } }; const loader = new THREE.TextureLoader(); sources.forEach((tile, index) => { const tileUrl = tile.url || tile.texture, tb = tile.bounds || this.bounds, fitW = Math.min(size, Math.max(64, Math.ceil((tb[2] - tb[0]) / this.widthM * size / 64) * 64)), fitH = Math.min(size, Math.max(64, Math.ceil((tb[3] - tb[1]) / this.depthM * size / 64) * 64)), key = `tile:${tileUrl}@${fitW}x${fitH}`, cached = this.imageCache.get(key); if (cached) { (this._tilesInUse ||= new Set()).add(cached); loaded[index] = { tile, image: cached }; loadedCount += 1; finish(); return; } const accept = image => { if (this.disposed || token !== this.textureLoadToken) return; (this._tilesInUse ||= new Set()).add(image); this.cacheImage(key, image); loaded[index] = { tile, image }; loadedCount += 1; finish(); }; /* A tile that fails is skipped (and reported unless optional), so it cannot hold back the rest. */ const failed = e => { if (!tile.optional) this.onError(e); loadedCount += 1; finish(); }; /* the rest of the photo still appears */ if (typeof createImageBitmap === 'function' && typeof fetch === 'function') { /* createImageBitmap decodes off the main thread; drawing an <img> would decode synchronously during compositing. */ const decode = src => fetch(src).then(res => { if (!res.ok) throw new Error(`Texture request failed (${res.status})`); return res.blob(); }).then(blob => createImageBitmap(blob, { resizeWidth: fitW, resizeHeight: fitH, resizeQuality: 'high' })); /* decoded straight to the size it covers in the composed photo: a wide view takes up to a dozen village photos, and decoding each at full size could run out of memory */ decode(tileUrl).catch(error => tile.fallbackUrl && tile.fallbackUrl !== tileUrl ? decode(tile.fallbackUrl) : Promise.reject(error)).then(accept).catch(failed); return; } loader.load(tileUrl, texture => { const image = texture.image; texture.dispose(); accept(image); }, undefined, failed); }); return; } if (!url) return; const key = `url:${url}`, cached = this.imageCache.get(key); if (cached) { const texture = new THREE.Texture(cached); texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true; this.terrainTexture = texture; this.setMaterialMode(); return; } const fallback = this.sceneJSON?.textureFallback; const load = (src, onFail) => new THREE.TextureLoader().load(src, texture => { if (this.disposed || token !== this.textureLoadToken) { texture.dispose(); return; } this.cacheImage(key, texture.image); texture.colorSpace = THREE.SRGBColorSpace; this.terrainTexture = texture; this.setMaterialMode(); }, undefined, onFail); load(url, e => fallback && fallback !== url ? load(fallback, err => this.onError(err)) : this.onError(e)); }
  dispose() { this.disposed = true; this._cancelCadastreLOD(); if (this._renderFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._renderFrame); this._renderFrame = 0; clearTimeout(this._viewTimer); this.clear(); this.resizeObserver?.disconnect(); this.canvas.removeEventListener('pointerdown', this._onPointerDown); this.canvas.removeEventListener('pointerup', this._onPointerUp); this.canvas.removeEventListener('pointercancel', this._onPointerCancel); this.canvas.removeEventListener('dblclick', this._onDoubleClick); this.controls.removeEventListener('start', this._onControlsStart); this.controls.removeEventListener('end', this._onControlsEnd); this.controls.removeEventListener('change', this._onControlsChange); this.controls.dispose(); this.releaseRetiredMaterials(); this.renderer.dispose(); }
}
export default AtlasRenderer;
