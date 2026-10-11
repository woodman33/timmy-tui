/**
 * Round R4 (helper H90): readConnect(home), the one read of Timmy Connect for God's Eye View (its second slice) and for
 * anything else that shows the operator's computers: the devices with their last probe, and the remote jobs with their
 * states, as plain JSON. It reads Timmy's own records only (no device is contacted, nothing is written), writes every path
 * under the account's home from ~, and says a record it could not read is unknown, with why.
 */
import { readdirSync } from 'node:fs';
import { listJobs } from './jobs.js';
import { connectPaths, readDevices } from './store.js';
import { deviceNeeds, deviceWords, jobWords } from './words.js';
import { scrubShown } from './scrub.js';
import type { ContactOutcome, DeviceOs, DeviceRecord, RemoteJobRecord, RemoteJobState, ShellFamily } from './types.js';

export const CONNECT_SCHEMA = 'timmy.connect/1';

export interface ConnectDeviceView {
  id: string; name: string; address: string; port: number; user: string;
  /** "agent", or the key file's path from ~ */
  identity: string;
  ssh_config: 'timmy' | 'account';
  os: DeviceOs; shell: ShellFamily;
  host_key: { type: string; fingerprint: string; confirmed_at: string } | null;
  host_key_refused: { at: string; offered?: string } | null;
  remote_dir: string;
  added_at: string;
  probe: { at: string; outcome: ContactOutcome; words: string; found_on_path: string[] } | null;
  /** what waits on a person for this device (a host key to confirm, a changed key, a refused key) */
  needs: string[];
  words: string;
}

export interface ConnectJobView {
  id: string; device: string; label: string;
  state: RemoteJobState;
  words: string;
  submitted_at: string;
  last_seen: string | null;
  /** what the device's status file last said (absent: never read) */
  remote: { read_at: string; where: string; state?: string; exit_status?: number | null; stop_signal?: string } | null;
  stop: { asked_at: string; confirmed_at?: string } | null;
  fetched: number;
}

export interface ConnectView {
  schema: typeof CONNECT_SCHEMA;
  as_of: string;
  devices: ConnectDeviceView[];
  jobs: ConnectJobView[];
  /** records that could not be read, each with why (their state is unknown) */
  unreadable: Array<{ record: string; why: string }>;
}

/** One device as every surface shows it (the CLI's JSON, the REPL, readConnect): no key, paths from ~. */
export function deviceView(d: DeviceRecord): ConnectDeviceView {
  return {
    id: d.id, name: d.name, address: d.address, port: d.port, user: d.user, identity: d.identity, ssh_config: d.ssh_config,
    os: d.os, shell: d.shell,
    host_key: d.host_key ? { type: d.host_key.type, fingerprint: d.host_key.fingerprint, confirmed_at: d.host_key.confirmed_at } : null,
    host_key_refused: d.host_key_refused ? { at: d.host_key_refused.at, ...(d.host_key_refused.offered ? { offered: d.host_key_refused.offered } : {}) } : null,
    remote_dir: d.remote_dir, added_at: d.added_at,
    probe: d.probe ? { at: d.probe.at, outcome: d.probe.outcome, words: scrubShown(d.probe.words), found_on_path: d.probe.facts?.found_on_path ?? [] } : null,
    needs: deviceNeeds(d).map(scrubShown),
    words: scrubShown(deviceWords(d)),
  };
}

/** One remote job as every surface shows it: its state and the same words everywhere. */
export function jobView(j: RemoteJobRecord): ConnectJobView {
  return {
    id: j.id, device: j.device, label: scrubShown(j.label), state: j.state, words: scrubShown(jobWords(j)),
    submitted_at: j.submitted_at, last_seen: j.last_seen ?? null,
    remote: j.remote ? { read_at: j.remote.read_at, where: j.remote.where, ...(j.remote.state ? { state: j.remote.state } : {}), ...(j.remote.state === 'ended' ? { exit_status: j.remote.exit_status ?? null } : {}), ...(j.remote.stop_signal ? { stop_signal: j.remote.stop_signal } : {}) } : null,
    stop: j.stop ? { asked_at: j.stop.asked_at, ...(j.stop.confirmed_at ? { confirmed_at: j.stop.confirmed_at } : {}) } : null,
    fetched: j.fetched?.length ?? 0,
  };
}

/** Timmy Connect as JSON: devices and remote jobs, from Timmy's own records (home: TIMMY_HOME or ~/timmy). */
export function readConnect(home?: string): ConnectView {
  const p = connectPaths(home);
  const read = readDevices(p);
  const unreadable: ConnectView['unreadable'] = [];
  if (read.error) unreadable.push({ record: 'connect/devices.json', why: read.error });
  const devices: ConnectDeviceView[] = read.devices.map(deviceView);
  const jobs = listJobs(p).map(jobView);
  // a remote record listJobs could not read is named, not dropped
  try {
    const listed = new Set(jobs.map((j) => `${j.id}.json`));
    for (const n of readdirSync(p.jobs)) if (/^r[0-9a-f]{8}\.json$/.test(n) && !listed.has(n)) unreadable.push({ record: `jobs/${n}`, why: 'not a readable remote job record' });
  } catch { /* no jobs folder: no jobs */ }
  return { schema: CONNECT_SCHEMA, as_of: new Date().toISOString(), devices, jobs, unreadable };
}
