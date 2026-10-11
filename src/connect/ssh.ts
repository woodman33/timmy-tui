/**
 * Round R4 (helper H90): the one way Timmy Connect calls ssh. Every call carries Timmy's own settings, whatever the
 * account's configuration says (options given with -o come first, so they win over any config file):
 *
 *   -F <Timmy's own, empty config>        the account's ~/.ssh/config and /etc/ssh/ssh_config are not read
 *                                         (a device that opted into the account's config drops only this one)
 *   -o BatchMode=yes                       never a password or passphrase prompt
 *   -o StrictHostKeyChecking=yes           only a host key a person confirmed; ssh refuses any other
 *   -o UserKnownHostsFile=<Timmy's file>   Timmy's own known_hosts; the account's ~/.ssh/known_hosts is never read or written
 *   -o GlobalKnownHostsFile=<null device>
 *   -o UpdateHostKeys=no                   ssh never adds or rotates keys in Timmy's file
 *   -o HostKeyAlias=timmy-<id>             the device's own pin (two devices on one computer keep their own)
 *   -o ConnectTimeout=<s>, ServerAliveInterval/CountMax   a dead connection is noticed
 *   -o ControlMaster=no -o ControlPath=none               no shared connection (it would skip the host key check)
 *   -o ForwardAgent=no -o ClearAllForwardings=yes -o ForwardX11=no -o PermitLocalCommand=no -T
 *   -i <key file> -o IdentitiesOnly=yes    a key named by its file (ssh reads it; Timmy never does), or
 *   -o IdentityFile=none                   "agent": only the ssh agent's keys
 *   -p <port> -l <user> -- <address> <remote command>
 *
 * A remote command is a fixed word list (`sh -s`, or `powershell.exe … -EncodedCommand <base64>`); what it runs comes on
 * stdin, so no script, path or secret of the operator's is ever in an argument list on either computer.
 */
import { devNull } from 'node:os';
import { scrubShown } from './scrub.js';
import { ensureConnect, expandHome, sshConfigProblem, type ConnectPaths } from './store.js';
import { runProgram, type Ran, type RunOptions } from './exec.js';
import type { ContactOutcome, DeviceRecord, UnreachableWhy } from './types.js';
import { hostAlias } from './validate.js';

export const CONNECT_TIMEOUT_S = 10;
export const ALIVE_INTERVAL_S = 15;
export const ALIVE_COUNT = 3;

/** A path inside an ssh -o value: % doubled (ssh expands %-tokens there), quoted when it holds a space. */
function optionPath(file: string): string {
  if (file.includes('"') || file.includes('${')) throw new Error(`a path ssh would misread: ${JSON.stringify(file)}`);
  const escaped = file.replace(/%/g, '%%');
  return /\s/.test(escaped) ? `"${escaped}"` : escaped;
}

