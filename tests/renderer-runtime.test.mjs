import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorThree = pathToFileURL(resolve(root, 'dist/vendor/three.module.js')).href;
const temp = mkdtempSync(join(tmpdir(), 'burgundy-renderer-'));
const orbitPath = join(temp, 'OrbitControls.mjs');
const rendererPath = join(temp, 'atlas-renderer.mjs');
const orbitSource = readFileSync(resolve(root, 'dist/vendor/OrbitControls.js'), 'utf8').replaceAll("from 'three'", `from '${vendorThree}'`);
const rendererSource = readFileSync(resolve(root, 'dist/atlas-renderer.js'), 'utf8')
  .replace("from 'three'", `from '${vendorThree}'`)
  .replace("from 'three/addons/controls/OrbitControls.js'", `from '${pathToFileURL(orbitPath).href}'`)
  .replace("from './region.js'", `from '${pathToFileURL(resolve(root, 'dist/region.js')).href}'`)
  .replace("from './simulation.js'", `from '${pathToFileURL(resolve(root, 'dist/simulation.js')).href}'`);
writeFileSync(orbitPath, orbitSource);
writeFileSync(rendererPath, rendererSource);

const THREE = await import(vendorThree);
const { AtlasRenderer } = await import(pathToFileURL(rendererPath).href);

function prototypeRenderer() {
  const renderer = Object.create(AtlasRenderer.prototype);
  renderer.controls = {
    target: new THREE.Vector3(),
    screenSpacePanning: false,
    mouseButtons: {},
    touches: {},
    update() {},
  };
  renderer.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
  renderer.requestRender = () => {};
  renderer.renderer = { domElement: { width: 640, height: 480 } };
  renderer.imageCache = new Map();
  renderer.sceneJSON = { buildings: [] };
  renderer.exaggeration = 1;
  renderer.bounds = [850000, 6650000, 850100, 6650100];
  renderer.widthM = renderer.depthM = 100;
  renderer.grid = 2;
  renderer.heightGrid = [10, 20, 30, 40];
  renderer.validMask = [true, true, true, true];
  renderer.minElevation = 10;
  renderer.maxElevation = 40;
  renderer.layers = { buildings: new THREE.Group(), parcels: new THREE.Group() };
  renderer.world = new THREE.Group();
  renderer.featureIndex = [];
  renderer.classificationVisibility = {};
  renderer.selectionOverlay = null;
  renderer.terrain = renderer.makeTerrain();
  renderer.aocMesh = new THREE.Mesh(renderer.terrain.geometry.clone(), new THREE.MeshBasicMaterial());
  renderer._testNow = 0;
  renderer._now = () => renderer._testNow;
  return renderer;
}

function runFrame(renderer, frames, timestamp) {
  renderer._testNow = timestamp;
  frames.shift()(timestamp);
}

test('selection outline follows feature visibility and reports stable metadata', () => {
  const renderer = prototypeRenderer();
  const feature = { properties: { id: 'parcel-7', classification: 'Grand Cru', name: 'Clos Test', rawPropertyFacts: { key: 'facts-7', villageId: 'vosne-21714' } }, geometry: { type: 'Polygon', coordinates: [[[850010, 6650010], [850090, 6650010], [850090, 6650090], [850010, 6650010]]] } };
  renderer.featureIndex = [{ feature, key: 'parcels', ring: feature.geometry.coordinates[0], holes: [], classification: 'Grand Cru' }];
  const events = [];
  renderer.onSelect = (...args) => events.push(args);
  renderer.selectFeature(feature, 'parcels');
  assert.ok(renderer.selectionOverlay);
  assert.deepEqual(renderer.selectionOverlay.children[0].material.uniforms.resolution.value.toArray(), [640, 480]);
  assert.equal(events.at(-1)[2].kind, 'aoc-parcel');
  assert.equal(events.at(-1)[2].factsKey, 'facts-7');
  assert.equal(events.at(-1)[2].factsVillageId, 'vosne-21714');
  renderer.setClassification('grand-cru', false);
  assert.equal(renderer.selectionOverlay, null);
  renderer.setClassification('grand-cru', true);
  assert.ok(renderer.selectionOverlay);
});

