// timmy init — the first run is blank (ORDER blank-slate-v1k9), and since round R4 (H98) Timmy's one guided setup.
//
// A fresh clone carries no operator, no identity, no providers, no project and no receipts. `timmy init` asks for them
// and writes ONLY to two places (and the receipts store pin):
//   ~/timmy/            (TIMMY_HOME)         identity.json, identity.seed (0600), providers.json (0600), setup.json (0600), projects/<name>/
//   <repo>/.timmy/private/ (TIMMY_PRIVATE_DIR) config.json (merged), projects.json (merged)
// Nothing in the public tree changes. `isBlankSlate()` is what the CLI and the TUI ask before showing anything else;
// without a TTY (or --yes) the wizard prints what it would ask and writes nothing, so a first launch in a container still
// shows the wizard.
//
// R4 (H98): the questions are src/setup/questions.ts's, the same the monitor (`timmy watch`) and the REPL's /setup ask;
// each is asked only while it has no answer (what an older `timmy init` wrote counts), the local model and local-only
// logs are preselected, and an existing identity is never replaced (applySetup keeps identity.json and identity.seed).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { identityPath as identityPathOf, isBlankSlate as blankSlate, privateDir as privateDirOf, prettyPath, setupPath, timmyHome as homeOf, workspaceRoot as workspaceOf } from '../setup/home.js';
import { OLLAMA_DEFAULT, PROJECT_DEFAULT, OPERATOR_DEFAULT, pendingQuestions, readSetupState, setupSummary, type Answers, type Chat, type Logs, type SetupState } from '../setup/questions.js';
import { askSetup, terminalIO, wrap, type SetupIO } from '../setup/terminal.js';

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
  ['identity', 'A new key, or a PEM or hex seed path'],
  ['ollama', 'Ollama host (the local model)'],
  ['chat', 'Chat: local model (default) or OpenRouter'],
  ['logs', 'Logs: this computer (default) or a worker'],
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
  log('    --operator <name>  --seed generate|<pem|hex>');
  log('    --ollama <host>  --chat local|openrouter');
  log('    --openrouter <key>  --logs local|cloud');
  log('    --project <name>  --edge-host <host>  --json\n');
}
const relPretty = (p: string): string => prettyPath(p);

export interface InitOptions {
  yes: boolean; json: boolean;
  operator?: string; seed?: string; openrouter?: string; anthropic?: string; ollama?: string; project?: string; edgeHost?: string;
  /** R4 (H98): `--chat local|openrouter`, `--logs local|cloud` */
  chat?: Chat; logs?: Logs;
  /** a flag with a value it cannot take, in words */
  error?: string;
}
export function parseInitArgs(args: string[]): InitOptions {
  const o: InitOptions = { yes: args.includes('--yes') || args.includes('-y'), json: args.includes('--json') };
  const v = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
  o.operator = v('--operator'); o.seed = v('--seed'); o.openrouter = v('--openrouter'); o.anthropic = v('--anthropic');
  o.ollama = v('--ollama'); o.project = v('--project'); o.edgeHost = v('--edge-host');
  const chat = v('--chat');
  if (chat !== undefined) { if (chat === 'local' || chat === 'openrouter') o.chat = chat; else o.error = `--chat takes local or openrouter, not ${chat}.`; }
  const logs = v('--logs');
  if (logs !== undefined) { if (logs === 'local' || logs === 'cloud') o.logs = logs; else o.error = `--logs takes local or cloud, not ${logs}.`; }
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
    ...(o.logs ? { logs: o.logs } : {}),
    ...(o.edgeHost !== undefined ? { edge: o.edgeHost } : {}),
    ...(o.project !== undefined ? { project: o.project } : {}),
  };
}

