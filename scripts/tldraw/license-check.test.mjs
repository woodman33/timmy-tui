// Controls for license-check.mjs, run against each pinned tldraw before the real key: licenses signed by
// this test's own P-256 key pair (accepted only with --test-public-key), a forged key checked
// against tldraw's real public key, garbage, no key. The key must never appear in the output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'license-check.mjs');
// The workflow installs each pinned @tldraw/editor and names its folder here (VERSION=DIR,...).
const EDITORS = Object.fromEntries((process.env.TLDRAW_EDITORS ?? '').split(',').filter(Boolean).map((pair) => pair.split('=')));
if (!Object.keys(EDITORS).length) throw new Error('Set TLDRAW_EDITORS=VERSION=DIR,... (the workflow does).');
const FLAGS = { ANNUAL: 1, PERPETUAL: 2, WATERMARK: 8 };
const day = 86_400_000;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));

async function license(hosts, flags, expiry) {
  for (let n = 0; ; n++) {
    const json = JSON.stringify([`test-license-${n}`, hosts, flags, expiry.toISOString()]);
    const data = Buffer.from(json, 'latin1').toString('base64');
    if (data.includes('/')) continue; // tldraw splits the key's first part on "/"
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(json, 'latin1')));
    return `tldraw-test/${data}.${b64(sig)}`;
  }
}
function run(version, key, args = [], trusted = true) {
  const r = spawnSync(process.execPath, [SCRIPT, '--editor', EDITORS[version], ...(trusted ? ['--test-public-key', publicKey] : []), ...args], {
    env: { ...process.env, TLDRAW_LICENSE_KEY: key }, encoding: 'utf8',
  });
  const out = r.stdout + r.stderr;
  if (key) assert.ok(!out.includes(key) && !out.includes(key.split('.')[1] ?? '\u0000'), 'the key (or its signature) was printed');
  return { status: r.status, out };
}

for (const v of Object.keys(EDITORS)) {
  test(`${v}: a valid annual license for the host passes, with the type and expiry and no host names`, async () => {
    const key = await license(['timmy.example'], FLAGS.ANNUAL, new Date(Date.now() + 200 * day));
    const r = run(v, key);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /valid signature/);
    assert.match(r.out, /type +annual/);
    assert.match(r.out, /expires +\d{4}-\d\d-\d\d \(in (199|200) days\)/);
    assert.match(r.out, /hosts +1 licensed\n/);
    assert.match(r.out, /ok +licensed host 1: licensed/);
    assert.match(r.out, /network +none attempted/);
    assert.ok(!r.out.includes('timmy.example'), 'hosts are private unless --show-hosts');
    assert.match(run(v, key, ['--show-hosts']).out, /1 licensed: timmy\.example/);
    assert.match(run(v, key, ['--summary']).out, /^valid annual, expires \d{4}-\d\d-\d\d, 1\/1 licensed hosts pass \(tldraw [\d.]+\)\n$/);
  });
  test(`${v}: the same license fails on a host it does not list`, async () => {
    const key = await license(['timmy.example'], FLAGS.ANNUAL, new Date(Date.now() + 200 * day));
    const r = run(v, key, ['elsewhere.example']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAIL +https:\/\/elsewhere\.example\/: unlicensed/);
  });
  test(`${v}: a wildcard license covers a subdomain`, async () => {
    const key = await license(['*.timmy.example'], FLAGS.ANNUAL, new Date(Date.now() + 30 * day));
    assert.equal(run(v, key, ['map.timmy.example']).status, 0);
  });
  test(`${v}: an annual license expired past the grace period fails`, async () => {
    const key = await license(['timmy.example'], FLAGS.ANNUAL, new Date(Date.now() - 60 * day));
    const r = run(v, key, ['timmy.example']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\(60 days ago\)|\(59 days ago\)/);
    assert.match(r.out, /FAIL +https:\/\/timmy\.example\/: (expired|unlicensed)/);
  });
  test(`${v}: a key not signed by tldraw is refused (checked against tldraw's real public key)`, async () => {
    const forged = await license(['timmy.example'], FLAGS.ANNUAL, new Date(Date.now() + 200 * day));
    const r = run(v, forged, ['timmy.example'], false);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /key +invalid/);
  });
  test(`${v}: garbage is refused, and no key at all says so`, () => {
    assert.equal(run(v, 'not-a-tldraw-key', [], false).status, 1);
    const none = run(v, '', [], false);
    assert.equal(none.status, 66);
    assert.match(none.out, /not set/);
  });
}
