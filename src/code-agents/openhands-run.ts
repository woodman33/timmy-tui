/**
 * Round R4 (helper H52): what an OpenHands run does outside its container (openhands.ts plans it): the docker checks
 * before it, the copy of the project it works on, the write-back of its changes after it, and the stop of its container
 * by its name and labels. Every docker command goes through the docker client /agent found (TIMMY_AGENT_DOCKER_BIN, else
 * docker on PATH), with Timmy's keys blank in its environment; none builds, pulls or removes an image.
 *
 * The copy: .timmy/agents/<run>/work/, every file Timmy's snapshot of the project lists (not .git, node_modules, .timmy or
 * dist, at any depth: the same folders /agent never compares, so nothing outside what is compared goes in, and nothing
 * the agent writes there comes back): .git stays out so the agent cannot touch the repository's history, config or hooks,
 * and node_modules because it is the host's (often macOS) build, large, and never compared. A link is copied as its link
 * text (inside the container it resolves there, or nowhere). A file is read without following a link at its own name,
 * hashed as it is copied, and the copy is refused when a file's bytes are not the ones the snapshot saw (the project
 * changed while it was copied).
 *
 * The write-back, only for a run that completed: the copy's changes (the copy now against the copy as made) are written
 * into the project when the project is as it was copied (Timmy's snapshot again, every file); otherwise nothing is
 * written (a stale refusal) and the copy is kept. Before anything is written, every project file it overwrites or deletes
 * is copied to .timmy/agents/<run>/before/<path> and checked against the snapshot; then deletions, changes (a temporary
 * file renamed over the old one, keeping its mode) and additions (placed only where nothing is). A link is never written
 * back, and nothing is written through a folder that is a link. What could not be written is named, never dropped.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { packagedPath } from '../utils/asset-dirs.js';
import { placeNew } from '../utils/place-new.js';
import { ollamaRoot } from './codex-local.js';
import {
  AGENTS_DIR, diffSnapshots, SNAPSHOT_HASH_LIMIT, SNAPSHOT_MAX_FILES, SNAPSHOT_SKIP, snapshotProject,
  type ChangeSet, type Snapshot,
} from './index.js';
import {
  dockerClientEnv, LABEL_PROJECT, LABEL_RUN, OPENHANDS_COPY_MAX_BYTES, OPENHANDS_IMAGE, OPENHANDS_IMAGE_LABEL, OPENHANDS_SDK, OPENHANDS_WORKER,
  type ContainerStop, type OpenHandsContainer, type OpenHandsDocker, type WriteBack,
} from './openhands.js';

type Env = Record<string, string | undefined>;

// ── docker ──────────────────────────────────────────────────────────────────────

export interface DockerAnswer { code: number | null; stdout: string; stderr: string; error?: string }

/** One docker command, its environment Timmy's own with its keys blank (dockerClientEnv); it never reads a stdin. */
export function dockerCall(bin: string, args: string[], env: Env, timeoutMs = 15_000): Promise<DockerAnswer> {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...dockerClientEnv(env) } }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        // A command Timmy's own timeout ended has no exit code of its own: OrbStack's docker exits 143 on that SIGTERM,
        // which read as docker's answer on the Mac (ledger row 159). It is recorded as no answer.
        const timedOut = !!e?.killed;
        const code = !e ? 0 : timedOut ? null : typeof e.code === 'number' ? e.code : null;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(e && code === null ? { error: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s (Timmy ended the docker command)` : String(e.code ?? e.message) } : {}) });
      });
      child.stdin?.end();
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: (e as Error).message });
    }
  });
}

const firstLine = (t: string | undefined): string => (t ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? '';

/**
 * Whether a run could start here: the daemon answers (docker info) and the image is there, built from Timmy's Dockerfile
 * (its label). Read-only: nothing is built, pulled or started.
 */
export async function dockerSetup(bin: string, env: Env, timeoutMs = 8000): Promise<OpenHandsDocker> {
  const info = await dockerCall(bin, ['info', '--format', '{{.ServerVersion}}'], env, timeoutMs);
  const server = firstLine(info.stdout);
  if (info.code !== 0 || !server) return { state: 'no daemon', detail: firstLine(info.stderr) || info.error || `docker info exited ${info.code}` };
  const img = await dockerCall(bin, ['image', 'inspect', '--format', `{{.Id}}|{{index .Config.Labels "${OPENHANDS_IMAGE_LABEL}"}}`, OPENHANDS_IMAGE], env, timeoutMs);
  if (img.code !== 0) return /no such image/i.test(`${img.stderr}${img.stdout}`) ? { state: 'no image' } : { state: 'docker failed', detail: firstLine(img.stderr) || img.error || `docker image inspect exited ${img.code}` };
  const [id, label] = firstLine(img.stdout).split('|').map((x) => x.trim());
  if (label !== OPENHANDS_SDK) return { state: 'other image', detail: `its ${OPENHANDS_IMAGE_LABEL} label is ${label || 'missing'}` };
  if (!id) return { state: 'docker failed', detail: 'docker image inspect gave no image id' };
  return { state: 'ready', server, imageId: id };
}

/** The worker this Timmy ships (workers/openhands/timmy_openhands.py), found as the other workers are; undefined when missing. */
export const openHandsWorker = (): string | undefined => packagedPath(OPENHANDS_WORKER, import.meta.url, { kind: 'file' });

/**
 * Whether this machine's Ollama lists the model by its exact name (GET /api/tags): OpenHands asks for it by that name
 * from inside its container. Nothing is written or pulled; the task is not sent.
 */
export async function ollamaListed(baseUrl: string, model: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  let where = 'its address';
  let url: string;
  try { where = new URL(baseUrl).host; url = `${ollamaRoot(baseUrl)}/api/tags`; } catch { return { ok: false, error: 'TIMMY_AGENT_BASE_URL is not an address OpenHands\' local route can use. Nothing was started.' }; }
  let res: Response;
  try { res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 3000), redirect: 'manual' }); } catch {
    return { ok: false, error: `The Ollama at ${where} did not answer: start it (ollama serve, or brew services start ollama), then try again. Nothing was started.` };
  }
  let names: string[] | undefined;
  if (res.ok) {
    try {
      const body = await res.json() as { models?: unknown };
      if (Array.isArray(body?.models)) names = body.models.map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined)).filter((n): n is string => typeof n === 'string');
    } catch { names = undefined; }
  } else {
    try { await res.body?.cancel(); } catch { /* nothing to read */ }
  }
  if (!names) return { ok: false, error: `${where} did not answer as an Ollama (GET /api/tags: HTTP ${res.status}). Nothing was started.` };
  if (!names.includes(model)) {
    const base = model.split(':')[0];
    const near = names.filter((n) => n.split(':')[0] === base).slice(0, 4);
    return { ok: false, error: `The Ollama at ${where} does not list ${model}${near.length ? ` (it lists ${near.join(', ')})` : ''}: name a model exactly as \`ollama list\` does, or pull it yourself first (ollama pull ${model}). Nothing was started.` };
  }
  return { ok: true };
}

