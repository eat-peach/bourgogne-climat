// Visitor feedback and data-correction forms. Submissions go to the Worker API
// (/api/submissions), protected by Cloudflare Turnstile and server-side checks.
import { element } from './feature-panel.js';

const MAX_PHOTOS = 3;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024; // refuse to decode anything larger in the browser
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_EDGE = 2000;
import { term } from './region.js';

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const FEEDBACK_TOPICS = [['bug', 'Something is broken'], ['data', 'Data looks wrong'], ['design', 'Design or usability'], ['idea', 'Idea or request'], ['other', 'Something else']];
const CORRECTION_FIELDS = [['classification', term('classificationField')], ['name', 'Name or spelling'], ['boundary', 'Boundary or location'], ['area', 'Area'], ['elevation', 'Elevation'], ['ownership', 'Ownership'], ['other', 'Something else']];

let configPromise = null, turnstilePromise = null, dialog = null, state = null;

function loadConfig() {
  configPromise ||= fetch('/api/config', { headers: { accept: 'application/json' } })
    .then(res => res.ok ? res.json() : null)
    .then(config => config?.enabled && config.turnstileSiteKey ? config : null)
    .catch(() => null);
  return configPromise;
}

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  turnstilePromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC; script.async = true; script.defer = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Verification unavailable'));
    script.onerror = () => { turnstilePromise = null; reject(new Error('Verification unavailable')); };
    document.head.append(script);
  });
  return turnstilePromise;
}

// Re-encodes a photo through a canvas: this normalises orientation, caps the size,
// and drops all embedded metadata (including GPS location) before upload.
async function preparePhoto(file) {
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new Error(`${file.name} is not an image.`);
  if (file.size > MAX_SOURCE_BYTES) throw new Error(`${file.name} is larger than 30 MB.`);
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error(`${file.name} could not be opened. Please use a JPEG or PNG photo.`); }
  try {
    for (const [edge, quality] of [[MAX_EDGE, 0.85], [1600, 0.78], [1200, 0.7]]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
    }
  } finally { bitmap.close?.(); }
  throw new Error(`${file.name} is too detailed to upload. Try a smaller photo.`);
}

function field(label, control, { hint, name, optional } = {}) {
  const wrap = element('label', 'fb-field');
  const head = element('span', 'fb-label', label);
  if (optional) head.append(element('em', '', ' optional'));
  wrap.append(head, control);
  if (hint) wrap.append(element('small', 'fb-hint', hint));
  wrap.append(Object.assign(element('small', 'fb-error'), { id: `fb-error-${name}` }));
  wrap.dataset.field = name;
  return wrap;
}

function select(name, options, placeholder) {
  const el = element('select');
  el.name = name; el.required = true;
  el.append(new Option(placeholder, ''), ...options.map(([value, label]) => new Option(label, value)));
  el.options[0].disabled = true; el.selectedIndex = 0;
  return el;
}

function textarea(name, { rows = 4, max, required, placeholder } = {}) {
  const el = element('textarea');
  Object.assign(el, { name, rows, required: Boolean(required), placeholder: placeholder || '' });
  if (max) el.maxLength = max;
  return el;
}

function input(name, type, { max, placeholder, autocomplete } = {}) {
  const el = element('input');
  Object.assign(el, { name, type, placeholder: placeholder || '' });
  if (max) el.maxLength = max;
  if (autocomplete) el.autocomplete = autocomplete;
  return el;
}

function targetSummary(target) {
  const box = element('div', 'fb-target');
  box.append(element('span', 'fb-target-kicker', target.layer === 'cadastre' ? 'Cadastral parcel' : target.classification || 'Selected place'));
  box.append(element('strong', '', target.featureName || target.parcelRef || 'Selected feature'));
  const where = [target.parcelRef && target.featureName ? `Parcel ${target.parcelRef}` : '', target.villageName].filter(Boolean).join(' · ');
  if (where) box.append(element('span', 'fb-target-where', where));
  return box;
}

