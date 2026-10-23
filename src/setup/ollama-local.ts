/**
 * R10 (H170; CHAT-H170 item 3): Ollama on this computer, told apart: installed (the `ollama` program on the PATH, or the macOS
 * app), its server answering (GET /api/version), the models it holds (GET /api/tags, ./ollama-models.ts listOllamaModels,
 * and the local probe's /api/show check, src/agent/providers.ts probeOllama: installed local completion weights) and the
 * models it has loaded now (GET /api/ps). Installed is not running, and a model held is not a model loaded; each is said
 * apart, with when it was observed. Every request goes to the loopback address the chat asks (src/capabilities/ollama-route.ts)
 * and costs nothing; no model is run by any of them.
 *
 * The optional starter download: three small models, their sizes as the official library pages display them (artifact
 * sizes: what is downloaded, not the memory a model needs, and no benchmark of Timmy's). Nothing is downloaded without a
 * confirmation the caller holds: confirmPull() is called on the person's own step, after the free-disk check, and ollamaPull
 * refuses anything else. The pull is POST /api/pull, its progress streamed (bytes done of total), Cancel aborts it (Ollama
 * keeps what it downloaded, and a later pull resumes it), and its errors are said in words (the disk full, no network, no
 * such model). Tests use a FAKE Ollama on 127.0.0.1 only; nothing here ever downloads in a test.
 */
import { accessSync, constants, existsSync, statfsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Env } from './home.js';
import { listOllamaModels, type ListedModel } from './ollama-models.js';

/** Official pages (PROVIDER_SETUP_GUIDE.md, checked 2026-10-22). */
export const OLLAMA_LINKS = {
  download: 'https://ollama.com/download',
  quickstart: 'https://docs.ollama.com/quickstart',
  library: 'https://ollama.com/library',
} as const;

/** The starter models: tags, sizes as the library pages display them (artifact sizes), and what each is for. */
export const STARTER_MODELS: ReadonlyArray<{ model: string; size: string; bytes: number; use: string; page: string; default: boolean }> = [
  { model: 'qwen3:0.6b', size: '523 MB', bytes: 523e6, use: 'a small text starter to evaluate', page: 'https://ollama.com/library/qwen3:0.6b', default: true },
  { model: 'qwen3.5:0.8b', size: '1.2 GB (MLX) / 1.3 GB (llama.cpp)', bytes: 1.3e9, use: 'a newer small option to evaluate', page: 'https://ollama.com/library/qwen3.5:0.8b', default: false },
  { model: 'smollm2:135m-instruct-q4_0', size: '92 MB', bytes: 92e6, use: 'a limited demonstration, not the default agent', page: 'https://ollama.com/library/smollm2:135m-instruct-q4_0', default: false },
];
export const SIZE_NOTE = 'artifact sizes as the Ollama library shows them: what is downloaded, not the memory a model needs';

/** The steps that install and start Ollama here, in words, with the official page. */
export function installSteps(platform: NodeJS.Platform = process.platform): { install: string; start: string; link: string } {
  switch (platform) {
    case 'darwin': return { install: 'download the Ollama app for macOS (or: brew install ollama)', start: 'open the Ollama app (or: ollama serve)', link: `${OLLAMA_LINKS.download}/mac` };
    case 'linux': return { install: 'curl -fsSL https://ollama.com/install.sh | sh (the official install script)', start: 'ollama serve (or: systemctl start ollama)', link: `${OLLAMA_LINKS.download}/linux` };
    case 'win32': return { install: 'download the Ollama installer for Windows', start: 'start Ollama from the Start menu (or: ollama serve)', link: `${OLLAMA_LINKS.download}/windows` };
    default: return { install: 'install Ollama for this system', start: 'ollama serve', link: OLLAMA_LINKS.download };
  }
}

/** Where `program` is on the PATH (the first executable file), or null. Nothing is run. */
export function onPath(program: string, env: Env = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, program);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* not here */ }
  }
  return null;
}

/** Whether Ollama is installed here, and how: its program on the PATH, or the macOS app. Files only. */
export function ollamaInstalled(o: { env?: Env; platform?: NodeJS.Platform; home?: string; exists?: (p: string) => boolean } = {}): { installed: boolean; how?: 'program' | 'app'; words: string } {
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  if (onPath('ollama', env)) return { installed: true, how: 'program', words: 'installed (the ollama program is on the PATH)' };
  if ((o.platform ?? process.platform) === 'darwin') {
    for (const app of ['/Applications/Ollama.app', join(o.home ?? homedir(), 'Applications', 'Ollama.app')]) {
      if (exists(app)) return { installed: true, how: 'app', words: 'installed (the Ollama app is in Applications)' };
    }
  }
  return { installed: false, words: 'not installed here (no ollama program on the PATH, and no Ollama app)' };
}

/** One model Ollama has loaded now (GET /api/ps). */
export interface RunningModel { name: string; sizeBytes: number | null; vramBytes: number | null; until: string | null }