test('restoreSelection clears a stale selected feature and notifies the app', () => {
  const renderer = prototypeRenderer();
  renderer.featureIndex = [];
  const events = [];
  renderer.onSelect = (...args) => events.push(args);
  renderer.selectedFeature = { feature: { properties: { id: 'gone' } }, key: 'climats', identity: 'climats:gone' };
  renderer.restoreSelection();
  assert.equal(renderer.selectedFeature, null);
  assert.deepEqual(events.at(-1).slice(1), [null, { kind: null, identity: null, layer: null }]);
});

test('selection identity separates repeated source ids by polygon geometry', () => {
  const renderer = prototypeRenderer();
  renderer.onSelect = () => {};
  const polygon = (x) => ({ properties: { id: 'rawparcelid1781', classification: 'Grand Cru' }, geometry: { type: 'Polygon', coordinates: [[[850000 + x, 6650000], [850010 + x, 6650000], [850010 + x, 6650010], [850000 + x, 6650000]]] } });
  const first = polygon(5), second = polygon(40);
  renderer.featureIndex = [
    { feature: first, key: 'parcels', ring: first.geometry.coordinates[0], holes: [], classification: 'Grand Cru' },
    { feature: second, key: 'parcels', ring: second.geometry.coordinates[0], holes: [], classification: 'Grand Cru' },
  ];
  renderer.selectFeature(second, 'parcels');
  const refreshedFirst = polygon(5), refreshedSecond = polygon(40);
  renderer.featureIndex = [
    { feature: refreshedFirst, key: 'parcels', ring: refreshedFirst.geometry.coordinates[0], holes: [], classification: 'Grand Cru' },
    { feature: refreshedSecond, key: 'parcels', ring: refreshedSecond.geometry.coordinates[0], holes: [], classification: 'Grand Cru' },
  ];
  renderer.restoreSelection();
  assert.equal(renderer.selectedFeature.feature, refreshedSecond);
});

test('interaction mode maps left drag and touch while keeping right drag on rotate', () => {
  const renderer = prototypeRenderer();
  renderer.setInteraction('pan');
  assert.equal(renderer.interaction, 'pan');
  assert.equal(renderer.controls.mouseButtons.LEFT, THREE.MOUSE.PAN);
  assert.equal(renderer.controls.mouseButtons.RIGHT, THREE.MOUSE.ROTATE);
  assert.equal(renderer.controls.touches.ONE, THREE.TOUCH.PAN);
  renderer.setInteraction('rotate');
  assert.equal(renderer.controls.mouseButtons.LEFT, THREE.MOUSE.ROTATE);
  assert.equal(renderer.controls.mouseButtons.RIGHT, THREE.MOUSE.ROTATE);
  assert.equal(renderer.controls.touches.ONE, THREE.TOUCH.ROTATE);
});

test('reports whether a directional pan is in flight', () => {
  const renderer = prototypeRenderer();
  assert.equal(renderer.isPanAnimating(), false);
  renderer._panAnimation = { start: 0 };
  assert.equal(renderer.isPanAnimating(), true);
  renderer._panAnimation = null;
  assert.equal(renderer.isPanAnimating(), false);
});

test('exaggeration updates existing terrain and overlay geometry and rejects 5x', () => {
  const renderer = prototypeRenderer();
  const original = renderer.terrain.geometry.attributes.position.getY(3);
  const overlay = renderer.aocMesh.geometry.attributes.position;
  renderer.setExaggeration(4);
  assert.equal(renderer.exaggeration, 4);
  assert.equal(renderer.terrain.geometry.attributes.position.getY(3), original * 4);
  assert.ok(Math.abs(overlay.getY(3) - (renderer.terrain.geometry.attributes.position.getY(3) + 0.06)) < 1e-5);
  renderer.setExaggeration(5);
  assert.equal(renderer.exaggeration, 1);
});

