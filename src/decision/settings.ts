/**
 * Round R4 (H120): the decision settings, in Timmy's settings folder (src/setup/home.ts settingsFile: TIMMY_SETTINGS_DIR,
 * else the account's own) in a file of their own, decision.json, beside the Workbench's workbench.json and never inside it.
 * A save writes a temporary file (0600) in that folder, flushes it and renames it over the old one, the same way
 * src/workbench/settings.ts saves, so a reader sees the old settings or the new ones, never half of either.
 *
 *   Use decision-model routing        off by default; TIMMY_CLEF=1 or 0 overrides it for one process (never saved). R9
 *                                     (H162): its words are model-neutral, since the model is clef.json's, not always
 *                                     Clef-Omni; the stored names stay (useClef, TIMMY_CLEF) for compatibility
 *   Allow cloud analysis              off by default: no media item is ever sent while it is off
 *   Require review before dispatch    on by default: every recommendation waits for a person
 *   thresholds                        minTop 0.60, minMargin 0.15 (src/decision/judge.ts)
 *   timeout                           8000 ms per call
 *
 * The operator's rule it keeps: the switches are off, or on the cautious side, until a person turns them; a value out of
 * range is never saved, and one found in the file is replaced by its default with the problem said. It never reads or
 * writes a secret.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { settingsFile } from '../setup/home.js';
import { checkThresholds, DEFAULT_THRESHOLDS, type Thresholds } from './judge.js';

export const DECISION_SETTINGS_SCHEMA = 'timmy.decision-settings/1';

export interface DecisionSettings {
  useClef: boolean;
  allowCloudAnalysis: boolean;
  requireReview: boolean;
  thresholds: Thresholds;
  timeoutMs: number;
}

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = Object.freeze({
  useClef: false,
  allowCloudAnalysis: false,
  requireReview: true,
  thresholds: Object.freeze({ ...DEFAULT_THRESHOLDS }),
  timeoutMs: 8000,
}) as DecisionSettings;

export type SwitchKey = 'useClef' | 'allowCloudAnalysis' | 'requireReview';

export const SETTING_LABELS: ReadonlyArray<{ key: SwitchKey; label: string; about: string }> = [
  { key: 'useClef', label: 'Use decision-model routing', about: 'ask the decision model clef.json names to score the options Timmy built (saved as useClef; TIMMY_CLEF=1 or 0 for one process); off: the existing route is used and no model is asked' },
  { key: 'allowCloudAnalysis', label: 'Allow cloud analysis', about: 'images, audio or video marked not private may be sent with a question; off: no media item is ever sent' },
  { key: 'requireReview', label: 'Require review before dispatch', about: 'every recommendation becomes a NEEDS YOU proposal; nothing is dispatched until a person approves' },
];

/** The timeout's range: a call that can never finish, or one that blocks a route for minutes, is refused. */
export const TIMEOUT_RANGE = { min: 10, max: 120_000 } as const;

type Env = Record<string, string | undefined>;

/** Where the decision settings are kept: beside workbench.json. */
export const decisionSettingsPath = (env: Env = process.env): string => join(dirname(settingsFile(env)), 'decision.json');

export interface DecisionSettingsRead {
  /** What applies now: the saved settings, with TIMMY_CLEF applied. */
  settings: DecisionSettings;
  /** As saved (the defaults for what is not): what a surface edits and saves back. */
  saved: DecisionSettings;
  path: string;
  state: 'saved' | 'none yet' | 'unreadable';
  error?: string;
  useClefFrom: 'environment' | 'saved' | 'default';
  /** Values found out of range in the file, each replaced by its default. */
  problems: string[];
}

const copy = (s: DecisionSettings): DecisionSettings => ({ ...s, thresholds: { ...s.thresholds } });

/** Problems that stop a save, in words; an empty list means the settings may be saved. */
export function checkSettings(s: DecisionSettings): string[] {
  const p = checkThresholds(s.thresholds ?? ({} as Thresholds));
  if (!Number.isInteger(s.timeoutMs) || s.timeoutMs < TIMEOUT_RANGE.min || s.timeoutMs > TIMEOUT_RANGE.max) {
    p.push(`the timeout must be a whole number of milliseconds from ${TIMEOUT_RANGE.min} to ${TIMEOUT_RANGE.max}, not ${String(s.timeoutMs)}`);
  }
  for (const k of ['useClef', 'allowCloudAnalysis', 'requireReview'] as const) if (typeof s[k] !== 'boolean') p.push(`${k} must be true or false`);
  return p;
}

