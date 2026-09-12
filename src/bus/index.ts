import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, statSync, openSync, readSync, closeSync } from 'fs';
import { join, dirname, basename } from 'path';

// CONTROL PLANE (ORDER control-plane-k3e7) — runs.jsonl formalized as THE
// event stream. publish(event) appends an NDJSON envelope; subscribe(filter)
// tails the file (initial backfill + fs.watch for live appends). Receipts
// remain the SEALED subset: receipt lines carry a top-level `hash` and are
// chain-verified by utils/receipts; bus event lines carry no top-level hash
// so readChain/verifyChain skip them and chain integrity is untouched.
export interface BusEvent {
  v: 1;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

export function busPath(dir: string = process.cwd()): string {
  // TEST ISOLATION (tui-redesign-p6a3 step 4): the bus lives INSIDE the store,
  // so a per-test TIMMY_STORE gets its own bus and tests never publish into
  // the real runs.jsonl. Same scoping rule as receiptsDir (default cwd only).
  if (process.env.TIMMY_STORE && dir === process.cwd()) return join(process.env.TIMMY_STORE, 'runs.jsonl');
  return join(dir, '.timmy', 'receipts', 'runs.jsonl');
}

export function publish(kind: string, payload: Record<string, unknown>, dir?: string): BusEvent {
  const ev: BusEvent = { v: 1, ts: new Date().toISOString(), kind, payload };
  const p = busPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(ev) + '\n', 'utf8');
  return ev;
}

export interface SubscribeHandle { stop(): void }

export function subscribe(
  cb: (ev: BusEvent) => void,
  opts: { filter?: (ev: BusEvent) => boolean; tail?: number; dir?: string } = {}
): SubscribeHandle {
  const p = busPath(opts.dir);
  const filter = opts.filter ?? (() => true);
  const parse = (l: string): BusEvent | null => {
    try { const o = JSON.parse(l); return o && typeof o.kind === 'string' ? (o as BusEvent) : null; } catch { return null; }
  };
  // initial backfill
  if (existsSync(p)) {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const slice = opts.tail && opts.tail > 0 ? lines.slice(-opts.tail) : lines;
    for (const l of slice) { const ev = parse(l); if (ev && filter(ev)) cb(ev); }
  }
  let offset = existsSync(p) ? statSync(p).size : 0;
  let buf = '';
  let fd = existsSync(p) ? openSync(p, 'r') : null;
  const drain = () => {
    try {
      if (!existsSync(p)) return;
      if (fd === null) { fd = openSync(p, 'r'); offset = 0; }
      const size = statSync(p).size;
      if (size < offset) { offset = 0; buf = ''; }
      if (size === offset) return;
      const len = size - offset;
      const b = Buffer.alloc(len);
      readSync(fd, b, 0, len, offset);
      offset = size;
      buf += b.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const l of parts) { const ev = parse(l); if (ev && filter(ev)) cb(ev); }
    } catch { /* transient */ }
  };
  // watch the DIRECTORY so we catch the stream file being created, then drain
  const target = join(dirname(p));
  mkdirSync(target, { recursive: true });
  const watcher = watch(target, (_evt, fname) => {
    if (fname && fname !== basename(p)) return;
    drain();
  });
  // poll fallback bounds delivery latency when fs.watch is slow (heavy load)
  const poll = setInterval(drain, 50);
  return { stop: () => { watcher.close(); clearInterval(poll); if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } fd = null; } } };
}
