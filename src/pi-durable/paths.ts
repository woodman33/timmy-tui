/**
 * Pi Durable, slice S1 (R4 H118): where the Pi worker keeps what it owns, for one project. Everything is under
 * <project>/.timmy/private/pi/ (Timmy's per-project folder, never committed), except the socket, which lives in $TMPDIR
 * with a short name because macOS caps a socket path at 104 bytes (plan b.1.5).
 *
 * .timmy/private is the part of the project Timmy's own file tools, reads and listings never reach (privatePath in
 * src/project), so no agent can read the worker's token into a model's context or rewrite its effect ledger (fix S1 of
 * H119's review: it was .timmy/pi/, which they reached). Pi's own file tools refuse all of .timmy/ (slow-tools.ts).
 */
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectId } from '../project/index.js';

/** The worker's folder, project-relative (worker.token, worker.json, the store, the ledger, runs/, starts.jsonl, trial copies). */
export const PI_DIR_REL = '.timmy/private/pi';
/** The store, as worker.json and hello name it: project-relative, never a home path. */
export const STORE_REL = `${PI_DIR_REL}/store.sqlite`;
/** The worker's log, project-relative (the supervisor appends its output there). */
export const LOG_REL = `${PI_DIR_REL}/worker.log`;

export interface PiPaths {
  readonly root: string;
  readonly projectId: string;
  readonly dir: string;
  readonly store: string;
  readonly owner: string;
  readonly token: string;
  readonly log: string;
  readonly effects: string;
  readonly runs: string;
  /** one line per worker start (the supervisor's start budget, plan b.2) */
  readonly starts: string;
  readonly fauxCalls: string;
  readonly socket: string;
}

export function piPaths(root: string): PiPaths {
  const abs = resolve(root);
  const id = projectId(abs);
  const dir = join(abs, ...PI_DIR_REL.split('/'));
  return {
    root: abs,
    projectId: id,
    dir,
    store: join(abs, STORE_REL),
    owner: join(dir, 'worker.json'),
    token: join(dir, 'worker.token'),
    log: join(dir, 'worker.log'),
    effects: join(dir, 'effects.jsonl'),
    runs: join(dir, 'runs'),
    starts: join(dir, 'starts.jsonl'),
    // FAKE: every request the scripted faux model receives, one line each (the tests count them; spike model.log)
    fauxCalls: join(dir, 'faux-calls.jsonl'),
    socket: join(tmpdir(), `timmy-pi-${id.slice(0, 12)}.sock`),
  };
}

/**
 * The worker folder holding the pinned packages: --worker-dir, else TIMMY_PI_WORKER_DIR, else this checkout's
 * workers/pi-durable. (S2 may move the default to Timmy's data folder, where `timmy pi setup` installs it.)
 */
export function defaultWorkerDir(): string {
  const given = process.env.TIMMY_PI_WORKER_DIR;
  if (given) return resolve(given);
  // src/pi-durable/paths.ts (or dist/src/pi-durable/paths.js) → the checkout root → workers/pi-durable
  const here = dirname(fileURLToPath(import.meta.url));
  const up2 = resolve(here, '..', '..');
  const root = basename(up2) === 'dist' ? dirname(up2) : up2;
  return join(root, 'workers', 'pi-durable');
}
