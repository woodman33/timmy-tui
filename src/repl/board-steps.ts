/**
 * Round R4 (H45): what every flow card on the board's Flows section shares (src/repl/board-flows.ts and the cards for
 * Blender, OpenSCAD, FreeCAD and After Effects):
 *
 *   the step strip   the flow's steps in their order, each with its state in words (completed, running, waiting, failed,
 *                    stopped, interrupted, not run), the step it ended in marked, as an ordered list (<ol>) that needs no
 *                    script. The steps are the ones each kind runs (src/repl/iterate*.ts):
 *                      tray     agent, checks, build, readback
 *                      blender  agent, checks, blender, readback
 *                      scad     agent, checks, openscad, compare (the record's `readback` step: Timmy's STL reading against
 *                               OpenSCAD's own summary; no job of its own)
 *                      freecad  agent, checks, freecad, readback
 *                      ae       agent, checks, author, render, readback
 *                    A finished record says the step it ended in (`ended_in`) and how (`outcome`): the steps before it
 *                    completed, the one it names ended as the outcome says (succeeded and differs: completed; failed;
 *                    stopped; cancelled: stopped with /stop; interrupted: recorded after a restart, src/repl/recover.ts),
 *                    and the steps after it did not run. A readback that could not start says so itself (`state: 'not
 *                    run'`). A flow still running has no record yet: its state file (.timmy/flows/<id>/state.json, its
 *                    `step`) says which step runs; the steps before it completed and the ones after it wait.
 *   details          the long parts of a card in <details>, closed by default and open when the flow failed or differs;
 *                    each keyed by the flow id (data-keep), so the live board keeps the operator's open or closed choice
 *                    across its redraws (src/repl/board-live.ts).
 *   artifacts        the files a record names that a person opens: the editable native file, the source the agent
 *                    changed, the preview or render, and the record itself, each a link (text on the live board) with its
 *                    /open command; only paths inside the project.
 *   next             an interrupted record's own next steps (src/repl/recover.ts writes them): shown as written, with the
 *                    commands they begin with that take one plain argument. Nothing here invents a way to resume a flow.
 *
 * Every string is escaped. Colour never stands alone: each state is a word, each mark has its own shape.
 */
import { diffText } from '../flows/iterate.js';
import { scadDiffText } from '../flows/iterate-scad.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';

export type FlowKind = 'tray' | 'blender' | 'scad' | 'freecad' | 'ae';
export type StepState = 'completed' | 'running' | 'waiting' | 'failed' | 'stopped' | 'interrupted' | 'not run' | 'unknown';
export interface StripStep {
  /** the step's name as the record and the state file write it ('build', 'openscad', 'readback'…) */
  step: string;
  /** the step's name on the strip ('compare' for OpenSCAD's readback step) */
  name: string;
  state: StepState;
  /** a few words from the record about the step: the job, how it was judged, the verdict */
  detail: string;
  /** on the step the flow ended in ("ended here: failed") or the step that runs ("running now") */
  here?: string;
}
export interface Strip { kind: FlowKind; outcome: string; steps: StripStep[]; note?: string }

type Obj = Record<string, unknown>;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** A detail is a few words: longer ones are cut (the card's other parts say the rest). */
const DETAIL_MAX = 90;
const cut = (s: string): string => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s);
const joined = (...parts: Array<string | undefined | false>): string => parts.filter((x): x is string => !!x).join(' · ');

/** The kind of a flow record: the tray's has no target; the others name theirs. */
export function flowKind(record: unknown): FlowKind | undefined {
  const r = obj(record);
  if (!r || r.kind !== 'iterate') return undefined;
  if (r.target === undefined) return 'tray';
  return r.target === 'blender' || r.target === 'scad' || r.target === 'freecad' || r.target === 'ae' ? r.target : undefined;
}

// ── each kind's steps, and a few words about each from the record ───────────────

interface Def { step: string; name: string; part?: string; detail: (r: Obj) => string; notRun?: (r: Obj) => boolean }

