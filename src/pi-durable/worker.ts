/**
 * Pi Durable, slice S1 (R4 H118): the Pi worker process (plan b.1.2), one per project, started detached by the
 * supervisor (supervisor.ts), never by hand in normal use:
 *
 *   node <entry> --project <root> [--worker-dir <dir>] [--on-exit pause|keep-working] [--idle-ms N]
 *                [--lease-grace-ms N] [--allow-trial-shell]
 *
 * Its life, in order:
 * 1. Pins: it reads the installed versions and refuses to start on a mismatch, naming the package and both versions
 *    (exit 4), before it loads any of them.
 * 2. The store: its own connection with an exclusive lock (store.ts). Another live owner: "database is locked", and it
 *    exits 3 naming that owner's pid (the supervisor that started it then attaches to the owner).
 * 3. Reconciliation, before anything is scheduled (reconcile.ts): every effect the ledger shows started and never ended
 *    is read back and ended, or marked unknown (NEEDS YOU).
 * 4. The Harness opens with Timmy's tools and guard (S1: slow_read, slow_write, and trial_shell when allowed; the guard
 *    hooks) and the FAKE model of each run. When the store holds live work (a run the last worker did not finish), the
 *    worker stays PAUSED: nothing runs until the operator's Resume. pi-durable starts scheduling on resume(), submit(),
 *    wait() and Conversation.abort(), so a paused worker calls none of them; a Stop while paused commits the abort mark
 *    with abortTask (plan b.3; S1's test settled that it does not settle the run before Resume).
 * 5. It publishes worker.json and its token (owner.ts) and answers on its socket (protocol.ts, frozen as version 1).
 *
 * Leases and Timmy's exit (plan b.2, b.3): every authenticated connection is a lease. When the last one ends (Timmy
 * exited, or crashed: its connection closes; a lease whose process is proven gone is dropped too) and none comes back
 * within --lease-grace-ms (default 15 s), the worker acts on its exit setting:
 * - `pause` (the default the plan proposes; the operator has NOT decided it): it stops admitting work, closes the
 *   Harness (pi-durable seals admission, settles admitted commits and interrupts invocations in flight), records `paused`
 *   on each live run, withdraws its owner record and exits 0. `shutdown`, SIGTERM and SIGINT do the same at once.
 * - `keep-working`: it goes on until its work is idle, then exits after --idle-ms (default 10 minutes) with no live
 *   work and no lease. It is never restarted without Timmy.
 * A SIGKILL leaves the store as committed; the next worker starts paused and shows those runs interrupted.
 *
 * The model is FAKE everywhere in S1 (pi-ai's scripted faux provider; faux.ts): no network, no key, no cost.
 */
import { appendFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { THIS_PROCESS, writerState } from '../ops/process-proof.js';
import { loadPi, type EntryRecord, type Harness, type LockedStorage, type PiApi, type PiEventStream, type SubmissionRecord } from './adapter/pi-api.js';
import { costWords } from './cost.js';
import { EffectLedger, type EffectRecord } from './effects.js';
import { checkScript, fauxAnswer } from './faux.js';
import { guardHooks } from './guard.js';
import { newToken, ownerState, publishOwner, readOwner, sha256Hex, updateOwner, withdrawOwner } from './owner.js';
import { defaultWorkerDir, piPaths, STORE_REL, type PiPaths } from './paths.js';
import { checkPins } from './pins.js';
import {
  MAX_ARGUMENT_CHARS, MAX_EVENTS_WAIT_MS, MAX_TEXT_CHARS, MAX_TOOL_CALLS, MIN_PAGE_BYTES, PAGE_BYTES, PROTOCOL_VERSION, serve, STATUS_EFFECTS_BYTES,
  type AnswerDecision, type AnswerResult, type EventsResult, type HelloResult, type MessageResult, type Method, type OnExit, type Peer, type PiServer,
  type RunWords, type StatusResult, type StopResult, type TranscriptEntry, type TranscriptResult, type WorkerSetting,
} from './protocol.js';
import { reconcileOpen } from './reconcile.js';
import { eventsPath, lastSubmission, listRuns, openNeedsYou, readRun, RUN_SCHEMA, writeRun, type RunFile } from './runs.js';
import { slowTools } from './slow-tools.js';
import { openExclusive, StoreLocked } from './store.js';

export { FAKE_COST, IN_FLIGHT_COST } from './cost.js';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, OWNED: 3, PINS: 4 } as const;

export const DEFAULT_SETTING: WorkerSetting = Object.freeze({ on_exit: 'pause', idle_ms: 600_000, lease_grace_ms: 15_000, trial_shell: false });
/** How often the worker looks at its leases and its idleness. */
export const TICK_MS = 250;
/** A single event bigger than this is kept as its type and size only. */
export const MAX_EVENT_BYTES = 16_384;
/** At its exit the worker ends every connection and waits for them this long at most (fix S3). */
export const CLOSE_WAIT_MS = 2000;
export const SHUTTING_DOWN = 'the Pi worker is shutting down: attach again in a moment (a new worker starts when one is needed)';

/**
 * Node 22 prints an ExperimentalWarning when node:sqlite loads. The worker drops that one warning (every other warning
 * still prints). It must run before node:sqlite is first loaded: store.ts and the adapter load it later, on purpose.
 */
export function quietSqliteWarning(): void {
  const original = process.emitWarning.bind(process) as (...a: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const opt = rest[0];
    const type = typeof opt === 'string' ? opt : (opt as { type?: string } | undefined)?.type;
    const name = typeof warning === 'string' ? type : warning?.name;
    const text = typeof warning === 'string' ? warning : warning?.message;
    if ((name === 'ExperimentalWarning' || type === 'ExperimentalWarning') && /SQLite/i.test(String(text))) return;
    original(warning, ...rest);
  }) as typeof process.emitWarning;
}

export interface WorkerArgs { project: string; workerDir?: string; setting: WorkerSetting }

