/**
 * The unified Workspace order (2026-10-27): the canvas agent. A person names a goal (and, if they like, a selection of the
 * board's nodes); the agent proposes edits to the board's executable workflow in the SAME operations a person makes by hand
 * (add an operation node, connect one of its typed ports to a file on the board, set a parameter, run it), and the page
 * applies them through the same functions a person's presses use (./timmy-app/src/pages/op-node.jsx), so every edit is
 * visible, validated and kept in the board, and every run is dispatched through /api/workflow (src/companion/workflow-ops.ts)
 * with `by: 'agent'`.
 *
 *   GET  /api/canvas-agent/harness          the harness the agent would use now, or why it is off (nothing is sent)
 *   POST /api/canvas-agent/plan             { board, goal, selection?, mode, budget?, previous? }: one plan, asked of the model
 *   GET  /api/canvas-agent/plans?board=     the board's plans, newest first
 *   GET  /api/canvas-agent/plans/:id        one plan
 *   POST /api/canvas-agent/plans/:id/applied { n, shape?, run?, words? }: the page applied step n (the record keeps it)
 *   POST /api/canvas-agent/plans/:id/stop   the person pressed Stop: the record says stopped; nothing more is applied
 *
 * The harness: the project's chat route (src/companion/chat-route.ts pageRoute, the one route every surface reads), used here
 * ONLY when it is a model in an Ollama on this computer (a loopback address, not a ":cloud" name): that asks Ollama's /api/chat
 * once per plan, with a JSON schema as its `format`, and spends nothing. Any other route is refused with its reason, and the
 * refusal is recorded as a refusal (a setup refusal is not a run of the harness: `harnessRan: false`). OpenRouter is not wired
 * here; a paid model would spend credits, which this round holds.
 *
 * Evidence (AGENTS.md §4): the handles the model may name are the board's nodes AS SAVED at one source revision (the sha256 of
 * the saved snapshot, src/studio/document.ts): each is an enum value in the schema, so a name that is not one is not even
 * expressible. The plan's `cites` lists the handles it relies on; at admission each cited handle is resolved against that saved
 * revision (that resolution is the observation; there is no cite tool call: the model's endpoint has no tools here). A step that
 * names a handle it did not cite, a stale revision, an operation whose app is not installed, an incompatible file, a parameter
 * out of range, or an unknown ref is a problem: the plan is refused with every problem, its raw output kept (sha256 and the
 * text), never repaired. An empty plan is the model's own "nothing to do" (or unknown), never a success.
 *
 * Records: <TIMMY_HOME>/canvas-agent/<project id>/plans/<id>.json (written through a temp file and a rename).
 */
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectId } from '../project/index.js';
import { ollamaAt } from '../setup/ollama-models.js';
import { pageRoute } from './chat-route.js';
import { checkParams, compatible, operationOf, OPERATIONS, type OperationSpec } from './workflow-ops.js';

type Env = Record<string, string | undefined>;

export const PLAN_SCHEMA = 'timmy.canvas-agent-plan/1' as const;
export const MODES = ['plan', 'run', 'autopilot'] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_BUDGET = Object.freeze({ steps: 8, runs: 1, rounds: 2 });
const PLAN_ID = /^p[0-9a-f]{12}$/;
const REF = /^n[1-9]$/;
const MAX_HANDLES = 40;
const MAX_RAW = 16_000;
export const PLAN_TIMEOUT_MS = 180_000;

