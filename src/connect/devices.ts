/**
 * Round R4 (helper H90): adding and removing the operator's own computers. A device record names how to reach it (address,
 * port, user), which key ssh is to use (a key file's path, never its contents, or the ssh agent), whether its ssh uses
 * Timmy's own empty config (the default) or the account's, and the folder for Timmy's job records there. It holds no key
 * and no token; its host key is a fingerprint a person confirmed.
 */
import { statSync } from 'node:fs';
import { forgetKeys } from './hostkeys.js';
import { ensureConnect, expandHome, shown, updateDevices, type ConnectPaths } from './store.js';
import { checkAddress, checkId, checkIdentity, checkName, checkPort, checkRemoteDir, checkUser } from './validate.js';
import type { DeviceRecord } from './types.js';

export const DEFAULT_REMOTE_DIR = '.timmy-connect/jobs';

export interface DeviceInput {
  id: string;
  address: string;
  user: string;
  port?: number;
  /** "agent", or a private key's file (absolute or from ~) */
  identity: string;
  name?: string;
  remoteDir?: string;
  /** the device opts into the account's own ssh config (~/.ssh/config) */
  accountConfig?: boolean;
}

/** Every reason the input cannot become a device record (none: it can). */
export function checkDeviceInput(i: DeviceInput): string[] {
  const port = i.port ?? 22;
  const problems = [checkId(i.id), checkAddress(i.address), checkUser(i.user), checkPort(port), checkIdentity(i.identity), checkName(i.name ?? i.id), checkRemoteDir(i.remoteDir ?? DEFAULT_REMOTE_DIR)];
  if (i.identity !== 'agent' && !checkIdentity(i.identity)) {
    // the key file is looked at (stat: it exists, it is a file, who may read it), never opened
    try {
      const st = statSync(expandHome(i.identity));
      if (!st.isFile()) problems.push(`the key file ${i.identity} is not a file`);
      else if ((st.mode & 0o077) !== 0) problems.push(`the key file ${i.identity} can be read by others (mode ${(st.mode & 0o777).toString(8)}); ssh refuses such a key: chmod 600 it`);
    } catch { problems.push(`the key file ${i.identity} does not exist`); }
  }
  return problems.filter((x): x is string => Boolean(x));
}

/** A key file's path as a record keeps it: from ~ when it is under the home. */
const keptIdentity = (identity: string): string => (identity === 'agent' ? 'agent' : shown(expandHome(identity)));

/** Adds a device (no host key yet); refused when its id is taken or its input does not pass the checks. */
export function addDevice(p: ConnectPaths, i: DeviceInput): { device?: DeviceRecord; problems: string[] } {
  const problems = checkDeviceInput(i);
  if (problems.length) return { problems };
  ensureConnect(p);
  const device: DeviceRecord = {
    id: i.id, name: i.name ?? i.id, address: i.address, port: i.port ?? 22, user: i.user,
    identity: keptIdentity(i.identity), ssh_config: i.accountConfig ? 'account' : 'timmy',
    os: 'unknown', shell: 'unknown', host_key: null, host_key_scan: null, host_key_refused: null,
    remote_dir: i.remoteDir ?? DEFAULT_REMOTE_DIR, added_at: new Date().toISOString(), probe: null,
  };
  return updateDevices(p, (devices) => {
    if (devices.some((d) => d.id === i.id)) return { problems: [`a device ${i.id} exists already: timmy connect remove ${i.id} first, or choose another id`] };
    devices.push(device);
    return { device: { ...device }, problems: [] };
  });
}

/**
 * Removes a device's record, its confirmed key and its waiting keys from Timmy's files. Nothing on the device is touched:
 * its job folder and the line in its authorized_keys stay until a person removes them (the words say where).
 */
export function removeDevice(p: ConnectPaths, id: string): { removed?: DeviceRecord; words: string } {
  const removed = updateDevices(p, (devices) => {
    const at = devices.findIndex((d) => d.id === id);
    return at < 0 ? undefined : devices.splice(at, 1)[0];
  });
  if (!removed) return { words: `no device ${JSON.stringify(id)}: nothing removed` };
  forgetKeys(p, id);
  return { removed, words: `removed ${id} from Timmy (its record and its confirmed host key); nothing on ${removed.address} was changed: its job folder ${removed.remote_dir} and Timmy's line in its authorized_keys stay until you remove them there` };
}
