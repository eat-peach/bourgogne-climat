import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorThree = pathToFileURL(resolve(root, 'dist/vendor/three.module.js')).href;
const temp = mkdtempSync(join(tmpdir(), 'burgundy-labels-'));
const orbitPath = join(temp, 'OrbitControls.mjs');
const rendererPath = join(temp, 'atlas-renderer.mjs');
writeFileSync(orbitPath, readFileSync(resolve(root, 'dist/vendor/OrbitControls.js'), 'utf8').replaceAll("from 'three'", `from '${vendorThree}'`));
writeFileSync(rendererPath, readFileSync(resolve(root, 'dist/atlas-renderer.js'), 'utf8')
  .replace("from 'three'", `from '${vendorThree}'`)
  .replace("from 'three/addons/controls/OrbitControls.js'", `from '${pathToFileURL(orbitPath).href}'`)
  .replace("from './region.js'", `from '${pathToFileURL(resolve(root, 'dist/region.js')).href}'`)
  .replace("from './simulation.js'", `from '${pathToFileURL(resolve(root, 'dist/simulation.js')).href}'`));
const { labelCandidates } = await import(pathToFileURL(rendererPath).href);

const vosne = JSON.parse(gunzipSync(readFileSync(resolve(root, 'dist/data/scenes/vosne-roman-e-21714.json.gz'))).toString('utf8'));

test('grand and premier crus from the AOC layer are labelled first', () => {
  const labels = labelCandidates(vosne);
  const grand = labels.filter(item => item.tier === 0).map(item => item.text).sort();
  assert.deepEqual(grand, ['La Grande Rue', 'La Romanée', 'La Tâche', 'Richebourg', 'Romanée-Conti', 'Romanée-Saint-Vivant']);
  const premier = labels.filter(item => item.tier === 1).map(item => item.text);
  for (const name of ['Les Suchots', 'Aux Malconsorts', 'Cros Parantoux', 'Les Beaux Monts']) assert.ok(premier.includes(name), name);
  assert.ok(!premier.some(name => /premier cru/i.test(name)), 'appellation prefix is removed');
  assert.ok(labels.every((item, i) => i === 0 || labels[i - 1].tier <= item.tier), 'ranked by tier');
});

test('a cru is not labelled twice and capitalised lieux-dits are title-cased', () => {
  const labels = labelCandidates(vosne);
  assert.equal(labels.filter(item => item.fold === 'auxmalconsorts').length, 1);
  assert.equal(labels.find(item => item.fold === 'auxmalconsorts').tier, 1);
  const communes = labels.find(item => item.fold === 'auxcommunes');
  assert.equal(communes?.text, 'Aux Communes');
  assert.equal(labels.find(item => item.fold === 'audessusdelariviere')?.text, 'Au-dessus de la Riviere');
});

test('label anchors fall inside their polygon', () => {
  const inside = (x, y, ring) => { let hit = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit; } return hit; };
  for (const item of labelCandidates(vosne).filter(entry => entry.tier === 0)) {
    const rings = item.feature.rings, polygons = Array.isArray(rings[0][0][0]) ? rings : [rings];
    assert.ok(polygons.some(polygon => inside(item.point[0], item.point[1], polygon[0])), item.text);
  }
});

test('lieux-dits inside an AOC area outrank those outside, and particles stay lower case', () => {
  const square = (x, y, size) => [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]];
  const scene = {
    parcels: [{ name: 'Bourgogne', classification: 'regional', rings: square(0, 0, 100) }],
    climats: [{ name: "SUR L'HOPITAL", rings: square(10, 10, 20) }, { name: 'LES CHASSAGNES OU CORVEE AU PRETRE', rings: square(500, 500, 40) }],
  };
  const labels = labelCandidates(scene);
  assert.deepEqual(labels.map(item => [item.text, item.tier]), [["Sur l'Hopital", 2], ['Les Chassagnes ou Corvee au Pretre', 3]]);
});

test('a harmonised lieu-dit name merges with its cru label', () => {
  const vougeot = JSON.parse(gunzipSync(readFileSync(resolve(root, 'dist/data/scenes/vougeot-21716.json.gz'))).toString('utf8'));
  const labels = labelCandidates(vougeot);
  assert.equal(labels.filter(item => /clos de vougeot/i.test(item.text)).length, 1);
  assert.equal(labels.find(item => /clos de vougeot/i.test(item.text)).tier, 0);
});