/** A node of the board the model may name: a file on the board (a display node) or an operation node. */
export interface Handle { id: string; kind: 'file' | 'operation'; title: string; path?: string; type?: string; op?: string; connected?: string[] }
export interface Step { n: number; do: 'add' | 'connect' | 'set' | 'run'; ref?: string; operation?: string; params?: Record<string, string | number>; node?: string; port?: string; from?: string; param?: string; value?: string | number; words: string }
export interface Harness { ready: boolean; kind: 'ollama-local' | 'none'; model?: string; origin?: string; label: string; words: string }
export interface PlanRecord {
  schema: typeof PLAN_SCHEMA; id: string; board: string; boardRevision: number; sourceRevision: string | null;
  goal: string; mode: Mode; budget: { steps: number; runs: number; rounds: number }; round: number; previous: string | null;
  principal: string; createdAt: string; updatedAt: string;
  harness: { kind: Harness['kind']; model: string | null; label: string };
  harnessRan: boolean;
  handles: Handle[]; cites: string[];
  state: 'proposed' | 'refused' | 'applying' | 'applied' | 'stopped';
  say: string; done: boolean | null; steps: Step[]; problems: string[]; refusal: string | null;
  raw: { sha256: string; text: string; truncated: boolean } | null;
  model: { evalCount: number | null; promptEvalCount: number | null; ms: number | null; doneReason: string | null } | null;
  applied: Array<{ n: number; shape?: string; run?: string; words?: string; at: string }>;
}

export interface AgentScope { principal: string; home: string; project: { name: string; root: string }; env: Env }
export interface AgentDeps {
  withToken: express.RequestHandler; withUser: express.RequestHandler;
  scopeOf: (req: express.Request) => AgentScope | null;
  /** the board as saved (its revision, the sha256 of its snapshot and the snapshot), or null for a board the project has not */
  boardOf: (req: express.Request, board: string) => { revision: number; sourceRevision: string | null; snapshot: unknown } | null;
  /** the hosted apps (the mini-app host's listing): an operation is offered only when its app can be hosted here */
  apps: (req: express.Request) => Array<{ id: string; title: string; hostable: boolean; problem: string | null }> | null;
  /** tests: the fetch Ollama is asked through */
  fetch?: typeof fetch;
}

// ── the harness ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The harness now: the project's chat route when it is a model in this computer's Ollama; otherwise off, with why. */
export function harnessNow(env: Env, cwd: string): Harness {
  const r = pageRoute(env, cwd);
  if (r.kind === 'local' && r.ready) {
    const at = ollamaAt(r.host);
    if ('error' in at) return { ready: false, kind: 'none', label: 'Agent off: its Ollama address is not usable', words: `The chat's Ollama address is not one Timmy uses (${at.error}). Nothing is sent.` };
    if (r.cloud) return { ready: false, kind: 'none', model: r.model, label: `Agent off: ${r.model} is a cloud model`, words: `The chat's model ${r.model} runs on Ollama's servers, so the board would leave this computer under your Ollama account. The canvas agent uses a model on this computer only. Nothing is sent.` };
    if (!r.loopback) return { ready: false, kind: 'none', model: r.model, label: 'Agent off: Ollama is on another computer', words: `The chat's Ollama (${at.host}) is not this computer. The canvas agent uses a model on this computer only. Nothing is sent.` };
    return { ready: true, kind: 'ollama-local', model: r.model, origin: at.origin, label: `${r.model} · Ollama on this computer · no charge`, words: `The agent asks ${r.model} in this computer's Ollama (the chat's model), once per plan, with the board's nodes as saved. Nothing leaves this computer and nothing is charged.` };
  }
  if (r.kind === 'openrouter') return { ready: false, kind: 'none', model: r.model, label: 'Agent off: the chat route is OpenRouter', words: `The chat's route is ${r.model} through OpenRouter. The canvas agent is wired to a model in this computer's Ollama only (and a paid model would spend credits, which this round holds). Choose a local model for chat (timmy init --chat local) to use it. Nothing is sent.` };
  return { ready: false, kind: 'none', label: 'Agent off: no chat model', words: `${r.words.replace(/^Send is off: /, 'No model for the agent: ')}`.slice(0, 600) };
}

// ── the board's handles ─────────────────────────────────────────────────────────────────────────────────────────────────

const parse = <T>(s: unknown, d: T): T => { try { return typeof s === 'string' && s ? JSON.parse(s) as T : d; } catch { return d; } };