test('classification updates parcel visibility in place and keeps the image cache bounded', () => {
  const renderer = prototypeRenderer();
  let redraws = 0;
  renderer.drawAocOverlay = () => { redraws += 1; };
  renderer.classificationVisibility = {};
  renderer.sceneJSON = {};
  const parcel = { userData: { classification: 'grand-cru' }, visible: true };
  renderer.layers.parcels.children = [parcel];
  renderer.aocMesh.visible = true;
  renderer.setClassification('grand-cru', false);
  assert.equal(parcel.visible, false);
  assert.equal(redraws, 1);
  for (let i = 0; i < 60; i += 1) renderer.cacheImage(`image:${i}`, { id: i });
  assert.equal(renderer.imageCache.size, 48);
});

test('directional pan follows rotated screen axes and preserves orbit distance', () => {
  const renderer = prototypeRenderer();
  renderer.sceneJSON = { buildings: [] };
  renderer.elevationAt = () => 0;
  renderer.camera.position.set(4, 5, 6);
  renderer.controls.target.set(0, 0, 0);
  renderer.camera.lookAt(renderer.controls.target);
  renderer.camera.updateProjectionMatrix();
  renderer.camera.updateMatrixWorld();
  renderer.controls.update = () => {};
  renderer.scheduleViewChange = () => {};
  const before = renderer.camera.position.clone().sub(renderer.controls.target);
  const beforeTarget = renderer.controls.target.clone();
  assert.equal(renderer.panByDirection('right'), true);
  const rightDelta = renderer.controls.target.clone().sub(beforeTarget);
  assert.ok(Math.hypot(rightDelta.x, rightDelta.z) > 0);
  assert.ok(rightDelta.length() > 0);
  assert.ok(Math.abs(renderer.camera.position.distanceTo(renderer.controls.target) - before.length()) < 1e-6);
  assert.equal(renderer.panByDirection('left'), true);
  assert.ok(Math.hypot(renderer.controls.target.x - beforeTarget.x, renderer.controls.target.z - beforeTarget.z) < 1e-6);
  assert.equal(renderer.panByDirection('↑'), true);
  const upTarget = renderer.controls.target.clone();
  assert.equal(renderer.panByDirection('down'), true);
  assert.ok(Math.hypot(renderer.controls.target.x - upTarget.x, renderer.controls.target.z - upTarget.z) > 0);
});

test('boundary batches are screen-space quad meshes with a halo and update both endpoints vertically', () => {
  const renderer = prototypeRenderer();
  renderer.lineBuffers = { 'climats:all': { positions: [0, 0, 0, 1, 0, 0], colors: [] } };
  const group = new THREE.Group();
  renderer.flushLineBatch(group, 'climats:all');
  assert.equal(group.children.length, 2);
  assert.ok(group.children.every(child => child.isMesh && child.userData.screenLine));
  assert.ok(group.children[0].geometry.getAttribute('next'));
  assert.ok(group.children[0].geometry.getAttribute('side'));
  assert.equal(group.children[0].userData.boundaryRole, 'halo');
  assert.equal(group.children[1].userData.boundaryRole, 'core');
  renderer.layers = { climats: group };
  const nextAttribute = group.children[0].geometry.getAttribute('next');
  const nextVersion = nextAttribute.version;
  renderer.updateVerticalGeometry();
  assert.ok(nextAttribute.version > nextVersion);
});

test('cadastral parcels deduplicate by commune and parcel id while retaining source metadata', () => {
  const renderer = prototypeRenderer();
  const feature = (id, x) => ({ id, properties: { communeCode: '21267', id }, geometry: { type: 'Polygon', coordinates: [[[850000 + x, 6650000], [850010 + x, 6650000], [850010 + x, 6650010], [850000 + x, 6650000]]] } });
  renderer.setCadastralParcels([feature('A', 1), feature('A', 20), feature('B', 40)], { sourceDate: '2026-01-01', sourceUrl: 'https://example.test/cadastre', license: 'ODbL' });
  assert.equal(renderer.cadastralParcels.length, 2);
  assert.equal(renderer.cadastralMeta.sourceDate, '2026-01-01');
});

