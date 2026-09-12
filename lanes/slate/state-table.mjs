#!/usr/bin/env node
// The ledger board's state table, computed by the same rules the viewer runs
// (companion/slate3d/src/state.js) from the pinned root store and the worker's
// daily head. Prints markdown, writes companion/boards/ledger.state.{json,md},
// and seals slate.state with both hashes so the table is its own receipt.
//   node lanes/slate/state-table.mjs [--board ledger] [--worker <url>] [--no-seal]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, stateTable } from '../../companion/slate3d/src/state.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = process.env.TIMMY_REPO ?? '<repo>';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BOARD = opt('--board', 'ledger');
const board = JSON.parse(readFileSync(join(ROOT, 'companion', 'boards', `${BOARD}.mission.json`), 'utf8'));
const WORKER = (opt('--worker', board.worker ?? 'https://timmy-ai-proxy-preview.wmeldman33.workers.dev')).replace(/\/$/, '');

// receipt records only (event envelopes have no hash)
const receipts = [];
for (const line of readFileSync(join(REPO, '.timmy', 'receipts', 'runs.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o && o.id && o.hash) receipts.push({ id: o.id, ts: o.ts, subject: o.subject, kind: o.kind, epoch: o.epoch ?? null, sources: o.sources ?? null });
}
const head = await fetch(`${WORKER}/head`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
const table = stateTable(board, receipts, head);
const md = renderMarkdown(table);
const jsonPath = join(ROOT, 'companion', 'boards', `${BOARD}.state.json`);
const mdPath = join(ROOT, 'companion', 'boards', `${BOARD}.state.md`);
writeFileSync(jsonPath, JSON.stringify(table, null, 1) + '\n');
writeFileSync(mdPath, `# ${board.name} · state\n\n${md}\n`);
console.log(md);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
if (!args.includes('--no-seal')) {
  const meta = [`board=${BOARD}`, `board_sha256=${sha(join(ROOT, 'companion', 'boards', `${BOARD}.mission.json`))}`, `table_json_sha256=${sha(jsonPath)}`, `table_md_sha256=${sha(mdPath)}`,
    `receipts=${receipts.length}`, `edge_head=${head?.combined_sha256 ?? 'none'}`, `edge_date=${head?.date ?? ''}`,
    ...table.capsules.map((c) => `${c.id}=${c.status} ${c.held}/${c.total}${c.unreceipted ? `+${c.unreceipted}u` : ''}`),
    ...table.frames.map((f) => `${f.id}=${f.status}${f.attested ? '(attested)' : ''} ${f.sealed}/${f.total}`)];
  const a = ['slate.state']; for (const m of meta) a.push('--meta', m);
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'seal', ...a], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