interface Identity { operatorId: string; publicKeyHex: string; privatePem: string; source: 'generated' | 'imported' }
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export function seedIdentity(seed: string | undefined): Identity {
  let priv;
  let source: Identity['source'] = 'generated';
  if (!seed || seed === 'generate' || seed === 'g') {
    priv = generateKeyPairSync('ed25519').privateKey;
  } else if (/^[0-9a-fA-F]{64}$/.test(seed)) {
    priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' }); source = 'imported';
  } else if (existsSync(seed)) {
    priv = createPrivateKey(readFileSync(seed, 'utf8')); source = 'imported';
  } else throw new Error('seed must be "generate", a 64-hex ed25519 seed, or a path to a PEM private key');
  const pubDer = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  return { operatorId: 'op_' + createHash('sha256').update(pubDer).digest('hex').slice(0, 16), publicKeyHex: pubDer.toString('hex'), privatePem: priv.export({ format: 'pem', type: 'pkcs8' }) as string, source };
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

export interface InitResult { ok: boolean; written: string[]; operator: string; operator_id: string; project: string; identity_source: string; home: string; private_dir: string; store_pin?: string }

/** R4 (H98): an identity exists and a seed was given: it is never replaced (refused, nothing written). */
export const IDENTITY_KEPT = 'An identity already exists in the Timmy home (identity.json, identity.seed); Timmy never replaces it, so --seed was not used and nothing was written. To make a new one, move those two files away first.';
/** R4 (H98): an identity.seed with no identity.json, that is not a key Timmy can read: kept as it is, nothing written. */
export const SEED_UNREADABLE = 'The Timmy home has an identity.seed but no identity.json, and that seed is not a key Timmy can read. Timmy never replaces it, so nothing was written: move identity.seed away (or put its identity.json back), then run timmy init again.';

/**
 * R4 (H98): writes the setup's answers: only what was answered now, merged into what the home holds. An existing
 * identity is kept (identity.json and identity.seed are never replaced; a new operator name only renames it there), a
 * provider key is added and never removed, a project is added to the private list, never over it. setup.json records the
 * answers in words (never a key) and who gave them (`by`).
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
  // providers: the Ollama host; a key only when one was given (never removed)
  const providersPatch: Record<string, string> = {};
  if (answers.ollama !== undefined || !s.providers.exists) providersPatch.ollama_host = answers.ollama || s.providers.ollama || OLLAMA_DEFAULT;
  if (answers.key) providersPatch.openrouter_api_key = answers.key;
  if (answers.anthropic) providersPatch.anthropic_api_key = answers.anthropic;
  if (Object.keys(providersPatch).length) written.push(mergeJson(join(home, 'providers.json'), providersPatch, 0o600, repoRoot));
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
      ...(chat ? { chat } : {}), ...(answers.logs ?? prev.logs ? { logs: answers.logs ?? prev.logs } : {}),
      ...(answers.edge !== undefined ? { edge: answers.edge } : prev.edge !== undefined ? { edge: prev.edge } : {}), project,
    },
  }, 0o600, repoRoot));
  return { ok: true, written: [...new Set(written)], operator, operator_id: operatorId, project, identity_source: source, home, private_dir: priv, store_pin: existsSync(pin) ? pin : undefined };
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
    if (q.id === 'key' || q.id === 'edge') continue; // no key and no host unless given
    const pre = q.preselect({ ...out }, state);
    if (q.id === 'chat') out.chat = pre as Chat;
    else if (q.id === 'logs') out.logs = pre as Logs;
    else (out as Record<string, string>)[q.id] = pre;
  }
  return out;
}

/** Where a run of the guided setup may write, as a person reads it. */
function writesFor(state: SetupState, repoRoot: string): string[] {
  const pin = join(repoRoot, '.timmy', 'store-pin');
  return [`${relPretty(timmyHome())}/`, `${relPretty(privateDir(repoRoot))}/`, ...(existsSync(pin) ? [] : [`${relPretty(pin)} (the receipts store)`])];
}

/**
 * R4 (H98): the guided setup in this terminal, as `timmy init` and `timmy watch` run it: asks what has no answer (flags
 * answer too), writes after a yes, prints one line of what the setup chose. 0 set up (or nothing to ask), 1 declined,
 * 130 stopped (Ctrl+C), 2 a refused flag.
 */
export async function guidedSetup(by: string, given: Answers = {}, io: SetupIO = terminalIO(), o: { json?: boolean; title?: string } = {}): Promise<number> {
  const repoRoot = workspaceRoot();
  const state = readSetupState(process.env, repoRoot);
  if (state.identity.exists && given.identity !== undefined) { io.log(`  ${IDENTITY_KEPT}`); return 2; }
  const pending = pendingQuestions(state, given);
  if (!pending.length && !Object.keys(given).length) {
    io.log('');
    for (const l of wrap(`Every setup question has an answer: ${setupSummary(state)}.`)) io.log(l);
    for (const l of wrap('To change one: timmy init --chat local|openrouter, --openrouter <key>, --logs local|cloud, --ollama <host> or --operator <name> (an identity is never replaced).')) io.log(l);
    io.log('');
    return 0;
  }
  const asked = await askSetup({ state, given, io, title: o.title ?? (state.identity.exists ? 'TIMMY · guided setup' : 'TIMMY · first run — guided setup'), writes: writesFor(state, repoRoot) });
  if ('stopped' in asked) return asked.stopped === 'interrupted' ? 130 : 1;
  return applyAndReport(asked.answers, { by, repoRoot, state }, io, o.json === true);
}

/** Writes and reports; a refusal (an unreadable seed, a seed that is not one) in words, exit 1. */
function applyAndReport(answers: Answers, w: { by: string; repoRoot?: string; state: SetupState }, io: Pick<SetupIO, 'log'>, json: boolean): number {
  let r: InitResult;
  try { r = applySetup(answers, w); } catch (e) {
    io.log(`  ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return report(r, io, json);
}

/** What was written, and the one line of what the setup chose. */
function report(r: InitResult, io: Pick<SetupIO, 'log'>, json: boolean): number {
  if (json) { io.log(JSON.stringify(r)); return 0; }
  const after = readSetupState();
  io.log('');
  for (const l of wrap(`✓ Set up: ${setupSummary(after)}.`)) io.log(l);
  io.log(`    identity ${r.operator_id} (${r.identity_source})`);
  for (const w of r.written) io.log(`    wrote ${relPretty(w)}`);
  io.log('\n  Next: `timmy doctor`, then `timmy` to open the REPL.');
  io.log('  In the REPL: Studio /studio · Control Room /room ·');
  io.log('  God\'s Eye View /overview · all three in your browser:');
  io.log('  /board live. The monitor: timmy watch.\n');
  return 0;
}

/** The wizard. Returns the process exit code. */
export async function runInit(args: string[], io: { isTTY: boolean; log: (s: string) => void; question?: (q: string) => Promise<string> } = { isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), log: console.log }): Promise<number> {
  const o = parseInitArgs(args);
  if (o.error) { io.log(`  ${o.error}`); return 2; }
  if (!o.yes && !io.isTTY) { printBlankSlateBanner(io.log); io.log('  (no TTY: nothing written — answer with flags and --yes)'); return 0; }
  const given = answersFromFlags(o);
  if (o.yes) {
    const state = readSetupState();
    if (state.identity.exists && given.identity !== undefined) { io.log(`  ${IDENTITY_KEPT}`); return 2; }
    return applyAndReport(withDefaults(state, given), { by: 'timmy init', state }, { log: io.log }, o.json);
  }
  const term = terminalIO(io.log);
  return guidedSetup('timmy init', given, io.question ? { ...term, question: io.question, hidden: io.question } : term, { json: o.json });
}