/** The board's nodes as saved: its files (display nodes) and its operation nodes; `selection` narrows them (unknown ids are dropped). */
export function handlesOf(snapshot: unknown, selection: string[] = []): Handle[] {
  const store = snapshot && typeof snapshot === 'object' ? (snapshot as { store?: Record<string, any> }).store ?? {} : {};
  const shapes = Object.values(store).filter((r: any) => r && r.typeName === 'shape');
  const want = new Set(selection);
  const out: Handle[] = [];
  for (const s of shapes as any[]) {
    if (want.size && !want.has(s.id)) continue;
    if (s.type === 'timmy-display' && typeof s.props?.path === 'string' && s.props.path) {
      out.push({ id: s.id, kind: 'file', title: String(s.props.title || s.props.path.split('/').pop()).slice(0, 80), path: s.props.path, type: String(s.props.kind || 'file') });
    } else if (s.type === 'timmy-op' && typeof s.props?.op === 'string') {
      const inputs = parse<Record<string, { path?: string }>>(s.props.inputs, {});
      out.push({ id: s.id, kind: 'operation', title: String(s.props.title || s.props.op).slice(0, 80), op: s.props.op, connected: Object.keys(inputs) });
    }
    if (out.length >= MAX_HANDLES) break;
  }
  return out;
}

// ── the model's answer: a schema, and the admission check ─────────────────────────────────────────────────────────────────

/** The JSON schema the model's answer must follow (Ollama's `format`): every name it can give is an enum of what is here. */
export function planFormat(ops: readonly OperationSpec[], handles: Handle[], budget: { steps: number }): Record<string, unknown> {
  const files = handles.filter((h) => h.kind === 'file').map((h) => h.id);
  const opNodes = handles.filter((h) => h.kind === 'operation').map((h) => h.id);
  const refs = Array.from({ length: Math.min(9, budget.steps) }, (_, i) => `n${i + 1}`);
  const ports = [...new Set(ops.flatMap((o) => o.inputs.map((p) => p.name)))];
  const params = [...new Set(ops.flatMap((o) => o.params.map((p) => p.name)))];
  const enumOr = (xs: string[]) => (xs.length ? { type: 'string', enum: xs } : { type: 'string', maxLength: 0 });
  return {
    type: 'object', additionalProperties: false, required: ['say', 'cites', 'steps', 'done'],
    properties: {
      say: { type: 'string', maxLength: 300 },
      cites: { type: 'array', maxItems: MAX_HANDLES, items: enumOr(handles.map((h) => h.id)) },
      steps: {
        type: 'array', maxItems: budget.steps,
        items: {
          type: 'object', additionalProperties: false, required: ['do'],
          properties: {
            do: { type: 'string', enum: ['add', 'connect', 'set', 'run'] },
            ref: enumOr(refs), operation: enumOr(ops.map((o) => o.id)),
            node: enumOr([...refs, ...opNodes]), port: enumOr(ports), from: enumOr(files),
            param: enumOr(params), value: { type: 'string', maxLength: 80 },
          },
        },
      },
      done: { type: 'boolean' },
    },
  };
}

