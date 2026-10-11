#!/usr/bin/env node
/**
 * FAKE ssh-keygen, for Timmy Connect's tests only (round R4, helper H90): the one use Timmy makes of it,
 * `ssh-keygen -l -E sha256 -f <file>`, answered as ssh-keygen answers it ("<bits> SHA256:<base64> <host or comment>
 * (<TYPE>)" per key, a public key file or known_hosts lines alike). Any other option is refused as not part of this
 * stand-in. Each call's arguments go to $TIMMY_FAKE_SSH_LOG.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.TIMMY_FAKE_SSH_LOG) fs.appendFileSync(process.env.TIMMY_FAKE_SSH_LOG, `${JSON.stringify({ prog: 'ssh-keygen', pid: process.pid, argv })}\n`);
const die = (s, code = 1) => { process.stderr.write(`${s}\n`); process.exit(code); };
let list = false;
let hash = 'sha256';
let file = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-l') list = true;
  else if (a === '-E') { hash = argv[++i]; if (!hash) die('option requires an argument -- E'); }
  else if (a === '-f') { file = argv[++i]; if (!file) die('option requires an argument -- f'); }
  else die(`FAKE ssh-keygen: ${a} is not part of this stand-in`);
}
if (!list || !file) die('FAKE ssh-keygen: only -l -E sha256 -f <file> is part of this stand-in');
if (hash !== 'sha256') die(`Invalid hash algorithm "${hash}"`, 255);
let text;
try { text = fs.readFileSync(file, 'utf8'); } catch { die(`${file}: No such file or directory`); }
const LABEL = (t) => (t === 'ssh-ed25519' ? 'ED25519' : t === 'ssh-rsa' ? 'RSA' : t.startsWith('ecdsa') ? 'ECDSA' : t.toUpperCase());
const TYPE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/;
function bits(type, blob) {
  if (type === 'ssh-ed25519') return 256;
  if (type.startsWith('ecdsa-sha2-nistp')) return Number(type.slice(-3));
  // ssh-rsa: string type, mpint e, mpint n
  const b = Buffer.from(blob, 'base64');
  let at = 0;
  const next = () => { const n = b.readUInt32BE(at); const v = b.subarray(at + 4, at + 4 + n); at += 4 + n; return v; };
  next(); next();
  const n = next();
  let first = 0;
  while (first < n.length && n[first] === 0) first++;
  return (n.length - first) * 8 - Math.clz32(n[first]) + 24;
}
let printed = 0;
for (const line of text.split('\n')) {
  const w = line.trim().split(/\s+/);
  if (!w[0] || w[0].startsWith('#')) continue;
  const [type, blob, comment] = TYPE.test(w[0]) ? [w[0], w[1], w.slice(2).join(' ') || 'no comment'] : [w[1], w[2], w[0]];
  if (!type || !TYPE.test(type) || !blob) continue;
  const fp = `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
  process.stdout.write(`${bits(type, blob)} ${fp} ${comment} (${LABEL(type)})\n`);
  printed++;
}
if (!printed) die(`${file} is not a public key file.`, 255);
