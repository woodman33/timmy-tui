/**
 * R10 (H170; CHAT-H170 items 2 and 4): the provider keys a person gives Timmy in its own UI, kept where the setup keeps them:
 * providers.json in the Timmy home (TIMMY_HOME, else ~/timmy), 0600, the file `timmy init --openrouter -` writes
 * (src/utils/init.ts applySetup) and loadConfig reads (src/utils/config.ts). OpenRouter's key in its field,
 * openrouter_api_key (from https://openrouter.ai/keys, or the sign-in's exchange: ./openrouter-signin.ts); Ollama Cloud's in
 * its own, ollama_cloud_api_key (from https://ollama.com/settings/keys). Node only, plus the model key's own reader
 * (src/utils/model-key.ts, node only): nothing here builds the settings store, whose loading writes its file.
 *
 * A key saved is "saved, not checked" until a check answers (./providers-state.ts checkProvider). A key is a token the
 * provider's page shows, pasted, or the one the sign-in exchanged; never an account's password, which nothing here asks for.
 * A key never enters a word this module returns, an error, a log or a URL: only its fingerprint ("key <12 hex>", as
 * modelKeyFingerprint names one) and where it is kept.
 *
 * Writes are atomic (a temporary file in the same folder, 0600, flushed, renamed over the old one), merge into what the file
 * holds (the Ollama host, the other provider's key), and leave the file 0600 also where an older one was 0644. A file that
 * is not a JSON object is never overwritten (what it holds would be lost): the words say so. Forgetting removes the field
 * from providers.json only: a key the environment sets (OPENROUTER_API_KEY, OLLAMA_API_KEY) or an older place holds
 * (timmy-tui.config.json, the monitor's settings) is not Timmy's to delete, and the words say which one is still in use.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { timmyHome, type Env } from './home.js';
import { modelKeyInUse, type KeySource } from '../utils/model-key.js';

export type KeyedProvider = 'openrouter' | 'ollama-cloud';

/** Where each key is kept in providers.json. */
export const KEY_FIELD: Readonly<Record<KeyedProvider, string>> = { openrouter: 'openrouter_api_key', 'ollama-cloud': 'ollama_cloud_api_key' };
/** The environment variable each provider's own tools read; set, it is used before the saved key (as loadConfig does). */
export const KEY_ENV: Readonly<Record<KeyedProvider, string>> = { openrouter: 'OPENROUTER_API_KEY', 'ollama-cloud': 'OLLAMA_API_KEY' };
/** The provider's own page where a person makes a key (official links, PROVIDER_SETUP_GUIDE.md, checked 2026-10-22). */
export const KEY_PAGE: Readonly<Record<KeyedProvider, string>> = { openrouter: 'https://openrouter.ai/keys', 'ollama-cloud': 'https://ollama.com/settings/keys' };
export const PROVIDER_NAME: Readonly<Record<KeyedProvider, string>> = { openrouter: 'OpenRouter', 'ollama-cloud': 'Ollama Cloud' };

/** Where a key in use comes from: OpenRouter's four places (src/utils/model-key.ts), Ollama Cloud's two. */
export type KeyFrom = KeySource;

export const providersFile = (env: Env = process.env): string => join(timmyHome(env), 'providers.json');

