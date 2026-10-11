/**
 * Round R4 (H76): the ladder of every /tools row (src/capabilities/ladder.ts), put on the rows the checks built
 * (src/capabilities/index.ts and the modules it asks). The checks decide what is here now (found, answering, or what is
 * missing); this module adds each rung's own evidence, why each rung is not reached, the rung that stands, and the row's
 * demonstrations on the operator's Mac, which stay a separate fact (src/capabilities/demonstrations.ts).
 *
 * Nothing here runs a program or contacts anything: it reads what the checks found, the probes they made (with the time
 * each answered), the chain evidence (src/capabilities/evidence.ts) and the tables of this folder.
 */
import { mcpRoutes } from '../connectors/mcp-cli.js';
import { locateNative, NATIVE_APPS, type NativeApp } from '../native/index.js';
import { demonstrationsOf, type Demonstration } from './demonstrations.js';
import { exercisedOf, QUALIFICATION_RECORDS, checkQualificationRecord, type ChainEvidence, type RunMark } from './evidence.js';
import { emptyLadder, NOT_REACHED, standingRung, type InstalledEvidence, type Ladder, type NotReached, type ReachableEvidence, type Rung } from './ladder.js';
import { PROPOSED } from './plans.js';

/** A probe's answer and when it came. */
export interface Timed<T> { v: T; at: string }

/** What the live checks asked, for the rows that are reachable only when an answer came. */
export interface Probes {
  studioBase: string;
  studio?: Timed<{ state: string; pageConnected?: boolean | null; detail?: string; tldrawVersion?: string | null }>;
  ollamaBase?: string;
  ollama?: Timed<{ ok: boolean; models: string[] }>;
  openrouter?: Timed<string>;
  taskforge?: Timed<number | null>;
  missionMap?: Timed<number | null>;
}

/** What the post-pass needs. */
export interface LadderContext {
  env: Record<string, string | undefined>;
  probes: Probes;
  /** where a program on PATH is, or null (absent: where is not said) */
  which?: (program: string) => string | null;
  /** the exercised runs and admitted answers on the verified chain (absent: the ladder's exercised and the models' qualified are not read) */
  chain?: ChainEvidence;
  /** the recipe's run that counts in this project, and whether it was read at all */
  recipe?: RunMark;
  recipeRead?: boolean;
  /** the folder Timmy runs from, when it is Timmy's repository (its qualification records live there) */
  qualificationRoot?: string;
  /** the table of demonstrations (absent: the project's own) */
  demonstrations?: readonly Demonstration[];
}

/** A row as the checks built it. */
interface Built {
  id: string;
  rung: string;
  detail: string;
  setup?: string;
  tools?: string[];
  exercisedBy?: string;
}

/** The programs a row is found by on PATH, in the order its check looks. */
const PROGRAMS: Readonly<Record<string, readonly string[]>> = {
  'cockpit': ['zellij', 'tmux'], 'web': ['carbonyl'], 'workflows': ['upmd'], 'ollama': ['ollama'], 'browser': ['agent-browser'], 'stress': ['oha'],
  'claude-code': ['claude'], 'codex': ['codex'], 'codex-local': ['codex'], 'qwen-code': ['qwen', 'qwen-code'], 'opencode': ['opencode'], 'look': ['python3'],
  'openhands': ['docker'],
};
/** Rows that are Timmy's own code: found because this Timmy runs. */
const BUILT_IN = new Set(['repl', 'monitor', 'receipts', 'builtin', 'project-files', 'workspace', 'canvas-tools', 'spatial-review', 'mission-map']);
/** Rows found by a setting in the environment (never printed). */
const SETTINGS: Readonly<Record<string, string>> = {
  'trigger': 'TRIGGER_SECRET_KEY, set in the environment (never printed)',
  'composio': 'COMPOSIO_API_KEY, set in the environment (never printed)',
  'pulse': 'TIMMY_EDGE_HOST or the private overlay (the host is never printed)',
  'listing': 'BREAK_MODE_API_BASE_URL (or API_BASE_URL) and TIMMY_USERNAME, set in the environment',
  'taskforge': 'TASKFORGE_API_URL, set in the environment (an address is not an answer)',
  'agentpass': 'AGENTPASS_REPO_PATH, set to a checkout that is there',
};

