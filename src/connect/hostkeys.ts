/**
 * Round R4 (helper H90): host keys. Adding a device fetches its host keys with ssh-keyscan and shows their SHA256
 * fingerprints (ssh-keygen -l -E sha256 says each, and Timmy checks it against its own computation); they wait in
 * connect/scanned_hosts, which ssh is never given. Nothing is trusted until a person confirms the exact fingerprint: in
 * the CLI, `timmy connect trust <id> SHA256:<…>` must equal one that was fetched; in the REPL, Timmy's approval box.
 *
 * A confirmed key goes into Timmy's own known_hosts under the device's own name (`-o HostKeyAlias=timmy-<id>`), so each
 * device has its own pin, a pin never moves to another device on the same computer, and the account's
 * ~/.ssh/known_hosts is never read or written. A key that changes later is refused by ssh itself (StrictHostKeyChecking);
 * Timmy records the refusal and never re-pins: only a person's new confirmation replaces a pin.
 */
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendReceipt } from '../utils/receipts.js';
import { runProgram } from './exec.js';
import { scrubShown } from './scrub.js';
import { ensureConnect, locked, patchDevice, findDevice, writePrivate, type ConnectPaths } from './store.js';
import { FINGERPRINT, hostAlias } from './validate.js';
import type { DeviceRecord, HostKeyPin, HostKeyScan } from './types.js';

export { hostAlias };

/** How ssh-keyscan writes a host: the address, or [address]:port when the port is not 22. */
export const scanHost = (address: string, port: number): string => (port === 22 ? address : `[${address}]:${port}`);

export interface HostKey { type: string; blob: string; fingerprint: string; label: string }

const KEY_TYPES = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

/** OpenSSH's SHA256 fingerprint of a key blob: unpadded base64 of the blob's sha256. */
export function fingerprintOf(blob: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/** The key type as ssh-keygen names it: ED25519, ECDSA, RSA, ED25519-SK, ECDSA-SK. */
export function keyLabel(type: string): string {
  if (type === 'ssh-ed25519') return 'ED25519';
  if (type === 'ssh-rsa') return 'RSA';
  if (type.startsWith('ecdsa-')) return 'ECDSA';
  if (type.startsWith('sk-ssh-ed25519')) return 'ED25519-SK';
  if (type.startsWith('sk-ecdsa')) return 'ECDSA-SK';
  return type.toUpperCase();
}

/** The key lines of ssh-keyscan's answer for one host ("<host> <type> <base64>"); comments and anything else are left out. */
export function parseScan(stdout: string, host: string): Array<{ type: string; blob: string }> {
  const keys: Array<{ type: string; blob: string }> = [];
  for (const line of stdout.replace(/\r/g, '').split('\n')) {
    const [h, type, blob, ...rest] = line.trim().split(/\s+/);
    if (!h || h.startsWith('#') || rest.length > 0 || h !== host || !type || !KEY_TYPES.test(type) || !blob || !/^[A-Za-z0-9+/]+=*$/.test(blob)) continue;
    if (!keys.some((k) => k.blob === blob)) keys.push({ type, blob });
  }
  return keys;
}

const ORDER = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];
const rank = (type: string): number => { const i = ORDER.indexOf(type); return i < 0 ? ORDER.length : i; };

/**
 * Each key's fingerprint as ssh-keygen -l -E sha256 says it, checked against Timmy's own computation; when ssh-keygen is
 * not on PATH, Timmy's own (the words say so). Refused when the two disagree.
 */
async function fingerprints(p: ConnectPaths, host: string, keys: Array<{ type: string; blob: string }>): Promise<{ keys: HostKey[]; by: string } | { error: string }> {
  const own = keys.map((k) => ({ ...k, fingerprint: fingerprintOf(k.blob), label: keyLabel(k.type) }));
  const temp = path.join(p.dir, `.scan-${randomUUID()}.pub`);
  try {
    writeFileSync(temp, own.map((k) => `${host} ${k.type} ${k.blob}\n`).join(''), { mode: 0o600, flag: 'wx' });
    const r = await runProgram('ssh-keygen', ['-l', '-E', 'sha256', '-f', temp], { timeoutMs: 20_000 });
    if (r.spawnError === 'ENOENT') return { keys: own, by: 'Timmy (ssh-keygen is not on PATH here)' };
    if (r.code !== 0) return { error: `ssh-keygen could not read the fetched keys: ${scrubShown(r.stderr).trim().split('\n').at(-1) ?? `exit ${r.code}`}` };
    const said = [...r.stdout.toString('utf8').matchAll(/SHA256:[A-Za-z0-9+/]{43}/g)].map((m) => m[0]);
    if (said.length !== own.length || said.some((f, i) => f !== own[i].fingerprint)) return { error: 'ssh-keygen\'s fingerprints differ from Timmy\'s own computation of the same keys: nothing is shown as fetched' };
    return { keys: own, by: 'ssh-keygen' };
  } finally {
    try { unlinkSync(temp); } catch { /* not written */ }
  }
}