/** The words the model is asked with: what it may use, the goal, and (autopilot's next round) what the last round did. */
export function planPrompt(o: { goal: string; ops: readonly OperationSpec[]; unavailable: Array<{ id: string; why: string }>; handles: Handle[]; budget: { steps: number; runs: number }; previous?: { say: string; outcomes: string[] } | null }): { system: string; user: string } {
  const system = [
    'You edit a Timmy Workspace board: a canvas of files and executable operation nodes. You answer with JSON only, in the given schema.',
    'Steps: {"do":"add","ref":"n1","operation":<id>} adds an operation node; {"do":"connect","node":<ref or operation node>,"port":<port>,"from":<file node>} connects a file on the board to one of its input ports; {"do":"set","node":…,"param":<name>,"value":…} sets a parameter; {"do":"run","node":…} runs it.',
    'Name only what is listed. A file can feed a port only when its extension is one the port accepts. List in "cites" every node you name. Use at most the step and run budget. If the goal cannot be done with what is listed, give no steps and say why in "say". Set "done" true when the board already does what the goal asks.',
  ].join('\n');
  const opLines = o.ops.map((op) => `- ${op.id}: ${op.label}. Inputs: ${op.inputs.map((p) => `${p.name} (${p.accepts.map((x) => `.${x}`).join(' ')})`).join(', ') || 'none'}. Parameters: ${op.params.map((p) => (p.kind === 'choice' ? `${p.name} one of ${p.choices!.join('/')}` : p.kind === 'number' ? `${p.name} ${p.min}–${p.max}` : `${p.name} text`)).join(', ') || 'none'}.`);
  const handleLines = o.handles.map((h) => (h.kind === 'file' ? `- ${h.id}: file ${h.path} (${h.type})` : `- ${h.id}: operation node ${h.op} "${h.title}"${h.connected && h.connected.length ? `, connected: ${h.connected.join(', ')}` : ', nothing connected'}`));
  const user = [
    `Goal: ${o.goal}`,
    '', 'Operations you can add:', ...(opLines.length ? opLines : ['(none: no app for an operation is installed here)']),
    ...(o.unavailable.length ? ['', 'Not available here (do not use):', ...o.unavailable.map((u) => `- ${u.id}: ${u.why}`)] : []),
    '', 'Nodes on the board:', ...(handleLines.length ? handleLines : ['(none)']),
    '', `Budget: at most ${o.budget.steps} steps and ${o.budget.runs} run step${o.budget.runs === 1 ? '' : 's'}.`,
    ...(o.previous ? ['', `Last round: ${o.previous.say}`, ...o.previous.outcomes.map((x) => `- ${x}`)] : []),
  ].join('\n');
  return { system, user };
}

