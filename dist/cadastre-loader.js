export function cadastreTargets(manifest, view, limit = 6) {
  const r = Math.max(100, Number(view.radiusMetres)) * 1.35;
  const x = Number(view.easting), y = Number(view.northing);
  return Object.entries(manifest.communes || {}).map(([code, meta]) => {
    const b = meta.bounds;
    if (!Array.isArray(b) || b.length !== 4) return null;
    const distance = Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
    const centerDistance = Math.hypot((b[0] + b[2]) / 2 - x, (b[1] + b[3]) / 2 - y);
    return distance <= r ? { code, meta, distance, centerDistance } : null;
  }).filter(Boolean).sort((a, b) => a.distance - b.distance || a.centerDistance - b.centerDistance || a.code.localeCompare(b.code)).slice(0, limit);
}

export class CadastreLoader {
  constructor({ fetchManifest, fetchCommune, publish, status, maxRadius = 2200, cacheLimit = 8 }) {
    Object.assign(this, { fetchManifest, fetchCommune, publish, status, maxRadius, cacheLimit });
    this.cache = new Map();
    this.revision = 0;
    this.publishedKey = '';
    this.pendingKey = '';
    this.mode = '';
  }

  async manifest() {
    if (!this.manifestPromise) {
      this.manifestPromise = Promise.resolve().then(this.fetchManifest).then(data => {
        if (data?.crs !== 'EPSG:2154' || !data.communes) throw new Error('Invalid cadastral manifest');
        return data;
      }).catch(error => { this.manifestPromise = null; throw error; });
    }
    return this.manifestPromise;
  }

  clear(mode, message) {
    this.revision++;
    this.controller?.abort();
    this.pendingKey = '';
    if (this.publishedKey) this.publish([], {});
    this.publishedKey = '';
    this.mode = mode;
    this.status(message, mode);
  }

  async update(view, enabled = true) {
    if (!enabled) { this.clear('hidden', 'Cadastral parcels are hidden.'); return; }
    if (!view || !Number.isFinite(view.easting) || !Number.isFinite(view.northing) || !Number.isFinite(view.radiusMetres)) return;
    if (view.radiusMetres > this.maxRadius) {
      if (this.mode !== 'zoom') this.clear('zoom', 'Zoom in to see parcel boundaries.');
      return;
    }
    const beforeManifest = this.revision;
    let manifest;
    try { manifest = await this.manifest(); }
    catch { if (beforeManifest === this.revision) this.status('Cadastral data could not load. Toggle the layer to retry.', 'error'); return; }
    if (beforeManifest !== this.revision) return;
    const targets = cadastreTargets(manifest, view);
    if (!targets.length) { this.clear('unavailable', 'No cadastral coverage in this view.'); return; }
    const key = targets.map(row => row.code).sort().join(',');
    if (key === this.publishedKey || key === this.pendingKey) return;
    const revision = ++this.revision;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    this.pendingKey = key;
    this.mode = 'loading';
    this.status('Loading nearby cadastral parcels…', 'loading');
    const results = await Promise.allSettled(targets.map(async ({ code, meta }) => {
      let value = this.cache.get(code);
      if (!value) {
        const payload = await this.fetchCommune(meta, controller.signal);
        if (!Array.isArray(payload?.parcels)) throw new Error(`Invalid cadastre data: ${code}`);
        value = { code, parcels: payload.parcels.map(parcel => ({ ...parcel, communeCode: parcel.communeCode || code, __cadastreMeta: { communeCode: code, sourceDate: payload.sourceDate || meta.sourceDate, sourceUrl: payload.sourceUrl || meta.sourceUrl } })) };
      }
      if (revision === this.revision && !controller.signal.aborted) {
        this.cache.delete(code);
        this.cache.set(code, value);
        while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
      }
      return value;
    }));
    if (revision !== this.revision || controller.signal.aborted) return;
    this.pendingKey = '';
    const loaded = results.filter(row => row.status === 'fulfilled').map(row => row.value);
    const failures = results.length - loaded.length;
    const parcels = loaded.flatMap(row => row.parcels);
    if (!loaded.length) { this.clear('error', 'Cadastral data is unavailable here. Toggle the layer to retry.'); return; }
    // A partial result is retryable rather than permanently cached as complete.
    this.publishedKey = failures ? `partial:${key}` : key;
    this.publish(parcels, { ...manifest, communes: undefined, loadedCommunes: loaded.map(row => row.code) });
    this.mode = failures ? 'partial' : 'ready';
    this.status(`${loaded.length} nearby communes · ${parcels.length.toLocaleString()} parcel records${failures ? ` · ${failures} unavailable` : ''}`, this.mode);
  }
}
