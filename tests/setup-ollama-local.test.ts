/**
 * R10 (H170; CHAT-H170 item 3): Ollama on this computer, told apart (installed, its server answering, the models it holds,
 * the ones loaded), and the optional starter download, against a FAKE Ollama on 127.0.0.1 only. The FAKE plays GET
 * /api/version, /api/tags, /api/ps, POST /api/show and a streamed POST /api/pull (its layers in steps; modes for a full disk,
 * no network, and a pull that stalls so Cancel can stop it, kept partial so the next pull resumes). Nothing is downloaded
 * from anywhere: no request leaves 127.0.0.1, no process is started (the `ollama` on the PATH is a file never run), and a
 * pull without the person's confirmation is refused before any request.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkProvider, providerState } from '../src/setup/providers-state.js';
import { confirmPull, freeBytes, installSteps, localHardware, ollamaInstalled, ollamaPull, pullErrorWords, STARTER_MODELS, type PullProgress } from '../src/setup/ollama-local.js';

const trap = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  const wrapped = Object.fromEntries(names.map((n) => [n, (...args: unknown[]) => { trap.calls.push(`${n} ${String(args[0])}`); throw new Error(`a child process was started (${n})`); }]));
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

type PullMode = 'ok' | 'disk-full' | 'no-network' | 'stall';
/** FAKE Ollama: FAKE model names, FAKE layers; a pull's bytes kept per model, so a cancelled pull resumes. */
function fakeOllama() {
  const installed = new Set<string>(['fake-qwen3:8b']);
  const running = new Set<string>(['fake-qwen3:8b']);
  const partial = new Map<string, number>();
  const seen: string[] = [];
  let pullMode: PullMode = 'ok';
  const TOTAL = 4000;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push(`${req.method} ${u.pathname}`);
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && u.pathname === '/api/version') return json(200, { version: '0.0.0-FAKE' });
    if (req.method === 'GET' && u.pathname === '/api/tags') return json(200, { models: [...installed].map((name) => ({ name, model: name, size: 5_200_000_000, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } })).concat([{ name: 'fake-gpt-oss:120b-cloud', model: 'fake-gpt-oss:120b-cloud', size: 0, details: {} } as never]) });
    if (req.method === 'GET' && u.pathname === '/api/ps') return json(200, { models: [...running].map((name) => ({ name, model: name, size: 6_000_000_000, size_vram: 6_000_000_000, expires_at: '2026-10-22T23:59:00Z' })) });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = body ? JSON.parse(body) as { model?: string } : {};
      if (req.method === 'POST' && u.pathname === '/api/show') {
        if (!j.model || !installed.has(j.model)) return json(404, { error: 'model not found' });
        return json(200, { capabilities: ['completion', 'tools'], details: { format: 'gguf', family: 'qwen3', parameter_size: '8B', quantization_level: 'Q4_K_M' }, model_info: { 'qwen3.context_length': 40960 } });
      }
      if (req.method === 'POST' && u.pathname === '/api/pull') {
        const model = j.model ?? '';
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
        line({ status: 'pulling manifest' });
        if (pullMode === 'no-network') { line({ error: 'pull model manifest: Get "https://registry.ollama.ai/v2/library/x/manifests/y": dial tcp: lookup registry.ollama.ai: no such host' }); res.end(); return; }
        let done = partial.get(model) ?? 0;
        const step = () => {
          if (res.destroyed) return;
          done = Math.min(TOTAL, done + 1000);
          partial.set(model, done);
          line({ status: 'pulling FAKE-layer', digest: 'sha256:FAKE', total: TOTAL, completed: done });
          if (pullMode === 'disk-full' && done >= 1000) { line({ error: 'write /FAKE/blobs/sha256-FAKE-partial: no space left on device' }); res.end(); return; }
          if (pullMode === 'stall' && done >= 2000) return; // waits: the client cancels
          if (done < TOTAL) { setTimeout(step, 5); return; }
          line({ status: 'verifying sha256 digest' }); line({ status: 'writing manifest' }); line({ status: 'success' });
          installed.add(model); partial.delete(model); res.end();
        };
        setTimeout(step, 5);
        return;
      }
      json(404, { error: 'not found' });
    });
  });
  return { server, installed, running, partial, seen, setMode: (m: PullMode) => { pullMode = m; } };
}

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });

