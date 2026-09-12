// lanes/factory/seal.mts — seal `<subject>` on the pinned runs chain (the worktree's .timmy/store-pin
// points at the main checkout's store). Mirrors lanes/visual/seal.mts (ORDER hana-h2m6).
//   tsx lanes/factory/seal.mts <subject> --note "…" [--status ok|failed] --sources a,b [--json '{…}'] [--child id,…] [--discrepancy "…"]…
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendReceipt, verifySignature, verifyChain } from '../../src/utils/receipts.ts';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const subject = argv[0];
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const flags = (n: string) => argv.map((a, i) => (a === n ? argv[i + 1] : null)).filter((x): x is string => !!x);
if (!subject || subject.startsWith('--')) { console.error('usage: seal.mts <subject> --note … --sources a,b [--status ok] [--json {…}] [--child …] [--discrepancy …]'); process.exit(2); }
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const sources = (flag('--sources') ?? '').split(',').filter(Boolean).map((p) => ({ path: p, sha256: sha(fs.readFileSync(path.join(ROOT, p))) }));
const extra = flag('--json') ? JSON.parse(flag('--json')!) : {};
const input: any = {
  kind: 'seal', subject, policy: 'auto', status: flag('--status') ?? 'ok',
  order: 'factory-f1d0', lane: 'factory', sources, artifacts: sources.map((s) => s.path),
  child_receipts: flags('--child').flatMap((s) => s.split(',')).filter(Boolean),
  discrepancies: flags('--discrepancy'), cost_usd: Number(extra.cost_usd ?? 0), ...extra,
  note: flag('--note') ?? '',
};
const r = appendReceipt('runs', input, ROOT);
const after = verifyChain('runs', ROOT);
if (!verifySignature(r) || !after.ok) throw new Error(`seal ${subject}: verification failed (sig=${verifySignature(r)} chain=${after.ok})`);
const line = { ts: r.ts, id: r.id, hash: r.hash, subject: r.subject, status: r.status, sources: sources.map((s) => `${s.path}@${s.sha256.slice(0, 12)}`) };
fs.appendFileSync(path.join(HERE, 'seals.jsonl'), JSON.stringify(line) + '\n');
console.log(JSON.stringify({ id: r.id, hash: r.hash, subject: r.subject, status: r.status, sources: sources.length, chain: { ok: after.ok, count: after.count } }));
