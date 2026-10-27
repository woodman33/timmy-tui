/**
 * R13 (the operator's 15:31 order, item 4: the C1 adapters for the video and animate commands and Animate's agent tools and
 * MCP): an owner's app opened by one of Timmy's own commands rather than by the page. The same host as the page's (./host.ts):
 * the app runs unchanged as a durable server job of the Timmy home, its data in the same per-project folder the page uses,
 * its port answering only Timmy (the worker guard); each job it ends is sealed into the project's runs chain as the page's
 * are (./receipts.ts), and its receipt ids are handed back to the command. One worker per folder: when the page (or another
 * command) already has this app open for the project, the command says so instead of starting a second one.
 */
import { join } from 'node:path';
import { JobManager } from '../../jobs/index.js';
import { projectId, readActiveProject } from '../../project/index.js';
import { baseHome } from '../identity/scope.js';
import { appendReceipt, readChain } from '../../utils/receipts.js';
import { appDataDir, hostProblem, installedRevision, startHostedApp, type AppResponse, type HostedApp } from './host.js';
import { miniAppOf, type MiniAppSpec } from './registry.js';

type Env = Record<string, string | undefined>;

export interface AppSession {
  spec: MiniAppSpec;
  project: { name: string; root: string };
  app: HostedApp;
  request: HostedApp['request'];
  /** seal what has ended now; the receipts sealed (ids) */
  sealNow(): Promise<string[]>;
  /**
   * Seals until this job's receipt is in the chain, or `ms` passes (R13, the Mac run of d1228ee): an app's API can say a job
   * ended before its own record does (Timmy Animate writes job.json cancelled once Blender has exited), and the receipt is
   * sealed from the record. The receipts for the job, empty when the record never said it ended in time.
   */
  sealFor(jobId: string, ms?: number): Promise<Array<{ id: string; status: string; state: string | undefined }>>;
  /** every receipt sealed for this app's job in this project (newest last), read from the chain */
  receiptsOf(jobId: string): Array<{ id: string; status: string; state: string | undefined }>;
  /** stop the worker (after one last read of its jobs); what was sealed in that read */
  close(): Promise<void>;
}

export interface OpenOptions {
  env?: Env;
  /** the project folder (default: the active project, as other surfaces open) */
  root?: string;
}

/** Opens an owner's app for Timmy's own commands, or answers why it cannot (not installed, not built, already open). */
export async function openAppSession(appId: string, o: OpenOptions = {}): Promise<AppSession | { error: string }> {
  const env = o.env ?? process.env;
  const spec = miniAppOf(appId);
  if (!spec?.host) return { error: `${spec?.title ?? appId} is not hostable here: ${spec?.observed?.next ?? 'no such app'}` };
  const problem = hostProblem(spec, env);
  if (problem) return { error: problem };
  const project = o.root ? { name: o.root.split(/[\\/]/).filter(Boolean).pop() ?? o.root, root: o.root } : readActiveProject();
  const home = baseHome(env);
  const pid = projectId(project.root);
  const jobs = new JobManager({ dir: join(home, 'jobs') });
  let app: HostedApp;
  try {
    app = await startHostedApp({
      spec, key: `${spec.id}:operator:${pid}`, dir: env[spec.host.sourceEnv]!, dataDir: appDataDir(home, spec.id, pid), base: env,
      ancestors: [], jobs, project: project.name, revision: installedRevision(spec, env),
      seal: (r) => appendReceipt('runs', { ...r, project_id: pid }, project.root).id,
      principal: 'operator',
      known: () => readChain('runs', project.root).filter((r) => r.kind === 'miniapp' && r.miniapp?.app === spec.id && r.miniapp?.principal === 'operator' && typeof r.job?.id === 'string').map((r) => r.job!.id),
    });
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const receiptsOf = (jobId: string) => readChain('runs', project.root)
    .filter((r) => r.kind === 'miniapp' && r.miniapp?.app === spec.id && (r.job?.id === jobId || String(r.job?.id ?? '').startsWith(`${jobId}/`)))
    .map((r) => ({ id: r.id, status: String(r.status), state: r.job?.state }));
  return {
    spec, project, app,
    request: (...a) => app.request(...a),
    sealNow: () => app.sealNow(),
    receiptsOf,
    sealFor: async (jobId, ms = 15_000) => {
      const end = Date.now() + ms;
      await app.sealNow();
      while (!receiptsOf(jobId).length && Date.now() < end) { await new Promise((r) => setTimeout(r, 250)); await app.sealNow(); }
      return receiptsOf(jobId);
    },
    close: () => app.stop(),
  };
}

/** Polls `read` until `done` says the job ended (or `ms` passes); the last answer. */
export async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 300_000, every = 500): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await new Promise((r) => setTimeout(r, every)); v = await read(); }
  return v;
}

export type { AppResponse };
