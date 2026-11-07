import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(resolve('dist/app.js'), 'utf8');

function declaration(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `missing ${name} declaration`);
  const open = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i], next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name} declaration`);
}

class FakeClock {
  constructor() { this.now = 0; this.nextId = 1; this.timers = new Map(); }
  setTimeout = (callback, delay) => { const id = this.nextId++; this.timers.set(id, { at: this.now + delay, callback }); return id; };
  clearTimeout = id => { this.timers.delete(id); };
  advance(ms) {
    this.now += ms;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now).sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) { if (this.timers.delete(id)) timer.callback(); }
  }
}

function createSandbox() {
  const clock = new FakeClock();
  const calls = { compose: [], setVillage: [], cadastre: [], aborts: 0 };
  const cadastreState = { config: undefined };
  const renderer = {
    isPanAnimating: () => false,
    setCadastralParcels: (...args) => calls.cadastre.push(args),
    setVillage: async (...args) => { calls.setVillage.push(args); },
  };
  const village = { id: 'test-village' };
  const mosaicMock = {
    findVillage: () => village,
    compose: (view, options) => {
      calls.compose.push({ view, options });
      return Promise.resolve({ scene: { bounds: [0, 0, 1, 1], gridSize: 2 } });
    },
  };
  class CadastreLoaderMock {
    constructor(config) { cadastreState.config = config; }
    update(view, enabled) { return { view, enabled }; }
  }
  const sandbox = {
    clock,
    calls,
    renderer,
    mosaicMock,
    village,
  };
  const declarations = [
    'refreshCadastre', 'streamIsMeaningful', 'streamView',
    'scheduleInteractionFlush', 'markInteraction',
  ].map(declaration).join('\n');
  const factory = new Function(
    'CadastreLoader', 'CADASTRE_MAX_VIEW_RADIUS_METRES', 'fetchJson', 'fetchScene', 'setCadastreStatus', 'cadastreState',
    'document', 'location', 'setTimeout', 'clearTimeout', 'AbortController',
    `${declarations}
      let mosaic = null, streamAbort = null, streamSeq = 0, streamReady = false, streamViewLast = null, streamViewPending = null, streamViewQueued = null, interactionIdleTimer = 0, interactionActive = false, interactionHeld = false, renderer = null, regionalNavigator = null, cadastreLoader = null, cadastrePublishQueued = null, selected = null, sceneCache = new Map();
      const debug = { resourceErrors: [] };
      const activeFromView = () => selected;
      const updateDetails = () => {};
      const updateCoverageHint = () => {};
      const renderList = () => {};
      return {
        refreshCadastre, streamIsMeaningful, streamView, scheduleInteractionFlush, markInteraction,
        getCadastreConfig: () => cadastreState.config,
        getState: () => ({ interactionActive, interactionHeld, streamViewQueued, streamViewPending, streamViewLast, cadastrePublishQueued }),
        setState: next => {
          if ('interactionActive' in next) interactionActive = next.interactionActive;
          if ('interactionHeld' in next) interactionHeld = next.interactionHeld;
          if ('streamReady' in next) streamReady = next.streamReady;
          if ('mosaic' in next) mosaic = next.mosaic;
          if ('renderer' in next) renderer = next.renderer;
          if ('streamViewLast' in next) streamViewLast = next.streamViewLast;
          if ('streamViewPending' in next) streamViewPending = next.streamViewPending;
          if ('streamViewQueued' in next) streamViewQueued = next.streamViewQueued;
          if ('cadastrePublishQueued' in next) cadastrePublishQueued = next.cadastrePublishQueued;
          if ('streamAbort' in next) streamAbort = next.streamAbort;
          if ('selected' in next) selected = next.selected;
        },
      };`,
  )(
    CadastreLoaderMock,
    1800,
    async () => ({}),
    async () => ({}),
    () => {},
    cadastreState,
    { querySelector: selector => selector === '[data-layer="cadastre"]' ? { checked: true } : null },
    { href: 'https://example.test/' },
    clock.setTimeout,
    clock.clearTimeout,
    class TestAbortController {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; calls.aborts += 1; }
    },
  );
  factory.setState({ mosaic: mosaicMock, renderer, streamReady: true, selected: village });
  return { ...sandbox, ...factory };
}

const view = (easting, northing) => ({ easting, northing, radiusMetres: 1000 });

test('held gesture queues views without composing or refreshing cadastre', async () => {
  const app = createSandbox();
  app.setState({ interactionActive: true, interactionHeld: true });
  await app.streamView(view(1, 2));
  assert.equal(app.calls.compose.length, 0);
  assert.equal(app.getCadastreConfig(), undefined);
  assert.deepEqual(app.getState().streamViewQueued, view(1, 2));
});

test('latest queued view resumes after the interaction idle window', async () => {
  const app = createSandbox();
  app.setState({ interactionActive: true, interactionHeld: false });
  await app.streamView(view(1, 2));
  await app.streamView(view(3, 4));
  app.markInteraction(false);
  app.clock.advance(349);
  assert.equal(app.calls.compose.length, 0);
  app.clock.advance(1);
  await Promise.resolve();
  assert.equal(app.calls.compose.length, 1);
  assert.deepEqual(app.calls.compose[0].view, view(3, 4));
});

test('interaction start aborts an in-flight compose before setVillage', async () => {
  const app = createSandbox();
  let resolveCompose;
  app.setState({ mosaic: { findVillage: () => app.village, compose: (nextView, options) => new Promise(resolve => { resolveCompose = { resolve, options }; }) } });
  const pending = app.streamView(view(1, 2));
  await Promise.resolve();
  app.markInteraction(true);
  resolveCompose.resolve({ scene: { bounds: [0, 0, 1, 1], gridSize: 2 } });
  await pending;
  assert.equal(app.calls.aborts, 1);
  assert.equal(app.calls.setVillage.length, 0);
});

test('cadastre publication waits for idle even without a queued view', () => {
  const app = createSandbox();
  app.setState({ interactionActive: true, interactionHeld: false });
  app.refreshCadastre(view(1, 2));
  app.getCadastreConfig().publish([{ id: 'parcel' }], { source: 'test' });
  assert.equal(app.calls.cadastre.length, 0);
  app.markInteraction(false);
  app.clock.advance(350);
  assert.equal(app.calls.cadastre.length, 1);
  assert.deepEqual(app.calls.cadastre[0], [[{ id: 'parcel' }], { source: 'test' }]);
});

test('pan damping reschedules the idle flush until animation stops', () => {
  const app = createSandbox();
  let frames = 2;
  app.renderer.isPanAnimating = () => frames-- > 0;
  app.setState({ interactionActive: true, interactionHeld: false });
  app.refreshCadastre(view(1, 2));
  app.getCadastreConfig().publish([{ id: 'parcel' }], { source: 'test' });
  app.markInteraction(false);
  app.clock.advance(350);
  assert.equal(app.calls.cadastre.length, 0);
  assert.equal(app.getState().interactionActive, true);
  app.clock.advance(350);
  assert.equal(app.calls.cadastre.length, 0);
  app.clock.advance(350);
  assert.equal(app.calls.cadastre.length, 1);
  assert.equal(app.getState().interactionActive, false);
});
