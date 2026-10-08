#!/usr/bin/env node
// Checks a tldraw license key with tldraw's own LicenseManager (signature, type, expiry, domains)
// and prints only the verdict: never the key, and the licensed hosts only with --show-hosts.
//   TLDRAW_LICENSE_KEY=... node license-check.mjs --editor <@tldraw/editor dir> [--show-hosts] [--summary] [HOST...]
// --summary prints one line (for a commit status): no hosts, no key.
// HOSTs are checked as https://HOST/ in production mode; with none, each licensed host is checked.
// Exit: 0 licensed for every host checked, 1 not (or the key is invalid), 2 usage, 66 no key set.
// No network: tldraw's tracking request is blocked, and validation is offline by design.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const take = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv.splice(i, 2)[1]; };
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const editor = take('--editor');
const testPublicKey = take('--test-public-key'); // the test suite's own key pair, never tldraw's
const showHosts = flag('--show-hosts');
const summary = flag('--summary');
if (!editor || argv.some((a) => a.startsWith('--'))) {
  console.error('usage: TLDRAW_LICENSE_KEY=... license-check.mjs --editor DIR [--show-hosts] [--summary] [HOST...]');
  process.exit(2);
}
const key = process.env.TLDRAW_LICENSE_KEY ?? '';
if (!key.trim()) {
  console.log('TLDRAW_LICENSE_KEY is not set: nothing to check.');
  process.exit(66);
}

// Any request (tldraw's watermark tracking) is answered here, counted and reported, never sent.
let requests = 0;
const blocked = async () => { requests++; return new Response(null, { status: 204 }); };
globalThis.fetch = blocked;
const at = (url) => { const u = new URL(url); globalThis.window = { location: { origin: u.origin, protocol: u.protocol, hostname: u.hostname, href: u.href }, fetch: blocked }; };
process.env.NODE_ENV = 'production';
const mod = await import(pathToFileURL(join(editor, 'dist-esm/lib/license/LicenseManager.mjs')).href);
const { version } = await import(pathToFileURL(join(editor, 'dist-esm/version.mjs')).href);

// Built in development mode (no tracking request, nothing logged), then pointed at each host.
at('http://localhost/');
const log = console.log;
console.log = () => {};
const manager = new mod.LicenseManager('', testPublicKey, 'development');
manager.verbose = false;
// Let its own (empty-key) validation finish while still in development mode.
for (let i = 0; i < 200 && manager.state.get() === 'pending'; i++) await new Promise((res) => setTimeout(res, 5));
const stateOf = (result) => {
  if (mod.getLicenseState) return mod.getLicenseState(result, () => {}, manager.isDevelopment); // tldraw 4+
  try {
    if (mod.isEditorUnlicensed(result)) return 'unlicensed'; // tldraw 3
  } catch {
    return 'unlicensed (internal license expired)';
  }
  return result.isLicensedWithWatermark ? 'licensed-with-watermark' : 'licensed';
};
const check = async (host) => {
  at(`https://${host}/`);
  manager.isDevelopment = manager.getIsDevelopment();
  const result = await manager.getLicenseFromKey(key);
  return { host, result, state: stateOf(result) };
};

const first = await check(argv[0] ?? 'licensed-hosts.invalid');
console.log = log;
const out = [`tldraw ${version} license check (tldraw's own LicenseManager; the key is never printed)`];
if (!first.result.isLicenseParseable) {
  out.push('  key      invalid: tldraw could not verify it (bad format or signature, or not a tldraw key)');
  out.push(`  network  ${requests ? `${requests} request(s) blocked, none sent` : 'none attempted'}`);
  console.log(summary ? `invalid key (tldraw ${version})` : out.join('\n'));
  process.exit(1);
}
const r = first.result;
const kinds = [
  r.isAnnualLicense && 'annual', r.isPerpetualLicense && 'perpetual', r.isEvaluationLicense && 'evaluation',
  r.isLicensedWithWatermark && 'with watermark', r.isInternalLicense && 'internal', r.isNativeLicense && 'native',
  r.isCollaborationEnabled && 'collaboration', r.isCommentingEnabled && 'commenting',
].filter(Boolean);
const day = 86_400_000;
const expiry = r.expiryDate instanceof Date && !Number.isNaN(r.expiryDate.getTime()) ? r.expiryDate : null;
const left = expiry ? Math.ceil((expiry.getTime() - Date.now()) / day) : null;
out.push('  key      valid signature (issued by tldraw)');
out.push(`  type     ${kinds.join(', ') || 'unknown flags'}`);
out.push(`  expires  ${expiry ? expiry.toISOString().slice(0, 10) : 'unknown'}${left === null ? '' : left >= 0 ? ` (in ${left} days)` : ` (${-left} days ago)`}`);
const hosts = r.license.hosts ?? [];
out.push(`  hosts    ${hosts.length} licensed${showHosts && hosts.length ? `: ${hosts.join(', ')}` : ''}`);
// With no HOST given, check each licensed host (a wildcard as one of its subdomains).
const targets = argv.length ? argv : hosts.map((h) => h.replace(/^\*\./, 'app.').replace(/\*/g, 'app'));
let ok = targets.length > 0;
let passing = 0;
for (const [i, host] of targets.entries()) {
  const c = i === 0 && argv.length ? first : await check(host);
  const good = c.state === 'licensed' || c.state === 'licensed-with-watermark';
  ok &&= good;
  if (good) passing += 1;
  const label = argv.length || showHosts ? `https://${host}/` : `licensed host ${i + 1}`;
  out.push(`  ${good ? 'ok  ' : 'FAIL'}     ${label}: ${c.state}`);
}
if (!targets.length) out.push('  FAIL     the license lists no hosts');
out.push(`  network  ${requests ? `${requests} request(s) blocked, none sent` : 'none attempted'}`);
console.log(summary
  ? `${ok ? 'valid' : 'NOT valid'} ${kinds[0] ?? 'license'}, expires ${expiry ? expiry.toISOString().slice(0, 10) : 'unknown'}, ${passing}/${targets.length} licensed hosts pass (tldraw ${version})`
  : out.join('\n'));
process.exit(ok ? 0 : 1);