/** The model's answer admitted: every step checked against the board as saved, the operations here and the budget. */
export function admitPlan(raw: unknown, o: { handles: Handle[]; ops: readonly OperationSpec[]; budget: { steps: number; runs: number } }): { steps: Step[]; cites: string[]; say: string; done: boolean | null; problems: string[] } {
  const problems: string[] = [];
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!a) return { steps: [], cites: [], say: '', done: null, problems: ['The answer is not a JSON object.'] };
  const say = typeof a.say === 'string' ? a.say.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const done = typeof a.done === 'boolean' ? a.done : null;
  const byId = new Map(o.handles.map((h) => [h.id, h]));
  const cites = Array.isArray(a.cites) ? [...new Set(a.cites.filter((c): c is string => typeof c === 'string'))] : [];
  for (const c of cites) if (!byId.has(c)) problems.push(`It cites ${JSON.stringify(c).slice(0, 60)}, which is not a node on the board as saved.`);
  const rawSteps = Array.isArray(a.steps) ? a.steps : [];
  if (rawSteps.length > o.budget.steps) problems.push(`${rawSteps.length} steps: over the budget of ${o.budget.steps}.`);
  const refs = new Map<string, OperationSpec>();
  const steps: Step[] = [];
  let runs = 0;
  const opAt = (node: unknown): OperationSpec | null => {
    if (typeof node !== 'string') return null;
    if (REF.test(node)) return refs.get(node) ?? null;
    const h = byId.get(node);
    return h && h.kind === 'operation' && h.op ? operationOf(h.op) ?? null : null;
  };
  const cited = (id: string): boolean => REF.test(id) || cites.includes(id);
  rawSteps.slice(0, o.budget.steps).forEach((x, i) => {
    const n = i + 1;
    const s = x && typeof x === 'object' ? x as Record<string, unknown> : {};
    const bad = (why: string) => problems.push(`Step ${n}: ${why}`);
    if (s.do === 'add') {
      const op = typeof s.operation === 'string' ? o.ops.find((p) => p.id === s.operation) : undefined;
      if (!op) { bad(`no operation ${JSON.stringify(String(s.operation ?? '')).slice(0, 60)} can be added here.`); return; }
      if (typeof s.ref !== 'string' || !REF.test(s.ref) || refs.has(s.ref)) { bad(`an added node needs a new ref (n1–n9), not ${JSON.stringify(String(s.ref ?? '')).slice(0, 20)}.`); return; }
      refs.set(s.ref, op);
      steps.push({ n, do: 'add', ref: s.ref, operation: op.id, words: `Add “${op.label}” (${s.ref})` });
    } else if (s.do === 'connect') {
      const op = opAt(s.node);
      if (!op) { bad(`it connects to ${JSON.stringify(String(s.node ?? '')).slice(0, 60)}, which is not an operation node here.`); return; }
      if (typeof s.node === 'string' && !cited(s.node)) { bad(`it names ${s.node} without citing it.`); return; }
      const port = op.inputs.find((p) => p.name === s.port);
      if (!port) { bad(`${op.label} has no input ${JSON.stringify(String(s.port ?? '')).slice(0, 30)}.`); return; }
      const from = typeof s.from === 'string' ? byId.get(s.from) : undefined;
      if (!from || from.kind !== 'file' || !from.path) { bad(`it connects ${JSON.stringify(String(s.from ?? '')).slice(0, 60)}, which is not a file on the board as saved.`); return; }
      if (!cited(from.id)) { bad(`it names ${from.id} without citing it.`); return; }
      if (!compatible(port, from.path)) { bad(`${from.path.split('/').pop()} cannot feed ${port.label} (it takes ${port.accepts.map((e) => `.${e}`).join(', ')}).`); return; }
      steps.push({ n, do: 'connect', node: s.node as string, port: port.name, from: from.id, words: `Connect ${from.path.split('/').pop()} to ${port.label} of ${String(s.node)}` });
    } else if (s.do === 'set') {
      const op = opAt(s.node);
      if (!op) { bad(`it sets a parameter of ${JSON.stringify(String(s.node ?? '')).slice(0, 60)}, which is not an operation node here.`); return; }
      if (typeof s.node === 'string' && !cited(s.node)) { bad(`it names ${s.node} without citing it.`); return; }
      const prm = op.params.find((p) => p.name === s.param);
      if (!prm) { bad(`${op.label} has no parameter ${JSON.stringify(String(s.param ?? '')).slice(0, 30)}.`); return; }
      const v = typeof s.value === 'string' || typeof s.value === 'number' ? s.value : undefined;
      const c = checkParams(op, { [prm.name]: v });
      if (c.problems.length || v === undefined) { bad(c.problems[0] ?? `${prm.label}: no value.`); return; }
      steps.push({ n, do: 'set', node: s.node as string, param: prm.name, value: c.params[prm.name], words: `Set ${prm.label} of ${String(s.node)} to ${c.params[prm.name]}` });
    } else if (s.do === 'run') {
      const op = opAt(s.node);
      if (!op) { bad(`it runs ${JSON.stringify(String(s.node ?? '')).slice(0, 60)}, which is not an operation node here.`); return; }
      if (typeof s.node === 'string' && !cited(s.node)) { bad(`it names ${s.node} without citing it.`); return; }
      runs += 1;
      if (runs > o.budget.runs) { bad(`a run over the budget of ${o.budget.runs}.`); return; }
      steps.push({ n, do: 'run', node: s.node as string, words: `Run ${String(s.node)} (${op.label})` });
    } else bad(`${JSON.stringify(String(s.do ?? '')).slice(0, 20)} is not a step.`);
  });
  return { steps, cites, say, done, problems };
}

