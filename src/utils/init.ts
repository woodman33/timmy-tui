// timmy init — the first run is blank (ORDER blank-slate-v1k9), and since round R4 (H98) Timmy's one guided setup.
//
// A fresh clone carries no operator, no identity, no providers, no project and no receipts. `timmy init` asks for them
// and writes ONLY to two places (and the receipts store pin):
//   ~/timmy/            (TIMMY_HOME)         identity.json, identity.seed (0600), providers.json (0600), setup.json (0600), projects/<name>/
//   <repo>/.timmy/private/ (TIMMY_PRIVATE_DIR) config.json (merged), projects.json (merged)
// and, R4 (H98, journey-2), when the monitor's settings file holds a model key (the old FIRST RUN kept one there), that
// file: the key moves to providers.json, the one place the key is kept, and leaves the settings. Nothing in the public
// tree changes. `isBlankSlate()` is what the CLI and the TUI ask before showing anything else; without a TTY (or --yes)
// the wizard prints what it would ask and writes nothing, so a first launch in a container still shows the wizard.
//
// R4 (H98): the questions are src/setup/questions.ts's, the same the monitor (`timmy watch`) and the REPL's /setup ask;
// each is asked only while it has no answer (what an older `timmy init` wrote counts), the local model is preselected,
// logs stay on this computer (journey-2: nothing to ask), and an existing identity is never replaced (applySetup keeps
// identity.json and identity.seed).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { identityPath as identityPathOf, isBlankSlate as blankSlate, privateDir as privateDirOf, prettyPath, settingsFile, setupPath, timmyHome as homeOf, workspaceRoot as workspaceOf } from '../setup/home.js';
import { OLLAMA_DEFAULT, PROJECT_DEFAULT, OPERATOR_DEFAULT, pendingQuestions, readSetupState, setupSummary, type Answers, type Chat, type QuestionId, type SetupState } from '../setup/questions.js';
import { askSetup, terminalIO, wrap, type SetupIO } from '../setup/terminal.js';
import { identityProblem, isNewKey, seedIdentity, type Identity } from '../setup/identity.js';

// the identity parser lives with the setup's questions (one parser for the question and the writer)
export { seedIdentity };

// Match the cockpit's workspace override. Installed modules are application
// code, never the default destination for operator state.
const workspaceRoot = (): string => workspaceOf();
export const timmyHome = (): string => homeOf();
export const privateDir = (workspace = workspaceRoot()): string => privateDirOf(workspace);
export const identityPath = (): string => identityPathOf();
export const isBlankSlate = (): boolean => blankSlate();

export const BANNER = 'TIMMY · first run — blank slate';
// C-14: the first run fits 60 columns, the questions included (they ran to 120).
export const QUESTIONS: ReadonlyArray<readonly [string, string]> = [
  ['operator', 'Operator name (your receipts show it)'],
  ['identity', 'A new key, or a key of yours (asked hidden)'],
  ['ollama', 'Ollama host (the local model)'],
  ['chat', 'Chat: local model (default) or OpenRouter'],
  ['project', 'First project name (under ~/timmy/projects/)'],
];

/** The first-run banner, within 60 columns (C-14): what is missing, where init writes, how to skip the questions. */
export function printBlankSlateBanner(log: (s: string) => void = console.log): void {
  log(`\n  ${BANNER}\n`);
  log('  No operator, identity or project yet, and nothing');
  log('  personal in this tree. `timmy init` (or `timmy watch`,');
  log('  in a terminal) asks these and writes only to:');
  log(`    ${relPretty(timmyHome())}/`);
  log(`    ${relPretty(privateDir())}/`);
  log('    <repo>/.timmy/store-pin (the receipts store)\n');
  for (const [k, q] of QUESTIONS) log(`    ${k.padEnd(10)} ${q}`);
  log('\n  Without questions: timmy init --yes, and any of');
  log('    --operator <name>  --seed generate|<key file>|-');
  log('    --ollama <host>  --chat local|openrouter');
  log('    --openrouter -  --project <name>  --edge-host <host>');
  log('    --json');
  log('  - reads the key from stdin: a key in a command\'s');
  log('  arguments is visible to other processes and kept in');
  log('  your shell history. With questions, a key is hidden.');
  log('  Logs and run events stay on this computer.\n');
}
const relPretty = (p: string): string => prettyPath(p);