const agentDetail = (r: Obj): string => {
  const a = obj(r.agent);
  if (!a) return '';
  return joined(str(a.agent), str(a.job) && `job ${a.job as string}`, str(a.outcome) && a.outcome !== 'completed' && (a.outcome as string));
};

function checksDetail(kind: FlowKind, r: Obj): string {
  const others = obj(r.agent)?.others;
  const n = Array.isArray(others) ? others.length : 0;
  if (n) return `${n} other file${n === 1 ? '' : 's'} changed`;
  if (kind === 'tray' || kind === 'scad') {
    const p = obj(r.parameters);
    if (!p) return '';
    if (p.invalid) return kind === 'scad' ? 'the file the agent left does not check' : 'the file the agent left is not valid';
    const names = obj(p.names);
    if (names && (list(names.added).length || list(names.removed).length)) return 'parameter names added or removed';
    if (p.diff === undefined || p.diff === null) return '';
    return kind === 'scad' ? scadDiffText(p.diff) : diffText(p.diff);
  }
  const s = obj(r.script);
  const syntax = obj(s?.syntax);
  const said = !syntax ? '' : kind === 'ae'
    ? (syntax.checked === true ? (syntax.ok === true ? 'compiles' : 'does not compile') : 'not compiled')
    : (syntax.checked === true ? (syntax.ok === true ? 'parses as Python' : 'does not parse as Python') : 'not checked as Python');
  const ch = obj(s?.change);
  return joined(ch && finite(ch.added) && finite(ch.removed) && `+${ch.added} −${ch.removed} lines`, said);
}

/** An app's run (Blender, OpenSCAD, FreeCAD, After Effects, aerender): its job and how it was judged. */
const runDetail = (p: Obj | undefined): string => (p ? joined(str(p.job) && `job ${p.job as string}`, str(p.outcome) ? `judged ${p.outcome as string}` : str(p.state)) : '');
const buildDetail = (b: Obj | undefined): string => (b ? joined(str(b.operation) && `recipe job ${(b.operation as string).slice(0, 8)}`, str(b.state)) : '');
const renderDetail = (x: Obj | undefined): string => {
  if (!x) return '';
  const file = obj(x.file);
  const instead = file?.instead === true && str(file.path) ? `wrote ${(file.path as string).replace(/^.*\./, '.')} instead` : undefined;
  return joined(runDetail(x), instead);
};
const readbackDetail = (k: Obj | undefined): string => (k ? joined(str(k.verdict) ?? str(k.state), str(k.job) && `job ${k.job as string}`) : '');
const compareDetail = (k: Obj | undefined): string => (k ? (k.verdict === 'no summary' ? 'no OpenSCAD summary to compare' : str(k.verdict) ?? '') : '');
const readbackNotRun = (r: Obj): boolean => obj(r.readback)?.state === 'not run';

const AGENT: Def = { step: 'agent', name: 'agent', part: 'agent', detail: agentDetail };
const checks = (kind: FlowKind): Def => ({ step: 'checks', name: 'checks', detail: (r) => checksDetail(kind, r) });

const DEFS: Record<FlowKind, Def[]> = {
  tray: [AGENT, checks('tray'), { step: 'build', name: 'build', part: 'rebuild', detail: (r) => buildDetail(obj(r.rebuild)) }, { step: 'readback', name: 'readback', part: 'readback', detail: (r) => readbackDetail(obj(r.readback)) }],
  blender: [AGENT, checks('blender'), { step: 'blender', name: 'blender', part: 'blender', detail: (r) => runDetail(obj(r.blender)) }, { step: 'readback', name: 'readback', part: 'readback', detail: (r) => readbackDetail(obj(r.readback)) }],
  scad: [AGENT, checks('scad'), { step: 'openscad', name: 'openscad', part: 'openscad', detail: (r) => runDetail(obj(r.openscad)) }, { step: 'readback', name: 'compare', part: 'readback', detail: (r) => compareDetail(obj(r.readback)) }],
  freecad: [AGENT, checks('freecad'), { step: 'freecad', name: 'freecad', part: 'freecad', detail: (r) => runDetail(obj(r.freecad)) }, { step: 'readback', name: 'readback', part: 'readback', detail: (r) => readbackDetail(obj(r.readback)), notRun: readbackNotRun }],
  ae: [AGENT, checks('ae'), { step: 'author', name: 'author', part: 'author', detail: (r) => runDetail(obj(r.author)) }, { step: 'render', name: 'render', part: 'render', detail: (r) => renderDetail(obj(r.render)) }, { step: 'readback', name: 'readback', part: 'readback', detail: (r) => readbackDetail(obj(r.readback)), notRun: readbackNotRun }],
};

