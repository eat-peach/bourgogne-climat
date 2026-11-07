// Sun position and rain runoff for the terrain, kept free of WebGL so it can be tested in Node.

const RAD = Math.PI / 180;

// Sun position (NOAA approximation, about 0.5° accuracy, no refraction). Azimuth is measured clockwise from north.
export function solarPosition(date, latitude, longitude) {
  const jd = date.getTime() / 86400000 + 2440587.5, T = (jd - 2451545) / 36525;
  const L0 = ((280.46646 + T * (36000.76983 + T * .0003032)) % 360 + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - .0001537 * T), e = .016708634 - T * (.000042037 + .0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (.004817 + .000014 * T)) + Math.sin(2 * M * RAD) * (.019993 - .000101 * T) + Math.sin(3 * M * RAD) * .000289;
  const omega = 125.04 - 1934.136 * T, lambda = L0 + C - .00569 - .00478 * Math.sin(omega * RAD);
  const eps = 23 + (26 + (21.448 - T * (46.815 + T * (.00059 - T * .001813))) / 60) / 60 + .00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan(eps * RAD / 2) ** 2;
  const eqTime = 4 / RAD * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD) + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) - .5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const hourAngle = ((minutes + eqTime + 4 * longitude) / 4 - 180) * RAD, lat = latitude * RAD;
  const cosZenith = Math.min(1, Math.max(-1, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)));
  const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / RAD + 180 + 360) % 360;
  return { elevation: 90 - Math.acos(cosZenith) / RAD, azimuth };
}

