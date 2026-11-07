import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorThree = pathToFileURL(resolve(root, 'dist/vendor/three.module.js')).href;
const temp = mkdtempSync(join(tmpdir(), 'burgundy-renderer-profile-'));
const orbitPath = join(temp, 'OrbitControls.mjs');
const rendererPath = join(temp, 'atlas-renderer.mjs');
writeFileSync(orbitPath, readFileSync(resolve(root, 'dist/vendor/OrbitControls.js'), 'utf8').replaceAll("from 'three'", `from '${vendorThree}'`));
writeFileSync(rendererPath, readFileSync(resolve(root, 'dist/atlas-renderer.js'), 'utf8')
  .replace("from 'three'", `from '${vendorThree}'`)
  .replace("from 'three/addons/controls/OrbitControls.js'", `from '${pathToFileURL(orbitPath).href}'`));

globalThis.document = {
  createElement(type) {
    if (type !== 'canvas') return { style: {}, addEventListener() {}, removeEventListener() {} };
    const context = { clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, fill() {} };
    return { width: 0, height: 0, getContext: () => context };
  },
  body: { append() {} },
};

const THREE = await import(vendorThree);
const { AtlasRenderer } = await import(pathToFileURL(rendererPath).href);

const sceneFiles = ['priss-71360', 'beaune-21054', 'meursault-21412'];
const scene = name => JSON.parse(gunzipSync(readFileSync(resolve(root, `dist/data/scenes/${name}.json.gz`))));
const cadastre = code => JSON.parse(gunzipSync(readFileSync(resolve(root, `dist/data/cadastre/${code}.json.gz`))));
const now = () => performance.now();
const stat = (samples) => {
  const ordered = [...samples].sort((a, b) => a - b);
  return { min: ordered[0], median: ordered[Math.floor(ordered.length / 2)], max: ordered.at(-1) };
};
const makeRenderer = () => {
  const r = Object.create(AtlasRenderer.prototype);
  r.controls = { target: new THREE.Vector3(), screenSpacePanning: false, mouseButtons: {}, touches: {}, update() {} };
  r.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
  r.requestRender = () => {};
  r.renderer = { domElement: { width: 640, height: 480 }, info: { render: { calls: 0 } } };
  r.imageCache = new Map(); r.sceneJSON = null; r.exaggeration = 3; r.bounds = [850000, 6650000, 850100, 6650100];
  r.widthM = r.depthM = 100; r.grid = 2; r.heightGrid = [10, 20, 30, 40]; r.validMask = [true, true, true, true];
  r.minElevation = 10; r.maxElevation = 40; r.layers = {}; r.world = new THREE.Group(); r.featureIndex = [];
  r.classificationVisibility = {}; r.selectionOverlay = null; r.selectedFeature = null; r.cadastralParcels = []; r.cadastralMeta = {};
  r._cadastreEnabled = true; r.mode = 'atlas'; r.aocOpacity = .25; r.labels = null; r.container = { querySelector: () => null };
  r._renderFrame = 0; r._panAnimation = null; r.pendingViewChange = false; r.disposed = false;
  r.onSelect = () => {}; r.onError = e => { throw e; }; r.onViewChange = () => {};
  return r;
};
const configure = (r, d) => {
  r.sceneJSON = d; r.indexVillage = { bounds: d.bounds, bounds2154: d.bounds, id: d.id };
  r.bounds = d.bounds.map(Number); r.widthM = r.bounds[2] - r.bounds[0]; r.depthM = r.bounds[3] - r.bounds[1];
  r.grid = d.gridSize; r.heightGrid = d.heights; r.validMask = r.readMask(d.validMask); r.minElevation = d.minElevation; r.maxElevation = d.maxElevation;
  r.camera.position.set(0, 40, 0); r.controls.target.set(0, 0, 0); r.world = new THREE.Group(); r.layers = {};
};
const count = (r) => Object.fromEntries(Object.entries(r.layers).map(([k, g]) => [k, g.children.length]));

const results = [];
for (const name of sceneFiles) {
  const d = scene(name), r = makeRenderer(); configure(r, d);
  const samples = [];
  for (let i = 0; i < 4; i++) { r.layers = {}; r.featureIndex = []; r.lineBuffers = {}; const t = now(); r.addFeatures(); samples.push(now() - t); }
  results.push({ op: 'addFeatures', scene: name, source: { climats: d.climats?.length || 0, parcels: d.parcels?.length || 0, roads: d.roads?.length || 0, forests: d.forests?.length || 0, buildings: d.buildings?.length || 0, water: (d.waterSurfaces?.length || 0) + (d.waterLines?.length || 0) }, featureIndex: r.featureIndex.length, layerMeshes: count(r), ms: stat(samples) });
}

const d = scene('beaune-21054'), r = makeRenderer(); configure(r, d); r.addFeatures();
const c = cadastre('21054');
const setSamples = [];
for (let i = 0; i < 4; i++) { const t = now(); r.setCadastralParcels(c.parcels, c); setSamples.push(now() - t); }
const allCadastre = r.cadastralParcels.length;
r.controls.target.copy(r.worldPoint((d.bounds[0] + d.bounds[2]) / 2, (d.bounds[1] + d.bounds[3]) / 2));
r.camera.position.copy(r.controls.target).add(new THREE.Vector3(0, 12, 0));
const lodSamples = [];
for (let i = 0; i < 4; i++) { r._cadastreLodKey = null; const t = now(); r.updateCadastreLOD(true); lodSamples.push(now() - t); }
const stableSamples = [];
for (let i = 0; i < 20; i++) { const t = now(); r.updateCadastreLOD(); stableSamples.push(now() - t); }
const cadastreVertices = r.layers.cadastre.children[0]?.geometry?.attributes?.position?.count || 0;
results.push({ op: 'setCadastralParcels', scene: 'beaune-21054', sourceFeatures: c.parcels.length, deduped: allCadastre, ms: stat(setSamples) });
results.push({ op: 'updateCadastreLOD-close', scene: 'beaune-21054', indexed: r.featureIndex.filter(x => x.key === 'cadastre').length, visible: r.featureIndex.filter(x => x.key === 'cadastre' && x.cadastreVisible).length, meshChildren: r.layers.cadastre.children.length, meshVertices: cadastreVertices, ms: stat(lodSamples), sameBucketMs: stat(stableSamples) });

const villageSamples = [];
const phaseSamples = Object.fromEntries(['clear', 'build', 'addFeatures', 'buildAocOverlay', 'drawAocOverlay', 'rebuildBuildings'].map(k => [k, []]));
for (const key of Object.keys(phaseSamples)) {
  const original = r[key].bind(r);
  r[key] = (...args) => { const t = now(); const value = original(...args); phaseSamples[key].push(now() - t); return value; };
}
for (let i = 0; i < 3; i++) { const t = now(); await r.setVillage({ id: d.id, bounds: d.bounds }, d, { preserveView: true }); villageSamples.push(now() - t); }
results.push({ op: 'setVillage-full-rebuild', scene: 'beaune-21054', ms: stat(villageSamples), phasesMs: Object.fromEntries(Object.entries(phaseSamples).map(([k, v]) => [k, stat(v)])), featureIndex: r.featureIndex.length, layerMeshes: count(r) });

console.log(JSON.stringify({ node: process.version, results }, null, 2));
