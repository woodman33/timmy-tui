/**
 * Round R4 (helper H90): remote jobs. `timmy connect run <id> [--wait] -- <command…>` or `--script <file>`.
 *
 * The job's id ("r" and 8 hex digits) is chosen here before anything is sent, and names its folder on the device
 * (<remote_dir>/<id>). Its local record lives in Timmy's jobs folder (<Timmy home>/jobs/<id>.json, kind "remote"): the
 * job readers there list only their own j<6 hex> records, so they read past it. The record holds the device, the remote
 * id, the script's sha256 and one state:
 *
 *   submitted   sent, not confirmed by the device (or not sent at all: the words say which)
 *   running     the device's status file said so, read at a named time
 *   ended       with its exit (or: its process is gone and it recorded no end)
 *   unknown     the device did not answer: since when, why, when it was last seen and what is not known
 *   stop asked  a person asked for a stop; the device has not confirmed it
 *   stopped     the device's status file confirms the stop
 *
 * `status` reads the device's status file before it says anything, and so does every retry, so a job is never started
 * twice: on the device, only the call that creates the job's claim starts it (src/connect/remote-posix.ts).
 *
 * An id is 32 random bits, and a job's folder on a device outlives its local record, so the record carries a nonce that its
 * submission writes into the folder it makes (an owner file): a folder that holds another nonce is another job's, the device
 * answers "id-taken", nothing in that folder changes, and `run` draws a new id and says so. The record also keeps the job's
 * first process once the device has shown it running this job's supervisor (`process`): a stop signals only that one.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { appendReceipt } from '../utils/receipts.js';
import { posixCommandScript, posixFetchScript, posixStatusScript, posixStopScript, posixSubmitScript, posixWaitScript } from './remote-posix.js';
import { windowsCommandScript, windowsFetchScript, windowsStatusScript, windowsStopScript, windowsSubmitInput, windowsSubmitScript, windowsWaitScript } from './remote-windows.js';
import { noteFailure, keyValues } from './probe.js';
import { scrubShown } from './scrub.js';
import { POSIX_WORDS, powershellWords, shQuote } from './shells.js';
import { callSsh, classifySsh, type SshFailure } from './ssh.js';
import { expandHome, findDevice, locked, privateDir, shown, writePrivate, type ConnectPaths } from './store.js';
import { checkJobPath, REMOTE_JOB_ID } from './validate.js';
import { exitWords, jobWords } from './words.js';
import type { DeviceRecord, RemoteJobRecord, RemoteStatus } from './types.js';

/** The longest script Timmy sends (its bytes ride in the submission). */
export const MAX_SCRIPT = 1024 * 1024;
/** A wait has no limit of its own; this is only a backstop (7 days). */
const WAIT_MS = 7 * 24 * 3600 * 1000;
const EVENTS_MAX = 60;

export const jobFile = (p: ConnectPaths, id: string): string => path.join(p.jobs, `${id}.json`);
/** The exact bytes sent, kept 0600 until the device confirms the run started (a retry sends the same bytes). */
const scriptCopy = (p: ConnectPaths, id: string): string => path.join(p.jobs, `${id}.script`);

export function readJob(p: ConnectPaths, id: string): RemoteJobRecord | undefined {
  if (!REMOTE_JOB_ID.test(id)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(jobFile(p, id), 'utf8')) as RemoteJobRecord;
    return raw && raw.kind === 'remote' && raw.id === id ? raw : undefined;
  } catch { return undefined; }
}

/** Every remote job record in Timmy's jobs folder, newest first (no device is contacted). */
export function listJobs(p: ConnectPaths): RemoteJobRecord[] {
  let names: string[] = [];
  try { names = readdirSync(p.jobs); } catch { return []; }
  return names.flatMap((n) => { const m = /^(r[0-9a-f]{8})\.json$/.exec(n); const j = m ? readJob(p, m[1]) : undefined; return j ? [j] : []; })
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));
}

function event(j: RemoteJobRecord, what: string, at = new Date().toISOString()): void {
  j.events.push({ at, what: scrubShown(what).slice(0, 400) });
  if (j.events.length > EVENTS_MAX) j.events.splice(0, j.events.length - EVENTS_MAX);
}

/** Changes a job's record under Connect's lock, from the record as it is on disk now (another Timmy may have written it). */
function updateJob(p: ConnectPaths, id: string, fn: (j: RemoteJobRecord) => void): RemoteJobRecord {
  return locked(p, () => {
    const j = readJob(p, id);
    if (!j) throw new Error(`no remote job ${id}`);
    fn(j);
    writePrivate(jobFile(p, id), `${JSON.stringify(j, null, 2)}\n`);
    return j;
  });
}

