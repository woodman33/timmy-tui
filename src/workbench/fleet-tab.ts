/**
 * R5 (H134): the body of tab 8, Fleet & Clef (src/contracts/workspace.ts TABS: "fleet plans and their counts, Clef
 * recommendations and Cloudflare, labelled as they are"), laid out as the operator's references 09 and 18 lay theirs out:
 *
 *   the strip      the fleet, the Cloudroom Core, the decision model and the Cloudflare edge in one row, each as it is
 *   FLEET          the project's plans (src/fleet/service.ts listFleetViews: read from their files only), newest first, with
 *                  their counts kept apart (planned, admitted, running, done, failed; done is delivered, never verified); a
 *                  FAKE plan says FAKE (simulation); the Cloudroom Core as this reading found it, recorded or not connected
 *                  (nothing here asks it: no live call is authorized), and under SERVICES as the frame last observed it
 *   DECISION MODEL its mode (decision-model routing, saved as "Use Clef routing", off by default), its thresholds said to be
 *                  uncalibrated, its transport, the model clef.json names with its pricing as declared (free: local; a price
 *                  and its billing; or unknown, amber, with what every call is then refused for) and its limits, and the
 *                  project's recent decisions (src/decision/store.ts): what each recommended and which model said so, its
 *                  scores as bars (the recommended option amber, never green), that a recommendation is not a run, and,
 *                  selected, its pricing, any refusal in its words and a model that answered for another (R9, H162: the
 *                  words are the model's own, never Clef for another model)
 *   SERVICES       the connections as the workspace frame observed them (src/ops/workspace-frame.ts connectionOf): ● live
 *                  green only for an answer seen in the last 30 minutes
 *   CLOUDFLARE     optional, not the chat provider: set up or not
 *
 * From 120 columns the fleet and Clef sit beside the services, below that everything is stacked. readFleet reads files
 * only: nothing here launches a VM, starts a Core, calls a paid service or makes a network request.
 */
import { existsSync } from 'node:fs';
import type { WorkspaceFrame } from '../contracts/workspace.js';
import { readClefConfig } from '../decision/config.js';
import { NEEDS_REVIEW } from '../decision/judge.js';
import type { ModelLimits, Pricing } from '../decision/pricing.js';
import { providerFromConfig } from '../decision/provider.js';
import { readSettings } from '../decision/settings.js';
import { listDecisions } from '../decision/store.js';
import type { DecisionRecord } from '../decision/types.js';
import { decisionLines, ENDPOINT_WORDS, type DecisionLine } from '../decision/view.js';
import { cloudroomAvailability, cloudroomConfigPath } from '../fleet/cloudroom/index.js';
import { knownProviders, listFleetViews, readRouteAdvice, type FleetView, type ProviderEntry, type RouteAdvice } from '../fleet/service.js';
import type { Glyphs } from './frame.js';
import { connectionMark } from './hub.js';
import {
  bar, clipRows, fieldRows, first, flow, heading, onBar, para, previewNote, rowsOf, S, selectedIn, sideBySide, sideBySideAt, RULE_CELLS, widths, windowMarked, type TabCtx,
  type TabView,
} from './tab-columns.js';
import { cells, clock, cut, fit, lineCells, pick, spread, wrapSegs, wrapText, type Line, type Role, type Seg } from './text.js';

type Env = Record<string, string | undefined>;

/** The Workbench list the tab's selection is kept in (src/workbench/screen.ts: `center:<workspace>`). */
export const FLEET_LIST = 'center:fleet';
/** R5 (H131; the QA of e7f853e, defect 2): what no Timmy surface draws of this tab yet, and what the companion shows of it */
const FLEET_NONE = 'No Timmy surface draws fleet previews yet.';
const FLEET_C = 'these cards in words';
/** How many plans and decisions are listed (the newest). */
export const PLANS_SHOWN = 8;
export const DECISIONS_SHOWN = 6;

/** The command that makes the first plan (the frame's own action for this tab: the FAKE backend, nothing starts). */
export const PLAN_COMMAND = 'timmy fleet plan --provider fake --workers 3 --prompt "<task>"';
/** The command that records a decision (deterministic while decision-model routing is off). */
export const DECIDE_COMMAND = 'timmy decide route --option <id> --option <id> --deterministic <id>';

// ── the reading ────────────────────────────────────────────────────────────────

export interface PlanRow { view: FleetView; route?: RouteAdvice }

export interface DecisionRow {
  id: string;
  kind: string;
  at: string;
  operation: string;
  outcome: DecisionRecord['outcome'];
  recommended?: { option: string; label: string; top: number; margin: number };
  /** why a person decides (an abstention) */
  abstained?: string;
  fallback: { used: boolean; option?: string; rule: string; reason?: string };
  needsReview: boolean;
  admitted: boolean;
  /** the model's scores, highest first; the abstain option as "a person should decide" */
  distribution: Array<{ id: string; label: string; p: number }>;
  /** what answered, in words (never an address or an account id) */
  asked: string;
  /** R9 (H162): the model asked for (absent in a record made before R9), its pricing as declared, and "asked for X; the answer
   *  names Y" when another model answered */
  model?: string;
  pricing?: string;
  differs?: string;
  /** the record in plain lines (src/decision/view.ts decisionLines): the Inspector's words */
  lines: DecisionLine[];
}

