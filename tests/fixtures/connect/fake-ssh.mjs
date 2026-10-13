#!/usr/bin/env node
/**
 * FAKE ssh, for Timmy Connect's tests only (round R4, helper H90). This container has no OpenSSH, so this stand-in plays
 * `ssh` from a FAKE network described in a JSON file ($TIMMY_FAKE_NET): no network is used and no real computer is
 * contacted. It follows OpenSSH's argument rules for the options Timmy uses (ssh's getopt letters, `-o Key=Value`, `--`
 * ending the options, the destination, then the remote command's words joined by spaces) and refuses what OpenSSH refuses,
 * in OpenSSH's own words: an unknown or changed host key under StrictHostKeyChecking=yes (exit 255), a refused
 * authentication, a refused or timed-out connection, a name that does not resolve.
 *
 * A remote command runs for real on this machine, in the FAKE device's remote home, through /bin/sh -c (as sshd runs a
 * command through the login shell), in a session of its own, with real child processes, signals and files: when this
 * process is killed, the remote command loses its stdin and stdout as it would when a connection drops.
 *
 * It also enforces Timmy's own rules, so a test fails loudly if Timmy forgets one: BatchMode=yes, StrictHostKeyChecking=yes,
 * a UserKnownHostsFile of Timmy's (never the account's ~/.ssh/known_hosts), GlobalKnownHostsFile=/dev/null. It never reads
 * a private key (only its permissions and the .pub beside it, as a stand-in for what ssh proves with it). Each call's
 * argument list is appended to $TIMMY_FAKE_SSH_LOG (one JSON line) for the tests to check. `ssh -V` prints the version it
 * plays ($TIMMY_FAKE_SSH_VERSION, default a 9.6), logged as "ssh-version"; it knows KnownHostsCommand only from 8.5 on.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const err = (s) => process.stderr.write(`${s}\n`);
const die = (s, code = 255) => { if (s) err(s); process.exit(code); };
// the version this stand-in plays ($TIMMY_FAKE_SSH_VERSION, as `ssh -V` prints it): an ssh older than 8.5 has no
// KnownHostsCommand, and refuses it as OpenSSH does (an unknown option)
const VERSION = process.env.TIMMY_FAKE_SSH_VERSION || 'OpenSSH_9.6p1 FAKE, OpenSSL 3.0.13 30 Jan 2024';
if (argv.length === 1 && argv[0] === '-V') {
  if (process.env.TIMMY_FAKE_SSH_LOG) fs.appendFileSync(process.env.TIMMY_FAKE_SSH_LOG, `${JSON.stringify({ prog: 'ssh-version', pid: process.pid, argv })}\n`);
  die(VERSION, 0);
}
if (process.env.TIMMY_FAKE_SSH_LOG) fs.appendFileSync(process.env.TIMMY_FAKE_SSH_LOG, `${JSON.stringify({ prog: 'ssh', pid: process.pid, argv })}\n`);
const [major, minor] = (/OpenSSH_(\d+)\.(\d+)/.exec(VERSION) ?? ['', '0', '0']).slice(1).map(Number);

// ssh's own getopt string: "1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:P:Q:R:S:TVw:W:XYy"
const WITH_ARG = new Set('bceilmopBDEFIJLOPQRSwW'.split(''));
const FLAG = new Set('1246afgknqstvxACGKMNTVXYy'.split(''));
const USAGE = 'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n           [-e escape_char] [-F configfile] [-I pkcs11] [-i identity_file]\n           [-J destination] [-L address] [-l login_name] [-m mac_spec]\n           [-O ctl_cmd] [-o option] [-P tag] [-p port] [-R address]\n           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]\n           destination [command [argument ...]]';
const KNOWN_OPTIONS = new Set(['batchmode', 'stricthostkeychecking', 'userknownhostsfile', 'globalknownhostsfile', 'updatehostkeys', 'hostkeyalias', 'connecttimeout', 'serveraliveinterval', 'serveralivecountmax', 'controlmaster', 'controlpath', 'forwardagent', 'clearallforwardings', 'forwardx11', 'permitlocalcommand', 'identityfile', 'identitiesonly', 'requesttty', 'loglevel', 'port', 'user', 'verifyhostkeydns']);
if (major > 8 || (major === 8 && minor >= 5)) KNOWN_OPTIONS.add('knownhostscommand');

const o = { opt: new Map(), identity: [], user: null, port: null, F: null, flags: new Set(), dest: null, cmd: [] };
function option(text) {
  const m = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(text);
  if (!m) die(`command-line line 0: missing argument.`);
  const key = m[1].toLowerCase();
  if (!KNOWN_OPTIONS.has(key)) die(`command-line line 0: Bad configuration option: ${m[1].toLowerCase()}`);
  let value = m[2].trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (!o.opt.has(key)) o.opt.set(key, value); // the first value given wins, as in ssh
}
let i = 0;
let terminated = false;
for (;;) {
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { i++; terminated = true; break; }
    if (!a.startsWith('-') || a === '-') break;
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (FLAG.has(ch)) { o.flags.add(ch); continue; }
      if (WITH_ARG.has(ch)) {
        let v = a.slice(k + 1);
        if (!v) { i++; if (i >= argv.length) die(`ssh: option requires an argument -- ${ch}\n${USAGE}`); v = argv[i]; }
        if (ch === 'o') option(v);
        else if (ch === 'i') o.identity.push(v);
        else if (ch === 'l') o.user = v;
        else if (ch === 'p') { if (!/^[0-9]+$/.test(v) || Number(v) < 1 || Number(v) > 65535) die(`Bad port '${v}'`); o.port = Number(v); }
        else if (ch === 'F') o.F = v;
        else die(`FAKE ssh: option -${ch} is not part of this stand-in`);
        break;
      }
      die(`ssh: unknown option -- ${ch}\n${USAGE}`);
    }
    i++;
  }
  if (o.dest === null && i < argv.length) {
    o.dest = argv[i++];
    if (!terminated && i < argv.length && argv[i].startsWith('-')) continue; // ssh reads options after the destination too
  }
  break;
}
o.cmd = argv.slice(i);
if (!o.dest) die(USAGE);
let host = o.dest;
let user = o.user;
const at = host.lastIndexOf('@');
if (at >= 0) { if (user === null) user = host.slice(0, at); host = host.slice(at + 1); }
const port = o.port ?? 22;
user ??= 'nobody';
const yes = (k) => (o.opt.get(k) ?? '').toLowerCase() === 'yes';

// Timmy's rules, checked so a test fails loudly when one is missing
if (!yes('batchmode')) die('FAKE ssh: Timmy must pass -o BatchMode=yes');
if (!yes('stricthostkeychecking')) die('FAKE ssh: Timmy must pass -o StrictHostKeyChecking=yes');
const userKnown = (o.opt.get('userknownhostsfile') ?? '').replace(/%%/g, '%');
if (!userKnown) die('FAKE ssh: refusing to read the account\'s ~/.ssh/known_hosts: Timmy must pass UserKnownHostsFile');
if (o.opt.get('globalknownhostsfile') !== '/dev/null') die('FAKE ssh: Timmy must pass GlobalKnownHostsFile=/dev/null');
if (o.F !== null) {
  let st;
  try { st = fs.statSync(o.F); } catch { die(`Can't open user config file ${o.F}: No such file or directory`); }
  if ((st.mode & 0o022) !== 0) die(`Bad owner or permissions on ${o.F}`);
  if (st.size > 0) die(`FAKE ssh: this stand-in reads no ssh config, and ${o.F} is not empty`);
} else if (process.env.TIMMY_FAKE_ALLOW_ACCOUNT_CONFIG !== '1') die('FAKE ssh: no -F given: the account\'s ~/.ssh/config would be read (this test did not allow it)');

const net = JSON.parse(fs.readFileSync(process.env.TIMMY_FAKE_NET, 'utf8'));
const entry = net.hosts?.[`${host}:${port}`];
const isIp = /^[0-9.]+$/.test(host) || host.includes(':');
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
const timeoutS = Number(o.opt.get('connecttimeout') ?? '0') || 30;

if ((net.unresolvable ?? []).includes(host) || (!isIp && !Object.keys(net.hosts ?? {}).some((k) => k.startsWith(`${host}:`)))) die(`ssh: Could not resolve hostname ${host}: Name or service not known`);
if (!entry || entry.mode === 'refused') die(`ssh: connect to host ${host} port ${port}: Connection refused`);
if (entry.mode === 'timeout') { await sleep(Math.min(timeoutS, 1) * 1000); die(`ssh: connect to host ${host} port ${port}: Connection timed out`); }
if (entry.mode === 'noroute') die(`ssh: connect to host ${host} port ${port}: No route to host`);
if (entry.mode === 'banner-close') die('kex_exchange_identification: Connection closed by remote host');

// host key: as ssh, under HostKeyAlias when given, else [host]:port (port 22: host)
const name = o.opt.get('hostkeyalias') || (port === 22 ? host : `[${host}]:${port}`);
const LABEL = (t) => (t === 'ssh-ed25519' ? 'ED25519' : t === 'ssh-rsa' ? 'RSA' : t.startsWith('ecdsa') ? 'ECDSA' : t.toUpperCase());
const fp = (blob) => `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
const known = [];
for (const file of userKnown.split(/\s+/).filter(Boolean)) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, n) => {
    const [patterns, type, blob] = line.trim().split(/\s+/);
    if (!patterns || patterns.startsWith('#') || !type || !blob) return;
    if (patterns.split(',').includes(name)) known.push({ file, line: n + 1, type, blob });
  });
}
const offered = entry.keys.find((k) => known.some((x) => x.type === k.type)) ?? entry.keys[0];
if (!known.length) die(`No ${LABEL(offered.type)} host key is known for ${name} and you have requested strict checking.\nHost key verification failed.`);
if (!known.some((x) => x.type === offered.type && x.blob === offered.blob)) {
  const bad = known.find((x) => x.type === offered.type) ?? known[0];
  die([
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
    'It is also possible that a host key has just been changed.',
    `The fingerprint for the ${LABEL(offered.type)} key sent by the remote host is\n${fp(offered.blob)}.`,
    'Please contact your system administrator.',
    `Add correct host key in ${bad.file} to get rid of this message.`,
    `Offending ${LABEL(bad.type)} key in ${bad.file}:${bad.line}`,
    `Host key for ${name} has changed and you have requested strict checking.`,
    'Host key verification failed.',
  ].join('\n'));
}

// authentication: the identity's public key (the .pub beside it), or the FAKE agent's keys ($SSH_AUTH_SOCK names a file of them)
const offeredKeys = [];
for (const file of o.identity) {
  let st;
  try { st = fs.statSync(file); } catch { err(`Warning: Identity file ${file} not accessible: No such file or directory.`); continue; }
  if ((st.mode & 0o077) !== 0) {
    err(['@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @', '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', `Permissions 0${(st.mode & 0o777).toString(8)} for '${file}' are too open.`, 'It is required that your private key files are NOT accessible by others.', 'This private key will be ignored.', `Load key "${file}": bad permissions`].join('\n'));
    continue;
  }
  try { offeredKeys.push(fs.readFileSync(`${file}.pub`, 'utf8').trim().split(/\s+/)[1]); } catch { /* no .pub: this stand-in cannot tell its key */ }
}
const identityNone = (o.opt.get('identityfile') ?? '').toLowerCase() === 'none';
if (!yes('identitiesonly') || identityNone) {
  try { for (const l of fs.readFileSync(process.env.SSH_AUTH_SOCK ?? '', 'utf8').split('\n')) if (l.trim()) offeredKeys.push(l.trim().split(/\s+/)[1] ?? l.trim()); } catch { /* no FAKE agent */ }
}
const account = entry.users?.[user];
if (!account || !offeredKeys.some((k) => account.authorized.includes(k))) die(`${user}@${host}: Permission denied (publickey).`);
if (entry.mode === 'drop-before-run') die(`Connection to ${host} closed by remote host.`);