export function parseArgs(argv: string[]): WorkerArgs | { error: string } {
  let project: string | undefined;
  let workerDir: string | undefined;
  let onExit: OnExit = DEFAULT_SETTING.on_exit;
  let idle = DEFAULT_SETTING.idle_ms;
  let grace = DEFAULT_SETTING.lease_grace_ms;
  let trial = false;
  const ms = (v: string | undefined, name: string): number | { error: string } => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 86_400_000 ? n : { error: `${name} takes milliseconds (0 to 86400000)` };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') project = argv[++i];
    else if (a === '--worker-dir') workerDir = argv[++i];
    else if (a === '--on-exit') {
      const v = argv[++i];
      if (v !== 'pause' && v !== 'keep-working') return { error: '--on-exit takes pause or keep-working' };
      onExit = v;
    } else if (a === '--idle-ms') { const n = ms(argv[++i], a); if (typeof n !== 'number') return n; idle = n; }
    else if (a === '--lease-grace-ms') { const n = ms(argv[++i], a); if (typeof n !== 'number') return n; grace = n; }
    else if (a === '--allow-trial-shell') trial = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (!project) return { error: 'usage: worker --project <root> [--worker-dir <dir>] [--on-exit pause|keep-working] [--idle-ms N] [--lease-grace-ms N] [--allow-trial-shell]' };
  return { project, workerDir, setting: { on_exit: onExit, idle_ms: idle, lease_grace_ms: grace, trial_shell: trial } };
}