test('cadastre LOD keeps a bounded nearby neighbourhood and updates without rebuilding terrain', () => {
  const renderer = prototypeRenderer();
  renderer.camera.position.set(0, 10, 0);
  renderer.controls.target.set(0, 0, 0);
  const makeItem = (x, identity, visible = true) => ({ key: 'cadastre', identity, bounds: [850000 + x, 6650000, 850001 + x, 6650001], object: { visible } });
  const nearby = makeItem(100, 'nearby'), far = makeItem(5000, 'far');
  renderer.layers.cadastre = new THREE.Group();
  renderer.onSelect = () => {};
  renderer._cadastreEnabled = true;
  renderer.featureIndex = [nearby, far];
  renderer.updateCadastreLOD();
  assert.equal(nearby.cadastreVisible, true);
  assert.equal(far.cadastreVisible, false);
});

test('cadastre selection reports layer and source metadata and disabling it clears only that selection', () => {
  const renderer = prototypeRenderer();
  renderer.layers.cadastre = new THREE.Group();
  renderer.cadastralMeta = { sourceDate: '2026-01-01', license: 'ODbL' };
  const feature = { properties: { id: 'parcel-a', communeCode: '21267' }, geometry: { type: 'Polygon', coordinates: [[[850010, 6650010], [850090, 6650010], [850090, 6650090], [850010, 6650010]]] } };
  renderer.featureIndex = [{ feature, key: 'cadastre', ring: feature.geometry.coordinates[0], holes: [], object: { visible: true } }];
  const events = [];
  renderer.onSelect = (...args) => events.push(args);
  renderer.selectFeature(feature, 'cadastre');
  assert.equal(events.at(-1)[1], 'cadastre');
  assert.equal(events.at(-1)[2].kind, 'cadastre-parcel');
  assert.equal(events.at(-1)[2].sourceDate, '2026-01-01');
  renderer.setLayer('cadastre', false);
  assert.equal(renderer.selectedFeature, null);
  assert.equal(events.at(-1)[0], null);
});

test('cadastre batches many candidate parcels into one halo/core mesh pair and gives cadastre pick precedence', () => {
  const renderer = prototypeRenderer();
  renderer.layers.cadastre = new THREE.Group();
  const makeFeature = (x, id) => ({ id, properties: { communeCode: '21267', id }, geometry: { type: 'Polygon', coordinates: [[[850000 + x, 6650000], [850001 + x, 6650000], [850001 + x, 6650001], [850000 + x, 6650000]]] } });
  const features = Array.from({ length: 1000 }, (_, i) => makeFeature(i % 30, `p-${i}`));
  renderer.cadastralParcels = features;
  renderer.indexCadastreFeatures();
  renderer.buildCadastreBatch(renderer.featureIndex.filter(item => item.key === 'cadastre'));
  assert.equal(renderer.layers.cadastre.children.length, 2);
  renderer.layers.climats = new THREE.Group();
  renderer.camera.position.set(0, 50, 0);
  renderer.raycastTerrain = () => ({ point: new THREE.Vector3(0, 0, 0) });
  renderer.featureIndex.push({ key: 'climats', feature: { properties: { id: 'climat' } }, ring: [[849990, 6649990], [850010, 6649990], [850010, 6650010]], holes: [] });
  renderer.featureIndex.find(item => item.key === 'cadastre').cadastreVisible = true;
  renderer.onSelect = (...args) => { renderer._picked = args; };
  renderer.pick({});
  assert.equal(renderer._picked[1], 'cadastre');
});

