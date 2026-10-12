/**
 * R4 (H110): the Workbench's Quick settings, kept in Timmy's settings folder (src/setup/home.ts settingsFile: TIMMY_SETTINGS_DIR,
 * else the account's own), in a file of their own: workbench.json, beside the monitor's config.json and never inside it.
 * Each save writes a temporary file (0600) in that folder, flushes it, and renames it over the old one, so a reader sees the
 * old settings or the new ones, never half of either. "Saved locally" is said only once that rename has happened.
 *
 * The startup choices (Open Companion at startup, Open Studio at startup) are kept apart from Show, which acts now: showing
 * the Companion never changes whether it opens at startup. They apply only to an interactive `timmy workbench`.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { settingsFile } from '../setup/home.js';
import type { WorkspaceId } from './nav.js';
import { NAV_ORDER } from './nav.js';

export const SETTINGS_SCHEMA = 'timmy.workbench-settings/1';

export type RightTab = 'tools' | 'inspector' | 'files';
export const RIGHT_TABS: readonly RightTab[] = ['tools', 'inspector', 'files'];

export interface SavedLayout { workspace: WorkspaceId; tab: RightTab; activity: boolean }

export interface WorkbenchSettings {
  openCompanionAtStart: boolean;
  openStudioAtStart: boolean;
  /** another surface's project choice (the REPL's /project) moves this Workbench too */
  followActiveProject: boolean;
  /** a run that starts selects itself in Activity and the Inspector (the workspace never changes by itself) */
  followSelectedArtifact: boolean;
  /** the workspace, right tab and Activity are restored per project at the next start */
  rememberLayout: boolean;
  /** no spinner and no moving text */
  reducedMotion: boolean;
  /** per project id, when rememberLayout is on */
  layouts: Record<string, SavedLayout>;
}

export type SettingKey = Exclude<keyof WorkbenchSettings, 'layouts'>;

export const SETTING_LABELS: ReadonlyArray<{ key: SettingKey; label: string; about: string }> = [
  { key: 'openCompanionAtStart', label: 'Open Companion at startup', about: 'when timmy workbench starts at a terminal; Show acts now and does not change this' },
  { key: 'openStudioAtStart', label: 'Open Studio at startup', about: 'when timmy workbench starts at a terminal; Show acts now and does not change this' },
  { key: 'followActiveProject', label: 'Follow active project', about: 'a project chosen in the REPL or the monitor moves this Workbench too' },
  { key: 'followSelectedArtifact', label: 'Follow selected artifact', about: 'a run that starts is selected in Activity and the Inspector' },
  { key: 'rememberLayout', label: 'Remember layout', about: 'the workspace, tab and Activity come back per project' },
  { key: 'reducedMotion', label: 'Reduced motion', about: 'no spinner; running work is said in words only' },
];

export const DEFAULT_SETTINGS: WorkbenchSettings = {
  openCompanionAtStart: false, openStudioAtStart: false, followActiveProject: true, followSelectedArtifact: false,
  rememberLayout: true, reducedMotion: false, layouts: {},
};

export type PresetId = 'terminal-only' | 'connected' | 'full-studio';
export const PRESETS: ReadonlyArray<{ id: PresetId; label: string; about: string; set: Partial<WorkbenchSettings> }> = [
  { id: 'terminal-only', label: 'Terminal only', about: 'nothing else opens at startup', set: { openCompanionAtStart: false, openStudioAtStart: false } },
  { id: 'connected', label: 'Connected', about: 'the Companion opens at startup', set: { openCompanionAtStart: true, openStudioAtStart: false } },
  { id: 'full-studio', label: 'Full Studio', about: 'the Companion and Studio open at startup', set: { openCompanionAtStart: true, openStudioAtStart: true } },
];

type Env = Record<string, string | undefined>;

/** Where the Workbench's settings are kept. */
export const settingsPath = (env: Env = process.env): string => join(dirname(settingsFile(env)), 'workbench.json');

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

export interface SettingsRead { settings: WorkbenchSettings; path: string; state: 'saved' | 'none yet' | 'unreadable'; error?: string }

/** The settings as saved (the defaults for what is not), and whether the file was there and readable. */
export function readSettings(env: Env = process.env): SettingsRead {
  const path = settingsPath(env);
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { settings: { ...DEFAULT_SETTINGS, layouts: {} }, path, state: 'none yet' } : { settings: { ...DEFAULT_SETTINGS, layouts: {} }, path, state: 'unreadable', error: code ?? 'it could not be read' };
  }
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || v.schema !== SETTINGS_SCHEMA) throw new Error('it is not the Workbench\'s settings file');
    const layouts: Record<string, SavedLayout> = {};
    const given = v.layouts && typeof v.layouts === 'object' ? v.layouts as Record<string, unknown> : {};
    for (const [id, l] of Object.entries(given)) {
      const o = l as Record<string, unknown>;
      if (!/^[0-9a-f]{16}$/.test(id) || !o || typeof o !== 'object') continue;
      if (!NAV_ORDER.includes(o.workspace as WorkspaceId) || !RIGHT_TABS.includes(o.tab as RightTab)) continue;
      layouts[id] = { workspace: o.workspace as WorkspaceId, tab: o.tab as RightTab, activity: o.activity === true };
    }
    const d = DEFAULT_SETTINGS;
    return {
      path, state: 'saved',
      settings: {
        openCompanionAtStart: bool(v.openCompanionAtStart, d.openCompanionAtStart), openStudioAtStart: bool(v.openStudioAtStart, d.openStudioAtStart),
        followActiveProject: bool(v.followActiveProject, d.followActiveProject), followSelectedArtifact: bool(v.followSelectedArtifact, d.followSelectedArtifact),
        rememberLayout: bool(v.rememberLayout, d.rememberLayout), reducedMotion: bool(v.reducedMotion, d.reducedMotion), layouts,
      },
    };
  } catch (e) {
    return { settings: { ...DEFAULT_SETTINGS, layouts: {} }, path, state: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
}

export type SaveResult = { ok: true; at: string; path: string } | { ok: false; error: string; path: string };

/** Writes the settings: a temporary file, flushed, renamed over the old one. "Saved" only when the rename happened. */
export function saveSettings(s: WorkbenchSettings, env: Env = process.env): SaveResult {
  const path = settingsPath(env);
  const tmp = join(dirname(path), `.workbench.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const at = new Date().toISOString();
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify({ schema: SETTINGS_SCHEMA, ...s, saved_at: at }, null, 2)}\n`);
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
