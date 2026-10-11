/**
 * Round R4 (helper H90): Timmy Connect, slice 1: the operator's own computers over SSH. The shapes every part of it shares:
 * a device record (devices.json), a probe's answer, and a remote job's local record (in Timmy's jobs folder, kind "remote").
 *
 * Nothing here holds key material or a secret: a key is named by its file (or "agent"), a host key by its SHA256
 * fingerprint, and captured remote output is scrubbed before it is stored (src/connect/scrub.ts).
 */

export type DeviceOs = 'macos' | 'linux' | 'windows' | 'unknown';
/** The family of the shell a device runs a command through: from the probe, never assumed. */
export type ShellFamily = 'posix' | 'powershell' | 'cmd' | 'unknown';

/** What one contact with a device came to. */
export type ContactOutcome = 'connected' | 'unreachable' | 'host-key-unconfirmed' | 'host-key-changed' | 'auth-refused' | 'error';
/** Why a device was unreachable, in ssh's terms. */
export type UnreachableWhy = 'timed out' | 'refused' | 'no route' | 'name not resolved' | 'network unreachable' | 'closed';

/** A host key a person confirmed: its type and SHA256 fingerprint, when, and where they confirmed it. */
export interface HostKeyPin { type: string; fingerprint: string; confirmed_at: string; confirmed_by: 'cli' | 'repl' }
/** The host keys ssh-keyscan last fetched (fingerprints only; the keys wait in connect/scanned_hosts until one is confirmed). */
export interface HostKeyScan { at: string; keys: Array<{ type: string; fingerprint: string }>; words: string }
/** ssh refused the device's host key: it differs from the confirmed one. Timmy never re-pins it; a person decides. */
export interface HostKeyRefusal { at: string; offered?: string; words: string }

/** What a probe learned: each fact as the device answered it; "found on PATH" never means supported or working. */
export interface ProbeFacts {
  os_name?: string;
  os_version?: string;
  arch?: string;
  user?: string;
  login_shell?: string;
  /** the remote job folder: writable now, or absent (and whether it can be made), or not writable */
  job_folder?: 'writable' | 'not writable' | 'absent, can be made' | 'absent, cannot be made' | 'unknown';
  /** how a job is detached from the SSH session there: setsid, perl's POSIX::setsid, WMI (Windows), or none found */
  detach?: 'setsid' | 'perl' | 'wmi' | 'none';
  /** the program that gives a file's sha256 there */
  sha256?: string;
  found_on_path: string[];
  not_found_on_path: string[];
}

export interface DeviceProbe { at: string; outcome: ContactOutcome; why?: UnreachableWhy; words: string; facts?: ProbeFacts }

export interface DeviceRecord {
  /** a slug: lowercase letters, digits and dashes */
  id: string;
  name: string;
  /** a hostname, a tailnet name or an IP address */
  address: string;
  port: number;
  user: string;
  /** "agent" (the ssh agent's keys), or a private key's file, written from ~ when it is under the home; never read by Timmy */
  identity: string;
  /** "timmy": ssh reads only Timmy's own, empty config; "account": the device opted into the account's own ~/.ssh/config */
  ssh_config: 'timmy' | 'account';
  os: DeviceOs;
  shell: ShellFamily;
  host_key: HostKeyPin | null;
  host_key_scan: HostKeyScan | null;
  host_key_refused: HostKeyRefusal | null;
  /** the remote folder for Timmy's job records: relative to the remote home, or absolute */
  remote_dir: string;
  added_at: string;
  probe: DeviceProbe | null;
}

/** A remote job's state, as Timmy last knew it (src/connect/words.ts says each in words). */
export type RemoteJobState = 'submitted' | 'running' | 'ended' | 'unknown' | 'stop asked' | 'stopped';

/** The remote status file as the device last answered it. */
export interface RemoteStatus {
  /** when Timmy read it */
  read_at: string;
  /** absent: the device has no folder for this id; not started: a folder and no claim; claimed: a claim and no status yet */
  where: 'absent' | 'not started' | 'claimed' | 'status';
  state?: 'running' | 'ended';
  pid?: number;
  pgid?: number;
  /** the first process's start time as the device's ps says it (checked before any signal, so a reused pid is never signalled) */
  pid_start?: string;
  started_at?: string;
  ended_at?: string;
  /** the shell's exit status of the job (above 128: a shell's way of reporting a death by signal N-128, or that exit code) */
  exit_status?: number | null;
  /** the signal the job's supervisor received (a stop) */
  stop_signal?: string;
  /** who wrote the end: the job's supervisor, or a stop that had to end its group with KILL */
  by?: string;
  /** whether its first process still runs: yes (the same start time), no, reused (another process has its pid now), or
   *  unchecked (it runs, and no start time was recorded there to say it is the same one) */
  alive?: 'yes' | 'no' | 'reused' | 'unchecked';
  /** the stop the device recorded */
  stop?: { asked_at?: string; signals: string[] };
  /** the last lines of its output (scrubbed before they are stored) */
  tail?: string[];
}

export interface RemoteJobEvent { at: string; what: string }

export interface RemoteJobRecord {
  /** "r" and 8 hex digits: chosen here before anything is sent, and the name of the remote job folder */
  id: string;
  kind: 'remote';
  /** what runs, scrubbed: the command's words, or the script's file name */
  label: string;
  device: string;
  /** the remote job folder: <remote_dir>/<id> */
  remote_dir: string;
  script: { sha256: string; bytes: number; from: 'command' | 'file'; name?: string; shell: 'posix' | 'powershell' };
  state: RemoteJobState;
  submitted_at: string;
  /** when the device first confirmed the run had started */
  confirmed_at?: string;
  /** when the device last answered about this job */
  last_seen?: string;
  remote?: RemoteStatus;
  /** while the state is unknown: since when, why, and what is not known */
  unknown?: { since: string; why: string; not_known: string };
  /** the stop a person asked for: when, whether the device confirmed it, and how it went */
  stop?: { asked_at: string; confirmed_at?: string; result?: string; words: string };
  fetched?: Array<{ path: string; to: string; sha256: string; bytes: number; receipt?: string; at: string }>;
  events: RemoteJobEvent[];
}
