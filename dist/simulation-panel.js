// Microclimate bar (sun, rain and frost), docked above the map controls. Three modes share it:
//  Sun   – a date slider and a time-of-day timeline light the terrain; ▶ plays the day.
//  Rain  – a rainfall slider sets the storm; rain falls, and the part that runs off flows down the slopes; ▶ plays the storm.
//  Frost – a clear, still night from sunset to dawn: cold air drains off the slopes and pools on the flats and in
//          hollows; the dawn temperature on the valley floor is picked from three presets; ▶ plays the night.
import { FROST_PRESETS, franceLocalToUtc, franceUtcOffset, solarPosition, stormRunoffMm, sunTimes } from './simulation.js';
import { REGION } from './region.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const pad = v => String(v).padStart(2, '0');
const clock = minutes => `${pad(Math.floor(minutes / 60) % 24)}:${pad(Math.floor(minutes % 60))}`;
const DAY_SECONDS = 15; // a played day runs across the timeline in this many seconds
const STORM_SECONDS = 12; // a played storm builds up to its total in this many seconds (at 1×)
const EDGE_MINUTES = 30; // the timeline starts this long before sunrise and ends this long after sunset
const RAIN_PRESETS = [['Shower', 10], ['Heavy rain', 25], ['Storm', 50], ['Severe storm', 80], ['Extreme', 120]];
const RAIN_MAX = 150;
const DURATIONS = [1, 6, 24]; // storm lengths in hours: a cloudburst, a wet afternoon, a rainy day
const SPEEDS = [.25, .5, 1, 2, 4]; // playback speed choices, cycled by the speed button
const NIGHT_SECONDS = 12; // a played night runs from sunset to dawn in this many seconds (at 1×)
const NIGHT_STEPS = 1000; // resolution of the night timeline
const FROST_DAY = 110; // frost nights are played on 20 April, around budburst, when spring frost does its damage
const MODES = ['sun', 'rain', 'frost'];
const fmtC = v => `${v < -.05 ? '−' : v > .05 ? '+' : ''}${Math.abs(v).toFixed(1)} °C`;
const pct = v => `${Math.round(v * 100)}%`;

