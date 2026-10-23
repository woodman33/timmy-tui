/**
 * R11 Phase 2 (H169, item b): the paid model names that were typed into labels, dead code and static lists are gone, each
 * site made honest without renaming anything the operator sees and without a change of behaviour:
 *
 *   - `/models` reads the OpenRouter catalog this computer keeps (free models first), never a list typed into the code;
 *   - `/model fallback` switches to nothing: a model nobody chose is never asked (the operator's order of 2026-10-23);
 *   - the lanes (`/tmux list`, `/tmux add`, the companion's addTmuxSession, switchPaneAgent) are labels that name no model:
 *     nothing there runs one;
 *   - the AgentSwarm's profiles say they are profiles and name no model (the chosen model is used; no surface makes a swarm);
 *   - the ^K palette's models come from the kept catalog (free ones), not five paid names;
 *   - the providers catalog's note on qwen3.8-max says nothing chooses it by default;
 *   - the companion island reads the route's chosen model (no MODEL const), and the old chat entry ships no default model.
 *
 * Nothing is sent anywhere: the words are read, no model is asked, no lane is started (multiplexer 'none').
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../src/agent/core.js';
import { AgentSwarm, PROFILE_NAMES_NO_MODEL, PROFILES } from '../src/agent/multi-agent.js';
import { paletteModels } from '../src/tui/utils/ergonomics.js';
import { listProviders } from '../src/utils/providers.js';
import { handleSlashCommand, modelsCommandWords, NO_FALLBACK_MODEL_WORDS } from '../src/utils/slash-commands.js';

const PAID = /claude-opus|claude-3-5-sonnet|claude-3\.5-sonnet|gpt-5|gpt-4o|gemini-3\.5-flash|gemini-2\.5-flash|qwen3\.8-max|qwen3\.7-max|minimax-m3|kimi-k2\.6|hermes-3-llama|inflection\/pi-3|animoca\/builder|meta\/llama-3\.3|qwen-2\.5-coder/;
let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'h169-honest-'));
  mkdirSync(join(home, 'models'), { recursive: true });
  // FAKE: a catalog this computer keeps (as `timmy models --refresh` writes it): one free model, one priced
  writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-20T00:00:00.000Z', models: [
    { id: 'fake-maker/fake-free:free', name: 'FAKE free', context_length: 32768, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'fake-maker/fake-paid', name: 'FAKE paid', context_length: 128000, pricing: { prompt: '0.000003', completion: '0.000015' }, supported_parameters: ['tools'] },
  ] }));
  vi.stubEnv('TIMMY_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const agent = (model = '') => createAgent({ apiKey: '', model, instructions: '', maxSteps: 1, maxCost: 1 }, { multiplexer: 'none' });

describe('the static lists read the kept catalog', () => {
  it('/models lists the catalog this computer keeps, free first, and says no model is chosen until one is', () => {
    const words = modelsCommandWords(agent());
    expect(words).toBe([
      'OpenRouter catalog this computer keeps (fetched, of 2026-10-20): 2 models, 1 free.',
      'Free (the catalog says $0):',
      '• fake-maker/fake-free:free',
      '`timmy models` lists every model with its price.',
      'No model is chosen: nothing is sent until one is (/model use <model_id>).',
      'Use `/model use <model_id>` to choose; `timmy models --refresh` fetches the current catalog (free).',
    ].join('\n'));
    expect(words).not.toMatch(PAID);
    expect(modelsCommandWords(agent('fake-maker/fake-paid'))).toContain('Chosen for the next turn: fake-maker/fake-paid.');
    // through the slash command itself
    expect(handleSlashCommand('/models', agent(), {})).toBe(words);
  });

  it('the ^K palette offers the kept catalog\'s free models, labelled with their price words, never a paid name typed into the code', () => {
    expect(paletteModels()).toEqual([{ id: 'fake-maker/fake-free:free', label: 'fake-maker/fake-free:free · free (OpenRouter catalog of 2026-10-20)' }]);
    expect(JSON.stringify(paletteModels())).not.toMatch(PAID);
  });
});

describe('no fallback model, no model in a label', () => {
  it('/model fallback switches to nothing and says why', () => {
    const switched: string[] = [];
    expect(handleSlashCommand('/model fallback', agent(), { switchModel: (id: string) => switched.push(id) })).toBe(NO_FALLBACK_MODEL_WORDS);
    expect(NO_FALLBACK_MODEL_WORDS).toBe('No fallback model: a model nobody chose is never asked in place of the one you chose. /model use <model_id> chooses one; /models lists the catalog this computer keeps.');
    expect(switched).toEqual([]);
  });

  it('the lanes are labels that name no model: /tmux list, /tmux add, switchPaneAgent', () => {
    const a = agent();
    expect(a.tmuxSessions.map((s) => s.name)).toEqual(['OpenCode CLI', 'Hermes CLI', 'Pi Daemon', 'Systems MCP', 'jcode', 'Minds CLI']);
    expect(a.tmuxSessions.every((s) => s.model === '')).toBe(true);
    expect(handleSlashCommand('/tmux list', a, {})).toBe(['CLI sessions (memory and cost are not measured):', '[1] OpenCode CLI (no model named)', '[2] Hermes CLI (no model named)', '[3] Pi Daemon (no model named)', '[4] Systems MCP (no model named)', '[5] jcode (no model named)', '[6] Minds CLI (no model named)'].join('\n'));
    expect(handleSlashCommand('/tmux add Pane', a, {})).toBe('Successfully spawned background TMUX session: "Pane" (no model named)');
    expect(a.tmuxSessions.at(-1)).toMatchObject({ name: 'Pane', model: '' });
    expect(handleSlashCommand('/tmux add Labelled fake/label', a, {})).toBe('Successfully spawned background TMUX session: "Labelled" with the model label fake/label');
    expect(handleSlashCommand('/tmux list', a, {})).toContain('[8] Labelled (label: fake/label)');
    // a pane switched to an agent: the label names no model; the OpenRouter pane's label is the chosen model, or none
    a.switchPaneAgent('1', 'hermes');
    expect(a.tmuxSessions[0]).toMatchObject({ name: 'Hermes CLI', model: '' });
    a.switchPaneAgent('1', 'openrouter');
    expect(a.tmuxSessions[0]).toMatchObject({ name: 'OpenRouter Agent', model: '' });
    const chosen = agent('fake-maker/fake-free:free');
    chosen.switchPaneAgent('1', 'openrouter');
    expect(chosen.tmuxSessions[0].model).toBe('fake-maker/fake-free:free');
    expect(JSON.stringify(a.tmuxSessions)).not.toMatch(PAID);
  });

  it('the swarm\'s profiles say they are profiles and name no model; the swarm uses the model its caller chose', () => {
    for (const p of Object.values(PROFILES)) expect(p).toMatchObject({ kind: 'profile', model: '' });
    expect(Object.keys(PROFILES)).toEqual(['orchestrator', 'code-review', 'research', 'generate', 'chat']);
    expect(PROFILE_NAMES_NO_MODEL).toBe('a profile names no model: the chosen model is used');
    const swarm = new AgentSwarm({ apiKey: '', model: 'fake-maker/fake-free:free', instructions: '', maxSteps: 1, maxCost: 1 } as never);
    expect((swarm as unknown as { orchestrator: { getModel(): string } }).orchestrator.getModel()).toBe('fake-maker/fake-free:free');
    expect(JSON.stringify(PROFILES)).not.toMatch(PAID);
  });

  it('the providers catalog\'s note, the companion island and the old chat entry name no default', () => {
    const qwen = listProviders().find((p) => p.modelId === 'qwen/qwen3.8-max');
    expect(qwen?.notes).toBe('a catalog entry: nothing chooses it by default (no model is chosen until you choose one)');
    const island = readFileSync(join(import.meta.dirname, '..', 'src', 'companion', 'island', 'companion-chat.js'), 'utf8');
    expect(island).not.toContain('qwen3.8-max');
    expect(island).not.toMatch(/const MODEL\b/);
    expect(island).toContain("'Message ' + route.model + ' here: this page’s own chat'");
    const chatmain = readFileSync(join(import.meta.dirname, '..', 'src', 'tui', 'chatmain.tsx'), 'utf8');
    expect(chatmain).not.toMatch(PAID);
    expect(chatmain).toContain("model: String(cfg.model || process.env.TIMMY_MODEL || '')");
  });
});