function ensureDialog() {
  if (dialog) return dialog;
  dialog = element('dialog', 'fb-dialog');
  dialog.setAttribute('aria-labelledby', 'fb-title');
  dialog.addEventListener('close', () => { state?.widgetId != null && window.turnstile?.remove(state.widgetId); state = null; });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  return dialog;
}

function renderPhotos(list) {
  list.replaceChildren();
  state.photos.forEach((photo, i) => {
    const item = element('div', 'fb-photo');
    const img = element('img');
    img.src = photo.url; img.alt = `Attached photo ${i + 1}`;
    const remove = element('button', 'fb-photo-remove', '×');
    remove.type = 'button'; remove.setAttribute('aria-label', `Remove photo ${i + 1}`);
    remove.addEventListener('click', () => { URL.revokeObjectURL(photo.url); state.photos.splice(i, 1); renderPhotos(list); });
    item.append(img, remove);
    list.append(item);
  });
  state.photoInput.disabled = state.photos.length >= MAX_PHOTOS;
  state.photoButton.classList.toggle('is-disabled', state.photos.length >= MAX_PHOTOS);
  state.photoButton.querySelector('span').textContent = state.photos.length ? `Add photo (${state.photos.length}/${MAX_PHOTOS})` : 'Add photos';
}

function showErrors(form, fields = {}) {
  form.querySelectorAll('.fb-field').forEach(wrap => {
    const message = fields[wrap.dataset.field] || '';
    wrap.classList.toggle('has-error', Boolean(message));
    const slot = wrap.querySelector('.fb-error');
    if (slot) slot.textContent = message;
  });
  const first = form.querySelector('.has-error textarea, .has-error input, .has-error select');
  first?.focus();
}

function showDone(card, reference, kind) {
  card.replaceChildren();
  const done = element('div', 'fb-done');
  done.append(element('div', 'fb-done-mark', '✓'), element('h2', '', kind === 'correction' ? 'Correction received' : 'Thank you'));
  done.append(element('p', '', kind === 'correction'
    ? 'Your correction will be checked against official sources before the atlas is updated.'
    : 'Your feedback has been sent to the author of the atlas.'));
  if (reference) done.append(element('p', 'fb-reference', `Reference ${reference}`));
  const close = element('button', 'fb-primary', 'Close');
  close.type = 'button'; close.addEventListener('click', () => dialog.close());
  done.append(close);
  card.append(done);
  close.focus();
}

async function submit(form, card, kind, target) {
  const status = form.querySelector('.fb-status'), button = form.querySelector('.fb-primary');
  status.textContent = ''; status.dataset.state = '';
  if (!form.reportValidity()) return;
  if (!state.token) { status.textContent = 'Please complete the verification check.'; status.dataset.state = 'error'; return; }
  const data = new FormData(form);
  data.set('kind', kind);
  data.set('consent', form.consent.checked ? 'yes' : '');
  data.set('page', `${location.pathname}${location.hash}`.slice(0, 500));
  data.set('cf-turnstile-response', state.token);
  if (target) data.set('target', JSON.stringify(target));
  data.delete('photo-picker');
  state.photos.forEach((photo, i) => data.append('photos', photo.blob, `photo-${i + 1}.jpg`));
  button.disabled = true; button.textContent = 'Sending…'; form.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch('/api/submissions', { method: 'POST', body: data, headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) { showDone(card, body.reference, kind); return; }
    showErrors(form, body.fields);
    status.textContent = body.error || 'Your submission could not be sent. Please try again.';
    status.dataset.state = 'error';
    if (body.retryVerification || res.status === 403) { state.token = ''; window.turnstile?.reset(state.widgetId); }
  } catch {
    status.textContent = 'Network problem. Check your connection and try again.';
    status.dataset.state = 'error';
  } finally {
    if (form.isConnected) { button.disabled = false; button.textContent = kind === 'correction' ? 'Send correction' : 'Send feedback'; form.removeAttribute('aria-busy'); }
  }
}

