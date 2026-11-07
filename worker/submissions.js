// Pure validation helpers for visitor feedback and correction requests.
// Kept free of Worker globals so they can be unit tested with `node --test`.

export const LIMITS = Object.freeze({
  maxPhotos: 3,
  maxPhotoBytes: 4 * 1024 * 1024,
  maxRequestBytes: 14 * 1024 * 1024,
  minMessage: 10,
  maxMessage: 3000,
  maxProposed: 1000,
  maxEvidence: 1000,
  maxName: 100,
  maxEmail: 254,
  maxLinks: 6,
  perIpHour: 5,
  perIpDay: 15,
  globalDay: 300,
  // Total photo storage in R2. Once reached, submissions are still accepted but without photos.
  photoStorageBytes: 5 * 1000 ** 3,
});

export const FEEDBACK_CATEGORIES = Object.freeze(['bug', 'data', 'design', 'idea', 'other']);
export const CORRECTION_FIELDS = Object.freeze(['name', 'classification', 'boundary', 'area', 'elevation', 'ownership', 'other']);
export const TARGET_LAYERS = Object.freeze(['climats', 'parcels', 'cadastre']);
export const STATUSES = Object.freeze(['new', 'reviewing', 'accepted', 'rejected', 'spam']);
const TARGET_KEYS = Object.freeze(['villageId', 'villageName', 'featureName', 'layer', 'classification', 'featureId', 'factsKey', 'parcelRef', 'communeCode']);

// Removes control characters (keeping newlines and tabs), normalises Unicode and trims.
export function cleanText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const singleLine = value => cleanText(value).replace(/\s+/g, ' ');
const linkCount = text => (text.match(/https?:\/\/|www\./gi) || []).length;
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

function parseTarget(raw, errors) {
  const text = String(raw ?? '');
  if (!text) { errors.target = 'Select a vineyard or lieu-dit on the map first.'; return null; }
  if (text.length > 2000) { errors.target = 'The selected place could not be read.'; return null; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { errors.target = 'The selected place could not be read.'; return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { errors.target = 'The selected place could not be read.'; return null; }
  const target = {};
  for (const key of TARGET_KEYS) {
    if (parsed[key] == null || parsed[key] === '') continue;
    const value = singleLine(parsed[key]);
    if (value.length > 200) { errors.target = 'The selected place could not be read.'; return null; }
    if (value) target[key] = value;
  }
  if (!TARGET_LAYERS.includes(target.layer)) { errors.target = 'Corrections can be sent for vineyards, lieux-dits and cadastral parcels.'; return null; }
  if (!target.featureName && !target.parcelRef && !target.featureId) { errors.target = 'Select a vineyard or lieu-dit on the map first.'; return null; }
  return target;
}

// Validates the text fields of a submission. `fields` is a plain object of form values.
export function validateSubmission(fields) {
  const errors = {};
  const kind = String(fields.kind ?? '');
  if (kind !== 'feedback' && kind !== 'correction') return { errors: { kind: 'Unknown submission type.' }, value: null };

  const message = cleanText(fields.message);
  if (message.length < LIMITS.minMessage) errors.message = `Please write at least ${LIMITS.minMessage} characters.`;
  else if (message.length > LIMITS.maxMessage) errors.message = `Please keep this under ${LIMITS.maxMessage} characters.`;

  const value = { kind, message, category: null, proposed: '', evidence: '', target: null };
  if (kind === 'feedback') {
    value.category = String(fields.category ?? '');
    if (!FEEDBACK_CATEGORIES.includes(value.category)) errors.category = 'Choose a topic.';
  } else {
    value.category = String(fields.field ?? '');
    if (!CORRECTION_FIELDS.includes(value.category)) errors.field = 'Choose what needs correcting.';
    value.proposed = cleanText(fields.proposed);
    if (value.proposed.length > LIMITS.maxProposed) errors.proposed = `Please keep this under ${LIMITS.maxProposed} characters.`;
    value.evidence = cleanText(fields.evidence);
    if (value.evidence.length > LIMITS.maxEvidence) errors.evidence = `Please keep this under ${LIMITS.maxEvidence} characters.`;
    value.target = parseTarget(fields.target, errors);
  }

  value.name = singleLine(fields.name);
  if (value.name.length > LIMITS.maxName) errors.name = `Please keep your name under ${LIMITS.maxName} characters.`;
  value.email = singleLine(fields.email).toLowerCase();
  if (value.email && (value.email.length > LIMITS.maxEmail || !EMAIL.test(value.email))) errors.email = 'Enter a valid email address, or leave it blank.';

  if (String(fields.consent ?? '') !== 'yes') errors.consent = 'Please confirm you agree to how your submission is used.';
  if (linkCount(`${message} ${value.proposed} ${value.evidence}`) > LIMITS.maxLinks) errors.message = 'Please include no more than 6 links.';

  const page = singleLine(fields.page);
  value.page = page.startsWith('/') && page.length <= 500 ? page : '';

  return { errors, value: Object.keys(errors).length ? null : value };
}

// Identifies an image from its leading bytes; the browser-supplied MIME type is never trusted.
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { type: 'image/png', ext: 'png' };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { type: 'image/webp', ext: 'webp' };
  return null;
}
