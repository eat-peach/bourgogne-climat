const text = value => String(value ?? '').trim();
const parcelId = parcel => text(parcel?.id ?? parcel?.parcelId ?? parcel?.parcel_id ?? parcel?.properties?.id ?? parcel?.properties?.parcelId);
const communeCode = parcel => text(parcel?.communeCode ?? parcel?.commune_code ?? parcel?.codeCommune ?? parcel?.properties?.communeCode);

export function ownershipTargets(manifest, parcel) {
  const code = communeCode(parcel);
  if (!code) return [];
  const commune = manifest?.communes?.[code];
  return commune ? [{ code, ...commune }] : [];
}

export function ownershipRows(payload, parcel) {
  const id = parcelId(parcel);
  if (!id || !payload || typeof payload.parcels !== 'object' || Array.isArray(payload.parcels)) return [];
  const rows = payload.parcels[id];
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({
    // displayName: the DGFiP name made readable (legal form, capitals, accents); entityName stays exactly as published.
    displayName: text(row?.displayName),
    areaM2: Number(row?.areaM2) || 0,
    land: Array.isArray(row?.land) ? row.land.map(text).filter(Boolean) : [],
    entityName: text(row?.entityName),
    siren: text(row?.siren),
    rightsCode: text(row?.rightsCode),
    rightLabel: text(row?.rightsLabel),
    asOf: text(row?.sourceAsOf ?? payload?.sourceAsOf),
  })).filter(row => row.entityName || row.siren || row.rightsCode || row.rightLabel);
}

export function formatOwnershipFacts(rows, meta = {}) {
  return rows.map(row => ({
    title: row.displayName || row.entityName || 'Recorded legal entity',
    details: [row.displayName && row.entityName && row.displayName.replace(/…$/, '') !== row.entityName && `Registered as ${row.entityName}`, row.siren && `${/^\d{9}$/.test(row.siren) ? 'SIREN' : 'DGFiP entity identifier'} ${row.siren}`, row.rightsCode && `Rights code ${row.rightsCode}`, row.rightLabel, row.areaM2 && `Parcel area ${row.areaM2 >= 10000 ? `${(row.areaM2 / 10000).toFixed(2)} ha` : `${row.areaM2} m²`}`, row.land?.length && `Recorded use: ${row.land.join(', ')}`, (row.asOf || meta.sourceAsOf) && `As of ${row.asOf || meta.sourceAsOf}`].filter(Boolean),
  }));
}

export class OwnershipLoader {
  constructor({ fetchManifest, fetchPayload, maxCache = 8 } = {}) {
    this.fetchManifest = fetchManifest;
    this.fetchPayload = fetchPayload;
    this.maxCache = Math.max(1, maxCache);
    this.manifest = null;
    this.cache = new Map();
    this.pending = new Map();
  }

  async loadForParcel(parcel) {
    const code = communeCode(parcel), id = parcelId(parcel), key = code;
    if (!code || !id) return { status: 'unknown', rows: [], meta: null };
    if (this.cache.has(key)) return this.resultForParcel(this.cache.get(key), parcel);
    const resolve = record => record?.status ? record : this.resultForParcel(record, parcel);
    if (this.pending.has(key)) return this.pending.get(key).then(resolve);
    const request = (async () => {
      try {
        this.manifest ||= await this.fetchManifest();
        const target = ownershipTargets(this.manifest, parcel)[0];
        if (!target) return { status: 'unsupported', rows: [], meta: this.manifest };
        const payload = await this.fetchPayload(target);
        if (!payload || !payload.parcels || typeof payload.parcels !== 'object' || Array.isArray(payload.parcels)) {
          throw new Error('Invalid or unavailable legal-entity payload');
        }
        const record = { payload, meta: { ...this.manifest, ...target, ...payload } };
        this.remember(key, record);
        return record;
      } catch (error) {
        return { status: 'unavailable', rows: [], error };
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, request);
    return request.then(resolve);
  }

  remember(key, value) {
    this.cache.set(key, value);
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  resultForParcel(record, parcel) {
    const rows = ownershipRows(record?.payload, parcel);
    return { status: rows.length ? 'ok' : 'unknown', rows, meta: record?.meta || null };
  }
}
