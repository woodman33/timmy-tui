/**
 * Pi Durable, slice S1 (R4 H118): the FAKE model. S1 has no real model route: a run's model is pi-ai's in-memory faux
 * provider (no request leaves the process, no key, no cost), scripted from the transcript as H115's spike scripted it
 * (spike/scripts/common.mjs makeFaux): the first answer calls a tool (or streams a long text, for a kill mid-stream);
 * after an "interrupted" result it calls the same tool with the same arguments again (the dangerous retry); after a
 * blocked result, an error or a plain result it answers in text. The script is stored with the run, so a restarted
 * worker answers the same way.
 */
import type { FauxAnswer, FauxSeen } from './adapter/pi-api.js';

export type FauxStep = { readonly text: string; readonly repeat?: number } | { readonly tool: string; readonly args: Record<string, unknown> };

export interface FauxScript {
  readonly first: FauxStep;
  readonly after_result?: FauxStep;
  /** default 'repeat': the same call again */
  readonly after_interrupted?: FauxStep | 'repeat';
  readonly after_blocked?: FauxStep | 'repeat';
  readonly after_error?: FauxStep | 'repeat';
  /** streams the answer at this pace (pi-ai faux tokensPerSecond); unset: at once */
  readonly tokens_per_second?: number;
}

const isStep = (x: unknown): x is FauxStep => {
  const s = x as Record<string, unknown>;
  if (!s || typeof s !== 'object') return false;
  if (typeof s.text === 'string') return s.repeat === undefined || (Number.isInteger(s.repeat) && (s.repeat as number) >= 1 && (s.repeat as number) <= 2000);
  return typeof s.tool === 'string' && !!s.args && typeof s.args === 'object' && !Array.isArray(s.args);
};

/** The script as given, or what is wrong with it. */
export function checkScript(x: unknown): { script: FauxScript } | { error: string } {
  const s = x as Record<string, unknown>;
  if (!s || typeof s !== 'object') return { error: 'the FAKE model needs a script object' };
  if (!isStep(s.first)) return { error: 'script.first must be {text, repeat?} or {tool, args}' };
  for (const k of ['after_result', 'after_interrupted', 'after_blocked', 'after_error'] as const) {
    if (s[k] !== undefined && s[k] !== 'repeat' && !isStep(s[k])) return { error: `script.${k} must be a step or "repeat"` };
  }
  if (s.after_result === 'repeat') return { error: 'script.after_result cannot be "repeat"' };
  if (s.tokens_per_second !== undefined && !(typeof s.tokens_per_second === 'number' && s.tokens_per_second > 0)) return { error: 'script.tokens_per_second must be a positive number' };
  return { script: s as unknown as FauxScript };
}

const stepAnswer = (step: FauxStep): FauxAnswer => ('tool' in step ? { tool: step.tool, args: step.args } : { text: step.text.repeat(step.repeat ?? 1) });

/** What the FAKE model answers, given the last message of its context. */
export function fauxAnswer(script: FauxScript, seen: FauxSeen | undefined): FauxAnswer {
  const pick = (choice: FauxStep | 'repeat' | undefined, fallback: string): FauxAnswer => {
    if (choice === 'repeat') return stepAnswer(script.first);
    if (choice) return stepAnswer(choice);
    return { text: fallback };
  };
  if (!seen || seen.role === 'user') return stepAnswer(script.first);
  if (seen.role === 'toolResult') {
    if (/Tool call blocked|NEEDS YOU/.test(seen.text)) return pick(script.after_blocked, 'Stopped: the earlier call needs a person (FAKE answer).');
    if (/was interrupted/.test(seen.text)) return pick(script.after_interrupted ?? 'repeat', 'Interrupted (FAKE answer).');
    if (/\[error\]|refused/.test(seen.text)) return pick(script.after_error, 'The tool failed (FAKE answer).');
    return pick(script.after_result, 'Done (FAKE answer).');
  }
  return { text: 'Nothing to do (FAKE answer).' };
}
