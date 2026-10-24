/**
 * R8 (H155): the Control Room's panes on the companion (tab 7; the operator's references 07 and 14), under
 * /api/panel/control/…, behind the companion's token and answering for the project the page shows (?project=<id>, else the
 * one followed). Which runs get a pane, and what each pane says, are src/ops/panes.ts's: the Workbench's tab 7
 * (src/workbench/control-tab.ts) draws from the same source. The page side is src/companion/client/panel-control.js, which
 * draws them read-only. Nothing here starts, stops or changes a run.
 *
 *   route                          answers
 *   GET /api/panel/control/panes   the project's panes (timmy.control-panes/1), in the Workbench's order: its running jobs,
 *                                  the chat turns being answered, then its newest ended runs in the slots they leave, at most
 *                                  PANES_MAX in all, and how many more run. Each with its run name (a workflow block's
 *                                  "<document> › <block>", another job's label, a chat turn), its mark and word, who started
 *                                  it, its log's last lines (TAIL_MAX of them from its end, read only for the panes in the
 *                                  answer), its exit and its receipt (verified only when verifyReceiptIn confirms it against
 *                                  the chain read for this answer), its operation (whose run detail the page opens), and how
 *                                  it is stopped, in the workspace frame's words (the frame is read only while something runs)
 *
 * A request without the token is refused (401) before anything is read; a project the companion does not know is 404.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type express from 'express';
import type { ChatSurface } from '../../contracts/chat-session.js';
import type { WorkspaceFrame } from '../../contracts/workspace.js';
import type { JobRecord } from '../../jobs/index.js';
import type { PaneTail } from '../../ops/panes.js';
import { projectId } from '../../project/index.js';
import { timmyHome } from '../../setup/home.js';
import { scrubHomes } from '../../utils/home-scrub.js';
import { readChain, type Receipt } from '../../utils/receipts.js';
import type { JobRow } from '../../workbench/state.js';
import type { PanelContext } from '../panels.js';

type Env = Record<string, string | undefined>;

export const CONTROL_PANEL = { panes: '/api/panel/control/panes', room: '/api/panel/control/room' } as const;
/** R11 round 7 (H169): the Control Room's room — what runs now and waits on you, Stop, the fleet in the three words, the budget. */
export const CONTROL_ROOM_SCHEMA = 'timmy.control-room/1' as const;
export const CONTROL_PANES_SCHEMA = 'timmy.control-panes/1' as const;
/** How often the page reads the panes again while tab 7 is shown (ms): a running pane says it, as the Workbench's says its tick. */
export const PANES_EVERY_MS = 2000;

const FAILED = 'The Control Room panel could not read what this request needs, so it answers with nothing. The companion is still running.';
/** The unicode marks the panes are drawn with (src/workbench/frame.ts glyphsFor(true)'s). */
const MARKS = { next: '▶', ok: '✓', fail: '✕', unicode: true } as const;

/** One pane, as the page draws it. */
export interface ControlPane {
  kind: 'job' | 'turn';
  /** the job's id (j and 6 hex), or the turn's hold id */
  id: string;
  /** what runs: a workflow block's "<document> › <block>", another job's label; "chat turn" for a turn being answered */
  name: string;
  /** an ended run in a slot the running ones left */
  quiet: boolean;
  /** its mark and word (src/ops/panes.ts jobMark: ▶ running, ✓ completed, ✕ failed, ■ stopped, = no change, ? unknown);
   *  `failed`: drawn as a failure (amber, with ✕ and its word) */
  state: { glyph: string; word: string; failed: boolean };
  /** who started it (src/ops/panes.ts whoWords), or a turn's process */
  who: string;
  /** a turn: the surface it was sent from, in words */
  from?: string;
  /** when it started (a turn: when it took the project) */
  since: string;
  endedAt?: string;
  /** how long it ran, in words (a job's) */
  took?: string;
  /** a workflow run's blocks, counted once; recovery's state for a job a session left */
  blocks?: string;
  recovery?: string;
  /** its operation: the page opens its run detail (/run/<operation>); null, with why none */
  operation: string | null;
  noDetail?: string;
  /** its log's last lines, or why there are none */
  tail: PaneTail;
  /** a running pane: how often the page reads it again (ms) */
  every?: number;
  /** a quiet pane: its exit, and its receipt checked in this reading */
  exit?: string;
  receipt?: { id: string | null; state: 'verified' | 'failed' | 'not found' | 'none'; words: string };
  /** how it is stopped, in the frame's words; absent where the frame names no stop for it */
  stop?: { words: string; command?: string };
  /** a turn whose process's start could not be read */
  proof?: string;
}