export interface ClefState {
  useClef: boolean;
  /** where the switch comes from: TIMMY_CLEF for this process, the saved settings, or the default (off) */
  from: 'environment' | 'saved' | 'default';
  requireReview: boolean;
  allowCloudAnalysis: boolean;
  thresholds: { minTop: number; minMargin: number };
  settings: 'saved' | 'none yet' | 'unreadable';
  /** values found out of range in the settings file, each replaced by its default, or why it could not be read */
  problems: string[];
  /** how the decision model is reached, in words (and in a few, for a narrow column): never the address, account id or token */
  transport: { state: 'configured' | 'none yet' | 'off' | 'unreadable' | 'invalid'; words: string; short: string; cloudflare: boolean };
  /** R9 (H162): the model clef.json names, its pricing as declared and its limits; absent when none is configured */
  model?: { name: string; id: string; pricing: Pick<Pricing, 'kind' | 'words' | 'why'>; limits: string; limitsSource: ModelLimits['source'] };
}

export interface FleetData {
  /** when this reading was made (ISO) */
  at: string;
  plans: PlanRow[];
  /** plans not listed (older than the newest PLANS_SHOWN) */
  more: number;
  providers: ProviderEntry[];
  cloudroom: { recorded: boolean; available: boolean; mode: 'off' | 'real' | 'fake'; why: string };
  clef: ClefState;
  decisions: DecisionRow[];
  moreDecisions: number;
  /** what could not be read, each with why */
  notes: string[];
}

export interface FleetReadInput {
  /** Timmy's home (the Cloudroom Core's record is <home>/fleet/cloudroom.json) */
  home: string;
  /** the project's folder (its plans in .timmy/fleet, its decisions in .timmy/decisions) */
  root: string;
  /** the settings' folder and the flags (TIMMY_CLEF, TIMMY_FLEET_CLOUDROOM) */
  env?: Env;
  now?: number;
}

function decisionRow(r: DecisionRecord): DecisionRow {
  const label = (id: string): string => (id === NEEDS_REVIEW ? 'a person should decide' : r.options.permitted.find((o) => o.id === id)?.label ?? id);
  const via = r.provider.endpoint ? ENDPOINT_WORDS[r.provider.endpoint] ?? r.provider.endpoint : 'no transport';
  return {
    id: r.id, kind: r.kind, at: r.createdAt, operation: r.operationId, outcome: r.outcome,
    ...(r.outcome === 'recommend' && r.recommendation ? { recommended: { option: r.recommendation.option, label: r.recommendation.label, top: r.recommendation.top, margin: r.recommendation.margin } } : {}),
    ...(r.outcome === 'abstain' ? { abstained: r.judge?.kind === 'abstain' ? r.judge.reason : 'the model did not recommend an option' } : {}),
    fallback: { used: r.fallback.used, ...(r.fallback.option ? { option: r.fallback.option } : {}), rule: r.fallback.rule, ...(r.fallback.reason ? { reason: r.fallback.reason } : {}) },
    needsReview: r.admission.needsReview, admitted: r.admission.admitted,
    distribution: Object.entries(r.distribution ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, p]) => ({ id, label: label(id), p })),
    asked: r.provider.model ? `${r.provider.model} via ${via}` : r.latencyMs !== undefined ? `asked ${via}: no usable answer` : `no model was asked (${via})`,
    ...(r.model ? { model: r.model.requested } : {}),
    ...(r.provider.pricing ? { pricing: r.provider.pricing.words } : {}),
    ...(r.model?.differs ? { differs: r.model.differs } : {}),
    lines: decisionLines(r),
  };
}

/**
 * How the decision model is reached, which model clef.json names and its pricing as declared, in words: never its address,
 * account id or token. R9 (H162): from the provider's own description (src/decision/provider.ts), the one place that reads
 * clef.json's model and pricing, so a loopback address is never called free here either.
 */
function transportOf(env: Env): Pick<ClefState, 'transport' | 'model'> {
  const c = readClefConfig(env);
  if (c.state === 'none yet') return { transport: { state: c.state, words: 'not set up (no decision/clef.json in Timmy\'s home)', short: 'not set up', cloudflare: false } };
  if (c.state === 'off') return { transport: { state: c.state, words: 'turned off (transport "none")', short: 'turned off', cloudflare: false } };
  if (c.state !== 'configured') return { transport: { state: c.state, words: c.why, short: c.state, cloudflare: false } };
  const d = providerFromConfig(c).describe();
  const here = d.endpoint === 'systemone-loopback';
  const words = d.transport === 'workers-ai' ? 'Workers AI: Cloudflare\'s hosted service, off this computer'
    : here ? `SystemOne on this computer${d.cloudModel ? ', but its model is a cloud tag: what it is given leaves this computer' : ''}` : 'SystemOne on another computer';
  const short = d.transport === 'workers-ai' ? 'Workers AI' : here ? 'SystemOne, this computer' : 'SystemOne, elsewhere';
  return {
    transport: { state: 'configured', words: d.available ? words : `${words}: ${d.reason ?? 'not usable'}`, short, cloudflare: d.transport === 'workers-ai' },
    model: { name: d.model, id: d.id, pricing: { kind: d.pricing.kind, words: d.pricing.words, ...(d.pricing.why ? { why: d.pricing.why } : {}) }, limits: d.limits.words, limitsSource: d.limits.source },
  };
}

/** The tab's reading: the project's plans, the providers and the Cloudroom Core as recorded, the decision model's settings and the
 *  project's decisions. Reads files only. */
