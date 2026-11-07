export function areaUnits(squareMetres) {
  if (squareMetres == null || squareMetres === '' || !Number.isFinite(Number(squareMetres)) || Number(squareMetres) < 0) return null;
  const m2 = Number(squareMetres);
  // Values of 1 or more keep a fixed number of decimals; smaller values keep three significant figures.
  const format = (value, digits) => value === 0 ? '0' : value >= 1
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits })
    : value.toLocaleString(undefined, { maximumSignificantDigits: 3 });
  return { ha: format(m2 / 10000, 2), km2: format(m2 / 1000000, 2), acres: format(m2 / 4046.8564224, 1) };
}

export function areaText(squareMetres) {
  const units = areaUnits(squareMetres);
  return units ? `${units.ha} ha · ${units.km2} km² · ${units.acres} acres` : 'Not available';
}

export function placeHeading(place, village) {
  const name = displayPlaceName(place), commune = displayPlaceName(village);
  const normalized = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s-]+/g, '');
  return name && commune && normalized(name) !== normalized(commune) ? `${name} – ${commune}` : name || commune;
}

export function displayPlaceName(value) {
  const text = String(value || '').trim();
  if (!text || text !== text.toLocaleUpperCase('fr')) return text;
  const particles = new Set(['DE','DU','DES','LA','LE','LES','ET','EN','AU','AUX','SUR']);
  return text.split(/\s+/).map((word, i) => i && particles.has(word) ? word.toLocaleLowerCase('fr') : word.toLocaleLowerCase('fr').replace(/(^|[-'’])\p{L}/gu, part => part.toLocaleUpperCase('fr'))).join(' ');
}

const COMMUNE_PARTICLES = new Set(['le','la','les','sur','sous','en','de','du','des','lès','lés','lez','et','aux','au','à']);
// French commune names keep linking particles lower case after the first word: Berzé-la-Ville, Saint-Symphorien-d'Ancelles.
const COMMUNE_NAME_FIXES = new Map([['Chapelle-De-Guinchay', 'La Chapelle-de-Guinchay'], ['Chapelle-Sous-Brancion', 'La Chapelle-sous-Brancion'], ['Chapelle-Vaupelteigne', 'La Chapelle-Vaupelteigne']]);
export function communeDisplayName(value) {
  const text = String(value || '').trim();
  if (!text) return text;
  if (COMMUNE_NAME_FIXES.has(text)) return COMMUNE_NAME_FIXES.get(text);
  return text.split('-').map((part, i) => {
    if (!i) return part;
    const lower = part.toLocaleLowerCase('fr');
    if (COMMUNE_PARTICLES.has(lower)) return lower;
    return part.replace(/^([DL])(['’])/, (match, letter, quote) => letter.toLowerCase() + quote);
  }).join('-');
}

export function displayEntityName(value) {
  const text = String(value || '').trim();
  if (!text || text !== text.toLocaleUpperCase('fr')) return text;
  const acronyms = new Set(['SCI','SC','SCV','GFV','GFA','EARL','SCEA','SARL','SAS','SA','GAEC','GIE','SNC','SCEV','GFR','SASU','EURL']);
  const particles = new Set(['DE','DU','DES','LA','LE','LES','ET','EN','AU','AUX','SUR']);
  return text.split(/\s+/).map((word, i) => acronyms.has(word) ? word : i && particles.has(word) ? word.toLocaleLowerCase('fr') : word.slice(0, 1) + word.slice(1).toLocaleLowerCase('fr')).join(' ');
}

export function displayRecordDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return '';
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function featureArea(meta = {}) {
  const aoc = meta.aocVerification;
  if (aoc?.physicalStatus === 'derived-supported' && areaUnits(aoc.physicalAreaM2)) return { value: aoc.physicalAreaM2, label: 'Physical vineyard · derived boundary' };
  if (aoc?.geometryScope === 'named-place-reference') return { value: aoc.legalAreaM2, label: aoc.areaLabel || 'Full legal denomination · INAO boundary' };
  if (aoc) return { value: aoc.legalAreaM2, label: 'Legal appellation area · may overlap other AOCs' };
  const spatial = meta.spatialAocEligibility;
  const fractions = (Array.isArray(spatial?.matches) ? spatial.matches : []).map(m => Number(m.coverageFraction)).filter(n => n > 0 && n <= 1.000001);
  if (fractions.length && Number(spatial.mappedAreaM2) > 0) {
    // Vineyard (AOC) land is the meaningful figure; roads and woods inside the outline are context only.
    const whole = areaUnits(spatial.mappedAreaM2);
    return { value: Math.min(1, Math.max(...fractions)) * Number(spatial.mappedAreaM2), label: `Vineyard (AOC) land · whole lieu-dit ${whole.ha} ha` };
  }
  if (Number(meta.aocDelimitedAreaM2) > 0) return { value: meta.aocDelimitedAreaM2, label: 'AOC-delimited area · mapped eligibility' };
  return { value: meta.mappedAreaStatus === 'available' ? meta.mappedAreaM2 : null, label: meta.mappedAreaScope === 'full-source-named-place' ? 'Full mapped lieu-dit · boundary unverified' : 'Mapped polygon · boundary unverified' };
}

export function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

export function detailRow(container, label, value) {
  if (value == null || value === '') return;
  const row = element('div', 'fact-detail-row');
  row.append(element('dt', '', label), element('dd', '', String(value)));
  container.append(row);
}

const TIER_KEYS = [['grand', /grand cru/i], ['premier', /premier cru|1er cru/i], ['village', /village/i], ['regional', /regional|régional/i]];

export function glanceTile(label, value, sub, { className = '', icon = '' } = {}) {
  const tile = element('div', `glance-tile${className ? ` ${className}` : ''}`);
  tile.innerHTML = `<span class="terroir-k">${label}</span><strong class="terroir-v">${icon}</strong><small></small>`;
  tile.querySelector('strong').append(document.createTextNode(value ?? '—'));
  const small = tile.querySelector('small'); if (sub) small.textContent = sub; else small.remove();
  if (value == null) tile.classList.add('is-unavailable');
  return tile;
}

// The selected-feature card: a header, an at-a-glance grid (area and elevation now; terroir tiles join it when they
// load), a one-line ownership hint or the parcel's recorded rights, and every source detail folded into one disclosure.
export function renderFeaturePanel(card, { title, subtitle, identity = [], area, altitude, rows = [], links = [], ownershipPrompt }) {
  card.replaceChildren();
  card.classList.add('feature-summary');
  const header = element('header', 'fact-heading');
  const heading = element('h3', 'fact-place-heading');
  const separator = title.lastIndexOf(' – ');
  if (separator > 0) {
    const commune = element('span', 'fact-village-name');
    commune.append(element('span', 'fact-commune-label', 'Commune · '), document.createTextNode(title.slice(separator + 3)));
    heading.append(element('span', 'fact-place-name', title.slice(0, separator)), commune);
  }
  else heading.textContent = title;
  if (subtitle) {
    const tier = element('p', 'fact-tier', subtitle);
    const key = TIER_KEYS.find(([, re]) => re.test(subtitle))?.[0];
    if (key) tier.dataset.tier = key;
    header.append(tier);
  }
  header.append(heading);
  // identity: short values become chips ("Lieu-dit", "AOC La Tâche"); a long note stays a single quiet line
  const chips = element('div', 'fact-chips'), longNotes = [];
  for (const [label, value] of identity) {
    if (value == null || value === '') continue;
    const text = String(value);
    if (text.length > 60) { longNotes.push([label, text]); if (label === 'AOC') chips.append(element('span', 'fact-chip', 'Several AOCs · see details')); continue; }
    const fold = v => String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    if (label === 'AOC' && separator > 0 && fold(text) === fold(title.slice(0, separator))) continue; // same as the heading
    chips.append(element('span', 'fact-chip', label === 'AOC' ? `AOC ${text}` : text));
  }
  if (chips.childElementCount) heading.after(chips);

  const glance = element('section', 'fact-glance');
  glance.setAttribute('aria-label', 'At a glance');
  const units = areaUnits(area?.value);
  glance.append(glanceTile('Area', units ? `${units.ha} ha` : null, units ? `${units.acres} acres` : 'Not available', { className: 'glance-area' }));
  if (altitude?.value) glance.append(glanceTile('Elevation', altitude.value, 'near the centre', { className: 'glance-elevation' }));

  const ownership = element('section', 'fact-ownership');
  ownership.dataset.ownership = '';
  if (ownershipPrompt) ownership.append(element('h4', 'fact-label', 'Ownership'), element('p', 'fact-value is-unavailable', ownershipPrompt));
  else { ownership.classList.add('is-hint'); ownership.append(element('p', 'fact-hint', 'To see recorded owners, tap a cadastral parcel on the map.')); }

  const details = element('details', 'fact-disclosure');
  details.append(element('summary', '', 'Sources & details'));
  const body = element('div', 'fact-details-body');
  const list = element('dl', 'fact-details-list');
  if (units) detailRow(list, 'Area', `${areaText(area.value)}${area?.label ? ` · ${area.label}` : ''}`);
  if (altitude?.caption && altitude?.value) detailRow(list, 'Elevation estimate', altitude.caption);
  longNotes.forEach(([label, value]) => detailRow(list, label, value));
  rows.forEach(([label, value]) => detailRow(list, label, value));
  const sourceList = element('div', 'fact-sources');
  for (const [label, href] of links) {
    if (!href) continue;
    const a = element('a', '', `${label} ↗`);
    a.href = href; a.target = '_blank'; a.rel = 'noopener'; sourceList.append(a);
  }
  body.append(list, sourceList); details.append(body);
  card.append(header, glance, ownership, details);
  return { ownership, body, list, sourceList };
}
