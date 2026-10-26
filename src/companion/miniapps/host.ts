/**
 * R13 (the 2026-10-26 integration order): hosting an owner's mini-app behind Timmy, unchanged.
 *
 * One worker per (app, principal, project): Timmy starts the app's own server (`node <entry>`) as a durable server job of
 * that principal's Timmy home (src/jobs: its record, log, ready check and process-group Stop), on a loopback port of its
 * choosing, with the data folder of that principal's project (<principal's TIMMY_HOME>/apps/<app>/<project id>) and only the
 * variables the app's registry entry allows (./registry.ts: never a provider key, a token or the paid-call switch). The
 * worker's own port is not handed to the page. The page reaches the app through a gateway: a second loopback listener that
 * answers only a browser holding the gateway's cookie, and that cookie is given only for a one-time key that the app page got
 * from Timmy's own routes (the launch token and the principal's session checked there, ./routes.ts).
 *
 * The gateway changes as little as it must to put the app inside Timmy's frame: the request's Host and Origin become the
 * worker's (the app checks both), the gateway's cookie is not forwarded, and the response's `frame-ancestors` names Timmy's
 * own origin instead of 'none'. Everything else, the bytes, the status and the other headers, is the app's.
 *
 * Known limit (recorded in the integration register): the worker's own port has no check of its own, as the app ships today
 * (its server answers any loopback client that names its host). The port is chosen fresh each start and never shown; a token
 * check in the app's server is the owner's change to make.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { JobManager } from '../../jobs/index.js';
import type { MiniAppSpec } from './registry.js';

type Env = Record<string, string | undefined>;

export interface HostedApp {
  key: string;
  appId: string;
  /** the gateway's port (the page's address for the app) */
  gatewayPort: number;
  /** the worker's port (never shown to a page) */
  workerPort: number;
  dataDir: string;
  /** the durable job that runs the worker (<home>/jobs: its record, log, state and Stop are Timmy's own) */
  jobId: string;
  startedAt: string;
  /** a one-time key for the gateway's launch address, valid for LAUNCH_MS */
  launch(): string;
  stop(): Promise<void>;
  readonly running: boolean;
}

export const LAUNCH_MS = 60_000;
const READY_MS = 30_000;
const STOP_MS = 5_000;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** The folder a principal's project's copy of an app keeps its data in. */
export function appDataDir(home: string, appId: string, projectKey: string): string {
  return join(home, 'apps', appId, projectKey);
}

/** The words for a hostable app that cannot start here: not installed (no folder named), or not built. */
export function hostProblem(spec: MiniAppSpec, env: Env): string | null {
  const h = spec.host;
  if (!h) return `${spec.title} is not hostable yet: ${spec.observed?.next ?? 'its source is not in hand.'}`;
  const dir = env[h.sourceEnv];
  if (!dir) return `${spec.title} is not installed with this Timmy: ${h.sourceEnv} names no folder. The review package sets it to the copy it carries.`;
  if (!existsSync(join(dir, h.entry))) return `${spec.title}'s folder (${h.sourceEnv}) has no ${h.entry}.`;
  if (!existsSync(join(dir, h.builtFile))) return `${spec.title} is installed but not built: run npm run build in its folder.`;
  return null;
}

/** The response's CSP with frame-ancestors naming `ancestors` (the app's 'none' would refuse Timmy's frame). */
export function framedPolicy(csp: string, ancestors: string[]): string {
  const parts = csp.split(';').map((p) => p.trim()).filter(Boolean).filter((p) => !/^frame-ancestors\b/i.test(p));
  parts.push(`frame-ancestors ${ancestors.join(' ')}`);
  return parts.join('; ');
}

export interface StartOptions {
  spec: MiniAppSpec;
  key: string;
  /** the app's folder (spec.host.sourceEnv's value) */
  dir: string;
  dataDir: string;
  /** the companion's environment, filtered by the spec */
  base: Env;
  /** the origins that may frame the app (Timmy's own page) */
  ancestors: string[];
  /** the node that runs the app (this process's by default) */
  node?: string;
  /** the job manager of the principal's Timmy home (<home>/jobs) */
  jobs: JobManager;
  /** the project's name (the job record's) */
  project: string;
}

