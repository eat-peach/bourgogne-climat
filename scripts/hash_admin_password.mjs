// Prints the ADMIN_PASSWORD_HASH secret for a password read from the ADMIN_PASSWORD
// environment variable, so the password never lands in a file or the shell history:
//   ADMIN_PASSWORD=... node scripts/hash_admin_password.mjs | wrangler secret put ADMIN_PASSWORD_HASH
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const password = process.env.ADMIN_PASSWORD;
if (!password) { console.error('Set ADMIN_PASSWORD first.'); process.exit(1); }
// Workers' PBKDF2 accepts at most 100,000 iterations.
const iterations = 100000, salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
process.stdout.write(`pbkdf2-sha256:${iterations}:${salt.toString('base64')}:${hash.toString('base64')}`);
