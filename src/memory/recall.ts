/**
 * Timmy Memory (round R4, helper H50): recall over the work this project retained. `/recall <words>` searches each
 * record's own text for the words (by words, not by meaning: nothing here understands, embeds or ranks by meaning) and
 * lists the hits ranked by how many of the words each matched, then by recency: when, what kind of record, its state or
 * verdict in words, one line, the project-relative file to open, and the receipt that seals it (or why none does).
 *
 * The records, each read through the reader that already exists for it, never a second parser of the same file:
 *   flows            results/flows/*.json              readFlowRecord; sealed as checkFlowRecord checks it
 *   VoxVision        results/vox/*.json                readVoxRecord
 *   observations     results/observations/*.json       readObservationRecord with its provenance check
 *   code-agent runs  .timmy/agents/<run>/              listAgentRuns
 *   MCP calls        .timmy/mcp/<id>/call.json         readMcpCalls: server, tool and arguments only, never the output
 *   native runs      .timmy/native/<run>/              readNativeRecord
 *   recipe jobs      .timmy/recipe-jobs/<uuid>/        the recipe lane's status()
 *   workflow runs    (upmd) the jobs' records and the runs chain's workflow receipts
 *   lessons          .timmy/memory/lessons/*.json      src/memory/lessons.ts
 * A record that cannot be read is named with why, never skipped silently. Nothing here writes, seals or runs anything.
 */
import { readdirSync } from 'node:fs';
import { AGENTS_DIR, listAgentRuns, taskWords } from '../code-agents/index.js';
import { MCP_CALL_ID, mcpCallRel, MCP_CALLS_DIR, readMcpCalls } from '../connectors/mcp-records.js';
import { readFlowRecord, diffText, FLOWS_DIR, type FlowRecord } from '../flows/iterate.js';
import { scadFlowSummary } from '../flows/iterate-scad.js';
import { freecadFlowSummary } from '../flows/iterate-freecad.js';
import { aeFlowSummary } from '../flows/iterate-ae.js';
import { blenderFlowSummary } from '../flows/iterate-blender.js';
import type { JobRecord } from '../jobs/index.js';
import { NATIVE_APPS, readNativeRecord, type NativeApp } from '../native/index.js';
import { readProjectFile, resolveInside, sameFolder } from '../project/index.js';
import { isRecipeJobId, RECIPE_ID } from '../recipes/index.js';
import { status as recipeStatus } from '../../lanes/recipes/jobs.js';
import { checkFlowRecord } from '../repl/board-flows.js';
import { flowKind } from '../repl/board-steps.js';
import { readObservationRecord } from '../repl/board.js';
import { readVoxRecord } from '../repl/board-vox.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { Receipt } from '../utils/receipts.js';
import { OBSERVATIONS_DIR } from '../vision/look.js';
import { VOX_DIR } from '../vox/record.js';
import { fileShaNow, LESSONS_DIR, LESSON_KINDS, listLessons, oneLine, sealOfFile, shortHash, type LessonKind } from './lessons.js';
import { LESSONS_HEAD } from './retrieve.js';

type Line = Segment[];

export type RecallKind = 'flow' | 'vox' | 'observation' | 'agent' | 'mcp' | 'native' | 'recipe' | 'workflow' | 'lesson';
export const RECALL_KINDS: readonly RecallKind[] = ['flow', 'vox', 'observation', 'agent', 'mcp', 'native', 'recipe', 'workflow', 'lesson'];

/** The receipt that seals a record (its short hash), or why none does. */
export interface RecallSeal { receipt?: string; note?: string }

export interface RecallItem {
  kind: RecallKind;
  /** the record in a few words: "flow scad", "agent qwen", "MCP call" */
  what: string;
  id: string;
  /** when it ended (or was made), ISO */
  when?: string;
  /** its state or verdict in words */
  state: string;
  line: string;
  /** the file to open, project-relative */
  file?: string;
  seal: RecallSeal;
  /** the record's own text the words are looked for in */
  text: string;
  /** the kind of work it was, as a lesson names it */
  lessonKind?: LessonKind;
  /** the lessons it was given (a flow's or an /agent run's) */
  lessons?: string[];
}
export interface RecallUnreadable { kind: RecallKind; file: string; why: string }
export interface RecallContext {
  root: string;
  chain: readonly Receipt[];
  projectId: string;
  /** this Timmy's job records (workflow runs are kept there, not in the project) */
  jobs?: readonly JobRecord[];
}

