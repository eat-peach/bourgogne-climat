import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportMapImage } from '../dist/export-map.js';

let fallbackSequence = 0;

function harness({ failBlob = false, sourceWidth = 100 } = {}) {
  const calls = [];
  const context = new Proxy({
    fillText(text, x, y) { calls.push({ op: 'fillText', text, x, y, font: this.font }); },
    fillRect(...args) { calls.push({ op: 'fillRect', args }); },
    drawImage(...args) { calls.push({ op: 'drawImage', args }); },
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    measureText(text) { return { width: String(text).length * 6 }; },
  }, { set(target, key, value) { target[key] = value; return true; } });
  const source = { width: sourceWidth * 2, height: 100, getBoundingClientRect: () => ({ left: 10, top: 20, width: sourceWidth, height: 50 }) };
  const output = { width: 0, height: 0, getContext: () => context, toBlob: cb => cb(failBlob ? null : new Blob(['png'], { type: 'image/png' })) };
  const label = { hidden: false, textContent: 'Clos des Lambrays', getBoundingClientRect: () => ({ left: 40, top: 30, width: 80, height: 14 }) };
  const nodes = {
    '#feature-card .fact-place-name': null,
    '#detail-name': { textContent: 'Vosne-Romanée' },
    '#crumb-village': { textContent: 'Vosne-Romanée' },
    '#map-labels .map-label': [label],
    '[data-classification]': [],
    '[data-layer="cadastre"]': { checked: false },
  };
  const created = [];
  globalThis.getComputedStyle = () => ({ fontSize: '12px', fontFamily: 'Georgia', fontStyle: 'normal', fontVariant: 'normal', fontWeight: '400', color: '#fff' });
  globalThis.document = { querySelector: selector => selector === '#terrain-canvas' ? source : nodes[selector] || null, querySelectorAll: selector => nodes[selector] || [], createElement: tag => { if (tag === 'canvas') return output; const a = { click: () => created.push(a) }; return a; } };
  const revoked = [];
  globalThis.URL = { createObjectURL: () => `blob:test-${fallbackSequence++}`, revokeObjectURL: url => revoked.push(url) };
  return { source, output, calls, created, revoked };
}

test('export composes labels at device pixel scale and uses commune title', async () => {
  const h = harness();
  const result = await exportMapImage({ canvas: h.source, mode: 'aerial', exaggeration: 3, aocOpacity: .25, renderScene() {} });
  assert.equal(result.filename, 'bourgogne-climat-vosne-romanee-map.png');
  assert.equal(h.output.width, 200);
  assert.ok(h.calls.some(call => call.op === 'fillText' && call.text === 'Clos des Lambrays' && call.font.includes('24px')));
  assert.ok(h.calls.some(call => call.op === 'fillText' && call.text.startsWith('Bourgogne Climat')));
  assert.ok(!h.calls.some(call => call.op === 'fillText' && call.text.includes('6.0409')));
  assert.equal(h.created.length, 1);
  assert.ok(!h.revoked.includes(result.url));
});

test('export wraps a narrow footer and keeps fallback URL available', async () => {
  const h = harness({ sourceWidth: 60 });
  const result = await exportMapImage({ canvas: h.source, renderScene() {}, layers: { parcels: { visible: true } } });
  assert.ok(result.url.startsWith('blob:test-'));
  assert.ok(h.output.height > h.source.height + 120);
  assert.ok(!h.revoked.includes(result.url));
});

test('export reports blob encoding failure without starting a download', async () => {
  const h = harness({ failBlob: true });
  await assert.rejects(() => exportMapImage({ canvas: h.source, renderScene() {} }), /encode the map image/);
  assert.equal(h.created.length, 0);
});
