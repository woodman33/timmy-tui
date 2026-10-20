/**
 * R9 (H159): what the installed Rerun CLI reads of a recording (.rrd): its entities, its timelines (their names and kinds) and
 * each timeline's range, beside the header facts Timmy reads itself (./recording.ts). Bounded:
 *
 *   the program   `rerun`, found as Rerun's viewer is found (./layers.ts rerunReady: TIMMY_RERUN, else the PATH). Its version
 *                 line (`rerun --version`) is recorded, and only a version whose output was checked here is read further
 *                 (RRD_CLI_CHECKED: rerun-cli 0.38.1, its outputs captured in tests/fixtures/rrd-cli/)
 *   the calls     `rerun rrd verify`; then `rrd stats` and `rrd print -vv`; and `rrd print -vvv` only on a recording of at most
 *                 RRD_PRINT_DATA_MAX. Each with argv only (never a shell) and the recording's own bytes on its standard input,
 *                 so the program reads the bytes Timmy hashed, never a path that could change or lead elsewhere; each in its
 *                 own process group, killed whole after RRD_CLI_TIMEOUT_MS; its output read up to RRD_CLI_OUTPUT_MAX, where
 *                 the read stops and says so
 *   the network   CI=1 in the program's environment, and FORCE_RERUN_ANALYTICS taken out. Observed here with strace on
 *                 rerun-cli 0.38.1: otherwise `rrd verify` and `rrd stats` read Rerun's analytics settings, write an
 *                 analytics file in the account's data folder and open a connection (the program names https://tel.rerun.io
 *                 as its analytics sink); with CI=1 they opened none and wrote none, and printed the same. `rrd print` and
 *                 `--version` opened none either way. The operator's own Rerun settings are never changed.
 *
 * The project's log: each call, as it ends, is one event on the project's bus (logRrdCall: kind "rrd.cli", in the store the
 * project's receipts go to, as the Logs tab reads it): the command, the CLI's version, the exit, the duration, the bytes read
 * and whether it was cut, with the recording's path in the project and its sha256. Never its output, and no folder of this
 * computer.
 *
 * What it says: each fact as read, with the command that read it; or an explicit unknown with why: the CLI is not installed,
 * its version was not checked here (and which was), a timeout, an output over the cap, Rerun's own check failed, a bad exit,
 * or output that does not parse. Nothing is guessed: a range not read stays unknown, and an output cut short is never read as
 * a whole. The checks against each other (the entities rrd stats lists against its own count, the chunks each print shows
 * against the chunks rrd stats counted, each chunk's rows against its header) turn a mismatch into "does not parse".
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { publish } from '../bus/index.js';
import { projectId } from '../project/index.js';
import { rerunReady } from './layers.js';
import { onPathOf } from './preview.js';

export const RRD_CLI_SCHEMA = 'timmy.rrd-cli/1';
/** The rerun-cli versions whose output this reader was checked against (their outputs are in tests/fixtures/rrd-cli/). */
export const RRD_CLI_CHECKED: readonly string[] = ['0.38.1'];
/** How long one call may take before its process group is killed. */
export const RRD_CLI_TIMEOUT_MS = 10_000;
/** The most of one call's output (its stdout and stderr together) read. */
export const RRD_CLI_OUTPUT_MAX = 4 * 1024 * 1024;
/** The largest recording whose data `rrd print -vvv` prints here (it prints every row's values). */
export const RRD_PRINT_DATA_MAX = 16 * 1024 * 1024;

export type RrdUnknownReason =
  | 'not-installed' | 'version-not-checked' | 'timeout' | 'over-cap' | 'verify-failed' | 'failed' | 'does-not-parse' | 'not-run'
  | 'being-read' | 'not-a-recording';
/** A fact not read, and why. */
export interface RrdUnknown { state: 'unknown'; reason: RrdUnknownReason; why: string }

/** One run of the program, as the project's log names it. */
export interface RrdCall {
  /** the command without the program's path: "rerun rrd stats" */
  command: string;
  /** the program's version (rerun-cli X.Y.Z) when it was known before the call */
  version: string | null;
  /** what it was given on its standard input */
  input: { sha256: string; bytes: number; words: string } | null;
  exit: number | null;
  signal: string | null;
  /** when it started */
  at: string;
  ms: number;
  /** its output read (stdout and stderr), at most the cap */
  bytes: number;
  /** its output was over the cap: the read stopped there */
  cut: boolean;
  /** it gave no answer in time: its process group was killed */
  timedOut: boolean;
  /** it could not be started */
  error?: string;
}

export interface RrdStore { kind: 'recording' | 'blueprint' | 'other'; application: string; recording: string; entities: number }
export interface RrdEntities {
  state: 'read';
  count: number;
  /** each entity path as rrd stats prints it (Rerun's own escaped form), across every store in the file */
  paths: string[];
  by: 'rrd stats';
  /** the file's stores, as rrd stats' chunk index names them, with each one's entity count */
  stores: RrdStore[];
  /** the entities with data logged on no timeline (static): a chunk of theirs has no index column */
  static: { state: 'read'; paths: string[]; by: 'rrd print -vv' } | RrdUnknown;
}
export type RrdTimelineKind = 'sequence' | 'timestamp' | 'duration' | 'other';
export interface RrdRange { state: 'read'; min: string; max: string; words: string; by: 'rrd print -vvv' }
export interface RrdTimeline {
  name: string;
  /** how many chunks have it, as rrd stats counts them */
  chunks: number;
  /** its kind, from its index column's type (Int64 a sequence, Timestamp(ns) a timestamp, Duration(ns) a duration) */
  kind: { state: 'read'; kind: RrdTimelineKind; type: string; by: 'rrd print -vv' } | RrdUnknown;
  /** its least and greatest value as rerun prints them, from every row */
  range: RrdRange | RrdUnknown;
}
export interface RrdTimelines { state: 'read'; by: 'rrd stats'; list: RrdTimeline[] }
export type RrdVerify = { state: 'passed'; words: string; by: 'rrd verify' } | { state: 'failed'; why: string; by: 'rrd verify' } | RrdUnknown;

