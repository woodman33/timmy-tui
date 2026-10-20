/**
 * Round R4 (H121): whether Timmy's fleet may use a Cloudroom Core, and which one.
 *
 *   TIMMY_FLEET_CLOUDROOM unset   unavailable, with why and what turns it on
 *   TIMMY_FLEET_CLOUDROOM=1       the Core named in <TIMMY_HOME>/fleet/cloudroom.json: {url, token_file, label?, max_concurrent?}
 *   TIMMY_FLEET_CLOUDROOM=fake    the in-process FAKE Core (src/fleet/cloudroom/fake-core.ts), a simulation
 *
 * The token lives only in its own file, named by token_file, which must allow no group or other access (0600); the
 * config holds no credential and is refused when it seems to. The token is read when a request is made and at no other
 * time, and no message here carries it. writeCloudroomConfig is for a later `timmy fleet connect cloudroom <url>
 * --token-file <file>` (the lead adds the verb); it never reads the token. Messages name files from "~", and the config
 * by its place in Timmy's home, so a refusal stored in a fleet's ledger holds no home path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tildePath } from '../../utils/home-scrub.js';
import { writeWhole } from '../ledger.js';
import { coreUrlProblem, tokenIsUsable } from './client.js';
import { FAKE_CORE_LABEL } from './fake-core.js';

export const CLOUDROOM_FLAG = 'TIMMY_FLEET_CLOUDROOM';
export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_LABEL = 'cloudroom-core';
export type CloudroomMode = 'off' | 'real' | 'fake';

/** The config file as written: no credential, only where the token's file is. */
export interface CloudroomFileConfig {
  url: string;
  token_file: string;
  label?: string;
  max_concurrent?: number;
}

export interface CloudroomSettings {
  url: string;
  tokenFile: string;
  label: string;
  maxConcurrent: number;
}

type Env = Record<string, string | undefined>;

export const timmyHomeOf = (env: Env = process.env): string => env.TIMMY_HOME || path.join(os.homedir(), 'timmy');
export const cloudroomConfigPath = (home: string): string => path.join(home, 'fleet', 'cloudroom.json');
const CONFIG_WORDS = "fleet/cloudroom.json in Timmy's home folder";
const CONNECT = 'timmy fleet connect cloudroom <url> --token-file <file>';

/** The config's fields checked, or why it cannot be used. Reads no file. */
export function parseCloudroomConfig(value: unknown): { ok: true; settings: CloudroomSettings } | { ok: false; why: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, why: `${CONFIG_WORDS} is not a JSON object` };
  const v = value as Record<string, unknown>;
  const credential = Object.keys(v).find((k) => k !== 'token_file' && /token|secret|password|key|auth/i.test(k));
  if (credential) return { ok: false, why: `${CONFIG_WORDS} must not hold a credential (it has "${credential}"): put the token in its own file, mode 0600, and name that file in token_file` };
  const unknown = Object.keys(v).find((k) => !['url', 'token_file', 'label', 'max_concurrent'].includes(k));
  if (unknown) return { ok: false, why: `${CONFIG_WORDS} has an unknown field "${unknown}" (it takes url, token_file, label and max_concurrent)` };
  if (typeof v.url !== 'string') return { ok: false, why: `${CONFIG_WORDS} needs a url` };
  const urlProblem = coreUrlProblem(v.url);
  if (urlProblem) return { ok: false, why: `${CONFIG_WORDS}: ${urlProblem}` };
  if (typeof v.token_file !== 'string' || !path.isAbsolute(v.token_file)) {
    return { ok: false, why: `${CONFIG_WORDS} needs token_file: the absolute path of a file holding the Core's token (mode 0600)` };
  }
  const label = v.label === undefined ? DEFAULT_LABEL : v.label;
  if (typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(label)) {
    return { ok: false, why: `${CONFIG_WORDS}: label must be 1 to 64 letters, digits, spaces, dots, underscores or hyphens` };
  }
  const max = v.max_concurrent === undefined ? DEFAULT_MAX_CONCURRENT : v.max_concurrent;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 100) return { ok: false, why: `${CONFIG_WORDS}: max_concurrent must be a whole number from 1 to 100` };
  return { ok: true, settings: { url: v.url, tokenFile: v.token_file, label, maxConcurrent: max } };
}

