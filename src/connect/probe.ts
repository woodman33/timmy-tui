/**
 * Round R4 (helper H90): `timmy connect probe <id>`: connect, and learn what the device is (its operating system,
 * architecture, user and shell family), whether its job folder can be written, and which programs of a fixed list are on
 * its PATH. "Found on PATH" is all that is said of a program: a working connection does not prove CAD, rendering, GPU
 * acceleration or native application support (the owner's order); each of those is proven by a run of its own.
 *
 * Two steps. First a line every shell answers differently (`echo TIMMY-PROBE %OS%`: cmd.exe expands %OS% to Windows_NT,
 * PowerShell prints each word on its own line, a POSIX shell prints it as it is), so a Windows device is recognised from
 * its answer and never assumed. Then the probe of that family: a POSIX sh script on stdin, or a PowerShell script as an
 * encoded command. Words and JSON tell apart: unreachable (timed out, refused, no route, name not resolved), host key not
 * confirmed or changed, authentication refused, and connected.
 */
import { POSIX_PROGRAMS, posixProbeScript } from './remote-posix.js';
import { DETECT_WORDS, detectShell, windowsProbeScript } from './remote-windows.js';
import { POSIX_WORDS, powershellWords } from './shells.js';
import { callSsh, classifySsh, type SshFailure } from './ssh.js';
import { scrubShown } from './scrub.js';
import { ensureConnect, findDevice, patchDevice, type ConnectPaths } from './store.js';
import type { DeviceOs, DeviceProbe, DeviceRecord, ProbeFacts, ShellFamily } from './types.js';

/** The key=value lines between a script's BEGIN and END markers; null unless both came (an answer cut off is not read). */
export function keyValues(text: string, begin: string, end: string): Array<[string, string]> | null {
  const lines = text.replace(/\r/g, '').split('\n');
  const from = lines.findIndex((l) => l.trim() === begin);
  if (from < 0) return null;
  const to = lines.findIndex((l, i) => i > from && l.trim() === end);
  if (to < 0) return null;
  return lines.slice(from + 1, to).flatMap((l) => {
    const at = l.indexOf('=');
    return at > 0 ? [[l.slice(0, at).trim(), l.slice(at + 1).trim()] as [string, string]] : [];
  });
}

const JOB_FOLDER = new Set(['writable', 'not writable', 'absent, can be made', 'absent, cannot be made']);

/** A probe's answer (POSIX or PowerShell) as facts; null when its markers are not there. */
export function parseProbe(answer: string): { family: 'posix' | 'powershell'; os: DeviceOs; facts: ProbeFacts; startTime: boolean } | null {
  const kv = keyValues(answer, 'TIMMY-PROBE-BEGIN', 'TIMMY-PROBE-END');
  if (!kv) return null;
  const one = (k: string): string | undefined => kv.find(([key]) => key === k)?.[1] || undefined;
  const family = one('family') === 'powershell' ? 'powershell' : 'posix';
  const osName = one('os_name');
  const os: DeviceOs = family === 'powershell' || /^windows/i.test(osName ?? '') ? 'windows' : osName === 'Darwin' ? 'macos' : osName === 'Linux' ? 'linux' : 'unknown';
  const folder = one('job_folder');
  const detach = one('detach');
  const scrub = (v: string | undefined): string | undefined => (v === undefined ? undefined : scrubShown(v).slice(0, 120));
  const facts: ProbeFacts = {
    ...(osName ? { os_name: scrub(osName) } : {}),
    ...(one('macos_version') ?? one('os_version') ? { os_version: scrub(one('macos_version') ?? one('os_version')) } : {}),
    ...(one('arch') ? { arch: scrub(one('arch')) } : {}),
    ...(one('user') ? { user: scrub(one('user')) } : {}),
    ...(one('login_shell') ? { login_shell: scrub(one('login_shell')) } : {}),
    job_folder: folder && JOB_FOLDER.has(folder) ? folder as ProbeFacts['job_folder'] : 'unknown',
    ...(detach === 'setsid' || detach === 'perl' || detach === 'wmi' || detach === 'none' ? { detach } : {}),
    ...(one('sha256') ? { sha256: scrub(one('sha256')) } : {}),
    found_on_path: kv.filter(([k]) => k === 'found').map(([, v]) => v).filter((v) => /^[A-Za-z0-9._-]+$/.test(v)),
    not_found_on_path: kv.filter(([k]) => k === 'missing').map(([, v]) => v).filter((v) => /^[A-Za-z0-9._-]+$/.test(v)),
  };
  return { family, os, facts, startTime: one('start_time') === 'yes' };
}

const OS_WORD: Record<DeviceOs, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows', unknown: 'an unknown system' };