/** The step names of each kind, in order, as the strip shows them. */
export const STEP_NAMES: Record<FlowKind, readonly string[]> = {
  tray: DEFS.tray.map((x) => x.name), blender: DEFS.blender.map((x) => x.name), scad: DEFS.scad.map((x) => x.name),
  freecad: DEFS.freecad.map((x) => x.name), ae: DEFS.ae.map((x) => x.name),
};

/** How a finished flow's outcome leaves the step it ended in. */
const END_STATE: Record<string, StepState> = { succeeded: 'completed', differs: 'completed', failed: 'failed', stopped: 'stopped', cancelled: 'stopped', interrupted: 'interrupted' };

/** A step's state from its own part only (when the record does not say where it ended). */
function partState(d: Def, r: Obj): StepState {
  const p = d.part ? obj(r[d.part]) : undefined;
  if (!p) return d.part ? 'not run' : 'unknown';
  if (p.state === 'not run') return 'not run';
  const words = [p.outcome, p.state, p.verdict].filter((w): w is string => typeof w === 'string');
  if (words.includes('failed')) return 'failed';
  if (words.some((w) => w === 'completed' || w === 'succeeded' || w === 'ok' || w === 'matches')) return 'completed';
  return 'unknown';
}

const safe = (f: () => string): string => { try { return cut(f()); } catch { return ''; } };

/**
 * The steps of a flow, in order, each with its state from the record (or, for a flow that runs, from its state file's
 * `step`). Undefined for a record that is not a flow of a kind Timmy runs.
 */
export function flowSteps(record: unknown): Strip | undefined {
  const r = obj(record);
  const kind = flowKind(r);
  if (!r || !kind) return undefined;
  const defs = DEFS[kind];
  const outcome = str(r.outcome) ?? 'unknown';
  const base = defs.map((d) => ({ step: d.step, name: d.name, detail: safe(() => d.detail(r)) }));
  if (outcome === 'running') {
    const at = str(r.step);
    const i = at ? defs.findIndex((d) => d.step === at) : -1;
    if (i >= 0) return { kind, outcome, steps: base.map((s, k): StripStep => ({ ...s, state: k < i ? 'completed' : k === i ? 'running' : 'waiting', ...(k === i ? { here: 'running now' } : {}) })) };
    if (at === 'prepare') return { kind, outcome, steps: base.map((s): StripStep => ({ ...s, state: 'waiting' })), note: 'its state file says it is being prepared' };
    if (at === 'record' || at === 'done') return { kind, outcome, steps: base.map((s): StripStep => ({ ...s, state: 'completed' })), note: 'its state file says its record is being written' };
    return { kind, outcome, steps: base.map((s): StripStep => ({ ...s, state: 'unknown' })), note: at ? `its state file names a step this board does not know: ${cut(at)}` : 'its state file names no step' };
  }
  const ended = str(r.ended_in);
  const endState = END_STATE[outcome] ?? 'unknown';
  const here = `ended here: ${cut(outcome)}`;
  if (ended === 'prepare') return { kind, outcome, steps: [{ step: 'prepare', name: 'prepare', detail: '', state: endState, here }, ...base.map((s): StripStep => ({ ...s, state: 'not run' }))] };
  if (ended === 'record') return { kind, outcome, steps: [...base.map((s): StripStep => ({ ...s, state: 'completed' })), { step: 'record', name: 'record', detail: '', state: endState, here }] };
  const i = ended ? defs.findIndex((d) => d.step === ended) : -1;
  if (i < 0) {
    return {
      kind, outcome, steps: base.map((s, k): StripStep => ({ ...s, state: partState(defs[k], r) })),
      note: ended ? `the record names a step this board does not know (${cut(ended)}): each step is shown as its own part says` : 'the record does not say which step it ended in: each step is shown as its own part says',
    };
  }
  return {
    kind, outcome, steps: base.map((s, k): StripStep => {
      if (k < i) return { ...s, state: 'completed' };
      if (k > i) return { ...s, state: 'not run' };
      return { ...s, state: defs[k].notRun?.(r) === true ? 'not run' : endState, here };
    }),
  };
}

