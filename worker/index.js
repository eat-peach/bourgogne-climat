// Bourgogne Climat Worker: serves the static atlas from `dist/` and handles the
// visitor feedback / correction API under /api/*.
import { LIMITS, STATUSES, sniffImage, validateSubmission } from './submissions.js';

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' } });
}
const fail = (status, error, extra = {}) => json({ ok: false, error, ...extra }, status);

function isConfigured(env) {
  return Boolean(env.DB && env.PHOTOS && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.IP_HASH_SALT);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyTurnstile(env, token, ip, expectedAction) {
  if (!token || token.length > 2048) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  body.append('idempotency_key', crypto.randomUUID());
  const res = await fetch(TURNSTILE_VERIFY, { method: 'POST', body });
  if (!res.ok) return false;
  const outcome = await res.json();
  if (!outcome.success) return false;
  // Test keys report the action "test"; real widgets report the action the page requested.
  if (outcome.action && outcome.action !== 'test' && outcome.action !== expectedAction) return false;
  if (env.TURNSTILE_HOSTNAME && outcome.hostname !== env.TURNSTILE_HOSTNAME) return false;
  return true;
}

async function rateLimited(env, ipHash) {
  const now = Date.now();
  const hourAgo = new Date(now - 3600e3).toISOString(), dayAgo = new Date(now - 86400e3).toISOString();
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN ip_hash = ?1 AND created_at > ?2 THEN 1 ELSE 0 END) AS ip_hour,
       SUM(CASE WHEN ip_hash = ?1 THEN 1 ELSE 0 END) AS ip_day,
       COUNT(*) AS global_day
     FROM submissions WHERE created_at > ?3`
  ).bind(ipHash, hourAgo, dayAgo).first();
  if ((row?.ip_hour || 0) >= LIMITS.perIpHour || (row?.ip_day || 0) >= LIMITS.perIpDay) return 'You have sent several submissions recently. Please try again later.';
  if ((row?.global_day || 0) >= LIMITS.globalDay) return 'We have received a lot of submissions today. Please try again tomorrow.';
  return null;
}

async function photoBytesStored(env) {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(photo_bytes), 0) AS bytes FROM submissions').first();
  return Number(row?.bytes || 0);
}

async function createSubmission(request, env, url) {
  if (!isConfigured(env)) return fail(503, 'Submissions are not available right now.');
  // Same-origin only: blocks other sites from posting on a visitor's behalf.
  if (request.headers.get('origin') !== url.origin) return fail(403, 'Submissions must be sent from the atlas page.');
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('multipart/form-data')) return fail(415, 'Unsupported submission format.');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > LIMITS.maxRequestBytes) return fail(413, 'The submission is too large. Please attach smaller photos.');

  let form;
  try { form = await request.formData(); } catch { return fail(400, 'The submission could not be read.'); }

  // Honeypot: real visitors never see this field. Pretend success so bots learn nothing.
  if (String(form.get('website') || '').trim()) return json({ ok: true, reference: null }, 202);

  const fields = {};
  for (const key of ['kind', 'category', 'field', 'message', 'proposed', 'evidence', 'target', 'name', 'email', 'consent', 'page']) fields[key] = form.get(key);
  const { errors, value } = validateSubmission(fields);
  if (!value) return fail(422, 'Please check the highlighted fields.', { fields: errors });

  const files = form.getAll('photos').filter(f => f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && f.size > 0);
  if (files.length > LIMITS.maxPhotos) return fail(422, `Attach up to ${LIMITS.maxPhotos} photos.`, { fields: { photos: `Attach up to ${LIMITS.maxPhotos} photos.` } });
  const photos = [];
  for (const file of files) {
    if (file.size > LIMITS.maxPhotoBytes) return fail(413, 'Each photo must be under 4 MB.', { fields: { photos: 'Each photo must be under 4 MB.' } });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffImage(bytes);
    if (!kind) return fail(422, 'Photos must be JPEG, PNG or WebP images.', { fields: { photos: 'Photos must be JPEG, PNG or WebP images.' } });
    photos.push({ bytes, ...kind });
  }
  const photoBytes = photos.reduce((sum, p) => sum + p.bytes.byteLength, 0);
  if (photoBytes && (await photoBytesStored(env)) + photoBytes > LIMITS.photoStorageBytes) {
    const message = 'Photo storage is full, so photos cannot be accepted right now. Please send your message without photos.';
    return fail(422, message, { fields: { photos: message }, photosEnabled: false });
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await verifyTurnstile(env, String(form.get('cf-turnstile-response') || ''), ip, value.kind))) {
    return fail(403, 'The verification check failed. Please complete it again and resend.', { retryVerification: true });
  }

  // Only a salted hash of the address is kept, for rate limiting and abuse review.
  const ipHash = await sha256Hex(`${env.IP_HASH_SALT}|${ip || 'unknown'}`);
  const limited = await rateLimited(env, ipHash);
  if (limited) return fail(429, limited);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const keys = [];
  try {
    for (const [i, photo] of photos.entries()) {
      const key = `submissions/${id}/${i + 1}.${photo.ext}`;
      await env.PHOTOS.put(key, photo.bytes, { httpMetadata: { contentType: photo.type }, customMetadata: { submission: id } });
      keys.push(key);
    }
    await env.DB.prepare(
      `INSERT INTO submissions (id, kind, status, created_at, category, message, proposed, evidence, contact_name, contact_email, target_json, page, user_agent, country, ip_hash, photo_keys, photo_bytes)
       VALUES (?1, ?2, 'new', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
    ).bind(
      id, value.kind, createdAt, value.category, value.message, value.proposed || null, value.evidence || null,
      value.name || null, value.email || null, value.target ? JSON.stringify(value.target) : null, value.page || null,
      (request.headers.get('user-agent') || '').slice(0, 300), request.cf?.country || null, ipHash, JSON.stringify(keys), photoBytes
    ).run();
  } catch (error) {
    if (keys.length) await env.PHOTOS.delete(keys).catch(() => {});
    throw error;
  }
  return json({ ok: true, reference: id.slice(0, 8).toUpperCase() }, 201);
}