let root = '';
let env: Record<string, string> = {};
const realFetch = globalThis.fetch;
const asked: string[] = [];
/** Only 127.0.0.1: anything else fails the test. */
const localOnly = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  asked.push(`${u.origin}${u.pathname}`);
  if (u.hostname !== '127.0.0.1') throw new Error(`a request left this computer: ${u.origin}`);
  return realFetch(input, init);
}) as typeof fetch;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'h170-ollama-'));
  for (const d of ['home', 'settings', 'work', 'bin']) mkdirSync(join(root, d));
  env = { TIMMY_HOME: join(root, 'home'), TIMMY_SETTINGS_DIR: join(root, 'settings'), TIMMY_REPO_ROOT: join(root, 'work'), PATH: join(root, 'work') };
  asked.length = 0;
  trap.calls.length = 0;
  // the probe (src/agent/providers.ts) asks through the global fetch: it may reach 127.0.0.1 and nothing else
  vi.stubGlobal('fetch', localOnly);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
  expect(trap.calls).toEqual([]);
});

/** A file named ollama on the PATH: Ollama installed, as far as files say (it is never run). */
const installFake = () => {
  writeFileSync(join(root, 'bin', 'ollama'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(root, 'bin', 'ollama'), 0o755);
  env.PATH = join(root, 'bin');
};

describe('Ollama on this computer: installed, answering, models held and loaded, told apart', () => {
  it('not installed; installed and not checked; checked with its models and what is loaded; installed and stopped', async () => {
    const fake = fakeOllama();
    env.OLLAMA_HOST = await listen(fake.server);
    const ctx = () => ({ env, cwd: join(root, 'work'), platform: 'linux' as const, fetch: localOnly });
    const none = providerState('ollama-local', ctx());
    expect(none).toMatchObject({ state: 'not installed', words: 'Ollama is not installed here (no ollama program on the PATH, and no Ollama app). Local models need no account and no key.' });
    expect(none.next).toBe(`Install it: ${installSteps('linux').install}; then ${installSteps('linux').start}`);
    expect(none.links?.[0]).toEqual({ label: 'Download Ollama', url: 'https://ollama.com/download/linux' });
    installFake();
    expect(ollamaInstalled({ env })).toMatchObject({ installed: true, how: 'program' });
    expect(providerState('ollama-local', ctx())).toMatchObject({ state: 'installed, not checked', next: 'Refresh' });
    const checked = await checkProvider('ollama-local', ctx());
    expect(checked.state).toBe('checked');
    expect(checked.words).toMatch(/^Checked just now: Ollama answered at 127\.0\.0\.1:\d+ with local models \(no account, no charge\)\.$/);
    expect(checked.lines).toEqual(['Ollama 0.0.0-FAKE holds fake-qwen3:8b (5.2 GB), and lists 1 cloud model (cloud, not local); 1 passes the local check; loaded now: fake-qwen3:8b']);
    expect(fake.seen).toEqual(expect.arrayContaining(['GET /api/version', 'GET /api/tags', 'GET /api/ps', 'POST /api/show']));
    expect(fake.seen).not.toContain('POST /api/pull');
    await close(fake.server);
    const stopped = await checkProvider('ollama-local', ctx());
    expect(stopped.state).toBe('installed, stopped');
    // the connection's own error code: refused, or a kept-alive socket the stopped server closed (both seen here)
    expect(stopped.words).toMatch(/^Ollama is installed \(the ollama program is on the PATH\); it did not answer at 127\.0\.0\.1:\d+ when checked just now \(the connection failed \([A-Z_]+\)\)\.$/);
    expect(stopped.next).toBe('Start it: ollama serve (or: systemctl start ollama); then Refresh');
    expect(asked.every((a) => a.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  it('an Ollama that holds no local model is checked and says so, with the starter download as the next step', async () => {
    const fake = fakeOllama();
    fake.installed.clear(); fake.running.clear();
    env.OLLAMA_HOST = await listen(fake.server);
    installFake();
    const s = await checkProvider('ollama-local', { env, cwd: join(root, 'work'), platform: 'linux', fetch: localOnly });
    expect(s).toMatchObject({ state: 'checked', next: 'Download a starter model (qwen3:0.6b, 523 MB), with your confirmation' });
    expect(s.words).toMatch(/holds no local model Timmy can use yet\.$/);
    await close(fake.server);
  });
});

describe('the starter download: sizes as the library shows them, the free-disk check, the confirmation, the streamed pull', () => {
  it('measured memory and free disk, said beside the downloads, and nothing claimed from them', () => {
    expect(localHardware({ memory: 16e9, free: 40e9 }).words).toBe('This computer: 16.0 GB of memory; 40.0 GB free where Ollama keeps its models (measured now).');
    expect(localHardware({ memory: null, free: null }).words).toBe('This computer: memory not measured; free disk not measured.');
    // the real readers (os.totalmem, statfs): a positive number, or null where the system cannot say
    const real = localHardware({ env: { OLLAMA_MODELS: join(root, 'home', 'models') } });
    expect(real.memoryBytes === null || real.memoryBytes > 0).toBe(true);
    expect(real.freeDiskBytes === null || real.freeDiskBytes >= 0).toBe(true);
  });

  it('the three starter models and their artifact sizes', () => {
    expect(STARTER_MODELS.map((s) => [s.model, s.size])).toEqual([
      ['qwen3:0.6b', '523 MB'], ['qwen3.5:0.8b', '1.2 GB (MLX) / 1.3 GB (llama.cpp)'], ['smollm2:135m-instruct-q4_0', '92 MB'],
    ]);
    expect(STARTER_MODELS.find((s) => s.model === 'smollm2:135m-instruct-q4_0')?.use).toBe('a limited demonstration, not the default agent');
  });

  it('refuses without the person\'s confirmation (no request at all), and refuses a confirmation the disk has no room for', async () => {
    const fake = fakeOllama();
    const origin = await listen(fake.server);
    const r = await ollamaPull('qwen3:0.6b', () => {}, undefined, { confirmation: undefined, origin, fetch: localOnly });
    expect(r).toMatchObject({ ok: false, reason: 'not confirmed' });
    const forged = Object.freeze({ model: 'qwen3:0.6b', size: '523 MB', free: '1 TB free', at: new Date().toISOString() });
    expect(await ollamaPull('qwen3:0.6b', () => {}, undefined, { confirmation: forged, origin, fetch: localOnly })).toMatchObject({ ok: false, reason: 'not confirmed' });
    const other = confirmPull('smollm2:135m-instruct-q4_0', { free: 1e12 });
    expect(other.ok).toBe(true);
    expect(await ollamaPull('qwen3:0.6b', () => {}, undefined, { confirmation: other.ok ? other.confirmation : undefined, origin, fetch: localOnly })).toMatchObject({ ok: false, reason: 'not confirmed' });
    expect(fake.seen).toEqual([]);
    expect(confirmPull('qwen3:0.6b', { free: 400e6 })).toEqual({ ok: false, words: 'Not enough free disk for qwen3:0.6b (523 MB): 400 MB free where Ollama keeps its models. Free some space, or choose a smaller model.' });
    expect(confirmPull('qwen3:0.6b', { free: 4e9 })).toMatchObject({ ok: true, words: 'Download qwen3:0.6b (523 MB; 4.0 GB free). Ollama downloads it from its library; nothing else is installed.' });
    expect(confirmPull('qwen3:0.6b', { free: null })).toMatchObject({ ok: true, words: expect.stringContaining('free space not known') });
    // the real free-disk reader: a number of bytes for a folder that exists (or null where the system cannot say)
    const f = freeBytes(join(root, 'home', 'no', 'such', 'folder'));
    expect(f === null || (Number.isFinite(f) && f >= 0)).toBe(true);
    await close(fake.server);
  });

  it('streams bytes done of total, ends with the installed status read back; Cancel stops it and a later pull resumes', async () => {
    const fake = fakeOllama();
    const origin = await listen(fake.server);
    const c = confirmPull('qwen3:0.6b', { free: 4e9 });
    if (!c.ok) throw new Error('no confirmation');
    const progress: PullProgress[] = [];
    fake.setMode('stall');
    const ac = new AbortController();
    const cancelled = ollamaPull('qwen3:0.6b', (p) => { progress.push(p); if (p.done >= 2000) ac.abort(); }, ac.signal, { confirmation: c.confirmation, origin, fetch: localOnly });
    expect(await cancelled).toMatchObject({ ok: false, reason: 'cancelled', words: 'Cancelled: Ollama keeps what it downloaded of qwen3:0.6b, and pulling it again resumes there.' });
    expect(progress.map((p) => p.words)).toEqual(['pulling manifest', '1 KB of 4 KB · pulling FAKE-layer', '2 KB of 4 KB · pulling FAKE-layer']);
    expect(fake.partial.get('qwen3:0.6b')).toBe(2000);
    fake.setMode('ok');
    const resumed: PullProgress[] = [];
    const r = await ollamaPull('qwen3:0.6b', (p) => resumed.push(p), undefined, { confirmation: c.confirmation, origin, fetch: localOnly });
    expect(r).toMatchObject({ ok: true, words: 'Downloaded: Ollama lists qwen3:0.6b as installed now.' });
    // it resumed at what was kept: the first layer report is past the half
    expect(resumed.find((p) => p.total !== null)?.done).toBe(3000);
    expect(resumed.at(-1)?.status).toBe('success');
    expect(fake.installed.has('qwen3:0.6b')).toBe(true);
    await close(fake.server);
  });

  it('says a full disk and no network in words, and a server that does not answer', async () => {
    const fake = fakeOllama();
    const origin = await listen(fake.server);
    const c = confirmPull('qwen3:0.6b', { free: 4e9 });
    if (!c.ok) throw new Error('no confirmation');
    fake.setMode('disk-full');
    expect(await ollamaPull('qwen3:0.6b', () => {}, undefined, { confirmation: c.confirmation, origin, fetch: localOnly })).toMatchObject({ ok: false, reason: 'disk full', words: 'the disk is full: Ollama could not write the model. Free some space, then pull again (it resumes).' });
    fake.setMode('no-network');
    expect(await ollamaPull('qwen3:0.6b', () => {}, undefined, { confirmation: c.confirmation, origin, fetch: localOnly })).toMatchObject({ ok: false, reason: 'no network' });
    await close(fake.server);
    expect(await ollamaPull('qwen3:0.6b', () => {}, undefined, { confirmation: c.confirmation, origin, fetch: localOnly })).toMatchObject({ ok: false, reason: 'no answer' });
    expect(pullErrorWords('pull model manifest: file does not exist')).toEqual({ reason: 'no such model', words: 'the Ollama library has no model of that name.' });
    expect(await ollamaPull('qwen3:0.6b', () => {}, undefined, { confirmation: c.confirmation, origin: 'http://192.0.2.1:11434', fetch: localOnly })).toMatchObject({ ok: false, words: '192.0.2.1:11434 is not this computer: Timmy downloads only into a local Ollama' });
  });
});
