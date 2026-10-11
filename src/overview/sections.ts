/**
 * Round R4 (helper H78): God's Eye View's sections, each built from the parts src/overview/sources.ts read, inside its own
 * guard (src/overview/build.ts): a section whose part could not be read says "unknown" and why; one whose part was read in
 * part says "partial". Words come from the records' own readers (the Control Room's states, Waiting on you's items,
 * VoxVision's status words, the review's changes); what this module adds is only what is proven of each run's life
 * (src/overview/proof.ts), where each item's record and command are, and the counts, each saying what it counts.
 */
import { AGENTS_DIR, RUN_RECORD } from '../code-agents/index.js';
import { FLOW_SCHEMA } from '../flows/iterate.js';
import type { JobRecord } from '../jobs/index.js';
import { operationRel } from '../ops/operations.js';
import { runOf } from '../repl/board-workflows.js';
import type { BoardFlow } from '../repl/board-flows.js';
import type { Decision } from '../room/decisions.js';
import { cleanLine, costsLine, type RoomCost, type RoomRun } from '../room/index.js';
import { verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import { isGeometry } from '../vox/record.js';
import { metricText } from '../vox/tools.js';
import type { VoxKind } from '../vox/kinds.js';
import { blockDetail } from '../workflows/run-blocks.js';
import { readProjectToken } from '../studio/project-link.js';
import { canvasDir } from '../studio/document.js';
import { studioPort } from '../studio/config.js';
import { ARTIFACT_ORDER, artifactCommand, artifactKind } from './artifacts.js';
import {
  ITEMS_MAX, SECTION_TITLE,
  type AgentItem, type AgentsSection, type AppRunItem, type AppsSection, type ArtifactItem, type Blocker, type Count, type Handoff,
  type HistorySection, type JobItem, type Life, type NeedsItem, type NeedsSection, type OperationItem, type OverviewCost,
  type OverviewSectionId, type OverviewSource, type ProjectSection, type ReceiptItem, type ResultItem, type SectionBase,
  type SpatialHighlight, type SpatialItem, type SpatialSection, type Tone, type Unreadable, type WorkflowItem, type WorkflowsSection,
} from './model.js';
import { flowLife, jobLife, LIVE_STATES, operationLife } from './proof.js';
import { roomRuns, unreadableWhy, type Sources } from './sources.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const quoteArg = (s: string): string => (/[\s"']/.test(s) ? (s.includes('"') ? `'${s}'` : `"${s}"`) : s);
const shortReceipt = (r: Receipt): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?'));
const LIFE_ORDER: Readonly<Record<Life, number>> = { left: 0, stale: 1, running: 2, unknown: 3, ended: 4 };
const VOX_RECORD = /^results\/vox\/v[0-9a-f]{8}\.json$/;
/** The roles of the files a record names that are about the run itself, not what it made (src/room/index.ts's roles). */
const SKIP_ROLE = /^(record|transcript|its final message|agent transcript|agent result|raw output|kept record|observation)$|\blog$/;
const FLOW_RECORD = /^results\/flows\/f[0-9a-f]{8}\.json$/;

/** A section's shared fields; `state` read unless said. */
export function base<T extends OverviewSectionId>(id: T, s: Pick<Sources, 'asOf'>): SectionBase & { id: T } {
  return { id, title: SECTION_TITLE[id], as_of: s.asOf, state: 'read', summary: '', counts: [], unreadable: [], notes: [] };
}

/** A count, only when it says something: a zero is kept only where `keep` asks (nothing is invented). */
const count = (n: number, of: string, many?: string): Count => ({ n, of: n === 1 || many === undefined ? of : many });

/** The tone of a Control Room state. */
const toneOf = (t: string): Tone => (t === 'failed' ? 'failed' : t === 'running' ? 'running' : t === 'ok' ? 'ok' : t === 'attention' || t === 'stopped' ? 'attention' : 'neutral');

/** A Control Room cost as the overview keeps it: a reported number, free (recorded as no charge), null (unknown); none: absent. */
export function costOf(c: RoomCost): { cost?: OverviewCost; none?: string } {
  if (c.kind === 'none') return { none: c.words };
  if (c.kind === 'known') return { cost: { kind: 'known', usd: typeof c.usd === 'number' ? c.usd : null, words: c.words } };
  if (c.kind === 'free') return { cost: { kind: 'free', usd: 0, words: c.words } };
  return { cost: { kind: 'unknown', usd: null, ...(c.atLeast ? { at_least: c.atLeast } : {}), words: c.words } };
}

// ── needs you ────────────────────────────────────────────────────────────────

export function needsSource(d: Decision): OverviewSource {
  return { record: d.record ?? null, command: d.commands[0] ?? '/decisions', board: 'room-decisions', ...(d.receipt ? { receipt: d.receipt } : {}) };
}

