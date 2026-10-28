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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { JobManager } from '../../jobs/index.js';
import type { MiniAppSpec } from './registry.js';
import { watchAppJobs, type AppJobReceipt } from './receipts.js';

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
  /**
   * a one-time key for the gateway's launch address, valid for LAUNCH_MS; `to`, a path of the app (checked by launchTarget),
   * is where the launch lands instead of the app's root (Files' "Open inspection": Card Lab's `/?run=<id>`)
   */
  launch(to?: string): string;
  /** extend every live grant of this gateway by GRANT_MS (the page renews while its session is valid); how many it kept */
  renew(): number;
  /** end every grant: each browser holding one is refused until it opens the app again from Timmy (sign-out, project switch) */
  revoke(): void;
  /** read the app's state now and seal its newly ended jobs (the receipts' ids); a no-op without a seal */
  sealNow(): Promise<string[]>;
  /**
   * R13 (the C1 adapters: `timmy video`, `timmy animate`, the agent's and MCP's Animate tools): one request to the app as
   * Timmy itself makes it (its own Host, the worker's secret), for Timmy's own commands; never handed to a page.
   */
  request(method: string, path: string, body?: Buffer | string | object, headers?: Record<string, string>): Promise<AppResponse>;
  stop(): Promise<void>;
  readonly running: boolean;
}

/** What `request` answers: the status, the body as bytes, and its JSON when it parses. */
export interface AppResponse { status: number; headers: http.IncomingHttpHeaders; bytes: Buffer; json: unknown }

/**
 * R13: one worker per app data folder, whichever Timmy process starts it (the companion for the page, a `timmy video` or
 * `timmy animate` command, the MCP server): two servers of one app on one folder would write over each other's records.
 * The lock beside the folder names the process that runs it; a lock whose process is gone is stale and taken over.
 */
export function takeWorkerLock(dataDir: string, title: string): () => void {
  const file = `${dataDir}.timmy-worker.lock`;
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; since?: string };
    if (typeof held.pid === 'number' && held.pid !== process.pid) {
      let alive = false;
      try { process.kill(held.pid, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; }
      if (alive) throw Object.assign(new Error(`${title} is already open for this project in another Timmy process (pid ${held.pid}, since ${held.since ?? 'unknown'}): use it there, or stop it there first.`), { code: 'TIMMY_APP_LOCKED' });
    }
  } catch (e) { if ((e as { code?: string }).code === 'TIMMY_APP_LOCKED') throw e; }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), { mode: 0o600 });
  return () => { try { const held = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }; if (held.pid === process.pid) rmSync(file, { force: true }); } catch { /* gone */ } };
}

export const LAUNCH_MS = 60_000;
/** how long a browser's grant lasts without a renewal from the Timmy page that holds a valid session (the page renews it) */
export const GRANT_MS = 15 * 60_000;
export const MAX_GRANTS = 16;
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

/** The revision the installed copy names (its .timmy-source.json, written by the review package builder), null when none. */
export function installedRevision(spec: MiniAppSpec, env: Env): string | null {
  const dir = spec.host ? env[spec.host.sourceEnv] : undefined;
  if (!dir) return null;
  try { const r = JSON.parse(readFileSync(join(dir, '.timmy-source.json'), 'utf8')).revision; return typeof r === 'string' && /^[0-9a-f]{7,40}$/.test(r) ? r : null; } catch { return null; }
}

/**
 * What the app's folder says it was made from, in words: its commit, or, for an owner's archive with no commit (Animate),
 * the label the package recorded (`.timmy-source.json` label). Null when the folder records neither.
 */