/** One container docker ps lists: its id, its names, its state and Timmy's two labels. */
export interface Listed { id: string; names: string[]; state: string; run: string; project: string }
const PS_FORMAT = `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "${LABEL_RUN}"}}\t{{.Label "${LABEL_PROJECT}"}}`;

/** The containers carrying every one of these labels (docker ps -a --filter label=k=v ...), or why docker could not say. */
export async function listByLabels(bin: string, env: Env, labels: Record<string, string>, timeoutMs = 15_000): Promise<{ ok: true; listed: Listed[] } | { ok: false; error: string }> {
  const filters = Object.entries(labels).flatMap(([k, v]) => ['--filter', v ? `label=${k}=${v}` : `label=${k}`]);
  const r = await dockerCall(bin, ['ps', '-a', '--no-trunc', ...filters, '--format', PS_FORMAT], env, timeoutMs);
  if (r.code !== 0) return { ok: false, error: firstLine(r.stderr) || r.error || `docker ps exited ${r.code}` };
  const listed: Listed[] = [];
  for (const line of r.stdout.split('\n')) {
    const [id, names, state, run, project] = line.split('\t');
    if (!id?.trim() || names === undefined) continue;
    listed.push({ id: id.trim(), names: names.split(',').map((n) => n.trim().replace(/^\//, '')).filter(Boolean), state: (state ?? '').trim().toLowerCase(), run: (run ?? '').trim(), project: (project ?? '').trim() });
  }
  return { ok: true, listed };
}

/** The container with this exact name among those carrying exactly these labels: never a name alone. */
async function findOwn(bin: string, env: Env, c: { name: string; labels: Record<string, string> }): Promise<{ ok: true; found?: Listed } | { ok: false; error: string }> {
  const r = await listByLabels(bin, env, c.labels);
  if (!r.ok) return r;
  const found = r.listed.find((x) => x.names.includes(c.name) && x.run === c.labels[LABEL_RUN] && x.project === c.labels[LABEL_PROJECT]);
  return { ok: true, ...(found ? { found } : {}) };
}

const RUNNING: ReadonlySet<string> = new Set(['running', 'restarting', 'paused', 'created']);

/**
 * Stops a run's container: found by its labels and its exact name (findOwn), then `docker stop --time <grace> <name>`,
 * then `docker kill <name>` when it still runs, each followed by the same check. Never a container found by its name alone.
 */
export async function stopContainer(bin: string, env: Env, c: { name: string; labels: Record<string, string> }, why: ContainerStop['why'], o: { graceSeconds?: number; now?: () => Date } = {}): Promise<ContainerStop> {
  const at = (o.now?.() ?? new Date()).toISOString();
  const steps: ContainerStop['steps'] = [];
  const base = { why, at, name: c.name };
  const look = async (): Promise<{ ok: true; running: boolean } | { ok: false; error: string }> => {
    const f = await findOwn(bin, env, c);
    return f.ok ? { ok: true, running: !!f.found && RUNNING.has(f.found.state) } : f;
  };
  const first = await look();
  if (!first.ok) return { ...base, result: 'unchecked', steps, detail: `docker ps: ${first.error}` };
  if (!first.running) return { ...base, result: 'gone', steps };
  const grace = String(o.graceSeconds ?? 10);
  const stop = await dockerCall(bin, ['stop', '--time', grace, c.name], env, (Number(grace) + 20) * 1000);
  steps.push({ command: `docker stop --time ${grace} ${c.name}`, exit: stop.code });
  const second = await look();
  // A stop that failed on a container already gone (it ended meanwhile) did not stop it: it had ended.
  if (second.ok && !second.running) return { ...base, result: stop.code === 0 ? 'stopped' : 'gone', steps };
  const kill = await dockerCall(bin, ['kill', c.name], env, 20_000);
  steps.push({ command: `docker kill ${c.name}`, exit: kill.code });
  const third = await look();
  // Gone after a docker kill that failed: it ended on the stop's own signal (or by itself), not by the kill (row 159).
  if (third.ok && !third.running) {
    if (kill.code === 0) return { ...base, result: 'killed', steps };
    const said = stop.code === null ? `docker stop gave no answer (${stop.error ?? 'no exit code'}); docker kill exited ${kill.code ?? 'without an exit code'}${firstLine(kill.stderr) ? `: ${firstLine(kill.stderr)}` : ''}` : `docker stop exited ${stop.code}; docker kill exited ${kill.code ?? 'without an exit code'}`;
    return { ...base, result: 'ended', steps, detail: said };
  }
  const said = firstLine(kill.stderr) || firstLine(stop.stderr) || (third.ok ? '' : third.error);
  return { ...base, result: third.ok ? 'unresolved' : 'unchecked', steps, ...(said ? { detail: said } : {}) };
}

// ── the copy ────────────────────────────────────────────────────────────────────

const CHUNK = 1024 * 1024;

/** Copies a regular file without following a link at its own name, hashing it; the copy is created (never replaced) with `mode`. */
function copyRegular(src: string, dst: string, mode?: number): { sha256: string; size: number; mode: number; mtimeMs: number } {
  const from = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  let to: number | undefined;
  try {
    const st = fstatSync(from);
    if (!st.isFile()) throw Object.assign(new Error(`${src} is not a regular file`), { code: 'ENOTREG' });
    const m = mode ?? (st.mode & 0o777);
    to = openSync(dst, 'wx', m);
    const h = createHash('sha256');
    const buf = Buffer.alloc(CHUNK);
    let size = 0;
    for (;;) {
      const n = readSync(from, buf, 0, CHUNK, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
      for (let off = 0; off < n;) off += writeSync(to, buf, off, n - off);
      size += n;
    }
    const out = fstatSync(to);
    return { sha256: h.digest('hex'), size, mode: m, mtimeMs: out.mtimeMs };
  } finally {
    closeSync(from);
    if (to !== undefined) closeSync(to);
  }
}

/** A file's sha256 and size, read without following a link at its own name; undefined when it is not a regular file. */
function hashNoFollow(path: string): { sha256: string; size: number } | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return undefined; }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const h = createHash('sha256');
    const buf = Buffer.alloc(CHUNK);
    let size = 0;
    for (;;) { const n = readSync(fd, buf, 0, CHUNK, null); if (!n) break; h.update(buf.subarray(0, n)); size += n; }
    return { sha256: h.digest('hex'), size };
  } finally { closeSync(fd); }
}

/** Whether `abs` is the folder `root` or inside it, both through their real paths. */
function inside(realRoot: string, abs: string): boolean {
  let real: string;
  try { real = realpathSync(abs); } catch { return false; }
  const rel = relative(realRoot, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A project-relative path from a snapshot: plain names only, never climbing out. */
const plainRel = (rel: string): boolean => rel.split('/').every((p) => p && p !== '.' && p !== '..');

export type CopyMade = { ok: true; copied: Snapshot; files: number; bytes: number; worker: { sha256: string } } | { ok: false; error: string };

/**
 * The run's copy of the project (container.work) from the snapshot it is judged by, and its worker (container.worker),
 * both inside its run folder. Refused, with what it made removed, when the snapshot stopped at its limit, when the files
 * are more than OPENHANDS_COPY_MAX_BYTES, or when a file is not what the snapshot saw. Returns the copy's own snapshot as
 * made (the baseline its changes are read against: its files' times are the copy's).
 */
export function makeCopy(o: { root: string; container: OpenHandsContainer; before: Snapshot; truncated: boolean; workerSource: string }): CopyMade {
  const c = o.container;
  if (o.truncated) return { ok: false, error: `The project has more than ${SNAPSHOT_MAX_FILES.toLocaleString('en-US')} files (not counting .git, node_modules, .timmy and dist): OpenHands works on a copy of every one, and Timmy copies at most that many. Nothing was started.` };
  let bytes = 0;
  for (const f of o.before.values()) if (f.link === undefined) bytes += f.size;
  if (bytes > OPENHANDS_COPY_MAX_BYTES) return { ok: false, error: `The project's files come to ${(bytes / 1024 ** 3).toFixed(1)} GiB (not counting .git, node_modules, .timmy and dist): OpenHands works on a copy, and Timmy copies at most ${OPENHANDS_COPY_MAX_BYTES / 1024 ** 3} GiB. Nothing was started.` };
  const made: string[] = [];
  const undo = (): void => { for (const d of made.reverse()) { try { rmSync(d, { recursive: true, force: true }); } catch { /* left; named by the error */ } } };
  try {
    const realRoot = realpathSync(o.root);
    mkdirSync(c.work); made.push(c.work);
    mkdirSync(c.worker); made.push(c.worker);
    const copied: Snapshot = new Map();
    let files = 0;
    for (const [rel, f] of [...o.before.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!plainRel(rel)) throw new Error(`the snapshot named ${rel}`);
      const src = join(o.root, ...rel.split('/'));
      const dst = join(c.work, ...rel.split('/'));
      mkdirSync(dirname(dst), { recursive: true });
      if (!inside(realRoot, dirname(src))) throw new Error(`${rel}: its folder leads outside the project`);
      if (f.link !== undefined) {
        symlinkSync(f.link, dst);
        const st = lstatSync(dst);
        copied.set(rel, { size: Buffer.byteLength(f.link), sha256: createHash('sha256').update(`symlink\0${f.link}`).digest('hex'), mtimeMs: st.mtimeMs, link: f.link });
        files += 1;
        continue;
      }
      const got = copyRegular(src, dst);
      const same = f.sha256 ? got.sha256 === f.sha256 : got.size === f.size;
      if (!same) throw Object.assign(new Error(`${rel} changed while the project was being copied`), { code: 'ESTALE' });
      copied.set(rel, { size: got.size, sha256: got.size <= SNAPSHOT_HASH_LIMIT ? got.sha256 : null, mtimeMs: got.mtimeMs });
      files += 1;
    }
    const w = copyRegular(o.workerSource, join(c.worker, 'timmy_openhands.py'), 0o444);
    return { ok: true, copied, files, bytes, worker: { sha256: w.sha256 } };
  } catch (e) {
    undo();
    const err = e as NodeJS.ErrnoException;
    return { ok: false, error: `The copy of the project for OpenHands could not be made: ${err.code === 'ESTALE' ? err.message : `${err.code ?? 'error'}: ${err.message}`}. Nothing was started.` };
  }
}

/** Removes a run folder made just now and holding only what makeCopy makes (work/ and worker/): a start refused after it. */
export function discardRunDir(root: string, run: string): void {
  if (!/^a[0-9a-f]{8}$/.test(run)) return;
  const dir = join(root, AGENTS_DIR, run);
  try {
    const left = readdirSync(dir).filter((n) => n !== 'work' && n !== 'worker');
    if (left.length) return;
    rmSync(dir, { recursive: true, force: true });
  } catch { /* nothing there */ }
}

// ── the write-back ──────────────────────────────────────────────────────────────

/** At most this many entries of each list are kept in a record; the rest are counted. */
const LISTED_MAX = 200;

/** The entries the copy holds that are never compared or written back (.git, node_modules, .timmy, dist, at any depth). */
function notCompared(work: string, max = 20): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= max) return;
      const abs = join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (SNAPSHOT_SKIP.has(n)) { out.push(st.isDirectory() ? `${r}/` : r); continue; }
      if (st.isDirectory()) walk(abs, r);
    }
  };
  walk(work, '');
  return out;
}

