import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = readFileSync('dist/app.js', 'utf8');
const html = readFileSync('dist/index.html', 'utf8');
const css = readFileSync('dist/style.css', 'utf8');

test('region list renders accessible independent accordion groups', () => {
  assert.match(app, /regionCollapsed = new Map/);
  assert.match(app, /class=\"region-group\"/);
  assert.match(app, /class=\"region-heading\" aria-expanded=/);
  assert.match(app, /aria-controls=\"\$\{regionId\}/);
  assert.match(app, /regionCollapsed\.set\(key,!open\)/);
  assert.match(css, /\.region-heading\{[^}]*width:100%;[^}]*display:grid/);
});

test('search temporarily expands matching region groups without discarding collapse state', () => {
  assert.match(app, /const collapsed=!q&&regionCollapsed\.get\(group\.id\)===true/);
});

test('region groups start collapsed without a global list collapse row', () => {
  assert.match(app, /regionCollapsed=new Map\(regionalGroups\.map\(group=>\[group\.id,true\]\)\)/);
  assert.doesNotMatch(html, /id="result-count"/);
  assert.doesNotMatch(html, /id="list-toggle"/);
  assert.doesNotMatch(app, /listToggle|list-collapsed|ui\.result/);
});
