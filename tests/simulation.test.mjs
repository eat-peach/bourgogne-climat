import assert from 'node:assert/strict';
import { test } from 'node:test';
import { franceLocalToUtc, franceUtcOffset, rainRunoff, solarPosition, sunTimes } from '../dist/simulation.js';

const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

test('sun position matches known values for Beaune', () => {
  // Midsummer solar noon: elevation is 90° − latitude + 23.44° tilt, due south.
  const noon = solarPosition(new Date(Date.UTC(2026, 5, 21, 11, 41)), 47.02, 4.84);
  near(noon.elevation, 66.4, .5, 'June noon elevation');
  near(noon.azimuth, 180, 2, 'June noon azimuth');
  // Equinox sunrise is near due east, about 05:50 UTC (06:50 in France, still on winter time).
  const rise = solarPosition(new Date(Date.UTC(2026, 2, 20, 5, 50)), 47.02, 4.84);
  near(rise.elevation, 0, 1.5, 'equinox sunrise elevation');
  near(rise.azimuth, 90, 3, 'equinox sunrise azimuth');
  assert.ok(solarPosition(new Date(Date.UTC(2026, 11, 21, 0, 0)), 47.02, 4.84).elevation < -60);
});

test('French clock time follows summer time', () => {
  assert.equal(franceUtcOffset(new Date(Date.UTC(2026, 0, 15, 12))), 1);
  assert.equal(franceUtcOffset(new Date(Date.UTC(2026, 6, 15, 12))), 2);
  assert.equal(franceUtcOffset(new Date(Date.UTC(2026, 2, 29, 0, 59))), 1); // last Sunday of March 2026 is the 29th
  assert.equal(franceUtcOffset(new Date(Date.UTC(2026, 2, 29, 1, 0))), 2);
  assert.equal(franceLocalToUtc(2026, 172, 14 * 60).toISOString(), '2026-06-21T12:00:00.000Z');
  assert.equal(franceLocalToUtc(2026, 15, 14 * 60).toISOString(), '2026-01-15T13:00:00.000Z');
});

test('rain runs downhill, fills pits and gathers in the valley', () => {
  // A V-shaped valley draining south, with a pit in its floor.
  const size = 9, heights = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) heights.push(Math.abs(c - 4) * 10 + (size - r) * 2);
  heights[4 * size + 4] -= 30;
  const { receiver, accumulation } = rainRunoff(heights, null, size, 25);
  const centre = r => r * size + 4;
  for (let r = 1; r < size - 1; r++) assert.equal(receiver[centre(r)], centre(r + 1), `valley floor row ${r} drains south`);
  assert.equal(receiver[centre(size - 1)], -1, 'the outlet is at the edge');
  assert.equal(receiver[2 * size + 1], 2 * size + 2, 'a slope cell drains towards the valley');
  const total = accumulation.reduce((a, b) => Math.max(a, b), 0);
  assert.ok(accumulation[centre(size - 1)] === total && total > size * 3, 'the outlet collects the most water');
});

test('cells marked as gaps are left out', () => {
  const size = 5, heights = Array.from({ length: 25 }, (_, i) => 100 - Math.floor(i / 5));
  const valid = heights.map((_, i) => i !== 12);
  const { receiver, accumulation } = rainRunoff(heights, valid, size, 10);
  assert.equal(receiver[12], -1);
  assert.equal(accumulation[12], 0);
  assert.ok(!receiver.includes(12));
});

test('sunrise and sunset in Beaune agree with the standard hour-angle formula', () => {
  // cos H = (sin −0.833° − sin φ sin δ) / (cos φ cos δ) at solar noon ± H, worked by hand for Beaune (47.02° N, 4.84° E):
  // 21 June 05:45 and 21:39 CEST; 21 December 08:24 and 16:54 CET.
  const june = sunTimes(2026, 172, 47.02, 4.84), december = sunTimes(2026, 355, 47.02, 4.84);
  near(june.rise, 5 * 60 + 45, 3, 'June sunrise'); near(june.set, 21 * 60 + 39, 3, 'June sunset');
  near(december.rise, 8 * 60 + 24, 3, 'December sunrise'); near(december.set, 16 * 60 + 54, 3, 'December sunset');
});

test('storm runoff follows the SCS curve number formula', async () => {
  const { stormRunoffMm, flowLength } = await import('../dist/simulation.js');
  // CN 80: S = 63.5 mm, Ia = 12.7 mm. 50 mm → (37.3)² / (37.3 + 63.5) = 13.80 mm.
  assert.equal(stormRunoffMm(10), 0);
  assert.equal(stormRunoffMm(12.7), 0);
  near(stormRunoffMm(50), 13.80, .01, '50 mm storm');
  near(stormRunoffMm(100), 87.3 ** 2 / 150.8, .01, '100 mm storm');
  assert.ok(stormRunoffMm(100) < 100 && stormRunoffMm(150) > stormRunoffMm(100));
  // A straight chain 0 → 1 → 2 on a 3×1 strip (as a 3×3 grid's top row).
  const receiver = Int32Array.from([1, 2, -1, -1, -1, -1, -1, -1, -1]), filled = [3, 2, 1, 0, 0, 0, 0, 0, 0];
  const length = flowLength(receiver, filled, null, 3, 10);
  assert.deepEqual([...length.slice(0, 3)], [0, 10, 20]);
});

test('wetness fields point downhill, find hollows and delay water downstream', async () => {
  const { rainRunoff, wetnessFields } = await import('../dist/simulation.js');
  // A slope falling to the south (row up) with a one-cell hollow in the middle.
  const size = 7, heights = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) heights.push(100 - r * 5);
  heights[3 * size + 3] -= 12;
  const routed = rainRunoff(heights, null, size, 10), f = wetnessFields(heights, null, size, 10, routed);
  const i = 1 * size + 1;
  assert.ok(f.dirZ[i] > .99 && Math.abs(f.dirX[i]) < .01, 'downhill is south');
  near(f.slope[i], .5, 1e-9, 'slope is 5 m per 10 m');
  assert.ok(f.pond[3 * size + 3] > 1, 'the hollow holds water');
  assert.equal(f.pond[i], 0);
  assert.ok(f.arrival[5 * size + 1] > f.arrival[2 * size + 1] && f.arrival[0 * size + 1] === 0, 'water arrives later further down');
  assert.ok(f.wetness[5 * size + 1] > f.wetness[1 * size + 1], 'lower ground is wetter');
});

test('ground types shed different amounts and add up downstream', async () => {
  const { LAND_COVER, landRunoffMm, classAccumulation } = await import('../dist/simulation.js');
  const q = landRunoffMm(50), byKey = Object.fromEntries(LAND_COVER.map((c, k) => [c.key, q[k]]));
  assert.ok(byKey.forest < byKey.open && byKey.open < byKey.vines && byKey.vines < byKey.built && byKey.built <= byKey.water);
  near(byKey.water, 50, 1e-9, 'water passes everything on');
  // CN 70, 50 mm: S = 108.86, Ia = 21.77 → (28.23)² / (28.23 + 108.86) = 5.81 mm
  near(byKey.forest, 5.81, .01, 'woods');
  const receiver = Int32Array.from([1, 2, -1, -1]), filled = [3, 2, 1, 0], fractions = [1, 0, .5, .5, 0, 1, 0, 0];
  const acc = classAccumulation(receiver, filled, null, 2, fractions, 2);
  assert.deepEqual([...acc.slice(4, 6)], [1.5, 1.5]);
});
