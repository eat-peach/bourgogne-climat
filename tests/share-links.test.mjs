import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

test('the address keeps the village before ? so old #village links still work', () => {
  assert.match(app, /function hashParts\(\)\{const raw=location\.hash\.slice\(1\),q=raw\.indexOf\('\?'\)/);
  assert.match(app, /function villageFromHash\(\)\{const \{id\}=hashParts\(\)/);
});

test('a link records selection, owner card, shading and camera', () => {
  for (const key of ["p.set('sel'", "p.set('owner'", "p.set('shade'", "p.set('cam'"]) assert.ok(app.includes(key), key);
});

test('the address is rewritten without adding history entries, and not while a link is being restored', () => {
  assert.match(app, /history\.replaceState\(null,'',hash\);\},450\)/);
  assert.match(app, /function scheduleShareSync\(\)\{if\(shareRestoring\|\|!selected\)return;/);
  assert.match(app, /onViewChange:view=>\{streamView\(view\);scheduleShareSync\(\);\}/);
});

test('opening a link restores the same things it records', () => {
  assert.match(app, /async function applyShare\(params\)/);
  assert.match(app, /renderer\.restoreView\(\{easting:cam\[0\],northing:cam\[1\],radiusMetres:cam\[2\]/);
  assert.match(app, /waitForFeature\(layer,id\)/);
  assert.match(app, /showOwner\(o\);window\.atlasSearchDrop\?\.open\(input\)/);
});