/** What Ollama answered at `origin` now: its version, the models it holds, the ones loaded. */
export type OllamaObservation =
  | { answered: true; at: string; origin: string; version: string | null; models: ListedModel[]; running: RunningModel[] | null; why?: undefined }
  | { answered: false; at: string; origin: string; why: string };

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Asks Ollama at `origin` (loopback only, as the chat asks it): GET /api/version, /api/tags and /api/ps. No charge, no model run. */
export async function observeOllama(origin: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<OllamaObservation> {
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 2500;
  const at = new Date().toISOString();
  let u: URL;
  try { u = new URL(origin); } catch { return { answered: false, at, origin, why: `${origin} is not an address` }; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return { answered: false, at, origin, why: `${u.host} is not this computer: Timmy asks a local Ollama only at a loopback address` };
  const get = async (path: string): Promise<Record<string, unknown> | string> => {
    try {
      const res = await doFetch(`${u.origin}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!res.ok) { try { await res.body?.cancel(); } catch { /* nothing to read */ } return `HTTP ${res.status}`; }
      return obj(await res.json());
    } catch (e) {
      const code = (e as { cause?: { code?: unknown } })?.cause?.code;
      return typeof code === 'string' && /^[A-Z_]{3,40}$/.test(code) ? `the connection failed (${code})` : 'no answer';
    }
  };
  const version = await get('/api/version');
  // the cause alone: every sentence that says it names the address already
  if (typeof version === 'string') return { answered: false, at, origin: u.origin, why: version };
  const list = await listOllamaModels(u.origin, { timeoutMs });
  const ps = await get('/api/ps');
  const running = typeof ps === 'string' || !Array.isArray(ps.models) ? null : ps.models.slice(0, 64).map((m) => {
    const r = obj(m);
    return { name: typeof r.name === 'string' ? r.name : typeof r.model === 'string' ? r.model : '?', sizeBytes: count(r.size), vramBytes: count(r.size_vram), until: typeof r.expires_at === 'string' ? r.expires_at : null };
  });
  return { answered: true, at, origin: u.origin, version: typeof version.version === 'string' ? version.version : null, models: list.ok ? list.models : [], running };
}

/** Where Ollama keeps its models here (OLLAMA_MODELS, else ~/.ollama/models), for the free-disk check. */
export const modelsDir = (env: Env = process.env, home: string = homedir()): string => env.OLLAMA_MODELS?.trim() || join(home, '.ollama', 'models');

/** Free bytes on the disk that holds `dir` (its nearest folder that exists), or null when the system cannot say. */
export function freeBytes(dir: string, statfs: (p: string) => { bavail: number | bigint; bsize: number | bigint } = statfsSync): number | null {
  let p = dir;
  for (let i = 0; i < 64; i++) {
    try {
      if (existsSync(p)) { const s = statfs(p); return Number(s.bavail) * Number(s.bsize); }
    } catch { return null; }
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return null;
}

/** Bytes in the library's decimal units: 523 MB, 1.3 GB (a layer under a megabyte in KB or B, never rounded up to 1 MB). */
export const units = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

/** A confirmation that the person chose this download, made only by confirmPull: ollamaPull takes nothing else. */
export interface PullConfirmation { readonly model: string; readonly size: string; readonly free: string; readonly at: string }
const issued = new WeakSet<PullConfirmation>();

/**
 * The free-disk check, then the confirmation, for one of the starter models (or a model the person named, its size unknown).
 * Call it on the person's own step ("Download qwen3:0.6b, 523 MB"). Refused, in words, when the disk lacks room for it with a
 * tenth to spare; a size or free space not known is said, never guessed, and the person's step still decides.
 */
export function confirmPull(model: string, o: { env?: Env; home?: string; free?: number | null } = {}): { ok: true; confirmation: PullConfirmation; words: string } | { ok: false; words: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) return { ok: false, words: 'that is not a model name Ollama pulls (letters, digits and . _ : / -)' };
  const starter = STARTER_MODELS.find((s) => s.model === model);
  const free = o.free !== undefined ? o.free : freeBytes(modelsDir(o.env, o.home));
  if (starter && free !== null && free < starter.bytes * 1.1) {
    return { ok: false, words: `Not enough free disk for ${model} (${starter.size}): ${units(free)} free where Ollama keeps its models. Free some space, or choose a smaller model.` };
  }
  const c: PullConfirmation = Object.freeze({ model, size: starter?.size ?? 'size not known (not a starter model)', free: free === null ? 'free space not known' : `${units(free)} free`, at: new Date().toISOString() });
  issued.add(c);
  return { ok: true, confirmation: c, words: `Download ${model} (${c.size}; ${c.free}). Ollama downloads it from its library; nothing else is installed.` };
}

export interface PullProgress { status: string; done: number; total: number | null; words: string }
export type PullResult =
  | { ok: true; model: string; at: string; words: string }
  | { ok: false; model: string; at: string; reason: 'not confirmed' | 'cancelled' | 'disk full' | 'no network' | 'no such model' | 'no answer' | 'failed'; words: string };

/** Ollama's error, in words, and its kind. */
export function pullErrorWords(raw: string): { reason: Extract<PullResult, { ok: false }>['reason']; words: string } {
  const e = raw.slice(0, 300);
  if (/no space left|disk full|not enough space/i.test(e)) return { reason: 'disk full', words: 'the disk is full: Ollama could not write the model. Free some space, then pull again (it resumes).' };
  if (/dial tcp|no such host|lookup .* on|i\/o timeout|network is unreachable|connection refused|TLS handshake|tls:/i.test(e)) return { reason: 'no network', words: 'no network: Ollama could not reach its library. Connect, then pull again (it resumes).' };
  if (/file does not exist|not found|manifest unknown|pull access denied/i.test(e)) return { reason: 'no such model', words: 'the Ollama library has no model of that name.' };
  return { reason: 'failed', words: `Ollama said: ${e.replace(/[\x00-\x1f\x7f]/g, ' ')}` };
}

/**
 * Downloads `model` into the local Ollama at `origin`: POST /api/pull, streamed. Only with a confirmation confirmPull made for
 * this model; `onProgress` gets bytes done of total; `signal` cancels (what Ollama downloaded stays, and a later pull resumes).
 * Ends with the installed status read back (GET /api/tags).
 */
export async function ollamaPull(model: string, onProgress: (p: PullProgress) => void, signal: AbortSignal | undefined, o: { confirmation: PullConfirmation | undefined; origin: string; fetch?: typeof fetch }): Promise<PullResult> {
  const at = (): string => new Date().toISOString();
  if (!o.confirmation || !issued.has(o.confirmation) || o.confirmation.model !== model) {
    return { ok: false, model, at: at(), reason: 'not confirmed', words: `Not downloaded: ${model} needs the person's confirmation first (its size and the free disk shown, then their step).` };
  }
  const doFetch = o.fetch ?? fetch;
  let u: URL;
  try { u = new URL(o.origin); } catch { return { ok: false, model, at: at(), reason: 'no answer', words: `${o.origin} is not an address` }; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return { ok: false, model, at: at(), reason: 'no answer', words: `${u.host} is not this computer: Timmy downloads only into a local Ollama` };
  let res: Response;
  try {
    res = await doFetch(`${u.origin}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal, redirect: 'error' });
  } catch {
    if (signal?.aborted) return { ok: false, model, at: at(), reason: 'cancelled', words: `Cancelled: ${model} was not downloaded.` };
    return { ok: false, model, at: at(), reason: 'no answer', words: `Ollama did not answer at ${u.host}: start it, then try again.` };
  }
  if (!res.ok || !res.body) {
    let said = '';
    try { said = String(obj(await res.json()).error ?? ''); } catch { /* none */ }
    const w = said ? pullErrorWords(said) : { reason: 'failed' as const, words: `Ollama refused the pull (HTTP ${res.status}).` };
    return { ok: false, model, at: at(), ...w };
  }
  const layers = new Map<string, { total: number; done: number }>();
  let last = '';
  const decoder = new TextDecoder();
  let buf = '';
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m: Record<string, unknown>;
        try { m = obj(JSON.parse(line)); } catch { continue; }
        if (typeof m.error === 'string') { try { await reader.cancel(); } catch { /* closed */ } return { ok: false, model, at: at(), ...pullErrorWords(m.error) }; }
        const status = typeof m.status === 'string' ? m.status.slice(0, 120) : '';
        last = status || last;
        if (typeof m.digest === 'string' && count(m.total) !== null) layers.set(m.digest, { total: count(m.total)!, done: count(m.completed) ?? layers.get(m.digest)?.done ?? 0 });
        const total = [...layers.values()].reduce((s, l) => s + l.total, 0);
        const doneBytes = [...layers.values()].reduce((s, l) => s + Math.min(l.done, l.total), 0);
        onProgress({ status, done: doneBytes, total: total || null, words: total ? `${units(doneBytes)} of ${units(total)}${status ? ` · ${status}` : ''}` : status || 'starting' });
      }
    }
  } catch {
    if (signal?.aborted) return { ok: false, model, at: at(), reason: 'cancelled', words: `Cancelled: Ollama keeps what it downloaded of ${model}, and pulling it again resumes there.` };
    return { ok: false, model, at: at(), reason: 'no answer', words: `Ollama stopped answering during the download of ${model}: pull it again (it resumes).` };
  }
  if (last !== 'success') return { ok: false, model, at: at(), reason: 'failed', words: `The download of ${model} ended without Ollama saying it succeeded (its last word: ${last || 'none'}).` };
  const list = await listOllamaModels(u.origin, { timeoutMs: 3000 });
  const held = list.ok && list.models.some((m) => m.name === model || m.name === `${model}:latest`);
  return held
    ? { ok: true, model, at: at(), words: `Downloaded: Ollama lists ${model} as installed now.` }
    : { ok: false, model, at: at(), reason: 'failed', words: `Ollama said the download succeeded, and its list does not show ${model} (${list.ok ? 'not listed' : list.why}).` };
}