test('cadastre checkbox state survives LOD changes and far zoom removes its highlight', () => {
  const renderer = prototypeRenderer();
  renderer.onSelect = () => {};
  renderer._cadastreEnabled = true;
  renderer.layers.cadastre = new THREE.Group();
  const feature = { properties: { id: 'p1', communeCode: '21267' }, geometry: { type: 'Polygon', coordinates: [[[850010, 6650010], [850020, 6650010], [850020, 6650020], [850010, 6650010]]] } };
  renderer.cadastralParcels = [feature];
  renderer.indexCadastreFeatures();
  renderer.camera.position.set(0, 5, 0);
  renderer.updateCadastreLOD(true);
  renderer.selectFeature(feature, 'cadastre');
  assert.ok(renderer.selectionOverlay);
  renderer.camera.position.set(0, 200, 0);
  renderer.updateCadastreLOD(true);
  assert.equal(renderer.selectionOverlay, null);
  renderer.setLayer('cadastre', false);
  renderer.camera.position.set(0, 2, 0);
  renderer.updateCadastreLOD(true);
  assert.equal(renderer.layers.cadastre.visible, false);
});

test('cadastre LOD reuses the mesh when the candidate identities are unchanged', () => {
  const renderer = prototypeRenderer();
  renderer.layers.cadastre = new THREE.Group();
  renderer._cadastreEnabled = true;
  const feature = { properties: { id: 'stable', communeCode: '21267' }, geometry: { type: 'Polygon', coordinates: [[[850010, 6650010], [850020, 6650010], [850020, 6650020], [850010, 6650010]]] } };
  renderer.cadastralParcels = [feature];
  renderer.indexCadastreFeatures();
  let builds = 0;
  renderer.buildCadastreBatch = candidates => { builds += 1; renderer.layers.cadastre.add(new THREE.Group()); assert.equal(candidates.length, 1); };
  renderer.updateCadastreLOD(true);
  renderer.updateCadastreLOD(true);
  assert.equal(builds, 1);
  assert.equal(renderer.featureIndex.find(item => item.key === 'cadastre').cadastreVisible, true);
});

test('cadastre LOD reuses the mesh when only candidate distance order changes', () => {
  const renderer = prototypeRenderer();
  renderer.layers.cadastre = new THREE.Group();
  renderer._cadastreEnabled = true;
  const makeFeature = (id, x) => ({ properties: { id, communeCode: '21267' }, geometry: { type: 'Polygon', coordinates: [[[850000 + x, 6650000], [850001 + x, 6650000], [850001 + x, 6650001], [850000 + x, 6650000]]] } });
  renderer.cadastralParcels = [makeFeature('near-a', 100), makeFeature('near-b', 300)];
  renderer.indexCadastreFeatures();
  let builds = 0;
  renderer.buildCadastreBatch = candidates => { builds += 1; renderer.layers.cadastre.add(new THREE.Group()); renderer._candidateOrder = candidates.map(item => item.identity); };
  renderer.updateCadastreLOD(true);
  const firstOrder = renderer._candidateOrder;
  renderer.controls.target.x = 250 * 0.035;
  const movedOrder = [...renderer.featureIndex].sort((a, b) => Math.abs(a.bounds[0] - 850250) - Math.abs(b.bounds[0] - 850250)).map(item => item.identity);
  renderer.updateCadastreLOD(true);
  assert.notDeepEqual(movedOrder, firstOrder);
  assert.equal(builds, 1);
});

test('cadastre LOD defers bucket changes and cancels pending work with lifecycle cleanup', async () => {
  const renderer = prototypeRenderer();
  renderer.layers.cadastre = new THREE.Group();
  renderer._cadastreEnabled = true;
  renderer._cadastreDeferralEnabled = true;
  const feature = { properties: { id: 'deferred', communeCode: '21267' }, geometry: { type: 'Polygon', coordinates: [[[850010, 6650010], [850020, 6650010], [850020, 6650020], [850010, 6650010]]] } };
  renderer.cadastralParcels = [feature];
  renderer.indexCadastreFeatures();
  renderer.updateCadastreLOD(true);
  const item = renderer.featureIndex.find(candidate => candidate.key === 'cadastre');
  assert.equal(item.cadastreVisible, true);
  let builds = 0;
  renderer.buildCadastreBatch = () => { builds += 1; };
  renderer.camera.position.set(0, 100, 0);
  renderer.updateCadastreLOD();
  assert.equal(item.cadastreVisible, true);
  assert.ok(renderer._cadastreLodTimer);
  renderer.clear();
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(builds, 0);
  assert.equal(renderer._cadastreLodTimer, 0);
});