function buildForm(card, kind, target, config) {
  const form = element('form', 'fb-form');
  form.noValidate = false;
  if (kind === 'correction') {
    form.append(targetSummary(target));
    form.append(field('What needs correcting?', select('field', CORRECTION_FIELDS, 'Choose one'), { name: 'field' }));
    form.append(field('What is wrong?', textarea('message', { rows: 4, max: config.limits?.maxMessage || 3000, required: true, placeholder: 'Describe what the atlas shows and why it is incorrect.' }), { name: 'message' }));
    form.append(field('What should it be?', textarea('proposed', { rows: 2, max: 1000 }), { name: 'proposed', optional: true }));
    form.append(field('Source or evidence', textarea('evidence', { rows: 2, max: 1000, placeholder: 'e.g. INAO cahier des charges, a cadastral extract, a link' }), { name: 'evidence', optional: true, hint: 'Corrections backed by an official source can be applied fastest.' }));
  } else {
    form.append(field('Topic', select('category', FEEDBACK_TOPICS, 'Choose a topic'), { name: 'category' }));
    form.append(field('Your message', textarea('message', { rows: 5, max: config.limits?.maxMessage || 3000, required: true }), { name: 'message' }));
  }

  const photoWrap = element('div', 'fb-field fb-photos-field');
  photoWrap.dataset.field = 'photos';
  const photoHead = element('span', 'fb-label', 'Photos');
  photoHead.append(element('em', '', ' optional · up to 3'));
  const photoInput = input('photo-picker', 'file');
  photoInput.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
  photoInput.multiple = true; photoInput.className = 'fb-file';
  photoInput.id = `fb-photo-input-${kind}`;
  const photoButton = element('label', 'fb-photo-add');
  photoButton.htmlFor = photoInput.id;
  photoButton.append(element('b', '', '+'), element('span', '', 'Add photos'));
  const photoList = element('div', 'fb-photo-list');
  photoWrap.append(photoHead, photoInput, photoButton, photoList, element('small', 'fb-hint', 'Photos are resized and their location data removed before upload.'), Object.assign(element('small', 'fb-error'), {}));
  form.append(photoWrap);
  state.photoInput = photoInput; state.photoButton = photoButton;
  if (config.photosEnabled === false) {
    // Photo storage has reached its cap; text submissions still work.
    photoInput.disabled = true; photoButton.hidden = true;
    photoWrap.querySelector('.fb-hint').textContent = 'Photo uploads are paused because photo storage is full. You can still send your message.';
  }
  photoInput.addEventListener('change', async () => {
    const files = [...photoInput.files].slice(0, MAX_PHOTOS - state.photos.length);
    photoInput.value = '';
    const error = photoWrap.querySelector('.fb-error');
    error.textContent = ''; photoWrap.classList.remove('has-error');
    photoButton.classList.add('is-busy');
    for (const file of files) {
      try { const blob = await preparePhoto(file); state?.photos.push({ blob, url: URL.createObjectURL(blob) }); }
      catch (err) { error.textContent = err.message; photoWrap.classList.add('has-error'); }
    }
    photoButton.classList.remove('is-busy');
    if (state) renderPhotos(photoList);
  });

  const contact = element('div', 'fb-row');
  contact.append(field('Name', input('name', 'text', { max: 100, autocomplete: 'name' }), { name: 'name', optional: true }));
  contact.append(field('Email', input('email', 'email', { max: 254, autocomplete: 'email' }), { name: 'email', optional: true, hint: 'Only if you would like a reply.' }));
  form.append(contact);

  // Honeypot: hidden from people and assistive technology; bots that fill it are discarded.
  const trap = element('div', 'fb-trap');
  trap.setAttribute('aria-hidden', 'true');
  const trapInput = input('website', 'text');
  trapInput.tabIndex = -1; trapInput.autocomplete = 'off';
  trap.append(trapInput);
  form.append(trap);

  const consent = element('label', 'fb-field fb-consent');
  consent.dataset.field = 'consent';
  const box = input('consent', 'checkbox');
  box.required = true; box.value = 'yes';
  consent.append(box, element('span', '', 'I agree that this submission, including any photos I own or may share, is stored privately and used to improve the atlas.'), element('small', 'fb-error'));
  form.append(consent);
  const privacy = element('p', 'fb-privacy', 'Your IP address is kept only as an anonymous hash to prevent abuse. Nothing you send is published automatically. ');
  // Opens in a new tab so an unfinished form is not lost.
  privacy.append(Object.assign(element('a', '', 'Privacy notice'), { href: './legal.html#privacy', target: '_blank', rel: 'noopener' }));
  form.append(privacy);

  const widget = element('div', 'fb-turnstile');
  const status = element('p', 'fb-status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = element('div', 'fb-actions');
  const cancel = element('button', 'fb-secondary', 'Cancel');
  cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
  const send = element('button', 'fb-primary', kind === 'correction' ? 'Send correction' : 'Send feedback');
  send.type = 'submit';
  actions.append(cancel, send);
  form.append(widget, status, actions);
  form.addEventListener('submit', event => { event.preventDefault(); submit(form, card, kind, target); });

  loadTurnstile().then(turnstile => {
    if (!state || !widget.isConnected) return;
    state.widgetId = turnstile.render(widget, {
      sitekey: config.turnstileSiteKey, action: kind, theme: 'light', size: 'flexible',
      callback: token => { if (state) state.token = token; status.textContent = ''; },
      'expired-callback': () => { if (state) state.token = ''; },
      'error-callback': () => { if (state) state.token = ''; status.textContent = 'The verification check could not load. Please try again.'; status.dataset.state = 'error'; },
    });
  }).catch(() => { status.textContent = 'The verification check could not load. Check your connection or disable content blockers for this page.'; status.dataset.state = 'error'; send.disabled = true; });
  return form;
}

export async function openSubmissionDialog(kind, target = null) {
  const modal = ensureDialog();
  if (modal.open) modal.close();
  state = { token: '', widgetId: null, photos: [] };
  modal.replaceChildren();
  const card = element('div', 'fb-card');
  const close = element('button', 'fb-close', '×');
  close.type = 'button'; close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => modal.close());
  const header = element('header', 'fb-header');
  header.append(element('span', 'fb-eyebrow', kind === 'correction' ? 'Help verify the atlas' : 'Feedback'));
  header.append(Object.assign(element('h2', '', kind === 'correction' ? 'Suggest a correction' : 'Send feedback'), { id: 'fb-title' }));
  header.append(element('p', 'fb-intro', kind === 'correction'
    ? 'Much of this atlas is assembled from public sources and not yet verified. If something here is wrong, tell us what it should be.'
    : 'Report a problem, share an idea, or tell us what would make the atlas more useful.'));
  const body = element('div', 'fb-body');
  body.append(element('p', 'fb-loading', 'Loading…'));
  card.append(close, header, body);
  modal.append(card);
  modal.showModal();
  const config = await loadConfig();
  if (!state || !modal.open) return;
  body.replaceChildren();
  if (!config) {
    body.append(element('p', 'fb-unavailable', 'Submissions are not available on this copy of the atlas. Please try again later.'));
    return;
  }
  const form = buildForm(body, kind, target, config);
  body.append(form);
  form.querySelector('select, textarea')?.focus();
}

// The call-to-action placed at the end of a selected feature's panel.
export function correctionPrompt(target) {
  const wrap = element('section', 'fb-prompt');
  const button = element('button', 'fb-prompt-link');
  button.type = 'button';
  button.append(document.createTextNode('Spotted something wrong? '), element('span', '', 'Suggest a correction'));
  button.addEventListener('click', () => openSubmissionDialog('correction', target));
  wrap.append(button);
  return wrap;
}