const tilde = (p: string, home: string | undefined): string => (home && home.length > 1 && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** Where and how a row was found, from what its check knows (the check's own words are always kept as `found`). */
function foundHow(r: Built, c: LadderContext): Omit<InstalledEvidence, 'found'> {
  if (BUILT_IN.has(r.id)) return { how: 'built into Timmy' };
  if (r.id.startsWith('vox:') && r.detail.startsWith('built in: ')) return { how: 'built into Timmy' };
  if (SETTINGS[r.id]) return { how: SETTINGS[r.id] };
  if (r.id === 'openrouter') return { how: 'the model key, from where the REPL reads it (never printed)' };
  if (r.id === 'canvas') return { how: 'Timmy Canvas, built into Timmy' };
  // An MCP-to-CLI route: its package says its version (MCPorter's, or the MCP SDK's under Timmy's own command line).
  if (r.id.startsWith('mcp-cli:')) {
    try {
      const route = mcpRoutes(c.env).find((m) => `mcp-cli:${m.id}` === r.id);
      if (route?.version) return { how: route.id === 'mcporter' ? 'its package, found by Timmy' : 'Timmy\'s own command line on the MCP SDK', version: route.version, versionFrom: 'its package.json' };
    } catch { /* the check's own words stand */ }
    return {};
  }
  // A native app: where its finder found it, and how (its setting, the PATH, or a folder scan whose folder name is not the
  // program saying its version, so no version is given here).
  const app = r.exercisedBy?.startsWith('native:') ? r.exercisedBy.slice('native:'.length) : undefined;
  if (app && Object.hasOwn(NATIVE_APPS, app)) {
    try {
      const { found } = locateNative(app as NativeApp, c.env);
      if (found) return { where: tilde(found.path, c.env.HOME), how: found.how === 'env' ? NATIVE_APPS[app as NativeApp].envVar : found.how === 'path' ? `the PATH (${NATIVE_APPS[app as NativeApp].program})` : 'a scan of its install folder' };
    } catch { /* the check's own words stand */ }
    return {};
  }
  const bins = PROGRAMS[r.id];
  if (bins && c.which) {
    for (const b of bins) {
      const at = c.which(b);
      if (at) return { where: tilde(at, c.env.HOME), how: `the PATH (${b})` };
    }
  }
  return {};
}

const stamp = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** The reachable evidence of a row the checks found answering, or why it is not reachable. */
function probed(r: Built, c: LadderContext): { evidence?: ReachableEvidence; why?: string } {
  const p = c.probes;
  const health = `GET ${p.studioBase}/api/canvas/health`;
  const tags = `GET ${p.ollamaBase ?? 'the local Ollama'}/api/tags, then each local model's details`;
  const answered = r.rung === 'reachable';
  switch (r.id) {
    case 'canvas':
    case 'canvas-tools': {
      const s = p.studio;
      if (!s) return {};
      const page = s.v.pageConnected === true ? 'a canvas page is open' : s.v.pageConnected === false ? 'no canvas page is open' : 'it cannot say whether a page is open';
      if (answered) return { evidence: { asked: health, at: s.at, answer: `Timmy Canvas answered: ${page}${s.v.tldrawVersion ? ` (tldraw ${s.v.tldrawVersion})` : ''}` } };
      return { why: s.v.state === 'running' ? `asked ${health} at ${stamp(s.at)}: Timmy Canvas answered, but ${page}` : s.v.state === 'other' ? `asked ${health} at ${stamp(s.at)}: another program answered${s.v.detail ? ` (${s.v.detail})` : ''}` : `asked ${health} at ${stamp(s.at)}: nothing listens there` };
    }
    case 'openrouter': {
      const o = p.openrouter;
      if (!o) return {};
      const asked = 'GET https://openrouter.ai/api/v1/key with the model key (no model call, no charge)';
      if (answered) return { evidence: { asked, at: o.at, answer: 'the key was accepted' } };
      const why: Record<string, string> = {
        'rejected': `asked ${asked} at ${stamp(o.at)}: the key was refused`,
        'unreachable': `asked ${asked} at ${stamp(o.at)}: openrouter.ai did not answer`,
        'no-key': 'not asked: no model key is set',
        'not-asked': 'not asked: this check could not read the key itself (/tools in the REPL asks with the key it uses)',
      };
      return { why: why[o.v] ?? `asked ${asked}: ${o.v}` };
    }
    case 'ollama':
    case 'spatial-review': {
      const o = p.ollama;
      if (!o) return {};
      const n = o.v.models.length;
      if (answered) return { evidence: { asked: tags, at: o.at, answer: `${n} local ${n === 1 ? 'model' : 'models'} answered` } };
      return { why: `asked ${tags} at ${stamp(o.at)}: no answer, or no local model` };
    }
    case 'taskforge': {
      const t = p.taskforge;
      if (!t) return { why: 'not asked: TASKFORGE_API_URL is not set' };
      const asked = 'GET TASKFORGE_API_URL/runtime/health';
      if (answered) return { evidence: { asked, at: t.at, answer: `HTTP ${t.v}` } };
      return { why: t.v === null ? `asked ${asked} at ${stamp(t.at)}: no answer came (refused, or none within its time)` : `asked ${asked} at ${stamp(t.at)}: HTTP ${t.v}, not a healthy answer` };
    }
    case 'mission-map': {
      const m = p.missionMap;
      if (!m) return {};
      const asked = 'GET http://127.0.0.1:4336/api/vision/status';
      if (answered) return { evidence: { asked, at: m.at, answer: `HTTP ${m.v}` } };
      return { why: m.v === null ? `asked ${asked} at ${stamp(m.at)}: nothing answered (timmy map starts it)` : `asked ${asked} at ${stamp(m.at)}: HTTP ${m.v}` };
    }
    default:
      return {};
  }
}

/** The run that counts for a row, by what keys it: its own record (exercisedBy), its VoxVision tool, its model route, or its agent tools. */
function exercisedMark(r: Built, c: LadderContext): RunMark | undefined {
  const runs = c.chain?.runs;
  if (r.exercisedBy?.startsWith('recipe:')) return c.recipe;
  if (r.exercisedBy) return runs?.get(r.exercisedBy);
  if (r.id.startsWith('vox:')) return runs?.get(r.id);
  if (r.id === 'openrouter') return runs?.get('model:openrouter');
  // An MCP route's row: a call answered through it; the summary row: any route's, or its agent tools'.
  if (r.id.startsWith('mcp-cli:')) return runs?.get(`mcp:${r.id.slice('mcp-cli:'.length)}`);
  const own = r.id === 'mcp-cli' ? [...(runs?.entries() ?? [])].filter(([k]) => k.startsWith('mcp:')).map(([, m]) => m)
    : r.id === 'look' ? [runs?.get('observe:look')] : [];
  const marks = [...own, ...(r.tools ?? []).map((t) => runs?.get(t))].filter((m): m is RunMark => Boolean(m));
  return marks.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
}

/** Whether Timmy seals a run that could exercise this row at all. */
const hasExerciseSource = (r: Built): boolean => Boolean(r.exercisedBy || r.tools?.length || r.id.startsWith('vox:') || r.id.startsWith('mcp-cli') || r.id === 'openrouter');

/** The ladder fields of one row. */
export interface LadderFields { rung: Rung; ladder: Ladder; notReached: NotReached; demonstrated: Demonstration[]; setup?: string; exercised?: string }

/**
 * One row's ladder: each rung's evidence, why the others are not reached, the rung that stands, its demonstrations, and
 * (when chain evidence was read) its "used" time from the same run. A proposed row loses its install step: installing a
 * tool that no code runs would not make it work.
 */
export function ladderFor(r: Built, c: LadderContext): LadderFields {
  const ladder = emptyLadder();
  const notReached: NotReached = {};
  const proposal = PROPOSED[r.id];
  const present: 'proposed' | 'needs setup' | 'installed' | 'reachable' = proposal ? 'proposed' : r.rung === 'needs setup' ? 'needs setup' : r.rung === 'reachable' ? 'reachable' : 'installed';

  // proposed
  if (proposal) ladder.proposed = { plan: proposal.plan, section: proposal.section, says: proposal.says };
  else notReached.proposed = NOT_REACHED.proposed;

  // installed: what the check found here now
  if (present === 'installed' || present === 'reachable') ladder.installed = { found: r.detail, ...foundHow(r, c) };
  else notReached.installed = proposal ? `not looked for: ${proposal.noCode}` : `not found here: ${r.detail}`;

  // reachable: only a probe that answered
  const p = probed(r, c);
  if (present === 'reachable' && p.evidence) ladder.reachable = p.evidence;
  else notReached.reachable = p.why ?? (present === 'reachable' ? 'its check said it answered but recorded no probe, so it is not shown as reachable' : NOT_REACHED.noProbe);

  // exercised: Timmy's own run here, judged and sealed on a verified chain
  const recipe = r.exercisedBy?.startsWith('recipe:') === true;
  const read = recipe ? c.recipeRead === true : Boolean(c.chain);
  const m = exercisedMark(r, c);
  if (m) ladder.exercised = exercisedOf(m);
  else if (!hasExerciseSource(r)) notReached.exercised = 'not recorded: Timmy seals no run of this row on its own';
  else if (!read) notReached.exercised = recipe ? 'not read: the project\'s recipe jobs were not checked here' : 'not read: the receipts were not checked here';
  else if (!recipe && c.chain?.broken) notReached.exercised = `${NOT_REACHED.brokenChain} (${c.chain.broken})`;
  else notReached.exercised = NOT_REACHED.exercised;

  // qualified: a formal qualification record only
  const qualifiedNow = r.id === 'openrouter' ? c.chain?.qualified.get('model:openrouter') : undefined;
  const record = QUALIFICATION_RECORDS.find((q) => q.row === r.id);
  if (qualifiedNow) ladder.qualified = qualifiedNow;
  else if (record) {
    const q = checkQualificationRecord(record, c.qualificationRoot);
    if (q.ok) ladder.qualified = q.evidence;
    else notReached.qualified = q.why;
  } else notReached.qualified = NOT_REACHED.qualified;

  const rung = standingRung(present, ladder);
  return {
    rung, ladder, notReached, demonstrated: demonstrationsOf(r.id, c.demonstrations),
    ...(proposal ? {} : r.setup ? { setup: r.setup } : {}),
    // When the evidence was read, "used" is the time of the same run the ladder shows (never a run it did not count).
    ...(read ? { exercised: ladder.exercised?.at } : {}),
  };
}