export async function startHostedApp(o: StartOptions): Promise<HostedApp> {
  const h = o.spec.host;
  if (!h) throw new Error(`${o.spec.title} is not hostable.`);
  mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
  const workerPort = await freePort();
  const env = h.env({ port: workerPort, dataDir: o.dataDir, base: o.base });
  const job = o.jobs.start({
    kind: 'server', label: `${o.spec.title} (mini-app)`, project: o.project, root: o.dir,
    command: o.node ?? process.execPath, args: [join(o.dir, h.entry)], env, envExact: true,
    ready: { url: `http://127.0.0.1:${workerPort}${h.readyPath}`, timeoutMs: READY_MS },
  });
  const ready = await o.jobs.ready(job.id);
  if (ready.state !== 'ready') throw new Error(`${o.spec.title} did not start (job ${job.id}: ${ready.state}${ready.error ? `, ${ready.error}` : ''}).`);
  const exited = () => { const j = o.jobs.get(job.id); return !j || (j.state !== 'ready' && j.state !== 'running'); };
  const secret = randomBytes(32).toString('hex');
  const launches = new Map<string, number>();
  let gatewayPort = 0;
  const cookieName = () => `timmy_app_${gatewayPort}`;
  const hasCookie = (header: string | undefined): boolean => {
    const want = Buffer.from(secret);
    for (const part of String(header ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName()) { const got = Buffer.from(v.join('=')); if (got.length === want.length && timingSafeEqual(got, want)) return true; }
    }
    return false;
  };
  const gateway = http.createServer((req, res) => {
    const self = `http://127.0.0.1:${gatewayPort}`;
    const deny = (status: number, words: string) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(`${words}\n`); };
    if (req.headers.host !== `127.0.0.1:${gatewayPort}`) { deny(403, 'This address answers only as 127.0.0.1.'); return; }
    const url = new URL(req.url ?? '/', self);
    if (url.pathname === '/__timmy/launch') {
      const k = url.searchParams.get('k') ?? '';
      const at = launches.get(k);
      launches.delete(k);
      if (at === undefined || Date.now() - at > LAUNCH_MS) { deny(403, 'This launch address was used or has expired: open the app again from Timmy.'); return; }
      res.writeHead(302, { location: '/', 'set-cookie': `${cookieName()}=${secret}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (!hasCookie(req.headers.cookie)) { deny(401, `Open ${o.spec.title} from Timmy: this address answers only the browser Timmy opened it in.`); return; }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== self) { deny(403, 'Cross-origin requests are not allowed.'); return; }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${workerPort}` };
    delete headers.cookie;
    if (origin !== undefined) headers.origin = `http://127.0.0.1:${workerPort}`;
    if (headers.referer) delete headers.referer;
    const up = http.request({ host: '127.0.0.1', port: workerPort, method: req.method, path: req.url, headers }, (upRes) => {
      const out: http.OutgoingHttpHeaders = { ...upRes.headers };
      const csp = upRes.headers['content-security-policy'];
      if (typeof csp === 'string') out['content-security-policy'] = framedPolicy(csp, o.ancestors);
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) deny(502, `${o.spec.title} is not answering: open it again from Timmy.`); else res.destroy(); });
    req.pipe(up);
  });
  gateway.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', () => resolve()); });
  gatewayPort = (gateway.address() as net.AddressInfo).port;

  let stopped = false;
  const hosted: HostedApp = {
    key: o.key, appId: o.spec.id, gatewayPort, workerPort, dataDir: o.dataDir, jobId: job.id, startedAt: new Date().toISOString(),
    launch() {
      const k = randomBytes(24).toString('hex');
      const now = Date.now();
      for (const [old, at] of launches) if (now - at > LAUNCH_MS) launches.delete(old);
      launches.set(k, now);
      return `http://127.0.0.1:${gatewayPort}/__timmy/launch?k=${k}`;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((r) => { gateway.close(() => r()); gateway.closeAllConnections(); });
      if (!exited()) await o.jobs.stop(job.id, STOP_MS);
    },
    get running() { return !stopped && !exited(); },
  };
  return hosted;
}

/** A principal's short one-way key (never the id itself), as the app page keys its own browser storage. */
export function principalKey(user: { id?: unknown; operator?: boolean } | undefined): string {
  return !user || user.operator ? 'operator' : `u-${createHash('sha256').update(`timmy-app:${String(user.id ?? '')}`).digest('hex').slice(0, 16)}`;
}

/** The running apps, one per (app, principal, project); stopped together when the companion ends. */
export class MiniAppHost {
  private apps = new Map<string, HostedApp>();
  private starting = new Map<string, Promise<HostedApp>>();

  async ensure(o: StartOptions): Promise<HostedApp> {
    const have = this.apps.get(o.key);
    if (have?.running) return have;
    if (have) this.apps.delete(o.key);
    const pending = this.starting.get(o.key);
    if (pending) return pending;
    const p = startHostedApp(o).then((a) => { this.apps.set(o.key, a); return a; }).finally(() => this.starting.delete(o.key));
    this.starting.set(o.key, p);
    return p;
  }

  get(key: string): HostedApp | undefined { const a = this.apps.get(key); return a?.running ? a : undefined; }

  async stop(key: string): Promise<boolean> {
    const a = this.apps.get(key);
    if (!a) return false;
    this.apps.delete(key);
    await a.stop();
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.apps.values()];
    this.apps.clear();
    await Promise.all(all.map((a) => a.stop()));
  }
}