export function installedSource(spec: MiniAppSpec, env: Env): string | null {
  const rev = installedRevision(spec, env);
  if (rev) return rev;
  const dir = spec.host ? env[spec.host.sourceEnv] : undefined;
  if (!dir) return null;
  try { const l = JSON.parse(readFileSync(join(dir, '.timmy-source.json'), 'utf8')).label; return typeof l === 'string' && l.trim() !== '' ? l.trim().slice(0, 80) : null; } catch { return null; }
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

/**
 * R13 (the operator's 15:31 order: close the direct worker-port bypass). The worker's own port listens on 127.0.0.1, where any
 * local program could reach it without Timmy's grant. Timmy now starts each worker with this guard loaded first (`node
 * --require`), before the owner's code: every HTTP request and upgrade the app's servers receive must carry the worker's
 * secret, which only Timmy (the gateway and its receipt reader) holds; anything else is answered 403 before the app sees it.
 * The secret is removed from the app's environment and from the request's headers before the app runs or reads them. The
 * owners' code is unchanged; an owner's own check of the same secret would be the native form (REGISTER findings).
 */
export const WORKER_HEADER = 'x-timmy-worker';
const GUARD_SOURCE = `'use strict';
// Timmy mini-app worker guard (written by Timmy's host, src/companion/miniapps/host.ts; R13). Not an owner's file.
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const secret = process.env.TIMMY_WORKER_SECRET || '';
delete process.env.TIMMY_WORKER_SECRET;
if (secret) {
  const want = Buffer.from(secret);
  const ok = (req) => { const got = req.headers['${'x-timmy-worker'}']; if (typeof got !== 'string') return false; const b = Buffer.from(got); return b.length === want.length && timingSafeEqual(b, want); };
  const scrub = (req) => { delete req.headers['${'x-timmy-worker'}']; const r = req.rawHeaders; for (let i = r.length - 2; i >= 0; i -= 2) if (String(r[i]).toLowerCase() === '${'x-timmy-worker'}') r.splice(i, 2); };
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, resOrSocket) {
    if (event === 'request' || event === 'upgrade' || event === 'checkContinue' || event === 'checkExpectation') {
      if (!ok(req)) {
        try {
          if (event === 'upgrade') resOrSocket.end('HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');
          else { resOrSocket.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }); resOrSocket.end('This app answers only through Timmy.\\n'); }
        } catch { /* the client is gone */ }
        return true;
      }
      scrub(req);
    }
    return emit.apply(this, arguments);
  };
}
`;

/** The guard's file beside the apps' data (<home>/apps/.timmy-worker-guard.cjs), written when it differs. */
export function workerGuardFile(appsDir: string): string {
  const file = join(appsDir, '.timmy-worker-guard.cjs');
  let have = '';
  try { have = readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (have !== GUARD_SOURCE) { mkdirSync(appsDir, { recursive: true, mode: 0o700 }); writeFileSync(`${file}.tmp`, GUARD_SOURCE, { mode: 0o644 }); renameSync(`${file}.tmp`, file); }
  return file;
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
  /** the exact origin of the Timmy page that opened it (an app's theme contract checks messages against it); ancestors[0] when absent */
  parentOrigin?: string;
  /** the node that runs the app (this process's by default) */
  node?: string;
  /** the job manager of the principal's Timmy home (<home>/jobs) */
  jobs: JobManager;
  /** the project's name (the job record's) */
  project: string;
  /** seals one of the app's ended jobs into Timmy's receipts (the routes: the project's runs chain); absent: none sealed */
  seal?: (r: AppJobReceipt) => string | undefined;
  /** the principal's one-way key; the app job ids the chain already holds for this app, principal and project */
  principal?: string;
  known?: () => string[];
  /** the checklist's A6: each hashed output written into the project too (receipts.ts deliverInto) */
  deliver?: (rel: string, bytes: Buffer) => boolean;
  /** the installed copy's revision (its .timmy-source.json), sealed with each job */
  revision?: string | null;
}

export async function startHostedApp(o: StartOptions): Promise<HostedApp> {
  const h = o.spec.host;
  if (!h) throw new Error(`${o.spec.title} is not hostable.`);
  mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
  const unlock = takeWorkerLock(o.dataDir, o.spec.title);
  const workerPort = await freePort();
  // (the worker's secret: only this host's gateway and receipt reader present it; the guard refuses every other client)
  const workerSecret = randomBytes(32).toString('hex');
  const env = { ...h.env({ port: workerPort, dataDir: o.dataDir, base: o.base, parentOrigin: o.parentOrigin ?? o.ancestors[0] }), TIMMY_WORKER_SECRET: workerSecret };
  const guard = workerGuardFile(dirname(dirname(o.dataDir)));
  const job = o.jobs.start({
    kind: 'server', label: `${o.spec.title} (mini-app)`, project: o.project, root: o.dir,
    command: o.node ?? process.execPath, args: ['--require', guard, join(o.dir, h.entry)], env, envExact: true,
    ready: { url: `http://127.0.0.1:${workerPort}${h.readyPath}`, timeoutMs: READY_MS },
  });
  const ready = await o.jobs.ready(job.id);
  if (ready.state !== 'ready') unlock();
  if (ready.state !== 'ready') throw new Error(`${o.spec.title} did not start (job ${job.id}: ${ready.state}${ready.error ? `, ${ready.error}` : ''}).`);
  const exited = () => { const j = o.jobs.get(job.id); return !j || (j.state !== 'ready' && j.state !== 'running'); };
  const watcher = o.seal && h.receipts ? watchAppJobs({ spec: o.spec, workerPort, workerSecret, dataDir: o.dataDir, revision: o.revision ?? null, project: o.project, seal: o.seal, principal: o.principal ?? 'operator', known: o.known, ...(o.deliver ? { deliver: o.deliver } : {}) }) : null;
  // grants: one per launch (a browser), each its own secret, each ending at its own time unless renewed; revoke ends them all
  const grants = new Map<string, number>();
  const launches = new Map<string, { at: number; to: string | null }>();
  let gatewayPort = 0;
  const cookieName = () => `timmy_app_${gatewayPort}`;
  const hasGrant = (header: string | undefined): boolean => {
    const now = Date.now();
    for (const part of String(header ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k !== cookieName()) continue;
      const got = Buffer.from(v.join('='));
      for (const [secret, until] of grants) {
        const want = Buffer.from(secret);
        if (got.length === want.length && timingSafeEqual(got, want)) { if (until > now) return true; grants.delete(secret); return false; }
      }
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
      const entry = launches.get(k);
      launches.delete(k);
      const at = entry ? entry.at : undefined;
      if (at === undefined || Date.now() - at > LAUNCH_MS) { deny(403, 'This launch address was used or has expired: open the app again from Timmy.'); return; }
      const secret = randomBytes(32).toString('hex');
      grants.set(secret, Date.now() + GRANT_MS);
      // (at most MAX_GRANTS browsers at once: the one ending soonest gives way)
      while (grants.size > MAX_GRANTS) { let first: string | null = null; let at = Infinity; for (const [k, u] of grants) if (u < at) { at = u; first = k; } if (first) grants.delete(first); else break; }
      res.writeHead(302, { location: entry && entry.to ? entry.to : '/', 'set-cookie': `${cookieName()}=${secret}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (!hasGrant(req.headers.cookie)) { deny(401, `Open ${o.spec.title} from Timmy: this address answers only the browser Timmy opened it in.`); return; }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== self) { deny(403, 'Cross-origin requests are not allowed.'); return; }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${workerPort}`, [WORKER_HEADER]: workerSecret };
    delete headers.cookie;
    if (origin !== undefined) headers.origin = `http://127.0.0.1:${workerPort}`;
    if (headers.referer) delete headers.referer;
    const up = http.request({ host: '127.0.0.1', port: workerPort, method: req.method, path: req.url, headers }, (upRes) => {
      const out: http.OutgoingHttpHeaders = { ...upRes.headers };
      const csp = upRes.headers['content-security-policy'];
      // only Timmy's own page may frame the app (added when the app sends no policy of its own)
      out['content-security-policy'] = typeof csp === 'string' ? framedPolicy(csp, o.ancestors) : `frame-ancestors ${o.ancestors.join(' ')}`;
      // (an app that refuses every frame with X-Frame-Options, as Card Lab's SAMEORIGIN does: the CSP above says who may)
      delete out['x-frame-options'];
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
    launch(to?: string) {
      const k = randomBytes(24).toString('hex');
      const now = Date.now();
      for (const [old, e] of launches) if (now - e.at > LAUNCH_MS) launches.delete(old);
      launches.set(k, { at: now, to: launchTarget(to) });
      return `http://127.0.0.1:${gatewayPort}/__timmy/launch?k=${k}`;
    },
    renew() { const now = Date.now(); for (const [k, until] of grants) { if (until <= now) grants.delete(k); else grants.set(k, now + GRANT_MS); } return grants.size; },
    revoke() { grants.clear(); launches.clear(); },
    sealNow() { return watcher ? watcher.tick() : Promise.resolve([]); },
    request(method, path, body, headers = {}) {
      return new Promise<AppResponse>((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port: workerPort, method, path, headers: {
          host: `127.0.0.1:${workerPort}`, [WORKER_HEADER]: workerSecret,
          ...(payload && !Buffer.isBuffer(body) && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
          ...(payload ? { 'content-length': String(payload.length) } : {}), ...headers,
        } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => { const bytes = Buffer.concat(chunks); let json: unknown = null; try { json = JSON.parse(bytes.toString('utf8')); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, json }); });
          res.on('error', reject);
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      // (one last read of the app's jobs while it still answers)
      if (watcher) await watcher.stop().catch(() => undefined);
      await new Promise<void>((r) => { gateway.close(() => r()); gateway.closeAllConnections(); });
      if (!exited()) await o.jobs.stop(job.id, STOP_MS);
      unlock();
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
  /** the apps as GET /api/apps lists them for a request's principal and project (set by mountMiniApps; the catalog reads it) */
  listing: ((req: unknown) => import('../../capabilities/catalog.js').AppListingRow[] | null) | null = null;
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

  /** every running app whose key starts with `prefix` (keys are `<app>:<principal>:<project>`) */
  private matching(prefix: string): HostedApp[] { return [...this.apps.entries()].filter(([k, a]) => k.startsWith(prefix) && a.running).map(([, a]) => a); }

  /** A principal opening an app in one project ends their grants to it in every other project (its jobs keep running). */
  revokeOthers(key: string): number {
    const [app, principal] = key.split(':');
    const others = this.matching(`${app}:${principal}:`).filter((a) => a.key !== key);
    for (const a of others) a.revoke();
    return others.length;
  }

  /** End every grant a principal holds, in every app and project (their session ended, or they asked). */
  revokePrincipal(principal: string): number {
    const all = [...this.apps.values()].filter((a) => a.key.split(':')[1] === principal && a.running);
    for (const a of all) a.revoke();
    return all.length;
  }

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

/** A launch's landing place inside the app: a path of its own origin only (no scheme, no second slash), short; else none. */
export function launchTarget(to: unknown): string | null {
  if (typeof to !== 'string' || to.length > 200) return null;
  return /^\/(?![\/\\])[\w\-./?=&%~]*$/.test(to) ? to : null;
}