const GLYPH: Record<StepState, string> = { completed: '✓', running: '●', waiting: '○', failed: '✕', stopped: '■', interrupted: '!', 'not run': '–', unknown: '?' };
const stateClass = (s: StepState): string => s.replace(/[^a-z]/g, '');

/** The strip as an ordered list: each step's name and state in words; the step it ended in (or that runs) marked. */
export function stripHtml(s: Strip, id: string): string {
  const items = s.steps.map((x) => `<li class="st st-${stateClass(x.state)}${x.here ? ' st-here' : ''}"${x.here ? ' aria-current="step"' : ''}>`
    + `<span class="st-dot" aria-hidden="true">${GLYPH[x.state]}</span> <span class="st-name">${esc(x.name)}</span> <span class="st-state">${esc(x.state)}</span>`
    + `${x.here ? ` <span class="st-here-words">${esc(x.here)}</span>` : ''}${x.detail ? ` <span class="st-detail">${esc(x.detail)}</span>` : ''}</li>`).join('');
  return `<ol class="strip n${Math.min(s.steps.length, 7)}" aria-label="${esc(`the steps of flow ${id}`)}">${items}</ol>${s.note ? `<p class="meta strip-note">${esc(s.note)}</p>` : ''}`;
}

/** The strip of a record, or '' when it is not a flow of a kind Timmy runs. */
export function recordStrip(record: unknown, id: string): string {
  const s = flowSteps(record);
  return s ? stripHtml(s, id) : '';
}

// ── details ─────────────────────────────────────────────────────────────────────

/** Whether a card's details open by default: when the flow failed or differs. */
export const opensByDefault = (outcome: unknown): boolean => outcome === 'failed' || outcome === 'differs';

/**
 * A long part of a card in <details>, keyed `<flow-id>:<part>` (data-keep) so the live board keeps it as the operator
 * left it; `data-open-default` says it was drawn open. '' when there is nothing in it.
 */
export function detailsHtml(o: { id: string; part: string; summary: string; body: string; open: boolean }): string {
  if (!o.body) return '';
  return `<details class="more" data-keep="${esc(`${o.id}:${o.part}`)}"${o.open ? ' data-open-default open' : ''}><summary>${esc(o.summary)}</summary><div class="more-body">${o.body}</div></details>`;
}

// ── the summary ─────────────────────────────────────────────────────────────────

/** A verdict or outcome in its own word; the class only colours it (never green: a verdict is not an action). */
export const verdictWord = (word: string): string => `<strong class="vw vw-${esc(word.replace(/[^a-z]/gi, '').toLowerCase())}">${esc(word)}</strong>`;

/** The summary every card keeps visible: rows of label and (escaped) HTML, then its lines (who measured, DOCTRINE §15). */
export function summaryHtml(rows: Array<[string, string]>, after = ''): string {
  const shown = rows.filter(([, html]) => html);
  if (!shown.length && !after) return '';
  return `<section class="summary">${shown.length ? `<dl>${shown.map(([label, html]) => `<dt>${esc(label)}</dt><dd>${html}</dd>`).join('')}</dl>` : ''}${after}</section>`;
}

// ── artifacts ───────────────────────────────────────────────────────────────────

/** A path inside the project as '/'-separated parts, or null (absolute, a URL, or one that climbs out): as board.ts. */
export function projectPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

export interface Artifact { role: string; path: unknown; note?: string }
interface ArtifactHelpers { file: (p: unknown, label?: string) => string; cmd: (c: string) => string }

/**
 * The files a person opens, each with its role, a link (text on the live board) and its /open command; only paths inside
 * the project, each once. `receipts` is the card's receipts line, drawn under them.
 */
