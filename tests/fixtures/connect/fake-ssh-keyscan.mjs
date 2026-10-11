#!/usr/bin/env node
/**
 * FAKE ssh-keyscan, for Timmy Connect's tests only (round R4, helper H90): answers from the FAKE network ($TIMMY_FAKE_NET)
 * as ssh-keyscan answers a real one. It follows ssh-keyscan's getopt letters ("cDHqv46O:p:T:t:f:", `--` ending them),
 * prints each host key as "<host> <type> <base64>" on stdout ([host]:port when the port is not 22) and its comment line on
 * stderr, prints nothing for a host that does not answer, "getaddrinfo <host>: …" for a name that does not resolve, and
 * exits 1 when it found no key. No network is used. Each call's arguments go to $TIMMY_FAKE_SSH_LOG.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.TIMMY_FAKE_SSH_LOG) fs.appendFileSync(process.env.TIMMY_FAKE_SSH_LOG, `${JSON.stringify({ prog: 'ssh-keyscan', pid: process.pid, argv })}\n`);
const USAGE = 'usage: ssh-keyscan [-46cDHqv] [-f file] [-O option] [-p port] [-T timeout]\n                   [-t type] [host | addrlist namelist]';
const die = (s, code = 1) => { process.stderr.write(`${s}\n`); process.exit(code); };
const WITH_ARG = new Set(['O', 'p', 'T', 't', 'f']);
const FLAG = new Set(['c', 'D', 'H', 'q', 'v', '4', '6']);
let port = 22;
let types = ['ed25519', 'ecdsa', 'rsa'];
const hosts = [];
let i = 0;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { i++; break; }
  if (!a.startsWith('-') || a === '-') break;
  for (let k = 1; k < a.length; k++) {
    const ch = a[k];
    if (FLAG.has(ch)) continue;
    if (!WITH_ARG.has(ch)) die(`ssh-keyscan: unknown option -- ${ch}\n${USAGE}`);
    let v = a.slice(k + 1);
    if (!v) { i++; if (i >= argv.length) die(`ssh-keyscan: option requires an argument -- ${ch}\n${USAGE}`); v = argv[i]; }
    if (ch === 'p') { if (!/^[0-9]+$/.test(v)) die(`Bad port '${v}'`); port = Number(v); }
    else if (ch === 't') types = v.split(',');
    else if (ch === 'f') die('FAKE ssh-keyscan: -f is not part of this stand-in');
    break;
  }
}
hosts.push(...argv.slice(i));
if (!hosts.length) die(USAGE);
const WANT = { ed25519: ['ssh-ed25519'], ecdsa: ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'], rsa: ['ssh-rsa'] };
const wanted = new Set(types.flatMap((t) => WANT[t] ?? []));
const net = JSON.parse(fs.readFileSync(process.env.TIMMY_FAKE_NET, 'utf8'));
let found = 0;
for (const host of hosts) {
  const isIp = /^[0-9.]+$/.test(host) || host.includes(':');
  if ((net.unresolvable ?? []).includes(host) || (!isIp && !Object.keys(net.hosts ?? {}).some((k) => k.startsWith(`${host}:`)))) { process.stderr.write(`getaddrinfo ${host}: Name or service not known\n`); continue; }
  const entry = net.hosts?.[`${host}:${port}`];
  if (!entry || !['up', 'drop-after-run', 'drop-before-run'].includes(entry.mode)) continue; // no answer: ssh-keyscan prints nothing for it
  const shown = port === 22 ? host : `[${host}]:${port}`;
  process.stderr.write(`# ${host}:${port} SSH-2.0-OpenSSH_9.6 FAKE\n`);
  for (const k of entry.keys) if (wanted.has(k.type)) { process.stdout.write(`${shown} ${k.type} ${k.blob}\n`); found++; }
}
process.exit(found ? 0 : 1);