/** A new job id, claimed by creating its record exclusively. */
function claimId(p: ConnectPaths, record: (id: string) => RemoteJobRecord): RemoteJobRecord {
  privateDir(p.jobs);
  for (let i = 0; i < 100; i++) {
    const id = `r${randomBytes(4).toString('hex')}`;
    const j = record(id);
    try {
      const fd = openSync(jobFile(p, id), 'wx', 0o600);
      try { writeSync(fd, `${JSON.stringify(j, null, 2)}\n`); } finally { closeSync(fd); }
      return j;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  throw new Error('no free remote job id in the jobs folder');
}

/** The status block of a script's answer (TIMMY-STATUS-BEGIN … END), as a RemoteStatus read now. */
export function parseStatus(text: string, readAt = new Date().toISOString()): RemoteStatus | null {
  const kv = keyValues(text, 'TIMMY-STATUS-BEGIN', 'TIMMY-STATUS-END');
  if (!kv) return null;
  const lines = text.replace(/\r/g, '').split('\n');
  const from = lines.findIndex((l) => l.trim() === 'TIMMY-STATUS-BEGIN');
  const to = lines.findIndex((l, i) => i > from && l.trim() === 'TIMMY-STATUS-END');
  // the output lines are scrubbed together, so a private-key block spread over them is caught whole
  const raw = lines.slice(from + 1, to < 0 ? undefined : to).filter((l) => l.startsWith('out|')).map((l) => l.slice(4));
  const tail = raw.length ? scrubShown(raw.join('\n')).split('\n').map((l) => l.slice(0, 300)) : [];
  const one = (k: string): string | undefined => kv.find(([key]) => key === k)?.[1];
  const int = (k: string): number | undefined => { const v = one(k); return v !== undefined && /^[0-9]+$/.test(v) ? Number(v) : undefined; };
  const where = one('where');
  if (where !== 'absent' && where !== 'not started' && where !== 'claimed' && where !== 'status') return null;
  const s: RemoteStatus = { read_at: readAt, where };
  // whose the folder is (only when Timmy passed its nonce): a folder of another job is none of this one's
  const owner = one('owner');
  if (owner === 'same' || owner === 'other' || owner === 'none') s.owner = owner;
  if (s.where !== 'status') return s;
  const state = one('state');
  if (state === 'running' || state === 'ended') s.state = state;
  for (const k of ['pid', 'pgid'] as const) { const v = int(k); if (v !== undefined) s[k] = v; }
  const text1 = (k: 'pid_start' | 'started_at' | 'ended_at' | 'stop_signal' | 'by'): void => { const v = one(k); if (v) s[k] = scrubShown(v).slice(0, 80); };
  text1('pid_start'); text1('started_at'); text1('ended_at'); text1('stop_signal'); text1('by');
  if (state === 'ended') { const code = one('exit_status'); s.exit_status = code !== undefined && /^[0-9]+$/.test(code) ? Number(code) : null; }
  const alive = one('alive');
  if (alive === 'yes' || alive === 'no' || alive === 'reused' || alive === 'unchecked') s.alive = alive;
  const runner = one('runner');
  if (runner === 'yes' || runner === 'no') s.runner = runner;
  const recorded = one('recorded');
  if (recorded === 'same' || recorded === 'differs') s.recorded = recorded;
  // a stop's time is kept only when it reads as one (the device wrote it; a job could have)
  const asked = one('stop.asked_at');
  const askedAt = asked && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/.test(asked) ? asked : undefined;
  const signals = one('stop.signals');
  if (asked || signals) s.stop = { ...(askedAt ? { asked_at: askedAt } : {}), signals: (signals ?? '').split(/\s+/).filter((x) => /^[A-Za-z]+$/.test(x)) };
  if (tail.length) s.tail = tail;
  return s;
}

/**
 * The job's first process, recorded once: the device showed it running (its start time the one it recorded, or none to
 * check) and ps there showed it running this job's supervisor. Never from a status read that ps did not back.
 */
function recordProcess(j: RemoteJobRecord, s: RemoteStatus): void {
  if (j.process || s.runner !== 'yes' || s.pid === undefined || s.pgid === undefined) return;
  j.process = { pid: s.pid, pgid: s.pgid, pid_start: s.pid_start ?? '', recorded_at: s.read_at };
}

/** What a status read means for the record: its state, words for a stop, when the device was last seen. */
function applyStatus(j: RemoteJobRecord, read: RemoteStatus): void {
  const before = j.state;
  j.last_seen = read.read_at;
  // a folder whose owner file holds another nonce is another job's: nothing in it is this one's (as if it had no folder)
  const s: RemoteStatus = read.owner === 'other' ? { read_at: read.read_at, where: 'absent', owner: 'other' } : read;
  if ((before === 'ended' || before === 'stopped') && s.where !== 'status') {
    // a known end stays known: the folder that held its status is gone from the device (removed there since)
    event(j, `${j.device} has ${s.owner === 'other' ? 'another job\'s folder' : s.where === 'absent' ? 'no folder' : 'no status'} for this job any more; its recorded end stands`);
    return;
  }
  const was = j.remote;
  j.remote = s;
  delete j.unknown;
  if (s.where === 'status' && j.process && s.recorded === 'differs' && was?.recorded !== 'differs') {
    event(j, `its status file on ${j.device} now names another process than the one Timmy recorded when it started (pid ${j.process.pid}): a stop will not signal while they differ`);
  }
  if (s.where === 'status' && !j.process && s.runner === 'no' && was?.runner !== 'no') {
    event(j, `the process its status file names (pid ${s.pid ?? 'none'}) is not this job's supervisor as ps on ${j.device} shows it: Timmy recorded no process for it, and a stop will not signal`);
  }
  if (s.where === 'absent' || s.where === 'not started' || s.where === 'claimed') {
    if (j.confirmed_at) {
      j.state = 'unknown';
      j.unknown = { since: s.read_at, why: `${j.device} answered, and has ${s.owner === 'other' ? 'another job\'s folder' : s.where === 'absent' ? 'no folder' : 'no status'} for this job any more`, not_known: 'what became of the run it confirmed earlier' };
    } else j.state = 'submitted';
  } else if (s.state === 'running' && (s.alive === 'yes' || s.alive === 'unchecked')) {
    j.confirmed_at ??= s.read_at;
    recordProcess(j, s);
    j.state = j.stop && !j.stop.confirmed_at ? 'stop asked' : 'running';
    if (j.stop && !j.stop.confirmed_at) j.stop.words = s.stop?.asked_at ? `the device recorded the stop (${s.stop.asked_at}, ${s.stop.signals.join(' ') || 'no signal'}) and the job still runs` : 'the stop never reached the device: the job still runs there';
  } else if (s.state === 'running') {
    j.confirmed_at ??= s.read_at;
    j.state = 'ended';
    if (j.stop && !j.stop.confirmed_at) j.stop.result = s.alive === 'reused' ? 'its pid now belongs to another process, which was not signalled' : 'its process was gone when the device was read';
  } else if (s.state === 'ended') {
    j.confirmed_at ??= s.read_at;
    const byStop = Boolean(s.stop_signal) || s.by === 'stop';
    if (j.stop && byStop) {
      j.state = 'stopped';
      j.stop.confirmed_at ??= s.read_at;
      j.stop.result = exitWords(s);
      j.stop.words = 'confirmed by its status file';
    } else {
      j.state = 'ended';
      if (j.stop && !j.stop.confirmed_at) j.stop.result = 'it had ended by itself before the stop reached it';
    }
  }
  if (j.state !== before) event(j, `${before} → ${j.state}: ${jobWords(j)}`);
}

/** The device did not answer: a job that may run goes unknown (since, why, what is not known); a known end stays. */
function applyFailure(j: RemoteJobRecord, f: SshFailure, during: string): void {
  const at = new Date().toISOString();
  if (j.state === 'ended' || j.state === 'stopped') { event(j, `${during}: ${f.words}`, at); return; }
  if (j.state === 'submitted' && !j.unknown && f.notSent) { event(j, `${during}: ${f.words}`, at); return; }
  if (j.state === 'stop asked') {
    j.stop = { ...(j.stop ?? { asked_at: at }), words: `not confirmed: ${f.words}` };
    event(j, `${during}: ${f.words}`, at);
    return;
  }
  const before = j.state;
  j.state = 'unknown';
  j.unknown = { since: j.unknown?.since ?? at, why: f.words, not_known: j.confirmed_at ? 'whether it still runs, and how it ended if it did' : 'whether the device received it and started it' };
  if (before !== 'unknown') event(j, `${before} → unknown (${during}): ${f.words}`, at);
}

/** Once the device has confirmed the run, the kept copy of its script is no longer needed (a retry never sends it again). */
function forgetCopy(p: ConnectPaths, j: RemoteJobRecord): void {
  if (j.confirmed_at) { try { unlinkSync(scriptCopy(p, j.id)); } catch { /* already gone */ } }
}

function deviceOf(p: ConnectPaths, j: RemoteJobRecord): DeviceRecord {
  const found = findDevice(p, j.device);
  if (!found.device) throw new Error(`the job's device ${j.device} is not in Timmy's devices any more`);
  return found.device;
}

const familyOf = (d: DeviceRecord): 'posix' | 'powershell' => (d.os === 'windows' || d.shell === 'cmd' || d.shell === 'powershell' ? 'powershell' : 'posix');

/** Reads a job's status on its device (the PowerShell or POSIX status script). */
async function readRemote(p: ConnectPaths, d: DeviceRecord, j: RemoteJobRecord): Promise<{ status?: RemoteStatus; failure?: SshFailure }> {
  let r;
  try {
    r = familyOf(d) === 'posix'
      ? await callSsh(d, p, POSIX_WORDS, { input: posixStatusScript(d.remote_dir, j.id, j), timeoutMs: 60_000 })
      : await callSsh(d, p, powershellWords(windowsStatusScript(d.remote_dir, j.id, j)), { timeoutMs: 60_000 });
  } catch (e) { return { failure: { outcome: 'error', words: `nothing was sent: ${(e as Error).message}`, ssh: '', notSent: true } }; }
  const f = classifySsh(r, d, 'TIMMY-STATUS-BEGIN');
  if (f) { noteFailure(p, d, f); return { failure: f }; }
  const status = parseStatus(r.stdout.toString('utf8'));
  return status ? { status } : { failure: { outcome: 'error', words: 'the device answered without a status block', ssh: '', notSent: false } };
}

export interface JobOutcome {
  job: RemoteJobRecord; words: string; failure?: SshFailure; answered: boolean;
  /** the device answered and did not do what was asked (a job it would not start), in words */
  refused?: string;
  /** the device answered that the job's id is taken there: its folder holds another job (nothing in it was changed) */
  taken?: boolean;
}

/** `timmy connect status <job>`: the device's status file is read before anything is said. */
export async function reconcileJob(p: ConnectPaths, id: string): Promise<JobOutcome | { error: string }> {
  const j = readJob(p, id);
  if (!j) return { error: `no remote job ${JSON.stringify(id)}: timmy connect jobs lists them` };
  let d: DeviceRecord;
  try { d = deviceOf(p, j); } catch (e) { return { error: (e as Error).message }; }
  const r = await readRemote(p, d, j);
  const job = updateJob(p, id, (x) => { if (r.status) applyStatus(x, r.status); else applyFailure(x, r.failure!, 'status read'); });
  forgetCopy(p, job);
  return { job, words: jobWords(job), ...(r.failure ? { failure: r.failure } : {}), answered: Boolean(r.status) };
}

export interface RunSpec { command?: string[]; scriptFile?: string }

/** Why a device cannot take a job now (nothing is sent), or null. */
function cannotRun(d: DeviceRecord): string | null {
  if (!d.host_key) return `${d.id}'s host key is not confirmed: timmy connect trust ${d.id} SHA256:<…> first; nothing was sent`;
  if (d.host_key_refused) return `${d.id}'s host key changed and Timmy refuses it (${d.host_key_refused.words}); nothing was sent`;
  if (!d.probe || d.probe.outcome !== 'connected' || !d.probe.facts) return `${d.id} has not answered a probe yet: timmy connect probe ${d.id} first (it says whether jobs can detach there); nothing was sent`;
  if (d.probe.facts.detach === 'none') return `${d.id} has no way to detach a job from the SSH session (no setsid, no perl): Timmy will not start a job there; nothing was sent`;
  if (d.probe.facts.job_folder === 'not writable' || d.probe.facts.job_folder === 'absent, cannot be made') return `${d.id}'s job folder ${d.remote_dir} ${d.probe.facts.job_folder} (last probe): nothing was sent`;
  return null;
}

/** Sends a job (or sends it again with the same id and bytes): the device starts it only once. */
async function submit(p: ConnectPaths, d: DeviceRecord, j: RemoteJobRecord, bytes: Buffer): Promise<JobOutcome> {
  let r;
  let status: RemoteStatus | undefined;
  let failure: SshFailure | undefined;
  let answer = '';
  try {
    if (familyOf(d) === 'posix') {
      r = await callSsh(d, p, POSIX_WORDS, { input: posixSubmitScript(d.remote_dir, j.id, bytes, j.script.sha256, j.nonce), timeoutMs: 120_000 });
      failure = classifySsh(r, d, 'TIMMY-SUBMIT') ?? undefined;
      answer = r.stdout.toString('utf8');
      status = failure ? undefined : parseStatus(answer) ?? undefined;
    } else {
      r = await callSsh(d, p, powershellWords(windowsSubmitScript(d.remote_dir, j.id, j.script.sha256, j.nonce)), { input: windowsSubmitInput(bytes), timeoutMs: 120_000 });
      failure = classifySsh(r, d, 'TIMMY-SUBMIT') ?? undefined;
      answer = r.stdout.toString('utf8');
      const word = /^TIMMY-SUBMIT (\S+)/m.exec(answer)?.[1];
      if (!failure && (word === 'started' || word === 'already-started')) { const s = await readRemote(p, d, j); status = s.status; failure = s.failure; }
    }
  } catch (e) {
    failure = { outcome: 'error', words: (e as Error).message, ssh: '', notSent: true };
  }
  const said = /^TIMMY-SUBMIT (\S+)(.*)$/m.exec(answer);
  if (!failure && (said?.[1] === 'started' || said?.[1] === 'already-started') && !status) {
    // the device said so, and its answer was cut off before the status came: unknown until a status read
    failure = { outcome: 'unreachable', why: 'closed', words: `${d.id} said the run ${said[1] === 'started' ? 'started' : 'had started'}, and its answer ended before its status came`, ssh: '', notSent: false };
  }
  if (failure) noteFailure(p, d, failure);
  let refused: string | undefined;
  const job = updateJob(p, j.id, (x) => {
    if (failure) {
      applyFailure(x, failure, 'submission');
      if (failure.notSent && x.state === 'submitted') x.unknown = undefined;
      return;
    }
    const word = said?.[1] ?? 'none';
    if (word === 'started' || word === 'already-started') {
      event(x, word === 'started' ? `started on ${x.device} (${said?.[2].trim()})` : `already started on ${x.device}: this submission started nothing (${said?.[2].trim()})`);
      if (status) applyStatus(x, status);
    } else {
      const why: Record<string, string> = {
        'no-folder': `the job folder ${d.remote_dir} could not be made there`,
        'not-written': 'the script could not be written there',
        'sha256-differs': `the script's sha256 there differs from Timmy's (${said?.[2].trim()}): it was not started`,
        'no-detach': 'there is no way to detach a job there (no setsid, no perl): it was not started',
        'id-taken': `the id ${x.id} is taken on ${x.device} by another job's folder (made by another Timmy, or before this record; nothing in it was changed): run it again as a new job`,
      };
      x.last_seen = new Date().toISOString();
      refused = `not started: ${why[word] ?? `the device answered ${JSON.stringify(word)}`}`;
      event(x, refused);
    }
  });
  forgetCopy(p, job);
  const words = failure
    ? (failure.notSent && job.state === 'submitted' ? `not sent: ${failure.words}` : jobWords(job))
    : refused ?? jobWords(job);
  return { job, words, ...(failure ? { failure } : {}), ...(refused ? { refused } : {}), ...(!failure && said?.[1] === 'id-taken' ? { taken: true } : {}), answered: !failure };
}

/** `timmy connect run`: a new job on a device, from command words or a script file. */
export async function runJob(p: ConnectPaths, deviceId: string, spec: RunSpec): Promise<JobOutcome | { error: string }> {
  const found = findDevice(p, deviceId);
  if (!found.device) return { error: found.error ?? `no device ${deviceId}` };
  const d = found.device;
  const no = cannotRun(d);
  if (no) return { error: no };
  const family = familyOf(d);
  let bytes: Buffer;
  let from: 'command' | 'file';
  let label: string;
  let name: string | undefined;
  if (spec.scriptFile) {
    const file = path.resolve(expandHome(spec.scriptFile));
    try {
      const st = statSync(file);
      if (!st.isFile()) return { error: `${spec.scriptFile} is not a file` };
      if (st.size > MAX_SCRIPT) return { error: `${spec.scriptFile} is ${st.size} bytes, past Timmy's ${MAX_SCRIPT} for a script` };
      bytes = readFileSync(file);
    } catch { return { error: `${spec.scriptFile} could not be read` }; }
    from = 'file';
    name = path.basename(file);
    label = `script ${name}`;
  } else if (spec.command?.length) {
    bytes = Buffer.from(family === 'posix' ? posixCommandScript(spec.command) : windowsCommandScript(spec.command), 'utf8');
    from = 'command';
    // the words as one would type them (a word with a space or a shell character quoted), scrubbed
    label = scrubShown(spec.command.map((w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : shQuote(w))).join(' ')).slice(0, 160);
  } else return { error: 'nothing to run: give -- <command…> or --script <file>' };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // an id whose folder on the device holds another job is not this job's: a new one is drawn (three draws at most)
  const taken: string[] = [];
  const takenWords = (id: string): string => taken.map((t) => `the id ${t} was taken on ${d.id} by another job's folder (left as it is): this job is ${id}`).join('; ');
  for (;;) {
    const now = new Date().toISOString();
    const j = claimId(p, (id) => ({
      id, kind: 'remote', label, device: d.id, remote_dir: `${d.remote_dir}/${id}`,
      script: { sha256, bytes: bytes.length, from, ...(name ? { name } : {}), shell: family },
      nonce: randomBytes(16).toString('hex'),
      state: 'submitted', submitted_at: now,
      events: [...(taken.length ? [{ at: now, what: takenWords(id) }] : []), { at: now, what: `submitted to ${d.id}: ${label} (sha256 ${sha256.slice(0, 12)})` }],
    }));
    writePrivate(scriptCopy(p, j.id), bytes);
    const r = await submit(p, d, j, bytes);
    if (!r.taken || taken.length >= 2) return taken.length ? { ...r, words: `${takenWords(r.job.id)}; ${r.words}` } : r;
    // this record never reached the device (the folder there is another job's, and was left as it is): its two files here,
    // made by this call, go with it
    taken.push(j.id);
    for (const f of [jobFile(p, j.id), scriptCopy(p, j.id)]) { try { unlinkSync(f); } catch { /* gone */ } }
  }
}

/**
 * `timmy connect retry <job>`: reads the device's status first; sends the job again (the same id and bytes) only when the
 * device has no started run of it. A run the device claimed is never started again.
 */
export async function retryJob(p: ConnectPaths, id: string): Promise<JobOutcome | { error: string }> {
  const read = await reconcileJob(p, id);
  if ('error' in read) return read;
  if (!read.answered) return { ...read, words: `not sent again: ${read.failure?.words ?? 'the device did not answer'}; ${read.words}` };
  const j = read.job;
  if (j.remote?.where === 'status' || j.remote?.where === 'claimed' || j.confirmed_at) return { ...read, words: `not sent again: ${j.device} has this run already. ${read.words}` };
  let bytes: Buffer;
  try { bytes = readFileSync(scriptCopy(p, id)); } catch { return { error: `the copy of ${id}'s script that Timmy kept is gone, so it cannot be sent again as it was` }; }
  if (createHash('sha256').update(bytes).digest('hex') !== j.script.sha256) return { error: `the kept copy of ${id}'s script no longer has the recorded sha256: it is not sent` };
  return submit(p, deviceOf(p, j), j, bytes);
}

/**
 * Waits for a job's end with one ssh call that the device answers every 2 s. A Ctrl-C (signal) stops only the local ssh:
 * the job is not touched, and the words say so with the command that stops it. A dropped connection leaves it unknown.
 * The local ssh runs in a process group of its own, so a terminal's Ctrl-C reaches Timmy alone, which then stops it.
 */
export async function waitJob(p: ConnectPaths, id: string, o: { signal?: AbortSignal; onRunning?: (at: string) => void; onChild?: (pid: number | undefined) => void } = {}): Promise<JobOutcome & { end: 'ended' | 'not running' | 'interrupted' | 'dropped' } | { error: string }> {
  const j = readJob(p, id);
  if (!j) return { error: `no remote job ${JSON.stringify(id)}` };
  let d: DeviceRecord;
  try { d = deviceOf(p, j); } catch (e) { return { error: (e as Error).message }; }
  let text = '';
  let seen: string | undefined;
  const onStdout = (chunk: Buffer): void => {
    text += chunk.toString('utf8');
    for (const m of text.matchAll(/^TIMMY-WAIT running (\S+)\r?$/gm)) { if (m[1] !== seen) { seen = m[1]; o.onRunning?.(seen); } }
    if (text.length > 1 << 20) text = text.slice(-(1 << 16));
  };
  const script = familyOf(d) === 'posix' ? posixWaitScript(d.remote_dir, id, j) : undefined;
  let r;
  try {
    r = script
      ? await callSsh(d, p, POSIX_WORDS, { input: script, timeoutMs: WAIT_MS, onStdout, ownGroup: true, ...(o.signal ? { signal: o.signal } : {}), onChild: (c) => o.onChild?.(c.pid) })
      : await callSsh(d, p, powershellWords(windowsWaitScript(d.remote_dir, id, j)), { timeoutMs: WAIT_MS, onStdout, ownGroup: true, ...(o.signal ? { signal: o.signal } : {}), onChild: (c) => o.onChild?.(c.pid) });
  } catch (e) { return { error: `not waited: nothing was sent: ${(e as Error).message}` }; }
  if (r.aborted || o.signal?.aborted) {
    const job = updateJob(p, id, (x) => { if (seen) x.last_seen = new Date().toISOString(); event(x, 'the local wait was stopped (Ctrl-C): only the local ssh was stopped; the remote job was not'); });
    return { job, end: 'interrupted', answered: Boolean(seen), words: `stopped waiting: only the local ssh was stopped. The remote job ${id} was not stopped${job.state === 'running' ? ` and was running when last read (${seen ?? job.remote?.read_at ?? 'unknown'})` : ''}; to stop it: timmy connect stop ${id}` };
  }
  const end = r.stdout.length ? r.stdout.toString('utf8') : text;
  const waited = /^TIMMY-WAIT end\r?$/m.test(end);
  let status = waited && script ? parseStatus(end) : null;
  let later: SshFailure | undefined;
  if (waited && !script) {
    // Windows: the wait's answer has no status lines (cmd.exe's line limit); a call of its own reads it
    const s = await readRemote(p, d, j);
    status = s.status ?? null;
    later = s.failure;
  }
  if (!status) {
    const f = later ?? classifySsh(r, d, 'TIMMY-WAIT end') ?? { outcome: 'unreachable' as const, why: 'closed' as const, words: 'the connection ended while Timmy waited', ssh: '', notSent: false };
    noteFailure(p, d, f);
    const job = updateJob(p, id, (x) => { if (seen) x.last_seen = new Date().toISOString(); applyFailure(x, f, 'wait'); });
    return { job, end: 'dropped', failure: f, answered: false, words: `the wait ended without the job's end: ${f.words}. The remote job was not stopped by Timmy. ${jobWords(job)}; timmy connect status ${id} reads it again` };
  }
  const job = updateJob(p, id, (x) => applyStatus(x, status));
  forgetCopy(p, job);
  // the wait ends when the job has ended, or when it was never running there (no claim: nothing to wait for)
  return { job, end: job.state === 'ended' || job.state === 'stopped' ? 'ended' : 'not running', answered: true, words: jobWords(job) };
}

/**
 * `timmy connect stop <job>`: the device signals the job's process group only after checking that its status file still
 * names the first process Timmy recorded, that this process has the recorded start time (a reused pid is never signalled)
 * and leads the recorded group, and that ps shows it running this job's supervisor; then it reads its status back. When
 * the device does not answer, the record says the stop was asked and not confirmed.
 */
export async function stopJob(p: ConnectPaths, id: string): Promise<JobOutcome | { error: string }> {
  const j0 = readJob(p, id);
  if (!j0) return { error: `no remote job ${JSON.stringify(id)}` };
  if (j0.state === 'ended' || j0.state === 'stopped') return { job: j0, answered: false, words: `nothing to stop: ${jobWords(j0)}` };
  let d: DeviceRecord;
  try { d = deviceOf(p, j0); } catch (e) { return { error: (e as Error).message }; }
  const asked = new Date().toISOString();
  updateJob(p, id, (x) => { x.stop = { asked_at: asked, words: 'asked; no answer yet' }; x.state = 'stop asked'; event(x, 'stop asked'); });
  let answer = '';
  let failure: SshFailure | undefined;
  let status: RemoteStatus | undefined;
  try {
    // the device gets the process Timmy recorded as literals: it signals only that one's group, and only while its status
    // file still names it and ps there agrees (its start time, its group, its command line: this job's supervisor)
    if (familyOf(d) === 'posix') {
      const r = await callSsh(d, p, POSIX_WORDS, { input: posixStopScript(d.remote_dir, id, j0), timeoutMs: 120_000 });
      failure = classifySsh(r, d, 'TIMMY-STOP') ?? undefined;
      answer = r.stdout.toString('utf8');
      if (!failure) status = parseStatus(answer) ?? undefined;
    } else {
      const r = await callSsh(d, p, powershellWords(windowsStopScript(d.remote_dir, id, j0)), { timeoutMs: 120_000 });
      failure = classifySsh(r, d, 'TIMMY-STOP') ?? undefined;
      answer = r.stdout.toString('utf8');
      if (!failure) { const s = await readRemote(p, d, j0); status = s.status; failure = s.failure; }
    }
  } catch (e) { failure = { outcome: 'error', words: (e as Error).message, ssh: '', notSent: true }; }
  if (failure) noteFailure(p, d, failure);
  const said = /^TIMMY-STOP (\S+)(.*)$/m.exec(answer)?.[1];
  const NOT_SIGNALLED: Record<string, string> = {
    gone: 'its first process was already gone (nothing was signalled)',
    reused: 'its pid now belongs to another process, which was not signalled',
    'status-differs': 'its status file there no longer names the process Timmy recorded when the job started (its supervisor), so nothing was signalled',
    'not-runner': 'the process its status file names is not this job\'s supervisor as ps shows it there (sh <its folder>/run.sh; on Windows run.ps1), so nothing was signalled',
    'not-leader': 'its first process does not lead its own process group there (it was not detached as Timmy starts a job), so nothing was signalled',
    unreadable: 'its status file could not be read, so nothing was signalled',
    'no-start-time': 'no start time was recorded for it there (ps gave none), so that its pid is still the same process cannot be checked: nothing was signalled',
    absent: 'the device has no folder for this job: nothing was signalled',
    'no-status': 'the job has no status there yet: nothing was signalled',
    'already-ended': 'it had already ended',
  };
  const job = updateJob(p, id, (x) => {
    if (failure) { applyFailure(x, failure, 'stop'); return; }
    if (status) applyStatus(x, status);
    if (said && NOT_SIGNALLED[said] && x.stop) { x.stop.result = NOT_SIGNALLED[said]; if (x.state === 'stop asked') x.stop.words = NOT_SIGNALLED[said]; }
    if (said === 'done') event(x, `the device stopped it (${/signals=(.*)$/m.exec(answer)?.[1] ?? 'TERM'})`);
  });
  forgetCopy(p, job);
  const words = failure ? `stop asked ${asked}, not confirmed: ${failure.words}` : `${jobWords(job)}${job.stop?.result && job.state !== 'stopped' ? ` (stop: ${job.stop.result})` : ''}`;
  return { job, words, ...(failure ? { failure } : {}), answered: !failure };
}

export interface FetchOutcome { ok: boolean; words: string; job?: RemoteJobRecord; to?: string; partial?: string; sha256?: string; remote_sha256?: string; bytes?: number; receipt?: string; failure?: SshFailure }

/** A free path for the partial file next to `dest` (an earlier fetch's is never replaced). */
function partialFor(dest: string): string {
  let partial = `${dest}.partial`;
  for (let i = 0; existsSync(partial); i++) partial = `${dest}.${randomBytes(2).toString('hex')}.partial`;
  return partial;
}

/**
 * `timmy connect fetch <job> <path> [--to <local path>]`: only a path inside the job's folder (no "..", no absolute path,
 * no symbolic link on the device); the device's sha256, the bytes over the ssh channel, the local sha256. Equal: the file
 * (never over an existing one) and a receipt on the runs chain; different: kept as .partial and said failed.
 */
export async function fetchFile(p: ConnectPaths, id: string, rel: string, o: { to?: string; cwd?: string } = {}): Promise<FetchOutcome> {
  const bad = checkJobPath(rel);
  if (bad) return { ok: false, words: `not fetched: ${bad}` };
  const j = readJob(p, id);
  if (!j) return { ok: false, words: `no remote job ${JSON.stringify(id)}` };
  let d: DeviceRecord;
  try { d = deviceOf(p, j); } catch (e) { return { ok: false, words: (e as Error).message }; }
  const dest = o.to ? path.resolve(o.cwd ?? process.cwd(), expandHome(o.to)) : path.join(p.results, id, ...rel.split('/'));
  if (existsSync(dest)) return { ok: false, words: `not fetched: ${shown(dest)} exists, and Timmy does not replace a file: give another --to` };
  if (o.to) mkdirSync(path.dirname(dest), { recursive: true });
  else privateDir(path.dirname(dest));
  const partial = partialFor(dest);
  const fd = openSync(partial, 'wx', 0o600);
  const hash = createHash('sha256');
  let head = Buffer.alloc(0);
  let header: { sum: string; size: number } | null = null;
  let refusal: string | null = null;
  let bytes = 0;
  const onStdout = (chunk: Buffer): void => {
    if (refusal) return;
    if (!header) {
      head = Buffer.concat([head, chunk]);
      const text = head.toString('latin1');
      const at = text.search(/(^|\n)TIMMY-FETCH /);
      if (at < 0) { if (head.length > 65536) refusal = 'the device answered without a TIMMY-FETCH line'; return; }
      const start = text[at] === '\n' ? at + 1 : at;
      const nl = text.indexOf('\n', start);
      if (nl < 0) return;
      const line = text.slice(start, nl).replace(/\r$/, '');
      const m = /^TIMMY-FETCH ok ([0-9a-f]{64}) ([0-9]+)$/.exec(line);
      if (!m) { refusal = line.replace(/^TIMMY-FETCH /, ''); return; }
      header = { sum: m[1], size: Number(m[2]) };
      chunk = head.subarray(nl + 1);
      head = Buffer.alloc(0);
    }
    if (chunk.length) { writeSync(fd, chunk); hash.update(chunk); bytes += chunk.length; }
  };
  let r;
  try {
    r = familyOf(d) === 'posix'
      ? await callSsh(d, p, POSIX_WORDS, { input: posixFetchScript(d.remote_dir, id, rel), timeoutMs: 6 * 3600 * 1000, onStdout })
      : await callSsh(d, p, powershellWords(windowsFetchScript(d.remote_dir, id, rel)), { timeoutMs: 6 * 3600 * 1000, onStdout });
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(partial); } catch { /* not there */ }
    return { ok: false, words: `not fetched: ${(e as Error).message}` };
  } finally {
    try { closeSync(fd); } catch { /* closed above */ }
  }
  const sealed = (status: 'ok' | 'failed', sha: string, why?: string): string | undefined => {
    try {
      const rec = appendReceipt('runs', {
        kind: 'remote-fetch', subject: `remote-fetch · ${d.id} · ${id} · ${rel} · ${status === 'ok' ? 'sha256 equal' : 'failed'}`,
        policy: 'human-gated', status,
        job: { id, kind: 'remote', label: j.label, state: j.state },
        outputs: [{ path: shown(status === 'ok' ? dest : partial), sha256: sha, bytes }],
        sources: [{ device: d.id, job: id, path: rel, remote_sha256: header?.sum ?? null, remote_bytes: header?.size ?? null, via: 'ssh' }],
        ...(why ? { discrepancies: [why] } : {}),
      });
      return rec.hash.slice(7, 15);
    } catch { return undefined; }
  };
  if (!header) {
    const f = refusal ? null : classifySsh(r, d, 'TIMMY-FETCH');
    if (f) noteFailure(p, d, f);
    if (bytes === 0) { try { unlinkSync(partial); } catch { /* gone */ } }
    const REFUSED: Record<string, string> = {
      'no-job': `${d.id} has no folder for job ${id}`,
      'job-link': `the job's folder for ${id} on ${d.id} is a symbolic link: refused (the fetch is bounded by the real folder)`,
      link: `${rel} is or passes through a symbolic link on ${d.id}: refused`,
      changed: `${rel} changed on ${d.id} while it was being read (swapped for another file or a link): refused, nothing was sent`,
      'not-a-file': `${rel} is not a regular file in the job's folder`,
      'not-readable': `${rel} cannot be read there`,
      'no-identity': `${d.id} has no stat that can say what an open file is (GNU stat -c or BSD stat -f), so a swap could not be ruled out: refused`,
      'no-sha256': `${d.id} has no sha256 program (sha256sum, shasum, openssl), so its bytes could not be checked: refused`,
    };
    const why = refusal ? (REFUSED[refusal] ?? `the device said ${JSON.stringify(refusal)}`) : f?.words ?? 'the device sent no answer';
    return { ok: false, words: `not fetched: ${why}`, ...(f ? { failure: f } : {}) };
  }
  const local = hash.digest('hex');
  const h: { sum: string; size: number } = header;
  if (local !== h.sum || bytes !== h.size) {
    const why = `the device's sha256 ${h.sum.slice(0, 16)}… (${h.size} bytes) differs from the bytes received here, sha256 ${local.slice(0, 16)}… (${bytes} bytes)${r.code !== 0 ? `; ssh ended ${r.code === null ? `by ${r.signal ?? 'a signal'}` : `with exit ${r.code}`}` : ''}`;
    const receipt = sealed('failed', local, why);
    return { ok: false, words: `fetch failed: ${why}; the bytes received are kept as ${shown(partial)} and nothing else was written`, partial: shown(partial), sha256: local, remote_sha256: h.sum, bytes, ...(receipt ? { receipt } : {}) };
  }
  try { linkSync(partial, dest); unlinkSync(partial); } catch {
    return { ok: false, words: `fetched and checked, but ${shown(dest)} appeared meanwhile: the file is kept as ${shown(partial)}`, partial: shown(partial), sha256: local, remote_sha256: h.sum, bytes };
  }
  const receipt = sealed('ok', local);
  const at = new Date().toISOString();
  const job = updateJob(p, id, (x) => {
    x.fetched = [...(x.fetched ?? []), { path: rel, to: shown(dest), sha256: local, bytes, ...(receipt ? { receipt } : {}), at }].slice(-50);
    event(x, `fetched ${rel} (${bytes} bytes, sha256 ${local.slice(0, 12)}) to ${shown(dest)}`);
  });
  return { ok: true, job, to: shown(dest), sha256: local, remote_sha256: h.sum, bytes, ...(receipt ? { receipt } : {}), words: `fetched ${rel} from ${d.id}: ${bytes} bytes, sha256 ${local} equal on both computers; saved as ${shown(dest)}${receipt ? `; receipt ${receipt}` : ''}` };
}