export function artifactsHtml(items: Artifact[], h: ArtifactHelpers, receipts = ''): string {
  const seen = new Set<string>();
  const rows = items.flatMap((a) => {
    const rel = projectPath(a.path);
    if (!rel || seen.has(rel)) return [];
    seen.add(rel);
    return [`<li class="art"><span class="art-role">${esc(a.role)}</span> ${h.file(rel)}${a.note ? ` <span class="tier">${esc(a.note)}</span>` : ''} ${h.cmd(`/open ${rel}`)}</li>`];
  });
  if (!rows.length && !receipts) return '';
  return `<section class="artifacts"><h4>artifacts</h4>${rows.length ? `<ul class="arts">${rows.join('')}</ul>` : ''}${receipts}</section>`;
}

// ── what an interrupted record says to do next ──────────────────────────────────

/**
 * The commands at the head of recover.ts's next steps that take one plain argument (a recipe job's UUID, a Timmy job, a
 * native run): each line keeps its own words, and only these get a copy button. Others (a new /iterate, whose instruction
 * is quoted) are shown as written, and copied by hand.
 */
const LEADING = /^\/(?:recipe (?:recover|copy) [0-9a-f-]{8,64}|jobs j[0-9a-f]{6}|freecad readback [0-9a-f-]{8,64})(?=[ ;:,]|$)/;

/** An interrupted record's next steps (recovered.next, written by src/repl/recover.ts), or ''. */
export function nextHtml(record: unknown, h: { cmd: (c: string) => string }): string {
  const r = obj(record);
  const rec = obj(r?.recovered);
  const next = list(rec?.next).slice(0, 8);
  if (!rec || !next.length) return '';
  const cmds = [...new Set(next.map((l) => LEADING.exec(l)?.[0]).filter((c): c is string => !!c))];
  const at = str(rec.at);
  return `<section class="next"><h4>${esc(`recorded after a restart${at ? ` (${at.slice(0, 16).replace('T', ' ')} UTC)` : ''}: what the record says to do next`)}</h4>`
    + `<ul>${next.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${cmds.length ? `<div class="cmds">${cmds.map((c) => h.cmd(c)).join('')}</div>` : ''}`
    + `<p class="meta">${esc('Nothing was run again; no command resumes a flow: these read what it left, or start a new one.')}</p></section>`;
}

// ── the look ────────────────────────────────────────────────────────────────────