/** The keys waiting for a person, for one device (from connect/scanned_hosts: "<id> <host> <type> <base64>" lines). */
export function pendingKeys(p: ConnectPaths, id: string): Array<{ host: string; type: string; blob: string }> {
  let text = '';
  try { text = readFileSync(p.scanned, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => {
    const [who, host, type, blob] = line.trim().split(/\s+/);
    return who === id && host && type && blob ? [{ host, type, blob }] : [];
  });
}

function replaceLines(file: string, keep: (line: string) => boolean, add: string[]): void {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* none yet */ }
  const lines = text.split('\n').filter((l) => l.trim() && keep(l));
  writePrivate(file, [...lines, ...add].map((l) => `${l}\n`).join(''));
}

export interface ScanResult { ok: boolean; device: DeviceRecord; scan: HostKeyScan; keys: HostKey[]; words: string; ssh?: string }

/**
 * Fetches a device's host keys (ssh-keyscan), keeps them waiting for a person, and records their fingerprints in the
 * device record (never the keys). Trusts nothing.
 */
export async function scanDevice(p: ConnectPaths, id: string, o: { timeoutS?: number } = {}): Promise<ScanResult | { error: string }> {
  ensureConnect(p);
  const found = findDevice(p, id);
  if (!found.device) return { error: found.error ?? `no device ${id}` };
  const d = found.device;
  const host = scanHost(d.address, d.port);
  const t = o.timeoutS ?? 10;
  const r = await runProgram('ssh-keyscan', ['-T', String(t), '-p', String(d.port), '-t', 'ed25519,ecdsa,rsa', '--', d.address], { timeoutMs: (t + 20) * 1000 });
  const at = new Date().toISOString();
  const ssh = scrubShown(r.stderr.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join('\n')).trim();
  let keys: HostKey[] = [];
  let words: string;
  if (r.spawnError) {
    words = r.spawnError === 'ENOENT' ? 'ssh-keyscan is not on PATH here: no host key was fetched' : `ssh-keyscan could not be started (${r.spawnError}): no host key was fetched`;
  } else {
    const raw = parseScan(r.stdout.toString('utf8'), host).sort((a, b) => rank(a.type) - rank(b.type));
    if (!raw.length) {
      words = `no host key came back from ${d.address}:${d.port}${ssh ? ` (ssh-keyscan: ${ssh.split('\n').at(-1)})` : r.timedOut ? ' (Timmy\'s time limit ended ssh-keyscan)' : ' (it did not answer within its time limit, or nothing listens there)'}`;
    } else {
      const fp = await fingerprints(p, host, raw);
      if ('error' in fp) words = fp.error;
      else {
        keys = fp.keys;
        const pinned = d.host_key ? keys.find((k) => k.fingerprint === d.host_key!.fingerprint) : undefined;
        words = `fetched ${keys.length} host key${keys.length === 1 ? '' : 's'} from ${d.address}:${d.port} (fingerprints by ${fp.by}); nothing is trusted until a person confirms one`
          + (d.host_key ? (pinned ? `; the confirmed key ${d.host_key.fingerprint} is among them` : `; the confirmed key ${d.host_key.fingerprint} is NOT among them: the computer's key changed, or this is not the same computer`) : '');
      }
    }
  }
  const scan: HostKeyScan = { at, keys: keys.map((k) => ({ type: k.label, fingerprint: k.fingerprint })), words };
  // the keys wait in scanned_hosts (replacing this device's earlier ones); ssh is never given this file
  locked(p, () => replaceLines(p.scanned, (l) => l.trim().split(/\s+/)[0] !== id, keys.map((k) => `${id} ${host} ${k.type} ${k.blob}`)));
  const updated = patchDevice(p, id, (x) => { x.host_key_scan = scan; });
  return { ok: keys.length > 0, device: updated ?? d, scan, keys, words, ...(ssh ? { ssh } : {}) };
}