/** A connected probe in one sentence: what it is, the job folder, how a job detaches, what is on PATH (and what that means). */
export function probeWords(d: Pick<DeviceRecord, 'id' | 'shell' | 'os'>, facts: ProbeFacts, startTime = true): string {
  const what = `${OS_WORD[d.os]}${facts.os_version ? ` ${facts.os_version}` : ''}${facts.arch ? ` ${facts.arch}` : ''}`;
  const shell = d.shell === 'posix' ? `POSIX sh (login shell ${facts.login_shell || 'unknown'})` : d.shell === 'cmd' ? 'cmd.exe (PowerShell sent encoded)' : d.shell === 'powershell' ? 'PowerShell' : 'unknown';
  const detach = facts.detach === 'setsid' ? 'jobs detach with setsid' : facts.detach === 'perl' ? 'jobs detach with perl\'s setsid' : facts.detach === 'wmi' ? 'jobs would start through WMI (not run on Windows yet)' : 'no way to detach a job was found (no setsid, no perl): Timmy will not start jobs there';
  const found = facts.found_on_path.length ? `found on PATH: ${facts.found_on_path.join(', ')}` : 'none of Timmy\'s list found on PATH';
  return `connected: ${what}, user ${facts.user ?? 'unknown'}, shell ${shell}; job folder ${facts.job_folder ?? 'unknown'}; ${detach}`
    + `${facts.sha256 && facts.sha256 !== 'none' ? `; sha256 by ${facts.sha256}` : '; no sha256 program found (fetch will refuse)'}`
    + `${startTime ? '' : '; ps gives no start time there (a stop will refuse to signal)'}`
    + `; ${found} (found on PATH only: not proven supported or working)`;
}

/** Records what a failed contact means for a device: a changed host key is kept as a refusal, never re-pinned. */
export function noteFailure(p: ConnectPaths, d: DeviceRecord, f: SshFailure): void {
  if (f.outcome !== 'host-key-changed') return;
  patchDevice(p, d.id, (x) => { x.host_key_refused = { at: new Date().toISOString(), ...(f.offered ? { offered: f.offered } : {}), words: f.words }; });
}

export interface ProbeResult { device: DeviceRecord; probe: DeviceProbe; failure?: SshFailure; ssh?: string }

export async function probeDevice(p: ConnectPaths, id: string): Promise<ProbeResult | { error: string }> {
  ensureConnect(p);
  const found = findDevice(p, id);
  if (!found.device) return { error: found.error ?? `no device ${id}` };
  const d = found.device;
  const at = new Date().toISOString();
  const fail = (f: SshFailure): ProbeResult => {
    noteFailure(p, d, f);
    const probe: DeviceProbe = { at, outcome: f.outcome, ...(f.why ? { why: f.why } : {}), words: f.words };
    const device = patchDevice(p, id, (x) => { x.probe = probe; }) ?? d;
    return { device, probe, failure: f, ...(f.ssh ? { ssh: f.ssh } : {}) };
  };
  let detected: ShellFamily;
  let r;
  try {
    const first = await callSsh(d, p, DETECT_WORDS, { timeoutMs: 60_000 });
    const failed = classifySsh(first, d, 'TIMMY-PROBE');
    if (failed) return fail(failed);
    detected = detectShell(first.stdout.toString('utf8'));
    if (detected === 'unknown') {
      return fail({ outcome: 'error', words: 'connected, but the device\'s shell answered in a way Timmy does not know (neither POSIX, cmd.exe nor PowerShell)', ssh: '', notSent: false });
    }
    r = detected === 'posix'
      ? await callSsh(d, p, POSIX_WORDS, { input: posixProbeScript(d.remote_dir), timeoutMs: 60_000 })
      : await callSsh(d, p, powershellWords(windowsProbeScript(d.remote_dir)), { timeoutMs: 60_000 });
  } catch (e) {
    return fail({ outcome: 'error', words: (e as Error).message, ssh: '', notSent: true });
  }
  const failed = classifySsh(r, d, 'TIMMY-PROBE-BEGIN');
  if (failed) return fail(failed);
  const parsed = parseProbe(r.stdout.toString('utf8'));
  if (!parsed) return fail({ outcome: 'error', words: 'connected, but the probe\'s answer had no TIMMY-PROBE lines', ssh: '', notSent: false });
  const shell: ShellFamily = detected;
  const device = patchDevice(p, id, (x) => {
    x.os = parsed.os;
    x.shell = shell;
    x.probe = { at, outcome: 'connected', words: probeWords({ id, shell, os: parsed.os }, parsed.facts, parsed.startTime), facts: parsed.facts };
  }) ?? d;
  return { device, probe: device.probe! };
}

export { POSIX_PROGRAMS };
