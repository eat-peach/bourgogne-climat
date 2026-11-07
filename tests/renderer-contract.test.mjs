import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';

const rendererPath = resolve('dist/atlas-renderer.js');
const source = readFileSync(rendererPath, 'utf8');

test('atlas renderer exposes one active implementation of each scene method', () => {
  for (const method of ['build', 'buildAocOverlay', 'restoreView', 'localGrid', 'elevationAt', 'makeTerrain', 'resetView', 'topDown', 'setMaterialMode', 'addAerialTexture', 'isPanAnimating']) {
    const count = (source.match(new RegExp(`^  ${method}\\(`, 'gm')) || []).length;
    assert.equal(count, 1, `${method} should not be shadowed by duplicate class methods`);
  }
  assert.match(source, /validMask/);
  assert.match(source, /screenSpacePanning: this\.controls\.screenSpacePanning/);
  assert.match(source, /loadedCount === sources\.length/);
});

test('atlas renderer is valid JavaScript without importing WebGL dependencies', () => {
  execFileSync(process.execPath, ['--check', rendererPath], { stdio: 'pipe' });
});

test('terrain keeps bright neutral lighting and strengthens only the aerial photo colours', () => {
  assert.match(source, /LIGHT_INTENSITY = 1\.8 \* \.85;\s+const BASE_GAMMA = 2 \*\* \.2;/);
  assert.match(source, /new THREE\.HemisphereLight\(0xffffff, 0xb4afa6, LIGHT_INTENSITY\)/);
  assert.match(source, /DISPLAY_DEFAULTS = Object\.freeze\(\{ brightness: 1, lightness: 0, saturation: 1\.7 \}\)/);
  assert.match(source, /material\.onBeforeCompile = saturatePhotoTexture/);
  assert.match(source, /#include <map_fragment>\s+#ifdef USE_MAP/);
  assert.doesNotMatch(source, /lightTrial|get\('light'\)/);
});

test('display settings live in their own dialog and are saved only in the browser', () => {
  const settings = readFileSync(new URL('../dist/display-settings.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  assert.match(settings, /localStorage\.setItem\(STORAGE_KEY/);
  assert.match(settings, /try \{ return clampDisplay/);
  assert.match(app, /initDisplaySettings\(renderer,\$\('#display-button'\)\)/);
  for (const page of ['../dist/index.html', '../dist/rhone/index.html']) assert.match(readFileSync(new URL(page, import.meta.url), 'utf8'), /id="display-button"/);
});