// Admin sign-in: ADMIN_PASSWORD_HASH holds "pbkdf2-sha256:<iterations>:<salt b64>:<hash b64>"
// (scripts/hash_admin_password.mjs), never the password. A correct password buys a signed
// session token, so the slow hash runs once per sign-in, not on every admin request.
const SESSION_MS = 12 * 3600e3;
const ADMIN_FAILURES = { max: 5, windowMs: 15 * 60e3 };
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function passwordMatches(env, password) {
  const [scheme, iterations, salt, hash] = String(env.ADMIN_PASSWORD_HASH || '').split(':');
  if (scheme !== 'pbkdf2-sha256' || !salt || !hash || !password) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: Number(iterations) }, key, 256);
  const expected = unb64(hash);
  return expected.byteLength === bits.byteLength && crypto.subtle.timingSafeEqual(expected, bits);
}

const sessionKey = env => crypto.subtle.importKey('raw', new TextEncoder().encode(`session|${env.ADMIN_PASSWORD_HASH}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

async function issueSession(env) {
  const expires = String(Date.now() + SESSION_MS);
  const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), new TextEncoder().encode(expires));
  return `${expires}.${b64(sig)}`;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD_HASH) return false;
  const [expires, sig] = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').split('.');
  if (!expires || !sig || !(Number(expires) > Date.now())) return false;
  try { return await crypto.subtle.verify('HMAC', await sessionKey(env), unb64(sig), new TextEncoder().encode(expires)); } catch { return false; }
}

async function adminLogin(request, env) {
  if (request.method !== 'POST') return fail(405, 'Method not allowed.');
  if (!env.ADMIN_PASSWORD_HASH || !env.IP_HASH_SALT) return fail(503, 'Admin sign-in is not configured.');
  const ipHash = await sha256Hex(`${env.IP_HASH_SALT}|${request.headers.get('cf-connecting-ip') || 'unknown'}`);
  const since = new Date(Date.now() - ADMIN_FAILURES.windowMs).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_failures WHERE ip_hash = ?1 AND created_at > ?2').bind(ipHash, since).first();
  if ((row?.n || 0) >= ADMIN_FAILURES.max) return fail(429, 'Too many failed sign-ins. Try again in 15 minutes.');
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === 'string' ? body.password.slice(0, 256) : '';
  if (!(await passwordMatches(env, password))) {
    await env.DB.prepare('INSERT INTO admin_failures (ip_hash, created_at) VALUES (?1, ?2)').bind(ipHash, new Date().toISOString()).run();
    return fail(401, 'That password was not accepted.');
  }
  return json({ ok: true, token: await issueSession(env), expiresInMs: SESSION_MS });
}

function publicRow(row) {
  let target = null, photoKeys = [];
  try { target = row.target_json ? JSON.parse(row.target_json) : null; } catch {}
  try { photoKeys = JSON.parse(row.photo_keys || '[]'); } catch {}
  return {
    id: row.id, reference: row.id.slice(0, 8).toUpperCase(), kind: row.kind, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    category: row.category, message: row.message, proposed: row.proposed, evidence: row.evidence, name: row.contact_name, email: row.contact_email,
    target, page: row.page, userAgent: row.user_agent, country: row.country, sender: String(row.ip_hash || '').slice(0, 10),
    photoCount: photoKeys.length, adminNote: row.admin_note,
  };
}

async function adminRoute(request, env, url) {
  if (!env.DB || !env.PHOTOS) return fail(503, 'Storage is not configured.');
  if (url.pathname === '/api/admin/login') return adminLogin(request, env);
  if (!(await isAdmin(request, env))) return fail(401, 'Not authorised.');
  const parts = url.pathname.split('/').filter(Boolean); // api, admin, submissions, :id, photos, :n
  if (parts[2] !== 'submissions') return fail(404, 'Not found.');
  const id = parts[3];

  if (!id) {
    if (request.method !== 'GET') return fail(405, 'Method not allowed.');
    const status = url.searchParams.get('status') || 'all', kind = url.searchParams.get('kind') || 'all';
    if (status !== 'all' && !STATUSES.includes(status)) return fail(400, 'Unknown status.');
    if (!['all', 'feedback', 'correction'].includes(kind)) return fail(400, 'Unknown type.');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const { results } = await env.DB.prepare(
      `SELECT * FROM submissions WHERE (?1 = 'all' OR status = ?1) AND (?2 = 'all' OR kind = ?2) ORDER BY created_at DESC LIMIT ?3 OFFSET ?4`
    ).bind(status, kind, limit, offset).all();
    const counts = await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM submissions GROUP BY status`).all();
    return json({ ok: true, submissions: results.map(publicRow), counts: Object.fromEntries(counts.results.map(r => [r.status, r.n])) });
  }

  if (!UUID.test(id)) return fail(400, 'Invalid submission id.');
  const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?1').bind(id).first();
  if (!row) return fail(404, 'Submission not found.');
  let photoKeys = [];
  try { photoKeys = JSON.parse(row.photo_keys || '[]'); } catch {}

  if (parts[4] === 'photos') {
    const n = Number(parts[5]);
    const key = Number.isInteger(n) && n >= 1 ? photoKeys[n - 1] : null;
    if (request.method !== 'GET' || !key) return fail(404, 'Photo not found.');
    const object = await env.PHOTOS.get(key);
    if (!object) return fail(404, 'Photo not found.');
    const type = object.httpMetadata?.contentType;
    return new Response(object.body, { headers: {
      ...BASE_HEADERS, 'cache-control': 'private, no-store',
      'content-type': ['image/jpeg', 'image/png', 'image/webp'].includes(type) ? type : 'application/octet-stream',
      'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline',
    } });
  }
  if (parts.length > 4) return fail(404, 'Not found.');

  if (request.method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return fail(400, 'Invalid request.'); }
    const status = body?.status ?? row.status;
    const note = body?.adminNote == null ? row.admin_note : String(body.adminNote).slice(0, 2000);
    if (!STATUSES.includes(status)) return fail(400, 'Unknown status.');
    await env.DB.prepare('UPDATE submissions SET status = ?2, admin_note = ?3, updated_at = ?4 WHERE id = ?1').bind(id, status, note, new Date().toISOString()).run();
    return json({ ok: true });
  }
  if (request.method === 'DELETE') {
    if (photoKeys.length) await env.PHOTOS.delete(photoKeys);
    await env.DB.prepare('DELETE FROM submissions WHERE id = ?1').bind(id).run();
    return json({ ok: true });
  }
  if (request.method === 'GET') return json({ ok: true, submission: publicRow(row) });
  return fail(405, 'Method not allowed.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/config' && request.method === 'GET') {
        const enabled = isConfigured(env);
        // Room for at least one more full-size photo, or the form hides its photo field.
        const photosEnabled = enabled && (await photoBytesStored(env)) + LIMITS.maxPhotoBytes <= LIMITS.photoStorageBytes;
        return json({ enabled, photosEnabled, turnstileSiteKey: enabled ? env.TURNSTILE_SITE_KEY : null, limits: { maxPhotos: LIMITS.maxPhotos, maxPhotoBytes: LIMITS.maxPhotoBytes, maxMessage: LIMITS.maxMessage } });
      }
      if (url.pathname === '/api/submissions') return request.method === 'POST' ? await createSubmission(request, env, url) : fail(405, 'Method not allowed.');
      if (url.pathname.startsWith('/api/admin/')) return await adminRoute(request, env, url);
      return fail(404, 'Not found.');
    } catch (error) {
      console.error('api error', url.pathname, error?.stack || error);
      return fail(500, 'Something went wrong. Please try again later.');
    }
  },
};
