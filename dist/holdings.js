// Who has vines in a cru: the legal entities in the DGFiP register, shown under the domaine they belong to where a
// sourced link exists (data/ownership/domaines.json, 'entities'), plus domaines with vines there that the register does
// not show (land held by private individuals is withheld from it), from a dated source ('holdings', per cru id).

// The domaine a register entity belongs to, or null. Keys are the entity's SIREN or DGFiP identifier.
export function entityDomaine(data, id) {
  const e = data?.entities?.[String(id ?? '').trim()];
  return e && e.domaine ? e : null;
}

// What to call a register entity: the linked domaine's name when there is one, else its registered name.
export function entityLabel(data, entity, displayName = n => n) {
  const link = entityDomaine(data, entity?.siren);
  return link ? link.domaine : displayName(entity?.name || '');
}

// The holdings rows for a cru id (as in owner-crus.json.gz), or [].
export function cruHoldings(data, cruId) {
  const rows = data?.holdings?.[String(cruId ?? '')]?.rows;
  return Array.isArray(rows) ? rows.filter(r => r && r.domaine && Number(r.ha) > 0) : [];
}

// owners: from the cru's parcels, { total, entities: [{ o: {name, siren}, ids: [parcel ids] }], areas: Map(id → m²) }.
// Entities linked to the same domaine are merged, counting each parcel once (co-owned parcels list every owner).
// Returns rows sorted by area, the cru's recorded area (parcels with any owner on record), the area added by reported
// holdings, and both as shares of the cru's parcel area (capped at 100%: sources differ in date and precision).
// cruAreaM2: the cru's own area; owner-crus.json.gz only knows parcels with an owner on record, so without it the
// share would always be 100%.
export function cruOwnerSummary(owners, data, cruId, displayName = n => n, cruAreaM2 = 0) {
  const total = Math.max(Number(owners?.total) || 0, Number(cruAreaM2) || 0), areas = owners?.areas || new Map(), groups = new Map(), recordedIds = new Set();
  for (const e of owners?.entities || []) {
    const link = entityDomaine(data, e.o?.siren), key = link ? `d:${link.domaine}` : `e:${e.o?.siren || e.o?.name}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { name: link ? link.domaine : displayName(e.o?.name || ''), kind: 'recorded', ids: new Set(), registered: [], link: link || null });
    for (const id of e.ids || []) { g.ids.add(id); recordedIds.add(id); }
    g.registered.push(displayName(e.o?.name || ''));
  }
  const area = ids => [...ids].reduce((s, id) => s + (Number(areas.get(id)) || 0), 0);
  const rows = [...groups.values()].map(g => ({ name: g.name, kind: 'recorded', areaM2: area(g.ids), registered: g.link ? g.registered : [], basis: g.link?.basis || null, why: g.link?.why || null, sources: g.link?.sources || [] }));
  const recordedNames = new Set(rows.map(r => r.name));
  let reportedM2 = 0;
  for (const h of cruHoldings(data, cruId)) {
    if (recordedNames.has(h.domaine)) continue; // already on record: the register's area stands
    const m2 = Number(h.ha) * 10000; reportedM2 += m2;
    rows.push({ name: h.domaine, kind: h.basis === 'declared' ? 'declared' : 'reported', areaM2: m2, approx: Boolean(h.approx), by: h.by || '', url: h.url || '' });
  }
  rows.sort((a, b) => b.areaM2 - a.areaM2 || a.name.localeCompare(b.name, 'fr'));
  const recordedM2 = area(recordedIds), share = m2 => total > 0 ? Math.min(1, m2 / total) : 0;
  return { totalM2: total, recordedM2, reportedM2, recordedShare: share(recordedM2), knownShare: share(recordedM2 + reportedM2), rows, checked: data?.holdings?.[String(cruId ?? '')]?.checked || data?.checked || '' };
}
