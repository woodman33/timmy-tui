// timmy init — the first run is blank (ORDER blank-slate-v1k9).
//
// A fresh clone carries no operator, no identity, no providers, no project and no
// receipts. `timmy init` asks for them and writes ONLY to two places:
//   ~/timmy/            (TIMMY_HOME)         identity.json, identity.seed (0600), providers.json (0600), projects/<name>/
//   <repo>/.timmy/private/ (TIMMY_PRIVATE_DIR) config.json (merged), projects.json
// Nothing in the public tree changes. `isBlankSlate()` is what the CLI and the TUI ask
// before showing anything else; without a TTY (or --yes) the wizard prints what it would
// ask and writes nothing, so a first launch in a container still shows the wizard.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { ensureStorePin } from './receipts.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const timmyHome = (): string => process.env.TIMMY_HOME || join(homedir(), 'timmy');
export const privateDir = (): string => process.env.TIMMY_PRIVATE_DIR || join(REPO_ROOT, '.timmy', 'private');
export const identityPath = (): string => join(timmyHome(), 'identity.json');
export const isBlankSlate = (): boolean => !existsSync(identityPath());

export const BANNER = 'TIMMY · first run — blank slate';
export const QUESTIONS: ReadonlyArray<readonly [string, string]> = [
  ['operator', 'Operator name (how the ship addresses you; goes into receipts as operator_label)'],
  ['seed', 'Seed identity: [g]enerate an ed25519 seed, or a path to a PEM / 64-hex seed to import'],
  ['providers', 'Providers: OpenRouter API key (blank = skip), Anthropic API key (blank = skip), Ollama host (default http://127.0.0.1:11434)'],
  ['project', 'First project name (created under ~/timmy/projects/<name>)'],
];

export function printBlankSlateBanner(log: (s: string) => void = console.log): void {
  log(`\n  ${BANNER}\n`);
  log('  No operator, identity, providers or project yet. Nothing in this tree is personal,');
  log('  and nothing will be written to it. `timmy init` asks four things and writes only to');
  log(`  ${relPretty(timmyHome())}/ and ${relPretty(privateDir())}/ (plus the gitignored receipts store pin, <repo>/.timmy/store-pin):`);
  for (const [k, q] of QUESTIONS) log(`    ${k.padEnd(10)} ${q}`);
  log('\n  Non-interactive: timmy init --yes [--operator <name>] [--seed generate|<pem|hex>] [--openrouter <key>]');
  log('                   [--anthropic <key>] [--ollama <host>] [--project <name>] [--edge-host <host>] [--json]\n');
}
const relPretty = (p: string): string => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p.startsWith(REPO_ROOT) ? '<repo>' + p.slice(REPO_ROOT.length) : p);