export function readFleet(i: FleetReadInput): FleetData {
  const env = i.env ?? process.env;
  const notes: string[] = [];
  let plans: PlanRow[] = [];
  let more = 0;
  try {
    const all = listFleetViews(i.root);
    more = Math.max(0, all.length - PLANS_SHOWN);
    plans = all.slice(0, PLANS_SHOWN).map((view) => { const route = readRouteAdvice(i.root, view.planId); return route ? { view, route } : { view }; });
  } catch (e) { notes.push(`The fleet plans could not be read: ${e instanceof Error ? e.message : String(e)}`); }
  const providers = (() => { try { return knownProviders(env); } catch (e) { notes.push(`The providers could not be read: ${e instanceof Error ? e.message : String(e)}`); return []; } })();
  const avail = cloudroomAvailability(env, i.home);
  const s = readSettings(env);
  const clef: ClefState = {
    useClef: s.settings.useClef, from: s.useClefFrom, requireReview: s.settings.requireReview, allowCloudAnalysis: s.settings.allowCloudAnalysis,
    thresholds: { ...s.settings.thresholds }, settings: s.state, problems: [...s.problems, ...(s.error ? [`the decision settings could not be read (${s.error}): the defaults apply`] : [])],
    ...transportOf(env),
  };
  let decisions: DecisionRow[] = [];
  let moreDecisions = 0;
  try {
    const all = listDecisions(i.root).reverse();
    moreDecisions = Math.max(0, all.length - DECISIONS_SHOWN);
    decisions = all.slice(0, DECISIONS_SHOWN).map(decisionRow);
  } catch (e) { notes.push(`The decisions could not be read: ${e instanceof Error ? e.message : String(e)}`); }
  return {
    at: new Date(i.now ?? Date.now()).toISOString(), plans, more, providers,
    cloudroom: { recorded: existsSync(cloudroomConfigPath(i.home)), available: avail.available, mode: avail.mode, why: avail.why },
    clef, decisions, moreDecisions, notes,
  };
}

// ── the items ──────────────────────────────────────────────────────────────────

/** The tab's selectable rows: a fleet plan, or a decision. */
export type FleetItem =
  | { kind: 'fleet-plan'; key: string; plan: PlanRow }
  | { kind: 'clef-decision'; key: string; decision: DecisionRow };

/** A row's name, for the Tools tab and Activity (src/workbench/views.ts itemName). */
export const fleetItemName = (item: FleetItem): string => (item.kind === 'fleet-plan' ? `fleet plan ${item.plan.view.planId}` : `decision ${item.decision.id}`);
/** A row's operation (src/workbench/views.ts operationOf). */
export const fleetItemOperation = (item: FleetItem): string => (item.kind === 'fleet-plan' ? item.plan.view.operationId : item.decision.operation);

// ── the view ───────────────────────────────────────────────────────────────────

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** A plan's backend as it is: the FAKE one says FAKE (simulation). */
export const backendWords = (v: FleetView): string => (v.simulation ? `${v.backend === 'FAKE' ? 'FAKE' : v.backend} (simulation)` : v.backend);

/** A plan's counts, kept apart, in two groups: planned, admitted, running; then done (delivered, never verified), failed, and
 *  the rest when any (queued, cancelled, refused, unknown allocations). */
export function countGroups(v: FleetView): [string[], string[]] {
  const c = v.counts;
  const extra = [c.queued ? `queued ${c.queued}` : '', c.cancelled ? `cancelled ${c.cancelled}` : '', c.refused ? `refused ${c.refused}` : '', c.unknownAllocations ? `unknown ${c.unknownAllocations}` : ''].filter(Boolean);
  return [[`planned ${c.requested}`, `admitted ${c.admitted}`, `running ${c.running}`], [`done ${c.delivered}`, `failed ${c.failed}`, ...extra]];
}

/** A plan's counts on one line. */
export const countsWords = (v: FleetView, g: Glyphs): string => countGroups(v).flat().join(` ${g.sep} `);

/** The indent of a block's rows under its first: deeper where the column has room for it. */
const under = (w: number): string => (w >= 44 ? '    ' : '  ');

/**
 * A plan's rows: its id and its backend as it is (FAKE (simulation) whole), its status, and every count, each whole. The status
 * ends the first row when it fits there, else the last row of counts, else a row of its own.
 */
function planBlock(p: PlanRow, w: number, selected: boolean, g: Glyphs): Line[] {
  const v = p.view;
  const sel = selected ? { selected: true } : {};
  const ind = under(w);
  const status: Line = [S(v.needsYou.length ? `${g.warn} ${v.status}` : v.status, v.needsYou.length ? 'attention' : 'text', sel)];
  const id: Line = [selected ? S(`${g.cursor} `, 'accent', sel) : S('  '), S(v.planId, 'strong', sel), S(` ${g.sep} `, 'secondary', sel), S(backendWords(v), v.simulation ? 'secondary' : 'text', sel)];
  const all = (l: Line): Line => (selected ? onBar(l) : l);
  const beside = (l: Line): boolean => lineCells(l) + 1 + lineCells(status) <= w;
  const counts = flow(countGroups(v), w, ind, ` ${g.sep} `, 'text', g.ellipsis);
  const rows: Line[] = [];
  if (beside(id)) rows.push(all(spread(id, status, w, g.ellipsis)), ...counts);
  else {
    rows.push(all(fit(id, w, g.ellipsis)), ...counts);
    const k = rows.length - 1;
    if (beside(rows[k])) rows[k] = spread(rows[k], status, w, g.ellipsis);
    else rows.push(spread([S(ind)], status, w, g.ellipsis));
  }
  // the selected plan says more: its isolation, harness and model, the decision model's route advice, and what needs you
  if (selected) {
    rows.push(fit([S(ind), S(`${v.isolationWords}${v.perWorker === 'dedicated' ? ', one per worker' : ', shared'} ${g.sep} ${v.harness} ${g.sep} ${v.model}`, 'secondary')], w, g.ellipsis));
    if (p.route) rows.push(fit([S(ind), S(p.route.words, p.route.outcome === 'recommend' ? 'accent' : 'secondary')], w, g.ellipsis));
  }
  for (const n of v.needsYou.slice(0, selected ? 3 : 1)) rows.push(fit([S(ind), S(`${g.warn} needs you: ${n}`, 'attention')], w, g.ellipsis));
  return rows.map((l) => fit(l, w, g.ellipsis));
}

