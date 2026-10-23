/**
 * R11 (H169, Phase 0 item 1; the operator's order of 2026-10-23: no default paid model anywhere): the one rule for which
 * OpenRouter model is chosen for the next turn, from the settings file's fields, the Workbench's own record and the
 * environment. Pure and node-free: src/utils/config.ts loadConfig applies it (the settings store), and the setup
 * (src/utils/init.ts) reads the files by path and applies it without building the store (building it writes the file).
 *
 * There is no shipped default any more. Every version before R11 shipped LEGACY_DEFAULT_MODEL as the settings' model and
 * conf wrote it into the file as a default, so an older file names it whether or not anyone chose it: it counts as chosen
 * only when it was saved as a choice (saveConfig records `modelChosen`) or the Workbench's Models recorded it before R11
 * (workbench.json's openRouterModel). OPENROUTER_MODEL in the environment wins for one process, as it always did.
 */
export const LEGACY_DEFAULT_MODEL = 'anthropic/claude-opus-4.7';

export interface ModelChoiceFacts {
  /** the settings file's fields (conf's store, or the file read by path) */
  settings: { model?: unknown; modelChosen?: unknown } | null | undefined;
  /** the Workbench's own settings (workbench.json beside the settings file), or none */
  workbench?: { openRouterModel?: unknown } | null;
  env?: Record<string, string | undefined>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Whether a legacy shipped default found in the settings is a choice. */
export const legacyDefaultChosen = (f: ModelChoiceFacts): boolean =>
  text(f.settings?.modelChosen) === LEGACY_DEFAULT_MODEL || text(f.workbench?.openRouterModel) === LEGACY_DEFAULT_MODEL;

/** The OpenRouter model chosen for the next turn, or '' when none is. */
export function chosenModel(f: ModelChoiceFacts): string {
  const fromEnv = text(f.env?.OPENROUTER_MODEL);
  if (fromEnv) return fromEnv;
  const model = text(f.settings?.model);
  if (model === LEGACY_DEFAULT_MODEL && !legacyDefaultChosen(f)) return '';
  return model;
}