test('cadastre LOD waits through an active gesture and rebuilds once after release', async () => {
  const renderer = prototypeRenderer();
  renderer.layers.cadastre = new THREE.Group();
  renderer._cadastreEnabled = true;
  renderer._cadastreDeferralEnabled = true;
  const feature = { properties: { id: 'gesture', communeCode: '21267' }, geometry: { type: 'Polygon', coordinates: [[[850010, 6650010], [850020, 6650010], [850020, 6650020], [850010, 6650010]]] } };
  renderer.cadastralParcels = [feature];
  renderer.indexCadastreFeatures();
  renderer.updateCadastreLOD(true);
  let builds = 0;
  renderer.buildCadastreBatch = () => { builds += 1; renderer.layers.cadastre.add(new THREE.Group()); };
  renderer._cadastreCandidateSignature = 'initial-candidate';
  renderer.layers.cadastre.add(new THREE.Group());
  renderer.camera.position.set(3000 * 0.035, 10, 0);
  renderer.controls.target.set(3000 * 0.035, 0, 0);
  renderer._controlsGestureActive = true;
  renderer.updateCadastreLOD();
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(builds, 0);
  renderer._controlsGestureActive = false;
  renderer.updateCadastreLOD();
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(builds, 1);
  assert.equal(renderer._cadastreLodTimer, 0);
});

test('forced cadastre LOD application cancels an obsolete deferred callback', async () => {
  const renderer = prototypeRenderer();
  renderer.layers.cadastre = new THREE.Group();
  renderer._cadastreEnabled = true;
  renderer._cadastreDeferralEnabled = true;
  renderer.featureIndex = [];
  const apply = renderer._applyCadastreLOD.bind(renderer);
  let applies = 0;
  renderer._applyCadastreLOD = bucket => { applies += 1; apply(bucket); };
  renderer.updateCadastreLOD(true);
  renderer.controls.target.x = 150 * 0.035;
  renderer.updateCadastreLOD();
  assert.ok(renderer._cadastreLodTimer);
  renderer.updateCadastreLOD(true);
  assert.equal(renderer._cadastreLodTimer, 0);
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(applies, 2);
});