export interface RrdReading {
  schema: typeof RRD_CLI_SCHEMA;
  /** read: the reading ran to its end (each fact says what it holds); not read: nothing past the version was run */
  state: 'read' | 'being read' | 'not read';
  /** who read what, in words: "read by rerun-cli 0.38.1: rrd stats and rrd print"; or why not */
  words: string;
  /** the bytes read: their sha256 (null: they were not read) and length */
  sha256: string | null;
  bytes: number;
  cli: { version: string | null; line: string | null; via: string | null; checked: readonly string[] };
  /** the step that installs the CLI, when it is not installed */
  setup?: string;
  verify: RrdVerify;
  entities: RrdEntities | RrdUnknown;
  timelines: RrdTimelines | RrdUnknown;
  calls: RrdCall[];
  /** when the reading ended */
  at: string | null;
}

export interface RrdReadOptions {
  /** PATH and TIMMY_RERUN, to find the program; the program's environment (with CI=1, FORCE_RERUN_ANALYTICS taken out) */
  env: NodeJS.ProcessEnv;
  /** the bytes' sha256, when it is known already */
  sha256?: string;
  timeoutMs?: number;
  max?: number;
  dataMax?: number;
  /** each call as it ends (the project's log takes them) */
  onCall?: (call: RrdCall) => void;
  /** the program's version line, when it was read before for this program (it is not asked again) */
  known?: { line: string };
}

// ── the program ────────────────────────────────────────────────────────────────

/** The environment the program runs in: the caller's, with Rerun's analytics off (CI=1) and never forced on. */
export function rrdCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, CI: '1' };
  delete out.FORCE_RERUN_ANALYTICS;
  return out;
}

/** Rerun's CLI as this computer has it: found (its path and how) or not, with why and its setup. Nothing is run. */
export function findRerun(env: NodeJS.ProcessEnv): { ok: true; command: string; via: string } | { ok: false; why: string; setup: string } {
  const r = rerunReady({ env, onPath: onPathOf(env), root: '' });
  return r.ready ? { ok: true, command: r.command, via: r.via } : { ok: false, why: r.why, setup: r.setup };
}

interface Ran { call: RrdCall; stdout: Buffer; stderr: Buffer }

/**
 * One call: argv only, in its own process group (detached), the input on its standard input; the group is killed after
 * `timeoutMs` or once its output passes `max` (what was read up to the cap is kept, and the call says it was cut).
 */