/** Each folder on the way to `rel` in the project that exists must be a real folder (never a link); the missing ones are made. */
function folderFor(root: string, rel: string, make: boolean): string | undefined {
  const parts = rel.split('/').slice(0, -1);
  let at = root;
  for (const p of parts) {
    at = join(at, p);
    let st;
    try { st = lstatSync(at); } catch {
      if (!make) return `its folder ${relative(root, at).split(sep).join('/')} is missing`;
      mkdirSync(at);
      continue;
    }
    if (st.isSymbolicLink()) return `its folder ${relative(root, at).split(sep).join('/')} in the project is a link`;
    if (!st.isDirectory()) return `${relative(root, at).split(sep).join('/')} in the project is a file, not a folder`;
  }
  return undefined;
}

/** Whether a folder of the copy is still a folder there (after a deletion, an emptied project folder is removed only when not). */
const folderInCopy = (work: string, rel: string): boolean => { try { return lstatSync(join(work, ...rel.split('/'))).isDirectory(); } catch { return false; } };

export interface WriteBackResult { writeback: WriteBack; copyChanges: ChangeSet & { truncated: boolean }; copyKept: boolean }

/**
 * Writes the run's changes from its copy into the project (see the module comment). `completed` false: nothing is
 * written, its changes are only read (why: `reason`). Synchronous: it runs as the run's job ends, before its result is
 * sealed, so the result's own before/after comparison sees what was written.
 */