export const STEPS_CSS = `
.grid > .card.flow { align-self: start; }
.flow ol.strip { list-style: none; margin: 2px 0 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.flow ol.strip.n1 { grid-template-columns: minmax(0, 1fr); }
.flow ol.strip.n2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.flow ol.strip.n3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.flow ol.strip.n5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.flow ol.strip.n6 { grid-template-columns: repeat(6, minmax(0, 1fr)); }
.flow ol.strip.n7 { grid-template-columns: repeat(7, minmax(0, 1fr)); }
.flow .st { position: relative; min-width: 0; padding: 30px 3px 0; text-align: center; font-size: 11.5px; line-height: 1.35; }
.flow .st::before { content: ""; position: absolute; top: 12px; left: 0; right: 0; border-top: 2px solid ${HOMEBREW.line}; }
.flow .st:first-child::before { left: 50%; }
.flow .st:last-child::before { right: 50%; }
.flow .st:only-child::before { display: none; }
.flow .st > span { display: block; overflow-wrap: anywhere; }
.flow .st > .st-dot { position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 26px; height: 26px; border-radius: 50%; border: 2px solid ${HOMEBREW.lineStrong}; background: ${HOMEBREW.surface}; color: ${HOMEBREW.textSecondary}; display: flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; font-weight: ${TYPE.weight.strong}; }
.flow .st-name { text-transform: uppercase; letter-spacing: .05em; font-weight: ${TYPE.weight.strong}; color: ${HOMEBREW.text}; }
.flow .st-state { color: ${HOMEBREW.textSecondary}; }
.flow .st-detail { color: ${HOMEBREW.textSecondary}; font-size: 11px; }
.flow .st-here-words { font-size: 11px; font-weight: ${TYPE.weight.strong}; color: ${HOMEBREW.text}; }
.flow .st-completed > .st-dot { border-color: ${HOMEBREW.text}; color: ${HOMEBREW.text}; }
.flow .st-completed .st-state { color: ${HOMEBREW.text}; }
.flow .st-running > .st-dot, .flow .st-stopped > .st-dot, .flow .st-interrupted > .st-dot { border-color: ${HOMEBREW.attention}; color: ${HOMEBREW.attention}; }
.flow .st-running .st-state, .flow .st-stopped .st-state, .flow .st-interrupted .st-state { color: ${HOMEBREW.attention}; }
.flow .st-failed > .st-dot { border-color: ${HOMEBREW.failure}; color: ${HOMEBREW.failure}; }
.flow .st-failed .st-state { color: ${HOMEBREW.failure}; }
.flow .st-waiting > .st-dot { border-style: dashed; }
.flow .st-notrun > .st-dot, .flow .st-unknown > .st-dot { border-style: dotted; }
.flow .st-notrun .st-name, .flow .st-unknown .st-name { color: ${HOMEBREW.textSecondary}; }
.flow .st-here > .st-dot { box-shadow: 0 0 0 3px ${HOMEBREW.surface}, 0 0 0 5px currentColor; }
.flow .st-here .st-name { text-decoration: underline; text-underline-offset: 3px; }
.flow .strip-note { margin: 0; }
.flow details.more { border: 1px solid ${HOMEBREW.line}; border-radius: 6px; padding: 0 10px; }
.flow details.more > summary { cursor: pointer; padding: 6px 0; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; text-transform: uppercase; letter-spacing: .06em; }
.flow details.more > summary:hover, .flow details.more > summary:focus-visible { color: ${HOMEBREW.text}; outline: none; }
.flow details.more > summary:focus-visible { box-shadow: 0 0 0 2px ${HOMEBREW.accent}; border-radius: 4px; }
.flow details.more[open] > summary { color: ${HOMEBREW.text}; border-bottom: 1px solid ${HOMEBREW.line}; margin-bottom: 8px; }
.flow details.more > .more-body { display: flex; flex-direction: column; gap: 8px; padding-bottom: 10px; min-width: 0; }
.flow section.summary { border-left: 3px solid ${HOMEBREW.lineStrong}; padding: 2px 0 2px 10px; display: flex; flex-direction: column; gap: 4px; }
.flow section.summary .who { margin: 0; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; overflow-wrap: anywhere; }
.flow section.summary .doctrine { margin: 2px 0 0; }
.flow .vw { font-weight: ${TYPE.weight.strong}; text-transform: uppercase; letter-spacing: .05em; font-size: 11px; margin-right: 6px; color: ${HOMEBREW.text}; }
.flow .vw-differs, .flow .vw-failed { color: ${HOMEBREW.failure}; }
.flow .vw-nosummary, .flow .vw-succeededwithoutreadback, .flow .vw-stopped, .flow .vw-cancelled, .flow .vw-interrupted, .flow .vw-running { color: ${HOMEBREW.attention}; }
.flow section.artifacts ul.arts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: ${TYPE.size.small}px; }
.flow section.artifacts li.art { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; }
.flow section.artifacts .art-role { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.textSecondary}; min-width: 7.5em; }
.flow section.artifacts .cmd { margin-left: auto; }
.flow section.next { border-left: 3px solid ${HOMEBREW.attention}; padding: 2px 0 2px 10px; }
.flow section.next ul { margin: 0; padding-left: 18px; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.flow section.next .cmds { margin-top: 6px; }
.flow section.next .meta { margin: 6px 0 0; }
.state-running, .state-interrupted { color: ${HOMEBREW.attention}; }
.status-running strong { color: ${HOMEBREW.attention}; }
@media (max-width: 520px) {
  .flow ol.strip[class] { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .flow .st { padding: 2px 0 0 36px; text-align: left; min-height: 28px; }
  .flow .st::before { display: none; }
  .flow .st > .st-dot { left: 0; transform: none; }
  .flow section.artifacts .cmd { margin-left: 0; }
}
`;