/** The text blocks of a model message's content. */
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : JSON.stringify(c))).join('');
  return JSON.stringify(content ?? '');
};
const textBlocks = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'text').map((c) => String((c as { text?: unknown }).text ?? '')).join('');
};
const toolCalls = (content: unknown): TranscriptEntry['tool_calls'] => (Array.isArray(content)
  ? content.filter((c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'toolCall')
    .map((c) => { const t = c as { id?: unknown; name?: unknown; arguments?: unknown }; return { id: String(t.id ?? ''), name: String(t.name ?? ''), arguments: t.arguments ?? null }; })
  : []);
const count = (n: number): string => n.toLocaleString('en-US');
/** The bytes a value takes in an answer line. */
const jsonBytes = (x: unknown): number => Buffer.byteLength(JSON.stringify(x) ?? 'null') + 1;

/** A conversation entry as the protocol carries it: long text, errors, arguments and call lists cut, with words (fix S2). */
function transcriptEntry(e: EntryRecord): TranscriptEntry {
  const m = e.model?.[0];
  const text = textBlocks(m?.content);
  const error = m?.errorMessage ?? null;
  const calls = toolCalls(m?.content);
  const shown = calls.slice(0, MAX_TOOL_CALLS).map((c) => {
    const json = JSON.stringify(c.arguments) ?? 'null';
    return json.length <= MAX_ARGUMENT_CHARS ? c
      : { ...c, arguments: json.slice(0, MAX_ARGUMENT_CHARS), arguments_cut: `its arguments are ${count(json.length)} characters as JSON: \`arguments\` holds their first ${count(MAX_ARGUMENT_CHARS)}, as text` };
  });
  return {
    id: e.id, kind: e.kind, by_task: e.byTaskId ?? null, role: m?.role ?? null, stop: m?.stopReason ?? null,
    text: text.slice(0, MAX_TEXT_CHARS), ...(text.length > MAX_TEXT_CHARS ? { text_cut: `its text is ${count(text.length)} characters: the first ${count(MAX_TEXT_CHARS)} are shown` } : {}),
    tool_calls: shown, ...(calls.length > MAX_TOOL_CALLS ? { tool_calls_cut: `it has ${count(calls.length)} tool calls: the first ${MAX_TOOL_CALLS} are shown` } : {}),
    error: error === null ? null : error.slice(0, MAX_TEXT_CHARS), ...(error !== null && error.length > MAX_TEXT_CHARS ? { error_cut: `its error is ${count(error.length)} characters: the first ${count(MAX_TEXT_CHARS)} are shown` } : {}),
  };
}

const compactEvent = (e: Record<string, unknown>): Record<string, unknown> => {
  if (e.type === 'snapshot') return { type: 'snapshot', entries: Array.isArray(e.entries) ? e.entries.length : null };
  const json = JSON.stringify(e);
  return json.length <= MAX_EVENT_BYTES ? e : { type: e.type, truncated: true, bytes: json.length };
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : fallback;
};

class Worker {
  private pi!: PiApi;
  private harness!: Harness;
  private locked!: LockedStorage;
  private models!: ReturnType<PiApi['models']>;
  private registry: unknown;
  private server?: PiServer;
  private ledger: EffectLedger;
  scheduling: 'paused' | 'running' = 'paused';
  private closing = false;
  private readonly convToRun = new Map<number, string>();
  private readonly refusedConversations = new Set<number>();
  private readonly following = new Set<string>();
  private readonly faux = new Set<string>();
  private line: Promise<unknown> = Promise.resolve();
  // leases (plan b.2): one per authenticated connection
  private readonly leases = new Map<number, { peer: Peer; end: () => void }>();
  /** when the last lease ended: null while a lease is held, and before the socket listens (fix S8: the clocks start then) */
  private noLeasesSince: number | null = null;
  private lastBusy = 0;
  private ticking = false;
  private ticks = 0;
  private timer?: NodeJS.Timeout;
  // events: one pi-durable event stream per run, written to the run's events file
  private readonly streams = new Map<string, PiEventStream>();
  private readonly eventCount = new Map<string, number>();
  private readonly eventWaiters = new Map<string, Set<() => void>>();

  constructor(private readonly paths: PiPaths, private readonly workerDir: string, private readonly pins: Record<string, string>, private readonly raw: DatabaseSync, readonly setting: WorkerSetting) {
    this.ledger = new EffectLedger(paths.effects);
  }

  log(words: string): void { process.stdout.write(`${new Date().toISOString()} pi-worker pid ${process.pid}: ${words}\n`); }

  /** Runs `fn` after every earlier serialized call (delegations, messages, answers, pause, resume): one at a time. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.line.then(fn, fn);
    this.line = next.catch(() => undefined);
    return next;
  }

  private get C() { return this.pi.C; }

  async start(): Promise<void> {
    this.pi = await loadPi(this.workerDir);
    // 3. reconcile before anything is scheduled
    for (const r of reconcileOpen(this.ledger, this.paths.root)) {
      this.log(`reconciled ${r.key}: ${r.state} (${r.outcome})`);
      if (r.state === 'unknown') this.addNeedsYou(r.run, r.key, r.outcome);
    }
    this.locked = this.pi.lockedStorage(this.raw);
    this.models = this.pi.models();
    for (const run of listRuns(this.paths)) this.registerFaux(run);
    const host = { root: this.paths.root, ledger: this.ledger, runOf: (c: number) => this.convToRun.get(c) };
    this.registry = this.pi.registry('timmy-pi-s1', slowTools(this.pi, { ...host, readsLog: join(this.paths.dir, 'reads.jsonl'), trialShell: this.setting.trial_shell, needsYou: (run, key, why) => this.addNeedsYou(run, key, why) }), guardHooks({
      ...host,
      refused: (run, conversationId, key, _open, words) => this.onRefused(run, conversationId, key, words),
      wasRefused: (c) => this.refusedConversations.has(c),
    }));
    await this.openHarness();
    // the store's run index (written in each conversation's creating commit) is the authority for run → conversation
    const index = (await this.harness.snapshot(this.pi.runIndex, this.C)) as { runs?: Record<string, number> } | undefined;
    for (const [run, conversation] of Object.entries(index?.runs ?? {})) {
      this.convToRun.set(conversation, run);
      const r = readRun(this.paths, run);
      if (r && r.conversation === undefined) { r.conversation = conversation; writeRun(this.paths, r); }
    }
    const inspection = await this.harness.inspect(this.C);
    const live = new Set<number>([...inspection.tasks.map((t) => t.record.conversationId), ...inspection.submissions.map((s) => s.conversationId)]);
    for (const t of inspection.tasks) {
      // spike G: a generation stopped in its request phase sends that request again, and its first cost is never recorded
      if (t.record.kind === 'pi.generation' && t.record.state.checkpoint?.phase === 'request') this.patchRun(this.convToRun.get(t.record.conversationId), (r) => { r.cost_unknown = 'in flight'; });
    }
    if (live.size) {
      this.scheduling = 'paused';
      const at = new Date().toISOString();
      for (const c of live) this.patchRun(this.convToRun.get(c), (r) => { if (!r.paused) r.interrupted = { why: 'the worker ended without pausing it (a crash, a kill or a power-off); Resume continues from its last checkpoint', at }; });
      this.log(`opened ${STORE_REL} PAUSED: ${live.size} conversation(s) hold live work; nothing runs until Resume`);
    } else {
      this.harness.resume();
      this.scheduling = 'running';
      this.log(`opened ${STORE_REL}: no live work`);
    }
    for (const r of listRuns(this.paths)) if (!r.ended && r.conversation !== undefined) await this.attachEvents(r.run);
    const token = newToken();
    this.server = await serve(this.paths.socket, sha256Hex(token), (m, p, peer) => this.handle(m, p, peer), () => this.hello(), {
      opened: (peer, end) => {
        this.leases.set(peer.id, { peer, end });
        this.noLeasesSince = null;
        this.log(`lease ${peer.id} began: ${peer.surface ?? 'a client'} (pid ${peer.pid ?? 'not given'})`);
      },
      closed: (peer) => {
        if (!this.leases.delete(peer.id)) return;
        this.log(`lease ${peer.id} ended (${this.leases.size} left)`);
        if (this.leases.size === 0) this.noLeasesSince = Date.now();
      },
    });
    // the clocks of Timmy's exit and of idleness start now that the socket listens (fix S8), not when the process began:
    // loading the pinned packages and opening the Harness must not use up a supervisor's time to attach
    const listening = Date.now();
    this.noLeasesSince = this.leases.size ? null : listening;
    this.lastBusy = listening;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    publishOwner(this.paths, token, {
      project_id: this.paths.projectId, store: STORE_REL, socket: this.paths.socket, pins: this.pins, node: process.version, scheduling: this.scheduling,
      setting: this.setting,
    });
    process.on('SIGTERM', () => { void this.shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void this.shutdown('SIGINT'); });
    this.log(`ready on its socket (protocol ${PROTOCOL_VERSION}), scheduling ${this.scheduling}; on exit: ${this.setting.on_exit} (lease grace ${this.setting.lease_grace_ms} ms, idle exit ${this.setting.idle_ms} ms)${this.setting.trial_shell ? '; trial_shell offered' : ''}`);
  }

  private async openHarness(): Promise<void> {
    this.harness = await this.pi.open(await this.locked.storage(), { models: this.models.models, registry: this.registry, onReport: (e) => this.log(`pi-durable reported: ${e instanceof Error ? e.message : String(e)}`) });
  }

  private registerFaux(r: RunFile): void {
    if (this.faux.has(r.run)) return;
    this.faux.add(r.run);
    const script = r.model.script;
    this.models.addFaux(r.model.provider, {
      tokensPerSecond: script.tokens_per_second,
      answer: (seen) => fauxAnswer(script, seen),
      onCall: (n, seen) => appendFileSync(this.paths.fauxCalls, `${JSON.stringify({ run: r.run, n, last_role: seen?.role ?? null, last_text: seen?.text.slice(0, 200) ?? null, pid: process.pid, at: new Date().toISOString(), fake: true })}\n`, { mode: 0o600 }),
    });
  }

  private patchRun(run: string | undefined, change: (r: RunFile) => void): void {
    if (!run) return;
    const r = readRun(this.paths, run);
    if (!r) return;
    change(r);
    writeRun(this.paths, r);
  }

  private addNeedsYou(run: string, key: string, why: string): void {
    this.patchRun(run, (r) => { r.needs_you = [...(r.needs_you ?? []), { key, why, at: new Date().toISOString() }]; });
  }

  // ── leases, Timmy's exit, idleness ────────────────────────────────────────────────────────────

  private async hasLiveWork(): Promise<boolean> {
    const i = await this.harness.inspect(this.C);
    return i.tasks.length > 0 || i.submissions.length > 0;
  }

  /** Every TICK_MS: drops leases whose process is proven gone, and acts on Timmy's exit and on idleness. */
  private async tick(): Promise<void> {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      if (++this.ticks % 8 === 0) {
        for (const { peer, end } of [...this.leases.values()]) {
          if (peer.pid !== undefined && peer.started && writerState({ pid: peer.pid, started: peer.started }) === 'gone') {
            this.log(`lease ${peer.id}: its process (pid ${peer.pid}) is gone`);
            end();
          }
        }
      }
      if (this.leases.size > 0 || this.noLeasesSince === null) return;
      const away = now - this.noLeasesSince;
      if (this.setting.on_exit === 'pause') {
        if (away >= this.setting.lease_grace_ms) await this.shutdown(`no Timmy process has been attached for ${this.setting.lease_grace_ms} ms`);
        return;
      }
      // keep working: a running worker with live work goes on; with none (or paused: nothing can move) it exits when idle
      if (this.scheduling === 'running' && await this.hasLiveWork()) { this.lastBusy = now; return; }
      if (now - Math.max(this.noLeasesSince, this.lastBusy) >= this.setting.idle_ms) await this.shutdown(`idle: no live work and no Timmy process attached for ${this.setting.idle_ms} ms`);
    } catch (e) { this.log(`tick: ${e instanceof Error ? e.message : String(e)}`); } finally { this.ticking = false; }
  }

  // ── events ────────────────────────────────────────────────────────────────────────────────────

  /** Attaches pi-durable's event stream of a run's conversation (a read-only viewer), writing each event to its file. */
  private async attachEvents(run: string): Promise<void> {
    if (this.streams.has(run) || this.closing) return;
    const r = readRun(this.paths, run);
    if (r?.conversation === undefined) return;
    let stream: PiEventStream;
    try { stream = await this.pi.events(this.harness, r.conversation); } catch (e) { this.log(`events of run ${run}: ${e instanceof Error ? e.message : String(e)}`); return; }
    if (this.streams.has(run)) { void stream.stop().catch(() => undefined); return; }
    this.streams.set(run, stream);
    this.appendEvent(run, { type: 'attached', worker: process.pid, entries: stream.snapshot.entries?.length ?? null, scheduling: this.scheduling });
    stream.start(async (events) => { for (const e of events) this.appendEvent(run, compactEvent(e)); });
  }

  private appendEvent(run: string, event: Record<string, unknown>): void {
    const file = eventsPath(this.paths, run);
    let n = this.eventCount.get(run);
    if (n === undefined) {
      try { n = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { n = 0; }
    }
    n += 1;
    this.eventCount.set(run, n);
    appendFileSync(file, `${JSON.stringify({ n, at: new Date().toISOString(), event })}\n`, { mode: 0o600 });
    const waiting = this.eventWaiters.get(run);
    this.eventWaiters.delete(run);
    for (const w of waiting ?? []) w();
  }

  private async detachEvents(): Promise<void> {
    const all = [...this.streams.values()];
    this.streams.clear();
    await Promise.all(all.map((s) => s.stop().catch(() => undefined)));
  }

  /** The run's events after `after`: at most `limit`, and a page under `maxBytes` (at least one event) (fix S2). */
  private readEvents(run: string, after: number, limit: number, maxBytes: number): { events: EventsResult['events']; more: boolean } {
    let lines: string[] = [];
    try { lines = readFileSync(eventsPath(this.paths, run), 'utf8').split('\n').filter((l) => l.trim()); } catch { lines = []; }
    const page: EventsResult['events'] = [];
    let bytes = 0;
    for (const l of lines) {
      let e: EventsResult['events'][number];
      try { e = JSON.parse(l) as EventsResult['events'][number]; } catch { continue; /* a line cut by a kill */ }
      if (!(e.n > after)) continue;
      if (page.length >= limit) return { events: page, more: true };
      let size = jsonBytes(e);
      // an event too big for any page (written before events were compacted, or by hand) is given as its type and size
      if (size > maxBytes) { e = { n: e.n, at: e.at, event: { type: e.event?.type ?? null, truncated: true, bytes: size } }; size = jsonBytes(e); }
      if (page.length && bytes + size > maxBytes) return { events: page, more: true };
      page.push(e);
      bytes += size;
    }
    return { events: page, more: false };
  }

  private async events(params: Record<string, unknown>): Promise<EventsResult> {
    const run = String(params.run ?? '');
    if (!readRun(this.paths, run)) throw new Error(`no Pi run ${run} in this project`);
    const after = clampInt(params.after, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clampInt(params.limit, 1, 1000, 200);
    const maxBytes = clampInt(params.max_bytes, MIN_PAGE_BYTES, PAGE_BYTES, PAGE_BYTES);
    const waitMs = clampInt(params.wait_ms, 0, MAX_EVENTS_WAIT_MS, 0);
    let got = this.readEvents(run, after, limit, maxBytes);
    if (!got.events.length && waitMs > 0 && !this.closing) {
      await new Promise<void>((done) => {
        const set = this.eventWaiters.get(run) ?? new Set<() => void>();
        this.eventWaiters.set(run, set);
        const finish = (): void => { clearTimeout(t); set.delete(finish); done(); };
        const t = setTimeout(finish, waitMs);
        set.add(finish);
      });
      got = this.readEvents(run, after, limit, maxBytes);
    }
    return { run, events: got.events, next: got.events.at(-1)?.n ?? after, more: got.more };
  }

  // ── refusals and stopping ─────────────────────────────────────────────────────────────────────

  /** The guard's first refusal in a run: NEEDS YOU, then the host abort, asked for after the hook has returned (spike A2). */
  private onRefused(run: string, conversationId: number, key: string, words: string): void {
    const first = !this.refusedConversations.has(conversationId);
    this.refusedConversations.add(conversationId);
    this.addNeedsYou(run, key, words);
    this.log(`refused a call in run ${run} (${key}): ${words}`);
    if (first) setImmediate(() => { void this.abortRun(run).then((how) => this.log(`run ${run} stopped at its first NEEDS YOU refusal (${how})`), (e: unknown) => this.log(`run ${run}: the abort after a refusal failed: ${String(e)}`)); });
  }

  /**
   * Stops a run's current work. Running: Conversation.abort(), which resolves once the run is idle (a tool that ignores
   * its signal is waited for: spike D2). Paused: abortTask on each live task of its conversation, which commits the
   * durable abort mark without starting the scheduler (the abort itself then runs first at Resume), and its queued
   * submissions are withdrawn. (pi-durable also marks the work a marked task owns: the extra marks are redundant.)
   */
  private async abortRun(run: string): Promise<string> {
    const r = readRun(this.paths, run);
    if (r?.conversation === undefined) return 'nothing to abort: no conversation yet';
    if (this.scheduling === 'running') {
      const conv = await this.harness.conversation(r.conversation, this.C);
      await conv?.abort(this.C);
      return 'aborted (Conversation.abort resolved: the run is idle)';
    }
    const inspection = await this.harness.inspect(this.C);
    const marks: string[] = [];
    const mine = inspection.tasks.filter((t) => t.record.conversationId === r.conversation).sort((x, y) => (x.record.owner === undefined ? 0 : 1) - (y.record.owner === undefined ? 0 : 1));
    for (const t of mine) marks.push(`task ${t.record.id} (${t.record.kind}) ${await this.harness.abortTask(t.record.id, this.C)}`);
    for (const s of inspection.submissions) {
      if (s.conversationId === r.conversation && s.status === 'queued') marks.push(`submission ${s.id} ${await this.harness.abortSubmission(s.id, this.C, r.conversation)}`);
    }
    return marks.length ? `abort marked while paused: ${marks.join(', ')}` : 'nothing live to abort';
  }

  // ── run records and words ─────────────────────────────────────────────────────────────────────

  /** The record of the run's newest submission (the one its words describe). */
  private async submissionOf(r: RunFile): Promise<SubmissionRecord | undefined> {
    const id = lastSubmission(r);
    if (id !== undefined) return (await this.harness.submission(id, this.C))?.status(this.C);
    if (r.conversation === undefined) return undefined;
    const conversation = r.conversation;
    return this.harness.commit((tx) => tx.submissionByRequest(conversation, r.request_id), this.C);
  }

  /** Timmy's words for a run (plan g): from Timmy's own records first, then the store's submission. */
  private words(r: RunFile, s: SubmissionRecord | undefined): RunWords {
    if (r.ended) return r.ended.status;
    if (s?.status === 'done') return 'completed';
    if (s?.status === 'unanswered') return s.reason === 'aborted' ? ((openNeedsYou(r) ?? []).length && !r.stop_requested ? 'needs you' : 'cancelled') : 'failed';
    if (!s) return r.conversation === undefined ? 'queued' : 'unknown';
    if (this.scheduling === 'paused') return r.interrupted ? 'interrupted' : 'paused';
    if ((openNeedsYou(r) ?? []).length) return 'needs you';
    return s.status === 'queued' ? 'queued' : 'running';
  }

  private recordEnd(run: string, s: SubmissionRecord): void {
    this.patchRun(run, (r) => {
      if (r.ended || lastSubmission(r) !== s.id) return; // a newer message took over: its own end is followed
      r.ended = { status: this.words({ ...r, ended: null }, s), ...(s.reason ? { reason: s.reason } : {}), at: new Date().toISOString() };
    });
  }

  /** Waits (while scheduling runs) for a run's newest submission to settle, and records how it ended. */
  private follow(run: string): void {
    const r = readRun(this.paths, run);
    const id = r ? lastSubmission(r) : undefined;
    if (!r || r.ended || id === undefined || this.scheduling !== 'running') return;
    const tag = `${run}:${id}`;
    if (this.following.has(tag)) return;
    this.following.add(tag);
    void (async () => {
      try {
        const sub = await this.harness.submission(id, this.C);
        const settled = sub ? await sub.wait(this.C) : undefined;
        if (settled) this.recordEnd(run, settled);
      } catch { /* the Harness closed (a pause or the exit): the run is recorded paused instead */ } finally { this.following.delete(tag); }
    })();
  }

  private async liveRuns(): Promise<RunFile[]> {
    const inspection = await this.harness.inspect(this.C);
    const live = new Set<number>([...inspection.tasks.map((t) => t.record.conversationId), ...inspection.submissions.map((s) => s.conversationId)]);
    return listRuns(this.paths).filter((r) => !r.ended && r.conversation !== undefined && live.has(r.conversation));
  }

  private hello(): HelloResult {
    return {
      protocol: PROTOCOL_VERSION, project_id: this.paths.projectId, store: STORE_REL, pid: THIS_PROCESS.pid, started: THIS_PROCESS.started,
      pins: this.pins, node: process.version, scheduling: this.scheduling, setting: this.setting, leases: this.leases.size,
    };
  }

  private async handle(method: Method, params: Record<string, unknown>, peer: Peer): Promise<unknown> {
    switch (method) {
      case 'hello': return this.hello();
      case 'delegate': return this.delegate(params);
      case 'status': return this.status(String(params.run ?? ''));
      case 'list': return this.list();
      case 'events': return this.events(params);
      case 'stop': return this.stop(String(params.run ?? ''), peer);
      case 'pause': return this.serialize(() => this.pause());
      case 'resume': return this.serialize(() => this.resume());
      case 'answer': return this.serialize(() => this.answer(params, peer));
      case 'message': return this.serialize(() => this.message(params, peer));
      case 'transcript': return this.transcript(params);
      case 'shutdown':
        setImmediate(() => { void this.shutdown(`shutdown asked by ${peer.surface ?? 'a client'}`); });
        return { ok: true, on_exit: 'pause', words: 'the worker pauses its live runs and exits' };
    }
  }

  // ── delegate ──────────────────────────────────────────────────────────────────────────────────

  private delegate(params: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      if (this.closing) return { ok: false, refused: 'the Pi worker is shutting down' };
      const task = typeof params.task === 'string' ? params.task.trim() : '';
      if (!task || task.length > 4000) return { ok: false, refused: 'the task must be 1 to 4,000 characters' };
      const key = params.key === undefined ? undefined : String(params.key);
      if (key !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return { ok: false, refused: 'a key is 1 to 128 letters, digits and . _ : -' };
      const model = (params.model ?? {}) as { route?: unknown; script?: unknown };
      if (model.route !== 'faux') return { ok: false, refused: 'S1 has one model route, the FAKE scripted faux model: model.route must be "faux"' };
      const checked = checkScript(model.script);
      if ('error' in checked) return { ok: false, refused: checked.error };
      if (key !== undefined) {
        const prior = listRuns(this.paths).find((r) => r.key === key);
        if (prior) {
          // plan c.3: the key's run admitted its submission → refused, naming the run; nothing admitted → a retry
          const admitted = await this.submissionOf(prior);
          if (admitted) return { ok: false, refused: `the key ${key} was already used: Pi run ${prior.run} (submission ${admitted.id}, ${admitted.status})`, run: prior.run, submission: admitted.id };
          if (this.scheduling === 'paused') return { ok: false, refused: 'the Pi worker is paused: Resume it first', run: prior.run };
          return this.place(prior);
        }
      }
      if (this.scheduling === 'paused') return { ok: false, refused: 'the Pi worker is paused: Resume it first (its interrupted or paused runs continue then), or Stop them' };
      const run = randomBytes(4).toString('hex');
      const now = new Date().toISOString();
      const r: RunFile = {
        schema: RUN_SCHEMA, run, ...(key !== undefined ? { key } : {}), task, request_id: `timmy:${run}:1`,
        model: { route: 'faux', provider: `faux-${run}`, model: 'faux-1', fake: true, script: checked.script }, created: now, updated: now,
      };
      writeRun(this.paths, r);
      this.registerFaux(r);
      return this.place(r);
    });
  }

  /** Creates the run's conversation (once: the run index says whether it exists) and submits its task with its request id. */
  private async place(r: RunFile): Promise<unknown> {
    const index = (await this.harness.snapshot(this.pi.runIndex, this.C)) as { runs?: Record<string, number> } | undefined;
    let conversation = r.conversation ?? index?.runs?.[r.run];
    if (conversation === undefined) {
      const runIndex = this.pi.runIndex;
      const created = await this.harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: r.model.provider, modelId: 'faux-1' } },
        init: async (tx, id) => { const d = await tx.doc(runIndex); d.runs = { ...((d.runs as Record<string, number> | undefined) ?? {}), [r.run]: id }; },
      }, this.C);
      conversation = created.id;
    }
    this.convToRun.set(conversation, r.run);
    r.conversation = conversation;
    writeRun(this.paths, r);
    await this.attachEvents(r.run);
    const conv = await this.harness.conversation(conversation, this.C);
    if (!conv) throw new Error(`conversation ${conversation} of run ${r.run} is missing from the store`);
    const sub = await conv.submit({ type: 'input', content: r.task, requestId: r.request_id }, this.C);
    r.submission = sub.id;
    if (!r.submissions?.includes(sub.id)) r.submissions = [sub.id, ...(r.submissions ?? [])];
    writeRun(this.paths, r);
    this.follow(r.run);
    this.log(`delegated run ${r.run}: conversation ${conversation}, submission ${sub.id} (${r.request_id}); model FAKE faux-1`);
    return { ok: true, started: true, run: r.run, conversation, submission: sub.id, request_id: r.request_id, model: 'faux-1 (FAKE scripted model)' };
  }

  // ── status, list, transcript ──────────────────────────────────────────────────────────────────

  private async status(run: string): Promise<StatusResult> {
    const r = readRun(this.paths, run);
    if (!r) throw new Error(`no Pi run ${run} in this project`);
    const s = await this.submissionOf(r);
    const inspection = await this.harness.inspect(this.C);
    const tasks = inspection.tasks.filter((t) => t.record.conversationId === r.conversation).map((t) => ({
      id: t.record.id, kind: t.record.kind, status: t.record.state.status, phase: t.record.state.checkpoint?.phase ?? null, owner: t.record.owner ?? null,
      abort_requested: t.record.abortRequested === true, inspect: t.state.kind,
    }));
    const conv = r.conversation === undefined ? undefined : await this.harness.conversation(r.conversation, this.C);
    const entries = conv ? (await conv.entries({ order: 'ascending' }, 500, undefined, this.C)).items.map((e) => ({
      id: e.id, kind: e.kind, stop: e.model?.[0]?.stopReason ?? null, text: textOf(e.model?.[0]?.content).slice(0, 200),
    })) : [];
    // the run's newest effect records that fit (fix S2): the ledger keeps them all
    const all: EffectRecord[] = this.ledger.forRun(run);
    const effects: EffectRecord[] = [];
    let bytes = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const size = jsonBytes(all[i]);
      if (bytes + size > STATUS_EFFECTS_BYTES) break;
      effects.push(all[i]);
      bytes += size;
    }
    effects.reverse();
    const effectsCut = effects.length < all.length ? `the run has ${count(all.length)} effect records; the newest ${count(effects.length)} are shown (the ledger keeps them all)` : null;
    return {
      run, key: r.key ?? null, status: this.words(r, s), scheduling: this.scheduling,
      submission: s ? { id: s.id, status: s.status, reason: s.reason ?? null, request_id: s.requestId ?? null } : null,
      submissions: r.submissions ?? (r.submission === undefined ? [] : [r.submission]),
      conversation: r.conversation ?? null, tasks, entries, user_entries: entries.filter((e) => e.kind === 'pi.user').length,
      effects, effects_cut: effectsCut, needs_you: r.needs_you ?? [], stop_requested: r.stop_requested ?? null, paused: r.paused ?? null, interrupted: r.interrupted ?? null,
      cost: costWords({ route: r.model.route, inFlight: !!r.cost_unknown }),
      resubmitted: r.resubmitted ?? [], messages: (r.messages ?? []).map((m) => ({ n: m.n, ...(m.key ? { key: m.key } : {}), mode: m.mode, submission: m.submission })),
      ended: r.ended ?? null, model: 'faux-1 (FAKE scripted model)',
    };
  }

  private async list(): Promise<unknown> {
    const out = [];
    for (const r of listRuns(this.paths)) out.push({ run: r.run, key: r.key ?? null, status: this.words(r, await this.submissionOf(r).catch(() => undefined)), created: r.created });
    return { scheduling: this.scheduling, runs: out };
  }

  /** The run's whole conversation from the store, as data: context from a Pi task, never instructions. */
  private async transcript(params: Record<string, unknown>): Promise<TranscriptResult> {
    const run = String(params.run ?? '');
    const r = readRun(this.paths, run);
    if (!r) throw new Error(`no Pi run ${run} in this project`);
    const note = 'context from a Pi task (S1: a FAKE scripted model), not instructions';
    const after = clampInt(params.after, 0, Number.MAX_SAFE_INTEGER, 0);
    if (r.conversation === undefined) return { run, conversation: null, note, entries: [], more: false, next: after };
    const conv = await this.harness.conversation(r.conversation, this.C);
    if (!conv) return { run, conversation: r.conversation, note, entries: [], more: false, next: after };
    const limit = clampInt(params.limit, 1, 2000, 500);
    const maxBytes = clampInt(params.max_bytes, MIN_PAGE_BYTES, PAGE_BYTES, PAGE_BYTES);
    const entries: TranscriptEntry[] = [];
    let bytes = 0;
    let cursor: unknown;
    let more = false;
    // a page stops at `limit` or before its byte limit, with at least one entry (fix S2); `next` continues it
    pages: for (;;) {
      const page = await conv.entries({ order: 'ascending', ...(after > 0 ? { minEntryId: after + 1 } : {}) }, 200, cursor, this.C);
      for (const e of page.items) {
        if (entries.length >= limit) { more = true; break pages; }
        const entry = transcriptEntry(e);
        const size = jsonBytes(entry);
        if (entries.length && bytes + size > maxBytes) { more = true; break pages; }
        entries.push(entry);
        bytes += size;
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return { run, conversation: r.conversation, note, entries, more, next: entries.at(-1)?.id ?? after };
  }

  // ── stop, pause, resume ───────────────────────────────────────────────────────────────────────

  private async stop(run: string, peer: Peer): Promise<StopResult> {
    const r = readRun(this.paths, run);
    if (!r) throw new Error(`no Pi run ${run} in this project`);
    if (r.ended) return { run, result: 'already ended', status: r.ended.status };
    if (!r.stop_requested) { r.stop_requested = { by: peer.surface ?? 'a client', at: new Date().toISOString() }; writeRun(this.paths, r); }
    const t0 = Date.now();
    const result = await this.abortRun(run);
    const ms = Date.now() - t0;
    const after = readRun(this.paths, run) ?? r;
    const s = await this.submissionOf(after);
    if (this.scheduling === 'running' && s && (s.status === 'done' || s.status === 'unanswered')) this.recordEnd(run, s);
    const final = readRun(this.paths, run) ?? after;
    return { run, result, ms, scheduling: this.scheduling, status: this.words(final, s) };
  }

  private async pause(): Promise<unknown> {
    if (this.scheduling === 'paused') return { scheduling: 'paused', already: true };
    const live = await this.liveRuns();
    await this.detachEvents();
    await this.harness.close(this.C);
    const at = new Date().toISOString();
    for (const r of live) this.patchRun(r.run, (x) => { x.paused = { why: 'paused by request', at }; });
    await this.openHarness();
    this.scheduling = 'paused';
    updateOwner(this.paths, { scheduling: 'paused' });
    for (const r of listRuns(this.paths)) if (!r.ended && r.conversation !== undefined) await this.attachEvents(r.run);
    this.log(`paused: the Harness was closed and opened again without scheduling (${live.length} live run(s))`);
    return { scheduling: 'paused', runs: live.map((r) => r.run) };
  }

  private async resume(): Promise<unknown> {
    if (this.scheduling === 'running') return { scheduling: 'running', already: true };
    const runs = listRuns(this.paths).filter((r) => !r.ended && r.conversation !== undefined);
    // plan e.3.8: a stop someone asked for is applied again before anything runs (the mark is durable already; this is idempotent)
    for (const r of runs) if (r.stop_requested) this.log(`resume: run ${r.run} has a stop requested: ${await this.abortRun(r.run)}`);
    for (const r of runs) if (r.paused || r.interrupted) this.patchRun(r.run, (x) => { x.paused = null; x.interrupted = null; });
    this.harness.resume();
    this.scheduling = 'running';
    updateOwner(this.paths, { scheduling: 'running' });
    const resumed: { run: string; submission: number; same: boolean; first?: true }[] = [];
    for (const r of runs) {
      // a run whose newest submission is a message continues by itself; only the delegation's request is re-acquired
      if (r.stop_requested || r.conversation === undefined || (r.messages ?? []).length) { this.follow(r.run); continue; }
      const conv = await this.harness.conversation(r.conversation, this.C);
      if (!conv) continue;
      // the same request id after a restart: pi-durable gives back the same submission (spike A1: submission 8 again)
      const sub = await conv.submit({ type: 'input', content: r.task, requestId: r.request_id }, this.C);
      // `first`: its task had never been submitted (a crash between creating its conversation and submitting)
      const first = r.submission === undefined;
      const same = !first && sub.id === r.submission;
      this.patchRun(r.run, (x) => {
        x.resubmitted = [...(x.resubmitted ?? []), { at: new Date().toISOString(), submission: sub.id, same, ...(first ? { first: true as const } : {}) }];
        if (x.submission === undefined) { x.submission = sub.id; x.submissions = [sub.id, ...(x.submissions ?? [])]; }
      });
      resumed.push({ run: r.run, submission: sub.id, same, ...(first ? { first: true as const } : {}) });
      this.follow(r.run);
    }
    this.log(`resumed: scheduling runs (${resumed.length} re-acquired by request id)`);
    return { scheduling: 'running', resumed };
  }

  // ── answer, message ───────────────────────────────────────────────────────────────────────────

  /** A NEEDS YOU decision (plan e.3.5): the first answer wins and is recorded; only it moves the effect on. */
  private async answer(params: Record<string, unknown>, peer: Peer): Promise<AnswerResult> {
    const run = String(params.run ?? '');
    const key = String(params.key ?? '');
    const decision = params.decision as AnswerDecision;
    if (decision !== 'accept' && decision !== 'retry' && decision !== 'stop') return { ok: false, refused: 'decision must be accept, retry or stop' };
    const r = readRun(this.paths, run);
    if (!r) return { ok: false, refused: `no Pi run ${run} in this project` };
    const items = (r.needs_you ?? []).filter((n) => n.key === key);
    if (!items.length) return { ok: false, refused: `run ${run} has no NEEDS YOU for ${key}` };
    const done = items.find((n) => n.answered);
    if (done?.answered) return { ok: false, refused: `already answered: ${done.answered.decision} by ${done.answered.by} at ${done.answered.at}` };
    const by = peer.surface ?? 'a client';
    let ledger: EffectRecord | null = this.ledger.latest().get(key) ?? null;
    let stop: StopResult | undefined;
    if (decision === 'accept' || decision === 'retry') {
      const open = this.ledger.unreconciled(key);
      if (open) {
        ledger = this.ledger.append({
          key, run: open.run, tool: open.tool, target: open.target, ...(open.argv ? { argv: open.argv, output: open.output } : {}),
          state: decision === 'accept' ? 'ended' : 'approved',
          outcome: decision === 'accept' ? `accepted as done by ${by} (it was ${open.state}: ${open.outcome ?? 'no outcome recorded'})` : `a retry was approved by ${by}; the earlier outcome stays ${open.state}`,
          by: 'operator',
        });
      }
      // the run's refusal hold lifts: a later message (or Resume) may continue it
      if (r.conversation !== undefined) this.refusedConversations.delete(r.conversation);
    } else {
      stop = await this.stop(run, peer);
    }
    const at = new Date().toISOString();
    this.patchRun(run, (x) => { x.needs_you = (x.needs_you ?? []).map((n) => (n.key === key && !n.answered ? { ...n, answered: { decision, by, at } } : n)); });
    this.log(`answered NEEDS YOU of run ${run} (${key}): ${decision} by ${by}`);
    return { ok: true, run, key, decision, ledger, ...(stop ? { stop } : {}) };
  }

  /** A steer or a follow-up to a run (plan b.1.5): one submission with request id timmy:<run>:<n>; a used key is refused. */
  private async message(params: Record<string, unknown>, peer: Peer): Promise<MessageResult> {
    const run = String(params.run ?? '');
    const r = readRun(this.paths, run);
    if (!r) return { ok: false, refused: `no Pi run ${run} in this project` };
    const mode = params.mode;
    if (mode !== 'steer' && mode !== 'followUp') return { ok: false, refused: 'mode must be steer or followUp' };
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text || text.length > 4000) return { ok: false, refused: 'the text must be 1 to 4,000 characters' };
    const key = params.key === undefined ? undefined : String(params.key);
    if (key !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return { ok: false, refused: 'a key is 1 to 128 letters, digits and . _ : -' };
    const used = key === undefined ? undefined : (r.messages ?? []).find((m) => m.key === key);
    if (used) return { ok: false, refused: `the key ${key} was already used: message ${used.n} of Pi run ${run} (submission ${used.submission})`, n: used.n, submission: used.submission };
    if (this.closing) return { ok: false, refused: 'the Pi worker is shutting down' };
    if (this.scheduling === 'paused') return { ok: false, refused: 'the Pi worker is paused: Resume it first' };
    if (r.conversation === undefined) return { ok: false, refused: `run ${run} has no conversation yet` };
    const conv = await this.harness.conversation(r.conversation, this.C);
    if (!conv) return { ok: false, refused: `the conversation of run ${run} is missing from the store` };
    await this.attachEvents(run);
    const n = (r.messages ?? []).reduce((m, x) => Math.max(m, x.n), 1) + 1;
    const requestId = `timmy:${run}:${n}`;
    const sub = await conv.submit({ type: 'input', content: text, whenBusy: mode, requestId }, this.C);
    const by = peer.surface ?? 'a client';
    this.patchRun(run, (x) => {
      x.messages = [...(x.messages ?? []), { n, ...(key !== undefined ? { key } : {}), mode, submission: sub.id, by, at: new Date().toISOString() }];
      const all = x.submissions ?? (x.submission === undefined ? [] : [x.submission]);
      x.submissions = all.includes(sub.id) ? all : [...all, sub.id];
      x.ended = null; // the run is live again
      x.stop_requested = null; // a stop applied to the work before this message
    });
    this.follow(run);
    this.log(`message ${n} (${mode}) to run ${run}: submission ${sub.id} (${requestId})`);
    return { ok: true, run, n, submission: sub.id, request_id: requestId, mode };
  }

  // ── exit ──────────────────────────────────────────────────────────────────────────────────────

  /** Pause on exit (the default the plan proposes; not yet the operator's decision). */
  async shutdown(why: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.server?.refuse(SHUTTING_DOWN); // no new lease from here on (fix S3)
    if (this.timer) clearInterval(this.timer);
    this.log(`shutting down (${why}): pause on exit`);
    let live: RunFile[] = [];
    try { live = await this.liveRuns(); } catch { /* the Harness may be closing already */ }
    await this.detachEvents();
    try { await this.harness.close(this.C); } catch (e) { this.log(`closing the Harness: ${String(e)}`); }
    const at = new Date().toISOString();
    for (const r of live) this.patchRun(r.run, (x) => { if (!x.paused && !x.interrupted) x.paused = { why: `Timmy exited (${why})`, at }; });
    for (const waiting of this.eventWaiters.values()) for (const w of waiting) w();
    const closed = this.server ? await this.server.close(CLOSE_WAIT_MS) : 'closed';
    if (closed === 'timed out') this.log(`its connections did not close within ${CLOSE_WAIT_MS} ms: exiting anyway`);
    rmSync(this.paths.socket, { force: true });
    withdrawOwner(this.paths);
    try { await this.locked.closeConnection(); } catch (e) { this.log(`closing the store: ${String(e)}`); }
    this.log(`exited cleanly; ${live.length} live run(s) recorded paused`);
    // the start budget counts only starts that did not end cleanly (fix S4): this one did
    try { appendFileSync(this.paths.starts, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, clean_exit: true })}\n`, { mode: 0o600 }); } catch { /* then this start counts */ }
    process.exit(EXIT.OK);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number | undefined> {
  const a = parseArgs(argv);
  if ('error' in a) { process.stderr.write(`${a.error}\n`); return EXIT.USAGE; }
  const paths = piPaths(a.project);
  const workerDir = a.workerDir ?? defaultWorkerDir();
  const pins = checkPins(workerDir);
  if (!pins.ok) { process.stderr.write(`${pins.words}\n`); return EXIT.PINS; }
  quietSqliteWarning();
  let raw: DatabaseSync;
  try {
    raw = await openExclusive(paths.store);
  } catch (e) {
    if (!(e instanceof StoreLocked)) throw e;
    const owner = readOwner(paths);
    process.stderr.write(`the Pi store ${STORE_REL} is owned by ${owner ? `pid ${owner.pid} (${ownerState(owner)})` : 'another process (its owner record is not written yet)'}: database is locked\n`);
    return EXIT.OWNED;
  }
  const worker = new Worker(paths, workerDir, pins.versions, raw, a.setting);
  process.on('uncaughtException', (e) => { worker.log(`uncaught: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(EXIT.FAILED); });
  process.on('unhandledRejection', (e) => { worker.log(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`); });
  await worker.start();
  return undefined; // the socket keeps the process alive; it exits through shutdown
}

const entry = (): boolean => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (entry()) {
  main().then((code) => { if (code !== undefined) process.exit(code); }, (e: unknown) => {
    process.stderr.write(`the Pi worker failed to start: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(EXIT.FAILED);
  });
}
