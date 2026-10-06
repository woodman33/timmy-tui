#!/usr/bin/env node
// Generates the two Timmy Pro server secrets and the matching public key.
//
//   node scripts/pro/gen-license-keys.mjs [--out <file>] [--force]
//
// Writes LICENSE_SIGNING_KEY (ed25519 private key, PKCS8 base64url) and
// LICENSE_KEY_SECRET (32 random bytes, base64url) to a 0600 file under
// TIMMY_PRIVATE_DIR (default .timmy/private/pro-secrets.env) and prints only the
// PUBLIC key, which goes into the CLI build. Feed the file to `wrangler secret
// put` and keep it out of git; the private values are never printed.

import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = resolve(outIdx >= 0 ? args[outIdx + 1] : join(process.env.TIMMY_PRIVATE_DIR || '.timmy/private', 'pro-secrets.env'));
if (existsSync(out) && !args.includes('--force')) {
  console.error(`refusing to overwrite ${out} (pass --force to replace; existing keys would stop verifying)`);
  process.exit(2);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const signingKey = b64url(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const keySecret = b64url(crypto.getRandomValues(new Uint8Array(32)));

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `LICENSE_SIGNING_KEY=${signingKey}\nLICENSE_KEY_SECRET=${keySecret}\nLICENSE_PUBLIC_KEY=${publicKey}\n`, { mode: 0o600 });
chmodSync(out, 0o600);

console.log(JSON.stringify({ ok: true, secrets_file: out, license_public_key: publicKey }, null, 2));
console.log('\nNext: in workers/pro run `npx wrangler@4 secret put LICENSE_SIGNING_KEY` and `... LICENSE_KEY_SECRET`,');
console.log('pasting the values from that file. Put license_public_key into the CLI build (TIMMY_PRO_PUBLIC_KEY).');