export interface InitOptions {
  yes: boolean; json: boolean;
  operator?: string; seed?: string; openrouter?: string; anthropic?: string; ollama?: string; project?: string; edgeHost?: string;
}
export function parseInitArgs(args: string[]): InitOptions {
  const o: InitOptions = { yes: args.includes('--yes') || args.includes('-y'), json: args.includes('--json') };
  const v = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
  o.operator = v('--operator'); o.seed = v('--seed'); o.openrouter = v('--openrouter'); o.anthropic = v('--anthropic');
  o.ollama = v('--ollama'); o.project = v('--project'); o.edgeHost = v('--edge-host');
  return o;
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
function guardPath(p: string, extraAllowed: string[] = []): string {
  const abs = resolve(p);
  const under = (root: string) => { const r = relative(resolve(root), abs); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  const ok = [timmyHome(), privateDir()].some(under) || extraAllowed.some((e) => resolve(e) === abs);
  if (!ok) throw new Error(`refusing to write outside TIMMY_HOME / TIMMY_PRIVATE_DIR: ${abs}`);
  return abs;
}
function writeJson(p: string, data: unknown, mode = 0o644): string { const abs = guardPath(p); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, JSON.stringify(data, null, 1) + '\n', { mode }); return abs; }
function mergeJson(p: string, patch: Record<string, unknown>, mode = 0o600): string {
  const abs = guardPath(p);
  let cur: Record<string, unknown> = {};
  if (existsSync(abs)) { try { cur = JSON.parse(readFileSync(abs, 'utf8')); } catch { cur = {}; } }
  return writeJson(abs, { ...cur, ...patch }, mode);
}

export interface InitResult { ok: boolean; written: string[]; operator: string; operator_id: string; project: string; identity_source: string; home: string; private_dir: string; store_pin?: string }

export function applyInit(a: Required<Pick<InitOptions, 'operator' | 'project'>> & InitOptions, repoRoot: string = REPO_ROOT): InitResult {
  const id = seedIdentity(a.seed);
  const home = timmyHome(); const priv = privateDir();
  const written: string[] = [];
  // the receipts store pin: generated here on the first run, never committed
  const pin = join(repoRoot, '.timmy', 'store-pin');
  if (!existsSync(pin)) { guardPath(pin, [pin]); ensureStorePin(repoRoot); if (existsSync(pin)) written.push(pin); }
  written.push(writeJson(join(home, 'identity.json'), { version: 1, operator: a.operator, operator_id: id.operatorId, public_key_hex: id.publicKeyHex, seed_source: id.source, created: new Date().toISOString() }));
  const seedPath = guardPath(join(home, 'identity.seed')); writeFileSync(seedPath, id.privatePem, { mode: 0o600 }); written.push(seedPath);
  const providers: Record<string, string> = { ollama_host: a.ollama || 'http://127.0.0.1:11434' };
  if (a.openrouter) providers.openrouter_api_key = a.openrouter;
  if (a.anthropic) providers.anthropic_api_key = a.anthropic;
  written.push(writeJson(join(home, 'providers.json'), providers, 0o600));
  const projDir = guardPath(join(home, 'projects', a.project)); mkdirSync(projDir, { recursive: true });
  const readme = join(projDir, 'README.md');
  if (!existsSync(readme)) writeFileSync(readme, `# ${a.project}\n\nFirst TIMMY project of ${a.operator} (${id.operatorId}). Created by \`timmy init\`.\n`);
  written.push(readme);
  written.push(mergeJson(join(priv, 'config.json'), { operator_label: a.operator, operator_id: id.operatorId, first_project: a.project, ...(a.edgeHost ? { edge_host: a.edgeHost } : {}) }));
  written.push(writeJson(join(priv, 'projects.json'), { projects: [{ name: a.project, path: projDir, created: new Date().toISOString() }] }, 0o600));
  return { ok: true, written, operator: a.operator, operator_id: id.operatorId, project: a.project, identity_source: id.source, home, private_dir: priv, store_pin: existsSync(pin) ? pin : undefined };
}

/** The wizard. Returns the process exit code. */
export async function runInit(args: string[], io: { isTTY: boolean; log: (s: string) => void; question?: (q: string) => Promise<string> } = { isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), log: console.log }): Promise<number> {
  const o = parseInitArgs(args);
  if (!o.yes && !io.isTTY) { printBlankSlateBanner(io.log); io.log('  (no TTY: nothing written — answer with flags and --yes)'); return 0; }
  const answers = { ...o, operator: o.operator ?? 'operator', seed: o.seed ?? 'generate', project: o.project ?? 'first-light' };
  if (!o.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = io.question ?? ((q: string) => rl.question(q));
    try {
      printBlankSlateBanner(io.log);
      answers.operator = (await ask(`  ${QUESTIONS[0][1]}\n  > `)).trim() || answers.operator;
      answers.seed = (await ask(`  ${QUESTIONS[1][1]}\n  > [g] `)).trim() || 'generate';
      answers.openrouter = (await ask('  OpenRouter API key (blank = skip)\n  > ')).trim() || undefined;
      answers.anthropic = (await ask('  Anthropic API key (blank = skip)\n  > ')).trim() || undefined;
      answers.ollama = (await ask('  Ollama host\n  > [http://127.0.0.1:11434] ')).trim() || undefined;
      answers.project = (await ask(`  ${QUESTIONS[3][1]}\n  > [first-light] `)).trim() || 'first-light';
      io.log(`\n  Will write to ${relPretty(timmyHome())}/ and ${relPretty(privateDir())}/ — nothing else.`);
      const go = (await ask('  Proceed? [Y/n] ')).trim().toLowerCase();
      if (go && go !== 'y' && go !== 'yes') { io.log('  aborted; nothing written'); return 1; }
    } finally { rl.close(); }
  }
  const r = applyInit(answers);
  if (o.json) io.log(JSON.stringify(r));
  else {
    io.log(`\n  ✓ ${r.operator} (${r.operator_id}) · identity ${r.identity_source} · project ${r.project}`);
    for (const w of r.written) io.log(`    wrote ${relPretty(w)}`);
    io.log('\n  Next: `timmy doctor`, then `npm start`.\n');
  }
  return 0;
}
