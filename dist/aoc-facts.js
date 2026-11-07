const number = (value, digits = 2) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : null;
};

export const formatHectares = (value, digits = 2) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? `${number(n, digits)} ha` : null;
};

const human = value => String(value ?? '').replaceAll('_', ' ').replaceAll('-', ' ');

const pick = (value, ...keys) => {
  if (value == null || typeof value !== 'object') return value;
  for (const key of keys) if (value[key] != null) return value[key];
  return undefined;
};

const displayTier = value => value === 'Regional' ? 'Regional appellation' : value === 'Village' ? 'Village appellation' : value;

export function mergeFeatureFacts(feature = {}, meta = null) {
  const current = feature?.properties || feature || {};
  return { ...(meta || {}), ...current, aocVerification: current.aocVerification ?? meta?.aocVerification };
}

const VERIFIED_STATUSES = new Set(['official-name-and-location-matched', 'official-source-matched', 'shared-eligibility-name-and-location-matched']);
const SPATIAL_STATUSES = new Set(['spatial-full-coverage', 'spatial-partial-coverage', 'no-overlap']);
// 'Cru' is a Northern Rhône cru (region pages): above its regional Côtes du Rhône, like a named Burgundy cru.
const SPATIAL_TIER_RANK = new Map([['Grand Cru', 4], ['Premier Cru', 3], ['Cru', 3], ['Village', 2], ['Beaujolais Cru', 2], ['Regional', 1]]);

const spatialData = meta => {
  const value = meta?.spatialAocEligibility ?? meta?.spatial_aoc_eligibility;
  return value && typeof value === 'object' ? value : null;
};

const validSpatialMatches = spatial => (Array.isArray(spatial?.matches) ? spatial.matches : [])
  .filter(match => match && typeof match === 'object' && Number.isFinite(Number(match.coverageFraction)) && Number(match.coverageFraction) > 0 && Number(match.coverageFraction) <= 1.000001)
  .map(match => ({ ...match, coverageFraction: Math.min(1, Number(match.coverageFraction)) }))
  .sort((a, b) => b.coverageFraction - a.coverageFraction || String(a.appellation || '').localeCompare(String(b.appellation || '')));

const spatialTierRank = value => SPATIAL_TIER_RANK.get(String(value || '')) || 0;
const coveragePercent = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const percent = n * 100;
  return `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
};

export function spatialAocMatches(meta = {}) {
  return validSpatialMatches(spatialData(meta));
}

// A lieu-dit is classified by its AOC (vineyard) land only. Roads, houses, woods and field edges inside the
// cadastral outline are not classified land, so they never dilute the answer: Les Petits Musigny is simply
// Grand Cru Musigny. Shares below are fractions of that vineyard land, not of the whole outline.
const WHOLE_LAND = .98;     // one appellation covering this much of the vineyard land covers all of it (drawing slivers)
const MEANINGFUL_PART = .02; // a higher-tier part smaller than this share of the vineyard land…
const MEANINGFUL_M2 = 500;   // …and smaller than this is a boundary sliver; a small but whole cru (0.4 ha in a 29 ha lieu-dit) is not
const meaningful = m => m.share >= MEANINGFUL_PART || Number(m.intersectionAreaM2) >= MEANINGFUL_M2;
const shareText = share => share >= WHOLE_LAND ? 'all of the vineyard land' : `${Math.round(share * 100)}% of the vineyard land`;

function specificName(group) {
  // "Volnay premier cru Santenots" is more informative than its parent "Volnay premier cru".
  return group.map(m => String(m.denomination || m.appellation || '')).sort((a, b) => b.length - a.length)[0] || 'Unnamed AOC';
}

function byAppellation(matches) {
  const groups = new Map();
  for (const match of matches) {
    // Village and premier cru share an appellation name ("Chambolle-Musigny"): keep tiers apart.
    const key = `${match.appellation || match.denomination || ''}|${match.tier || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  }
  return [...groups.values()].map(group => ({ ...group[0], name: specificName(group), share: Math.max(...group.map(m => m.share)) }))
    .sort((a, b) => placePreference(a) - placePreference(b));
}

