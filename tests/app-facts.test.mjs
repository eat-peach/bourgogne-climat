import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(resolve('dist/app.js'), 'utf8');
const declaration = source.match(/function safeUrl\(value\)\{[\s\S]*?\nfunction renderFeatureFacts/)[0].replace(/\nfunction renderFeatureFacts$/, '');
const safeUrl = new Function(`${declaration}; return safeUrl;`)();

test('feature source links accept only absolute HTTP(S) URLs', () => {
  assert.equal(safeUrl(undefined), null);
  assert.equal(safeUrl(null), null);
  assert.equal(safeUrl(''), null);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('/undefined'), null);
  assert.equal(safeUrl('https://example.test/source'), 'https://example.test/source');
  assert.equal(safeUrl('http://127.0.0.1:8765/source'), 'http://127.0.0.1:8765/source');
});

test('feature facts matching fails closed without explicit provenance', () => {
  const showFacts = source.match(/async function showFeatureFacts\([\s\S]*?\nfunction fold/)[0];
  assert.match(showFacts, /factsKey&&villageId\?await loadFeatureFacts\(villageId\):null/);
  assert.match(showFacts, /const candidates=factsKey\?/);
  assert.doesNotMatch(showFacts, /sourceId/);
});
