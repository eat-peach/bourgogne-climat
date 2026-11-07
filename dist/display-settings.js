// Display settings: each viewer can change how bright, light and saturated the aerial photos look.
// Choices are kept in this browser only and shared by every atlas on the site.
import { DISPLAY_DEFAULTS, clampDisplay } from './atlas-renderer.js';

const STORAGE_KEY = 'atlas-display-v2';
// Sliders work in whole numbers; scale turns them into renderer values.
const CONTROLS = [
  { key: 'brightness', label: 'Brightness', hint: 'Light on the whole map', min: 50, max: 150, step: 5, scale: 100, text: v => `${v}%` },
  { key: 'lightness', label: 'Lightness', hint: 'Lifts or deepens shadows and mid-tones, keeping highlights', min: -50, max: 50, step: 5, scale: 100, text: v => v > 0 ? `+${v}` : `${v}` },
  { key: 'saturation', label: 'Saturation', hint: '100% is the photo’s own colour; 0% is black and white', min: 0, max: 300, step: 10, scale: 100, text: v => `${v}%` },
];

function load() {
  try { return clampDisplay(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || DISPLAY_DEFAULTS); } catch { return { ...DISPLAY_DEFAULTS }; }
}

function save(settings) {
  try {
    const isDefault = CONTROLS.every(({ key }) => settings[key] === DISPLAY_DEFAULTS[key]);
    if (isDefault) localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* private windows may refuse storage; the settings still apply until reload */ }
}

export function initDisplaySettings(renderer, button) {
  let settings = load();
  renderer.setDisplay(settings);
  if (!button) return;

  const modal = document.createElement('div');
  modal.className = 'source-modal display-modal';
  modal.hidden = true;
  modal.innerHTML = `<div class="modal-card display-card" role="dialog" aria-labelledby="display-title"><button class="modal-close" type="button" aria-label="Close display settings">×</button><h2 id="display-title">Display</h2><p>Adjust how the aerial photos look. Your choices are saved in this browser.</p><div class="display-controls">${CONTROLS.map(c => `<label class="display-control" for="display-${c.key}"><span class="display-label">${c.label}</span><output id="display-${c.key}-value" for="display-${c.key}"></output><input id="display-${c.key}" type="range" min="${c.min}" max="${c.max}" step="${c.step}" data-display="${c.key}" /><small>${c.hint}</small></label>`).join('')}</div><div class="display-actions"><button type="button" class="outline-btn" data-display-reset>Reset to default</button><button type="button" class="outline-btn display-done">Done</button></div></div>`;
  document.body.append(modal);

  const sync = () => {
    for (const c of CONTROLS) {
      const value = Math.round(settings[c.key] * c.scale), input = modal.querySelector(`[data-display="${c.key}"]`);
      input.value = String(value);
      modal.querySelector(`#display-${c.key}-value`).textContent = c.text(value);
    }
  };
  const close = () => { if (modal.hidden) return; modal.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); };
  const open = () => { document.querySelectorAll('.display-modal').forEach(other => { if (other !== modal) other.hidden = true; }); sync(); modal.hidden = false; button.setAttribute('aria-expanded', 'true'); modal.querySelector('input').focus(); };

  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', open);
  modal.addEventListener('input', event => {
    const c = CONTROLS.find(x => x.key === event.target.dataset?.display);
    if (!c) return;
    settings = clampDisplay({ ...settings, [c.key]: Number(event.target.value) / c.scale });
    modal.querySelector(`#display-${c.key}-value`).textContent = c.text(Number(event.target.value));
    renderer.setDisplay(settings);
    save(settings);
  });
  modal.querySelector('[data-display-reset]').addEventListener('click', () => { settings = { ...DISPLAY_DEFAULTS }; renderer.setDisplay(settings); save(settings); sync(); });
  modal.querySelector('.modal-close').addEventListener('click', close);
  modal.querySelector('.display-done').addEventListener('click', close);
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
}
