import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const renderer = fs.readFileSync(new URL('../dist/atlas-renderer.js', import.meta.url), 'utf8');

test('terroir facts are loaded per village and keyed by layer and feature id', () => {
  assert.match(app, /data\/terroir\/\$\{encodeURIComponent\(villageId\)\}\.json/);
  assert.match(app, /features\?\.\[`\$\{layer\}:\$\{p\.id\}`\]/);
  // lieux-dits carry their commune code in the id, AOC areas in insee
  assert.match(app, /layer==='climats'\?String\(p\.id\|\|''\)\.split\(':'\)\[0\]:String\(p\.insee\|\|''\)/);
});

test('the info panel shows aspect, slope and elevation as tiles and modelled sun as a meter', () => {
  for (const label of ['Faces', 'Slope', 'Elevation']) assert.ok(app.includes(`glanceTile('${label}'`), label);
  assert.ok(app.includes('<span class="terroir-k">Direct sun</span>'), 'sun meter');
  assert.ok(!app.includes('not a weather record'), 'the model note moved to provenance');
});

test('terroir shading replaces the AOC class fill only while a mode is on', () => {
  assert.match(renderer, /setTerroirTint\(fn\)/);
  assert.match(renderer, /if \(this\.terroirTint\) \{ for \(const feature of this\.sceneJSON\?\.climats/);
  assert.match(app, /renderer\?\.setTerroirTint\?\.\(terroirMode==='off'\|\|terroirMode==='geology'\?null:terroirTint\)/);
});

test('a built terroir file has the expected fields', () => {
  const file = new URL('../dist/data/terroir/vosne-roman-e-21714.json', import.meta.url);
  if (!fs.existsSync(file)) return; // data is built separately (scripts/build_terroir.py)
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tache = body.features['climats:21714:la-tache'];
  assert.ok(tache, 'La Tâche lieu-dit present');
  for (const k of ['elevation', 'slopePct', 'slopeMaxPct', 'aspectDeg', 'aspect', 'aspectConsistency', 'sunHours', 'sunHoursFlat']) assert.ok(k in tache, k);
  assert.ok(tache.aspectDeg > 45 && tache.aspectDeg < 135, 'La Tâche faces roughly east');
  assert.ok(tache.sunHours > 0 && tache.sunHours <= tache.sunHoursFlat);
});