/** What /recall and its help say about how it searches. */
export const BY_WORDS = 'by words, not meaning: each record\'s own text is searched for the words you give; nothing is matched or ranked by meaning';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const shortOf = (r: Receipt): string => shortHash(String(r.hash));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);
const lessonIds = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (typeof obj(x)?.id === 'string' ? [obj(x)!.id as string] : [])) : []);
const asKind = (k: unknown): LessonKind | undefined => ((LESSON_KINDS as readonly unknown[]).includes(k) ? k as LessonKind : undefined);

/** The names in a project folder (none when it is not there); a folder that cannot be read is named. */
function namesIn(c: RecallContext, rel: string, kind: RecallKind, bad: RecallUnreadable[]): string[] {
  const at = resolveInside(c.root, rel);
  if ('error' in at) { bad.push({ kind, file: rel, why: at.error }); return []; }
  try { return readdirSync(at.path).filter((n) => !n.startsWith('.')).sort(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') bad.push({ kind, file: `${rel}/`, why: `the folder cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` });
    return [];
  }
}

/** A file's seal in words: its receipt when one of this project seals its bytes now, else why not. */
function sealWords(c: RecallContext, rel: string, kinds: readonly string[], what: string): RecallSeal {
  const now = fileShaNow(c.root, rel);
  if (!('sha256' in now)) return { note: 'gone' in now ? `${rel} is gone` : now.error };
  const s = sealOfFile(c.chain, c.projectId, rel, now.sha256, kinds);
  if ('sealed' in s) return { receipt: shortOf(s.sealed) };
  if ('changed' in s) return { note: `changed after its receipt ${shortOf(s.changed)} sealed it` };
  return { note: `no ${what} receipt of this project seals it` };
}

// ── each kind of record ──────────────────────────────────────────────────────────

function flowItems(c: RecallContext, out: RecallItem[], bad: RecallUnreadable[]): void {
  for (const n of namesIn(c, FLOWS_DIR, 'flow', bad)) {
    const rel = `${FLOWS_DIR}/${n}`;
    if (!n.endsWith('.json')) continue;
    const r = readFlowRecord(c.root, rel);
    if (!r.ok) { bad.push({ kind: 'flow', file: rel, why: r.error }); continue; }
    try {
      const rec = r.record as FlowRecord & Record<string, unknown>;
      const k = flowKind(rec);
      // As /iterate's list says a flow's change (src/repl/iterate.ts flowListRow), each part read by its own kind's words.
      let summary = '';
      try {
        const given: unknown = rec.parameters?.diff;
        summary = scadFlowSummary(rec) || freecadFlowSummary(rec) || aeFlowSummary(rec) || (given !== undefined && given !== null ? diffText(given) : blenderFlowSummary(rec));
      } catch { summary = ''; }
      const verdict = str(obj(rec.readback)?.verdict);
      const outcome = str(rec.outcome) ?? 'unknown';
      const why = str(rec.why);
      const check = checkFlowRecord(rel, r.sha256, c.chain, c.projectId);
      const paths = [obj(rec.parameters)?.path, obj(rec.script)?.path, obj(rec.model)?.path].filter((p): p is string => typeof p === 'string');
      const lessons = lessonIds(rec.lessons);
      out.push({
        kind: 'flow', what: `flow ${k ?? '(a kind Timmy does not know)'}`, id: String(rec.id), when: str(rec.ended_at) ?? str(rec.started_at),
        state: `${outcome}${verdict ? `, readback ${verdict}` : ''}`,
        line: `"${oneLine(String(rec.instruction ?? ''), 90)}"${summary ? `: ${oneLine(summary, 90)}` : ''}${why && outcome !== 'succeeded' ? `; ${oneLine(why, 110)}` : ''}`,
        file: rel, seal: check.status === 'verified' ? { receipt: check.receipt } : { note: check.reasons[0] ?? 'not verified' },
        text: [rec.id, k, outcome, verdict, rec.instruction, why, summary, ...paths, obj(rec.agent)?.agent, obj(rec.agent)?.model, ...lessons].filter(Boolean).join(' '),
        ...(asKind(k) ? { lessonKind: asKind(k) } : {}), ...(lessons.length || Array.isArray(rec.lessons) ? { lessons } : {}),
      });
    } catch (e) { bad.push({ kind: 'flow', file: rel, why: `it could not be read as a flow (${msg(e)})` }); }
  }
}

function voxItems(c: RecallContext, out: RecallItem[], bad: RecallUnreadable[]): void {
  for (const n of namesIn(c, VOX_DIR, 'vox', bad)) {
    if (!n.endsWith('.json')) continue;
    const rel = `${VOX_DIR}/${n}`;
    const r = readProjectFile(c.root, rel, 1024 * 1024);
    if (!r.ok) { bad.push({ kind: 'vox', file: rel, why: r.error }); continue; }
    if (r.truncated || r.text === undefined || !r.sha256) { bad.push({ kind: 'vox', file: rel, why: r.truncated ? 'it is larger than a VoxVision record' : 'it is not text' }); continue; }
    const card = readVoxRecord({ root: c.root, file: rel, text: r.text, fileSha256: r.sha256, chain: c.chain, projectId: c.projectId });
    if (!card) { bad.push({ kind: 'vox', file: rel, why: 'it is not a VoxVision record (timmy.vox/1) Timmy can read' }); continue; }
    const inputs = card.inputs.map((i) => i.path);
    const failures = card.failures.map((f) => f.message).filter(Boolean);
    out.push({
      kind: 'vox', what: `VoxVision ${card.action}`, id: card.id, when: card.madeAt, state: card.status.replace(/-/g, ' '),
      line: `${inputs.join(' and ') || '(no input named)'}: ${card.metrics.length} measured value${card.metrics.length === 1 ? '' : 's'}${card.claims.length ? `, ${card.claims.length} model claim${card.claims.length === 1 ? '' : 's'}` : ''}${failures.length ? `; ${oneLine(failures[0], 90)}` : ''}`,
      file: rel, seal: sealWords(c, rel, ['vox'], 'vox'),
      text: [card.id, card.action, card.command, card.status, ...inputs, ...card.metrics.flatMap((m) => [m.name, m.title, m.unit]), ...card.claims.map((m) => m.title), ...failures, ...card.notes].filter(Boolean).join(' '),
      lessonKind: 'vox',
    });
  }
}

function observationItems(c: RecallContext, out: RecallItem[], bad: RecallUnreadable[]): void {
  for (const n of namesIn(c, OBSERVATIONS_DIR, 'observation', bad)) {
    if (!n.endsWith('.json')) continue;
    const rel = `${OBSERVATIONS_DIR}/${n}`;
    const r = readProjectFile(c.root, rel, 1024 * 1024);
    if (!r.ok) { bad.push({ kind: 'observation', file: rel, why: r.error }); continue; }
    if (r.truncated || r.text === undefined) { bad.push({ kind: 'observation', file: rel, why: r.truncated ? 'it is larger than an observation record' : 'it is not text' }); continue; }
    let raw: unknown;
    try { raw = JSON.parse(r.text); } catch (e) { bad.push({ kind: 'observation', file: rel, why: `it is not JSON (${msg(e)})` }); continue; }
    const src = str(obj(obj(raw)?.source)?.path);
    const now = src ? fileShaNow(c.root, src) : undefined;
    const o = readObservationRecord(rel, raw, { record: raw, fileSha256: r.sha256, currentSourceSha256: now === undefined ? undefined : 'sha256' in now ? now.sha256 : 'gone' in now ? null : undefined, receipts: c.chain, projectId: c.projectId });
    if (!o) { bad.push({ kind: 'observation', file: rel, why: 'it is not an observation record (/observe) Timmy can read' }); continue; }
    const names = o.measurements.map((m) => m.name);
    const it = o.interpretation;
    out.push({
      kind: 'observation', what: 'observation', id: n.replace(/\.json$/, ''), when: o.madeAt,
      state: `${names.length} measured value${names.length === 1 ? '' : 's'}${it ? `; model ${it.status}` : ''}`,
      line: `${o.source?.path ?? '(no image named)'}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}${it?.question ? `; asked "${oneLine(it.question, 60)}"` : ''}`,
      file: rel, seal: o.check?.status === 'verified' ? { receipt: o.check.receipt } : { note: o.check?.reasons[0] ?? 'not checked' },
      text: [rel, o.source?.path, ...names, it?.model, it?.question, it?.answer, it?.status].filter(Boolean).join(' '),
      lessonKind: 'vox',
    });
  }
}

function agentItems(c: RecallContext, out: RecallItem[], bad: RecallUnreadable[]): void {
  const runs = listAgentRuns(c.root);
  const read = new Set(runs.map((r) => r.run));
  for (const n of namesIn(c, AGENTS_DIR, 'agent', bad)) {
    if (/^a[0-9a-f]{8}$/.test(n) && !read.has(n)) bad.push({ kind: 'agent', file: `${AGENTS_DIR}/${n}/`, why: 'neither its result.json nor its run.json is a record of this run Timmy can read' });
  }
  for (const r of runs) {
    const result = `${AGENTS_DIR}/${r.run}/result.json`;
    const has = 'sha256' in fileShaNow(c.root, result);
    const f = r.files;
    const changed = f ? [...f.added, ...f.changed, ...f.deleted].map((x) => x.path) : [];
    const lessons = lessonIds((r as { lessons?: unknown }).lessons);
    out.push({
      kind: 'agent', what: `agent ${r.agent}`, id: r.run, when: r.ended_at ?? r.started_at,
      state: r.outcome ?? 'not finished here',
      line: `"${taskWords(firstPart(r.task), c.root, 90)}"${f ? `: ${f.added.length} added, ${f.changed.length} changed, ${f.deleted.length} deleted` : ''}${r.why && r.outcome !== 'completed' ? `; ${oneLine(r.why, 100)}` : ''}`,
      file: has ? result : `${AGENTS_DIR}/${r.run}/run.json`,
      seal: has ? sealWords(c, result, ['agent'], 'agent') : { note: 'not finished here: no result.json' },
      text: [r.run, r.agent, r.model, r.endpoint, r.task, r.outcome, r.why, ...changed, ...lessons].filter(Boolean).join(' '),
      lessonKind: 'agent', ...(Array.isArray((r as { lessons?: unknown }).lessons) ? { lessons } : {}),
    });
  }
}

/** An /agent task without the lessons section Timmy appended to it (src/memory/retrieve.ts agentTask), for its one line. */
const firstPart = (task: string): string => task.split(`\n\n${LESSONS_HEAD}`)[0];

function mcpItems(c: RecallContext, out: RecallItem[], bad: RecallUnreadable[]): void {
  const names = namesIn(c, MCP_CALLS_DIR, 'mcp', bad).filter((n) => MCP_CALL_ID.test(n));
  if (!names.length) return;
  // readMcpCalls also reads each call's output back; only its server, tool and arguments are searched or shown here.
  const { list } = readMcpCalls(c.root, c.chain, names.length);
  const read = new Set(list.map((x) => x.record.id));
  for (const n of names) if (!read.has(n)) bad.push({ kind: 'mcp', file: mcpCallRel(n), why: 'call.json is not an MCP call record (timmy.mcp-call/1) Timmy can read' });
  for (const x of list) {
    const rec = x.record;
    let args = '';
    try { args = JSON.stringify(rec.arguments ?? null) ?? ''; } catch { args = ''; }
    out.push({
      kind: 'mcp', what: 'MCP call', id: rec.id, when: rec.ended_at || rec.started_at, state: rec.outcome,
      line: `${oneLine(rec.server, 60)} · ${oneLine(rec.tool, 60)}${args && args !== '{}' && args !== 'null' ? ` · arguments ${oneLine(args, 70)}` : ''}`,
      file: x.call, seal: x.check.status === 'verified' ? { receipt: x.check.receipt.replace(/^sha256[_:]/, '').slice(0, 8) } : { note: x.check.reason },
      text: [rec.server, rec.tool, args.slice(0, 8192)].join(' '),
    });
  }
}

const NATIVE_KIND: Partial<Record<NativeApp, LessonKind>> = { blender: 'blender', openscad: 'scad', freecad: 'freecad', aerender: 'ae', afterfx: 'ae' };
const RUN_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nativeItems(c: RecallContext, out: RecallItem[], bad: RecallUnreadable[]): void {
  for (const run of namesIn(c, '.timmy/native', 'native', bad)) {
    if (!RUN_TOKEN.test(run)) continue;
    const file = `.timmy/native/${run}/job.json`;
    let rec: ReturnType<typeof readNativeRecord>;
    try { rec = readNativeRecord(c.root, run); } catch (e) { bad.push({ kind: 'native', file, why: msg(e) }); continue; }
    if (!rec) { bad.push({ kind: 'native', file, why: 'job.json is not a native run record Timmy can read' }); continue; }
    const last = rec.verdicts.at(-1);
    const app = NATIVE_APPS[rec.job.app]?.name ?? String(rec.job.app);
    const sealed = [...c.chain].reverse().find((r) => r.project_id === c.projectId && r.native?.run === run);
    out.push({
      kind: 'native', what: app, id: run.slice(0, 8), when: last?.judged_at ?? rec.job.started_at,
      state: last ? `judged ${last.outcome}` : rec.started ? 'not judged yet' : 'submitted',
      line: `${oneLine(rec.job.label ?? '', 90)}${last ? `; ${oneLine(last.why, 100)}` : ''}`,
      file, seal: sealed ? { receipt: shortOf(sealed) } : { note: 'no receipt of this project names this run' },
      text: [run, rec.job.app, app, rec.job.label, rec.job.input?.path, last?.outcome, last?.why, ...(last?.files ?? []).map((x) => x.path)].filter(Boolean).join(' '),
      ...(NATIVE_KIND[rec.job.app] ? { lessonKind: NATIVE_KIND[rec.job.app] } : {}),
    });
  }
}

function recipeItems(c: RecallContext, out: RecallItem[], bad: RecallUnreadable[]): void {
  for (const id of namesIn(c, '.timmy/recipe-jobs', 'recipe', bad)) {
    if (!isRecipeJobId(id)) continue;
    const file = `.timmy/recipe-jobs/${id}/job.json`;
    let s: ReturnType<typeof recipeStatus>;
    try { s = recipeStatus(c.root, id); } catch (e) { bad.push({ kind: 'recipe', file, why: msg(e) }); continue; }
    const req = obj(s.job.request);
    const params = obj(req?.parameters) ?? req;
    const values = params ? Object.entries(params).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${String(v)}`).join(', ') : '';
    const named = [...c.chain].reverse().find((r) => r.project_id === c.projectId && ((typeof r.job?.label === 'string' && r.job.label.includes(id)) || (Array.isArray(r.sources) && r.sources.some((x) => obj(x)?.operation === id))));
    const created = typeof s.job.created === 'number' ? new Date(s.job.created).toISOString() : undefined;
    out.push({
      kind: 'recipe', what: `recipe ${RECIPE_ID}`, id: id.slice(0, 8), when: created,
      state: `${s.state}${s.progress && s.progress !== 'finished' && s.progress !== s.state ? ` (${s.progress})` : ''}`,
      line: `job ${id}${values ? `: ${values}` : ''}${s.reason ? `; ${oneLine(s.reason, 100)}` : ''}`,
      file, seal: named ? { receipt: shortOf(named), note: `its ${named.kind === 'predict' ? 'prediction' : `${named.kind} job`}` } : { note: 'no receipt of this project names this job' },
      text: [id, RECIPE_ID, 'recipe tray', s.state, s.progress, s.reason, values].filter(Boolean).join(' '),
      lessonKind: 'tray',
    });
  }
}

function workflowItems(c: RecallContext, out: RecallItem[]): void {
  const receipts = new Map<string, Receipt>();
  for (const r of c.chain) if (r.project_id === c.projectId && r.kind === 'workflow' && typeof r.job?.id === 'string') receipts.set(r.job.id, r);
  const jobs = new Map<string, JobRecord>();
  for (const j of c.jobs ?? []) if (j.kind === 'workflow' && sameFolder(j.root, c.root)) jobs.set(j.id, j);
  for (const id of new Set([...jobs.keys(), ...receipts.keys()])) {
    const j = jobs.get(id);
    const r = receipts.get(id);
    const label = j?.label ?? r?.job?.label ?? '';
    const [docFromLabel, blockFromLabel] = label.split(' › ');
    const doc = str(r?.prediction?.doc) ?? docFromLabel;
    const block = str(r?.prediction?.block) ?? blockFromLabel;
    const steps = j?.steps?.length ? j.steps : r?.job?.steps ?? [];
    const met = r?.prediction?.met;
    const state = `${j?.state ?? r?.job?.state ?? 'unknown'}${met === true ? ', prediction met' : met === false ? ', prediction missed' : ''}`;
    out.push({
      kind: 'workflow', what: 'workflow run', id, when: j?.endedAt ?? j?.startedAt ?? r?.ts, state,
      line: `${doc ?? '?'} › ${block ?? '?'}${steps.length ? `: ${steps.map((s) => `${s.name} ${s.state}`).join(', ')}` : ''}`,
      ...(doc && !doc.startsWith('/') ? { file: doc } : {}),
      seal: r ? { receipt: shortOf(r) } : { note: j && (j.state === 'running' || j.state === 'queued') ? 'running: sealed when it ends' : 'no receipt of this project names this run' },
      text: [id, label, doc, block, j?.state, r?.job?.state, ...steps.map((s) => s.name)].filter(Boolean).join(' '),
      lessonKind: 'run',
    });
  }
}

function lessonItems(c: RecallContext, out: RecallItem[], bad: RecallUnreadable[]): void {
  const { lessons, unreadable } = listLessons(c.root);
  for (const u of unreadable) bad.push({ kind: 'lesson', file: u.rel, why: u.error });
  for (const l of lessons) {
    const x = l.lesson;
    const s = sealOfFile(c.chain, c.projectId, l.rel, l.sha256, ['lesson']);
    out.push({
      kind: 'lesson', what: 'lesson', id: x.id, when: x.checked ?? x.created, state: x.status,
      line: `${oneLine(x.text, 120)} (${x.evidence.length} evidence item${x.evidence.length === 1 ? '' : 's'})`,
      file: l.rel, seal: 'sealed' in s ? { receipt: shortOf(s.sealed) } : 'changed' in s ? { note: `changed after its receipt ${shortOf(s.changed)} sealed it` } : { note: 'no lesson receipt of this project seals it' },
      text: [x.id, x.text, x.status, ...x.applies_to.kinds, ...x.applies_to.files, ...x.applies_to.words, ...x.evidence.flatMap((e) => [e.path, e.why])].join(' '),
    });
  }
}

/**
 * Every record the project retained, of every kind, each with its seal; and every record that could not be read, named
 * with why. A reader that fails as a whole is named too (its folder and why), never dropped.
 */
export function gatherRecall(c: RecallContext): { items: RecallItem[]; unreadable: RecallUnreadable[] } {
  const items: RecallItem[] = [];
  const unreadable: RecallUnreadable[] = [];
  const kinds: Array<[RecallKind, string, () => void]> = [
    ['flow', FLOWS_DIR, () => flowItems(c, items, unreadable)],
    ['vox', VOX_DIR, () => voxItems(c, items, unreadable)],
    ['observation', OBSERVATIONS_DIR, () => observationItems(c, items, unreadable)],
    ['agent', AGENTS_DIR, () => agentItems(c, items, unreadable)],
    ['mcp', MCP_CALLS_DIR, () => mcpItems(c, items, unreadable)],
    ['native', '.timmy/native', () => nativeItems(c, items, unreadable)],
    ['recipe', '.timmy/recipe-jobs', () => recipeItems(c, items, unreadable)],
    ['workflow', 'the workflow runs', () => workflowItems(c, items)],
    ['lesson', LESSONS_DIR, () => lessonItems(c, items, unreadable)],
  ];
  for (const [kind, where, read] of kinds) {
    try { read(); } catch (e) { unreadable.push({ kind, file: where, why: `these records could not be read (${msg(e)})` }); }
  }
  return { items, unreadable };
}

/** The words of a query: lower case, each trimmed of punctuation at its ends, two characters or more, each once. */
export function recallWords(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter((w) => w.length >= 2);
  return [...new Set(words)];
}

export interface RecallHit extends RecallItem { matched: string[] }
export interface RecallResult { words: string[]; hits: RecallHit[]; total: number; unreadable: RecallUnreadable[] }

const timeOf = (when: string | undefined): number => { const t = when ? Date.parse(when) : Number.NaN; return Number.isNaN(t) ? 0 : t; };

/** The records whose own text holds any of the words, ranked by how many they hold, then newest first; at most `max` unless `all`. */
export function recall(c: RecallContext, query: string, o: { all?: boolean; max?: number } = {}): RecallResult {
  const words = recallWords(query);
  const { items, unreadable } = gatherRecall(c);
  const hits: RecallHit[] = [];
  for (const it of items) {
    const hay = it.text.toLowerCase();
    const matched = words.filter((w) => hay.includes(w));
    if (matched.length) hits.push({ ...it, matched });
  }
  hits.sort((a, b) => b.matched.length - a.matched.length || timeOf(b.when) - timeOf(a.when));
  const max = o.max ?? 10;
  return { words, hits: o.all ? hits : hits.slice(0, max), total: hits.length, unreadable };
}

/** An ISO time as "YYYY-MM-DD HH:MM UTC" (the board's own form); anything else as it is. */
export const whenText = (when: string | undefined): string => {
  if (!when) return 'at an unknown time';
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? when : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

/** A record's seal as one phrase: "receipt 1a2b3c4d" or why none seals it. */
export const sealText = (s: RecallSeal): string => (s.receipt ? `receipt ${s.receipt}${s.note ? ` (${s.note})` : ''}` : s.note ?? 'no receipt');

/** /recall's lines: the words and how they are searched, each hit in two lines, then every record that could not be read. */
export function recallLines(r: RecallResult, o: { glyphs: GlyphSet; scrub: (t: string) => string; link?: (rel: string) => string; all?: boolean }): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const lines: Line[] = [[{ text: '  Recall     ', role: 'secondary' }, { text: r.words.join(' '), role: 'strong' }, { text: `${sep}${BY_WORDS}`, role: 'secondary' }]];
  if (!r.total) lines.push([{ text: `  Nothing this project retained holds ${r.words.length === 1 ? 'that word' : 'any of these words'}.`, role: 'secondary' }]);
  else {
    const shown = r.hits.length;
    lines.push([{ text: `  ${r.total} record${r.total === 1 ? '' : 's'} hold${r.total === 1 ? 's' : ''} ${r.words.length === 1 ? 'the word' : 'one or more of the words'}; ranked by how many words matched, then newest first${shown < r.total ? `; ${shown} shown: /recall ${r.words.join(' ')} --all shows all` : ''}`, role: 'secondary' }]);
  }
  for (const h of r.hits) {
    lines.push([{ text: `  ${g.bullet} ` }, { text: `${whenText(h.when)}  `, role: 'secondary' }, { text: `${h.what} ${h.id}`, role: 'strong' }, { text: `  ${o.scrub(h.state)}` },
      { text: `${sep}${o.scrub(h.line)}`, role: 'secondary' }]);
    lines.push([{ text: '      ' }, h.file ? { text: o.link ? o.link(h.file) : h.file } : { text: 'no file to open', role: 'secondary' },
      { text: `${sep}${o.scrub(sealText(h.seal))}${sep}matched ${h.matched.join(', ')}`, role: 'secondary' }]);
  }
  if (r.unreadable.length) {
    const show = o.all ? r.unreadable : r.unreadable.slice(0, 10);
    lines.push([{ text: `  Could not read ${r.unreadable.length} record${r.unreadable.length === 1 ? '' : 's'} (not searched):`, role: 'failure' }]);
    for (const u of show) lines.push([{ text: `    ${g.fail} ` , role: 'failure' }, { text: u.file }, { text: `  ${o.scrub(u.why)}`, role: 'secondary' }]);
    if (show.length < r.unreadable.length) lines.push([{ text: `    and ${r.unreadable.length - show.length} more: /recall ${r.words.join(' ')} --all names them all`, role: 'secondary' }]);
  }
  return lines;
}
