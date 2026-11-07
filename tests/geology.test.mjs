import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const renderer = fs.readFileSync(new URL('../dist/atlas-renderer.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

test('geology is a terroir shading mode in the layer menu', () => {
  assert.match(app, /\{v:'geology',name:'Geology'/);
  assert.match(app, /class="terroir-popover" id="terroir-popover" role="radiogroup"/);
  assert.ok(!html.includes('terroir-choice'), 'shading is no longer inside Layers');
  assert.match(app, /\['slope','aspect','sun','geology'\]\.includes\(mode\)/);
  assert.match(app, /renderer\?\.setGeologyLayer\?\.\(terroirMode==='geology'\?geologyLayer:null\)/);
});

test('the map layer reads 4 km tiles listed in the legend, and the panel reads per-village shares', () => {
  assert.match(app, /data\/geology\/legend\.json/);
  assert.match(app, /data\/geology\/tiles\/\$\{k\}\.json/);
  assert.match(app, /data\/geology\/\$\{encodeURIComponent\(v\)\}\.json/);
  assert.match(app, /L\.tileSet\.has\(k\)/);
});

test('the renderer draws formations with even-odd fill and keeps the overlay visible while a mode is on', () => {
  assert.match(renderer, /setGeologyLayer\(fn\)/);
  assert.match(renderer, /if \(this\.geologyLayer\) \{ const polys = this\.geologyLayer\(this\.bounds\)/);
  assert.match(renderer, /ctx\.fill\('evenodd'\)/);
  assert.ok(!/this\.aocMesh\.visible = next;/.test(renderer), 'parcels toggle must not hide an active shading');
});

test('the info panel stays short; source notes live in provenance', () => {
  assert.match(app, /<h4 class="fact-label">Geology<\/h4>/);
  assert.ok(!app.includes('Boundaries are good to a few tens of metres'), 'no geology caption in the panel');
  assert.match(html, /<dt>Geology<\/dt><dd>.*BRGM BD Charm-50.*Licence Ouverte 2\.0/);
  assert.match(html, /<dt>Terroir figures<\/dt>.*clear-sky model with hill shading/);
});

test('built geology data, when present, is consistent', () => {
  const legendFile = new URL('../dist/data/geology/legend.json', import.meta.url);
  const villageFile = new URL('../dist/data/geology/vosne-roman-e-21714.json', import.meta.url);
  if (!fs.existsSync(legendFile) || !fs.existsSync(villageFile)) return; // data is built separately (scripts/build_geology.py)
  const legend = JSON.parse(fs.readFileSync(legendFile, 'utf8'));
  const body = JSON.parse(fs.readFileSync(villageFile, 'utf8'));
  const tache = body.features['climats:21714:la-tache'];
  assert.ok(tache?.length, 'La Tâche has formations');
  const total = tache.reduce((a, [, pct]) => a + pct, 0);
  assert.ok(total >= 90 && total <= 101, `shares add up (${total})`);
  for (const [u] of tache) {
    const unit = legend.units[u];
    assert.ok(unit && /^#[0-9a-f]{6}$/.test(unit.colour) && unit.descr, 'unit has colour and description');
    assert.match(unit.age, /Jurassic/, 'La Tâche sits on Jurassic rocks');
  }
  for (const k of legend.tiles.slice(0, 3)) assert.ok(fs.existsSync(new URL(`../dist/data/geology/tiles/${k}.json`, import.meta.url)), k);
});