/** A decision's rows: its id, kind, time and outcome; what the model recommended (not a run) or the rule that chose; the
 *  scores as bars and what answered when it is selected, with its pricing and any refusal or model mismatch (R9, H162). */
function decisionBlock(d: DecisionRow, w: number, selected: boolean, g: Glyphs): Line[] {
  const sel = selected ? { selected: true } : {};
  const ind = under(w);
  const mark = selected ? S(`${g.cursor} `, 'accent', sel) : S('  ');
  const outcome: Seg = d.outcome === 'recommend' ? S('recommend', 'accent', sel) : d.outcome === 'abstain' ? S(`${g.warn} a person decides`, 'attention', sel) : S('deterministic', 'text', sel);
  const head = spread([mark, S(d.id, 'strong', sel), S(` ${g.sep} ${d.kind} ${g.sep} ${clock(d.at)}`, 'secondary', sel)], [outcome], w, g.ellipsis);
  const rows: Line[] = [selected ? onBar(head) : head];
  if (d.recommended) {
    const r = d.recommended;
    // R9 (H162): the model that recommended, by its own name (a record before R9: "the model"), never Clef for another
    const said: Line = [S(ind), S(`${d.model ?? 'the model'} recommended `, 'text'), S(r.label, 'accent')];
    const bare: Line = [S(ind), S('recommended ', 'text'), S(r.label, 'accent')];
    rows.push(first(w, g.ellipsis,
      [...said, S(` ${pct(r.top)}, ahead by ${pct(r.margin)}: a recommendation, not a run`, 'text')],
      [...said, S(` ${pct(r.top)}: not a run`, 'text')],
      [...said, S(': not a run', 'text')],
      [...bare, S(': not a run', 'text')],
      bare));
  } else if (d.outcome === 'abstain') rows.push(fit([S(ind), S(`no recommendation: ${d.abstained ?? 'a person decides'}`, 'attention')], w, g.ellipsis));
  else {
    const rule: Line = [S(ind), S(`deterministic: ${d.fallback.option ?? 'nothing chosen'} by ${d.fallback.rule}`, 'text')];
    rows.push(first(w, g.ellipsis, [...rule, S(d.fallback.reason ? ` (${d.fallback.reason})` : '', 'secondary')], rule));
  }
  if (d.needsReview) {
    rows.push(first(w, g.ellipsis,
      [S(ind), S(`${g.warn} needs you: a person approves before anything is dispatched`, 'attention')],
      [S(ind), S(`${g.warn} needs you: a person approves`, 'attention')],
      [S(ind), S(`${g.warn} needs you`, 'attention')]));
  }
  if (selected) {
    // the scores as bars: the recommended option amber, every other quiet; none green (a score is not evidence)
    const top = d.distribution.slice(0, 5);
    const lw = Math.min(16, Math.max(6, ...top.map((x) => x.label.length)));
    const barW = Math.max(4, Math.min(24, w - ind.length - lw - 1 - 7));
    for (const x of top) {
      const rec = d.recommended?.option === x.id;
      rows.push(fit([S(ind), S(`${cut(x.label, lw, g.ellipsis).padEnd(lw)} `, rec ? 'accent' : 'text'), ...bar(x.p, barW, rec ? 'accent' : 'secondary', g), S(` ${pct(x.p).padStart(6)}`, rec ? 'accent' : 'secondary')], w, g.ellipsis));
    }
    rows.push(first(w, g.ellipsis, [S(ind), S(`${d.asked} ${g.sep} cost not measured`, 'secondary')], [S(ind), S(`cost not measured ${g.sep} ${d.asked}`, 'secondary')]));
    // R9 (H162): the pricing as declared, a refusal in its own words and a model that answered for another, wrapped, never cut
    if (d.pricing) rows.push(...wrapSegs([S(ind), S(`pricing: ${d.pricing}`, 'secondary')], w, ind));
    if (d.differs) rows.push(...wrapSegs([S(ind), S(`${g.warn} ${d.differs}`, 'attention')], w, ind));
    if (!d.recommended && d.fallback.reason) rows.push(...wrapSegs([S(ind), S(`why: ${d.fallback.reason}`, 'secondary')], w, ind));
  }
  return rows.map((l) => fit(l, w, g.ellipsis));
}

/** The strip: the fleet, the Cloudroom Core, the decision model and the Cloudflare edge, each as it is (green only for a live edge);
 *  its short form where the long one does not fit, each part whole or left out. */
