// Private review page for visitor submissions. All submitted text is rendered with
// textContent, and photos are fetched with the admin token and shown as blob URLs.
const $ = s => document.querySelector(s);
const STATUSES = ['new', 'reviewing', 'accepted', 'rejected', 'spam'];
const PAGE = 30;
let token = '', offset = 0, objectUrls = [];

function readToken() { try { return sessionStorage.getItem('atlas-admin-token') || ''; } catch { return ''; } }
function saveToken(value) { try { value ? sessionStorage.setItem('atlas-admin-token', value) : sessionStorage.removeItem('atlas-admin-token'); } catch {} }

async function api(path, options = {}) {
  const res = await fetch(`./api/admin/${path}`, { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${token}` } });
  if (res.status === 401) { signOut('Your session has ended. Please sign in again.'); throw new Error('unauthorised'); }
  return res;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function block(label, text) {
  if (!text) return null;
  const node = el('div', 'block');
  node.append(el('b', '', label), document.createTextNode(text));
  return node;
}

function describeTarget(t) {
  if (!t) return '';
  return [t.classification, t.featureName, t.parcelRef && `parcel ${t.parcelRef}`, t.villageName && `in ${t.villageName}`].filter(Boolean).join(' · ');
}

async function loadPhotos(container, item) {
  for (let n = 1; n <= item.photoCount; n++) {
    const res = await api(`submissions/${item.id}/photos/${n}`);
    if (!res.ok) continue;
    const url = URL.createObjectURL(await res.blob());
    objectUrls.push(url);
    const link = el('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener';
    const img = el('img'); img.src = url; img.alt = `Photo ${n}`;
    link.append(img); container.append(link);
  }
}

function render(item) {
  const card = el('article', 'item');
  const head = el('div', 'item-head');
  const left = el('div');
  left.append(el('div', 'kind', item.kind === 'correction' ? `Correction · ${item.category}` : `Feedback · ${item.category}`));
  left.append(el('div', 'title', item.kind === 'correction' ? describeTarget(item.target) || 'Unspecified place' : item.message.split('\n')[0].slice(0, 90)));
  const meta = el('div', 'meta', `${new Date(item.createdAt).toLocaleString()} · ${item.reference} · ${item.country || '—'} · sender ${item.sender}`);
  const status = el('span', `status-${item.status}`, ` · ${item.status}`);
  meta.append(status);
  head.append(left, meta);
  card.append(head);
  for (const node of [block(item.kind === 'correction' ? 'What is wrong' : 'Message', item.message), block('Proposed correction', item.proposed), block('Source or evidence', item.evidence),
    block('Contact', [item.name, item.email].filter(Boolean).join(' · ')), block('Target', item.target ? JSON.stringify(item.target, null, 2) : ''), block('Page', item.page)]) if (node) card.append(node);
  if (item.photoCount) { const photos = el('div', 'photos'); card.append(photos); loadPhotos(photos, item).catch(() => {}); }

  const controls = el('div', 'controls');
  const select = el('select'); select.setAttribute('aria-label', 'Status');
  STATUSES.forEach(s => select.append(new Option(s, s, false, s === item.status)));
  const note = el('textarea'); note.placeholder = 'Private note'; note.value = item.adminNote || ''; note.maxLength = 2000;
  const save = el('button', 'primary', 'Save');
  const remove = el('button', 'danger', 'Delete');
  save.addEventListener('click', async () => {
    save.disabled = true;
    const res = await api(`submissions/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: select.value, adminNote: note.value }) });
    save.disabled = false; save.textContent = res.ok ? 'Saved' : 'Failed';
    if (res.ok) status.textContent = ` · ${select.value}`;
    setTimeout(() => { save.textContent = 'Save'; }, 1500);
  });
  remove.addEventListener('click', async () => {
    if (!confirm('Permanently delete this submission and its photos?')) return;
    const res = await api(`submissions/${item.id}`, { method: 'DELETE' });
    if (res.ok) card.remove();
  });
  controls.append(select, note, save, remove);
  card.append(controls);
  return card;
}

async function load(reset = true) {
  if (reset) { offset = 0; $('#list').replaceChildren(); objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; }
  const params = new URLSearchParams({ status: $('#filter-status').value, kind: $('#filter-kind').value, limit: PAGE, offset });
  let data;
  try {
    const res = await api(`submissions?${params}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
  } catch (error) {
    if (error.message !== 'unauthorised') $('#list').replaceChildren(el('p', 'error', error.message || 'Could not load submissions.'));
    return;
  }
  const counts = STATUSES.map(s => `${s} ${data.counts?.[s] || 0}`).join(' · ');
  $('#counts').textContent = counts;
  if (reset && !data.submissions.length) $('#list').append(el('p', 'empty', 'Nothing here.'));
  data.submissions.forEach(item => $('#list').append(render(item)));
  offset += data.submissions.length;
  $('#more').hidden = data.submissions.length < PAGE;
}

function signOut(message) {
  token = ''; saveToken('');
  $('#app').hidden = true; $('#sign-out').hidden = true; $('#login').hidden = false;
  const error = $('#login-error');
  error.hidden = !message; error.textContent = message || '';
}

function signIn(value) {
  token = value; saveToken(value);
  $('#login').hidden = true; $('#app').hidden = false; $('#sign-out').hidden = false;
  load();
}

// The password is exchanged once for a 12-hour session token; only the token is kept, in this tab.
async function logIn(password) {
  const res = await fetch('./api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) return signOut(data.error || 'Sign-in failed.');
  signIn(data.token);
}

$('#login').addEventListener('submit', event => { event.preventDefault(); const password = $('#token').value; $('#token').value = ''; logIn(password); });
$('#sign-out').addEventListener('click', () => signOut());
$('#refresh').addEventListener('click', () => load());
$('#more').addEventListener('click', () => load(false));
$('#filter-status').addEventListener('change', () => load());
$('#filter-kind').addEventListener('change', () => load());
const saved = readToken();
saved ? signIn(saved) : signOut();