// Grape and style appellations (aligoté, Passe-tout-grains, Crémant…) describe a wine, not a place: for regional
// land prefer the geographic appellation ("Bourgogne Hautes Côtes de Nuits"), then plain "Bourgogne". At village
// level the commune appellation ("Chassagne-Montrachet") is preferred over umbrella ones ("Côte de Beaune-Villages").
const WINE_STYLE = /aligot|passe-tout|mousseux|crémant|cremant|coteaux bourguignons|grand ordinaire/i;
const UMBRELLA = /-villages\b|\bvillages$/i;
function placePreference(match) {
  const name = String(match.appellation || match.name || '').trim();
  const rank = spatialTierRank(match.tier);
  if (rank === 1) return WINE_STYLE.test(name) ? 2 : name === 'Bourgogne' ? 1 : 0;
  if (rank === 2) return UMBRELLA.test(name) ? 1 : 0;
  return 0;
}

export function spatialAocIdentity(meta = {}) {
  const spatial = spatialData(meta);
  if (!spatial || !SPATIAL_STATUSES.has(String(spatial.status || ''))) return null;
  const raw = validSpatialMatches(spatial);
  const mapped = Number(spatial.mappedAreaM2);
  if (spatial.status === 'no-overlap' || !raw.length) return {
    status: 'no-overlap', matches: [], selected: [], tier: null, lead: null, aocLandFraction: 0, aocLandM2: 0,
    eligibility: 'No AOC vineyard land in this lieu-dit', statusLabel: 'No AOC vineyard land',
  };
  const aocLandFraction = Math.max(...raw.map(m => m.coverageFraction));
  const matches = raw.map(m => ({ ...m, share: Math.min(1, m.coverageFraction / aocLandFraction) }));
  const aocLandM2 = Number.isFinite(mapped) ? aocLandFraction * mapped : null;
  const whole = matches.filter(m => m.share >= WHOLE_LAND);
  const topRank = Math.max(0, ...whole.map(m => spatialTierRank(m.tier)));
  const base = byAppellation(whole.filter(m => spatialTierRank(m.tier) === topRank));
  const higher = byAppellation(matches.filter(m => spatialTierRank(m.tier) > topRank && meaningful(m)))
    .sort((a, b) => spatialTierRank(b.tier) - spatialTierRank(a.tier) || b.share - a.share);
  const common = { matches, aocLandFraction, aocLandM2 };
  if (base.length && !higher.length) {
    const best = Math.min(...base.map(placePreference));
    let pool = base.filter(m => placePreference(m) === best);
    if (topRank === 1 && best === 2) {
      // Only a style appellation reaches every corner of the land: name the place appellation covering nearly all of it.
      const near = byAppellation(matches.filter(m => spatialTierRank(m.tier) === 1 && m.share >= .9)).filter(m => placePreference(m) < 2);
      if (near.length) pool = near;
    }
    // Land eligible only for style appellations has no place name: list those appellations rather than pick one.
    const styleOnly = topRank === 1 && pool.every(m => placePreference(m) === 2);
    const single = topRank <= 2 && !styleOnly;
    const selected = single ? pool.slice(0, 1) : pool.slice(0, 2);
    const alternatives = single ? 0 : pool.length - selected.length;
    const names = `${selected.map(m => m.name).join(' / ')}${alternatives ? ` · +${alternatives} alternatives` : ''}`;
    return { ...common, status: 'classified', selected, lead: selected[0], tier: displayTier(selected[0].tier), eligibility: names, statusLabel: `${displayTier(selected[0].tier)} · ${shareText(1)}` };
  }
  // The vineyard land is split. Crus at the same tier are separate pieces of land, so each gets its own share;
  // a lower tier covers the higher ones as well (INAO delimits cru land for the lower appellations too), so it
  // only takes what is left. Parts are added from the highest tier down until the vineyard land is accounted for.
  const parts = [];
  let accounted = 0;
  const ranks = [...new Set(matches.map(m => spatialTierRank(m.tier)))].sort((a, b) => b - a);
  for (const rank of ranks) {
    if (accounted >= WHOLE_LAND) break;
    const atRank = matches.filter(m => spatialTierRank(m.tier) === rank && meaningful(m));
    if (!atRank.length) continue;
    if (rank >= 3) {
      // Named crus, not their generic parent ("Vosne-Romanée premier cru") when named ones exist.
      const named = atRank.filter(m => !/premier cru$/i.test(String(m.denomination || '').trim()) || !atRank.some(o => o !== m && String(o.denomination || '').startsWith(String(m.denomination || '')) && o.denomination !== m.denomination));
      let pieces = [...new Map(named.map(m => [String(m.denomination || m.appellation), m])).values()].sort((a, b) => b.share - a.share);
      // INAO can delimit the same plot under two premier cru names of one appellation (a premier cru also sold
      // under a neighbour's name). If they add up to more than their "<appellation> premier cru" parent covers,
      // they overlap: present them as one part. Different appellations (grand crus) never merge.
      const merged = [];
      for (const appellation of new Set(pieces.map(m => String(m.appellation || '')))) {
        const group = pieces.filter(m => String(m.appellation || '') === appellation);
        const parent = atRank.find(m => String(m.appellation || '') === appellation && /premier cru$/i.test(String(m.denomination || '').trim()));
        if (group.length > 1 && parent && group.reduce((sum, m) => sum + m.share, 0) > parent.share * 1.05 + .001) {
          merged.push({ ...group[0], denomination: group.map(m => String(m.denomination || m.appellation)).join(' / '), share: parent.share });
        } else merged.push(...group);
      }
      pieces = merged.sort((a, b) => b.share - a.share);
      for (const piece of pieces) {
        const share = Math.min(piece.share, 1 - accounted);
        if (share <= 0 || !meaningful({ ...piece, share })) continue;
        parts.push({ ...piece, name: String(piece.denomination || piece.appellation), exclusiveShare: share });
        accounted += share;
      }
    } else {
      const best = byAppellation(atRank)[0];
      const share = Math.max(0, Math.max(...atRank.map(m => m.share)) - accounted);
      if (share >= MEANINGFUL_PART || (share > 0 && parts.length === 0)) { parts.push({ ...best, exclusiveShare: share }); accounted += share; }
    }
  }
  const described = parts.map((m, i) => i === parts.length - 1 && parts.length > 1 && accounted >= WHOLE_LAND ? `${m.name} on the rest` : `${m.name} on ${shareText(m.exclusiveShare)}`);
  const tiers = parts.map(m => displayTier(m.tier)).filter((t, i, all) => all.indexOf(t) === i);
  return { ...common, status: 'split', selected: parts, lead: parts[0], tier: tiers.join(' / '), eligibility: described.join('; '), statusLabel: 'Split classification' };
}