function strip(d: FleetData, frame: WorkspaceFrame | undefined, g: Glyphs, w: number): Line {
  const fake = d.plans.filter((p) => p.view.simulation).length;
  const n = d.plans.length + d.more;
  const edge = frame?.connections.find((c) => c.id === 'cloudflare');
  const em = edge ? connectionMark(edge.state, g) : { text: '? unknown', role: 'secondary' as Role };
  const label = (t: string): Seg => S(`${t} `, 'secondary', { bold: true });
  const core: Seg = S(d.cloudroom.recorded ? `${g.ring} recorded, not checked` : `${g.dot} not connected`, d.cloudroom.recorded ? 'text' : 'secondary');
  const long: Line[] = [
    [label('FLEET'), S(n ? `${n} plan${n === 1 ? '' : 's'}${fake ? ` (${fake} FAKE, simulation)` : ''}` : 'no plan', 'text')],
    [label('CLOUDROOM CORE'), core],
    [label('DECISION MODEL'), S(d.clef.useClef ? 'on' : 'off (the default)', 'text')],
    [label('CLOUDFLARE'), S(em.text, em.role)],
  ];
  // the parts are kept apart by a rule (a "·" is the mark of what is not set up)
  const rule = g.unicode ? '│' : '|';
  const wide = pick(long, w, S(`  ${rule}  `, 'border'));
  if (lineCells(wide) && long.every((p) => wide.includes(p[0]))) return fit(wide, w, g.ellipsis);
  const short: Line[] = [
    [label('FLEET'), S(n ? `${n}${fake ? ` (${fake} FAKE)` : ''}` : 'none', 'text')],
    [label('DECIDE'), S(d.clef.useClef ? 'on' : 'off', 'text')],
    [label('CLOUDFLARE'), S(em.text, em.role)],
    [label('CORE'), core],
  ];
  return fit(pick(short, w, S(` ${rule} `, 'border')), w, g.ellipsis);
}

/** The fleet section's rows above the plans: the providers, and the Cloudroom Core as this reading found it recorded (nothing
 *  here asks it; the services below have what was last observed). */
function fleetHead(d: FleetData, w: number, g: Glyphs): Line[] {
  const out: Line[] = [spread([heading('Fleet'), S(` ${g.sep} plans, newest first`, 'secondary')], [S(d.plans.length ? `${d.plans.length}${d.more ? ` of ${d.plans.length + d.more}` : ''}` : '', 'secondary')], w, g.ellipsis)];
  const avail = d.providers.filter((p) => p.available).map((p) => p.label).join(', ') || 'none';
  const prov: Line = [S('  providers ', 'secondary'), S(avail, 'text')];
  out.push(first(w, g.ellipsis,
    [...prov, S(` ${g.sep} the FAKE backend is a simulation: no compute, no harness, no model, no cost`, 'secondary')],
    [...prov, S(avail === 'FAKE' ? ' (a simulation)' : ' (FAKE: a simulation)', 'secondary')],
    prov));
  const core: Line = [S('  Cloudroom Core ', 'secondary')];
  out.push(d.cloudroom.recorded
    ? first(w, g.ellipsis,
      [...core, S(`${g.ring} recorded`, 'text'), S(` ${g.sep} not checked here (no live call is authorized)`, 'secondary')],
      [...core, S(`${g.ring} recorded, not checked`, 'text')],
      [...core, S(`${g.ring} recorded`, 'text')])
    : first(w, g.ellipsis,
      [...core, S(`${g.dot} not connected`, 'secondary'), S(` ${g.sep} timmy fleet connect cloudroom <url> --token-file <file>`, 'secondary')],
      [...core, S(`${g.dot} not connected`, 'secondary')]));
  return out;
}

/** A model's limits in a few words, for a narrow row. */
const LIMITS_SHORT: Readonly<Record<ModelLimits['source'], string>> = { published: 'Clef-Omni\'s published limits', config: 'limits as clef.json states', default: 'conservative default limits' };

/** The decision model's rows above its decisions: its mode, its thresholds (uncalibrated), its review rule, its transport,
 *  and (R9, H162) the model clef.json names with its pricing as declared and its limits, each in the fullest words that fit. */
function clefHead(d: FleetData, w: number, g: Glyphs): Line[] {
  const c = d.clef;
  const t = c.thresholds;
  const env = c.from === 'environment';
  const state = c.useClef ? 'on' : 'off';
  const from = env ? `TIMMY_CLEF=${c.useClef ? 1 : 0}, for this process` : c.from === 'saved' ? 'saved' : 'the default';
  const name = c.model?.name;
  const tail = c.useClef ? `${name ?? 'the model'} scores the options` : 'routes stay deterministic; no model is asked';
  const brief = c.useClef ? `${name ?? 'the model'} is asked` : 'routes stay deterministic';
  const label = (s: string): Seg => S(`  ${s}: `, 'secondary');
  const routing = 'Decision-model routing';
  const out: Line[] = [first(w, g.ellipsis,
    [heading('Decision model'), S(` ${g.sep} ${name ?? 'none set up'} ${g.sep} a recommender`, 'secondary')],
    [heading('Decision model'), S(` ${g.sep} ${name ?? 'none set up'}`, 'secondary')],
    [heading('Decision model')])];
  out.push(first(w, g.ellipsis,
    [label(routing), S(`${state} (${from})`, 'text'), S(`: ${tail}`, 'secondary')],
    [label(routing), S(`${state} (${from})`, 'text'), S(`: ${brief}`, 'secondary')],
    [label(routing), S(`${state} (${from})`, 'text')],
    [label(routing), S(`${state} (${env ? `TIMMY_CLEF=${c.useClef ? 1 : 0}` : from})`, 'text')],
    [label(routing), S(state, 'text')]));
  const unc: Line = [S('  '), S('uncalibrated thresholds', 'attention')];
  const values = S(`: ${pct(t.minTop)} top, ${pct(t.minMargin)} margin`, 'text');
  out.push(first(w, g.ellipsis, [...unc, values, S(' (placeholders, not checked against outcomes)', 'secondary')], [...unc, values], unc));
  out.push(c.requireReview
    ? first(w, g.ellipsis,
      [label('Review'), S('every recommendation waits for a person', 'text'), S(' (the default)', 'secondary')],
      [label('Review'), S('every recommendation waits for a person', 'text')],
      [label('Review'), S('a person approves each one', 'text')])
    : first(w, g.ellipsis,
      [label('Review'), S('off: recommendations are not held for a person', 'attention')],
      [label('Review'), S('off: not held for a person', 'attention')]));
  const role: Role = c.transport.state === 'invalid' || c.transport.state === 'unreadable' ? 'failure' : c.transport.state === 'configured' ? 'text' : 'secondary';
  out.push(first(w, g.ellipsis, [label('Transport'), S(c.transport.words, role)], [label('Transport'), S(c.transport.short, role)]));
  if (c.model) {
    const m = c.model;
    out.push(first(w, g.ellipsis,
      [label('Model'), S(m.name, 'text'), S(` (${m.id}) ${g.sep} ${LIMITS_SHORT[m.limitsSource]}`, 'secondary')],
      [label('Model'), S(m.name, 'text'), S(` ${g.sep} ${LIMITS_SHORT[m.limitsSource]}`, 'secondary')],
      [label('Model'), S(m.name, 'text')]));
    // the pricing as clef.json declares it, wrapped, never cut; unknown is amber, with what every call is then refused for
    const unknown = m.pricing.kind === 'unknown';
    out.push(...wrapSegs([label('Pricing'), S(m.pricing.words, unknown ? 'attention' : 'text')], w, '    '));
    if (unknown) out.push(...para(`${g.warn} every call is refused before anything is sent: ${m.pricing.why ?? 'the pricing is unknown'}`, w, 'attention', '    '));
  }
  for (const p of c.problems) out.push(fit([S(`  ${g.warn} ${p}`, 'attention')], w, g.ellipsis));
  return out;
}