function withEnv(saved: DecisionSettings, from: 'saved' | 'default', env: Env): Pick<DecisionSettingsRead, 'settings' | 'useClefFrom'> {
  const v = env.TIMMY_CLEF?.trim();
  if (v === '1' || v === '0') return { settings: { ...copy(saved), useClef: v === '1' }, useClefFrom: 'environment' };
  return { settings: copy(saved), useClefFrom: from };
}

/** The settings as saved (the defaults for what is not), TIMMY_CLEF applied, and whether the file was there and readable. */
export function readSettings(env: Env = process.env): DecisionSettingsRead {
  const path = decisionSettingsPath(env);
  const defaults = copy(DEFAULT_DECISION_SETTINGS);
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const state = code === 'ENOENT' ? 'none yet' : 'unreadable';
    return { ...withEnv(defaults, 'default', env), saved: defaults, path, state, ...(state === 'unreadable' ? { error: code ?? 'it could not be read' } : {}), problems: [] };
  }
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || v.schema !== DECISION_SETTINGS_SCHEMA) throw new Error('it is not the decision settings file');
  } catch (e) {
    return { ...withEnv(defaults, 'default', env), saved: defaults, path, state: 'unreadable', error: e instanceof Error ? e.message : String(e), problems: [] };
  }
  const problems: string[] = [];
  const bool = (k: SwitchKey): boolean => {
    if (v[k] === undefined) return defaults[k];
    if (typeof v[k] === 'boolean') return v[k] as boolean;
    problems.push(`${k} is not true or false: the default (${String(defaults[k])}) applies`);
    return defaults[k];
  };
  const t = v.thresholds as Partial<Thresholds> | undefined;
  let thresholds = defaults.thresholds;
  if (t !== undefined) {
    const given = { minTop: Number(t?.minTop), minMargin: Number(t?.minMargin) };
    const tp = checkThresholds(given);
    if (tp.length) problems.push(...tp.map((x) => `${x}: the default thresholds apply`));
    else thresholds = given;
  }
  let timeoutMs = defaults.timeoutMs;
  if (v.timeoutMs !== undefined) {
    const n = v.timeoutMs as number;
    if (Number.isInteger(n) && n >= TIMEOUT_RANGE.min && n <= TIMEOUT_RANGE.max) timeoutMs = n;
    else problems.push(`the timeout ${String(v.timeoutMs)} is outside ${TIMEOUT_RANGE.min} to ${TIMEOUT_RANGE.max} ms: the default (${defaults.timeoutMs} ms) applies`);
  }
  const saved: DecisionSettings = { useClef: bool('useClef'), allowCloudAnalysis: bool('allowCloudAnalysis'), requireReview: bool('requireReview'), thresholds, timeoutMs };
  return { ...withEnv(saved, 'saved', env), saved, path, state: 'saved', problems };
}

export type SaveResult = { ok: true; at: string; path: string } | { ok: false; error: string; path: string };

/** Writes the settings: a temporary file, flushed, renamed over the old one. Refused, file untouched, when a value is out of range. */
export function saveSettings(s: DecisionSettings, env: Env = process.env): SaveResult {
  const path = decisionSettingsPath(env);
  const problems = checkSettings(s);
  if (problems.length) return { ok: false, error: `not saved: ${problems.join('; ')}`, path };
  const tmp = join(dirname(path), `.decision.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const at = new Date().toISOString();
  const body = {
    schema: DECISION_SETTINGS_SCHEMA, useClef: s.useClef, allowCloudAnalysis: s.allowCloudAnalysis, requireReview: s.requireReview,
    thresholds: { minTop: s.thresholds.minTop, minMargin: s.thresholds.minMargin }, timeoutMs: s.timeoutMs, saved_at: at,
  };
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    return { ok: true, at, path };
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
    try { rmSync(tmp, { force: true }); } catch { /* not made */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e), path };
  }
}