// ── the records ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const dirOf = (home: string, root: string): string => join(home, 'canvas-agent', projectId(root), 'plans');
function writePlan(home: string, root: string, p: PlanRecord): void {
  const dir = dirOf(home, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${p.id}.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, `${p.id}.json`));
}
export function readPlan(home: string, root: string, id: string): PlanRecord | null {
  if (!PLAN_ID.test(id)) return null;
  try { return JSON.parse(readFileSync(join(dirOf(home, root), `${id}.json`), 'utf8')) as PlanRecord; } catch { return null; }
}
function listPlans(home: string, root: string): PlanRecord[] {
  let names: string[] = [];
  try { names = readdirSync(dirOf(home, root)).filter((n) => /^p[0-9a-f]{12}\.json$/.test(n)); } catch { return []; }
  return names.map((n) => readPlan(home, root, n.slice(0, -5))).filter((p): p is PlanRecord => Boolean(p)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Ollama's answer, whether it streamed JSON lines or gave one object: its content, and its counts. */
async function askOllama(f: typeof fetch, origin: string, body: unknown, signal: AbortSignal): Promise<{ content: string; evalCount: number | null; promptEvalCount: number | null; doneReason: string | null }> {
  const res = await f(`${origin}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) { let why = text.slice(0, 300); try { why = String((JSON.parse(text) as { error?: unknown }).error ?? why); } catch { /* its words as given */ } throw new Error(`Ollama answered ${res.status}: ${why}`); }
  let content = ''; let evalCount: number | null = null; let promptEvalCount: number | null = null; let doneReason: string | null = null;
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    if (j.error) throw new Error(`Ollama: ${String(j.error).slice(0, 300)}`);
    if (j.message && typeof j.message.content === 'string') content += j.message.content;
    if (typeof j.eval_count === 'number') evalCount = j.eval_count;
    if (typeof j.prompt_eval_count === 'number') promptEvalCount = j.prompt_eval_count;
    if (typeof j.done_reason === 'string') doneReason = j.done_reason;
  }
  return { content, evalCount, promptEvalCount, doneReason };
}

export function mountCanvasAgent(app: express.Express, deps: AgentDeps): void {
  const guards = [deps.withToken, deps.withUser];
  const json = express.json({ limit: '16kb' });
  const f = deps.fetch ?? fetch;
  const no = (res: express.Response, status: number, error: string, more: Record<string, unknown> = {}) => { res.status(status).set('Cache-Control', 'no-store').json({ ok: false, error, ...more }); };

  app.get('/api/canvas-agent/harness', ...guards, (req, res) => {
    const sc = deps.scopeOf(req);
    if (!sc) { no(res, 404, 'No project is open for this page.'); return; }
    const h = harnessNow(sc.env, sc.project.root);
    res.set('Cache-Control', 'no-store').json({ ok: true, harness: { ready: h.ready, kind: h.kind, model: h.model ?? null, label: h.label, words: h.words } });
  });

  app.post('/api/canvas-agent/plan', ...guards, json, async (req, res) => {
    const sc = deps.scopeOf(req);
    if (!sc) { no(res, 404, 'No project is open for this page.'); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const goal = typeof b.goal === 'string' ? b.goal.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
    if (!goal) { no(res, 400, 'The agent needs a goal.'); return; }
    const mode: Mode = MODES.includes(b.mode as Mode) ? b.mode as Mode : 'plan';
    const board = typeof b.board === 'string' && b.board ? b.board : 'desk';
    const bud = (b.budget && typeof b.budget === 'object' ? b.budget : {}) as Record<string, unknown>;
    const clampInt = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    const budget = { steps: clampInt(bud.steps, 1, 9, DEFAULT_BUDGET.steps), runs: clampInt(bud.runs, 0, 3, DEFAULT_BUDGET.runs), rounds: clampInt(bud.rounds, 1, 4, DEFAULT_BUDGET.rounds) };
    const previous = typeof b.previous === 'string' && PLAN_ID.test(b.previous) ? readPlan(sc.home, sc.project.root, b.previous) : null;
    if (typeof b.previous === 'string' && b.previous && !previous) { no(res, 404, 'No such earlier plan.'); return; }
    const round = previous ? previous.round + 1 : 1;
    if (previous && round > previous.budget.rounds) { no(res, 409, `The budget's ${previous.budget.rounds} rounds are used: the agent stops here.`); return; }
    const saved = deps.boardOf(req, board);
    if (!saved) { no(res, 404, `This project has no board ${JSON.stringify(board.slice(0, 40))}.`); return; }
    const expected = typeof b.revision === 'number' ? b.revision : null;
    if (expected !== null && expected !== saved.revision) { no(res, 409, `The board changed since the page read it (revision ${saved.revision}, the page had ${expected}): save, then ask again.`, { revision: saved.revision }); return; }
    const selection = Array.isArray(b.selection) ? b.selection.filter((x): x is string => typeof x === 'string').slice(0, MAX_HANDLES) : [];
    const handles = handlesOf(saved.snapshot, selection);
    const listing = deps.apps(req) ?? [];
    const can = (op: OperationSpec) => listing.find((a) => a.id === op.app);
    const ops = OPERATIONS.filter((op) => { const a = can(op); return Boolean(a && a.hostable); });
    const unavailable = OPERATIONS.filter((op) => !ops.includes(op)).map((op) => { const a = can(op); return { id: op.id, why: a ? (a.problem || 'its app is not installed here') : 'its app is not known here' }; });
    const h = harnessNow(sc.env, sc.project.root);
    const now = new Date().toISOString();
    const rec: PlanRecord = {
      schema: PLAN_SCHEMA, id: `p${randomBytes(6).toString('hex')}`, board, boardRevision: saved.revision, sourceRevision: saved.sourceRevision,
      goal, mode, budget, round, previous: previous ? previous.id : null, principal: sc.principal, createdAt: now, updatedAt: now,
      harness: { kind: h.kind, model: h.model ?? null, label: h.label }, harnessRan: false,
      handles, cites: [], state: 'refused', say: '', done: null, steps: [], problems: [], refusal: null, raw: null, model: null, applied: [],
    };
    if (!h.ready) {
      rec.refusal = h.words;
      writePlan(sc.home, sc.project.root, rec);
      res.status(409).set('Cache-Control', 'no-store').json({ ok: false, error: h.words, plan: rec });
      return;
    }
    // what the last round did, or (a refused answer) every reason it was refused: a new attempt, never a repair of the old one
    const outcomes = previous ? (previous.state === 'refused' ? [`Your last answer was refused: ${(previous.problems.length ? previous.problems : [previous.refusal ?? 'no reason kept']).join(' ')}`] : previous.applied.map((x) => `step ${x.n}: ${x.words ?? 'applied'}`)) : [];
    const prompt = planPrompt({ goal, ops, unavailable, handles, budget, previous: previous ? { say: previous.say, outcomes } : null });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('timeout')), PLAN_TIMEOUT_MS);
    // the person left (Stop, or the page closed) while the model was asked: the request is abandoned and nothing is applied
    res.on('close', () => { if (!res.writableEnded) ctl.abort(new Error('stopped')); });
    const t0 = Date.now();
    try {
      const answer = await askOllama(f, h.origin!, {
        model: h.model, stream: false, format: planFormat(ops, handles, budget), options: { temperature: 0 },
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      }, ctl.signal);
      rec.harnessRan = true;
      rec.model = { evalCount: answer.evalCount, promptEvalCount: answer.promptEvalCount, ms: Date.now() - t0, doneReason: answer.doneReason };
      rec.raw = { sha256: createHash('sha256').update(answer.content).digest('hex'), text: answer.content.slice(0, MAX_RAW), truncated: answer.content.length > MAX_RAW };
      let parsed: unknown = null;
      try { parsed = JSON.parse(answer.content); } catch { rec.problems.push('The answer is not JSON.'); }
      if (parsed !== null) {
        const a = admitPlan(parsed, { handles, ops, budget });
        Object.assign(rec, { steps: a.steps, cites: a.cites, say: a.say, done: a.done });
        rec.problems.push(...a.problems);
      }
      rec.state = rec.problems.length ? 'refused' : 'proposed';
      if (rec.problems.length) rec.steps = [];
    } catch (e) {
      const why = ctl.signal.aborted ? (String((ctl.signal.reason as Error | undefined)?.message) === 'timeout' ? `The model did not answer in ${PLAN_TIMEOUT_MS / 1000} s.` : 'Stopped before the model answered.') : (e instanceof Error ? e.message : String(e));
      rec.refusal = why;
      rec.harnessRan = !/ECONNREFUSED|fetch failed/.test(why);
      rec.state = ctl.signal.aborted && /Stopped/.test(why) ? 'stopped' : 'refused';
    } finally { clearTimeout(timer); }
    rec.updatedAt = new Date().toISOString();
    writePlan(sc.home, sc.project.root, rec);
    if (res.writableEnded || res.destroyed) return;
    res.status(rec.state === 'proposed' ? 200 : 422).set('Cache-Control', 'no-store').json({ ok: rec.state === 'proposed', ...(rec.state === 'proposed' ? {} : { error: rec.refusal ?? rec.problems.join(' ') }), plan: rec });
  });

  app.get('/api/canvas-agent/plans', ...guards, (req, res) => {
    const sc = deps.scopeOf(req);
    if (!sc) { no(res, 404, 'No project is open for this page.'); return; }
    const board = typeof req.query.board === 'string' ? req.query.board : null;
    res.set('Cache-Control', 'no-store').json({ ok: true, plans: listPlans(sc.home, sc.project.root).filter((p) => !board || p.board === board).slice(0, 30) });
  });
  app.get('/api/canvas-agent/plans/:id', ...guards, (req, res) => {
    const sc = deps.scopeOf(req);
    if (!sc) { no(res, 404, 'No project is open for this page.'); return; }
    const p = readPlan(sc.home, sc.project.root, String(req.params.id));
    if (!p) { no(res, 404, 'No such plan.'); return; }
    res.set('Cache-Control', 'no-store').json({ ok: true, plan: p });
  });
  app.post('/api/canvas-agent/plans/:id/applied', ...guards, json, (req, res) => {
    const sc = deps.scopeOf(req);
    if (!sc) { no(res, 404, 'No project is open for this page.'); return; }
    const p = readPlan(sc.home, sc.project.root, String(req.params.id));
    if (!p) { no(res, 404, 'No such plan.'); return; }
    if (p.state !== 'proposed' && p.state !== 'applying') { no(res, 409, `This plan is ${p.state}: nothing more is applied.`); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const n = Number(b.n);
    const step = p.steps.find((s) => s.n === n);
    if (!step) { no(res, 400, 'No such step in this plan.'); return; }
    if (p.applied.some((x) => x.n === n)) { no(res, 409, `Step ${n} is already applied.`); return; }
    const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : undefined);
    p.applied.push({ n, ...(str(b.shape, /^shape:[\w-]{1,80}$/) ? { shape: b.shape as string } : {}), ...(str(b.run, /^w[0-9a-f]{12}$/) ? { run: b.run as string } : {}), words: typeof b.words === 'string' ? b.words.slice(0, 300) : step.words, at: new Date().toISOString() });
    p.state = p.applied.length === p.steps.length ? 'applied' : 'applying';
    p.updatedAt = new Date().toISOString();
    writePlan(sc.home, sc.project.root, p);
    res.set('Cache-Control', 'no-store').json({ ok: true, plan: p });
  });
  app.post('/api/canvas-agent/plans/:id/stop', ...guards, json, (req, res) => {
    const sc = deps.scopeOf(req);
    if (!sc) { no(res, 404, 'No project is open for this page.'); return; }
    const p = readPlan(sc.home, sc.project.root, String(req.params.id));
    if (!p) { no(res, 404, 'No such plan.'); return; }
    if (p.state === 'proposed' || p.state === 'applying') { p.state = 'stopped'; p.updatedAt = new Date().toISOString(); writePlan(sc.home, sc.project.root, p); }
    res.set('Cache-Control', 'no-store').json({ ok: true, plan: p });
  });
}