// the remote command: Windows shells answer the probe's detection and run nothing else (FAKE)
const line = o.cmd.join(' ');
if (!line) die('FAKE ssh: this stand-in runs commands only (no interactive session)');
if (entry.shell === 'cmd' || entry.shell === 'powershell') {
  if (line === 'echo TIMMY-PROBE %OS%') { process.stdout.write(entry.shell === 'cmd' ? 'TIMMY-PROBE Windows_NT\r\n' : 'TIMMY-PROBE\r\n%OS%\r\n'); process.exit(0); }
  const m = /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line);
  if (m && entry.shell === 'cmd' && line.length > 8191) { process.stdout.write('The command line is too long.\r\n'); process.exit(1); }
  if (m) {
    const script = Buffer.from(m[1], 'base64').toString('utf16le');
    if (script.includes('TIMMY-PROBE-BEGIN') && entry.probeAnswer) { process.stdout.write(fs.readFileSync(entry.probeAnswer)); process.exit(0); }
    die('FAKE ssh: this stand-in cannot run PowerShell', 1);
  }
  process.stdout.write(entry.shell === 'cmd' ? `'${o.cmd[0]}' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n` : `${o.cmd[0]} : The term '${o.cmd[0]}' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\n`);
  process.exit(1);
}

const home = account.home;
const env = { HOME: home, USER: user, LOGNAME: user, SHELL: '/bin/sh', PATH: entry.path || process.env.PATH, LANG: 'C', SSH_CONNECTION: `127.0.0.1 50000 ${host} ${port}` };
const child = spawn('/bin/sh', ['-c', line], { cwd: home, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.on('error', () => { /* the remote command ended before it read all its input */ });
process.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
const drop = entry.mode === 'drop-after-run';
let held = null;
child.stdout.on('data', (chunk) => {
  if (drop) return;
  if (!entry.corrupt) { process.stdout.write(chunk); return; }
  // FAKE corruption on the channel: the last byte of the stream is flipped (held back until the next chunk or the end)
  const all = held ? Buffer.concat([held, chunk]) : chunk;
  process.stdout.write(all.subarray(0, all.length - 1));
  held = all.subarray(all.length - 1);
});
child.stderr.on('data', (chunk) => { if (!drop) process.stderr.write(chunk); });
child.on('close', (code, signal) => {
  if (held) { const b = Buffer.from(held); b[0] ^= 0xff; process.stdout.write(b); }
  if (drop) die(entry.dropWords || `Connection to ${host} closed by remote host.`);
  // ssh exits with the remote command's status; a remote command ended by a signal gives 255
  process.stdout.write('', () => process.exit(signal ? 255 : (code ?? 255)));
});
