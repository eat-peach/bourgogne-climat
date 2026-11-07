import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = readFileSync('dist/app.js', 'utf8');
const css = readFileSync('dist/style.css', 'utf8');

test('drawer contract keeps the village edge full-height and details manual', () => {
  assert.match(css, /\.drawer-edge-left\{position:fixed!important;[^}]*top:0!important;bottom:0!important;[^}]*height:100dvh!important/);
  assert.match(app, /const edge=isLeft\?document\.createElement\('button'\):null/);
  assert.doesNotMatch(app, /drawer-edge-right/);
  assert.doesNotMatch(app, /if\(!isLeft\)[^{]*\{[^}]*pointerenter/);
  assert.match(css, /\.drawer-edge-left span\{display:flex;flex-direction:column!important;align-items:center;justify-content:flex-start/);
  assert.match(css, /\.sidebar\.drawer-open\) \.drawer-edge-left span\{display:none\}/);
  assert.match(app, /detail-close/);
});

test('drawer contract keeps the move pad clear of desktop and mobile details', () => {
  assert.match(css, /\.detail-panel\.drawer-open\) \.pan-pad\{right:298px\}/);
  assert.match(css, /\.detail-panel\.mobile-open\) \.pan-pad\{bottom:calc\(58vh \+ 16px\)\}/);
  assert.match(css, /\.detail-panel\.mobile-open\{[^}]*width:100%;[^}]*left:0;right:0/);
  assert.match(app, /toggle\.hidden=open/);
  assert.match(css, /\.details-toggle\{display:flex;align-items:flex-start;justify-content:center/);
  assert.match(css, /\.details-toggle\{[^}]*bottom:0;[^}]*width:44px/);
  assert.match(app, /details-toggle';detailBtn\.innerHTML='<svg/);
  assert.match(app, /sidebar-head-actions.*append\(leftDrawer\.pin\)/);
});