/** ssh's options for one device, before `--`, the address and the remote command. */
export function sshOptions(d: DeviceRecord, p: ConnectPaths, o: { connectTimeoutS?: number } = {}): string[] {
  const args: string[] = [];
  if (d.ssh_config !== 'account') args.push('-F', p.sshConfig);
  args.push(
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${optionPath(p.knownHosts)}`,
    '-o', `GlobalKnownHostsFile=${devNull}`,
    '-o', 'UpdateHostKeys=no',
    '-o', `HostKeyAlias=${hostAlias(d.id)}`,
    '-o', `ConnectTimeout=${o.connectTimeoutS ?? CONNECT_TIMEOUT_S}`,
    '-o', `ServerAliveInterval=${ALIVE_INTERVAL_S}`,
    '-o', `ServerAliveCountMax=${ALIVE_COUNT}`,
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardX11=no',
    '-o', 'PermitLocalCommand=no',
    '-T',
  );
  if (d.identity === 'agent') args.push('-o', 'IdentityFile=none');
  else args.push('-i', expandHome(d.identity), '-o', 'IdentitiesOnly=yes');
  args.push('-p', String(d.port), '-l', d.user);
  return args;
}

/** The whole argument list: options, `--`, the address, and the remote command's fixed words. */
export function sshArgs(d: DeviceRecord, p: ConnectPaths, remote: readonly string[], o: { connectTimeoutS?: number } = {}): string[] {
  return [...sshOptions(d, p, o), '--', d.address, ...remote];
}

/** Why a contact failed, in Timmy's words, with ssh's own words kept (scrubbed). */
export interface SshFailure {
  outcome: Exclude<ContactOutcome, 'connected'>;
  why?: UnreachableWhy;
  words: string;
  /** ssh's own words (its stderr, scrubbed, at most 1,200 characters) */
  ssh: string;
  /** the fingerprint ssh says the device offered, when its host key changed */
  offered?: string;
  /** the contact never reached the device (nothing was sent) */
  notSent: boolean;
}

/** ssh's stderr cut to its last lines, scrubbed. */
export function sshWords(stderr: string, max = 1200): string {
  const text = scrubShown(stderr.replace(/\r/g, '')).trim();
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

/**
 * What ssh's own refusal or failure was, or null when ssh connected and ran the remote command. `marker` is a line every
 * one of Timmy's remote scripts prints first: when it came back, the command ran (whatever its exit).
 */
export function classifySsh(r: Ran, d: DeviceRecord, marker?: string): SshFailure | null {
  const out = r.stdout.toString('utf8');
  if (marker && out.includes(marker)) return null;
  const ssh = sshWords(r.stderr);
  const where = `${d.address}:${d.port}`;
  if (r.spawnError) {
    return r.spawnError === 'ENOENT'
      ? { outcome: 'error', words: 'ssh is not on PATH here, so nothing was sent', ssh, notSent: true }
      : { outcome: 'error', words: `ssh could not be started (${r.spawnError}), so nothing was sent`, ssh, notSent: true };
  }
  const err = r.stderr;
  const changed = /REMOTE HOST IDENTIFICATION HAS CHANGED|has changed and you have requested strict checking/.test(err);
  if (changed) {
    const offered = /The fingerprint for the \S+ key sent by the remote host is\s*\n?\s*(SHA256:[A-Za-z0-9+/]{43})/.exec(err)?.[1];
    return { outcome: 'host-key-changed', words: `host key changed: ${where} offered ${offered ? `the key ${offered}` : 'a key'} other than the one a person confirmed, and ssh refused it; Timmy does not replace a confirmed key: a person checks the computer, then confirms its new key`, ssh, ...(offered ? { offered } : {}), notSent: true };
  }
  if (/host key is known for .* and you have requested strict checking|Host key verification failed/.test(err)) {
    return { outcome: 'host-key-unconfirmed', words: `host key not confirmed: Timmy holds no confirmed key for ${where}, so ssh refused to log in`, ssh, notSent: true };
  }
  if (/Permission denied \(/.test(err)) {
    const how = d.identity === 'agent' ? 'the ssh agent\'s keys' : `the key ${d.identity}`;
    const agentless = d.identity === 'agent' && !process.env.SSH_AUTH_SOCK ? ' (no ssh agent is reachable here: SSH_AUTH_SOCK is not set)' : '';
    return { outcome: 'auth-refused', words: `authentication refused: ${where} did not accept ${how} for ${d.user}${agentless}`, ssh, notSent: true };
  }
  const unreachable = (why: UnreachableWhy, words: string): SshFailure => ({ outcome: 'unreachable', why, words: `unreachable: ${words}`, ssh, notSent: true });
  if (/Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution/.test(err)) return unreachable('name not resolved', `the name ${d.address} was not resolved`);
  if (/Connection refused/.test(err)) return unreachable('refused', `${where} refused the connection (nothing listens there, or a firewall refuses it)`);
  if (/No route to host/.test(err)) return unreachable('no route', `no route to ${d.address}`);
  if (/Network is unreachable/.test(err)) return unreachable('network unreachable', `the network of ${d.address} is unreachable from here`);
  if (/Connection timed out|Operation timed out|timed out during banner exchange/.test(err)) return unreachable('timed out', `no answer from ${where} (timed out)`);
  if (r.timedOut) {
    return { outcome: 'unreachable', why: 'timed out', words: `unreachable: ssh had not finished when Timmy's time limit (${Math.round(r.ms / 1000)} s) ended it`, ssh, notSent: false };
  }
  if (/kex_exchange_identification/.test(err)) {
    return { outcome: 'unreachable', why: 'closed', words: `unreachable: ${where} closed the connection before ssh could log in`, ssh, notSent: true };
  }
  if (/Connection closed by|Connection reset by|closed by remote host|Broken pipe|client_loop/.test(err)) {
    return { outcome: 'unreachable', why: 'closed', words: `the connection to ${where} ended before Timmy got an answer`, ssh, notSent: false };
  }
  if (r.aborted) return { outcome: 'error', words: 'stopped here before it finished', ssh, notSent: false };
  if (r.code === 255 || r.code === null) return { outcome: 'error', words: `ssh failed${r.code === null ? ` (${r.signal ?? 'no exit code'})` : ' (exit 255)'}${ssh ? `: ${ssh.split('\n').at(-1)}` : ''}`, ssh, notSent: false };
  return { outcome: 'error', words: `the remote command ended with exit ${r.code} and no answer Timmy knows`, ssh, notSent: false };
}

export interface SshCallOptions extends Omit<RunOptions, 'timeoutMs'> { timeoutMs?: number; connectTimeoutS?: number }

/** One ssh call to a device with Timmy's settings; refused when Timmy's own ssh config is not empty. */
export async function callSsh(d: DeviceRecord, p: ConnectPaths, remote: readonly string[], o: SshCallOptions = {}): Promise<Ran> {
  ensureConnect(p);
  if (d.ssh_config !== 'account') {
    const problem = sshConfigProblem(p);
    if (problem) throw new Error(problem);
  }
  return runProgram('ssh', sshArgs(d, p, remote, { connectTimeoutS: o.connectTimeoutS }), { ...o, timeoutMs: o.timeoutMs ?? 120_000 });
}
