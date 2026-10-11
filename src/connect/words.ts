/**
 * Round R4 (helper H90): the words for a device and a remote job, in one place, so `timmy connect … --json`, the REPL's
 * `/connect` and readConnect (God's Eye View) say the same state the same way. Each word says what is known and how:
 * "running" is what the device's status file said at a named time; "unknown" says since when, why, and what is not known.
 */
import type { DeviceRecord, RemoteJobRecord, RemoteStatus } from './types.js';

const SIGNALS: Record<number, string> = { 1: 'HUP', 2: 'INT', 3: 'QUIT', 6: 'ABRT', 9: 'KILL', 13: 'PIPE', 14: 'ALRM', 15: 'TERM' };

/** "2026-10-11 09:24 UTC" from an ISO time; anything else as it is. */
export function when(iso: string | undefined): string {
  if (!iso) return 'at an unknown time';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : `${t.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** How a job's end reads: its exit, or the signal its stop sent, said as the device's shell reported it. */
export function exitWords(s: RemoteStatus | undefined): string {
  if (!s || s.state !== 'ended') return 'not ended';
  const code = s.exit_status;
  if (s.by === 'stop') return `ended by its stop with SIGKILL${s.stop?.signals.length ? ` (signals sent: ${s.stop.signals.join(', ')})` : ''}; no exit status was recorded`;
  if (code === undefined || code === null) return 'ended; no exit status was recorded';
  if (code === 0) return 'exit 0';
  if (code > 128 && code - 128 < 65) {
    const sig = SIGNALS[code - 128] ?? `${code - 128}`;
    return s.stop_signal
      ? `stopped: its supervisor received SIG${s.stop_signal}, and the job ended with status ${code} (a shell's report of a death by SIG${sig})`
      : `exit status ${code} (a shell reports a death by SIG${sig} so; it may also have exited with that code)`;
  }
  return `exit ${code}`;
}

/** One job's state in words: the same sentence in the CLI, the REPL and readConnect. */
export function jobWords(j: RemoteJobRecord): string {
  const on = `on ${j.device}`;
  const s = j.remote;
  switch (j.state) {
    case 'submitted':
      return s?.where === 'claimed'
        ? `submitted ${on} ${when(j.submitted_at)}: claimed there, and its supervisor wrote no status (read ${when(s.read_at)}); Timmy will not start it again`
        : `submitted ${on} ${when(j.submitted_at)}, not confirmed by ${j.device}${j.unknown ? `: ${j.unknown.why}` : s ? ` (read ${when(s.read_at)}: ${s.where === 'absent' ? 'no folder for it there' : 'its folder is there, not started'})` : ''}`;
    case 'running':
      return `running ${on}: its status file said so ${when(s?.read_at)}${s?.started_at ? ` (started ${when(s.started_at)})` : ''}${s?.alive === 'unchecked' ? '; ps gave no start time there, so that it is the same process is not checked (a stop will refuse to signal)' : ''}`;
    case 'ended':
      return s?.state === 'ended'
        ? `ended ${on} ${when(s.ended_at)}: ${exitWords(s)}`
        : `ended ${on}: its process is gone and it recorded no end (read ${when(s?.read_at)}; it was killed, or the computer restarted)`;
    case 'stopped':
      return `stopped ${on}: ${exitWords(s)}; confirmed by its status file ${when(j.stop?.confirmed_at ?? s?.read_at)}`;
    case 'stop asked':
      return `stop asked ${when(j.stop?.asked_at)}, not confirmed: ${j.stop?.words ?? 'no answer yet'}`;
    case 'unknown':
      return `unknown since ${when(j.unknown?.since)}: ${j.unknown?.why ?? `${j.device} did not answer`}; last seen ${j.last_seen ? when(j.last_seen) : 'never'}${j.remote?.state ? ` (then ${j.remote.state})` : ''}; not known: ${j.unknown?.not_known ?? 'whether it still runs'}`;
  }
}

/** What a person is needed for on a device, if anything (a host key to confirm, a changed key, a refused key). */
export function deviceNeeds(d: DeviceRecord): string[] {
  const needs: string[] = [];
  if (d.host_key_refused) needs.push(`its host key changed (${when(d.host_key_refused.at)}${d.host_key_refused.offered ? `: it offered ${d.host_key_refused.offered}` : ''}); Timmy refuses it: check the computer, then timmy connect scan ${d.id} and timmy connect trust ${d.id} SHA256:<new>`);
  else if (!d.host_key) needs.push(d.host_key_scan?.keys.length ? `a host key to confirm: timmy connect trust ${d.id} SHA256:<…> (fetched: ${d.host_key_scan.keys.map((k) => `${k.type} ${k.fingerprint}`).join(', ')})` : `no host key fetched yet: timmy connect scan ${d.id}`);
  if (d.probe?.outcome === 'auth-refused') needs.push(`its key was refused (${when(d.probe.at)}): add Timmy's public key to its authorized_keys (docs/ui-cockpit/TIMMY-CONNECT.md)`);
  return needs;
}

/** One device in one line: how it is reached, its key, and its last probe. */
export function deviceWords(d: DeviceRecord): string {
  const key = d.host_key ? `host key ${d.host_key.type} ${d.host_key.fingerprint} (confirmed ${when(d.host_key.confirmed_at)})` : 'host key not confirmed';
  const config = d.ssh_config === 'account' ? '; ssh uses your own ssh config (~/.ssh/config)' : '';
  const probe = d.probe ? `last probe ${when(d.probe.at)}: ${d.probe.words}` : 'not probed yet';
  return `${d.user}@${d.address}:${d.port} with ${d.identity === 'agent' ? 'the ssh agent' : `key ${d.identity}`}${config}; ${key}; ${probe}`;
}