export function needsSection(s: Sources): NeedsSection {
  const out: NeedsSection = { ...base('needs', s), total: 0, items: [], more: 0, tools: {} };
  if (!s.decisions.ok) return { ...out, state: 'unknown', summary: 'not known', why: `what waits on you could not be read: ${s.decisions.error}` };
  const v = s.decisions.value;
  const failed = v.notes.find((n) => /^What waits on you could not be read/.test(n));
  if (failed && !v.items.length) return { ...out, state: 'unknown', summary: 'not known', why: failed };
  const items: NeedsItem[] = v.items.map((d) => ({
    title: d.title, kind: d.kind, blocks: d.blocks, needed: d.needed, why: d.why, commands: [...d.commands],
    ...(d.keys?.length ? { keys: [...d.keys] } : {}), ...(d.steps?.length ? { steps: [...d.steps] } : {}),
    ...(d.operation ? { operation: d.operation } : {}), source: needsSource(d),
  }));
  const blocking = items.filter((i) => i.blocks).length;
  const first = items[0];
  const partial = v.notes.filter((n) => /could not be read/.test(n));
  return {
    ...out, state: partial.length ? 'partial' : 'read', ...(partial.length ? { why: partial.join('; ') } : {}),
    total: v.total, items, more: v.more,
    summary: v.total ? `${v.total} waiting${blocking ? `, ${blocking} blocking` : ''}` : 'nothing waits on you',
    counts: [count(v.total, v.total === 1 ? 'thing waits on you' : 'things wait on you'), ...(blocking ? [count(blocking, `of the first ${items.length} ${blocking === 1 ? 'blocks' : 'block'} a running or requested request`)] : [])],
    ...(first ? { urgent: { text: first.title, tone: first.blocks || first.kind === 'failed' || first.kind === 'differs' ? 'failed' : 'attention', source: first.source } } : {}),
    tools: { ...(v.tools.checkedAt ? { checked_at: v.tools.checkedAt } : {}), ...(v.tools.note ? { note: v.tools.note } : {}) },
    notes: [
      ...v.notes.filter((n) => !partial.includes(n)),
      ...(v.otherSetup ? [`${plural(v.otherSetup, 'other row')} of /tools need setup for a tool no run of this project used or tried: /tools lists them.`] : []),
      ...(s.standalone ? ['A NEEDS YOU box and a save the board refused are held by the REPL that has them: not read here.'] : []),
    ],
  };
}

// ── agents ───────────────────────────────────────────────────────────────────

/** Whom a decision is about: a run by its id, or its operation. */
const decisionFor = (d: Decision, run: { id: string; operation?: string }): boolean => d.run === run.id || (!!run.operation && (d.operation === run.operation || (d.operations ?? []).includes(run.operation)));