/** A service's name without its note in brackets ("OpenRouter (cloud chat)": "OpenRouter"), for a narrow column. */
const shortName = (label: string): string => label.replace(/\s*\([^)]*\)$/, '') || label;

/**
 * The services as observed, each with its mark and word (green only for live), its name whole and its words, the legend last.
 * From 48 cells: the mark, the name, the words under the name. Narrower, with rows enough: the name on its row, the mark and
 * the words under it. Short of rows (`room`: the rows there are; absent, as many as it takes): one row each, the name (or its
 * short form) and the mark at the row's end, and a row of its own for a name that still does not fit while rows are left.
 */
function serviceRows(frame: WorkspaceFrame | undefined, frameError: string | undefined, w: number, g: Glyphs, room?: number): Line[] {
  const out: Line[] = [[heading('Services'), S(` ${g.sep} as last observed`, 'secondary')]];
  if (!frame) {
    out.push(...para(frameError ? `The workspace frame could not be read: ${frameError}. [r] reads it again.` : 'Reading the workspace frame…', w, frameError ? 'failure' : 'secondary'));
    return out;
  }
  const n = frame.connections.length;
  const legend = fit([S(`live: an answer seen in the last 30 minutes ${g.sep} timmy workspace check asks each once ${g.sep} 1 Home has each one's step`, 'secondary')], w, g.ellipsis);
  const mw = 15;
  const wordsOf = (c: WorkspaceFrame['connections'][number]): Seg => S(c.words, c.state === 'unreachable' || c.state === 'refused' ? 'failure' : 'secondary');
  // R5 (H131; the QA of e7f853e, defect 11): each service's words wrapped under its name, never cut ("c in the…"), where the
  // column has the rows for all of them; else a row each (cut), else the names and marks alone
  const under = (c: WorkspaceFrame['connections'][number]): Line[] => (w >= 48
    ? wrapSegs([S(' '.repeat(2 + mw)), wordsOf(c)], w, ' '.repeat(2 + mw))
    : wrapSegs([S('    '), S(connectionMark(c.state, g).text, connectionMark(c.state, g).role), S(` ${g.sep} `, 'secondary'), wordsOf(c)], w, '    '));
  const whole = room === undefined || 1 + n + frame.connections.reduce((a, c) => a + under(c).length, 0) + 1 <= room;
  const two = whole || 1 + n * 2 + 1 <= room;
  let spare = room === undefined ? n : room - (1 + n + 1);
  for (const c of frame.connections) {
    const m = connectionMark(c.state, g);
    const words = wordsOf(c);
    if (w >= 48) {
      const mark = cut(m.text, mw - 1, g.ellipsis);
      out.push(fit([S('  '), S(mark, m.role), S(' '.repeat(mw - cells(mark))), S(c.label, 'strong')], w, g.ellipsis));
      if (whole) out.push(...under(c));
      else if (two) out.push(fit([S(' '.repeat(2 + mw)), words], w, g.ellipsis));
    } else if (two) {
      out.push(fit([S('  '), S(c.label, 'strong')], w, g.ellipsis), ...(whole ? under(c) : [fit([S('    '), S(m.text, m.role), S(` ${g.sep} `, 'secondary'), words], w, g.ellipsis)]));
    } else {
      const beside = (name: string): boolean => cells(`  ${name} ${m.text}`) <= w;
      const name = beside(c.label) ? c.label : shortName(c.label);
      if (beside(name) || spare <= 0) out.push(spread([S('  '), S(name, 'strong')], [S(m.text, m.role)], w, g.ellipsis));
      else {
        out.push(fit([S('  '), S(c.label, 'strong')], w, g.ellipsis), fit([S('    '), S(m.text, m.role)], w, g.ellipsis));
        spare -= 1;
      }
    }
  }
  out.push(legend);
  return out;
}

