import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const renderer = fs.readFileSync(new URL('../dist/atlas-renderer.js', import.meta.url), 'utf8');

test('compare starts from a lieu-dit or AOC area and picks B on the map, in search or on the navigator', () => {
  assert.match(app, /function addCompareButton\(host,feature,layer,provenance\)/);
  assert.match(app, /async function showFeatureFacts\(feature,layer,provenance\)\{if\(compare&&compareIntercept\(feature,layer,provenance\)\)return;/);
  assert.match(app, /async function selectCru\(cru\)\{if\(compare&&!compare\.flying&&\(compare\.picking\|\|compare\.repick\)\)\{setCompareFromCru\(cru\);return;\}/);
  assert.match(app, /b\.addEventListener\('dblclick',e=>\{e\.preventDefault\(\);clearTimeout\(t\);compare\.repick=b\.dataset\.fly;renderCompare\(\);\}\)/);
  assert.match(app, /const host=cruUnderParcel\(provenance\)/);
  assert.match(app, /far\?`Show \$\{compare\.viewing==='b'\?'A':'B'\}`:'Show both'/);
});

test('B can be anywhere: its facts load from its own village scene without moving the map', () => {
  assert.match(app, /async function sideFromRef\(ref\)\{const m=\/\^\(climats\|parcels\):\(\.\+\)@\(\.\+\)\$\//);
  assert.match(app, /const scene=await loadScene\(v\)/);
});

test('rows cover area, elevation, slope, aspect, sun, geology and legal-entity owners', () => {
  for (const label of ["compareRow('Area'", "compareRow('Elevation'", "compareRow('Slope'", "compareRow('Faces'", "compareRow('Direct sun", "compareRow('Geology'", "compareRow('Owners"]) assert.ok(app.includes(label), label);
  assert.match(app, /side\.layer==='parcels'\?String\(v\[0\]\)===String\(side\.id\):String\(v\[1\]\)===String\(side\.id\)/);
});

test('a comparison is part of the shareable link and survives flying between A and B', () => {
  assert.match(app, /p\.set\('cmp',\[compare\.a,compare\.b\]\.map\(x=>`\$\{x\.layer\}:\$\{x\.id\}@\$\{x\.villageId\}`\)\.join\(','\)\)/);
  assert.match(app, /const cmp=params\.get\('cmp'\);if\(cmp\)await restoreCompare\(cmp,params\.get\('cmpv'\)\);/);
  assert.match(app, /if\(!feature\)\{renderCompare\(\);return true;\}/);
});

test('A and B outlines are drawn at one shared scale with north, scale bar and a downhill arrow', () => {
  assert.match(app, /scale=Math\.min\(\.\.\.sides\.map\(v=>Math\.min\(\(W-PAD\*2\)\/Math\.max\(v\.w,1\)/);
  assert.match(app, /class="cmp-shape-north"/);
  assert.match(app, /class="cmp-shape-scale"/);
  assert.match(app, /html\+=compare\.shapes\?\.key===compareKey\(\)\?compareFiguresHtml\(\):compareShapes\(A,B\);/);
});

test('the detailed views are flat north-up maps at one scale, and Show both outlines A and B on the 3D map', () => {
  assert.match(app, /function renderCompareMaps\(sides,cru,fr\)/);
  assert.ok(!app.includes('renderCompare3D'), 'no 3D thumbnails');
  assert.match(app, /renderer\?\.setCompareOutlines\?\.\(\[\{rings:ga\.rings,color:0xb3abff\},\{rings:gb\.rings,color:0x4fe0a6\}\]\)/);
  assert.match(renderer, /setCompareOutlines\(items = \[\]\)/);
});

test('compare views use 5 m terrain tiles for grand and premier crus, with the village terrain as fallback', () => {
  assert.match(app, /data\/cruterrain\/index\.json/);
  assert.match(app, /const heightAt=\(x,y\)=>\{const f=v\.fine\?\.at\(x,y\);if\(f!=null\)\{const k=v\.fine\.edge\(x,y\)/);
  assert.match(app, /a lieu-dit borrows the tile of a cru that covers it/);
});

test('parcels offer Compare for their cru, and a comparison can be saved as an image next to Share', () => {
  assert.match(app, /addParcelCompareButton\(\$\('#feature-card'\),provenance\)/);
  assert.match(app, /const row=card\.querySelector\('\.cmp-actions'\);if\(row\)\{addShareButton\(row\);addCompareSaveButton\(row\);/);
  assert.match(app, /async function saveCompareImage\(\)/);
});

test('compare maps switch between parcels, geology and an overlay, and a slope profile shows both crus with their rock', () => {
  assert.match(app, /const CMP_VIEWS=\[\['parcels','Parcels'\],\['geology','Geology'\],\['overlay','Overlay'\]\];/);
  assert.match(app, /function renderGeologyMaps\(sides,fr\)/);
  assert.match(app, /function renderOverlay\(sides\)/);
  assert.match(app, /const turn=Number\.isFinite\(v\.fall\)\?\(180-v\.fall\)\*Math\.PI\/180:0/);
  assert.match(app, /function fallLine\(v\)/);
  assert.match(app, /function slopeProfile\(v\)/);
  assert.match(app, /profile:renderProfile\(sides\.map\(slopeProfile\)\)/);
  assert.match(app, /profSvg=document\.querySelector\('#feature-card \.cmp-profile-svg'\)/);
});

test('map labels hold steady while the map moves: dwell time, overlap tolerance, sticky nudge, fade-in', () => {
  assert.match(renderer, /const LABEL_DWELL_MS = 320, LABEL_HYSTERESIS_PX = 3;/);
  assert.match(renderer, /if \(box && !wasShown && recent\) \{ dwelling = true; continue; \}/);
  assert.match(renderer, /if \(item\.off != null && item\.off < offsets\.length\)/);
});

test('lieu-dit edges shared by two lieux-dits are drawn once and are not simplified', () => {
  assert.match(renderer, /if \(key === 'climats'\) \{ this\.addSharedEdges\(batch, ring\); continue; \}/);
  assert.match(renderer, /addSharedEdges\(batch, ring\) \{ const seen = batch\.seen \|\|= new Set\(\)/);
});
