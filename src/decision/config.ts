/**
 * Round R4 (H120): where Clef-Omni is reached, as the operator configured it in <TIMMY_HOME>/decision/clef.json:
 *
 *   {"transport": "workers-ai", "account_id": "<Cloudflare account id>", "token_file": "/path/to/a/0600/token"}
 *   {"transport": "systemone", "systemone_url": "http://127.0.0.1:8181", "token_file"?: "..."}   a self-hosted deployment
 *   {"transport": "none"}                                                                        Clef turned off here
 *
 * No file, or one that cannot be read or used, means the provider is unavailable (the deterministic path is used, the reason
 * recorded); nothing is guessed. The token is read only through src/cloud/token.ts readTokenFile (a regular file of the
 * operator's own, 0600 or 0400, never through a link), at each call, and kept in memory for that call alone. The token and
 * the account id never enter a record, a receipt, a log line, an error message or anything a page or canvas could read:
 * every word that leaves a call goes through redactSecrets. A SystemOne address may be http:// only to this computer.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { redactToken } from '../cloud/token.js';
import { timmyHome } from '../setup/home.js';
import { scrubHomes, tildePath } from '../utils/home-scrub.js';
import { redactString } from '../utils/redact.js';

export type ClefTransportSetting = 'workers-ai' | 'systemone' | 'none';

export interface ClefConfig {
  transport: ClefTransportSetting;
  account_id?: string;
  token_file?: string;
  systemone_url?: string;
}

/** A Cloudflare account id as the REST path takes it (letters and digits; long enough to be taken out of any text). */
export const ACCOUNT_ID = /^[A-Za-z0-9]{8,64}$/;

type Env = Record<string, string | undefined>;

export const clefConfigPath = (env: Env = process.env): string => join(timmyHome(env), 'decision', 'clef.json');

export type ClefConfigRead =
  | { state: 'configured'; config: ClefConfig; path: string }
  | { state: 'none yet' | 'off' | 'unreadable' | 'invalid'; why: string; path: string };

const LOOPBACK = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** Whether an address's host is this computer. */
export const isLoopbackUrl = (url: string): boolean => {
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
};

/** A SystemOne base address as kept (origin and path, no trailing slash), or why it is refused. Never echoes credentials. */
export function checkSystemOneUrl(raw: string): { url: string } | { why: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { why: 'systemone_url is not an address (http://127.0.0.1:<port>, or https://<host>)' }; }
  if (u.username || u.password) return { why: 'systemone_url holds a user name or password: give the address alone, and a token in token_file' };
  if (u.search || u.hash) return { why: 'systemone_url has a query or a fragment: give the base address alone' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { why: `systemone_url uses ${u.protocol}, not http: or https:` };
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) return { why: 'systemone_url uses http:// to another computer: http:// is allowed only to this computer (127.0.0.1, ::1, localhost); use https://' };
  return { url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** Clef's config as the operator wrote it, checked; never reads the token itself. */
export function readClefConfig(env: Env = process.env): ClefConfigRead {
  const path = clefConfigPath(env);
  const shown = tildePath(path);
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { state: 'none yet', why: `Clef is not set up: no ${shown} (transport workers-ai or systemone)`, path }
      : { state: 'unreadable', why: `${shown} cannot be read (${code ?? 'error'})`, path };
  }
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  } catch {
    return { state: 'unreadable', why: `${shown} is not a JSON object`, path };
  }
  const bad = (why: string): ClefConfigRead => ({ state: 'invalid', why: `${shown}: ${why}`, path });
  const transport = v.transport;
  if (transport === 'none') return { state: 'off', why: `Clef is turned off in ${shown} (transport "none")`, path };
  let tokenFile: string | undefined;
  if (v.token_file !== undefined) {
    if (typeof v.token_file !== 'string' || !v.token_file.trim()) return bad('token_file must be the path of the token file');
    tokenFile = expandHome(v.token_file.trim());
    if (!isAbsolute(tokenFile)) return bad('token_file must be an absolute path (or start with ~/)');
  }
  if (transport === 'workers-ai') {
    if (typeof v.account_id !== 'string' || !ACCOUNT_ID.test(v.account_id)) return bad('workers-ai needs account_id: the Cloudflare account id, 8 to 64 letters and digits');
    if (!tokenFile) return bad('workers-ai needs token_file: a file of yours (0600) holding an API token with Workers AI access');
    return { state: 'configured', config: { transport, account_id: v.account_id, token_file: tokenFile }, path };
  }
  if (transport === 'systemone') {
    if (typeof v.systemone_url !== 'string') return bad('systemone needs systemone_url: the deployment\'s base address');
    const u = checkSystemOneUrl(v.systemone_url);
    if ('why' in u) return bad(u.why);
    return { state: 'configured', config: { transport, systemone_url: u.url, ...(tokenFile ? { token_file: tokenFile } : {}) }, path };
  }
  return bad(`transport must be "workers-ai", "systemone" or "none", not ${JSON.stringify(transport ?? null)}`);
}

/**
 * `text` with the token and the account id taken out in every form they could take (as is, JSON-escaped, URL-encoded,
 * base64), then any other key-shaped string (src/utils/redact.ts) and home folders (written from ~).
 */
export function redactSecrets(text: string, s: { token?: string; accountId?: string }): string {
  let out = redactToken(text, s.token);
  const id = s.accountId;
  if (id && id.length >= 8) {
    const forms = [id, JSON.stringify(id).slice(1, -1), encodeURIComponent(id), Buffer.from(id, 'utf8').toString('base64')];
    for (const f of [...new Set(forms)].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length)) out = out.split(f).join('[REDACTED_ACCOUNT_ID]');
  }
  return scrubHomes(redactString(out));
}
