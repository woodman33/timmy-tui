/**
 * Timmy Cloud's backend: helpers for its tests (tests/cloud-*.test.ts). Not part of the backend itself.
 *
 * Everything here is real: the simulated provider and the backend are HTTP servers on 127.0.0.1, the event log is a real
 * file in a temporary folder, and `spawnBackend` starts the backend as a real child process (for the crash tests).
 * Credentials and tokens are generated at run time; none is ever written into a test.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudEngine } from './engine.js';
import { CloudHttpServer } from './http.js';
import { Redactor, newToken, sha256Hex } from './redaction.js';
import { SimulatedAdapter } from './simulated-adapter.js';
import { SimulatedProvider, type SimOptions } from './simulated-provider.js';
import type { Limits, SubscriptionState } from './types.js';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const MAIN = join(REPO_ROOT, 'services', 'cloud', 'main.ts');

export interface HttpReply { status: number; json: any; text: string; headers: Record<string, string | string[] | undefined> }

/** Every answer any client received, for the leak checks. */
export const RECEIVED: string[] = [];

/** One HTTP request with no connection pooling (a killed backend leaves no pooled socket behind). */
export function http(base: string, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<HttpReply> {
  const url = new URL(path, base);
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return new Promise((resolvePromise, reject) => {
    const req = request({
      host: url.hostname, port: url.port, path: url.pathname + url.search, method, agent: false,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        ...(opts.headers ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        RECEIVED.push(text);
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolvePromise({ status: res.statusCode ?? 0, json, text, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 20_000, () => req.destroy(new Error('timeout')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

export function agencyCredential(): string { return `agency-${randomBytes(24).toString('hex')}`; }

export function tempDir(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }

export interface Stack {
  url: string;
  sim: SimulatedProvider;
  engine: CloudEngine;
  server: CloudHttpServer;
  dataDir: string;
  credential: string;
  operatorToken: string;
  op(method: string, path: string, body?: unknown): Promise<HttpReply>;
  /** Stops the backend (the simulated provider keeps running unless `all`). */
  stopBackend(): Promise<void>;
  /** Starts a backend again on the same data folder and provider: what a restart rebuilds. */
  restartBackend(): Promise<void>;
  close(): Promise<void>;
}

export interface StackOptions { sim?: Partial<SimOptions>; timeoutMs?: number; retentionDays?: number; clock?: () => Date; clockMarginMs?: number }

/** The simulated provider and the backend, in this process, over real HTTP, on a fresh data folder. */
export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const credential = agencyCredential();
  const sim = new SimulatedProvider({ credential, ...o.sim });
  await sim.start();
  const dataDir = tempDir('timmy-cloud-');
  const operatorToken = newToken();
  const redactor = new Redactor([credential]);
  const open = async (): Promise<{ engine: CloudEngine; server: CloudHttpServer; url: string }> => {
    const adapter = new SimulatedAdapter({ baseUrl: sim.url, credential, provesAbsence: !!o.sim?.provesAbsence, timeoutMs: o.timeoutMs ?? 1500, redactor, clockMarginMs: o.clockMarginMs });
    const engine = CloudEngine.open({ dataDir, provider: adapter, redactor, operatorTokenSha256: sha256Hex(operatorToken), pollIntervalMs: 0, retentionDays: o.retentionDays, clock: o.clock });
    const server = new CloudHttpServer(engine, redactor);
    const url = await server.start();
    return { engine, server, url };
  };
  let cur = await open();
  const stack: Stack = {
    get url() { return cur.url; },
    get engine() { return cur.engine; },
    get server() { return cur.server; },
    sim, dataDir, credential, operatorToken,
    op: (method, path, body) => http(cur.url, method, path, { token: operatorToken, body }),
    async stopBackend() { await cur.server.close(); await cur.engine.idle(); cur.engine.close(); },
    async restartBackend() { cur = await open(); },
    async close() {
      await cur.server.close().catch(() => undefined);
      try { await cur.engine.idle(); cur.engine.close(); } catch { /* closed */ }
      await sim.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  } as Stack;
  return stack;
}

export interface CustomerHandle {
  id: string;
  token: string;
  get(path: string): Promise<HttpReply>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpReply>;
  order(body: { kind: string; item_id: string; domain?: string | null }, key: string): Promise<HttpReply>;
}

export async function newCustomer(stack: Pick<Stack, 'op'> & { url: string }, limits: Partial<Limits> = {}, subscription: SubscriptionState = 'active'): Promise<CustomerHandle> {
  const r = await stack.op('POST', '/v1/operator/customers', { limits: { per_order_cents: 10_000, monthly_cents: 50_000, ...limits }, subscription });
  if (r.status !== 201) throw new Error(`customer not created: ${r.status} ${r.text}`);
  const { customer_id: id, token } = r.json as { customer_id: string; token: string };
  return customerHandle(stack, id, token);
}

export function customerHandle(stack: { url: string }, id: string, token: string): CustomerHandle {
  return {
    id, token,
    get: (path) => http(stack.url, 'GET', path, { token }),
    post: (path, body, headers) => http(stack.url, 'POST', path, { token, body, headers }),
    order: (body, key) => http(stack.url, 'POST', '/v1/orders', { token, body, headers: { 'Idempotency-Key': key } }),
  };
}

/** Every file under a folder, as text (for the leak checks). */
export function folderText(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p); else out.push({ file: name, text: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

export interface SpawnedBackend {
  url: string;
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** The backend as a real child process (node --import tsx services/cloud/main.ts …). Resolves once it listens, or when it exits first. */
export function spawnBackend(o: { dataDir: string; providerUrl: string; credential: string; operatorToken: string; env?: Record<string, string>; args?: string[] }): Promise<SpawnedBackend & { listening: boolean }> {
  const child = spawn(process.execPath, ['--import', 'tsx', MAIN,
    '--data', o.dataDir, '--provider-url', o.providerUrl, '--operator-token-sha256', sha256Hex(o.operatorToken),
    '--tick-ms', '0', '--poll-ms', '0', '--provider-timeout-ms', '1500', ...(o.args ?? [])], {
    cwd: REPO_ROOT,
    env: { ...process.env, TIMMY_CLOUD_AGENCY_TOKEN: o.credential, ...(o.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  child.stderr!.on('data', (d: Buffer) => { err += d.toString('utf8'); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  return new Promise((resolvePromise) => {
    const done = (listening: boolean): void => {
      const m = out.match(/\{"listening":"(http:\/\/127\.0\.0\.1:\d+)"/);
      resolvePromise({ url: m ? m[1] : '', child, stdout: () => out, stderr: () => err, exited, listening });
    };
    const onData = (): void => { if (/\{"listening":"http:\/\/127\.0\.0\.1:\d+"/.test(out)) { child.stdout!.off('data', onData); done(true); } };
    child.stdout!.on('data', onData);
    void exited.then(() => done(false));
  });
}

/** Waits until fn() is true (polling), or fails after ms. */
export async function until(fn: () => boolean | Promise<boolean>, ms = 10_000, what = 'a condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}