export function featureIdentity(meta = {}, layer = 'climats') {
  const aoc = meta.aocVerification ?? meta.aoc_verification;
  const explicitType = meta.featureType ?? meta.feature_type ?? aoc?.featureType;
  const placeType = explicitType ? String(explicitType) : layer === 'parcels' ? 'Appellation area' : layer === 'cadastre' ? 'Cadastral parcel' : 'Lieu-dit';
  const status = String(aoc?.verificationStatus ?? meta.classificationStatus ?? '');
  const verified = VERIFIED_STATUSES.has(status);
  const rawTier = verified ? String(aoc?.officialTier || '') : '';
  const tier = rawTier === 'Regional' ? 'Regional appellation' : rawTier === 'Village' ? 'Village appellation' : rawTier || null;
  const eligibility = verified && (aoc?.officialDenomination || aoc?.officialAppellation || (Array.isArray(aoc?.eligibleAppellations) && aoc.eligibleAppellations[0]));
  if (eligibility) return { placeType, tier, aocEligibility: String(eligibility) };
  const spatial = spatialAocIdentity(meta);
  if (spatial) return { placeType, tier: spatial.tier, aocEligibility: spatial.eligibility };
  return { placeType, tier: null, aocEligibility: 'AOC identification under review' };
}

export function aocFactLines(meta = {}) {
  const aoc = meta.aocVerification ?? meta.aoc_verification;
  const hasSpatial = Boolean(spatialData(meta));
  const directStatus = String(aoc?.verificationStatus || meta.classificationStatus || '');
  if (aoc && typeof aoc === 'object' && (!hasSpatial || VERIFIED_STATUSES.has(directStatus))) {
    const lines = [];
    const add = (label, value) => { if (value != null && String(value).trim()) lines.push({ label, value: String(value) }); };
    const ha = value => value == null || value === '' ? null : formatHectares(Number(value) / 10000);
    const scopedArea = (value, status, fallback) => { const formatted = ha(value); return formatted ? `${formatted}${status ? ` · ${human(status)}` : ''}` : human(status || fallback); };
    add('Official appellation', aoc.officialAppellation);
    add('Official denomination', aoc.officialDenomination);
    add('Official tier', displayTier(aoc.officialTier));
    add('Geometry scope', human(aoc.geometryScope));
    add('Physical named-vineyard area', scopedArea(aoc.physicalAreaM2, aoc.physicalStatus, 'not available'));
    add('Legal AOC eligibility area', scopedArea(aoc.legalAreaM2, null, 'not available'));
    add(aoc.geometryScope === 'named-place-reference' ? 'Mapped lieu-dit area' : 'Exclusive display area', scopedArea(aoc.displayAreaM2, aoc.geometryScope, 'not available'));
    if (Array.isArray(aoc.eligibleAppellations) && aoc.eligibleAppellations.length) add('Eligible appellations', aoc.eligibleAppellations.join(', '));
    const productionHa = meta.productionAreaHa ?? meta.productionHa;
    if (productionHa != null && productionHa !== '') add('Declared production area', `${formatHectares(productionHa, 3)}${meta.productionYear != null ? ` · ${meta.productionYear} campaign` : ''}`);
    add('Verification', human(aoc.verificationStatus || 'not assessed'));
    add('Source snapshot', aoc.snapshot || 'not available');
    if (aoc.note) add('Scope note', aoc.note);
    if (hasSpatial) lines.push(...aocFactLines({ ...meta, aocVerification: null, aoc_verification: null }).filter(row => row.label !== 'Source snapshot'));
    return lines;
  }
  const spatial = spatialAocIdentity(meta);
  if (spatial) {
    const source = spatialData(meta);
    const lines = [{ label: 'Classification', value: spatial.status === 'no-overlap' ? spatial.statusLabel : `${spatial.tier} · ${spatial.eligibility}` },
      { label: 'Classification basis', value: 'AOC vineyard land only; roads, houses, woods and field edges inside the lieu-dit are not classified land' }];
    const mapped = Number(source.mappedAreaM2);
    if (spatial.status === 'no-overlap') {
      const minimumOverlap = Number(source.threshold?.minimumOverlapM2);
      const minimumCoverage = Number(source.threshold?.minimumCoverageFraction);
      const tolerance = [Number.isFinite(minimumOverlap) ? `${number(minimumOverlap, 2)} m²` : null, Number.isFinite(minimumCoverage) ? `${coveragePercent(minimumCoverage)} of mapped place` : null].filter(Boolean).join(' · ');
      if (tolerance) lines.push({ label: 'INAO match tolerance', value: tolerance });
    } else if (Number.isFinite(mapped) && mapped > 0) {
      lines.push({ label: 'Vineyard (AOC) land', value: `${formatHectares(spatial.aocLandM2 / 10000)} of the ${formatHectares(mapped / 10000)} lieu-dit` });
    }
    const appellations = byAppellation(spatial.matches);
    // Rows for the classification itself; lower appellations the same land may also be declared under go in one line.
    const floor = Math.min(...(spatial.selected || []).map(m => spatialTierRank(m.tier)), 99);
    const named = appellations.filter(m => spatialTierRank(m.tier) >= floor).sort((a, b) => spatialTierRank(b.tier) - spatialTierRank(a.tier) || b.share - a.share);
    named.forEach(match => lines.push({ label: displayTier(match.tier), value: `${match.name} · ${shareText(match.share)}` }));
    const lower = appellations.filter(m => spatialTierRank(m.tier) < floor).sort((a, b) => spatialTierRank(b.tier) - spatialTierRank(a.tier)).map(m => m.name);
    if (lower.length) lines.push({ label: 'Also eligible', value: lower.join(', ') });
    if (source.snapshot) lines.push({ label: 'Source snapshot', value: String(source.snapshot) });
    return lines;
  }
  const lines = [];
  const add = (label, value) => { if (value != null && String(value).trim()) lines.push({ label, value: String(value) }); };
  if (meta.productionAreaHa != null && meta.productionAreaHa !== '') add('Declared production area', `${formatHectares(meta.productionAreaHa, 3)}${meta.productionYear != null ? ` · ${meta.productionYear} campaign` : ''}`);
  return lines;
}

export function factScopeWarning(meta = {}) {
  const aoc = meta.aocVerification ?? meta.aoc_verification;
  if (aoc?.geometryScope === 'legal-aoc' || aoc?.geometryScope === 'legal-denomination' || aoc?.geometryScope === 'shared-eligibility') return 'Legal AOC eligibility is shown as a separate scope and is not an exclusive physical vineyard boundary.';
  if (aoc?.physicalStatus === 'unverified') return 'Physical named-vineyard scope is unverified; legal eligibility is shown separately.';
  return null;
}