test('screen-space segment quad keeps a constant projected width and consistent triangle winding', () => {
  const renderer = prototypeRenderer();
  const geometry = renderer.screenLineGeometry([0, 0, 0, 4, 0, 2]);
  const position = geometry.getAttribute('position');
  const next = geometry.getAttribute('next');
  const side = geometry.getAttribute('side');
  const projected = i => [position.getX(i), position.getZ(i)];
  const expanded = i => {
    const p = projected(i), q = [next.getX(i), next.getZ(i)];
    const dx = q[0] - p[0], dy = q[1] - p[1], distance = Math.hypot(dx, dy) || 1;
    return [p[0] + side.getX(i) * -dy / distance, p[1] + side.getX(i) * dx / distance];
  };
  const length = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const widthA = length(expanded(0), expanded(1));
  const widthB = length(expanded(2), expanded(3));
  assert.ok(widthA > 0);
  assert.ok(Math.abs(widthA - widthB) < 1e-7);
  assert.deepEqual([side.getX(0), side.getX(1), side.getX(2), side.getX(3)], [-1, 1, 1, -1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const areaOne = cross(expanded(0), expanded(2), expanded(1));
  const areaTwo = cross(expanded(2), expanded(3), expanded(1));
  assert.ok(Math.abs(areaOne) > 0 && Math.abs(areaTwo) > 0);
  assert.equal(Math.sign(areaOne), Math.sign(areaTwo));
  assert.deepEqual([next.getX(0), next.getZ(0)], [4, 2]);
  assert.deepEqual([next.getX(2), next.getZ(2)], [0, 0]);
});

test('directional pan eases halfway and settles without rebuilding the view', { concurrency: false }, () => {
  const renderer = prototypeRenderer();
  renderer.sceneJSON = { buildings: [] };
  renderer.camera.position.set(4, 5, 6);
  renderer.controls.target.set(0, 0, 0);
  renderer.camera.lookAt(renderer.controls.target);
  renderer.camera.updateMatrixWorld();
  renderer.controls.update = () => {};
  renderer.renderScene = () => {};
  renderer.requestRender = AtlasRenderer.prototype.requestRender.bind(renderer);
  renderer.onViewChange = () => {};
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const startTarget = renderer.controls.target.clone();
    assert.equal(renderer.panByDirection('right'), true);
    assert.equal(frames.length, 1);
    const animation = renderer._panAnimation;
    const halfwayTime = animation.start + animation.duration / 2;
    runFrame(renderer, frames, halfwayTime);
    const halfway = renderer.controls.target.clone();
    assert.ok(halfway.distanceTo(startTarget) > 0);
    assert.ok(Math.abs(halfway.distanceTo(startTarget) - animation.toTarget.distanceTo(startTarget) / 2) < 1e-6);
    const endFrame = frames.shift();
    endFrame(animation.start + animation.duration);
    assert.equal(renderer._panAnimation, null);
    assert.ok(renderer.controls.target.distanceTo(animation.toTarget) < 1e-7);
  } finally {
    globalThis.requestAnimationFrame = oldRaf;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});

test('repeated and opposite directional pans retarget from the current camera without a jump', { concurrency: false }, () => {
  const renderer = prototypeRenderer();
  renderer.sceneJSON = { buildings: [] };
  renderer.elevationAt = () => 0;
  renderer.camera.position.set(4, 5, 6);
  renderer.camera.lookAt(renderer.controls.target);
  renderer.camera.updateMatrixWorld();
  renderer.controls.update = () => {};
  renderer.renderScene = () => {};
  renderer.requestRender = AtlasRenderer.prototype.requestRender.bind(renderer);
  renderer.onViewChange = () => {};
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    renderer.panByDirection('right');
    let animation = renderer._panAnimation;
    runFrame(renderer, frames, animation.start + animation.duration / 2);
    const beforeRetarget = renderer.controls.target.clone();
    renderer.panByDirection('left');
    assert.ok(renderer.controls.target.distanceTo(beforeRetarget) < 1e-10);
    animation = renderer._panAnimation;
    runFrame(renderer, frames, animation.start + animation.duration);
    assert.ok(renderer.controls.target.distanceTo(animation.toTarget) < 1e-7);
  } finally {
    globalThis.requestAnimationFrame = oldRaf;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});

test('held same-direction arrows queue one step and advance over repeated 30ms input', { concurrency: false }, () => {
  const renderer = prototypeRenderer();
  renderer.sceneJSON = { buildings: [] };
  renderer.elevationAt = () => 0;
  renderer.camera.position.set(4, 5, 6);
  renderer.camera.lookAt(renderer.controls.target);
  renderer.camera.updateMatrixWorld();
  renderer.controls.update = () => {};
  renderer.renderScene = () => {};
  renderer.requestRender = AtlasRenderer.prototype.requestRender.bind(renderer);
  renderer.onViewChange = () => {};
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    renderer.panByDirection('right');
    const first = renderer._panAnimation;
    const step = first.toTarget.distanceTo(first.fromTarget);
    let timestamp = first.start + 30;
    let lastTarget = renderer.controls.target.clone();
    for (let i = 0; i < 33; i += 1, timestamp += 30) {
      const frame = frames.shift();
      assert.equal(typeof frame, 'function');
      renderer._testNow = timestamp;
      frame(timestamp);
      const beforeRepeat = renderer.controls.target.clone();
      renderer.panByDirection('right');
      assert.ok(renderer.controls.target.distanceTo(beforeRepeat) < 1e-10);
      assert.ok(renderer.controls.target.distanceTo(lastTarget) >= 0);
      lastTarget.copy(renderer.controls.target);
    }
    assert.ok(renderer.controls.target.distanceTo(first.fromTarget) > step * 1.2);
    assert.ok(frames.length <= 1);
  } finally {
    globalThis.requestAnimationFrame = oldRaf;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});

test('pan cancellation leaves the current interpolated state and bounds keyboard repeats', { concurrency: false }, () => {
  const renderer = prototypeRenderer();
  renderer.sceneJSON = { buildings: [] };
  renderer.camera.position.set(4, 5, 6);
  renderer.camera.lookAt(renderer.controls.target);
  renderer.camera.updateMatrixWorld();
  renderer.controls.update = () => {};
  renderer.renderScene = () => {};
  renderer.requestRender = AtlasRenderer.prototype.requestRender.bind(renderer);
  renderer.onViewChange = () => {};
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    renderer.panByDirection('right');
    const animation = renderer._panAnimation;
    runFrame(renderer, frames, animation.start + animation.duration / 2);
    const current = renderer.controls.target.clone();
    assert.equal(renderer.cancelPanAnimation('pointer'), true);
    assert.equal(renderer._panAnimation, null);
    assert.ok(renderer.controls.target.distanceTo(current) < 1e-10);
  } finally {
    globalThis.requestAnimationFrame = oldRaf;
    globalThis.cancelAnimationFrame = oldCancel;
  }
  renderer.requestRender = () => {};
  for (let i = 0; i < 100; i += 1) renderer.panByDirection('right');
  assert.ok(Number.isFinite(renderer.controls.target.x));
  assert.ok(Number.isFinite(renderer.camera.position.x));
});

test('parcel place context respects holes and does not guess between overlapping named crus', () => {
  const renderer = prototypeRenderer();
  const ring = [[0,0],[10,0],[10,10],[0,10],[0,0]];
  const first = {key:'climats',ring,holes:[],feature:{name:'Les Suchots',classification:'premier-cru',aocVerification:{}}};
  renderer.featureIndex=[first,{...first}];
  assert.equal(renderer.placeAt([5,5]),'Les Suchots');
  renderer.featureIndex=[{...first,holes:[[[4,4],[6,4],[6,6],[4,6],[4,4]]]}];
  assert.equal(renderer.placeAt([5,5]),null);
  renderer.featureIndex=[first,{...first,feature:{name:'Other cru',classification:'grand-cru',aocVerification:{}}}];
  assert.equal(renderer.placeAt([5,5]),null);
  assert.equal(renderer.placeAt([20,20]),null);
});


test('merged building meshes retain triangles from non-indexed extrusion geometry', () => {
  const renderer = prototypeRenderer();
  const group = renderer.layers.buildings;
  const shape = new THREE.Shape(); shape.moveTo(0,0);shape.lineTo(1,0);shape.lineTo(1,1);shape.lineTo(0,1);shape.closePath();
  let expected = 0;
  for (let i=0;i<2;i++) {
    const geometry = new THREE.ExtrudeGeometry(shape,{depth:1,bevelEnabled:false});
    assert.equal(geometry.index,null);
    expected += geometry.attributes.position.count;
    group.add(new THREE.Mesh(geometry,new THREE.MeshStandardMaterial()));
  }
  renderer.mergeBuildings(group);
  assert.equal(group.children.length,1);
  const merged = group.children[0].geometry;
  assert.equal(merged.index.count,expected);
  assert.ok(merged.index.count>0);
  assert.equal(merged.index.count % 3,0);
});

test('a selected named place uses the legal outline while retaining its full source geometry', () => {
  const renderer = prototypeRenderer();
  const full = [[850010,6650010],[850090,6650010],[850090,6650090],[850010,6650090],[850010,6650010]];
  const legal = [[850030,6650030],[850060,6650030],[850060,6650060],[850030,6650060],[850030,6650030]];
  const feature = {id:'named-place',rings:[[full]],aocSelectionRings:[[legal]]};
  renderer.layers.climats = new THREE.Group();
  renderer.featureIndex = [{feature,key:'climats',ring:full,holes:[]}];
  renderer.onSelect=()=>{};
  const used=[];const original=renderer.drapedPoints.bind(renderer);
  renderer.drapedPoints=ring=>{used.push(ring);return original(ring);};
  renderer.selectFeature(feature,'climats');
  assert.deepEqual(used,[legal]);
  assert.deepEqual(feature.rings,[[full]]);
});