function runOnce(program: string, args: string[], o: { input: Buffer | null; sha256: string; env: NodeJS.ProcessEnv; timeoutMs: number; max: number; version: string | null }): Promise<Ran> {
  return new Promise((resolve) => {
    const started = Date.now();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let cut = false;
    let timedOut = false;
    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    const finish = (exit: number | null, signal: string | null, error?: string): void => {
      if (ended) return;
      ended = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      const call: RrdCall = {
        command: ['rerun', ...args].join(' '), version: o.version,
        input: o.input ? { sha256: o.sha256, bytes: o.input.length, words: 'the recording\'s bytes on its standard input' } : null,
        exit, signal, at: new Date(started).toISOString(), ms: Date.now() - started, bytes, cut, timedOut, ...(error ? { error } : {}),
      };
      resolve({ call, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    };
    const killGroup = (): void => {
      const pid = child?.pid;
      if (!pid) return;
      try { process.kill(-pid, 'SIGKILL'); } catch { try { child?.kill('SIGKILL'); } catch { /* gone */ } }
    };
    // stopped: the whole group is killed; if its output streams are still held open (by a process that left the group), the
    // call ends anyway a moment after
    const stop = (): void => {
      killGroup();
      if (!grace) grace = setTimeout(() => { child?.stdout?.destroy(); child?.stderr?.destroy(); finish(null, 'SIGKILL'); }, 2000);
    };
    try {
      child = spawn(program, args, { env: o.env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
    } catch (e) { finish(null, null, e instanceof Error ? e.message : String(e)); return; }
    timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
    const take = (into: Buffer[]) => (b: Buffer): void => {
      if (cut) return;
      const room = o.max - bytes;
      if (b.length > room) { into.push(b.subarray(0, room)); bytes = o.max; cut = true; stop(); return; }
      into.push(b);
      bytes += b.length;
    };
    child.stdout?.on('data', take(out));
    child.stderr?.on('data', take(err));
    child.stdin?.on('error', () => { /* it did not read all of its input: how it ended says the rest */ });
    child.once('error', (e) => finish(null, null, e.message));
    child.once('close', (code, signal) => finish(code, signal));
    child.stdin?.end(o.input ?? undefined);
  });
}

// ── the words ──────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const textOf = (b: Buffer): string => b.toString('utf8').replace(ANSI, '').replace(/\r/g, '');
const seconds = (ms: number): string => String(Number((ms / 1000).toFixed(3)));
const capWords = (n: number): string => (n % (1024 * 1024) === 0 ? `${n / 1024 / 1024} MiB` : n % 1024 === 0 ? `${n / 1024} KiB` : `${n} bytes`);
export const bytesWords = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const possessive = (name: string): string => (name.endsWith('s') ? `${name}'` : `${name}'s`);
/** What a program said on its stderr, in a few words: its lines without colour codes or its own INFO lines, at most 300 characters. */
function saidOf(stderr: Buffer): string {
  const lines = textOf(stderr).split('\n').map((l) => l.trim()).filter((l) => l && !/^\S+Z\s+INFO\s/.test(l));
  const said = lines.join(' · ');
  return said.length > 300 ? `${said.slice(0, 299)}…` : said;
}

interface CallFault { reason: RrdUnknownReason; short: string; why: string }
/** How a call that did not end well ended, in words; null when it exited 0 with its whole output. */
function faultOf(r: Ran, name: string, o: { timeoutMs: number; max: number }): CallFault | null {
  const c = r.call;
  if (c.error) { const s = `${name} could not be run (${c.error})`; return { reason: 'failed', short: s, why: s }; }
  if (c.timedOut) { const s = `${name} gave no answer in ${seconds(o.timeoutMs)} s`; return { reason: 'timeout', short: s, why: `${s}, so it was stopped (its process group was killed)` }; }
  if (c.cut) { const s = `${name} printed more than ${capWords(o.max)}, the most read here`; return { reason: 'over-cap', short: s, why: `${s}, so the read stopped there` }; }
  if (c.exit !== 0) {
    const said = saidOf(r.stderr);
    const s = `${name} ended with ${c.exit === null ? `signal ${c.signal ?? 'unknown'}` : `exit ${c.exit}`}${said ? `: ${said}` : ''}${/\bstdin\b/.test(said) ? ' (the recording was given on its standard input)' : ''}`;
    return { reason: 'failed', short: s, why: s };
  }
  return null;
}
const unknown = (reason: RrdUnknownReason, why: string): RrdUnknown => ({ state: 'unknown', reason, why });

// ── the outputs ────────────────────────────────────────────────────────────────

/** A version line's version: "rerun-cli 0.38.1 (…)" is 0.38.1. */
export function versionOf(line: string): string | null {
  return /^rerun-cli (\d+\.\d+\.\d+)(?:\s|$)/.exec(line)?.[1] ?? null;
}

export interface RrdStats { entities: string[]; chunks: number; timelines: Array<{ name: string; chunks: number }>; stores: RrdStore[] }

/** rrd stats' report (rerun-cli 0.38.1's layout): its Overview counts, its chunks per entity and per index, its chunk index. */
export function parseStats(text: string): RrdStats | { error: string } {
  const lines = text.split('\n');
  const section = (title: string): string[] | null => {
    const at = lines.findIndex((l, k) => l === title && /^-{3,}$/.test(lines[k + 1] ?? ''));
    if (at < 0) return null;
    const out: string[] = [];
    for (let k = at + 2; k < lines.length && lines[k].trim() !== ''; k += 1) out.push(lines[k]);
    return out;
  };
  const counted = (rows: string[], what: string): Array<{ name: string; chunks: number }> | { error: string } => {
    const out: Array<{ name: string; chunks: number }> = [];
    for (const l of rows) {
      const m = /^(.+): (\d+)$/.exec(l);
      if (!m) return { error: `a line of its "${what}" it does not read: "${l.slice(0, 80)}"` };
      out.push({ name: m[1], chunks: Number(m[2]) });
    }
    return out;
  };
  const perEntity = section('Num chunks per entity');
  if (!perEntity) return { error: 'it has no "Num chunks per entity" section' };
  const entities = counted(perEntity, 'Num chunks per entity');
  if ('error' in entities) return entities;
  if (entities.some((e) => !e.name.startsWith('/'))) return { error: 'an entity path in it does not start with "/"' };
  const overview = section('Overview');
  const count = (key: string): number | null => { const m = new RegExp(`^${key} = (\\d+)$`).exec(overview?.find((l) => l.startsWith(`${key} = `)) ?? ''); return m ? Number(m[1]) : null; };
  const paths = count('num_entity_paths');
  const chunks = count('num_chunks');
  if (paths === null || chunks === null) return { error: 'its Overview does not say num_entity_paths and num_chunks' };
  if (paths !== entities.length) return { error: `it lists ${entities.length} entity paths and counts ${paths}` };
  const perIndex = section('Num chunks per index');
  if (!perIndex) return { error: 'it has no "Num chunks per index" section' };
  const timelines = counted(perIndex, 'Num chunks per index');
  if ('error' in timelines) return timelines;
  const stores: RrdStore[] = [];
  for (let k = 0; k < lines.length; k += 1) {
    const m = /^Chunk index for StoreId\((\w+), "((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"\)$/.exec(lines[k]);
    if (!m) continue;
    let n: number | null = null;
    for (let j = k + 1; j < lines.length && lines[j].startsWith('  '); j += 1) {
      const e = /^ {2}num_entity_paths = (\d+)$/.exec(lines[j]);
      if (e) n = Number(e[1]);
    }
    if (n === null) return { error: `its chunk index for ${m[1]} "${m[2]}" does not say num_entity_paths` };
    stores.push({ kind: m[1] === 'Recording' ? 'recording' : m[1] === 'Blueprint' ? 'blueprint' : 'other', application: m[2], recording: m[3], entities: n });
  }
  return { entities: entities.map((e) => e.name), chunks, timelines, stores };
}

export interface PrintedChunk {
  id: string;
  rows: number;
  entity: string;
  /** its index columns (its timelines), with the type each column says */
  indexes: Array<{ name: string; type: string }>;
  /** each index column's values, one per row, as printed (with the data only) */
  values: string[][];
}

const ROW_ID = /^row_[0-9A-Za-z]+$/;
/** A line of a chunk's table: its cells, or null when it is not a content line ("│ │ … ┆ … │ │"). */
function cellsOf(line: string): string[] | null {
  const end = line.trimEnd();
  if (!line.startsWith('│ │') || !end.endsWith('│ │') || end.length < 6) return null;
  return end.slice(3, end.length - 3).split('┆').map((c) => c.trim());
}

/**
 * rrd print -vv's or -vvv's chunks (rerun-cli 0.38.1's layout): each chunk's header line ("Chunk(…) with N rows (…) - <entity> - "),
 * its table's columns (an index column says "kind: index", its "index_name" and its "type"), and with the data, each row's
 * index values. Its store-info and blueprint lines are passed over (their chunks are counted all the same).
 */
export function parsePrint(text: string, data: boolean): { chunks: PrintedChunk[] } | { error: string } {
  const lines = text.split('\n');
  const chunks: PrintedChunk[] = [];
  for (let k = 0; k < lines.length; k += 1) {
    const head = /^Chunk\((chunk_[0-9A-Za-z]+)\) with (\d+) rows \([^)]*\) - (.*) - $/.exec(lines[k]);
    if (!head) continue;
    const at = `chunk ${chunks.length + 1} (${head[1]})`;
    // the table: header lines up to "╞", then rows up to "└"
    let j = k + 1;
    while (j < lines.length && !lines[j].startsWith('│ ┌') && !lines[j].startsWith('Chunk(')) j += 1;
    if (j >= lines.length || !lines[j].startsWith('│ ┌')) return { error: `${at} has no table` };
    const header: string[][] = [];
    for (j += 1; j < lines.length && !lines[j].startsWith('│ ╞'); j += 1) {
      const cells = cellsOf(lines[j]);
      if (!cells) return { error: `${at}: a header line it does not read` };
      header.push(cells);
    }
    if (j >= lines.length || !header.length) return { error: `${at}: its table has no header` };
    const width = header[0].length;
    if (header.some((h) => h.length !== width)) return { error: `${at}: its header's lines have different numbers of columns` };
    if (header[0][0] !== 'RowId') return { error: `${at}: its first column is not RowId` };
    const cols = Array.from({ length: width }, (_, c) => header.map((h) => h[c]).filter(Boolean));
    const attr = (c: number, key: string): string | undefined => cols[c].find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2);
    const indexCols: number[] = [];
    for (let c = 1; c < width; c += 1) if (attr(c, 'kind') === 'index') indexCols.push(c);
    const dataCols = Array.from({ length: width }, (_, c) => c).filter((c) => c > 0 && !indexCols.includes(c));
    if (indexCols.some((c) => dataCols.some((d) => d < c))) return { error: `${at}: an index column comes after a data column` };
    const indexes = indexCols.map((c) => ({ name: attr(c, 'index_name') ?? cols[c][0] ?? '', type: attr(c, 'type') ?? '' }));
    if (indexes.some((x) => !x.name || !x.type)) return { error: `${at}: an index column without its index_name or type` };
    const values: string[][] = indexCols.map(() => []);
    let rows = 0;
    let open: string[] | null = null;
    const close = (): void => { if (open) { open.forEach((v, n) => values[n].push(v)); open = null; } };
    for (j += 1; j < lines.length && !lines[j].startsWith('│ └'); j += 1) {
      if (lines[j].startsWith('│ ├')) { close(); continue; }
      const cells = cellsOf(lines[j]);
      if (!cells || cells.length < width) return { error: `${at}: a row line it does not read` };
      if (ROW_ID.test(cells[0])) { close(); rows += 1; open = indexCols.map((c) => cells[c]); }
      else if (cells[0] === '' && open) { const o: string[] = open; indexCols.forEach((c, n) => { if (cells[c]) o[n] += cells[c]; }); }
      else return { error: `${at}: a row without its row id` };
    }
    close();
    if (j >= lines.length) return { error: `${at}: its table does not end` };
    if (data && rows !== Number(head[2])) return { error: `${at} says ${head[2]} rows and shows ${rows}` };
    if (!data && rows) return { error: `${at} shows its data, which rrd print -vv does not` };
    const meta = lines.slice(k + 1, j).find((l) => l.startsWith('│ * entity_path: '));
    const entity = meta ? meta.replace(/^│ \* entity_path: /, '').replace(/\s*│\s*$/, '') : head[3];
    if (meta && entity !== head[3]) return { error: `${at}: its entity is said two ways` };
    chunks.push({ id: head[1], rows: Number(head[2]), entity, indexes, values });
    k = j;
  }
  return { chunks };
}

// ── values ─────────────────────────────────────────────────────────────────────

const NS = 1_000_000_000n;
const KINDS: Record<string, RrdTimelineKind> = { Int64: 'sequence', 'Timestamp(ns)': 'timestamp', 'Duration(ns)': 'duration' };
const fraction = (f: string | undefined): bigint => (f ? BigInt(f.padEnd(9, '0')) : 0n);
/** Days from 1970-01-01 to a date of the proleptic Gregorian calendar (H. Hinnant's days_from_civil). */
function daysFrom(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
/** A value as rerun prints it, as a whole number (nanoseconds for a timestamp or a duration); null when it is not one. */
export function valueOf(kind: RrdTimelineKind, v: string): bigint | null {
  if (kind === 'sequence') return /^-?\d{1,19}$/.test(v) ? BigInt(v) : null;
  if (kind === 'duration') {
    const m = /^(-)?P(?:0D|T(\d{1,19})(?:\.(\d{1,9}))?S)$/.exec(v);
    if (!m) return null;
    const ns = BigInt(m[2] ?? '0') * NS + fraction(m[3]);
    return m[1] ? -ns : ns;
  }
  if (kind === 'timestamp') {
    const m = /^(-?\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(v);
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
    return (BigInt(daysFrom(y, mo, d)) * 86_400n + BigInt(h * 3600 + mi * 60 + s)) * NS + fraction(m[7]);
  }
  return null;
}
/** A whole number of `unit` nanoseconds and its fraction, without trailing zeros: 2253343 ns in ms is "2.253343". */
function decimal(ns: bigint, unit: bigint, digits: number): string {
  const neg = ns < 0n;
  const a = neg ? -ns : ns;
  const frac = (a % unit).toString().padStart(digits, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / unit}${frac ? `.${frac}` : ''}`;
}
const secondsOf = (ns: bigint): string => `${decimal(ns, NS, 9)} s`;
/** A span of time in its own unit: ns, µs, ms or s. */
function spanOf(ns: bigint): string {
  if (ns < 1000n) return `${ns} ns`;
  if (ns < 1_000_000n) return `${decimal(ns, 1000n, 3)} µs`;
  if (ns < NS) return `${decimal(ns, 1_000_000n, 6)} ms`;
  return secondsOf(ns);
}

/** A timeline's range from its printed values: the least and the greatest, as printed, in words; or why not. */
function rangeOf(kind: RrdTimelineKind, type: string, printed: string[]): RrdRange | RrdUnknown {
  if (kind === 'other') return unknown('does-not-parse', `its index column's type (${type}) is not one whose values Timmy reads`);
  if (!printed.length) return unknown('does-not-parse', 'rrd print -vvv printed no value of it');
  let lo: { v: bigint; t: string } | null = null;
  let hi: { v: bigint; t: string } | null = null;
  for (const t of printed) {
    const v = valueOf(kind, t);
    if (v === null) return unknown('does-not-parse', `rrd print -vvv printed a ${kind} value Timmy does not read: "${t.slice(0, 60)}"`);
    if (!lo || v < lo.v) lo = { v, t };
    if (!hi || v > hi.v) hi = { v, t };
  }
  const min = lo!;
  const max = hi!;
  const words = kind === 'sequence' ? `${min.t} to ${max.t}`
    : kind === 'duration' ? `${secondsOf(min.v)} to ${secondsOf(max.v)}`
      : `${min.t} to ${max.t} (${spanOf(max.v - min.v)})`;
  return { state: 'read', min: min.t, max: max.t, words, by: 'rrd print -vvv' };
}

// ── the reading ────────────────────────────────────────────────────────────────

const sha256Of = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The reading's words: who read what, from the facts it holds. */
function wordsOf(version: string, entities: RrdReading['entities'], timelines: RrdReading['timelines'], verify: RrdVerify): string {
  if (verify.state === 'failed') return `rerun-cli ${version} could not verify it (rrd verify failed), so nothing more was read`;
  const printed = timelines.state === 'read' && timelines.list.some((t) => t.kind.state === 'read' || t.range.state === 'read')
    || (entities.state === 'read' && entities.static.state === 'read');
  if (entities.state !== 'read') return `rerun-cli ${version} read nothing of it: ${entities.why.replace(/^not read: /, '')}`;
  return `read by rerun-cli ${version}: rrd stats${printed ? ' and rrd print' : ''}`;
}

/**
 * What the installed Rerun CLI reads of these bytes: the program found, its version checked, then rrd verify, rrd stats,
 * rrd print -vv and (on a small enough recording) rrd print -vvv, each bounded. Never throws: each fact it cannot read is an
 * unknown with why.
 */
export async function readRrdWithCli(body: Buffer, o: RrdReadOptions): Promise<RrdReading> {
  const sha256 = o.sha256 ?? sha256Of(body);
  const timeoutMs = o.timeoutMs ?? RRD_CLI_TIMEOUT_MS;
  const max = o.max ?? RRD_CLI_OUTPUT_MAX;
  const dataMax = o.dataMax ?? RRD_PRINT_DATA_MAX;
  const calls: RrdCall[] = [];
  const base = { schema: RRD_CLI_SCHEMA, sha256, bytes: body.length } as const;
  const notRead = (u: RrdUnknown, cli: RrdReading['cli'], extra: Partial<RrdReading> = {}): RrdReading => ({
    ...base, state: 'not read', words: `not read by the Rerun CLI: ${u.why}`, cli, verify: u, entities: u, timelines: u, calls, at: new Date().toISOString(), ...extra,
  });
  const found = findRerun(o.env);
  if (!found.ok) return notRead(unknown('not-installed', found.why), { version: null, line: null, via: null, checked: RRD_CLI_CHECKED }, { setup: found.setup });
  const env = rrdCliEnv(o.env);
  const call = async (args: string[], input: Buffer | null, version: string | null): Promise<Ran> => {
    const r = await runOnce(found.command, args, { input, sha256, env, timeoutMs, max, version });
    calls.push(r.call);
    try { o.onCall?.(r.call); } catch { /* the log is the caller's */ }
    return r;
  };

  // the version: asked once per program (the caller keeps it), and only a checked one is read further
  let line = o.known?.line ?? null;
  if (line === null) {
    const v = await call(['--version'], null, null);
    const fault = faultOf(v, 'rerun --version', { timeoutMs, max });
    if (fault) return notRead(unknown(fault.reason, fault.why), { version: null, line: null, via: found.via, checked: RRD_CLI_CHECKED });
    line = textOf(v.stdout).split('\n')[0].trim().slice(0, 512);
  }
  const version = versionOf(line);
  const cli = { version, line, via: found.via, checked: RRD_CLI_CHECKED };
  if (!version) return { ...notRead(unknown('does-not-parse', `its version line says no version Timmy reads ("${line.slice(0, 120)}"), so it ran nothing more`), cli) };
  if (!RRD_CLI_CHECKED.includes(version)) {
    const checked = RRD_CLI_CHECKED.map((x) => `rerun-cli ${x}`).join(' or ');
    return notRead(unknown('version-not-checked', `rerun-cli ${version} is installed here, and Timmy reads only the output of ${checked} (the version its reading was checked against), so it ran nothing more`), cli);
  }
  const done = (verify: RrdVerify, entities: RrdReading['entities'], timelines: RrdReading['timelines']): RrdReading => ({
    ...base, state: 'read', words: wordsOf(version, entities, timelines, verify), cli, verify, entities, timelines, calls, at: new Date().toISOString(),
  });

  // Rerun's own check first: nothing else is read of a file it cannot load
  const v = await call(['rrd', 'verify'], body, version);
  const vf = faultOf(v, 'rrd verify', { timeoutMs, max });
  if (vf && vf.reason !== 'failed') { const u = unknown(vf.reason, `not read: ${vf.short}, so nothing more was run`); return done(unknown(vf.reason, vf.why), u, u); }
  if (vf) {
    const u = unknown('verify-failed', 'not read: Rerun\'s own check of the file failed (rrd verify), so its stats and print were not run');
    return done({ state: 'failed', why: vf.why, by: 'rrd verify' }, u, u);
  }
  const said = saidOf(v.stderr);
  const verify: RrdVerify = { state: 'passed', words: `rrd verify: ${said || 'exit 0'}`, by: 'rrd verify' };

  // the entities and the timelines' names
  const s = await call(['rrd', 'stats'], body, version);
  const sf = faultOf(s, 'rrd stats', { timeoutMs, max });
  if (sf) { const u = unknown(sf.reason, sf.why); return done(verify, u, u); }
  const stats = parseStats(textOf(s.stdout));
  if ('error' in stats) { const u = unknown('does-not-parse', `rrd stats' output does not parse as rerun-cli ${version}'s: ${stats.error}`); return done(verify, u, u); }

  // the timelines' kinds and the static entities, from the chunks' headers
  const h = await call(['rrd', 'print', '-vv'], body, version);
  const hf = faultOf(h, 'rrd print -vv', { timeoutMs, max });
  const chunksOf = (r: Ran, name: string, data: boolean): PrintedChunk[] | RrdUnknown => {
    const p = parsePrint(textOf(r.stdout), data);
    const bad = 'error' in p ? p.error : p.chunks.length !== stats.chunks ? `it printed ${p.chunks.length} chunks, and rrd stats counted ${stats.chunks}` : null;
    if (bad !== null || 'error' in p) return unknown('does-not-parse', `${possessive(name)} output does not parse as rerun-cli ${version}'s: ${bad}`);
    return p.chunks;
  };
  let headers: PrintedChunk[] | RrdUnknown = hf ? unknown(hf.reason, hf.why) : chunksOf(h, 'rrd print -vv', false);
  const typesOf = new Map<string, Set<string>>();
  if (Array.isArray(headers)) for (const c of headers) for (const x of c.indexes) { const t = typesOf.get(x.name) ?? new Set<string>(); t.add(x.type); typesOf.set(x.name, t); }
  const kindOf = (name: string): RrdTimeline['kind'] => {
    if (!Array.isArray(headers)) return headers;
    const types = [...(typesOf.get(name) ?? [])];
    if (types.length !== 1) return unknown('does-not-parse', types.length ? `rrd print -vv shows its column with ${types.length} types (${types.join(', ')})` : 'rrd print -vv shows no column of it');
    return { state: 'read', kind: KINDS[types[0]] ?? 'other', type: types[0], by: 'rrd print -vv' };
  };
  const unlisted = Array.isArray(headers) ? [...typesOf.keys()].find((n) => !stats.timelines.some((t) => t.name === n)) : undefined;
  if (unlisted !== undefined) headers = unknown('does-not-parse', `rrd print -vv shows a timeline rrd stats does not list ("${unlisted}")`);
  const staticOf: RrdEntities['static'] = Array.isArray(headers)
    ? { state: 'read', paths: stats.entities.filter((e) => (headers as PrintedChunk[]).some((c) => c.entity === e && c.indexes.length === 0)), by: 'rrd print -vv' }
    : headers;

  // each timeline's range, from every row's values: only on a small enough recording, and only with the kinds read
  let ranges: Map<string, string[]> | RrdUnknown;
  if (!Array.isArray(headers)) ranges = headers;
  else if (body.length > dataMax) ranges = unknown('not-run', `not read: rrd print -vvv prints the data itself, and is run here only on a recording of at most ${bytesWords(dataMax)} (this one is ${bytesWords(body.length)})`);
  else {
    const d = await call(['rrd', 'print', '-vvv'], body, version);
    const df = faultOf(d, 'rrd print -vvv', { timeoutMs, max });
    const printed = df ? unknown(df.reason, df.why) : chunksOf(d, 'rrd print -vvv', true);
    if (!Array.isArray(printed)) ranges = printed;
    else {
      const all = new Map<string, string[]>();
      for (const c of printed) c.indexes.forEach((x, n) => { const list = all.get(x.name) ?? []; list.push(...c.values[n]); all.set(x.name, list); });
      ranges = all;
    }
  }

  const list: RrdTimeline[] = stats.timelines.map((t) => {
    const kind = kindOf(t.name);
    const range: RrdTimeline['range'] = kind.state !== 'read' ? kind : ranges instanceof Map ? rangeOf(kind.kind, kind.type, ranges.get(t.name) ?? []) : ranges;
    return { name: t.name, chunks: t.chunks, kind, range };
  });
  const entities: RrdEntities = { state: 'read', count: stats.entities.length, paths: stats.entities, by: 'rrd stats', stores: stats.stores, static: staticOf };
  return done(verify, entities, { state: 'read', by: 'rrd stats', list });
}

// ── kept, and read in the background ─────────────────────────────────────────────

/**
 * R9 (H159): a reading is kept by the bytes' sha256 and the program's version line, so an unchanged recording is not read
 * again; the version line is kept by the program's path and its file's identity (size and times), so it is asked once per
 * program. Readings are made in the background, one at a time (startRrdReading); rrdReadingNow only looks, never runs
 * anything, so it may be asked on a synchronous draw path (the Workbench's) and says "being read" until a reading is done.
 */
interface ProgramSeen { sig: string; line: string | null; failed?: { reading: RrdReading; at: number } }
const programs = new Map<string, ProgramSeen>();
const readings = new Map<string, RrdReading>();
const KEEP_MAX = 200;
/** How long a failed version call is said before it is tried again. */
const VERSION_RETRY_MS = 60_000;

export interface RrdJob {
  /** the project and the recording's path in it, as the list names it */
  root: string;
  rel: string;
  /** the sha256 its bytes had when they were listed: the job reads only those bytes */
  sha256: string;
  env: NodeJS.ProcessEnv;
  /** its bytes now (null: not readable now) */
  read: () => Buffer | null;
  /** each call as it ends; the project's log (logRrdCall) when none is given */
  log?: (call: RrdCall, job: RrdJob) => void;
  /** how long each call may take (RRD_CLI_TIMEOUT_MS when absent) */
  timeoutMs?: number;
}
const queue: RrdJob[] = [];
const asked = new Set<string>();
let pumping: Promise<void> | null = null;

const BEING_READ = 'being read by the Rerun CLI, in the background';
const NOT_YET = 'not read yet: rerun-cli reads it in the background, once tab 6 is served';

function programSig(command: string): string {
  try { const st = statSync(command); return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`; } catch { return ''; }
}
const keep = (key: string, r: RrdReading): void => { if (readings.size >= KEEP_MAX) readings.delete(readings.keys().next().value as string); readings.set(key, r); };
const jobKey = (command: string, sha256: string): string => `${command}\0${sha256}`;
/** A reading that holds one unknown for every fact, for these bytes. */
function holding(state: RrdReading['state'], u: RrdUnknown, sha256: string | null, bytes: number, cli: RrdReading['cli'], words: string): RrdReading {
  return { schema: RRD_CLI_SCHEMA, state, words, sha256, bytes, cli, verify: u, entities: u, timelines: u, calls: [], at: null };
}

/**
 * What is known now of these bytes, without running anything: the CLI not installed, its version not checked (once it was
 * asked), the kept reading, "being read" while a reading is under way, else not read yet.
 */
export function rrdReadingNow(i: { sha256: string; bytes: number; env: NodeJS.ProcessEnv }): RrdReading {
  const found = findRerun(i.env);
  const none = { version: null, line: null, via: null, checked: RRD_CLI_CHECKED };
  if (!found.ok) return { ...holding('not read', unknown('not-installed', found.why), i.sha256, i.bytes, none, `not read by the Rerun CLI: ${found.why}`), setup: found.setup };
  const seen = programs.get(found.command);
  const current = seen && seen.sig === programSig(found.command) ? seen : undefined;
  const cli = { version: current?.line ? versionOf(current.line) : null, line: current?.line ?? null, via: found.via, checked: RRD_CLI_CHECKED };
  if (current?.line) {
    const version = versionOf(current.line);
    if (!version || !RRD_CLI_CHECKED.includes(version)) {
      const why = !version ? `its version line says no version Timmy reads ("${current.line.slice(0, 120)}"), so it ran nothing more`
        : `rerun-cli ${version} is installed here, and Timmy reads only the output of ${RRD_CLI_CHECKED.map((x) => `rerun-cli ${x}`).join(' or ')} (the version its reading was checked against), so it ran nothing more`;
      return holding('not read', unknown(version ? 'version-not-checked' : 'does-not-parse', why), i.sha256, i.bytes, cli, `not read by the Rerun CLI: ${why}`);
    }
    const kept = readings.get(`${i.sha256}\0${current.line}`);
    if (kept) return kept;
  } else if (current?.failed && Date.now() - current.failed.at < VERSION_RETRY_MS) {
    return { ...current.failed.reading, sha256: i.sha256, bytes: i.bytes };
  }
  if (asked.has(jobKey(found.command, i.sha256))) return holding('being read', unknown('being-read', BEING_READ), i.sha256, i.bytes, cli, BEING_READ);
  return holding('not read', unknown('not-run', NOT_YET), i.sha256, i.bytes, cli, NOT_YET);
}

/** A reading that says why these bytes were not given to the CLI at all (Timmy's own header reader found no recording in them, or they were not read). */
export function rrdNotGiven(reason: 'not-a-recording' | 'not-run', why: string, sha256: string | null, bytes: number): RrdReading {
  const words = `not given to the Rerun CLI: ${why}`;
  return holding('not read', unknown(reason, words), sha256, bytes, { version: null, line: null, via: null, checked: RRD_CLI_CHECKED }, words);
}

/** Asks for a reading of a recording's bytes in the background, unless one is kept or under way. Never waits. */
export function startRrdReading(job: RrdJob): void {
  const found = findRerun(job.env);
  if (!found.ok) return;
  const now = rrdReadingNow({ sha256: job.sha256, bytes: 0, env: job.env });
  if (now.state !== 'not read' || now.entities.state !== 'unknown' || now.entities.reason !== 'not-run') return;
  const key = jobKey(found.command, job.sha256);
  if (asked.has(key)) return;
  asked.add(key);
  queue.push(job);
  kick();
}

/** Starts the queue's one reader, unless it runs; a job asked while it was ending is read by the next. */
function kick(): void {
  if (pumping) return;
  pumping = pump().finally(() => { pumping = null; if (queue.length) kick(); });
}

async function pump(): Promise<void> {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const found = findRerun(job.env);
    try { if (found.ok) await readJob(job, found.command); } catch { /* a reading never throws; anything else leaves it not read */ }
    if (found.ok) asked.delete(jobKey(found.command, job.sha256));
  }
}

async function readJob(job: RrdJob, command: string): Promise<void> {
  const sig = programSig(command);
  const seen = programs.get(command);
  const line = seen && seen.sig === sig ? seen.line : null;
  // only the bytes that were listed: changed since, they are left for the next list
  let body: Buffer | null = null;
  try { body = job.read(); } catch { body = null; }
  if (!body || sha256Of(body) !== job.sha256) return;
  const log = job.log ?? ((c: RrdCall, j: RrdJob) => logRrdCall(j.root, j.rel, j.sha256, c));
  const reading = await readRrdWithCli(body, {
    env: job.env, sha256: job.sha256, ...(line ? { known: { line } } : {}), ...(job.timeoutMs ? { timeoutMs: job.timeoutMs } : {}), onCall: (c) => log(c, job),
  });
  if (reading.cli.line) programs.set(command, { sig, line: reading.cli.line });
  else programs.set(command, { sig, line: null, failed: { reading, at: Date.now() } });
  if (reading.state === 'read' && reading.cli.line) keep(`${job.sha256}\0${reading.cli.line}`, reading);
}

/** Resolves once no reading is under way (for tests, and for a job that waits on its readings). */
export async function rrdReadingsIdle(): Promise<void> {
  while (pumping) await pumping;
}

/** Forgets every kept reading and version (tests). */
export function forgetRrdReadings(): void {
  programs.clear();
  readings.clear();
}

/** How a call ended, in a word, as the Logs tab shows it: ok, failed, timed out or cut. */
const statusOf = (c: RrdCall): 'ok' | 'failed' | 'timed out' | 'cut' => (c.timedOut ? 'timed out' : c.cut ? 'cut' : c.error || c.exit !== 0 ? 'failed' : 'ok');
/** A call in the log's words: "rerun-cli 0.38.1 · rerun rrd stats · rec/probe.rrd · exit 0 · 48 ms · 3.0 KB read · not cut". */
export function rrdCallWords(c: RrdCall, rel: string): string {
  const end = c.error ? `not started (${c.error})`
    : c.exit !== null && !c.timedOut ? `exit ${c.exit}`
      : `no exit: stopped after ${c.ms} ms (${c.timedOut ? 'no answer in time; its process group was killed' : c.cut ? 'over the cap' : `by ${c.signal ?? 'no signal'}`})`;
  return [c.version ? `rerun-cli ${c.version}` : null, c.command, rel, end, ...(c.exit !== null && !c.timedOut ? [`${c.ms} ms`] : []), `${bytesWords(c.bytes)} read`, c.cut ? 'cut there (over the cap)' : 'not cut']
    .filter(Boolean).join(' · ');
}

/**
 * One call in the project's log: an "rrd.cli" event on the bus of the store this project's receipts go to (TIMMY_STORE, else
 * the project's own), as src/workbench/logs-tab.ts reads it. Never throws: a log that cannot be written leaves the reading as
 * it is.
 */
export function logRrdCall(root: string, rel: string, sha256: string, c: RrdCall): void {
  try {
    const payload = {
      words: rrdCallWords(c, rel), command: c.command, version: c.version, path: rel, sha256, exit: c.exit, signal: c.signal, at: c.at, ms: c.ms,
      bytes: c.bytes, cut: c.cut, timed_out: c.timedOut, ...(c.error ? { error: c.error } : {}), status: statusOf(c), project_id: projectId(root),
    };
    if (process.env.TIMMY_STORE) publish('rrd.cli', payload);
    else publish('rrd.cli', payload, root);
  } catch { /* the reading stands without its log line */ }
}
