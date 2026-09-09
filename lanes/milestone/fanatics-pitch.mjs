#!/usr/bin/env node
// Milestone lane: prove the Fanatics pitch surface stands, then seal it.
//
// Runs the route probe, hashes the pitch materials where they actually live,
// writes vault-custody/deck/MANIFEST.json (paths + hashes, not 36 MB of PDFs
// in git), and seals milestone.fanatics-pitch. A red route means no receipt.
//
//   node lanes/milestone/fanatics-pitch.mjs [--base <url>] [--no-seal]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('--base', 'https://preview.vault-custody.pages.dev');
const NO_SEAL = args.includes('--no-seal');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const shaFile = (p) => sha(readFileSync(p));
const short = (s) => String(s).slice(0, 12);

// ---------------------------------------------------------------- 1. routes
const probeOut = join(ROOT, 'lanes', 'milestone', '.cache', 'milestone-probe.json');
mkdirSync(dirname(probeOut), { recursive: true });
const probe = spawnSync('node', [join(ROOT, 'lanes', 'milestone', 'probe.mjs'), '--base', BASE, '--out', probeOut], { stdio: 'inherit' });
if (probe.status !== 0) {
  console.error('\nroutes did not all answer — refusing to seal a done milestone.');
  process.exit(1);
}
const routes = JSON.parse(readFileSync(probeOut, 'utf8'));

// ---------------------------------------------------------------- 2. pitch materials
// They live on the Desktop, not in the repo. Hash in place and record where.
const PITCH = '<home>/Desktop/FANATICS_PITCH_PACKAGE_2026-09-06';
const materials = [
  { role: 'deck · one-page brief', path: `${PITCH}/deck/Three-Step-Proposal.pdf` },
  { role: 'deck · brief + final deck', path: `${PITCH}/deck/Fanatics-Combined-Pitch.pdf` },
  { role: 'deck · final v2', path: `${PITCH}/deck/Fanatics-Vault-Custody-Timmy.pdf` },
  { role: 'deck · editable', path: `${PITCH}/deck/Fanatics-Vault-Custody-Timmy.pptx` },
  { role: 'deck · earlier final', path: '<home>/Desktop/VAULT_CUSTODY_x_TIMMY_deck_FINAL.pdf' },
  { role: 'walkthrough · 30s deck cut (ships in the package)', path: `${PITCH}/media/Vault-Custody-walkthrough-30s.mp4` },
  { role: 'walkthrough · v4 review cut', path: join(ROOT, 'renders', 'walkthrough', 'walkthrough.mp4') },
  { role: 'trailer · Timmy v17', path: `${PITCH}/media/Timmy-working-trailer-v17.mp4` },
].map((m) => {
  if (!existsSync(m.path)) return { ...m, missing: true };
  const st = statSync(m.path);
  return { ...m, sha256: shaFile(m.path), bytes: st.size, mtime: st.mtime.toISOString() };
});
const missing = materials.filter((m) => m.missing);
if (missing.length) {
  console.error('missing pitch material:', missing.map((m) => m.path).join(', '));
  process.exit(1);
}

// ---------------------------------------------------------------- 3. build evidence
const companionWasm = join(ROOT, 'vault-custody', 'public', 'companion', 'CustodyCompanion.wasm');
const stateTable = join(ROOT, 'companion', 'boards', 'ledger.state.json');
const badgePin = JSON.parse(readFileSync(join(ROOT, 'lanes', 'rive', 'badge.pin.json'), 'utf8'));
const table = JSON.parse(readFileSync(stateTable, 'utf8'));
const head = routes.rows.find((r) => r.name === 'api head');

const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const build = {
  site_commit: commit,
  companion_wasm_sha256: shaFile(companionWasm),
  companion_build_receipt: 'rc_mtq5vvyb_j1mn',      // defold.build, the badge v3 bundle
  rive_export_v3_receipt: 'rc_mtq5vcjy_ersu',
  badge_riv_sha256: badgePin.sha256,
  badge_source: badgePin.url,
  state_table_sha256: shaFile(stateTable),
  state_table_receipts: table.receipts,
  edge_head_date: table.head?.date ?? null,
  edge_head: table.head?.combined_sha256 ?? null,
  capsules: table.capsules.map((c) => `${c.id}=${c.status} ${c.held}/${c.total}`).join(' '),
  frames: table.frames.map((f) => `${f.id}=${f.status}`).join(' '),
};

// ---------------------------------------------------------------- 4. manifest
const manifestPath = join(ROOT, 'vault-custody', 'deck', 'MANIFEST.json');
mkdirSync(dirname(manifestPath), { recursive: true });
const manifest = {
  note: 'The pitch materials are large binaries and live outside the repo. This manifest is what the milestone receipt cites: where each file was, and what it hashed to, when the milestone was sealed.',
  package: PITCH,
  preview: BASE,
  sealed_for: 'milestone.fanatics-pitch',
  materials, routes: { checked_at: routes.checked_at, ok: routes.ok, of: routes.routes, rows: routes.rows.map((r) => ({ name: r.name, path: r.path, status: r.status, ok: r.ok, note: r.note })) },
  build,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
const manifestSha = shaFile(manifestPath);
console.log(`\nmanifest: ${relative(ROOT, manifestPath)} · ${short(manifestSha)}`);

// ---------------------------------------------------------------- 5. seal
const meta = {
  status: 'done',
  scope: 'pre-NFC snapshot of the pitch surface',
  preview: BASE,
  routes: `${routes.ok}/${routes.routes} ok`,
  tap_vector: routes.rows.find((r) => r.name === 'tap vector')?.note ?? '',
  site_commit: build.site_commit,
  manifest_sha256: manifestSha,
  deck_brief_sha256: materials[0].sha256,
  deck_combined_sha256: materials[1].sha256,
  walkthrough_30s_sha256: materials[5].sha256,
  walkthrough_v4_sha256: materials[6].sha256,
  walkthrough_v5: 'never made; the 30s deck cut is the current walkthrough',
  companion_wasm_sha256: build.companion_wasm_sha256,
  companion_build: build.companion_build_receipt,
  rive_export_v3: build.rive_export_v3_receipt,
  badge_riv_sha256: build.badge_riv_sha256,
  state_table_sha256: build.state_table_sha256,
  state_receipts: String(build.state_table_receipts),
  edge_head: `${build.edge_head_date} ${short(build.edge_head)}`,
  capsules: build.capsules,
  deck_path_note: 'vault-custody/deck holds the manifest only; the PDFs stay on the Desktop package',
};
if (NO_SEAL) { console.log(JSON.stringify(meta, null, 1)); process.exit(0); }
const a = ['milestone.fanatics-pitch'];
for (const [k, v] of Object.entries(meta)) a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 400)}`);
const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'seal', ...a], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