export interface ControlPanes {
  schema: typeof CONTROL_PANES_SCHEMA;
  at: string;
  project: { id: string; name: string };
  /** how often the page reads the panes again while the tab is shown (ms) */
  every: number;
  /** what runs: the project's running jobs and the chat turns being answered */
  running: number;
  /** how many of those are not among the panes (more than PANES_MAX run) */
  more: number;
  panes: ControlPane[];
  /** the frame's Stop current (its words and its action's command) while something runs; null when nothing runs or no frame
   *  was read */
  stop: { words: string; command: string | null } | null;
  /** what could not be read, each with why */
  notes: string[];
}

export interface PanesInput {
  root: string;
  name: string;
  env: Env;
  /** the workspace frame of the project (the companion's, src/companion/workspace.ts); absent: no stop words are given */
  frame?: () => Promise<WorkspaceFrame>;
  now?: number;
}

/** The runs chain the other panels read: TIMMY_STORE, else the project's own store. */
function chainOf(root: string): Receipt[] {
  try { return process.env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0];

/** The project's panes, read now (files only, and the frame while something runs). */
export async function readControlPanes(i: PanesInput): Promise<ControlPanes> {
  const [{ JobManager }, panes, state, chat] = await Promise.all([
    import('../../jobs/index.js'), import('../../ops/panes.js'), import('../../workbench/state.js'), import('../../agent/chat-turn.js'),
  ]);
  const now = i.now ?? Date.now();
  const notes: string[] = [];
  const jobsDir = join(timmyHome(i.env), 'jobs');
  let records: JobRecord[] = [];
  try { records = existsSync(jobsDir) ? new JobManager({ dir: jobsDir }).list() : []; } catch (e) { notes.push(`The job store could not be read (${msg(e)}): no job is shown from it`); }
  const chain = chainOf(i.root);
  const rows = state.readJobs(records, i.root, { mine: new Set(), chain });
  let sealed: ReturnType<typeof state.readTurns> = [];
  try { sealed = state.readTurns(chain, i.root); } catch { sealed = []; }
  let held: ReturnType<typeof chat.runningTurns> = [];
  try { held = chat.runningTurns(i.root, undefined, { readOnly: true }); } catch (e) { notes.push(`The chat turns being answered could not be read: ${msg(e)}`); }
  const turns = panes.liveTurnsOf(held, sealed);
  const sel = panes.paneJobs(rows, [], turns.length);
  const running = sel.live.length + turns.length;
  const shown = panes.paneOrder(sel, turns).slice(0, panes.PANES_MAX);

  // the stop words as the frame gives them, while something runs: its Stop current (the job it names, its words) and the
  // control tab's Stop current action (its command)
  let frame: WorkspaceFrame | null = null;
  if (running > 0 && i.frame) {
    try { frame = await i.frame(); } catch (e) { notes.push(`The workspace frame could not be read (${msg(e)}), so its stop words are not shown`); }
  }
  const stopAct = frame?.actions?.control?.find((a) => a.label === 'Stop current');
  const stop = frame && running > 0 ? { words: frame.activity.stopCurrent.words, command: stopAct ? stopAct.command : null } : null;

  const jobPane = (j: JobRow, quiet: boolean): ControlPane => {
    const m = panes.jobMark(j, MARKS);
    const tail = panes.paneTailOf(records.find((r) => r.id === j.id), j, i.env);
    const recovery = j.recovery && j.recovery.state !== j.word ? j.recovery.state : '';
    const out: ControlPane = {
      kind: 'job', id: j.id, name: scrubHomes(j.label, i.env as NodeJS.ProcessEnv), quiet, state: { glyph: m.glyph, word: j.word, failed: m.role === 'failure' },
      who: panes.whoWords(j), since: j.startedAt, ...(j.endedAt ? { endedAt: j.endedAt } : {}), took: j.elapsed,
      ...(j.blocks ? { blocks: j.blocks } : {}), ...(recovery ? { recovery } : {}),
      operation: j.operation ?? null, ...(j.operation ? {} : { noDetail: 'this job names no operation' }),
      tail, ...(j.live ? { every: PANES_EVERY_MS } : {}),
    };
    if (quiet) {
      out.exit = panes.exitWords(j);
      if (!j.receipt) out.receipt = { id: null, state: 'none', words: panes.receiptWords(j, undefined, MARKS).words };
      else {
        const v = panes.checkReceipt(chain, j.id, j.receipt);
        out.receipt = { id: j.receipt, state: v.state, words: panes.receiptWords(j, v, MARKS).words };
      }
    }
    if (j.live && frame && frame.activity.stopCurrent.job === j.id) out.stop = { words: frame.activity.stopCurrent.words, ...(stopAct ? { command: stopAct.command } : {}) };
    return out;
  };
  const turnPane = (t: (typeof turns)[number]): ControlPane => ({
    kind: 'turn', id: t.id, name: 'chat turn', quiet: false, state: { glyph: MARKS.next, word: 'answering', failed: false },
    who: `pid ${t.pid}`, from: chat.surfaceWords(t.surface), since: t.taken,
    operation: null, noDetail: 'a turn being answered has none until its receipt is sealed',
    tail: { why: 'its words are where it was sent' },
    stop: { words: panes.turnStopLine(t.surface as ChatSurface) },
    ...(t.proof === 'unknown' ? { proof: 'its process\'s start could not be read, so it is taken as running' } : {}),
  });

  return {
    schema: CONTROL_PANES_SCHEMA, at: new Date(now).toISOString(), project: { id: projectId(i.root), name: i.name },
    every: PANES_EVERY_MS, running, more: Math.max(0, running - panes.PANES_MAX),
    panes: shown.map((p) => (p.kind === 'turn' ? turnPane(p.turn) : jobPane(p.job, p.quiet))),
    stop, notes: notes.map((n) => scrubHomes(n, i.env as NodeJS.ProcessEnv)),
  };
}

// ── R11 round 7 (H169): the room ─────────────────────────────────────────────────────────────────────────────────────────
//
// GET /api/panel/control/room?project=<id>   what the Control Room page draws beside its panes: the activity (what runs, what
// waits on you, the frame's Stop current), the approvals that wait (the frame's count; each is answered where the turn runs),
// the fleet — the lanes and integrations of the capability inventory, each in the three words (available / configured /
// exercised, src/capabilities/inventory.ts; the Fleet & Clef page's content folds in here), the budget (free-only and local-
// only as set, what the project's receipts measured in dollars, and that no spending cap exists in this revision) and the
// companion's own log address. Read only; nothing is run, stopped or changed here (Stop is the page's POST /api/chat/stop for
// a turn, or the frame's command for a job).

export interface ControlRoom {
  schema: typeof CONTROL_ROOM_SCHEMA;
  at: string;
  project: { id: string; name: string };
  activity: { running: number; waitingOnYou: number; stop: { job: string | null; words: string; command: string | null } | null; chatTurn: { surface: string; since: string; words: string; id?: string } | null };
  /** the frame's connections the Fleet & Clef page drew (cloudroom, clef, cloudflare), as the frame says them */
  connections: Array<{ id: string; label: string; state: string; words: string; observedAt: string | null; setup: string | null }>;
  /** the capability inventory's lanes and integrations, each in its standing word with the three facts' words */
  fleet: Array<{ id: string; name: string; group: string; word: 'available' | 'configured' | 'exercised' | 'none'; available: string; configured: string; exercised: string; next?: string }>;
  budget: {
    freeOnly: boolean; localOnly: boolean; from: { freeOnly: string; localOnly: string };
    /** what the project's receipts measured (cost_usd with cost_measured not false), in dollars, and how many said unknown */
    measuredUsd: number; receipts: number; unmeasured: number;
    cap: string;
  };
  notes: string[];
}

export async function readControlRoom(i: PanesInput & { inventory?: () => Promise<{ inventory: { rows: Array<{ id: string; name: string; group: string; available: { words: string }; configured: { words: string }; exercised: { words: string }; next?: string }> } }> }): Promise<ControlRoom> {
  const [policy, words] = await Promise.all([import('../../agent/route-policy.js'), import('../../capabilities/inventory-words.js')]);
  const notes: string[] = [];
  let frame: WorkspaceFrame | null = null;
  if (i.frame) { try { frame = await i.frame(); } catch (e) { notes.push(`The workspace frame could not be read (${msg(e)}): the activity and the fleet's connections are not shown`); } }
  const stopAct = frame?.actions?.control?.find((a) => a.label === 'Stop current');
  const a = frame?.activity;
  const activity: ControlRoom['activity'] = {
    running: a?.running ?? 0, waitingOnYou: a?.waitingOnYou ?? 0,
    stop: a && a.running > 0 ? { job: a.stopCurrent.job, words: a.stopCurrent.words, command: stopAct ? stopAct.command : null } : null,
    chatTurn: a?.chatTurn ?? null,
  };
  const FLEET = new Set(['cloudroom', 'clef', 'cloudflare']);
  const connections = (frame?.connections ?? []).filter((c) => FLEET.has(String(c.id))).map((c) => ({ id: String(c.id), label: c.label, state: String(c.state), words: c.words, observedAt: c.observedAt, setup: c.setup }));
  let fleet: ControlRoom['fleet'] = [];
  if (i.inventory) {
    try {
      const inv = await i.inventory();
      fleet = inv.inventory.rows.filter((r) => r.group === 'Lanes' || r.group === 'Integrations').map((r) => ({
        id: r.id, name: r.name, group: r.group, word: words.standingWord(r as never), available: r.available.words, configured: r.configured.words, exercised: r.exercised.words, ...(r.next ? { next: r.next } : {}),
      }));
    } catch (e) { notes.push(`The capability inventory could not be read (${msg(e)}): the fleet is not shown`); }
  }
  const chain = (() => { try { return i.env.TIMMY_STORE ? readChain('runs') : readChain('runs', i.root); } catch { return [] as Receipt[]; } })();
  const pid = projectId(i.root);
  let measuredUsd = 0; let receipts = 0; let unmeasured = 0;
  for (const r of chain) {
    const rp = (r as { project_id?: unknown }).project_id;
    if (typeof rp === 'string' && rp !== pid) continue;
    receipts += 1;
    if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) { if (r.cost_measured === false) unmeasured += 1; else measuredUsd += r.cost_usd; }
  }
  const pol = policy.routePolicyNow(i.env);
  const from = policy.policyFrom(i.env);
  return {
    schema: CONTROL_ROOM_SCHEMA, at: new Date(i.now ?? Date.now()).toISOString(), project: { id: pid, name: i.name },
    activity, connections, fleet,
    budget: { freeOnly: pol.freeOnly, localOnly: pol.localOnly, from: { freeOnly: from.freeOnly === 'environment' ? 'TIMMY_CHAT_FREE_ONLY for this companion' : 'the settings', localOnly: from.localOnly === 'environment' ? 'TIMMY_CHAT_LOCAL_ONLY for this companion' : 'the settings' }, measuredUsd: Math.round(measuredUsd * 10000) / 10000, receipts, unmeasured, cap: 'none in this revision: OpenRouter\'s maxCost stops a request; it is not a guaranteed cap on billing' },
    notes: notes.map((n) => scrubHomes(n, i.env as NodeJS.ProcessEnv)),
  };
}

export function mountControlPanel(app: express.Express, ctx: PanelContext): void {
  app.get(CONTROL_PANEL.room, ctx.withToken, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      // the fleet from the capability inventory: a test's FAKE rows (ctx.inventory), else read now (files, settings, receipts)
      const inventory = ctx.inventory
        ? () => ctx.inventory!(project) as never
        : async () => { const { inventory: readInventory } = await import('../../capabilities/inventory.js'); return { inventory: readInventory({ env: { ...ctx.env }, cwd: project.root }) } as never; };
      const answer = await readControlRoom({ root: project.root, name: project.name, env: { ...ctx.env }, ...(ctx.frame ? { frame: () => ctx.frame!(project) } : {}), inventory });
      res.json({ ok: true, ...answer });
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });
  app.get(CONTROL_PANEL.panes, ctx.withToken, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      const answer = await readControlPanes({ root: project.root, name: project.name, env: { ...ctx.env }, ...(ctx.frame ? { frame: () => ctx.frame!(project) } : {}) });
      res.json({ ok: true, ...answer });
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });
}