/** Cloudflare: optional, not the chat provider; set up or not, as the frame observed it; whether Clef-Omni uses Workers AI. */
function cloudflareRows(d: FleetData, frame: WorkspaceFrame | undefined, w: number, g: Glyphs): Line[] {
  const edge = frame?.connections.find((c) => c.id === 'cloudflare');
  const m = edge ? connectionMark(edge.state, g) : { text: '? unknown', role: 'secondary' as Role };
  const out: Line[] = [[heading('Cloudflare'), S(` ${g.sep} optional`, 'secondary')]];
  // the edge's own words where they say more than its mark (an answer's age, a refusal); "not set up" is the mark's word
  const said = !edge ? 'the workspace frame is not read yet' : edge.state === 'not set up' ? '' : edge.words;
  out.push(fit([S('  edge: ', 'secondary'), S(m.text, m.role), S(said ? ` ${g.sep} ${said}` : '', edge?.state === 'unreachable' || edge?.state === 'refused' ? 'failure' : 'secondary')], w, g.ellipsis));
  const chat: Line = [S('  not the chat provider', 'text')];
  out.push(first(w, g.ellipsis, [...chat, S(': chat goes to OpenRouter or a local Ollama', 'secondary')], chat));
  const wa = S('  Workers AI: ', 'secondary');
  const name = d.clef.model?.name ?? 'the decision model';
  out.push(d.clef.transport.cloudflare
    ? first(w, g.ellipsis,
      [wa, S(`the decision model's transport (${name})`, 'text'), S(`; asked only while decision-model routing is on (it is ${d.clef.useClef ? 'on' : 'off'})`, 'secondary')],
      [wa, S(`the decision model's transport (${name})`, 'text')],
      [wa, S('the decision model\'s transport', 'text')])
    : first(w, g.ellipsis, [wa, S('not used', 'text'), S(' (the decision model\'s transport is not Workers AI)', 'secondary')], [wa, S('not used', 'text')]));
  return out;
}

/** An empty section's command, on rows of its own (wrapped at its words where the column is narrow). */
const commandRows = (command: string, w: number): Line[] => wrapText(command, Math.max(8, w - 2)).map((r) => [S('  '), S(r, 'strong')]);

/**
 * Tab 8's body: the strip, then the fleet and Clef-Omni beside the services and Cloudflare from 120 columns, or everything
 * stacked below that; every row at most `c.width` cells. The items are the plans, then the decisions, in that order at every
 * size: beside the services, the column keeps the selection in its own rows (an item out of view has line -1); stacked, the
 * body scrolls as every other view does.
 */
export function fleetView(c: TabCtx, d: FleetData | undefined, frame?: WorkspaceFrame, frameError?: string): TabView<FleetItem> {
  const { g, width: W, height: H } = c;
  if (!d) return { lines: [fit([S('Reading the fleet, Clef-Omni and the services…', 'secondary')], W, g.ellipsis)], items: [] };
  const all: FleetItem[] = [
    ...d.plans.map((plan): FleetItem => ({ kind: 'fleet-plan', key: `plan:${plan.view.planId}`, plan })),
    ...d.decisions.map((decision): FleetItem => ({ kind: 'clef-decision', key: `decision:${decision.id}`, decision })),
  ];
  const sel = selectedIn(c.ui, FLEET_LIST, all.length);
  const items: TabView<FleetItem>['items'] = all.map((item) => ({ line: -1, item }));
  // the left column's blocks: the fleet with its plans, then Clef-Omni with its decisions (an item's block names its index)
  const leftBlocks = (w: number): Array<{ lines: Line[]; at?: number }> => {
    const b: Array<{ lines: Line[]; at?: number }> = [{ lines: fleetHead(d, w, g) }];
    if (!d.plans.length) {
      b.push({ lines: [fit([S('  No fleet plan in this project.', 'text')], w, g.ellipsis), ...commandRows(PLAN_COMMAND, w),
        first(w, g.ellipsis, [S('  makes one on the FAKE backend (a simulation: nothing starts).', 'secondary')], [S('  the FAKE backend: nothing starts.', 'secondary')])] });
    }
    d.plans.forEach((p, i) => b.push({ lines: planBlock(p, w, i === sel, g), at: i }));
    if (d.plans.length) {
      b.push({ lines: [first(w, g.ellipsis, [S('  done: the runtime said it completed; nothing here verified it', 'secondary')], [S('  done: as the runtime said; not verified', 'secondary')], [S('  done: not verified here', 'secondary')])] });
    }
    b.push({ lines: [[]] }, { lines: clefHead(d, w, g) });
    b.push({ lines: [spread([heading('Decisions'), S(` ${g.sep} newest first`, 'secondary')], [S(d.decisions.length ? `${d.decisions.length}${d.moreDecisions ? ` of ${d.decisions.length + d.moreDecisions}` : ''}` : '', 'secondary')], w, g.ellipsis)] });
    if (!d.decisions.length) {
      b.push({ lines: [first(w, g.ellipsis, [S('  No decision recorded in this project.', 'text')], [S('  No decision recorded here yet.', 'text')]), ...commandRows(DECIDE_COMMAND, w),
        first(w, g.ellipsis, [S('  records one (deterministic while decision-model routing is off; nothing is dispatched).', 'secondary')], [S('  records one; nothing is dispatched.', 'secondary')])] });
    }
    d.decisions.forEach((x, k) => b.push({ lines: decisionBlock(x, w, d.plans.length + k === sel, g), at: d.plans.length + k }));
    for (const n of d.notes) b.push({ lines: para(n, w, 'failure') });
    return b;
  };
  const lines: Line[] = [strip(d, frame, g, W)];

  if (sideBySideAt(c)) {
    if (H >= 10) lines.push([]);
    const room = Math.max(1, H - lines.length);
    const [wl, wr] = widths(W - RULE_CELLS, [56, 44], 20);
    const blocks = leftBlocks(wl);
    const selBlock = blocks.findIndex((b) => b.at === sel);
    const win = windowMarked(blocks.map((b) => b.lines.length), selBlock, room, g, wl);
    const left: Line[] = win.above ? [win.above] : [];
    for (let i = win.start; i < win.end; i++) {
      const b = blocks[i];
      if (b.at !== undefined) items[b.at] = { line: lines.length + left.length, item: all[b.at], ...(b.lines.length > 1 ? { rows: b.lines.length } : {}) };
      left.push(...b.lines);
    }
    if (win.below) left.push(win.below);
    // a selected block cut at the column's end keeps its first rows; an item past the room is out of view
    for (const x of items) if (x.line >= lines.length + room) x.line = -1;
    // Cloudflare first (it is asked for by name), then the services in the rows left, then what a terminal cannot draw
    const cf = cloudflareRows(d, frame, wr, g);
    const note = previewNote(wr, g, FLEET_NONE, FLEET_C);
    // a row of air before the services only where every service still has its words under it
    const air: Line[] = cf.length + 1 + 2 + 2 * (frame?.connections.length ?? 0) + note.length <= room ? [[]] : [];
    const right: Line[] = [...cf, ...air, ...serviceRows(frame, frameError, wr, g, room - cf.length - air.length - note.length), ...note];
    lines.push(...sideBySide([{ w: wl, lines: rowsOf(left, wl, room, g.ellipsis) }, { w: wr, lines: clipRows(right, wr, room, g) }], room, g));
    return { lines, items };
  }

  // stacked: the fleet, Clef-Omni and its decisions, Cloudflare, the services; the body scrolls to the selection (the screen
  // says which rows show)
  lines.push([]);
  for (const b of leftBlocks(W)) {
    if (b.at !== undefined) items[b.at] = { line: lines.length, item: all[b.at], ...(b.lines.length > 1 ? { rows: b.lines.length } : {}) };
    lines.push(...b.lines);
  }
  lines.push([], ...cloudflareRows(d, frame, W, g), [], ...serviceRows(frame, frameError, W, g), ...previewNote(W, g, FLEET_NONE, FLEET_C));
  return { lines: lines.map((l) => (lineCells(l) > W ? fit(l, W, g.ellipsis) : l)), items };
}

