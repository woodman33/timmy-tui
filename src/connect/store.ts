/**
 * Round R4 (helper H90): where Timmy Connect keeps its own files, and the device records.
 *
 *   <Timmy home>/connect/            0700
 *     devices.json                   0600  the device records (no key, no token: a key is named by its file)
 *     known_hosts                    0600  Timmy's own known-hosts file: only keys a person confirmed
 *     scanned_hosts                  0600  host keys ssh-keyscan fetched, waiting for a person (never given to ssh)
 *     ssh_config                     0600  Timmy's own, empty ssh config (ssh -F): the account's ~/.ssh/config is not read
 *   <Timmy home>/jobs/r<8 hex>.json  0600  a remote job's local record (kind "remote"; the job readers list j<6 hex> only)
 *
 * Timmy home is TIMMY_HOME or ~/timmy (src/utils/init.ts timmyHome). Every write goes through a temp file and a rename,
 * and every change of devices.json, known_hosts or scanned_hosts is made under one lock (src/utils/receipts.ts withLockDir).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { timmyHome } from '../utils/init.js';
import { tildePath } from '../utils/home-scrub.js';
import { withLockDir } from '../utils/receipts.js';
import type { DeviceRecord } from './types.js';

export const DEVICES_SCHEMA = 'timmy.connect.devices/1';

export interface ConnectPaths {
  home: string;
  dir: string;
  devices: string;
  knownHosts: string;
  scanned: string;
  sshConfig: string;
  jobs: string;
  /** where fetched results go when no --to is given: <Timmy home>/connect/results/<job>/<path> */
  results: string;
  lock: string;
}

export function connectPaths(home: string = timmyHome()): ConnectPaths {
  const dir = path.join(path.resolve(home), 'connect');
  return {
    home: path.resolve(home), dir,
    devices: path.join(dir, 'devices.json'),
    knownHosts: path.join(dir, 'known_hosts'),
    scanned: path.join(dir, 'scanned_hosts'),
    sshConfig: path.join(dir, 'ssh_config'),
    jobs: path.join(path.resolve(home), 'jobs'),
    results: path.join(dir, 'results'),
    lock: path.join(dir, '.lock'),
  };
}

/** A folder of Timmy's own, made 0700 (and narrowed to 0700 when it is wider). */
export function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

/** Writes a file of Timmy's own through a temp file and a rename, 0600. */
export function writePrivate(file: string, text: string | Buffer): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } catch (e) {
    try { unlinkSync(temp); } catch { /* never written */ }
    throw e;
  }
  try { chmodSync(file, 0o600); } catch { /* the rename kept 0600 */ }
}

/** The connect folder, Timmy's empty ssh config and its known-hosts file, made when missing (nothing else is created). */
export function ensureConnect(p: ConnectPaths): void {
  privateDir(p.dir);
  for (const file of [p.sshConfig, p.knownHosts]) {
    if (!existsSync(file)) {
      try { writeFileSync(file, '', { mode: 0o600, flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    try { if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600); } catch { /* not ours to change */ }
  }
}

/** Why Timmy's own ssh config cannot be used, or null: it must exist and be empty (ssh -F would apply anything in it). */
export function sshConfigProblem(p: ConnectPaths): string | null {
  try {
    const st = statSync(p.sshConfig);
    if (!st.isFile()) return `${shown(p.sshConfig)} is not a file`;
    if (st.size > 0) return `Timmy's own ssh config (${shown(p.sshConfig)}) is not empty, and ssh would apply what it holds; Timmy keeps it empty: empty it or move it away`;
    return null;
  } catch { return `Timmy's own ssh config (${shown(p.sshConfig)}) is missing`; }
}

/** Runs `fn` while holding Connect's lock (one writer of devices.json, known_hosts and scanned_hosts at a time). */
export function locked<T>(p: ConnectPaths, fn: () => T): T {
  privateDir(p.dir);
  return withLockDir(p.lock, fn);
}

/** A path as Timmy shows it: from ~ when it is under a home folder. */
export const shown = (file: string): string => tildePath(file);

/** A path as given ("~/x" or absolute), expanded for use: "~" is this account's home. */
export function expandHome(file: string): string {
  if (file === '~') return homedir();
  if (file.startsWith('~/')) return path.join(homedir(), file.slice(2));
  return file;
}

export interface DevicesRead { devices: DeviceRecord[]; error?: string }

/** The device records; none when the file is missing, and an error (and none) when it cannot be read. */
export function readDevices(p: ConnectPaths): DevicesRead {
  let text: string;
  try { text = readFileSync(p.devices, 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { devices: [] } : { devices: [], error: `${shown(p.devices)} could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  try {
    const raw = JSON.parse(text) as { schema?: unknown; devices?: unknown };
    if (!raw || raw.schema !== DEVICES_SCHEMA || !Array.isArray(raw.devices)) return { devices: [], error: `${shown(p.devices)} is not a Timmy Connect device file (${DEVICES_SCHEMA})` };
    return { devices: raw.devices.filter((d): d is DeviceRecord => Boolean(d) && typeof (d as DeviceRecord).id === 'string') };
  } catch { return { devices: [], error: `${shown(p.devices)} is not valid JSON` }; }
}

/** Changes the device records under the lock; `fn` returns what to give back, and the records it leaves are written. */
export function updateDevices<T>(p: ConnectPaths, fn: (devices: DeviceRecord[]) => T): T {
  return locked(p, () => {
    const read = readDevices(p);
    if (read.error) throw new Error(read.error);
    const devices = read.devices;
    const out = fn(devices);
    writePrivate(p.devices, `${JSON.stringify({ schema: DEVICES_SCHEMA, devices }, null, 2)}\n`);
    return out;
  });
}

export function findDevice(p: ConnectPaths, id: string): { device?: DeviceRecord; error?: string } {
  const read = readDevices(p);
  if (read.error) return { error: read.error };
  const device = read.devices.find((d) => d.id === id);
  return device ? { device } : { error: `no device ${JSON.stringify(id)}: timmy connect devices lists them` };
}

/** Changes one device record under the lock (a probe's answer, a confirmed key, a refusal); false when it is gone. */
export function patchDevice(p: ConnectPaths, id: string, patch: (d: DeviceRecord) => void): DeviceRecord | undefined {
  return updateDevices(p, (devices) => {
    const d = devices.find((x) => x.id === id);
    if (!d) return undefined;
    patch(d);
    return { ...d };
  });
}