/** Why a token file cannot be used, or undefined. Looks at its kind, mode and size only; reads no content. */
export function tokenFileProblem(file: string): string | undefined {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return `the token file ${tildePath(file)} cannot be found`; }
  return statProblem(file, st);
}

function statProblem(file: string, st: fs.Stats): string | undefined {
  if (!st.isFile()) return `the token file ${tildePath(file)} is not a regular file`;
  if ((st.mode & 0o077) !== 0) {
    return `the token file ${tildePath(file)} allows group or other access (mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}); make it 0600 (chmod 600) before Timmy reads it`;
  }
  if (st.size > 4096) return `the token file ${tildePath(file)} is larger than a token (over 4096 bytes)`;
  return undefined;
}

/** The token, read now (at use time only) after the same checks on the open file; an error never carries its content. */
export function readTokenFile(file: string): string {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { throw new Error(`the token file ${tildePath(file)} cannot be opened`); }
  try {
    const problem = statProblem(file, fs.fstatSync(fd));
    if (problem) throw new Error(problem);
    const token = fs.readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (!tokenIsUsable(token)) throw new Error(`the token file ${tildePath(file)} does not hold one usable token (visible ASCII characters, no spaces)`);
    return token;
  } finally {
    fs.closeSync(fd);
  }
}

/** The configured Core's settings, with its token file checked (not read), or why there is none to use. */
export function loadCloudroomSettings(home: string): { ok: true; settings: CloudroomSettings } | { ok: false; why: string } {
  let raw: string;
  try { raw = fs.readFileSync(cloudroomConfigPath(home), 'utf8'); } catch { return { ok: false, why: `no Cloudroom Core is configured (${CONFIG_WORDS} is missing): ${CONNECT}` }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, why: `${CONFIG_WORDS} is not valid JSON` }; }
  const r = parseCloudroomConfig(parsed);
  if (!r.ok) return r;
  const problem = tokenFileProblem(r.settings.tokenFile);
  return problem ? { ok: false, why: problem } : r;
}

/** Whether the fleet may use a Cloudroom Core now, why (or why not), and which kind: none, a configured one, or the FAKE. */
export function cloudroomAvailability(env: Env = process.env, home: string = timmyHomeOf(env)): { available: boolean; why: string; mode: CloudroomMode } {
  const flag = (env[CLOUDROOM_FLAG] ?? '').trim();
  if (!flag) {
    return { available: false, mode: 'off', why: `${CLOUDROOM_FLAG} is not set: set it to 1 to use the Cloudroom Core named in ${CONFIG_WORDS} (${CONNECT}), or to "fake" for the in-process FAKE Core (a simulation)` };
  }
  if (flag === 'fake') return { available: true, mode: 'fake', why: `${CLOUDROOM_FLAG}=fake: ${FAKE_CORE_LABEL}` };
  if (flag !== '1') return { available: false, mode: 'off', why: `${CLOUDROOM_FLAG} must be 1 (a configured Core) or fake (the FAKE Core); it is set to something else` };
  const s = loadCloudroomSettings(home);
  if (!s.ok) return { available: false, mode: 'real', why: s.why };
  return {
    available: true, mode: 'real',
    why: `Cloudroom Core "${s.settings.label}" from ${CONFIG_WORDS}, at most ${s.settings.maxConcurrent} sessions at once: self-hosted and shared (a session on a shared machine per worker); not verified until a live check passes`,
  };
}

/**
 * Writes <home>/fleet/cloudroom.json (mode 0600) after checking the URL and the token file's mode; never reads the
 * token. For `timmy fleet connect cloudroom <url> --token-file <file>`.
 */
export function writeCloudroomConfig(home: string, input: { url: string; tokenFile: string; label?: string; maxConcurrent?: number }): { path: string; config: CloudroomFileConfig } {
  const config: CloudroomFileConfig = {
    url: input.url,
    token_file: path.resolve(input.tokenFile),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.maxConcurrent === undefined ? {} : { max_concurrent: input.maxConcurrent }),
  };
  const parsed = parseCloudroomConfig(config);
  if (!parsed.ok) throw new Error(parsed.why);
  const problem = tokenFileProblem(config.token_file);
  if (problem) throw new Error(problem);
  const file = cloudroomConfigPath(home);
  writeWhole(file, `${JSON.stringify(config, null, 2)}\n`);
  return { path: file, config };
}