// ── the Inspector ──────────────────────────────────────────────────────────────

const DECISION_ROLE: Readonly<Record<DecisionLine['role'], Role>> = { recommendation: 'accent', fallback: 'text', policy: 'text', muted: 'secondary' };

/** The Inspector's rows for a selected plan or decision: every count, the backend as it is, and what each recommendation is. */
export function fleetDetail(item: FleetItem, w: number, g: Glyphs): Line[] {
  const out: Line[] = [];
  const f = (label: string, value: string, role: Role = 'text'): void => { out.push(...fieldRows(label, value, w, role)); };
  if (item.kind === 'fleet-plan') {
    const v = item.plan.view;
    const c = v.counts;
    out.push([heading('Fleet plan')]);
    f('Plan', v.planId, 'strong');
    f('Status', v.status);
    f('Backend', v.simulation ? `${backendWords(v)}: no compute, no harness, no model, no cost` : `${v.backend}: not verified until a live check passes`);
    f('Isolation', `${v.isolationWords}${v.perWorker === 'dedicated' ? ', one per worker' : ', shared by workers'}`);
    f('Harness', `${v.harness} ${g.sep} model ${v.model}`);
    f('Planned', String(c.requested));
    f('Admitted', String(c.admitted));
    f('Running', String(c.running));
    f('Done', `${c.delivered} (the runtime said completed; not verified)`);
    f('Verified', `${c.verified} (an acceptance check passed, as the ledger records it)`);
    f('Failed', String(c.failed));
    f('Other', `queued ${c.queued} ${g.sep} cancelled ${c.cancelled} ${g.sep} refused ${c.refused} ${g.sep} unknown allocations ${c.unknownAllocations} ${g.sep} live allocations ${c.liveAllocations}`, 'secondary');
    f('Operation', v.operationId);
    f('Made', clock(v.createdAt));
    f('Updated', clock(v.updatedAt));
    f('Runner', v.runner ? `process ${v.runner.pid}, since ${clock(v.runner.started)}${v.cancelAsked ? '; a stop was asked' : ''}` : 'no process runs it now');
    if (item.plan.route) f('Route', item.plan.route.words, item.plan.route.outcome === 'recommend' ? 'accent' : 'text');
    for (const n of v.needsYou) out.push(...para(`${g.warn} needs you: ${n}`, w, 'attention'));
    out.push([], [heading('Workers'), S(` ${g.sep} ${v.workers.length}`, 'secondary')]);
    for (const x of v.workers.slice(0, 12)) {
      out.push(...para(`w${String(x.index).padStart(3, '0')} ${x.phase} ${g.sep} compute ${x.compute} ${g.sep} session ${x.sessionState} ${g.sep} ${x.events} events ${g.sep} ${x.collected ? `${x.files} file(s) collected` : 'nothing collected'}${x.reason ? ` ${g.sep} ${x.reason}` : ''}`, w, x.phase === 'failed' || x.phase === 'expired' ? 'failure' : 'text', '  '));
    }
    if (v.workers.length > 12) out.push([S(`  and ${v.workers.length - 12} more: timmy fleet status ${v.planId}`, 'secondary')]);
    return out;
  }
  const d = item.decision;
  out.push([heading('Decision')]);
  for (const l of d.lines) {
    const role = l.role === 'policy' && /^NEEDS YOU/.test(l.text) ? 'attention' : DECISION_ROLE[l.role];
    out.push(...para(l.text, w, role));
  }
  out.push([], ...para('A recommendation is not a run: nothing was dispatched from it, and nothing is until a person acts.', w, 'text'));
  return out;
}