export interface TrustResult { ok: boolean; device?: DeviceRecord; pin?: HostKeyPin; replaced?: HostKeyPin; words: string; receipt?: string }

/**
 * A person confirmed `fingerprint` for a device: it must equal one of the keys fetched for it (exactly). That key goes into
 * Timmy's known_hosts under the device's own name, replacing an earlier pin of that device only (the words say which).
 */
export function trustKey(p: ConnectPaths, id: string, fingerprint: string, by: 'cli' | 'repl'): TrustResult {
  if (!FINGERPRINT.test(fingerprint)) return { ok: false, words: `${JSON.stringify(fingerprint)} is not a SHA256 fingerprint as ssh writes it (SHA256: and 43 characters): nothing was trusted` };
  ensureConnect(p);
  const found = findDevice(p, id);
  if (!found.device) return { ok: false, words: found.error ?? `no device ${id}` };
  const d = found.device;
  const host = scanHost(d.address, d.port);
  const pending = pendingKeys(p, id).filter((k) => k.host === host).map((k) => ({ ...k, fingerprint: fingerprintOf(k.blob), label: keyLabel(k.type) }));
  const key = pending.find((k) => k.fingerprint === fingerprint);
  if (!key) {
    const fetched = pending.map((k) => `${k.fingerprint} (${k.label})`).join(', ');
    return { ok: false, device: d, words: pending.length
      ? `${fingerprint} is not among the keys fetched from ${d.address}:${d.port} (${fetched}): nothing was trusted`
      : `no host key of ${d.address}:${d.port} is waiting for a person (timmy connect scan ${id} fetches them): nothing was trusted` };
  }
  const pin: HostKeyPin = { type: key.label, fingerprint, confirmed_at: new Date().toISOString(), confirmed_by: by };
  const replaced = d.host_key && d.host_key.fingerprint !== fingerprint ? d.host_key : undefined;
  locked(p, () => {
    const alias = hostAlias(id);
    replaceLines(p.knownHosts, (l) => l.trim().split(/\s+/)[0] !== alias, [`${alias} ${key.type} ${key.blob}`]);
    replaceLines(p.scanned, (l) => l.trim().split(/\s+/)[0] !== id, []);
  });
  const device = patchDevice(p, id, (x) => { x.host_key = pin; x.host_key_refused = null; });
  // the person's confirmation, sealed on the runs chain (a fingerprint, never a key)
  let receipt: string | undefined;
  try {
    receipt = appendReceipt('runs', {
      kind: 'remote-trust', subject: `remote-trust · ${id} · ${key.label} ${fingerprint}`, policy: 'human-gated', status: 'ok',
      sources: [{ device: id, address: d.address, port: d.port, type: key.label, fingerprint, confirmed_by: by, ...(replaced ? { replaced: replaced.fingerprint } : {}) }],
    }).hash.slice(7, 15);
  } catch { receipt = undefined; }
  return {
    ok: true, device, pin, ...(replaced ? { replaced } : {}), ...(receipt ? { receipt } : {}),
    words: `confirmed: ${id}'s host key is ${key.label} ${fingerprint}; Timmy's ssh accepts only this key from ${d.address}:${d.port}`
      + (replaced ? ` (it replaces ${replaced.type} ${replaced.fingerprint}, confirmed ${replaced.confirmed_at})` : ''),
  };
}

/** Removes a device's confirmed key and its waiting keys from Timmy's files (its record goes separately). */
export function forgetKeys(p: ConnectPaths, id: string): void {
  locked(p, () => {
    replaceLines(p.knownHosts, (l) => l.trim().split(/\s+/)[0] !== hostAlias(id), []);
    replaceLines(p.scanned, (l) => l.trim().split(/\s+/)[0] !== id, []);
  });
}

/** The key Timmy's known_hosts holds for a device, as a fingerprint (null: none). */
export function pinnedFingerprint(p: ConnectPaths, id: string): string | null {
  let text = '';
  try { text = readFileSync(p.knownHosts, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const [alias, , blob] = line.trim().split(/\s+/);
    if (alias === hostAlias(id) && blob) return fingerprintOf(blob);
  }
  return null;
}