export function writeBack(o: { root: string; run: string; container: OpenHandsContainer; before: Snapshot; copied: Snapshot; completed: boolean; reason?: string }): WriteBackResult {
  const c = o.container;
  const dirRel = `${AGENTS_DIR}/${o.run}`;
  const after = snapshotProject(c.work);
  const changes = diffSnapshots(o.copied, after.files);
  // What it changed in its copy, each list cut at LISTED_MAX (truncated then says so, as when the walk stopped at its limit).
  const copyChanges = {
    added: changes.added.slice(0, LISTED_MAX), changed: changes.changed.slice(0, LISTED_MAX), deleted: changes.deleted.slice(0, LISTED_MAX),
    truncated: after.truncated || [changes.added, changes.changed, changes.deleted].some((l) => l.length > LISTED_MAX),
  };
  const notWritten: WriteBack['not_written'] = notCompared(c.work).map((p) => ({ path: p, why: 'not compared: .git, node_modules, .timmy and dist are never written back' }));
  const total = changes.added.length + changes.changed.length + changes.deleted.length;
  const done = (w: Omit<WriteBack, 'not_written'> & { not_written?: WriteBack['not_written'] }, keep: boolean): WriteBackResult => ({ writeback: { ...w, not_written: [...(w.not_written ?? []), ...notWritten].slice(0, LISTED_MAX) }, copyChanges, copyKept: keep });
  if (!o.completed) return done({ state: 'not attempted', why: `${o.reason ?? 'it did not complete'}; its copy is kept in ${dirRel}/work/`, written: [] }, true);
  if (after.truncated) return done({ state: 'refused', why: `its copy now has more files than Timmy compares (${SNAPSHOT_MAX_FILES.toLocaleString('en-US')}); its copy is kept in ${dirRel}/work/`, written: [] }, true);
  if (!total) return done({ state: 'nothing to write', why: 'it changed nothing in its copy', written: [] }, notWritten.length > 0);
  // Links are never written back; the rest are files.
  const links = (x: { link?: string; previous_link?: string }): boolean => x.link !== undefined || x.previous_link !== undefined;
  const skipped: WriteBack['not_written'] = [...changes.added, ...changes.changed, ...changes.deleted].filter(links).map((x) => ({ path: x.path, why: 'a link: links are never written back from the container' }));
  const deleted = changes.deleted.filter((x) => !links(x));
  const changed = changes.changed.filter((x) => !links(x));
  const added = changes.added.filter((x) => !links(x));
  // The project as it was copied, or nothing is written.
  const now = snapshotProject(o.root);
  const meanwhile = diffSnapshots(o.before, now.files);
  const moved = [...meanwhile.changed.map((x) => `${x.path} changed`), ...meanwhile.added.map((x) => `${x.path} added`), ...meanwhile.deleted.map((x) => `${x.path} deleted`)];
  if (now.truncated || moved.length) {
    const named = moved.slice(0, 3).join(', ');
    return done({
      state: 'refused', written: [], not_written: skipped,
      why: now.truncated ? `the project now has more files than Timmy compares, so whether it changed while OpenHands ran cannot be told; its changes are kept in ${dirRel}/work/`
        : `the project changed while it ran (${named}${moved.length > 3 ? ` and ${moved.length - 3} more` : ''}); its changes are kept in ${dirRel}/work/`,
      ...(moved.length ? { changed_meanwhile: moved.slice(0, 20).map((m) => m.replace(/ (changed|added|deleted)$/, '')), ...(moved.length > 20 ? { changed_meanwhile_more: moved.length - 20 } : {}) } : {}),
    }, true);
  }
  // Each file it overwrites or deletes is checked before anything is written: a regular file where the snapshot saw it,
  // reached through real folders (never a link). An added file is checked as it is written, after the deletions.
  const refused: WriteBack['not_written'] = [...skipped];
  const abs = (rel: string): string => join(o.root, ...rel.split('/'));
  const existing = <T extends { path: string }>(list: T[]): T[] => list.filter((x) => {
    let why = plainRel(x.path) ? folderFor(o.root, x.path, false) : 'not a plain path in the project';
    if (!why) { try { if (!lstatSync(abs(x.path)).isFile()) why = 'it is not a regular file in the project'; } catch { why = 'it is not in the project'; } }
    if (why) refused.push({ path: x.path, why });
    return !why;
  });
  const del = existing(deleted);
  const chg = existing(changed);
  const add = added.filter((x) => { if (plainRel(x.path)) return true; refused.push({ path: x.path, why: 'not a plain path in the project' }); return false; });
  const keptRel = (rel: string): string => `${dirRel}/before/${rel}`;
  const keptAbs = (rel: string): string => join(c.dir, 'before', ...rel.split('/'));
  // Kept first: every file it overwrites or deletes, its bytes checked against the snapshot. Nothing is written before.
  for (const x of [...del, ...chg]) {
    const was = o.before.get(x.path);
    try {
      mkdirSync(dirname(keptAbs(x.path)), { recursive: true });
      const got = copyRegular(abs(x.path), keptAbs(x.path));
      const same = was?.sha256 ? got.sha256 === was.sha256 : got.size === was?.size;
      if (!same) return done({ state: 'refused', why: `${x.path} changed as its changes were about to be written; nothing was written, and its changes are kept in ${dirRel}/work/`, written: [], not_written: refused }, true);
    } catch (e) {
      return done({ state: 'refused', why: `${x.path} could not be kept before it was replaced (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was written, and its changes are kept in ${dirRel}/work/`, written: [], not_written: refused }, true);
    }
  }
  const written: WriteBack['written'] = [];
  const all = del.length + chg.length + add.length;
  const partial = (path: string, e: unknown): WriteBackResult => done({
    state: 'partial', written, not_written: refused,
    why: `${path} could not be written (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}): ${written.length} of ${all} were written, the files they replaced or deleted are kept in ${dirRel}/before/, and its copy is kept in ${dirRel}/work/`,
  }, true);
  /** The copy's bytes in a new temporary file beside `dest`, checked against the copy's snapshot after the run. */
  const staged = (rel: string, dest: string, mode: number | undefined, sha: string | null): { tmp: string; sha256: string } => {
    const tmp = join(dirname(dest), `.${randomBytes(4).toString('hex')}.timmy-${o.run}.tmp`);
    try {
      const got = copyRegular(join(c.work, ...rel.split('/')), tmp, mode);
      if (sha && got.sha256 !== sha) throw Object.assign(new Error('its copy changed after the run'), { code: 'ESTALE' });
      return { tmp, sha256: got.sha256 };
    } catch (e) { try { unlinkSync(tmp); } catch { /* not made */ } throw e; }
  };
  for (const x of del) {
    try { unlinkSync(abs(x.path)); } catch (e) { return partial(x.path, e); }
    written.push({ path: x.path, how: 'deleted', previous_sha256: x.previous_sha256 ?? null, kept: keptRel(x.path) });
    // A project folder the deletion emptied goes too, when the copy no longer has it as a folder (rmdir: only when empty).
    for (let d = dirname(x.path); d && d !== '.'; d = dirname(d)) {
      if (folderInCopy(c.work, d)) break;
      try { rmdirSync(abs(d)); } catch { break; }
    }
  }
  for (const x of chg) {
    try {
      const mode = lstatSync(abs(x.path)).mode & 0o777;
      const t = staged(x.path, abs(x.path), mode, x.sha256);
      try { renameSync(t.tmp, abs(x.path)); } catch (e) { try { unlinkSync(t.tmp); } catch { /* gone */ } throw e; }
      written.push({ path: x.path, how: 'changed', sha256: t.sha256, previous_sha256: x.previous_sha256 ?? null, kept: keptRel(x.path) });
    } catch (e) { return partial(x.path, e); }
  }
  for (const x of add) {
    const why = folderFor(o.root, x.path, true);
    if (why) { refused.push({ path: x.path, why }); continue; }
    try {
      const t = staged(x.path, abs(x.path), undefined, x.sha256);
      try { placeNew(t.tmp, abs(x.path)); } catch (e) {
        try { unlinkSync(t.tmp); } catch { /* gone */ }
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') { refused.push({ path: x.path, why: 'something is already at its place in the project; nothing was replaced' }); continue; }
        throw e;
      }
      try { unlinkSync(t.tmp); } catch { /* renamed into place */ }
      written.push({ path: x.path, how: 'added', sha256: t.sha256 });
    } catch (e) { return partial(x.path, e); }
  }
  const n = (how: WriteBack['written'][number]['how']): number => written.filter((w) => w.how === how).length;
  return done({ state: 'written', why: `${n('added')} added, ${n('changed')} changed, ${n('deleted')} deleted; the files it replaced or deleted are kept in ${dirRel}/before/`, written, not_written: refused }, refused.length > 0 || notWritten.length > 0);
}
