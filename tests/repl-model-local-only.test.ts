/**
 * R10 (H169; the lead's decision of 2026-10-22 19:41): `/model local-only [on|off]` in the REPL (src/repl/commands.ts), kept as
 * `/model free-only` is: on and off saved in the settings beside free-only (src/agent/route-policy.ts saveRoutePolicy, the
 * settings' localOnly), no argument says the state, TIMMY_CHAT_LOCAL_ONLY winning for this process is said, and the words are
 * never taken as a model's name (neither the OpenRouter model's nor the local route's). The settings store is this file's own
 * (tests/isolation-setup.ts); nothing is sent anywhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { glyphSet } from '../src/term/glyphs.js';
import { COMMANDS, runSlash, type ReplContext } from '../src/repl/commands.js';
import { localOnlyOn } from '../src/agent/route-policy.js';
import { settingsFile } from '../src/utils/model-key.js';

const ON = '  Local-only: on · OpenRouter and Ollama Cloud are refused, and so are a cloud model and another computer\'s Ollama; Ollama on this computer answers';
const OFF = '  Local-only: off · /model local-only on refuses OpenRouter, Ollama Cloud and any model not on this computer';
const ENV_WINS = '  TIMMY_CHAT_LOCAL_ONLY is set in this environment and wins over this setting.';

/** A REPL context whose model setter and local route's list record what they were asked (both must stay empty here). */
function repl(): { c: ReplContext; printed: string[]; asked: string[]; set: string[] } {
  const printed: string[] = [];
  const asked: string[] = [];
  const set: string[] = [];
  const c: ReplContext = {
    agent: { getModel: () => 'fake-maker/fake-model', setModel: (m) => { set.push(m); }, startSession: () => 's1' },
    print: (segments) => printed.push(segments.map((s) => s.text).join('')),
    glyphs: glyphSet(false),
    // the local route, as the REPL gives it when the chat is set to Ollama: it would take any other words as a model's name
    chatModel: (args) => { asked.push(args); return Promise.resolve([[{ text: `  FAKE local list for "${args}"` }]]); },
  };
  return { c, printed, asked, set };
}

const saved = (): unknown => (existsSync(settingsFile()) ? (JSON.parse(readFileSync(settingsFile(), 'utf8')) as { localOnly?: unknown }).localOnly : undefined);

beforeEach(() => { vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', ''); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('/model local-only', () => {
  it('on: saved in the settings beside free-only, and said in the policy\'s words', async () => {
    const { c, printed, asked, set } = repl();
    expect(await runSlash('/model local-only on', c)).toBe('handled');
    expect(printed).toEqual([ON]);
    expect(saved()).toBe(true);
    expect(localOnlyOn()).toBe(true);
    expect([asked, set]).toEqual([[], []]);
  });

  it('off: saved, and said', async () => {
    const { c, printed, asked, set } = repl();
    await runSlash('/model local-only on', c);
    printed.length = 0;
    expect(await runSlash('/model local-only off', c)).toBe('handled');
    expect(printed).toEqual([OFF]);
    expect(saved()).toBe(false);
    expect(localOnlyOn()).toBe(false);
    expect([asked, set]).toEqual([[], []]);
  });

  it('no argument: the state, at once, and nothing saved; the variable that wins for this process is said', async () => {
    const { c, printed } = repl();
    await runSlash('/model local-only off', c);
    const before = readFileSync(settingsFile(), 'utf8');
    printed.length = 0;
    // no save to wait for: the state is said at once
    expect(runSlash('/model local-only', c)).toBe('handled');
    expect(printed).toEqual([OFF]);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);
    printed.length = 0;
    vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '1');
    expect(runSlash('/model local-only', c)).toBe('handled');
    expect(printed).toEqual([ON, ENV_WINS]);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);
  });

  it('a save while TIMMY_CHAT_LOCAL_ONLY is set is kept, and the line says the variable still wins', async () => {
    const { c, printed } = repl();
    vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', 'on');
    await runSlash('/model local-only off', c);
    expect(saved()).toBe(false);
    expect(printed).toEqual([ON, ENV_WINS]);
  });

  it('is never taken as a model\'s name: not the OpenRouter model\'s, not the local route\'s list', async () => {
    const { c, printed, asked, set } = repl();
    for (const line of ['/model local-only on', '/model local-only off', '/model local-only', '/model   local-only   on']) await runSlash(line, c);
    expect(asked).toEqual([]);
    expect(set).toEqual([]);
    expect(printed.every((l) => l.startsWith('  Local-only: '))).toBe(true);
    // words that are not the command are still the local route's to read, as before
    await runSlash('/model local-only-fake:8b', c);
    expect(asked).toEqual(['local-only-fake:8b']);
  });

  it('is named in /model\'s line of /help, within its 60 columns', () => {
    const { c, printed } = repl();
    runSlash('/help', c);
    expect(COMMANDS.find((x) => x.name === 'model')?.description).toBe('Model, price; <id>|free|free-only|local-only');
    expect(printed).toContain('  /model       Model, price; <id>|free|free-only|local-only');
    expect(printed.filter((l) => l.length > 60)).toEqual([]);
  });
});