export interface InitOptions {
  yes: boolean; json: boolean;
  /** `--seed`, `--openrouter`, `--anthropic`: `-` reads the value from stdin (hidden at a terminal), never from the arguments */
  operator?: string; seed?: string; openrouter?: string; anthropic?: string; ollama?: string; project?: string; edgeHost?: string;
  /** R4 (H98): `--chat local|openrouter` */
  chat?: Chat;
  /** a flag with a value it cannot take, in words */
  error?: string;
}
/** R4 (H98, journey-2): `--logs cloud`: this version sends no logs or run events to a worker, so it is not offered. */
export const LOGS_CLOUD_REFUSED = '--logs cloud is not offered: this version sends no logs or run events to a worker (the monitor and the REPL keep them on this computer). --logs local is what happens.';
/** A worker's host as `--edge-host` takes it: a host name (localhost too) and a port, no scheme or path. */
export const isEdgeHost = (v: string): boolean => /^(localhost|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)(:\d{1,5})?$/i.test(v);
export function parseInitArgs(args: string[]): InitOptions {
  const o: InitOptions = { yes: args.includes('--yes') || args.includes('-y'), json: args.includes('--json') };
  const v = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
  o.operator = v('--operator'); o.seed = v('--seed'); o.openrouter = v('--openrouter'); o.anthropic = v('--anthropic');
  o.ollama = v('--ollama'); o.project = v('--project');
  const chat = v('--chat');
  if (chat !== undefined) { if (chat === 'local' || chat === 'openrouter') o.chat = chat; else o.error = `--chat takes local or openrouter, not ${chat}.`; }
  const logs = v('--logs');
  if (logs !== undefined && logs !== 'local') o.error = logs === 'cloud' ? LOGS_CLOUD_REFUSED : `--logs takes local, not ${logs}.`;
  const edge = v('--edge-host');
  if (edge !== undefined) {
    const host = edge.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (isEdgeHost(host)) o.edgeHost = host; else o.error = '--edge-host takes a host name and a port, like worker.example.com or localhost:8787.';
  }
  if ([o.seed, o.openrouter, o.anthropic].filter((x) => x === '-').length > 1) o.error = 'Only one of --seed, --openrouter and --anthropic can read stdin (-).';
  return o;
}

/** The answers the flags give (an OpenRouter key alone means OpenRouter for the chat). */
export function answersFromFlags(o: InitOptions): Answers {
  return {
    ...(o.operator !== undefined ? { operator: o.operator } : {}),
    ...(o.seed !== undefined ? { identity: o.seed } : {}),
    ...(o.ollama !== undefined ? { ollama: o.ollama } : {}),
    ...(o.chat ? { chat: o.chat } : o.openrouter ? { chat: 'openrouter' as Chat } : {}),
    ...(o.openrouter !== undefined ? { key: o.openrouter } : {}),
    ...(o.anthropic !== undefined ? { anthropic: o.anthropic } : {}),
    ...(o.edgeHost !== undefined ? { edge: o.edgeHost } : {}),
    ...(o.project !== undefined ? { project: o.project } : {}),
  };
}

/** Every path this command writes must sit under TIMMY_HOME or TIMMY_PRIVATE_DIR — asserted, not assumed.
 *  The one named exception is <repo>/.timmy/store-pin: the receipts store pin is generated on the first
 *  run and never committed (.timmy/ is gitignored); receipts.ts owns its location. */
