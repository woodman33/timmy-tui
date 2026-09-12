#!/usr/bin/env node
// Edge chain → root chain anchor. Runs daily (launchd, see timmy.anchor.plist):
// fetch the public daily head from the custody edge, seal it as `chain.anchor`
// in the Timmy ROOT chain via the canonical CLI (store-pin preflight applies —
// if the resolved store is not the pinned root, the CLI STOPs and so do we).
// The edge never writes to the root chain; the root chain pulls the head.
//
// Env: CUSTODY_HEAD_URL (default https://preview.vault-custody.pages.dev/api/head)
//      TIMMY_REPO       (default: the main checkout)
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const HEAD_URL = process.env.CUSTODY_HEAD_URL ?? 'https://preview.vault-custody.pages.dev/api/head';
const REPO = process.env.TIMMY_REPO ?? '<repo>';
const LOG = join(REPO, '.timmy', 'anchor.log');

const log = (line) => {
  mkdirSync(join(REPO, '.timmy'), { recursive: true });
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  console.log(line);
};

async function main() {
  const r = await fetch(HEAD_URL, { headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) {
    log(`anchor.skip status=${r.status} url=${HEAD_URL}`);
    process.exit(r.status === 404 ? 0 : 1);
  }
  const head = await r.json();
  const meta = [
    `date=${head.date}`,
    `combined_sha256=${head.combined_sha256}`,
    `prev_combined_sha256=${head.prev_combined_sha256 ?? ''}`,
    `subjects=${head.subjects}`,
    `receipts=${head.receipts}`,
    `source=${HEAD_URL}`,
    `heads=${head.heads.map((h) => `${h.subject}:${h.head.slice(0, 8)}${h.ok ? '' : '!'}`).join(',')}`
  ];
  const args = ['tsx', 'src/cli.ts', 'seal', 'chain.anchor'];
  for (const m of meta) args.push('--meta', m);
  const out = execFileSync('npx', args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, TIMMY_STORE: process.env.TIMMY_STORE ?? '' } });
  log(`anchor.sealed date=${head.date} combined=${head.combined_sha256.slice(0, 16)} :: ${out.trim().split('\n').pop()}`);
}

main().catch((e) => {
  log(`anchor.error ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