// France keeps Central European Time: UTC+1, and UTC+2 from the last Sunday of March to the last Sunday of October (01:00 UTC).
const lastSunday = (year, month) => { const d = new Date(Date.UTC(year, month + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
export function franceUtcOffset(utc) {
  const year = utc.getUTCFullYear(), start = Date.UTC(year, 2, lastSunday(year, 2), 1), end = Date.UTC(year, 9, lastSunday(year, 9), 1);
  return utc.getTime() >= start && utc.getTime() < end ? 2 : 1;
}

// A local French clock time on a given day of the year (1–366) as a UTC instant.
export function franceLocalToUtc(year, dayOfYear, minutes) {
  const guess = new Date(Date.UTC(year, 0, dayOfYear, 0, 0, Math.round((minutes - 60) * 60)));
  return new Date(Date.UTC(year, 0, dayOfYear, 0, 0, Math.round((minutes - 60 * franceUtcOffset(guess)) * 60)));
}

// Sunrise and sunset as French clock minutes, when the sun's centre is 0.833° below the horizon (refraction and the
// sun's radius), found minute by minute. null where the sun does not cross the horizon that day.
export function sunTimes(year, dayOfYear, latitude, longitude) {
  let rise = null, set = null, before = solarPosition(franceLocalToUtc(year, dayOfYear, 0), latitude, longitude).elevation;
  for (let minute = 1; minute <= 1440; minute++) {
    const now = solarPosition(franceLocalToUtc(year, dayOfYear, minute), latitude, longitude).elevation;
    if (before < -.833 && now >= -.833 && rise === null) rise = minute;
    if (before >= -.833 && now < -.833) set = minute;
    before = now;
  }
  return rise === null || set === null ? null : { rise, set };
}

// Which way rain runs on a square height grid (row 0 north). Pits are filled first (priority flood, with a small
// rise so flats still drain), then each cell drains to its steepest lower neighbour. Returns, per cell, the cell it
// drains to (-1 at the edge, on gaps, or into a gap) and how many cells drain through it, itself included.
export function rainRunoff(heights, valid, size, cellMetres) {
  const n = size * size, filled = new Float64Array(n), closed = new Uint8Array(n), receiver = new Int32Array(n).fill(-1), accumulation = new Float32Array(n);
  const heap = [], push = i => { heap.push(i); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (filled[heap[p]] <= filled[i]) break; heap[k] = heap[p]; k = p; } heap[k] = i; };
  const pop = () => {
    const top = heap[0], last = heap.pop(), count = heap.length;
    if (count) {
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1; let m = -1, best = filled[last];
        if (l < count && filled[heap[l]] < best) { m = l; best = filled[heap[l]]; }
        if (r < count && filled[heap[r]] < best) m = r;
        if (m < 0) break;
        heap[k] = heap[m]; k = m;
      }
      heap[k] = last;
    }
    return top;
  };
  const DR = [-1, -1, -1, 0, 0, 1, 1, 1], DC = [-1, 0, 1, -1, 1, -1, 0, 1], DIST = DR.map((r, k) => Math.hypot(r, DC[k]) * cellMetres);
  const ok = i => valid ? Boolean(valid[i]) : true;
  for (let i = 0; i < n; i++) {
    filled[i] = heights[i];
    if (!ok(i)) { closed[i] = 1; continue; }
    const row = Math.floor(i / size), col = i % size;
    let edge = row === 0 || col === 0 || row === size - 1 || col === size - 1;
    for (let k = 0; !edge && k < 8; k++) edge = !ok((row + DR[k]) * size + col + DC[k]);
    if (edge) { closed[i] = 1; push(i); }
  }
  while (heap.length) {
    const c = pop(), row = Math.floor(c / size), col = c % size;
    for (let k = 0; k < 8; k++) {
      const r = row + DR[k], q = col + DC[k]; if (r < 0 || q < 0 || r >= size || q >= size) continue;
      const nb = r * size + q; if (closed[nb]) continue;
      closed[nb] = 1; filled[nb] = Math.max(heights[nb], filled[c] + 1e-3); push(nb);
    }
  }
  for (let i = 0; i < n; i++) {
    if (!ok(i)) continue;
    const row = Math.floor(i / size), col = i % size;
    let best = -1, steepest = 0;
    for (let k = 0; k < 8; k++) {
      const r = row + DR[k], q = col + DC[k]; if (r < 0 || q < 0 || r >= size || q >= size) continue;
      const nb = r * size + q; if (!ok(nb)) continue;
      const drop = (filled[i] - filled[nb]) / DIST[k]; if (drop > steepest) { steepest = drop; best = nb; }
    }
    receiver[i] = best;
  }
  const order = [];
  for (let i = 0; i < n; i++) if (ok(i)) { order.push(i); accumulation[i] = 1; }
  order.sort((a, b) => filled[b] - filled[a]);
  for (const i of order) if (receiver[i] >= 0) accumulation[receiver[i]] += accumulation[i];
  return { receiver, accumulation, filled };
}

// How much of a storm runs off rather than soaking in, by the USDA SCS curve number method (TR-55):
// Q = (P − Ia)² / (P − Ia + S), with S = 25400 / CN − 254 mm and initial abstraction Ia = 0.2 S. Below Ia nothing runs off.
// CN 80 is a typical value for row crops with bare inter-rows on medium soils, used here as a stand-in for vineyards.
export const VINEYARD_CURVE_NUMBER = 80;
export function stormRunoffMm(rainMm, curveNumber = VINEYARD_CURVE_NUMBER) {
  const S = 25400 / curveNumber - 254, Ia = .2 * S, P = Math.max(0, Number(rainMm) || 0);
  return P <= Ia ? 0 : (P - Ia) ** 2 / (P - Ia + S);
}

// Distance in metres from the top of each flow path, following the receivers downhill (the longest path wins at joins).
export function flowLength(receiver, filled, valid, size, cellMetres) {
  const n = size * size, length = new Float32Array(n), order = [];
  for (let i = 0; i < n; i++) if (!valid || valid[i]) order.push(i);
  order.sort((a, b) => filled[b] - filled[a]);
  for (const i of order) {
    const to = receiver[i]; if (to < 0) continue;
    const step = Math.hypot(Math.floor(i / size) - Math.floor(to / size), i % size - to % size) * cellMetres;
    if (length[i] + step > length[to]) length[to] = length[i] + step;
  }
  return length;
}

// Fields that describe how a storm wets the ground, per grid cell:
//  dirX, dirZ – downhill unit direction of the actual (unfilled) surface, x east and z south, for water sliding over slopes;
//  slope      – surface gradient in metres per metre;
//  wetness    – topographic wetness index ln(a / tan β), a = upslope area per unit contour width: high in valley bottoms;
//  pond       – depth in metres by which a hollow must fill before it spills (filled minus actual height);
//  arrival    – seconds for water from the farthest point upslope to reach the cell (time of concentration), with
//               overland speed 4.9 √s m/s (USDA TR-55, shallow concentrated flow on unpaved ground), at least 0.1 m/s.
export function wetnessFields(heights, valid, size, cellMetres, routed) {
  const n = size * size, { receiver, accumulation, filled } = routed;
  const dirX = new Float32Array(n), dirZ = new Float32Array(n), slope = new Float32Array(n), wetness = new Float32Array(n), pond = new Float32Array(n), arrival = new Float32Array(n);
  const ok = i => !valid || Boolean(valid[i]);
  const at = (r, c, fallback) => { if (r < 0 || c < 0 || r >= size || c >= size) return fallback; const i = r * size + c; return ok(i) ? heights[i] : fallback; };
  const order = [];
  for (let i = 0; i < n; i++) {
    if (!ok(i)) continue;
    order.push(i);
    const r = Math.floor(i / size), c = i % size, h = heights[i];
    const gx = (at(r, c + 1, h) - at(r, c - 1, h)) / (2 * cellMetres), gz = (at(r + 1, c, h) - at(r - 1, c, h)) / (2 * cellMetres);
    const g = Math.hypot(gx, gz); slope[i] = g;
    if (g > 1e-6) { dirX[i] = -gx / g; dirZ[i] = -gz / g; }
    else if (receiver[i] >= 0) { const dr = Math.floor(receiver[i] / size) - r, dc = receiver[i] % size - c, d = Math.hypot(dr, dc); dirX[i] = dc / d; dirZ[i] = dr / d; }
    wetness[i] = Math.log(accumulation[i] * cellMetres / Math.max(g, .005));
    pond[i] = Math.max(0, filled[i] - h - .01);
  }
  order.sort((a, b) => filled[b] - filled[a]);
  for (const i of order) {
    const to = receiver[i]; if (to < 0) continue;
    const distance = Math.hypot(Math.floor(i / size) - Math.floor(to / size), i % size - to % size) * cellMetres;
    const speed = Math.max(.1, 4.9 * Math.sqrt(Math.max(0, filled[i] - filled[to]) / distance));
    if (arrival[i] + distance / speed > arrival[to]) arrival[to] = arrival[i] + distance / speed;
  }
  return { dirX, dirZ, slope, wetness, pond, arrival };
}

// Ground types and how readily each sheds rain: USDA TR-55 curve numbers for hydrologic soil group C (clay loams,
// assumed for Burgundy's clay-limestone soils), average wetness before the storm.
export const LAND_COVER = [
  { key: 'open', label: 'Meadow and fields', curveNumber: 74 },     // pasture, good condition
  { key: 'vines', label: 'Vineyards', curveNumber: 85 },             // row crops, straight rows, good condition
  { key: 'forest', label: 'Woods', curveNumber: 70 },                // woods, good condition
  { key: 'built', label: 'Roofs', curveNumber: 98 },                 // impervious
  { key: 'road', label: 'Roads', curveNumber: 95 },                  // paved 98 and gravel 89, mixed as drawn
  { key: 'water', label: 'Water', curveNumber: 100 },                // rain on open water all flows on
];
export const landRunoffMm = rainMm => LAND_COVER.map(c => stormRunoffMm(rainMm, c.curveNumber));

// Adds up, for every cell, how much of each ground type drains through it (in cells' worth of area, including its own).
// fractions holds K values per cell (the share of each ground type), receivers and filled come from rainRunoff.
export function classAccumulation(receiver, filled, valid, size, fractions, K) {
  const n = size * size, out = new Float32Array(n * K), order = [];
  for (let i = 0; i < n; i++) if (!valid || valid[i]) { order.push(i); for (let k = 0; k < K; k++) out[i * K + k] = fractions[i * K + k]; }
  order.sort((a, b) => filled[b] - filled[a]);
  for (const i of order) { const to = receiver[i]; if (to < 0) continue; for (let k = 0; k < K; k++) out[to * K + k] += out[i * K + k]; }
  return out;
}