export function agentsSection(s: Sources): AgentsSection {
  const out: AgentsSection = { ...base('agents', s), items: [], more: 0, operations: [], operations_more: 0 };
  if (!s.room.ok) return { ...out, state: 'unknown', summary: 'not known', why: `the Control Room could not be read: ${s.room.error}` };
  const view = s.room.value;
  if (!view.groups.length) return { ...out, state: 'unknown', summary: 'not known', why: view.notes[0] ?? 'the Control Room read no runs' };
  const { runs, more } = roomRuns(view, ['agent', 'flow', 'chat']);
  const flows = s.flows.ok ? [...(s.flows.value.running ?? []), ...s.flows.value.list] : [];
  const flowById = new Map<string, BoardFlow>(flows.map((f) => [String((f.record as unknown as Obj).id), f] as const));
  const records = s.agentRuns.ok ? s.agentRuns.value : new Map();
  const decisions = s.decisions.ok ? s.decisions.value.items : [];
  const review = s.review.ok ? s.review.value.operations : [];
  const requestOf = (op: string | undefined): string | undefined => {
    if (!op) return undefined;
    const card = view.operations?.find((c) => c.id === op);
    if (card && !/^\(no record/.test(card.request)) return card.request;
    const rec = s.ix.ok ? s.ix.value.records.get(op)?.record : undefined;
    return rec ? s.scrub(rec.request) : undefined;
  };
  const items: AgentItem[] = runs.map((run): AgentItem => {
    const rec = run.kind === 'agent' ? records.get(run.id) : undefined;
    const flow = run.kind === 'flow' ? flowById.get(run.id) : undefined;
    // What it was asked, in its own record's words.
    let assignment: AgentItem['assignment'] = null;
    if (rec?.task) assignment = { text: cleanLine(rec.task, s.scrub, 200), from: `its task, in ${AGENTS_DIR}/${run.id}/${RUN_RECORD}` };
    else if (flow && str((flow.record as unknown as Obj).instruction)) assignment = { text: cleanLine((flow.record as unknown as Obj).instruction, s.scrub, 200), from: `its instruction, in ${flow.file}` };
    else {
      const req = requestOf(run.operation);
      if (req) assignment = { text: cleanLine(req, s.scrub, 200), from: `the request of operation ${run.operation}, in ${operationRel(run.operation!)}` };
    }
    // What is proven of its life.
    let life: { life: Life; why?: string };
    if (run.kind === 'chat') life = { life: 'ended' };
    else if (run.kind === 'flow') {
      life = run.running && flow
        ? flowLife({ id: run.id, record: flow.record as unknown as Obj, ...(flow.live?.written ? { written: flow.live.written } : {}), jobs: s.jobMap, activeFlows: s.activeFlows, now: s.now })
        : { life: 'ended' };
    } else if (rec?.outcome || rec?.state === 'interrupted') life = { life: 'ended' };
    else life = jobLife(run.job ? s.jobMap.get(run.job) : undefined);
    if (life.life === 'running' && !s.jobs.named) life = { life: 'unknown', why: 'no jobs folder was named, so whether it runs cannot be proven here' };
    const handoffs: Handoff[] = [];
    if (run.kind === 'flow') {
      for (const h of run.handoff ?? []) {
        handoffs.push({ to: h.owner, state: `${h.name}: ${h.state}${h.here ? ` (${h.here})` : ''}`, ...(h.job ? { source: { record: null, command: `/jobs ${h.job}`, board: 'jobs' as const } } : {}) });
      }
    }
    if (run.partOf) handoffs.push({ to: run.partOf.replace(/^(the agent step|a step|the build step) of /, ''), state: run.partOf, source: { record: null, command: `/room ${/(f[0-9a-f]{8})/.exec(run.partOf)?.[1] ?? run.id}`, board: 'room' } });
    for (const d of decisions) if (decisionFor(d, run)) handoffs.push({ to: 'you', state: `waiting on you: ${d.title}`, source: needsSource(d) });
    for (const op of review) {
      if (op.id !== run.operation || !op.changes.length) continue;
      handoffs.push({ to: 'the review', state: `${plural(op.changes.length + op.more, 'change')} of its operation to review`, source: { record: op.record ?? null, command: `/review ${op.id}`, board: 'review' } });
    }
    const c = costOf(run.cost);
    return {
      kind: run.kind as AgentItem['kind'], id: run.id, owner: run.owner, assignment,
      ...(run.harness ? { harness: run.harness } : {}), ...(run.model ? { model: run.model } : {}), route: run.route, ...(run.endpoint ? { endpoint: run.endpoint } : {}),
      life: life.life, ...(life.why ? { life_why: life.why } : {}), state: run.state,
      ...(run.step ? { step: run.step } : {}), ...(run.progress ? { progress: run.progress } : {}), ...(run.elapsed ? { elapsed: run.elapsed } : {}),
      handoffs, ...(c.cost ? { cost: c.cost } : {}), ...(c.none ? { cost_none: c.none } : {}),
      ...(run.operation ? { operation: run.operation } : {}), ...(run.role ? { role: run.role } : {}),
      source: { record: run.record ?? null, command: `/room ${run.id}`, board: 'room', ...(run.receipt ? { receipt: run.receipt } : {}) },
    };
  });
  items.sort((a, b) => LIFE_ORDER[a.life] - LIFE_ORDER[b.life]);
  // The requests (operations), running first, each with what is proven of the process that writes its record.
  const cards = view.operations ?? [];
  const operations: OperationItem[] = cards.map((c): OperationItem => {
    const rec = s.ix.ok ? s.ix.value.records.get(c.id)?.record : undefined;
    const life = c.state === 'running' ? operationLife(rec?.owner, false) : c.note ? { life: 'left' as Life, why: c.note } : { life: 'ended' as Life };
    return {
      id: c.id, request: c.request, state: c.state, life: life.life, ...(life.why ? { life_why: life.why } : {}), runs: c.runs.length, waiting: c.waiting ? [...c.waiting] : [],
      source: { record: c.record ?? null, command: `/op ${c.id}`, board: 'room' },
    };
  });
  // Flow records that could not be read as records (named with why; a record only left off the bounded list is not).
  const shownFlows = new Set(flows.map((f) => f.file));
  const unreadable: Unreadable[] = (s.files.ok ? s.files.value.list.map((f) => f.rel) : []).filter((r) => FLOW_RECORD.test(r) && !shownFlows.has(r))
    .flatMap((r) => { const why = unreadableWhy(s.root, r, FLOW_SCHEMA); return why ? [{ record: r, why }] : []; });
  const by = (l: Life): number => items.filter((i) => i.life === l).length;
  const urgent = items.find((i) => i.life === 'left' || i.life === 'stale') ?? items.find((i) => i.life === 'running')
    ?? items.find((i) => /^(failed|differs|timed out|interrupted)/.test(i.state));
  const recentRead = items.length + more;
  return {
    ...out,
    ...(s.jobs.named ? {} : { state: 'partial' as const, why: 'no jobs folder was named, so no run is proven running here' }),
    items: items.slice(0, ITEMS_MAX), more: Math.max(0, items.length - ITEMS_MAX) + more,
    operations: operations.slice(0, 6), operations_more: Math.max(0, operations.length - 6),
    summary: [`${by('running')} running`, ...(by('left') ? [`${by('left')} left`] : []), ...(by('stale') ? [`${by('stale')} stale`] : []), ...(by('unknown') ? [`${by('unknown')} unproven`] : []), `${recentRead} runs read`].join(', '),
    counts: [
      count(by('running'), 'run running (proven by a live process)', 'runs running (proven by a live process)'),
      ...(by('left') ? [count(by('left'), 'run left running by a Timmy that ended', 'runs left running by a Timmy that ended')] : []),
      ...(by('stale') ? [count(by('stale'), 'run stale (its process is gone)', 'runs stale (their processes are gone)')] : []),
      ...(by('unknown') ? [count(by('unknown'), 'run not proven either way', 'runs not proven either way')] : []),
      count(recentRead, 'agent, flow or chat run read', 'agent, flow and chat runs read'),
      ...(operations.length ? [count(operations.length, 'recent request (operation)', 'recent requests (operations)')] : []),
    ],
    ...(urgent ? { urgent: { text: `${urgent.owner} ${urgent.id}: ${urgent.life === 'running' ? `${urgent.state}${urgent.step ? `, ${urgent.step}` : ''}` : urgent.life_why ?? urgent.state}`, tone: urgent.life === 'running' ? 'running' : urgent.life === 'ended' ? 'failed' : 'attention', source: urgent.source } } : {}),
    unreadable,
    notes: [...view.notes.filter((n) => !/^The Control Room could not be read/.test(n))],
  };
}

// ── workflows ────────────────────────────────────────────────────────────────

export function workflowsSection(s: Sources): WorkflowsSection {
  const out: WorkflowsSection = { ...base('workflows', s), items: [], more: 0, jobs: [], jobs_more: 0 };
  const decisions = s.decisions.ok ? s.decisions.value.items : [];
  const jobList = s.jobs.ok ? s.jobs.value : [];
  // The project's jobs that say they run (live or stale), each with what is proven.
  const saying = jobList.filter((j) => LIVE_STATES.has(j.state) || j.stale);
  const jobs: JobItem[] = saying.map((j): JobItem => {
    const l = s.jobs.named ? jobLife(j) : { life: 'unknown' as Life, why: 'no jobs folder was named' };
    return { id: j.id, kind: j.kind, label: cleanLine(j.label, s.scrub, 120), life: l.life, ...(l.why ? { life_why: l.why } : {}), state: j.stale ? `${j.state} (its process is gone)` : j.state, source: { record: null, command: `/jobs ${j.id}`, board: 'jobs' } };
  }).sort((a, b) => LIFE_ORDER[a.life] - LIFE_ORDER[b.life]);
  if (!s.workflows.ok) {
    return { ...out, state: 'unknown', summary: 'not known', why: `the workflow documents could not be read: ${s.workflows.error}`, jobs: jobs.slice(0, ITEMS_MAX), jobs_more: Math.max(0, jobs.length - ITEMS_MAX) };
  }
  const docs = s.workflows.value.list;
  const items: WorkflowItem[] = docs.map((w): WorkflowItem => {
    const c = w.connected;
    const node = (name: string) => c?.nodes.find((n) => n.name === name);
    const readable = !(w.readOnly === 'it could not be read whole' && !w.blocks.length);
    const title = w.text ? /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(w.text)?.[1] : undefined;
    const run = c?.runs.find((r) => r.job === c.latest) ?? c?.runs[0];
    const job: JobRecord | undefined = run ? s.jobMap.get(run.job) : undefined;
    const life = run ? (job ? jobLife(job) : run.word === 'running' || run.word === 'starting' ? jobLife(undefined) : { life: 'ended' as Life }) : undefined;
    const blockers: Blocker[] = [];
    if (run) {
      for (const b of run.blocks) if (b.word === 'failed') blockers.push({ block: b.name, why: `failed in run ${run.job}${b.code !== undefined ? ` (exit ${b.code})` : ''}`, source: { record: w.rel, command: `/jobs ${run.job}`, board: 'workflows' } });
      if (life && (life.life === 'left' || life.life === 'stale')) {
        blockers.push({ block: run.interruptedAt ?? run.blocks.find((b) => b.word === 'running')?.name ?? run.target, why: life.why ?? life.life, source: { record: null, command: '/recover', board: 'room-decisions' } });
      }
      for (const d of decisions) {
        if (d.run === run.job || (!!job?.operation && (d.operation === job.operation || (d.operations ?? []).includes(job.operation)))) {
          blockers.push({ block: run.interruptedAt ?? run.target, why: `waiting for a decision: ${d.title}`, source: needsSource(d) });
        }
      }
    }
    const lastRun = run ? {
      job: run.job, target: run.target, word: run.word, life: life!.life, ...(life!.why ? { life_why: life!.why } : {}), order_from: run.orderFrom,
      blocks: run.blocks.map((b) => ({ name: b.name, word: b.word, ...(blockDetail(b) ? { detail: blockDetail(b) } : {}) })),
      ...(run.receipt ? { receipt: run.receipt } : {}), ...(typeof run.met === 'boolean' ? { met: run.met } : {}),
      source: { record: null, command: `/jobs ${run.job}`, board: 'workflows' as const },
    } : undefined;
    return {
      doc: w.rel, ...(title ? { title: cleanLine(title, s.scrub, 120) } : {}),
      blocks: w.blocks.map((b) => { const n = node(b.name); return { name: b.name, needs: [...b.deps], word: n?.word ?? 'not run yet', ...(n?.detail ? { detail: n.detail } : {}) }; }),
      ...(lastRun ? { last_run: lastRun } : {}), blockers, readable, ...(!readable ? { why: w.readOnly } : {}),
      source: { record: w.rel, command: `/workflows ${quoteArg(w.rel)}`, board: 'workflows' },
    };
  });
  const blockers = items.flatMap((i) => i.blockers.map((b) => ({ doc: i.doc, b })));
  const runningRuns = items.filter((i) => i.last_run?.life === 'running').length;
  const firstJob = jobs.find((j) => j.life === 'left' || j.life === 'stale');
  const urgent = blockers[0] ? { text: `${blockers[0].doc} › ${blockers[0].b.block}: ${blockers[0].b.why}`, tone: 'failed' as Tone, source: blockers[0].b.source }
    : firstJob ? { text: `job ${firstJob.id} (${firstJob.label}): ${firstJob.life_why ?? firstJob.life}`, tone: 'attention' as Tone, source: firstJob.source }
      : items.find((i) => i.last_run?.life === 'running') ? (() => { const i = items.find((x) => x.last_run?.life === 'running')!; return { text: `${i.doc} › ${i.last_run!.target}: running`, tone: 'running' as Tone, source: i.last_run!.source }; })()
        : undefined;
  const by = (l: Life): number => jobs.filter((j) => j.life === l).length;
  return {
    ...out,
    ...(s.jobs.named ? {} : { state: 'partial' as const, why: 'no jobs folder was named: runs are shown as their documents name them, none proven running' }),
    items: items.slice(0, ITEMS_MAX), more: Math.max(0, items.length - ITEMS_MAX) + s.workflows.value.more,
    jobs: jobs.slice(0, ITEMS_MAX), jobs_more: Math.max(0, jobs.length - ITEMS_MAX),
    summary: `${plural(items.length + s.workflows.value.more, 'document')}, ${runningRuns} running, ${plural(blockers.length, 'blocker')}${by('left') + by('stale') ? `, ${plural(by('left') + by('stale'), 'job')} left` : ''}`,
    counts: [
      count(items.length + s.workflows.value.more, items.length + s.workflows.value.more === 1 ? 'workflow document' : 'workflow documents'),
      count(runningRuns, 'with a run running now (proven)', 'with a run running now (proven)'),
      count(blockers.length, blockers.length === 1 ? 'blocker (a failed block, a run left or a decision)' : 'blockers (failed blocks, runs left, decisions)'),
      ...(by('running') ? [count(by('running'), 'job of the project running (proven)', 'jobs of the project running (proven)')] : []),
      ...(by('left') + by('stale') ? [count(by('left') + by('stale'), 'job left or stale by a Timmy that ended', 'jobs left or stale by a Timmy that ended')] : []),
    ],
    ...(urgent ? { urgent } : {}),
  };
}

// ── apps, artifacts and results ──────────────────────────────────────────────

export function appsSection(s: Sources): AppsSection {
  const out: AppsSection = { ...base('apps', s), runs: [], runs_more: 0, artifacts: [], artifacts_more: 0, results: [], results_more: 0 };
  const problems: string[] = [];
  const runs: AppRunItem[] = [];
  const artifacts: ArtifactItem[] = [];
  const seen = new Set<string>();
  const addArtifact = (path: string, role: string, by: string, board: OverviewSource['board']): void => {
    // What a run kept about itself (its record, transcript, logs) and Timmy's own working files are not what it made.
    if (seen.has(path) || path.startsWith('.timmy/') || SKIP_ROLE.test(role)) return;
    const k = artifactKind(path);
    if (!k) return;
    seen.add(path);
    artifacts.push({ path, kind: k.kind, ...(k.editor ? { editor: k.editor } : {}), role, by, source: { record: path, command: artifactCommand(path, role), ...(board ? { board } : {}) } });
  };
  let runsMore = 0;
  if (s.room.ok && s.room.value.groups.length) {
    const r = roomRuns(s.room.value, ['native', 'recipe', 'mcp']);
    runsMore = r.more;
    for (const run of r.runs) {
      const life = run.running ? (s.jobs.named ? jobLife(run.job ? s.jobMap.get(run.job) : undefined) : { life: 'unknown' as Life, why: 'no jobs folder was named' }) : { life: 'ended' as Life };
      runs.push({
        kind: run.kind as AppRunItem['kind'], id: run.id, app: run.owner, ...(run.harness ? { harness: run.harness } : {}), state: run.state, tone: toneOf(run.tone),
        life: life.life, ...(life.why ? { life_why: life.why } : {}), outputs: run.outputs.filter((o) => o.role !== 'record').length,
        ...(run.operation ? { operation: run.operation } : {}),
        source: { record: run.record ?? null, command: `/room ${run.id}`, board: 'room', ...(run.receipt ? { receipt: run.receipt } : {}) },
      });
    }
    // The files the runs made (the Control Room lists only those that are there): editable natives, exports and previews.
    // A flow's record names the files of its steps (its agent's change, its app's exports): it is named as their maker first.
    const view = s.room.value;
    const made = ['flow', 'native', 'recipe', 'agent'].flatMap((kind) => roomRuns(view, [kind]).runs);
    for (const run of made) for (const o of run.outputs) addArtifact(o.path, o.role, `${run.owner} ${run.id}`, run.kind === 'flow' ? 'flows' : 'room');
  } else problems.push(`the app runs could not be read: ${s.room.ok ? s.room.value.notes[0] ?? 'no runs' : s.room.error}`);
  // Workflow runs' outputs, as their sealed outcomes name them and as they are now.
  if (s.workflows.ok) {
    for (const w of s.workflows.value.list) for (const r of w.connected?.runs ?? []) for (const o of r.outputs) if (!/^not there|gone/.test(o.note)) addArtifact(o.rel, `written by workflow run ${r.job}`, `${w.rel} › ${r.target} (run ${r.job})`, 'workflows');
  }
  // VoxVision's views in Rerun (the user's own viewer, started apart from Timmy), and its highlights: readbacks to look at.
  if (s.vox.ok) {
    for (const c of s.vox.value.cards) {
      for (const v of c.views ?? []) {
        runs.push({
          kind: 'viewer', id: `${c.id}@${v.at}`, app: v.viewer === 'rerun' ? "Rerun's viewer" : v.viewer, ...(v.program ? { harness: v.program } : {}),
          state: `opened on ${c.file}: ${plural(v.passed.length, 'file')} passed${v.notPassed.length ? `, ${v.notPassed.length} not` : ''}`, tone: 'neutral',
          life: 'unknown', life_why: 'a window on your computer that Timmy started apart from itself and does not follow', outputs: 0,
          source: { record: c.file, command: `/vox view ${c.id}`, board: 'voxvision', ...(v.receipt ? { receipt: v.receipt } : {}) },
        });
      }
      for (const h of c.highlights) if (h.shown) addArtifact(h.path, `a VoxVision readback (${h.type ?? 'highlight'})`, `VoxVision ${c.id}`, 'voxvision');
    }
  }
  artifacts.sort((a, b) => ARTIFACT_ORDER[a.kind] - ARTIFACT_ORDER[b.kind]);
  // Results: what each recent operation changed, checked now (the review).
  let results: ResultItem[] = [];
  if (s.review.ok) {
    results = s.review.value.operations.filter((o) => o.changes.length).map((o): ResultItem => {
      const first = o.changes[0];
      return {
        operation: o.id, request: cleanLine(o.request, s.scrub, 160), changes: o.changes.length + o.more,
        ...(first ? { first: { path: first.path, how: first.how, now: first.now.state } } : {}),
        source: { record: o.record ?? null, command: `/review ${o.id}`, board: 'review' },
      };
    });
  } else problems.push(`the review could not be read: ${s.review.error}`);
  const changes = results.reduce((n, r) => n + r.changes, 0);
  const k = (kind: ArtifactItem['kind']): number => artifacts.filter((a) => a.kind === kind).length;
  const failedRun = runs.find((r) => r.tone === 'failed');
  const liveRun = runs.find((r) => r.life === 'left' || r.life === 'stale') ?? runs.find((r) => r.life === 'running');
  const urgent = failedRun ? { text: `${failedRun.app} ${failedRun.id}: ${failedRun.state}`, tone: 'failed' as Tone, source: failedRun.source }
    : liveRun ? { text: `${liveRun.app} ${liveRun.id}: ${liveRun.life === 'running' ? liveRun.state : liveRun.life_why ?? liveRun.life}`, tone: liveRun.life === 'running' ? 'running' as Tone : 'attention' as Tone, source: liveRun.source }
      : results[0] ? { text: `operation ${results[0].operation} changed ${plural(results[0].changes, 'file')}: ${results[0].request}`, tone: 'neutral' as Tone, source: results[0].source }
        : undefined;
  return {
    ...out,
    ...(problems.length ? { state: runs.length || artifacts.length || results.length ? 'partial' as const : 'unknown' as const, why: problems.join('; ') } : {}),
    runs: runs.slice(0, ITEMS_MAX), runs_more: Math.max(0, runs.length - ITEMS_MAX) + runsMore,
    artifacts: artifacts.slice(0, ITEMS_MAX + 4), artifacts_more: Math.max(0, artifacts.length - (ITEMS_MAX + 4)),
    results: results.slice(0, 6), results_more: Math.max(0, results.length - 6),
    summary: `${plural(runs.length + runsMore, 'app run')}, ${plural(artifacts.length, 'file')} (${k('editable')} editable), ${plural(changes, 'change')} to review`,
    counts: [
      count(runs.length + runsMore, 'app run read (native apps, recipes, MCP calls, viewers)', 'app runs read (native apps, recipes, MCP calls, viewers)'),
      count(k('editable'), 'editable file', 'editable files'), count(k('export'), 'export', 'exports'), count(k('preview'), 'preview', 'previews'),
      count(changes, `change to review in ${plural(results.length, 'operation')}`, `changes to review in ${plural(results.length, 'operation')}`),
    ],
    ...(urgent ? { urgent } : {}),
  };
}

// ── spatial ──────────────────────────────────────────────────────────────────

export function spatialSection(s: Sources): SpatialSection {
  const out: SpatialSection = { ...base('spatial', s), items: [], more: 0 };
  if (!s.vox.ok) return { ...out, state: 'unknown', summary: 'not known', why: `the VoxVision records could not be read: ${s.vox.error}` };
  const v = s.vox.value;
  const items: SpatialItem[] = v.cards.map((c): SpatialItem => {
    const geometry = c.inputs.some((i) => i.kind && isGeometry(i.kind as VoxKind));
    const words: Record<string, number> = {};
    for (const m of [...c.metrics, ...c.claims]) { const w = m.said?.word ?? 'unknown'; words[w] = (words[w] ?? 0) + 1; }
    const metrics = c.metrics.filter((m) => !m.malformed).map((m) => ({
      title: m.title, value: metricText({ name: m.name, value: m.value, ...(m.unit ? { unit: m.unit } : {}) }), word: m.said?.word ?? 'unknown',
      ...(m.said?.note ? { note: m.said.note } : {}), ...(m.of ? { of: m.of } : {}), ...(m.said?.recorded && m.said.recorded !== m.said.word ? { recorded: m.said.recorded } : {}),
    }));
    const highlights: SpatialHighlight[] = c.highlights.map((h) => ({
      path: h.path, ...(h.type ? { type: h.type } : {}), shown: h.shown, ...(h.why ? { why: h.why } : {}), ...(h.said?.word ? { word: h.said.word } : {}),
      from: geometry ? 'geometry' as const : 'image' as const, label: `${geometry ? 'geometry' : 'image'} from ${c.file}`,
    }));
    return {
      id: c.id, file: c.file, action: c.action, inputs: c.inputs.map((i) => ({ path: i.path, ...(i.kind ? { kind: i.kind } : {}) })), status: c.status,
      check: c.check.status, check_why: [...c.check.reasons], metrics: metrics.slice(0, 6), metrics_more: Math.max(0, metrics.length - 6), words, highlights,
      viewer: `/vox view ${c.id}`,
      source: { record: c.file, command: `/open ${c.file}`, board: 'voxvision', ...(c.check.status !== 'unverified' && c.check.receipt ? { receipt: c.check.receipt } : {}) },
    };
  });
  const shown = new Set(items.map((i) => i.file));
  const unreadable: Unreadable[] = (s.files.ok ? s.files.value.list.map((f) => f.rel) : []).filter((r) => VOX_RECORD.test(r) && !shown.has(r))
    .flatMap((r) => { const why = unreadableWhy(s.root, r, 'timmy.vox/1'); return why ? [{ record: r, why }] : []; });
  const by = (st: string): number => items.filter((i) => i.check === st).length;
  const words: Record<string, number> = {};
  for (const i of items) for (const [w, n] of Object.entries(i.words)) words[w] = (words[w] ?? 0) + n;
  const doubtful = items.find((i) => i.check !== 'verified');
  const urgent = doubtful ? { text: `${doubtful.action} ${doubtful.inputs.map((i) => i.path).join(' and ') || doubtful.file}: ${doubtful.check}${doubtful.check_why[0] ? `: ${doubtful.check_why[0]}` : ''}`, tone: 'attention' as Tone, source: doubtful.source }
    : items[0] ? { text: `${items[0].action} ${items[0].inputs.map((i) => i.path).join(' and ')}: ${items[0].status}, verified`, tone: 'neutral' as Tone, source: items[0].source } : undefined;
  return {
    ...out, items: items.slice(0, ITEMS_MAX), more: Math.max(0, items.length - ITEMS_MAX) + v.more,
    summary: `${plural(items.length + v.more, 'record')}: ${by('verified')} verified${by('stale') ? `, ${by('stale')} stale` : ''}${by('unverified') ? `, ${by('unverified')} not verified` : ''}`,
    counts: [
      count(items.length + v.more, 'VoxVision record', 'VoxVision records'),
      count(by('verified'), 'verified against its receipt', 'verified against their receipts'),
      ...(by('stale') ? [count(by('stale'), 'stale (an input changed since)')] : []),
      ...(by('unverified') ? [count(by('unverified'), 'not verified')] : []),
      ...Object.entries(words).map(([w, n]) => count(n, `value ${w}`, `values ${w}`)),
      count(items.reduce((n, i) => n + i.highlights.filter((h) => h.shown).length, 0), 'highlight shown', 'highlights shown'),
    ],
    ...(urgent ? { urgent } : {}), unreadable,
  };
}

// ── history, costs and receipts ──────────────────────────────────────────────

export function historySection(s: Sources): HistorySection {
  const out: HistorySection = {
    ...base('history', s), receipts: { known: false, total: 0, project: 0, recent: [], recent_more: 0 }, head: null,
    costs: { unknown: { runs: 0 }, free: { runs: 0 }, words: '' }, operations: { recorded: 0, running: 0, left: 0 }, lessons: {},
  };
  const problems: string[] = [];
  // Receipts: this project's newest, and the store's head verified as the existing verifier verifies it.
  const receiptsWhy = !s.chain.named ? 'no receipts store was named, so no receipt was read' : !s.chain.ok ? `the receipts store could not be read: ${s.chain.error}` : undefined;
  if (receiptsWhy) problems.push(receiptsWhy);
  const chain = s.receipts;
  const mine = chain.filter((r) => r && r.project_id === s.pid);
  const recent: ReceiptItem[] = [...mine].reverse().slice(0, 6).map((r) => ({
    id: shortReceipt(r), kind: String(r.kind), ts: String(r.ts ?? ''), ...(r.status ? { status: String(r.status) } : {}), ...(str(r.operation_id) ? { operation: String(r.operation_id) } : {}),
    source: { record: null, command: str(r.operation_id) ? `/op ${String(r.operation_id)}` : '/receipts' },
  }));
  const last = chain.at(-1);
  let head: HistorySection['head'] = null;
  if (last) {
    const v = verifyReceiptIn(chain, last.hash);
    head = {
      id: shortReceipt(last), kind: String(last.kind), ts: String(last.ts ?? ''), verified: v.ok,
      words: v.ok ? 'verified: every link of its epoch up to it, each body hash and its signature (verifyReceiptIn; timmy verify checks the whole chain)' : `not verified: ${v.reason}`,
      source: { record: null, command: 'timmy verify' },
    };
  }
  // Costs as the Control Room sums them: reported amounts summed, unknown counted apart (never 0), none not counted.
  let costs = out.costs;
  if (s.room.ok && s.room.value.groups.length) {
    const c = s.room.value.costs;
    costs = {
      ...(c.known ? { reported: { usd: c.knownUsd, runs: c.known } } : {}),
      unknown: { runs: c.unknown, ...(c.atLeastUsd > 0 ? { at_least_usd: c.atLeastUsd } : {}) }, free: { runs: c.free }, words: costsLine(c),
    };
  } else problems.push(`the costs could not be read: ${s.room.ok ? s.room.value.notes[0] ?? 'no runs' : s.room.error}`);
  // Operations: recorded, running (proven by the process that writes its record), left.
  const ops = { recorded: 0, running: 0, left: 0 };
  const unreadable: Unreadable[] = [];
  if (s.ix.ok) {
    for (const { record } of s.ix.value.records.values()) {
      ops.recorded++;
      if (record.ended !== null) continue;
      const l = operationLife(record.owner, false);
      if (l.life === 'running') ops.running++; else if (l.life === 'left') ops.left++;
    }
    for (const u of s.ix.value.unreadableRecords) unreadable.push({ record: u.rel, why: u.error });
  } else problems.push(`the operation records could not be read: ${s.ix.error}`);
  // Lessons (Timmy Memory): by status, checked now by its own reader.
  const lessons: Record<string, number> = {};
  if (s.memory.ok) {
    for (const l of s.memory.value.lessons) { const w = l.status === 'checked' && l.now.status === 'stale' ? 'stale now' : l.status; lessons[w] = (lessons[w] ?? 0) + 1; }
    if (s.memory.value.more) lessons['older, not checked here'] = s.memory.value.more;
    for (const u of s.memory.value.unreadable) unreadable.push({ record: u.file, why: u.why });
  } else problems.push(`the lessons could not be read: ${s.memory.error}`);
  const unknownState = !s.chain.ok || !s.chain.named;
  const urgent = head && !head.verified ? { text: `the receipts chain does not verify at its head ${head.id}: ${head.words}`, tone: 'failed' as Tone, source: head.source }
    : receiptsWhy && s.chain.named ? { text: `unknown: ${receiptsWhy}`, tone: 'attention' as Tone, source: { record: null, command: 'timmy verify' } }
    : costs.unknown.runs ? { text: `${plural(costs.unknown.runs, 'run')} of unknown cost: a request went out and no cost came back`, tone: 'attention' as Tone, source: { record: null, command: '/room', board: 'room' as const } }
      : unreadable[0] ? { text: `${unreadable[0].record} could not be read: ${unreadable[0].why}`, tone: 'attention' as Tone, source: { record: unreadable[0].record, command: `/open ${unreadable[0].record}` } }
        : recent[0] ? { text: `newest receipt ${recent[0].id} (${recent[0].kind}${recent[0].status ? `, ${recent[0].status}` : ''})`, tone: 'neutral' as Tone, source: recent[0].source } : undefined;
  return {
    ...out,
    ...(problems.length ? { state: unknownState && !s.room.ok ? 'unknown' as const : 'partial' as const, why: problems.join('; ') } : {}),
    receipts: { known: !receiptsWhy, ...(receiptsWhy ? { why: receiptsWhy } : {}), total: chain.length, project: mine.length, recent, recent_more: Math.max(0, mine.length - recent.length) },
    head, costs, operations: ops, lessons,
    summary: [receiptsWhy ? 'receipts not known' : plural(mine.length, 'receipt'), head ? `head ${head.verified ? 'verified' : 'NOT verified'}` : receiptsWhy ? 'head not known' : 'no receipts yet', costs.reported ? `$${costs.reported.usd.toFixed(4)} reported (${costs.reported.runs})` : 'no reported cost', `${costs.unknown.runs} unknown cost`].join(', '),
    counts: [
      ...(receiptsWhy ? [] : [count(mine.length, 'receipt of this project', 'receipts of this project'), count(chain.length, 'receipt in the store (every project)', 'receipts in the store (every project)')]),
      ...(costs.reported ? [count(costs.reported.runs, `run with a reported cost, $${costs.reported.usd.toFixed(4)}`, `runs with a reported cost, $${costs.reported.usd.toFixed(4)} in all`)] : []),
      count(costs.unknown.runs, 'run of unknown cost (never summed as 0)', 'runs of unknown cost (never summed as 0)'),
      count(costs.free.runs, 'run free on a local endpoint', 'runs free on a local endpoint'),
      count(ops.recorded, 'operation recorded', 'operations recorded'),
      ...(ops.left ? [count(ops.left, 'operation left by a Timmy that ended', 'operations left by a Timmy that ended')] : []),
    ],
    ...(urgent ? { urgent } : {}), unreadable,
  };
}

// ── project ──────────────────────────────────────────────────────────────────

export function projectSection(s: Sources): ProjectSection {
  const out: ProjectSection = { ...base('project', s), name: s.name, project_id: s.pid, changed: { at: null, basis: '' }, canvas: { state: 'unknown', words: '' } };
  // When it last changed: the newest of its files' modification times (as the board lists them) and its records.
  let newest = 0;
  const parts: string[] = [];
  if (s.files.ok) {
    for (const f of s.files.value.list) if (f.mtimeMs > newest) newest = f.mtimeMs;
    parts.push(`${plural(s.files.value.list.length, 'project file')}${s.files.value.truncated ? ' (the first 2,000)' : ''} (their modification times)`);
  }
  const mine = s.receipts.filter((r) => r && r.project_id === s.pid);
  for (const r of mine) { const t = Date.parse(String(r.ts ?? '')); if (Number.isFinite(t) && t > newest) newest = t; }
  parts.push(plural(mine.length, 'receipt'));
  if (s.ix.ok) {
    for (const { record } of s.ix.value.records.values()) for (const t of [record.started, record.ended]) { const ms = t ? Date.parse(t) : Number.NaN; if (Number.isFinite(ms) && ms > newest) newest = ms; }
    parts.push(plural(s.ix.value.records.size, 'operation record'));
  }
  const changed = { at: newest ? new Date(newest).toISOString() : null, basis: `the newest of ${parts.join(', ')}` };
  // Timmy Canvas: what the REPL found (it asks the canvas), else whether a canvas server of this Timmy home runs.
  let canvas: ProjectSection['canvas'];
  if (s.canvas) canvas = { state: s.canvas.tone, words: s.canvas.words, ...(s.canvas.command ? { command: s.canvas.command } : {}) };
  else {
    const port = studioPort(s.env);
    let token: string | null = null;
    try { token = readProjectToken(canvasDir(s.env), port); } catch { token = null; }
    canvas = token
      ? { state: 'running', words: `a Timmy Canvas server of this Timmy home runs on port ${port}; whether it shows this project is checked only by a REPL (/canvas)`, command: '/canvas' }
      : { state: 'not found', words: `no Timmy Canvas server of this Timmy home was found on port ${port} (no token file whose process runs): /canvas open starts one and names this project to it`, command: '/canvas open' };
  }
  return {
    ...out, ...(s.files.ok ? {} : { state: 'partial' as const, why: `the project's files could not be listed: ${s.files.error}` }),
    changed, canvas,
    summary: `${s.name}, changed ${changed.at ? `${changed.at.slice(0, 16).replace('T', ' ')} UTC` : 'at an unknown time'}, canvas ${canvas.state}`,
    counts: [
      ...(s.files.ok ? [count(s.files.value.list.length, 'project file listed', s.files.value.truncated ? 'project files listed (the first 2,000)' : 'project files listed')] : []),
      ...(s.workflows.ok ? [count(s.workflows.value.list.length + s.workflows.value.more, 'workflow document', 'workflow documents')] : []),
    ],
    // The board's canvas line is drawn only by a REPL that checked the canvas (given); otherwise no board section shows it.
    ...(canvas.state !== 'same' ? { urgent: { text: `Timmy Canvas: ${canvas.words}`, tone: 'neutral' as Tone, source: { record: null, command: canvas.command ?? '/canvas', ...(s.canvas ? { board: 'canvas' as const } : {}) } } } : {}),
  };
}

/** A job's workflow document and block, for the map (runOf, as the board reads it). */
export const workflowRunOf = (j: JobRecord): { doc: string; target: string } | undefined => runOf(j);
