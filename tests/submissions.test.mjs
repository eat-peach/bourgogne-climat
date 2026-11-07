import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, sniffImage, validateSubmission } from '../worker/submissions.js';
import { communeDisplayName } from '../dist/feature-panel.js';

const feedback = (extra = {}) => ({ kind: 'feedback', category: 'bug', message: 'The map froze when I panned north.', consent: 'yes', ...extra });
const target = JSON.stringify({ layer: 'climats', featureName: 'Les Chaumes', villageId: 'vosne-roman-e-21714' });
const correction = (extra = {}) => ({ kind: 'correction', field: 'classification', message: 'Les Chaumes is shown as village level.', proposed: 'Premier Cru', target, consent: 'yes', ...extra });

test('valid feedback and correction submissions pass', () => {
  assert.deepEqual(validateSubmission(feedback()).errors, {});
  const { errors, value } = validateSubmission(correction());
  assert.deepEqual(errors, {});
  assert.deepEqual(value.target, { layer: 'climats', featureName: 'Les Chaumes', villageId: 'vosne-roman-e-21714' });
});

test('consent, message length, category and email are enforced', () => {
  assert.ok(validateSubmission(feedback({ consent: '' })).errors.consent);
  assert.ok(validateSubmission(feedback({ message: 'too short' })).errors.message);
  assert.ok(validateSubmission(feedback({ message: 'x'.repeat(3001) })).errors.message);
  assert.ok(validateSubmission(feedback({ category: 'sql' })).errors.category);
  assert.ok(validateSubmission(feedback({ email: 'not-an-email' })).errors.email);
  assert.deepEqual(validateSubmission(feedback({ email: ' Me@Example.org ' })).value.email, 'me@example.org');
  assert.ok(validateSubmission({ ...feedback(), kind: 'admin' }).errors.kind);
});

test('link-heavy messages are rejected as spam', () => {
  const message = Array.from({ length: 7 }, (_, i) => `https://spam.example/${i}`).join(' ');
  assert.ok(validateSubmission(feedback({ message })).errors.message);
});

test('correction targets are whitelisted and require a selected place', () => {
  assert.ok(validateSubmission(correction({ target: '' })).errors.target);
  assert.ok(validateSubmission(correction({ target: '{bad json' })).errors.target);
  assert.ok(validateSubmission(correction({ target: JSON.stringify({ layer: 'roads', featureName: 'D974' }) })).errors.target);
  const { value } = validateSubmission(correction({ target: JSON.stringify({ layer: 'parcels', featureName: 'Romanée-Conti', injected: '<script>' }) }));
  assert.equal(value.target.injected, undefined);
});

test('text is normalised and stripped of control and bidi characters', () => {
  assert.equal(cleanText('  a\u0000b‮c\r\n\n\n\nd  '), 'abc\n\nd');
});

test('the page path must be relative', () => {
  assert.equal(validateSubmission(feedback({ page: '/#vosne-roman-e-21714' })).value.page, '/#vosne-roman-e-21714');
  assert.equal(validateSubmission(feedback({ page: 'javascript:alert(1)' })).value.page, '');
});

test('images are identified by signature, not by declared type', () => {
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).type, 'image/jpeg');
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).type, 'image/png');
  assert.equal(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')).type, 'image/webp');
  assert.equal(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>')), null);
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a')), null);
});

test('commune names keep French linking particles lower case', () => {
  assert.equal(communeDisplayName('Berzé-La-Ville'), 'Berzé-la-Ville');
  assert.equal(communeDisplayName('Bligny-Lès-Beaune'), 'Bligny-lès-Beaune');
  assert.equal(communeDisplayName("Saint-Symphorien-D'Ancelles"), "Saint-Symphorien-d'Ancelles");
  assert.equal(communeDisplayName("Paris-L'Hôpital"), "Paris-l'Hôpital");
  assert.equal(communeDisplayName('Le Breuil'), 'Le Breuil');
  assert.equal(communeDisplayName('Vosne-Romanée'), 'Vosne-Romanée');
  assert.equal(communeDisplayName('Chapelle-De-Guinchay'), 'La Chapelle-de-Guinchay');
});