const dayOfYear = (year, month, date) => Math.floor((Date.UTC(year, month - 1, date) - Date.UTC(year, 0, 0)) / 86400000);
const shortDate = (year, day) => new Date(Date.UTC(year, 0, day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtMm = v => v >= 10 ? v.toFixed(0) : v.toFixed(1);
const rainName = mm => mm <= 0 ? 'No rain' : RAIN_PRESETS.reduce((best, p) => Math.abs(p[1] - mm) < Math.abs(best[1] - mm) ? p : best)[0];

function franceNow() {
  const now = new Date(), local = new Date(now.getTime() + franceUtcOffset(now) * 3600000);
  return { year: local.getUTCFullYear(), day: dayOfYear(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate()), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

const ICON = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  rain: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.4 1.5A3.5 3.5 0 0 1 17 15"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/></svg>',
  frost: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7"/><path d="M9.5 3.5 12 6l2.5-2.5M9.5 20.5 12 18l2.5 2.5M3.6 10.4l3.4-.9-.9-3.4M20.4 13.6l-3.4.9.9 3.4M6.1 17.9l.9-3.4-3.4-.9M17.9 6.1l-.9 3.4 3.4.9"/></svg>',
};

export function initSimulation(renderer, button) {
  if (!button) return;
  const [latitude, longitude] = REGION.latLon;
  const state = { open: false, mode: 'sun', rainMm: 50, durationH: 1, speed: 1, frostMinC: -3, night: 1, ...franceNow() };
  const host = button.closest('.viewer-wrap') || document.body;

  const bar = document.createElement('div');
  bar.className = 'sim-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Microclimate: sun, rain and frost');
  bar.innerHTML = `<div class="sim-bar-main">
<div class="sim-modes" role="tablist" aria-label="Simulation"><button type="button" role="tab" data-mode="sun">${ICON.sun}<span>Sun</span></button><button type="button" role="tab" data-mode="rain">${ICON.rain}<span>Rain</span></button><button type="button" role="tab" data-mode="frost">${ICON.frost}<span>Frost</span></button></div>
<label class="sim-date-field" data-for="sun"><span class="sim-field-label sim-date-text"></span><input type="range" class="sim-day sim-range" min="1" max="365" step="1" aria-label="Date" /></label>
<div class="sim-transport"><button type="button" class="sim-play" aria-label="Play">▶</button><button type="button" class="sim-speed" title="Playback speed: click to change"></button></div>
<div class="sim-timeline" data-for="sun"><span class="sim-edge sim-rise" title="Sunrise"></span><input type="range" class="sim-time sim-range" aria-label="Time of day in France" step="1" /><span class="sim-edge sim-set" title="Sunset"></span></div>
<div class="sim-rainfall" data-for="rain"><input type="range" class="sim-rain-mm sim-range" min="0" max="${RAIN_MAX}" step="5" aria-label="Rainfall in one storm, millimetres" /><div class="sim-ticks">${RAIN_PRESETS.map(([name, mm]) => `<button type="button" data-mm="${mm}" style="left:${mm / RAIN_MAX * 100}%" title="${name}">${mm}</button>`).join('')}</div></div>
<div class="sim-duration" data-for="rain" role="group" aria-label="Storm length">${DURATIONS.map(h => `<button type="button" data-hours="${h}" title="All the rain falls in ${h === 1 ? 'one hour' : `${h} hours`}">${h} h</button>`).join('')}</div>
<div class="sim-timeline sim-night-line" data-for="frost"><span class="sim-edge sim-dusk" title="Sunset"></span><input type="range" class="sim-night sim-range" min="0" max="${NIGHT_STEPS}" step="1" aria-label="Time of night, from sunset to dawn" /><span class="sim-edge sim-dawn" title="Sunrise"></span></div>
<div class="sim-duration sim-frost-min" data-for="frost" role="group" aria-label="Dawn temperature on the valley floor">${FROST_PRESETS.map(([name, c]) => `<button type="button" data-min="${c}" title="${name} frost: ${String(c).replace('-', '−')} °C at dawn on the valley floor">${String(c).replace('-', '−')}°</button>`).join('')}</div>
<button type="button" class="sim-frost-info" data-for="frost" aria-label="About the frost model" title="A clear, still spring night (radiation frost). Cold air slides off the slopes and pools on the flats and in hollows, so the low ground freezes first while the mid-slope stays warmer. Terrain only, with no weather data: windy or cloudy nights, or a cold air mass moving in, freeze slopes and flats alike. White line: 0 °C. Blue line: −2 °C, where opened buds are killed.">?</button>
<output class="sim-readout" aria-live="off"><b class="sim-big"></b><span class="sim-small"></span></output>
<button type="button" class="sim-close" aria-label="Close microclimate">×</button></div>`;
  host.append(bar);
  const $ = sel => bar.querySelector(sel);
  const time = $('.sim-time'), day = $('.sim-day'), rain = $('.sim-rain-mm'), nightInput = $('.sim-night');
  // The frost night (20 April): from its sunset to the next morning's sunrise, in minutes after midnight of the date.
  const nightSpan = () => { const a = sunTimes(state.year, FROST_DAY, latitude, longitude), b = sunTimes(state.year, FROST_DAY + 1, latitude, longitude); return { dusk: a ? a.set : 1260, dawn: (b ? b.rise : 360) + 1440 }; };
  const nightClock = () => { const { dusk, dawn } = nightSpan(); return dusk + state.night * (dawn - dusk); };
  // The frost figures, from the renderer once it has mapped the cold air for the scene in view.
  const frostReadout = () => {
    if (state.mode !== 'frost') return;
    const f = renderer.frostSummary, t = state.night < 1 ? clock(nightClock()) : 'Dawn';
    // The big line stays short (it is all a phone shows): the time and the valley-floor temperature.
    $('.sim-big').textContent = f ? `${t} · ${fmtC(f.night.floorC)}` : t;
    const reach = f?.lineM === Infinity ? 'frost over all low ground' : f?.lineM > 0 ? `frost to ${Math.round(f.lineM)} m up` : 'no frost yet';
    $('.sim-small').textContent = ''; // the details are in the readout's tooltip
    bar.querySelector('.sim-readout').title = f ? `Valley floor ${fmtC(f.night.floorC)}; ${reach}${f.vineCells ? `; vines below 0 °C: ${pct(f.vinesFrosted)}, below −2 °C: ${pct(f.vinesDamaged)}, coldest ${fmtC(f.coldestVineC)}` : ''}` : '';
    nightInput.setAttribute('aria-valuetext', `${t}, ${f ? `${fmtC(f.night.floorC)} on the valley floor` : ''}`);
  };
  let playing = null;

  const fill = (input, value, min, max) => input.style.setProperty('--progress', `${(value - min) / (max - min) * 100}%`);
  const range = () => { const t = sunTimes(state.year, state.day, latitude, longitude); return t ? { rise: t.rise, set: t.set, start: t.rise - EDGE_MINUTES, end: t.set + EDGE_MINUTES } : { rise: null, set: null, start: 240, end: 1320 }; };
  const apply = () => {
    if (state.open) place(); // the village index and the map controls can change size while the bar is open
    const sunMode = state.open && state.mode === 'sun', rainMode = state.open && state.mode === 'rain', frostMode = state.open && state.mode === 'frost';
    bar.dataset.mode = state.mode;
    bar.querySelectorAll('[data-mode]').forEach(b => { const on = b.dataset.mode === state.mode; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    // Sun
    const { rise, set, start, end } = range();
    state.minutes = Math.min(end, Math.max(start, state.minutes));
    const utc = franceLocalToUtc(state.year, state.day, state.minutes), sun = solarPosition(utc, latitude, longitude);
    renderer.setSun(sunMode ? sun : null);
    time.min = String(start); time.max = String(end); time.value = String(state.minutes); fill(time, state.minutes, start, end);
    day.value = String(state.day); fill(day, state.day, 1, 365);
    $('.sim-date-text').textContent = shortDate(state.year, state.day);
    $('.sim-rise').textContent = rise == null ? '' : clock(rise);
    $('.sim-set').textContent = set == null ? '' : clock(set);
    time.setAttribute('aria-valuetext', `${clock(state.minutes)}, ${sun.elevation > 0 ? `sun ${sun.elevation.toFixed(0)} degrees up` : 'sun below the horizon'}`);
    // Rain
    // While a storm plays, the slider stays on the chosen total and the readout counts up the rain fallen so far.
    // Runoff is the average over the ground in view: woods soak up more, roofs and roads shed nearly everything.
    const progress = playing?.kind === 'storm' ? playing.p : 1, shown = state.rainMm * progress;
    const target = { rainMm: rainMode ? state.rainMm : 0, durationH: state.durationH, falling: rainMode, progress }, now = renderer.runoffState || {};
    if ((now.rainMm || 0) !== target.rainMm || (now.durationH || 1) !== target.durationH || Boolean(now.falling) !== target.falling || (now.progress ?? 1) !== target.progress) renderer.setRunoff(target);
    const off = renderer.averageRunoffMm ? renderer.averageRunoffMm(shown) : stormRunoffMm(shown); // after setRunoff, which may have just mapped the ground
    bar.querySelectorAll('[data-hours]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.hours) === state.durationH)));
    rain.value = String(state.rainMm); fill(rain, state.rainMm, 0, RAIN_MAX);
    rain.setAttribute('aria-valuetext', `${Math.round(shown)} millimetres, ${off > 0 ? `${fmtMm(off)} run off` : 'all soaks in'}`);
    bar.querySelectorAll('[data-mm]').forEach(b => b.classList.toggle('is-active', Number(b.dataset.mm) === state.rainMm));
    // Frost
    const frostNow = renderer.frostState, frostWanted = frostMode ? { minC: state.frostMinC, progress: state.night } : null;
    if (frostWanted ? !frostNow || frostNow.minC !== frostWanted.minC || frostNow.progress !== frostWanted.progress : frostNow) renderer.setFrost?.(frostWanted);
    nightInput.value = String(Math.round(state.night * NIGHT_STEPS)); fill(nightInput, state.night, 0, 1);
    { const { dusk, dawn } = nightSpan(); $('.sim-dusk').textContent = clock(dusk); $('.sim-dawn').textContent = clock(dawn); }
    bar.querySelectorAll('[data-min]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.min) === state.frostMinC)));
    const speed = $('.sim-speed'); speed.textContent = `${state.speed < 1 ? state.speed.toString().replace(/^0/, '') : state.speed}×`; speed.setAttribute('aria-label', `Playback speed ${state.speed} times`);
    // Readout
    if (state.mode === 'sun') {
      $('.sim-big').textContent = `${clock(state.minutes)} ${franceUtcOffset(utc) === 2 ? 'CEST' : 'CET'}`;
      $('.sim-small').textContent = sun.elevation > 0 ? `Sun ${sun.elevation.toFixed(0)}° ${COMPASS[Math.round(sun.azimuth / 45) % 8]}` : 'Sun down';
    } else if (state.mode === 'frost') frostReadout();
    else {
      $('.sim-big').textContent = `${Math.round(shown)} mm in ${state.durationH} h`;
      $('.sim-small').textContent = off > .05 ? `${rainName(state.rainMm)} · ${fmtMm(off)} mm runs off` : `${rainName(state.rainMm)} · all soaks in`;
    }
  };

  const showPlay = on => { const b = $('.sim-play'); b.textContent = on ? '❚❚' : '▶'; b.setAttribute('aria-label', on ? 'Pause' : state.mode === 'sun' ? 'Play the day' : state.mode === 'frost' ? 'Play the night' : 'Play the storm'); };
  // A paused day remembers where it stopped, so ▶ carries on from there; otherwise a day always plays from just before sunrise.
  let dayPausedAt = null;
  const pause = () => { if (playing) cancelAnimationFrame(playing.frame); const was = playing; playing = null; showPlay(false); if (was?.kind === 'day') dayPausedAt = state.minutes; if (was?.kind === 'storm') apply(); };
  const run = (kind, advance) => {
    playing = { kind, last: performance.now(), frame: 0, p: 0 };
    showPlay(true);
    const step = now => {
      if (!playing) return;
      const dt = Math.min(.1, (now - playing.last) / 1000) * state.speed; playing.last = now;
      const done = advance(dt);
      apply();
      if (done) { pause(); return; }
      playing.frame = requestAnimationFrame(step);
    };
    apply(); playing.frame = requestAnimationFrame(step);
  };
  const playDay = () => {
    const { start, end } = range();
    if (dayPausedAt === null || dayPausedAt !== state.minutes || state.minutes >= end) state.minutes = start;
    dayPausedAt = null;
    run('day', dt => { state.minutes = Math.min(end, state.minutes + (end - start) / DAY_SECONDS * dt); return state.minutes >= end; });
  };
  // A played night: from sunset the low ground cools first, frost forms on the flats and in the hollows, and the
  // frozen layer creeps up the slopes towards dawn. A night that has reached dawn starts again from sunset.
  const playNight = () => {
    if (state.night >= 1) state.night = 0;
    run('night', dt => { state.night = Math.min(1, state.night + dt / NIGHT_SECONDS); return state.night >= 1; });
  };
  // A played storm: the ground darkens as the first rain soaks in, then water starts to slide off the slopes, gathers
  // into streams that run down from the hilltops, and finally fills the hollows.
  const playStorm = () => {
    if (!state.rainMm) state.rainMm = 50;
    run('storm', dt => { playing.p = Math.min(1, (playing.p || 0) + dt / STORM_SECONDS); return playing.p >= 1; });
  };

  // The launcher button and the bar sit just above the map controls; the bar also stops short of the move pad.
  const placeBottom = () => host.style.setProperty('--sim-bottom', `${(host.querySelector('.viewer-bottom')?.offsetHeight || 0) + 12}px`);
  // The visible map: the info panel and the village index can cover its sides. The launcher is centred in it and the
  // bar spans it, stopping short of the move pad.
  function visibleSpan() {
    const hostBox = host.getBoundingClientRect(), panel = document.querySelector('.detail-panel'), side = document.querySelector('#village-sidebar')?.getBoundingClientRect();
    let left = hostBox.left, right = hostBox.right;
    if (panel && (panel.classList.contains('drawer-open') || panel.classList.contains('mobile-open'))) { const p = panel.getBoundingClientRect(); if (p.width > 0 && p.left < right && p.left > left + hostBox.width / 3) right = p.left; }
    if (side && side.width > 0 && side.right > left + 1 && side.right < left + hostBox.width / 2) left = side.right;
    for (const rail of document.querySelectorAll('.drawer-edge-left, .drawer-edge-left > *')) { const r = rail.getBoundingClientRect(); if (r.width > 0 && r.right > left && r.right < left + hostBox.width / 4 && getComputedStyle(rail).display !== 'none') left = r.right; }/* the narrow left rail */
    return { hostBox, left, right };
  }
  function placeLauncher() { const { hostBox, left, right } = visibleSpan(); host.style.setProperty('--sim-center', `${Math.round((left + right) / 2 - hostBox.left)}px`); }
  function place() {
    const padBox = host.querySelector('.pan-pad');
    placeBottom(); bar.style.bottom = 'var(--sim-bottom)';
    const padVisible = padBox && padBox.offsetParent && getComputedStyle(padBox).display !== 'none';
    const { hostBox, left, right } = visibleSpan();
    const stop = padVisible ? Math.min(right - 12, padBox.getBoundingClientRect().left - 12) : right - 16;
    bar.style.setProperty('--pad-room', `${Math.max(16, hostBox.right - stop)}px`);
    bar.style.setProperty('--side-room', `${Math.max(16, left - hostBox.left + 12)}px`);
    placeLauncher();
  }
  const setMode = mode => { if (mode === state.mode) return; pause(); state.mode = mode; showPlay(false); apply(); };
  const open = () => { state.open = true; bar.hidden = false; button.setAttribute('aria-expanded', 'true'); showPlay(false); apply(); $(`[data-mode="${state.mode}"]`).focus(); };
  const close = () => { pause(); state.open = false; bar.hidden = true; button.setAttribute('aria-expanded', 'false'); apply(); button.focus(); };

  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => state.open ? close() : open());
  addEventListener('resize', () => { placeBottom(); placeLauncher(); if (state.open) place(); });
  placeBottom(); placeLauncher();
  // the info panel opening or closing changes the visible map
  const watched = document.querySelector('.detail-panel');
  if (watched && typeof MutationObserver === 'function') new MutationObserver(() => { const again = () => { placeLauncher(); if (state.open) place(); }; requestAnimationFrame(again); setTimeout(again, 260); }).observe(watched, { attributes: true, attributeFilter: ['class', 'style'] });
  watched?.addEventListener('transitionend', () => { placeLauncher(); if (state.open) place(); });/* the panel slides in: measure again once it has arrived */
  if (watched && typeof ResizeObserver === 'function') new ResizeObserver(() => { placeLauncher(); if (state.open) place(); }).observe(watched);
  const controls = host.querySelector('.viewer-bottom');
  if (controls && typeof ResizeObserver === 'function') new ResizeObserver(() => { placeBottom(); }).observe(controls);
  bar.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('.sim-modes').addEventListener('keydown', event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { const k = MODES.indexOf(state.mode) + (event.key === 'ArrowRight' ? 1 : -1); setMode(MODES[(k + MODES.length) % MODES.length]); $(`[data-mode="${state.mode}"]`).focus(); } });
  // While a slider is dragged, the map is updated at most once per frame: the browser can send many input events per
  // frame, and redrawing for each one made the drag lag behind the pointer.
  let queued = 0;
  const applySoon = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; apply(); }); };
  time.addEventListener('input', () => { pause(); state.minutes = Number(time.value); applySoon(); });
  day.addEventListener('input', () => { pause(); state.day = Number(day.value); applySoon(); });
  rain.addEventListener('input', () => { pause(); state.rainMm = Number(rain.value); applySoon(); });
  $('.sim-ticks').addEventListener('click', event => { const mm = event.target.closest('[data-mm]')?.dataset.mm; if (mm) { pause(); state.rainMm = Number(mm); apply(); } });
  nightInput.addEventListener('input', () => { pause(); state.night = Number(nightInput.value) / NIGHT_STEPS; applySoon(); });
  $('.sim-frost-min').addEventListener('click', event => { const c = event.target.closest('[data-min]')?.dataset.min; if (c) { pause(); state.frostMinC = Number(c); if (state.night < .05) state.night = 1; apply(); } });
  renderer.onFrostChange = frostReadout;
  // The ? beside the frost presets opens a short note above the bar on what the model does and does not show.
  const note = document.createElement('p'); note.className = 'sim-note'; note.hidden = true; note.id = 'sim-frost-note';
  note.innerHTML = '<b>Frost on a clear, still night in mid-April</b>, around budburst. Cold air slides off the slopes and pools on the flats and in hollows, so the low ground freezes first and the mid-slope stays warmer. <span class="sim-key sim-key-0"></span> 0 °C <span class="sim-key sim-key-2"></span> −2 °C, where opened buds die. Terrain only: windy or cloudy nights, or a cold air mass moving in, freeze slopes and flats alike.';
  bar.prepend(note);
  const info = $('.sim-frost-info'); info.removeAttribute('title'); info.setAttribute('aria-controls', note.id); info.setAttribute('aria-expanded', 'false');
  info.addEventListener('click', () => { note.hidden = !note.hidden; info.setAttribute('aria-expanded', String(!note.hidden)); });
  bar.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { if (b.dataset.mode !== 'frost') { note.hidden = true; info.setAttribute('aria-expanded', 'false'); } }));
  $('.sim-play').addEventListener('click', () => playing ? pause() : state.mode === 'sun' ? playDay() : state.mode === 'frost' ? playNight() : playStorm());
  $('.sim-speed').addEventListener('click', () => { state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length]; if (playing) playing.last = performance.now(); apply(); });
  $('.sim-duration').addEventListener('click', event => { const h = event.target.closest('[data-hours]')?.dataset.hours; if (h) { pause(); state.durationH = Number(h); apply(); } });
  renderer.onRunoffChange = () => { if (state.open && state.mode === 'rain') apply(); };
  $('.sim-close').addEventListener('click', close);
  bar.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
}
