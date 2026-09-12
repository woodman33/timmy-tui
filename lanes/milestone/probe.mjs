#!/usr/bin/env node
// Milestone probe: every public route of the custody preview, with one content
// assertion per route so a 200 that renders an error page still fails. Prints a
// table and exits non-zero if anything is off; the milestone seal reads its
// output, so a red route means no receipt.
//
//   node lanes/milestone/probe.mjs [--base https://preview.vault-custody.pages.dev]
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('--base', 'https://preview.vault-custody.pages.dev').replace(/\/$/, '');
const OUT = opt('--out', null);

// The AN12196 published vector, the same one test/sun.test.ts pins. It must
// redirect, not render: /t verifies the CMAC and sends the tap to its receipt.
const VECTOR = '/t?e=EF963FF7828658A599F3041510671E88&c=94EED9EE65337086';

const ROUTES = [
  { name: 'gateway', path: '/', expect: 200, want: /Vault Custody|tap|custody/i },
  { name: 'tap vector', path: VECTOR, expect: 302, location: /\/r\/[A-Z0-9]+/ },
  { name: 'receipt', path: '/r/VC0007', expect: 200, want: /VC0007/ },
  { name: 'card', path: '/c/VC0007-17-03', expect: 200, want: /VC0007/ },
  { name: 'relic', path: '/relic/VC2210-08-01', expect: 200, want: /VC2210/ },
  { name: 'series', path: '/s/001', expect: 200, want: /series|Series/ },
  { name: 'manufacturer', path: '/m', expect: 200, want: /box|Box|manufactur/i },
  { name: 'log', path: '/log', expect: 200, want: /receipt|chain|log/i },
  { name: 'verify', path: '/verify', expect: 200, want: /verify|CMAC|tap/i },
  { name: 'provenance', path: '/p/VC0007', expect: 200, want: /VC0007/ },
  { name: 'companion', path: '/companion/?serial=VC0007', expect: 200, want: /<canvas|companion|Defold/i },
  { name: 'api head', path: '/api/head', expect: 200, json: (o) => typeof o.combined_sha256 === 'string' && Array.isArray(o.heads) },
  { name: 'api chain', path: '/api/chain/VC0007', expect: 200, json: (o) => Array.isArray(o.taps ?? o.events ?? o.chain) },
];

const rows = [];
for (const r of ROUTES) {
  const url = BASE + r.path;
  let row = { ...r, url, status: null, ok: false, note: '' };
  try {
    const res = await fetch(url, { redirect: 'manual', cache: 'no-store', headers: { 'user-agent': 'timmy-milestone-probe' } });
    row.status = res.status;
    const body = await res.text();
    row.bytes = body.length;
    row.body_sha256 = createHash('sha256').update(body).digest('hex');
    if (res.status !== r.expect) { row.note = `expected ${r.expect}`; }
    else if (r.location) {
      const loc = res.headers.get('location') ?? '';
      row.location = loc;
      row.ok = r.location.test(loc);
      row.note = row.ok ? `→ ${loc}` : `location ${loc || '(none)'} does not match`;
    } else if (r.json) {
      try { const o = JSON.parse(body); row.ok = r.json(o); row.note = row.ok ? 'shape ok' : 'json shape failed'; if (o.combined_sha256) row.note += ` head ${String(o.date ?? '')} ${String(o.combined_sha256).slice(0, 12)}`; }
      catch { row.note = 'not json'; }
    } else {
      row.ok = r.want.test(body);
      row.note = row.ok ? 'content ok' : `missing ${r.want}`;
    }
  } catch (e) {
    row.note = `fetch failed: ${e.message}`;
  }
  rows.push(row);
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${String(row.status ?? '---').padEnd(4)} ${r.name.padEnd(13)} ${r.path.slice(0, 52).padEnd(52)} ${row.note}`);
}

const bad = rows.filter((r) => !r.ok);
const summary = { base: BASE, checked_at: new Date().toISOString(), routes: rows.length, ok: rows.length - bad.length, failed: bad.map((r) => r.name), rows };
if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 1) + '\n');
console.log(`\n${rows.length - bad.length}/${rows.length} routes ok`);
process.exit(bad.length ? 1 : 0);
