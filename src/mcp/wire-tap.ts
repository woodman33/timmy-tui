#!/usr/bin/env node
/**
 * R6 (H142): Timmy's wire tap, a stdio pass-through between an MCP client (one of the two MCP-to-CLI routes) and a stdio MCP
 * server, so the Tools & MCP inspector can show a call's JSON-RPC traffic and how long each request took, measured here.
 *
 *   wire-tap --out <file> -- <command> [args...]
 *
 * It starts the server's command with this process's environment and folder, passes every byte both ways at once and
 * unchanged, and appends one line per JSON-RPC frame that passed to <file> (created with mode 0600), as JSON:
 *
 *   { v: 1, session: <this tap's pid>, seq, t: <epoch ms, sub-millisecond>, dir: 'to-server' | 'to-client', bytes,
 *     kind: 'request' | 'notification' | 'result' | 'error' | 'not json', id?, method?, line? }
 *
 * `method` on a result or an error is the method of the request it answers. `line` is the frame's exact text, as it passed,
 * for an initialize or tools/call request and its answer, and for every error, at most 64 KB (larger ones keep only their
 * size). A `start` line
 * names the server's program (never its arguments) and an `end` line its exit. The tap decides nothing and changes nothing:
 * what it measures is when each frame passed between the route and the server (a request's time is from its line to the
 * line that answers it, both seen here). Stopping the tap (SIGTERM, SIGINT) stops the server.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const WIRE_SCHEMA = 1;
/** The largest frame kept whole in the file. */
export const WIRE_FRAME_LIMIT = 64 * 1024;
/** The most frames one tap writes (a server that chatters is not kept forever). */
export const WIRE_FRAMES_MAX = 400;
/** The methods whose frames are kept whole (and every error). */
const KEPT = new Set(['initialize', 'tools/call']);

export type WireDir = 'to-server' | 'to-client';
export type WireKind = 'request' | 'notification' | 'result' | 'error' | 'not json';

export interface WireLine {
  v: 1;
  session: number;
  seq: number;
  t: number;
  dir?: WireDir;
  bytes?: number;
  kind?: WireKind | 'start' | 'end';
  id?: string | number;
  method?: string;
  /** the frame's exact text (initialize and tools/call requests and their answers, and every error) */
  line?: string;
  /** start: the server's program name; end: how it ended */
  program?: string;
  exit?: { code: number | null; signal: string | null };
  /** the frames past WIRE_FRAMES_MAX that were not written */
  dropped?: number;
}

const now = (): number => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;

export function parseTapArgs(argv: string[]): { out: string; command: string[] } | { error: string } {
  const split = argv.indexOf('--');
  if (split < 0 || split === argv.length - 1) return { error: 'usage: wire-tap --out <file> -- <command> [args...]' };
  const head = argv.slice(0, split);
  const at = head.indexOf('--out');
  const out = at >= 0 ? head[at + 1] : undefined;
  if (!out) return { error: 'usage: wire-tap --out <file> -- <command> [args...]' };
  return { out, command: argv.slice(split + 1) };
}

/** Runs the tap; resolves with the exit code the tap should end with. */
export function runTap(out: string, command: string[]): Promise<number> {
  const session = process.pid;
  let seq = 0;
  let written = 0;
  let dropped = 0;
  // the file is created 0600 before anything passes (an existing one is appended to: a route can start the server twice)
  try { closeSync(openSync(out, 'a', 0o600)); } catch { /* the trace is lost, the traffic still passes */ }
  const write = (l: Omit<WireLine, 'v' | 'session' | 'seq'>, frameLine = false): void => {
    if (frameLine && written >= WIRE_FRAMES_MAX) { dropped += 1; return; }
    if (frameLine) written += 1;
    try { appendFileSync(out, `${JSON.stringify({ v: WIRE_SCHEMA, session, seq: seq++, ...l })}\n`, { mode: 0o600 }); } catch { /* as above */ }
  };
  /** the method of each request by its id, in each direction, so its answer is named by it */
  const asked: Record<WireDir, Map<string, string>> = { 'to-server': new Map(), 'to-client': new Map() };
  const frame = (dir: WireDir, line: string): void => {
    const t = now();
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    let msg: Record<string, unknown> | null = null;
    try { const v = JSON.parse(line) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) msg = v as Record<string, unknown>; } catch { msg = null; }
    if (!msg) { write({ t, dir, bytes, kind: 'not json' }, true); return; }
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : undefined;
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    let kind: WireKind;
    let named = method;
    if (method && id !== undefined) { kind = 'request'; asked[dir].set(String(id), method); }
    else if (method) kind = 'notification';
    else {
      kind = 'error' in msg ? 'error' : 'result';
      // an answer travels the other way from the request it answers
      const back: WireDir = dir === 'to-client' ? 'to-server' : 'to-client';
      if (id !== undefined) { named = asked[back].get(String(id)); asked[back].delete(String(id)); }
    }
    const keep = (kind === 'error' || (named !== undefined && KEPT.has(named))) && bytes <= WIRE_FRAME_LIMIT;
    write({ t, dir, bytes, kind, ...(id !== undefined ? { id } : {}), ...(named ? { method: named } : {}), ...(keep ? { line } : {}) }, true);
  };
  const lines = (dir: WireDir): ((d: Buffer) => void) => {
    let buf = '';
    return (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) frame(dir, line);
      }
      // a frame longer than any kept one is counted when it ends; its text is not held beyond the limit
      if (buf.length > WIRE_FRAME_LIMIT * 4) buf = buf.slice(-WIRE_FRAME_LIMIT * 4);
    };
  };
  return new Promise((resolveTap) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    } catch (e) {
      process.stderr.write(`wire-tap: the server could not start: ${e instanceof Error ? e.message : String(e)}\n`);
      resolveTap(1);
      return;
    }
    write({ t: now(), kind: 'start', program: basename(command[0]) });
    const toServer = lines('to-server');
    const toClient = lines('to-client');
    process.stdin.on('data', (d: Buffer) => { child.stdin?.write(d); toServer(d); });
    process.stdin.on('end', () => { child.stdin?.end(); });
    process.stdin.on('error', () => { child.stdin?.end(); });
    child.stdin?.on('error', () => { /* the server left; its exit says how */ });
    child.stdout?.on('data', (d: Buffer) => { process.stdout.write(d); toClient(d); });
    const stop = (signal: NodeJS.Signals): void => { try { child.kill(signal); } catch { /* gone */ } };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
    child.on('error', (e) => { process.stderr.write(`wire-tap: the server could not start: ${e.message}\n`); });
    child.on('close', (code, signal) => {
      write({ t: now(), kind: 'end', exit: { code, signal }, ...(dropped ? { dropped } : {}) });
      // what the server printed last reaches the route before the tap ends
      process.stdout.write('', () => resolveTap(code ?? (signal ? 1 : 0)));
    });
  });
}

const invokedDirectly = (): boolean => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (invokedDirectly()) {
  const a = parseTapArgs(process.argv.slice(2));
  if ('error' in a) { process.stderr.write(`${a.error}\n`); process.exit(2); }
  runTap(a.out, a.command).then((code) => process.exit(code), (e: unknown) => { process.stderr.write(`wire-tap: ${String(e)}\n`); process.exit(1); });
}