/** "key <12 hex>": a key's fingerprint (sha256), what an observation of it names; never the key. */
export const keyFingerprint = (key: string): string => `key ${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;

/** A pasted key as it is kept (trimmed), or why it is not taken. The words never repeat what was pasted. */
export function checkKeyShape(id: KeyedProvider, raw: unknown): { key: string } | { why: string } {
  const name = PROVIDER_NAME[id];
  if (typeof raw !== 'string' || !raw.trim()) return { why: `nothing was pasted: paste the ${name} key from ${KEY_PAGE[id]}` };
  const key = raw.trim();
  if (/[\s\x00-\x1f\x7f-\x9f]/.test(key)) return { why: `that is not one ${name} key: it holds a space, a line break or a control character (paste the key alone)` };
  if (!/^[\x21-\x7e]+$/.test(key)) return { why: `that is not a ${name} key: a key is plain letters, digits and punctuation` };
  if (key.includes('://')) return { why: `that is an address, not a ${name} key: the key is shown on ${KEY_PAGE[id]} when you make one` };
  if (key.length < 20 || key.length > 512) return { why: `that is not a ${name} key: a key is 20 to 512 characters, and this is ${key.length}` };
  return { key };
}

type Body = Record<string, unknown>;

/** providers.json as an object: absent (empty), or why it cannot be used (never overwritten then). */
function readBody(file: string): { body: Body } | { why: string } {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { body: {} } : { why: `providers.json in the Timmy home cannot be read (${code ?? 'error'}), so nothing was changed` };
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return { body: v as Body };
  } catch { /* below */ }
  return { why: 'providers.json in the Timmy home is not a JSON object, so Timmy does not overwrite it (what it holds would be lost): fix or move it, then try again' };
}

/** Writes providers.json: a temporary file (0600) beside it, flushed, renamed over it. */
function writeBody(file: string, body: Body): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(file), `.providers.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(body, null, 1)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
    try { rmSync(tmp, { force: true }); } catch { /* not made */ }
    throw e;
  }
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * The key in use for `id` and where it is (read only): OpenRouter's as the REPL finds it (the environment, a local
 * timmy-tui.config.json, providers.json, the monitor's settings: src/utils/model-key.ts); Ollama Cloud's from OLLAMA_API_KEY,
 * else providers.json. For a check or an adapter (H169's Ollama Cloud route reads it here); never shown.
 */
export function keyInUse(id: KeyedProvider, env: Env = process.env, cwd: string = process.cwd()): { from: KeyFrom; key: string } | null {
  if (id === 'openrouter') {
    const k = modelKeyInUse(env, cwd);
    return k ? { from: k.source, key: k.key } : null;
  }
  const fromEnv = text(env[KEY_ENV[id]]);
  if (fromEnv) return { from: 'environment', key: fromEnv };
  const r = readBody(providersFile(env));
  const saved = 'body' in r ? text(r.body[KEY_FIELD[id]]) : undefined;
  return saved ? { from: 'providers.json', key: saved } : null;
}

/** Where the key in use is and its fingerprint, in words a page may show (never the key). */
export function keyWhere(id: KeyedProvider, env: Env = process.env, cwd: string = process.cwd()): { from: KeyFrom; fingerprint: string; words: string } | null {
  const k = keyInUse(id, env, cwd);
  return k ? { from: k.from, fingerprint: keyFingerprint(k.key), words: fromWords(id, k.from) } : null;
}

export function fromWords(id: KeyedProvider, from: KeyFrom): string {
  switch (from) {
    case 'environment': return `${KEY_ENV[id]} in this environment`;
    case 'timmy-tui.config.json': return 'timmy-tui.config.json in the working folder';
    case 'providers.json': return 'providers.json in the Timmy home (0600)';
    case 'settings': return 'the monitor\'s settings (an older place)';
  }
}

export type SaveKeyResult = { ok: true; fingerprint: string; path: string; words: string } | { ok: false; why: string };

/** Saves a pasted (or exchanged) key in providers.json, 0600: "saved, not checked" until a check answers. */
export function saveKey(id: KeyedProvider, raw: unknown, env: Env = process.env, cwd: string = process.cwd()): SaveKeyResult {
  const shaped = checkKeyShape(id, raw);
  if ('why' in shaped) return { ok: false, why: shaped.why };
  const file = providersFile(env);
  const r = readBody(file);
  if ('why' in r) return { ok: false, why: r.why };
  try { writeBody(file, { ...r.body, [KEY_FIELD[id]]: shaped.key }); } catch (e) {
    return { ok: false, why: `the key was not saved: providers.json could not be written (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const fingerprint = keyFingerprint(shaped.key);
  const used = keyInUse(id, env, cwd);
  const elsewhere = used && used.from !== 'providers.json' ? ` ${fromWords(id, used.from)} is used before it while that is set.` : '';
  return { ok: true, fingerprint, path: file, words: `Saved, not checked: the ${PROVIDER_NAME[id]} key (${fingerprint}) is in providers.json in the Timmy home (0600).${elsewhere}` };
}

export type ForgetKeyResult = { ok: true; removed: boolean; path: string; stillUsed: KeyFrom | null; words: string } | { ok: false; why: string };

/** Removes the key from providers.json (nothing else); says which key, if any, is still in use and where it is kept. */
export function forgetKey(id: KeyedProvider, env: Env = process.env, cwd: string = process.cwd()): ForgetKeyResult {
  const file = providersFile(env);
  const r = readBody(file);
  if ('why' in r) return { ok: false, why: r.why };
  const field = KEY_FIELD[id];
  const had = Object.prototype.hasOwnProperty.call(r.body, field);
  if (had) {
    const { [field]: _gone, ...rest } = r.body;
    void _gone;
    try { writeBody(file, rest); } catch (e) {
      return { ok: false, why: `the key was not forgotten: providers.json could not be written (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
    }
  }
  const still = keyInUse(id, env, cwd);
  const name = PROVIDER_NAME[id];
  const words = (had ? `Forgotten: providers.json in the Timmy home no longer holds the ${name} key.` : `providers.json in the Timmy home held no ${name} key.`)
    + (still ? ` Still in use: the ${name} key from ${fromWords(id, still.from)}, which Timmy does not delete.` : ` No ${name} key is set up now.`);
  return { ok: true, removed: had, path: file, stillUsed: still?.from ?? null, words };
}
