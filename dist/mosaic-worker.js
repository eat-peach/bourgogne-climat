// Background worker for the map: downloads, unpacks and parses village scenes and assembles the mosaic for a view, so
// none of that blocks the page. When the page is idle it also pre-loads the villages around the view (and warms the
// browser cache for their photos), so the next re-assembly can start at once.
import { SceneMosaic } from './scene-mosaic.js';

let mosaic = null, base = '', useAvif = false, ready = null, prefetchTimer = 0;
const scenes = new Map(), SCENE_LIMIT = 40, warmed = new Set();

async function fetchJson(url) {
  const res = await fetch(url); if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!(bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) return JSON.parse(new TextDecoder().decode(bytes));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
}
async function optionalJson(url) { try { return await fetchJson(url); } catch { return null; } }

// Same as the page's loadScene: the scene file, plus the photo the index lists for it.
function loadScene(entry) {
  const id = String(entry.id);
  if (scenes.has(id)) { const hit = scenes.get(id); scenes.delete(id); scenes.set(id, hit); return hit; }
  const promise = fetchJson(new URL(entry.scene, base)).then(scene => { if (entry.texture && !scene.texture) { scene.texture = useAvif && entry.textureAvif ? entry.textureAvif : entry.texture; scene.textureFallback = entry.texture; } return scene; });
  scenes.set(id, promise); promise.catch(() => scenes.delete(id));
  while (scenes.size > SCENE_LIMIT) scenes.delete(scenes.keys().next().value);
  return promise;
}

function schedulePrefetch(view) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(async () => {
    // The villages a somewhat wider view would use, nearest first, not yet loaded.
    const wider = { ...view, radiusMetres: Math.max(100, Number(view.radiusMetres) || 1800) * 2 };
    const wanted = mosaic.chooseCandidates(wider).map(item => item.entry).filter(entry => !scenes.has(String(entry.id))).slice(0, 8);
    for (const entry of wanted) {
      try { await loadScene(entry); } catch { continue; }
      for (const url of [useAvif && entry.textureAvif ? entry.textureAvif : entry.texture].filter(Boolean)) {
        const href = new URL(url, base).href; if (warmed.has(href)) continue; warmed.add(href);
        fetch(href).then(res => res.blob()).catch(() => {}); // only fills the browser cache; the page decodes it when needed
      }
      await new Promise(res => setTimeout(res, 50));
    }
  }, 600);
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    base = data.base; useAvif = Boolean(data.useAvif);
    ready = (async () => {
      const [context, communes] = await Promise.all([data.contextUrl ? optionalJson(data.contextUrl) : null, data.communesUrl ? optionalJson(data.communesUrl) : null]);
      mosaic = new SceneMosaic({ ...data.options, index: data.index, loadScene, textureManifest: data.textureManifest, textureBase: data.textureBase, backgroundSources: Array.isArray(context) ? context : (context?.tiles || []), boundaries: Array.isArray(communes) ? communes : (communes?.communes || communes?.features || []), cacheLimit: 0, preferAvif: useAvif });
    })();
    return;
  }
  if (data.type === 'compose') {
    try {
      await ready;
      const result = await mosaic.compose(data.view, { focusId: data.focusId });
      if (!result) { self.postMessage({ id: data.id, result: null }); return; }
      self.postMessage({ id: data.id, result: { scene: result.scene, bounds: result.bounds, sources: result.sources.map(source => ({ id: source.id })) } });
      schedulePrefetch(data.view);
    } catch (error) { self.postMessage({ id: data.id, error: String(error?.message || error) }); }
  }
};