function guardPath(p: string, extraAllowed: string[] = [], workspace = workspaceRoot()): string {
  const abs = resolve(p);
  const under = (root: string) => { const r = relative(resolve(root), abs); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  const ok = [timmyHome(), privateDir(workspace)].some(under) || extraAllowed.some((e) => resolve(e) === abs);
  if (!ok) throw new Error(`refusing to write outside TIMMY_HOME / TIMMY_PRIVATE_DIR: ${abs}`);
  return abs;
}
/** Writes a file at `mode`. writeFileSync's mode only applies to a file it creates, so a private file that
 *  already existed (an older version's, or one made by hand) is narrowed first, before the secret goes in. */
function writeAt(abs: string, data: string, mode: number): void {
  if ((mode & 0o077) === 0 && existsSync(abs)) chmodSync(abs, mode);
  writeFileSync(abs, data, { mode });
}
function writeJson(p: string, data: unknown, mode = 0o644, workspace = workspaceRoot()): string { const abs = guardPath(p, [], workspace); mkdirSync(join(abs, '..'), { recursive: true }); writeAt(abs, JSON.stringify(data, null, 1) + '\n', mode); return abs; }
const readObject = (abs: string): Record<string, unknown> => {
  if (!existsSync(abs)) return {};
  try { const v = JSON.parse(readFileSync(abs, 'utf8')) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
};
function mergeJson(p: string, patch: Record<string, unknown>, mode = 0o600, workspace = workspaceRoot()): string {
  const abs = guardPath(p, [], workspace);
  return writeJson(abs, { ...readObject(abs), ...patch }, mode, workspace);
}

export interface InitResult { ok: boolean; written: string[]; operator: string; operator_id: string; project: string; identity_source: string; home: string; private_dir: string; store_pin?: string; /** what a person should know about the model key's move (never the key) */ notes?: string[] }

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
/** The monitor's settings file, and the model key in it (never shown), read without conf (building conf's store writes it). */
function settingsKeyAt(): { file: string; body: Record<string, unknown>; key?: string } {
  const file = settingsFile();
  const body = readObject(file);
  const key = text(body.apiKey);
  return { file, body, ...(key ? { key } : {}) };
}
/**
 * R4 (H98, journey-2): what the setup does with a model key the monitor's settings hold (its old FIRST RUN kept one there,
 * and loadConfig read it before providers.json): `move` it into providers.json (which has none), `drop` it from the
 * settings (providers.json holds it, or a newer key given now), or `keep` it (providers.json holds another, which is the
 * one used; the settings' key is left as it is, unused, and the setup says so). null: the settings hold none.
 */
function settingsKeyPlan(home: string, newKey: string | undefined): { plan: 'move' | 'drop' | 'keep'; at: ReturnType<typeof settingsKeyAt> } | null {
  const at = settingsKeyAt();
  if (!at.key) return null;
  const held = text(readObject(join(home, 'providers.json')).openrouter_api_key);
  if (newKey || held === at.key) return { plan: 'drop', at };
  return { plan: held ? 'keep' : 'move', at };
}

/** R4 (H98): an identity exists and a seed was given: it is never replaced (refused, nothing written). */
export const IDENTITY_KEPT = 'An identity already exists in the Timmy home (identity.json, identity.seed); Timmy never replaces it, so --seed was not used and nothing was written. To make a new one, move those two files away first.';
/** R4 (H98, journey-2): an identity.seed with no identity.json, and a seed was given: the seed there is kept (refused). */
export const SEED_KEPT = 'The Timmy home has an identity.seed (its identity.json is missing): it is this home\'s key, and Timmy never replaces it, so --seed was not used and nothing was written. To use another key, move identity.seed away first.';
/** R4 (H98): an identity.seed with no identity.json, that is not a key Timmy can read: kept as it is, nothing written. */
export const SEED_UNREADABLE = 'The Timmy home has an identity.seed but no identity.json, and that seed is not a key Timmy can read. Timmy never replaces it, so nothing was written: move identity.seed away (or put its identity.json back), then run timmy init again.';

/** Words as lines within 60 columns (C-14): a refusal is never one line of 200 characters. */
const say = (log: (s: string) => void, words: string): void => { for (const l of wrap(words)) log(l); };

/**
 * R4 (H98): writes the setup's answers: only what was answered now, merged into what the home holds. An existing
 * identity is kept (identity.json and identity.seed are never replaced; a new operator name only renames it there), a
 * provider key is added (a new one replaces the one stored; none is ever removed), a project is added to the private list,
 * never over it. setup.json records the answers in words (never a key) and who gave them (`by`). R4 (H98, journey-2): the
 * model key is kept in one place, providers.json: a key the monitor's settings hold moves there (see settingsKeyPlan).
 */
export function applySetup(answers: Answers, o: { by: string; repoRoot?: string; state?: SetupState } = { by: 'timmy init' }): InitResult {
  const repoRoot = resolve(o.repoRoot ?? workspaceRoot());
  const home = timmyHome(); const priv = privateDir(repoRoot);
  const s = o.state ?? readSetupState(process.env, repoRoot);
  if (s.identity.exists && answers.identity !== undefined) throw new Error(IDENTITY_KEPT);
  // the identity is settled before anything is written: a seed that cannot be read stops the run with nothing written
  const idFile = join(home, 'identity.json');
  const seedFile = join(home, 'identity.seed');
  const kept = !s.identity.exists && existsSync(seedFile);
  // a seed left there is this home's key, and the answer: one given as well would be dropped, so it is refused instead
  if (kept && answers.identity !== undefined && !isNewKey(answers.identity)) throw new Error(SEED_KEPT);
  let id: Identity | null = null;
  if (!s.identity.exists) {
    // a seed file left without its identity.json is this home's key: it is read (and narrowed to 0600), never replaced
    try { id = seedIdentity(kept ? seedFile : answers.identity); } catch (e) {
      if (kept) throw new Error(SEED_UNREADABLE);
      throw e;
    }
  }
  const written: string[] = [];
  // the receipts store pin: generated here on the first run, never committed. receipts.ts's
  // ensureStorePin() returns early whenever a package.json is in reach, so the pin is written here.
  const pin = join(repoRoot, '.timmy', 'store-pin');
  if (!existsSync(pin)) { guardPath(pin, [pin], repoRoot); mkdirSync(join(repoRoot, '.timmy'), { recursive: true }); writeFileSync(pin, join(repoRoot, '.timmy', 'receipts')); written.push(pin); }
  // the identity: made once; an existing one is kept, and a new operator name only renames it
  let operator = answers.operator ?? s.identity.operator ?? OPERATOR_DEFAULT;
  let operatorId = s.identity.operatorId ?? '';
  let source = s.identity.source ?? 'existing';
  if (id) {
    operatorId = id.operatorId; source = kept ? 'kept' : id.source;
    if (kept) chmodSync(guardPath(seedFile, [], repoRoot), 0o600);
    written.push(writeJson(idFile, { version: 1, operator, operator_id: id.operatorId, public_key_hex: id.publicKeyHex, seed_source: source, created: new Date().toISOString() }, 0o644, repoRoot));
    if (!kept) { const seedPath = guardPath(seedFile, [], repoRoot); writeAt(seedPath, id.privatePem, 0o600); written.push(seedPath); }
  } else if (answers.operator !== undefined && answers.operator !== s.identity.operator) {
    written.push(writeJson(idFile, { ...readObject(idFile), operator: answers.operator }, 0o644, repoRoot));
  } else operator = s.identity.operator ?? operator;
  // providers: the Ollama host; a key only when one was given (never removed), or the one the monitor's settings held
  const providersPatch: Record<string, string> = {};
  if (answers.ollama !== undefined || !s.providers.exists) providersPatch.ollama_host = answers.ollama || s.providers.ollama || OLLAMA_DEFAULT;
  const fromSettings = settingsKeyPlan(home, answers.key || undefined);
  if (answers.key) providersPatch.openrouter_api_key = answers.key;
  else if (fromSettings?.plan === 'move' && fromSettings.at.key) providersPatch.openrouter_api_key = fromSettings.at.key;
  if (answers.anthropic) providersPatch.anthropic_api_key = answers.anthropic;
  if (Object.keys(providersPatch).length) written.push(mergeJson(join(home, 'providers.json'), providersPatch, 0o600, repoRoot));
  // then (providers.json written first: never a moment with the key in neither place) the settings without it
  const notes: string[] = [];
  if (fromSettings && fromSettings.plan !== 'keep') {
    const { apiKey: _gone, ...rest } = fromSettings.at.body;
    void _gone;
    writeAt(guardPath(fromSettings.at.file, [fromSettings.at.file], repoRoot), `${JSON.stringify(rest, undefined, '\t')}\n`, 0o600);
    written.push(fromSettings.at.file);
    notes.push(fromSettings.plan === 'move'
      ? `The model key the monitor's settings held is now in ${relPretty(join(home, 'providers.json'))}, the one place Timmy keeps it.`
      : `The monitor's settings no longer hold a model key: ${relPretty(join(home, 'providers.json'))} does.`);
  } else if (fromSettings?.plan === 'keep') {
    notes.push(`The monitor's settings (${relPretty(fromSettings.at.file)}) hold another model key, not used: the one in ${relPretty(join(home, 'providers.json'))} is.`);
  }
  // the project: its folder and README once; added to the private list
  const project = answers.project ?? s.recorded?.answers.project ?? s.firstProject ?? s.projects[0] ?? PROJECT_DEFAULT;
  const projDir = guardPath(join(home, 'projects', project), [], repoRoot); mkdirSync(projDir, { recursive: true });
  const readme = join(projDir, 'README.md');
  if (!existsSync(readme)) { writeFileSync(readme, `# ${project}\n\nFirst TIMMY project of ${operator} (${operatorId}). Created by \`timmy init\`.\n`); written.push(readme); }
  written.push(mergeJson(join(priv, 'config.json'), { operator_label: operator, operator_id: operatorId, first_project: project, ...(answers.edge ? { edge_host: answers.edge } : {}) }, 0o600, repoRoot));
  const listFile = join(priv, 'projects.json');
  const list = readObject(listFile).projects;
  const projects = Array.isArray(list) ? list.filter((p) => p && typeof p === 'object') as Array<Record<string, unknown>> : [];
  if (!projects.some((p) => p.name === project)) {
    written.push(writeJson(listFile, { projects: [...projects, { name: project, path: projDir, created: new Date().toISOString() }] }, 0o600, repoRoot));
  }
  // the answers in words (never a key, never a seed)
  const prev = s.recorded?.answers ?? {};
  const chat: Chat | undefined = answers.chat === 'openrouter' && !answers.key && !s.providers.key && !s.settingsKey ? 'local' : answers.chat ?? prev.chat;
  written.push(writeJson(setupPath(), {
    version: 1, by: o.by, at: new Date().toISOString(),
    answers: {
      ...prev, operator, identity: s.identity.exists ? (prev.identity ?? source) : source,
      ollama: answers.ollama || prev.ollama || s.providers.ollama || OLLAMA_DEFAULT,
      ...(chat ? { chat } : {}), project,
    },
  }, 0o600, repoRoot));
  return { ok: true, written: [...new Set(written)], operator, operator_id: operatorId, project, identity_source: source, home, private_dir: priv, store_pin: existsSync(pin) ? pin : undefined, ...(notes.length ? { notes } : {}) };
}

/** The first run with every answer at once (tests, `--yes`): the answers given, the preselected ones for the rest. */
export function applyInit(a: Pick<InitOptions, 'operator' | 'project'> & Partial<InitOptions>, repoRoot: string = workspaceRoot()): InitResult {
  repoRoot = resolve(repoRoot);
  const state = readSetupState(process.env, repoRoot);
  const given = answersFromFlags({ yes: true, json: false, ...a } as InitOptions);
  return applySetup(withDefaults(state, given), { by: 'timmy init', repoRoot, state });
}

/** The answers given, and for every question still without one, its preselected answer. */
function withDefaults(state: SetupState, given: Answers): Answers {
  const out: Answers = { ...given };
  for (const q of pendingQuestions(state, given)) {
    if (q.id === 'key') continue; // no key unless given
    const pre = q.preselect({ ...out }, state);
    if (q.id === 'chat') out.chat = pre as Chat;
    else (out as Record<string, string>)[q.id] = pre;
  }
  return out;
}

/** Where a run of the guided setup may write, as a person reads it (`newKey`: a key is given now). */
function writesFor(state: SetupState, repoRoot: string, newKey = false): string[] {
  void state;
  const pin = join(repoRoot, '.timmy', 'store-pin');
  const settings = settingsKeyPlan(timmyHome(), newKey ? 'given' : undefined);
  return [
    `${relPretty(timmyHome())}/`, `${relPretty(privateDir(repoRoot))}/`,
    ...(existsSync(pin) ? [] : [`${relPretty(pin)} (the receipts store)`]),
    ...(settings && settings.plan !== 'keep' ? [`${relPretty(settings.at.file)} (its model key ${settings.plan === 'move' ? 'moves to' : 'leaves it for'} providers.json)`] : []),
  ];
}

/**
 * R4 (H98): the guided setup in this terminal, as `timmy init`, `timmy watch` and the REPL's /setup run it: asks what has no
 * answer (flags answer too), writes after a yes, prints one line of what the setup chose, then `next` (where to go from
 * here; the REPL prints its own). 0 set up (or nothing to ask), 1 declined, 130 stopped (Ctrl+C), 2 a refused flag.
 */
export async function guidedSetup(by: string, given: Answers = {}, io: SetupIO = terminalIO(), o: { json?: boolean; title?: string; next?: readonly string[]; force?: readonly QuestionId[] } = {}): Promise<number> {
  const repoRoot = workspaceRoot();
  const state = readSetupState(process.env, repoRoot);
  const force = o.force ?? [];
  // refused before anything is asked, in words within 60 columns: what cannot be written is never found after "Proceed?"
  const refused = identityRefusal(state, given);
  if (refused) { say(io.log, refused.words); return refused.code; }
  const pending = pendingQuestions(state, given, force);
  if (!pending.length && !Object.keys(given).length) {
    io.log('');
    say(io.log, `Every setup question has an answer: ${setupSummary(state)}.`);
    say(io.log, 'To change one: timmy init --chat local|openrouter, --ollama <host> or --operator <name>; a model key: /setup key in the REPL, or timmy init --openrouter - (the key from stdin). An identity is never replaced.');
    io.log('');
    return 0;
  }
  const asked = await askSetup({ state, given, io, force, title: o.title ?? (state.identity.exists ? 'TIMMY · guided setup' : 'TIMMY · first run — guided setup'), writes: writesFor(state, repoRoot, Boolean(given.key) || force.includes('key')) });
  if ('stopped' in asked) return asked.stopped === 'interrupted' ? 130 : 1;
  // R4 (H98, journey-2): what the home holds now, read again just before writing: another setup (timmy init in another
  // terminal, the monitor's FIRST RUN) may have answered meanwhile; its answers are the base, these go over them, and an
  // identity made meanwhile is kept (never replaced)
  const fresh = readSetupState(process.env, repoRoot);
  return applyAndReport(mergeFresh(asked.answers, fresh), { by, repoRoot, state: fresh }, io, o.json === true, o.next);
}

/** The answers to write over what the home holds now: an identity that appeared meanwhile (or a seed left there) is kept. */
export function mergeFresh(answers: Answers, fresh: SetupState): Answers {
  const out: Answers = { ...answers };
  if (fresh.identity.exists || fresh.identity.seed) delete out.identity;
  return out;
}

/** Why the identity given (a flag) or held cannot be written, before anything is asked; null when nothing stops it. */
function identityRefusal(state: SetupState, given: Answers): { words: string; code: number } | null {
  if (state.identity.exists && given.identity !== undefined) return { words: IDENTITY_KEPT, code: 2 };
  if (state.identity.seed && given.identity !== undefined) return { words: SEED_KEPT, code: 2 };
  if (state.identity.seed === 'unreadable') return { words: SEED_UNREADABLE, code: 1 };
  if (given.identity !== undefined && !isNewKey(given.identity)) {
    const why = identityProblem(given.identity);
    if (why) return { words: `--seed: ${why}`, code: 2 };
  }
  return null;
}

/**
 * R4 (H98): before `timmy watch` starts the monitor. A home with questions still unanswered gets the guided setup here, in
 * this terminal (the same as `timmy init`), so the monitor never sends the operator to another command. Returns null to go
 * on to the monitor, or the exit status: 130 stopped with Ctrl+C, 1 a no at the end (nothing written; the monitor does not
 * start). Nothing is asked without a terminal (the monitor then says what is missing and exits 78, as before), under CI or
 * TIMMY_SKIP_INIT (the monitor's own guard skips there too), for the monitor's help or headless mode, or once the monitor's
 * own FIRST RUN finished on a home with an identity (its answers were taken there).
 */
export async function setupBeforeMonitor(args: readonly string[], o: { env?: NodeJS.ProcessEnv; tty?: boolean; io?: SetupIO } = {}): Promise<number | null> {
  const env = o.env ?? process.env;
  const tty = o.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!tty || env.CI || env.TIMMY_SKIP_INIT || args.some((a) => a === '-h' || a === '--help' || a === '--headless')) return null;
  const s = readSetupState(env);
  if ((s.identity.exists && s.onboarded) || !pendingQuestions(s).length) return null;
  const io = o.io ?? terminalIO();
  const code = await guidedSetup('timmy watch', {}, io, { title: s.identity.exists ? 'TIMMY · guided setup (timmy watch)' : 'TIMMY · first run — guided setup (timmy watch)' });
  if (code === 0) return null;
  if (code !== 130) io.log('  The monitor did not start. timmy watch asks again; timmy init asks the same questions.');
  return code;
}

/** Writes and reports; a refusal (an unreadable seed, a seed that is not one) in words within 60 columns, exit 1. */
function applyAndReport(answers: Answers, w: { by: string; repoRoot?: string; state: SetupState }, io: Pick<SetupIO, 'log'>, json: boolean, next?: readonly string[]): number {
  let r: InitResult;
  try { r = applySetup(answers, w); } catch (e) {
    say(io.log, e instanceof Error ? e.message : String(e));
    return 1;
  }
  return report(r, io, json, next);
}

/** After the setup in a terminal: where to go next (the REPL's /setup says its own). */
const NEXT = [
  '\n  Next: `timmy doctor`, then `timmy` to open the REPL.',
  '  In the REPL: Studio /studio · Control Room /room ·',
  '  God\'s Eye View /overview · the board in your browser:',
  '  /board live. The monitor: timmy watch.\n',
];

/** What was written, and the one line of what the setup chose; then `next` (where to go from here). */
function report(r: InitResult, io: Pick<SetupIO, 'log'>, json: boolean, next: readonly string[] = NEXT): number {
  if (json) { io.log(JSON.stringify(r)); return 0; }
  const after = readSetupState();
  io.log('');
  say(io.log, `✓ Set up: ${setupSummary(after)}.`);
  io.log(`    identity ${r.operator_id} (${r.identity_source})`);
  for (const w of r.written) for (const l of wrap(`wrote ${relPretty(w)}`, 60, '    ')) io.log(l);
  for (const n of r.notes ?? []) say(io.log, n);
  for (const l of next) io.log(l);
  return 0;
}

/** R4 (H98, journey-2): a value given as `-`: read hidden at a terminal, else all of stdin (a key piped in); never echoed. */
async function readDash(what: string, log: (s: string) => void): Promise<string | null> {
  if (process.stdin.isTTY) return terminalIO(log).hidden!(`  ${what} (hidden as you type): `);
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** A key (or a seed) written in a command's arguments: other processes see it and the shell's history keeps it. */
export const KEY_IN_ARGUMENTS = 'A key given in a command\'s arguments is visible to other processes (ps) and kept in your shell history: next time, give - and pipe it in (timmy init --yes --openrouter - < a file), or answer the questions, which hide it.';

/** The wizard. Returns the process exit code. */
export async function runInit(args: string[], io: { isTTY: boolean; log: (s: string) => void; question?: (q: string) => Promise<string> } = { isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), log: console.log }): Promise<number> {
  const o = parseInitArgs(args);
  if (o.error) { say(io.log, o.error); return 2; }
  // R4 (H98, journey-2): `-` reads a key or a seed from stdin (hidden at a terminal); one written in the arguments still
  // works, and is said to be visible
  for (const [flag, field, what] of [['--openrouter', 'openrouter', 'OpenRouter key'], ['--anthropic', 'anthropic', 'Anthropic key'], ['--seed', 'seed', 'Seed or key file']] as const) {
    const v = o[field];
    if (v === '-') {
      const read = await readDash(what, io.log);
      if (read === null) { io.log('  Stopped: nothing was written.'); return 130; }
      if (!read) { say(io.log, `${flag} -: nothing came on stdin, so nothing was written.`); return 2; }
      o[field] = read;
    } else if (v !== undefined && (field !== 'seed' || /^[0-9a-fA-F]{64}$/.test(v))) say(io.log, KEY_IN_ARGUMENTS);
  }
  if (!o.yes && !io.isTTY) { printBlankSlateBanner(io.log); io.log('  (no TTY: nothing written — answer with flags and --yes)'); return 0; }
  const given = answersFromFlags(o);
  if (o.yes) {
    const state = readSetupState();
    const refused = identityRefusal(state, given);
    if (refused) { say(io.log, refused.words); return refused.code; }
    return applyAndReport(withDefaults(state, given), { by: 'timmy init', state }, { log: io.log }, o.json);
  }
  const term = terminalIO(io.log);
  return guidedSetup('timmy init', given, io.question ? { ...term, question: io.question, hidden: io.question } : term, { json: o.json });
}
