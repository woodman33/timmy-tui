// R5 lead (2026-10-15, the operator's completion order): the one workspace frame the terminal Workbench, the browser companion
// and Timmy Studio share. These drive the producer with FAKE records and FAKE service answers: nothing leaves the process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TABS, WORKSPACE_SCHEMA, tabByKey, type WorkspaceFrame } from '../src/contracts/workspace.js';
import {
  CONNECTIONS_SCHEMA, LIVE_FOR_MS, actionsOf, buildWorkspaceFrame, chatFix, chatNotReady, checkConnections, connectionOf, connectionsPath, noteAnswered, noteStopped, ollamaAddress, readConnections, sentences, turnStopCommand, turnStopWords, writeConnections,
} from '../src/ops/workspace-frame.js';
import { freeOnlyRefusal } from '../src/agent/model-price.js';
import { workspaceLines, workspaceMain } from '../src/ops/workspace-cli.js';
import { takeTurnHold } from '../src/agent/chat-turn.js';
import { projectId } from '../src/project/index.js';

let home: string;
let project: string;
let env: Record<string, string | undefined>;
const NOW = Date.parse('2026-10-15T20:00:00.000Z');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tw-frame-'));
  project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  env = { HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_SETTINGS_DIR: join(home, 'settings'), PATH: process.env.PATH };
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const frame = (now = NOW): Promise<WorkspaceFrame> => buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => [], onPath: () => null, now });

describe('the tabs', () => {
  it('are ten, keyed 1 to 9 then 0, each with a label, the Workbench workspaces it gathers and its references', () => {
    expect(TABS.map((t) => t.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(new Set(TABS.map((t) => t.id)).size).toBe(10);
    for (const t of TABS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.workbench.length).toBeGreaterThan(0);
      expect(t.refs.length).toBeGreaterThan(0);
    }
    expect(tabByKey('0')?.id).toBe('logs');
    expect(tabByKey('x')).toBeUndefined();
  });
  it('cover every one of the operator\'s 18 references at least once', () => {
    const refs = new Set(TABS.flatMap((t) => t.refs));
    for (let i = 1; i <= 18; i++) expect(refs.has(String(i).padStart(2, '0')), `reference ${i}`).toBe(true);
  });
  // R7 lead (the operator, 2026-10-16 22:08 PT): "Keep 3D/Motion, Control Room, Fleet/Clef and Logs/Receipts visibly unfinished
  // until their intended interactions work."
  it('R7 lead: 3D & Motion, Control Room, Fleet & Clef and Logs & Receipts say they are unfinished: what works now, and what does not yet', async () => {
    const unfinished = TABS.filter((t) => t.unfinished).map((t) => t.id);
    expect(unfinished).toEqual(['create', 'control', 'fleet', 'logs']);
    for (const t of TABS.filter((x) => x.unfinished)) {
      expect(t.unfinished!.works.length, t.id).toBeGreaterThan(20);
      expect(t.unfinished!.missing.length, t.id).toBeGreaterThan(20);
    }
    expect(TABS.find((t) => t.id === 'fleet')!.unfinished!.missing).toContain('on HOLD');
    // the frame every surface draws carries the same words, and none on a tab whose interactions work
    const f = await frame();
    for (const t of f.tabs) expect(t.unfinished, t.id).toEqual(TABS.find((x) => x.id === t.id)!.unfinished);
    expect(f.tabs.filter((t) => t.unfinished).map((t) => t.id)).toEqual(['create', 'control', 'fleet', 'logs']);
  });
});

describe('a connection', () => {
  const base = { configured: true, setupWords: 'run timmy setup', setup: 'timmy workspace check', now: NOW };
  const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
  it('is live only when a request it answered was observed within the window, and says when', () => {
    const c = connectionOf('ollama', 'Ollama', { ...base, check: { answer: 'accepted', at: at(60_000), detail: '2 models listed' } });
    expect(c.state).toBe('live');
    expect(c.observedAt).toBe(at(60_000));
    expect(c.words).toContain('answered 1 min ago');
    expect(c.words).toContain('2 models listed');
  });
  it('is configured, not live, once the answer is older than the window, and asks for a new check', () => {
    const c = connectionOf('ollama', 'Ollama', { ...base, check: { answer: 'accepted', at: at(LIVE_FOR_MS + 60_000) } });
    expect(c.state).toBe('configured');
    expect(c.words).toContain('check again');
  });
  it('a setting alone is configured, never live', () => {
    const c = connectionOf('openrouter', 'OpenRouter', base);
    expect(c.state).toBe('configured');
    expect(c.observedAt).toBeNull();
    expect(c.words).toContain('a setting is not a connection');
  });
  it('says refused for an answered no, unreachable for no answer, and not set up with its step when nothing is set', () => {
    expect(connectionOf('openrouter', 'OpenRouter', { ...base, check: { answer: 'refused', at: at(1000) } }).state).toBe('refused');
    expect(connectionOf('studio', 'Studio', { ...base, check: { answer: 'no answer', at: at(1000) } }).state).toBe('unreachable');
    const none = connectionOf('openrouter', 'OpenRouter', { ...base, configured: false });
    expect(none.state).toBe('not set up');
    expect(none.words).toBe('run timmy setup');
  });
  it('a surface started on demand that is not running is set up, not failed, and says how to start it', () => {
    const c = connectionOf('studio', 'Studio', { ...base, startWords: 's starts it', check: { answer: 'not running', at: at(5000) } });
    expect(c.state).toBe('configured');
    expect(c.words).toBe('not running when checked just now; s starts it');
  });
  it('an optional service nobody chose that does not answer is not set up, with its step, not a failure', () => {
    const c = connectionOf('ollama', 'Ollama', { ...base, configured: false, setupWords: 'optional: run Ollama', check: { answer: 'no answer', at: at(2000), detail: 'connection refused' } });
    expect(c.state).toBe('not set up');
    expect(c.words).toBe('nothing answered when checked just now (connection refused); optional: run Ollama');
    expect(c.observedAt).toBe(at(2000));
  });
  it('ignores an observation whose time is not a time', () => {
    expect(connectionOf('ollama', 'Ollama', { ...base, check: { answer: 'accepted', at: 'yesterday' } }).state).toBe('configured');
  });
});

describe('the frame', () => {
  it('carries the schema, the project without its folder\'s full path, the ten tabs and every tab\'s actions', async () => {
    const f = await frame();
    expect(f.schema).toBe(WORKSPACE_SCHEMA);
    expect(f.project.name).toBe('proj');
    expect(f.project.shown.startsWith('~')).toBe(true);
    expect(f.project.id).toMatch(/^[0-9a-f]{16}$/);
    expect(f.tabs.map((t) => t.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    for (const t of f.tabs) expect(f.actions[t.id].length, t.id).toBeGreaterThan(0);
    expect(JSON.stringify(f)).not.toContain(home);
  });
  it('has at most one primary next step per tab, and no primary action that is not enabled', async () => {
    const f = await frame();
    for (const t of f.tabs) {
      const primary = f.actions[t.id].filter((a) => a.primary);
      expect(primary.length, t.id).toBeLessThanOrEqual(1);
      for (const a of primary) expect(a.enabled, `${t.id}: ${a.label}`).toBe(true);
      for (const a of f.actions[t.id]) {
        expect(a.command.trim().length, a.label).toBeGreaterThan(0);
        if (!a.enabled) expect(a.why, a.label).toBeTruthy();
      }
    }
  });
  it('with no chat route, makes setup the one next step and says chat is not known', async () => {
    const f = await frame();
    const next = f.actions.home.find((a) => a.primary);
    expect(next?.command).toBe('timmy init --chat openrouter');
    expect(f.actions.chat[0].enabled).toBe(false);
    expect(f.unknown.map((u) => u.field)).toContain('chat');
    // R5 lead (H131's note): said as a state, with the frame's one step; never as a message "not sent"
    const why = f.unknown.find((u) => u.field === 'chat')!.why;
    expect(why).toBe('No chat route yet: no OpenRouter key, and the chat is not set to a local model. timmy init --chat openrouter asks for a key (typed hidden); timmy init --chat local --model <name> uses a model your Ollama lists.');
    // R5 lead (H131's finding): never `timmy setup`, which scaffolds a folder and asks nothing
    expect(JSON.stringify(f.actions)).not.toContain('timmy setup');
  });
  it('names one fix for each thing that keeps chat from answering, never "turn free-only off" (the finish line, item 3)', () => {
    // no route at all: the setup, which asks for a key hidden
    expect(chatFix({ kind: 'none', ready: false })).toMatchObject({ problem: 'no-route', command: 'timmy init --chat openrouter' });
    // the local model, none chosen: choose among what Ollama lists
    const noModel = ['Error: the chat is set to the local model, and no model is chosen.', 'Cause: the setup recorded none.', 'Try: /model', 'Nothing was sent to any model.'];
    expect(chatFix({ kind: 'local', ready: false, refusal: noModel })).toMatchObject({ problem: 'no-local-model', command: '/model' });
    // the local model at an address Timmy does not use: set the address
    const badHost = ['Error: the chat is set to the local model, and its Ollama address is not one Timmy uses.', 'Cause: x.', 'Try: /setup chat'];
    expect(chatFix({ kind: 'local', ready: false, refusal: badHost })).toMatchObject({ problem: 'ollama-address', command: '/setup chat' });
    // the local route ready, but Ollama did not answer when checked: start it, then check again
    const down = [{ id: 'ollama', state: 'unreachable' as const, words: 'no answer when checked 3 min ago (asked at http://127.0.0.1:11434)' }];
    expect(chatFix({ kind: 'local', ready: true }, down)).toMatchObject({ problem: 'ollama-unreachable', command: 'timmy workspace check' });
    expect(chatFix({ kind: 'local', ready: true }, [{ id: 'ollama', state: 'live', words: 'answered just now' }])).toBeNull();
    // free-only on, the model not known to be free: choose a free model; free-only stays on
    const lines = freeOnlyRefusal('m/x', { free: false, words: '$1 per million (FAKE)' } as never, true)!;
    const free = chatFix({ kind: 'openrouter', ready: false, refusal: lines })!;
    expect(free).toMatchObject({ problem: 'free-only', command: '/model free' });
    expect(`${free.label} ${free.command}`).not.toMatch(/free-only off|TIMMY_CHAT_FREE_ONLY=0/);
    // a key OpenRouter refused when checked: give a working one, hidden
    // (with a key stored, timmy init --chat openrouter asks nothing and keeps it: H131's finding; --openrouter - replaces it)
    expect(chatFix({ kind: 'openrouter', ready: true }, [{ id: 'openrouter', state: 'refused', words: 'refused when checked just now' }])).toMatchObject({ problem: 'key-refused', command: 'timmy init --openrouter -' });
    expect(chatFix({ kind: 'openrouter', ready: true }, [])).toBeNull();
  });
  it('offers no "start Ollama" or "give a key" fix when a turn on that route answered after the check that saw it fail (the rehearsal)', () => {
    const checked = '2026-10-15T18:00:00.000Z';
    const after = '2026-10-15T18:05:00.000Z';
    const later = '2026-10-15T18:06:00.000Z';
    const before = '2026-10-15T17:55:00.000Z';
    const down = [{ id: 'ollama', state: 'unreachable' as const, words: 'no answer when checked 20 min ago', observedAt: checked }];
    const local = { kind: 'local', ready: true } as const;
    // an Ollama turn (its receipt names the endpoint, on this computer or off it) answered after the check: no fix
    expect(chatFix(local, down, [{ state: 'answered', at: after, local: true }])).toBeNull();
    expect(chatFix(local, down, [{ state: 'answered', at: after, local: false }])).toBeNull();
    // a turn stopped since says nothing about the route: the answered one before it still outdates the check
    expect(chatFix(local, down, [{ state: 'stopped', at: later, local: true }, { state: 'answered', at: after, local: true }])).toBeNull();
    // a turn that failed since: the check stands
    expect(chatFix(local, down, [{ state: 'failed', at: later, local: true }, { state: 'answered', at: after, local: true }])).toMatchObject({ problem: 'ollama-unreachable' });
    // answered before the check, only stopped or failed turns after it, an OpenRouter turn, or no turn: the check stands
    expect(chatFix(local, down, [{ state: 'answered', at: before, local: true }])).toMatchObject({ problem: 'ollama-unreachable' });
    expect(chatFix(local, down, [{ state: 'stopped', at: after, local: true }])).toMatchObject({ problem: 'ollama-unreachable' });
    expect(chatFix(local, down, [{ state: 'failed', at: after, local: true }])).toMatchObject({ problem: 'ollama-unreachable' });
    expect(chatFix(local, down, [{ state: 'answered', at: after }])).toMatchObject({ problem: 'ollama-unreachable' });
    expect(chatFix(local, down, [])).toMatchObject({ problem: 'ollama-unreachable' });
    // a check with no time is never outdated by a turn
    expect(chatFix(local, [{ id: 'ollama', state: 'unreachable', words: 'x' }], [{ state: 'answered', at: after, local: true }])).toMatchObject({ problem: 'ollama-unreachable' });
    // the key: an OpenRouter turn (no Ollama endpoint) answered after the refusal outdates it; an Ollama turn does not
    const refused = [{ id: 'openrouter', state: 'refused' as const, words: 'refused when checked 20 min ago', observedAt: checked }];
    const cloud = { kind: 'openrouter', ready: true } as const;
    expect(chatFix(cloud, refused, [{ state: 'answered', at: after }])).toBeNull();
    expect(chatFix(cloud, refused, [{ state: 'answered', at: later, local: true }, { state: 'answered', at: after }])).toBeNull();
    expect(chatFix(cloud, refused, [{ state: 'answered', at: after, local: true }])).toMatchObject({ problem: 'key-refused' });
    expect(chatFix(cloud, refused, [{ state: 'answered', at: before }])).toMatchObject({ problem: 'key-refused' });
  });
  it('drops "Start Ollama" from Home and Chat once a newer Ollama turn answered, and keeps it while the check is the newest word', () => {
    const wb = { activity: { waiting_on_you: 0, running: 0, stop_current: { job: null, words: '' } }, workflows: { docs: [] }, jobs: [],
      route: { kind: 'local', words: 'chat: qwen3:8b (FAKE)', ready: true } } as unknown as Parameters<typeof actionsOf>[0];
    const connections = [{ id: 'ollama', state: 'unreachable' as const, words: 'no answer when checked 20 min ago', observedAt: '2026-10-15T18:00:00.000Z' }];
    const stale = actionsOf(wb, [], { connections });
    expect(stale.home.filter((x) => x.primary)).toEqual([expect.objectContaining({ command: 'timmy workspace check' })]);
    const fresh = actionsOf(wb, [], { connections, recentTurns: [{ state: 'stopped', at: '2026-10-15T18:06:00.000Z', local: true }, { state: 'answered', at: '2026-10-15T18:05:00.000Z', local: true }] });
    expect(fresh.home.find((x) => x.primary)?.command).not.toBe('timmy workspace check');
    expect(fresh.chat.find((x) => x.primary)?.command).not.toBe('timmy workspace check');
  });
  it('makes the fix Home\'s and Chat\'s one next step, and says it on Send while it is off', () => {
    const wb = { activity: { waiting_on_you: 0, running: 0, stop_current: { job: null, words: '' } }, workflows: { docs: [] }, jobs: [],
      route: { kind: 'openrouter', words: 'chat: m/x · free-only: not sent', ready: false, refusal: freeOnlyRefusal('m/x', { free: false, words: '$1 per million (FAKE)' } as never, true)! } } as unknown as Parameters<typeof actionsOf>[0];
    const a = actionsOf(wb);
    expect(a.home.filter((x) => x.primary)).toEqual([expect.objectContaining({ command: '/model free' })]);
    expect(a.chat.filter((x) => x.primary)).toEqual([expect.objectContaining({ command: '/model free' })]);
    expect(a.chat[0]).toMatchObject({ enabled: false, why: expect.stringContaining('/model free') });
  });
  it('says why chat is not ready as a state: a refusal\'s "not sent" words are a message\'s, not the frame\'s', () => {
    const lines = freeOnlyRefusal('m/x', { free: false, words: '$1 per million (FAKE)' } as never, true)!;
    const why = chatNotReady({ kind: 'openrouter', refusal: lines });
    expect(why).toMatch(/^Free-only is on, and m\/x is not known to be free\. Cause: m\/x costs \$1 per million\. Try: /);
    expect(why).not.toMatch(/not sent|Nothing was sent|Error:/);
    expect(chatNotReady({ kind: 'local', refusal: [] })).toBe('The chat route is not ready.');
  });
  it('carries the project\'s sealed chat turns, every surface\'s, newest first, in the words every log uses (the finish line, item 3)', async () => {
    const id = projectId(project);
    const hash = (n: number) => `sha256_${String(n).repeat(64).slice(0, 64)}`;
    // FAKE receipts as the seal writes them (src/repl/seal.ts): a Workbench turn on this computer's Ollama, stopped; a REPL
    // turn on OpenRouter, answered; another project's turn, which is not this one's
    const chain = [
      { kind: 'turn', subject: 'repl · 1 step', project_id: id, status: 'ok', ts: '2026-10-15T19:58:00.000Z', ms: 1200, model_resolved: 'm/free:free', operation_id: 'o11111111', hash: hash(1) },
      { kind: 'chat', subject: 'chat.turn · workbench · cancelled · 0 steps · qwen3:8b', project_id: id, status: 'cancelled', ts: '2026-10-15T19:59:00.000Z', ms: 4100, via: 'ollama', sources: [{ kind: 'ollama', host: '127.0.0.1:11434', endpoint: 'local', tools: 'off', cost_basis: 'local endpoint' }], model_resolved: 'qwen3:8b', operation_id: 'o22222222', hash: hash(2) },
      { kind: 'chat', subject: 'chat.turn · workbench · 0 steps · qwen3:8b', project_id: 'ffffffffffffffff', status: 'ok', ts: '2026-10-15T19:59:30.000Z', hash: hash(3) },
    ];
    const f = await buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => chain as never, onPath: () => null, now: NOW });
    expect(f.chat?.turns).toEqual([
      // R6 (H140): a stopped turn always says who asked (its own surface when no other one did)
      { receipt: '22222222', surface: 'workbench', state: 'stopped', model: 'qwen3:8b', at: '2026-10-15T19:59:00.000Z', ms: 4100, operation: 'o22222222', route: 'local', words: 'turn stopped (asked from the Workbench) in the Workbench · qwen3:8b · receipt 22222222 · 4.1 s' },
      { receipt: '11111111', surface: 'repl', state: 'answered', model: 'm/free:free', at: '2026-10-15T19:58:00.000Z', ms: 1200, operation: 'o11111111', route: 'openrouter', words: 'turn answered in the REPL · m/free:free · receipt 11111111 · 1.2 s' },
    ]);
    // a receipt keeps hashes only, and so does the frame
    expect(JSON.stringify(f.chat)).not.toMatch(/prompt|response_hash|sha256_/);
    // no turn sealed yet: an empty list, never a made-up one
    expect((await frame()).chat).toEqual({ turns: [] });
  });
  it('lists every connection, none live without an observation, the two MCP routes unknown', async () => {
    const f = await frame();
    const ids = f.connections.map((c) => c.id);
    expect(ids).toEqual(['openrouter', 'ollama', 'cloudflare', 'clef', 'cloudroom', 'companion', 'studio', 'mcp-sdk', 'mcporter']);
    expect(f.connections.filter((c) => c.state === 'live')).toEqual([]);
    expect(f.connections.find((c) => c.id === 'openrouter')?.state).toBe('not set up');
    expect(f.connections.find((c) => c.id === 'mcp-sdk')?.state).toBe('unknown');
    expect(f.connections.find((c) => c.id === 'mcporter')?.state).toBe('unknown');
  });
  it('R6 lead (H146\'s finding): says each MCP route from the project\'s own newest call record: live within the bound, older configured, failed unreachable', async () => {
    const { writeMcpCall } = await import('../src/connectors/mcp-records.js');
    const { appendReceipt, readChain } = await import('../src/utils/receipts.js');
    const seal = (input: Parameters<typeof appendReceipt>[1]): string => appendReceipt('runs', input, project).hash.slice(7, 15);
    const call = (route: 'sdk' | 'mcporter', at: number, outcome: 'answered' | 'failed', tool: string): void => {
      const w = writeMcpCall({ root: project, project: 'proj', seal }, {
        route, server: { name: 'node fake-fixture-server.js', transport: 'stdio' }, tool, args: { text: 'FAKE' },
        startedAt: new Date(at - 1500).toISOString(), endedAt: new Date(at).toISOString(), ms: 1500, outcome, called: true,
        isError: outcome === 'answered' ? false : null, ...(outcome === 'failed' ? { error: 'FAKE: the server closed' } : {}),
        annotations: null, notes: ['FAKE: written by tests/workspace-frame.test.ts'],
      });
      expect(w.ok).toBe(true);
    };
    // the SDK route answered 2 min ago, then (older) mcporter answered 2 h ago; a failed mcporter call older still
    call('mcporter', NOW - 3 * 3600_000, 'failed', 'fake_fail');
    call('mcporter', NOW - 2 * 3600_000, 'answered', 'fake_echo');
    call('sdk', NOW - 2 * 60_000, 'answered', 'fake_echo');
    const chain = readChain('runs', project);
    const f = await buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => chain, onPath: () => null, now: NOW });
    const sdk = f.connections.find((c) => c.id === 'mcp-sdk')!;
    const mcporter = f.connections.find((c) => c.id === 'mcporter')!;
    expect(sdk).toMatchObject({ state: 'live', observedAt: new Date(NOW - 2 * 60_000).toISOString(), words: expect.stringMatching(/^a call through it answered 2 min ago; live: /) });
    expect(sdk.detail).toMatch(/^fake_echo on node fake-fixture-server\.js; its record sealed by receipt [0-9a-f]{8}$/);
    expect(mcporter).toMatchObject({ state: 'configured', words: 'a call through it answered 2 h ago; a new call shows it now' });
    // a failed call, the newest of its route: unreachable, with what failed
    call('mcporter', NOW - 60_000, 'failed', 'fake_fail');
    const g = await buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => readChain('runs', project), onPath: () => null, now: NOW });
    expect(g.connections.find((c) => c.id === 'mcporter')).toMatchObject({ state: 'unreachable', words: 'the newest call through it failed 1 min ago', detail: expect.stringContaining('fake_fail on node fake-fixture-server.js (FAKE: the server closed)') });
  });
  it('gives the same revision for the same records, a new one when a record changes, and never counts its own time', async () => {
    const a = await frame(NOW);
    const b = await frame(NOW);
    expect(a.revision).toBe(b.revision);
    expect(a.revision).toMatch(/^[0-9a-f]{16}$/);
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { ollama: { answer: 'accepted', at: new Date(NOW - 1000).toISOString() } } }, env);
    const c = await frame(NOW);
    expect(c.revision).not.toBe(a.revision);
    expect(c.connections.find((x) => x.id === 'ollama')?.state).toBe('live');
  });
  it('reads the observations a check wrote; studio live makes the Studio surface running with its address', async () => {
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { studio: { answer: 'accepted', at: new Date(NOW - 5000).toISOString(), detail: 'running' } } }, env);
    const f = await frame();
    expect(f.surfaces.studio.state).toBe('running');
    expect(f.surfaces.studio.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    expect(f.surfaces.companion.state).toBe('unknown');
  });
  it('with nothing run yet, says the log is not known rather than showing an empty log as quiet', async () => {
    const f = await frame();
    expect(f.log).toEqual([]);
    expect(f.unknown.find((u) => u.field === 'log')?.why).toContain('no job has run');
  });
});

describe('the primary next step follows the records', () => {
  const wb = (o: { ready: boolean; waiting: number; running: number; docs?: Array<{ rel: string; blocks: Array<{ name: string; needs_person: boolean }> }> }) => ({
    route: { ready: o.ready }, activity: { waiting_on_you: o.waiting, running: o.running, stop_current: { job: null, words: 'Stop current: idle' } },
    workflows: { docs: (o.docs ?? []).map((d) => ({ rel: d.rel, blocks: d.blocks.map((b) => ({ ...b, state: '', needs: [] })) })) }, jobs: [],
  }) as unknown as Parameters<typeof actionsOf>[0];
  it('waiting on you: Home sends you to what waits, Control Room makes deciding the next step', () => {
    const a = actionsOf(wb({ ready: true, waiting: 2, running: 0 }));
    expect(a.home[0]).toMatchObject({ primary: true, command: '/room' });
    expect(a.control[0]).toMatchObject({ primary: true, label: 'Decide what waits (2)' });
  });
  it('a chat route and nothing waiting: Continue in Chat (its key), and sending is enabled', () => {
    const a = actionsOf(wb({ ready: true, waiting: 0, running: 0 }));
    expect(a.home[0]).toMatchObject({ primary: true, command: '2' });
    expect(a.chat[0]).toMatchObject({ primary: true, enabled: true });
  });
  it('a workflow block and nothing running: run it is the Workflows tab\'s next step; Stop current is disabled with why', () => {
    const a = actionsOf(wb({ ready: true, waiting: 0, running: 0, docs: [{ rel: 'plan.up.md', blocks: [{ name: 'build', needs_person: false }] }] }));
    expect(a.workflows[0]).toMatchObject({ primary: true, command: '/run plan.up.md build' });
    expect(a.workflows[2]).toMatchObject({ enabled: false, why: 'nothing runs' });
  });
  it('R5 lead: with Studio running, Studio\'s next step is to have Timmy draw on it, not to open it again', () => {
    expect(actionsOf(wb({ ready: true, waiting: 0, running: 0 })).studio[0]).toMatchObject({ label: 'Open Studio', command: '/studio', primary: true });
    expect(actionsOf(wb({ ready: true, waiting: 0, running: 0 }), [], { studioRunning: true }).studio[0]).toMatchObject({ command: '/canvas open', primary: true });
  });
  // R7 lead (H147's R6 finding 2; the operator: "Make Studio's primary action reflect the actual next step when a draft is waiting")
  it('R7 lead: while a draft waits on the board, Studio\'s one next step is its Accept or Discard, opened or not', () => {
    const open = actionsOf(wb({ ready: true, waiting: 1, running: 0 }), [], { studioRunning: true, drafts: 1 });
    expect(open.studio[0]).toMatchObject({ label: 'Accept or discard the draft Timmy proposed', command: 'Accept or Discard on the draft, in Studio', primary: true, enabled: true });
    expect(open.studio.filter((x) => x.primary)).toHaveLength(1);
    expect(open.studio.map((x) => x.command)).not.toContain('/canvas open');
    const closed = actionsOf(wb({ ready: true, waiting: 1, running: 0 }), [], { drafts: 2 });
    expect(closed.studio[0]).toMatchObject({ label: 'Accept or discard the 2 drafts Timmy proposed', command: '/studio, then Accept or Discard on the draft', primary: true });
    // none waiting: as before
    expect(actionsOf(wb({ ready: true, waiting: 0, running: 0 }), [], { studioRunning: true, drafts: 0 }).studio[0]).toMatchObject({ command: '/canvas open', primary: true });
  });
  it('R7 lead: the frame reads the drafts from the project\'s saved board, as the waiting count does', async () => {
    const dir = join(home, 'timmy', 'canvas', 'projects', projectId(project));
    mkdirSync(dir, { recursive: true });
    const draft = (id: string, n: number) => ({ id: `shape:${id}`, typeName: 'shape', type: 'geo', meta: { timmyDraft: { id: `draft-0000000${n}`, job: `cj-${n}` } } });
    writeFileSync(join(dir, 'canvas.json'), JSON.stringify({ format: 'timmy-canvas', snapshot: { store: { 'shape:a': draft('a', 1), 'shape:b': draft('b', 1) } } }));
    const f = await frame();
    expect(f.actions.studio[0]).toMatchObject({ label: 'Accept or discard the draft Timmy proposed', primary: true });
    expect(f.activity.waitingOnYou).toBe(1);
  });
  // R7 lead (H148's N3: "While the REPL answers, the primary is ▶ 3 Stop the turn … Yet Enter … stops the REPL's turn at once")
  it('R7 lead: Stop the turn names the one surface that stops it (the one that sent the turn), so no other surface runs it on a key', () => {
    const a = actionsOf(wb({ ready: true, waiting: 0, running: 0 }), [{ surface: 'repl' }]);
    expect(a.chat[2]).toMatchObject({ label: 'Stop the turn', command: turnStopCommand('repl'), primary: true, doneIn: 'repl' });
    expect(actionsOf(wb({ ready: true, waiting: 0, running: 0 }), [{ surface: 'companion' }]).chat[2]).toMatchObject({ doneIn: 'companion' });
    const idle = actionsOf(wb({ ready: true, waiting: 0, running: 0 }));
    expect(idle.chat[2]).toMatchObject({ enabled: false });
    expect(idle.chat[2].doneIn).toBeUndefined();
    for (const tab of Object.values(idle)) for (const x of tab) expect(x.doneIn, x.label).toBeUndefined();
  });
  it('R5 lead: "needs you" has one meaning: Workflows counts what waits on a person now, never the blocks that ask first', () => {
    const docs = [{ rel: 'APPROVAL.md', blocks: [{ name: 'tidy', needs_person: true }] }];
    const quiet = actionsOf(wb({ ready: true, waiting: 0, running: 0, docs }));
    expect(quiet.workflows[1]).toMatchObject({ label: 'Review the last run', primary: false });
    expect(JSON.stringify(quiet)).not.toMatch(/needs you/i);
    const waits = actionsOf(wb({ ready: true, waiting: 2, running: 0, docs }));
    expect(waits.workflows[1]).toMatchObject({ label: 'Answer what waits on you (2)', command: '/room', primary: true });
    expect(waits.workflows.filter((x) => x.primary)).toHaveLength(1);
  });
});

describe('timmy workspace check', () => {
  it('asks each service once through what it was given, records what answered (0600), and never keeps the key', async () => {
    const asked: string[] = [];
    const { path, record } = await checkConnections({
      env, cwd: project, now: () => NOW,
      key: () => 'sk-or-FAKE-not-a-key',
      openRouter: async (k) => { asked.push(`openrouter:${k ? 'with a key' : 'no key'}`); return 'accepted'; },
      ollama: async () => { asked.push('ollama'); return { ok: false, models: [], answer: { state: 'no answer', why: 'connection refused' } }; },
      studio: async (u) => { asked.push(`studio:${u}`); return { state: 'running', pageConnected: true }; },
      companion: async (u) => { asked.push(`companion:${u}`); return 401; },
      edge: async () => { asked.push('edge'); return 200; },
    });
    expect(path).toBe(connectionsPath(env));
    expect(asked.slice(0, 4)).toEqual(['openrouter:with a key', 'ollama', expect.stringMatching(/^studio:http:\/\/127\.0\.0\.1:\d+/), 'companion:http://127.0.0.1:3001/']);
    expect(record.checks.companion).toMatchObject({ answer: 'accepted', detail: 'running' });
    expect(record.checks.openrouter).toMatchObject({ answer: 'accepted' });
    expect(record.checks.ollama).toMatchObject({ answer: 'no answer', detail: 'connection refused' });
    expect(record.checks.studio).toMatchObject({ answer: 'accepted', detail: 'running, a page is open' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('sk-or-FAKE');
    expect(readConnections(env).checks.studio?.answer).toBe('accepted');
    const f = await frame(NOW + 1000);
    expect(f.connections.find((c) => c.id === 'openrouter')?.state).toBe('live');
    // nobody chose the local model here: nothing answering is "not set up", with its step, never a failure
    expect(f.connections.find((c) => c.id === 'ollama')).toMatchObject({ state: 'not set up', words: expect.stringContaining('nothing answered') });
    expect(f.connections.find((c) => c.id === 'studio')?.state).toBe('live');
    expect(f.surfaces.companion).toMatchObject({ state: 'running', url: 'http://127.0.0.1:3001/' });
  });
  it('asks the Ollama the local chat asks (the setup\'s recorded address), and names it on the card; else OLLAMA_HOST, else the default (H131\'s finding)', async () => {
    expect(ollamaAddress(env)).toBe('http://127.0.0.1:11434');
    env.OLLAMA_HOST = 'http://127.0.0.1:11500';
    expect(ollamaAddress(env)).toBe('http://127.0.0.1:11500');
    // FAKE: a setup record that chose the local chat at its own address (as applySetup writes it); nothing is asked
    mkdirSync(join(home, 'timmy'), { recursive: true });
    writeFileSync(join(home, 'timmy', 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'FAKE', chat: 'local', ollama: 'http://127.0.0.1:47011', model: 'qwen3:8b' } }));
    expect(ollamaAddress(env)).toBe('http://127.0.0.1:47011');
    let asked = '';
    await checkConnections({
      env, cwd: project, now: () => NOW, key: () => null, openRouter: async () => 'no-key',
      ollama: async () => { asked = ollamaAddress(env); return { ok: true, models: ['qwen3:8b'] }; },
      studio: async () => ({ state: 'not-running' }), companion: async () => 'refused', edge: async () => null,
    });
    expect(asked).toBe('http://127.0.0.1:47011');
    const f = await frame(NOW + 1000);
    expect(f.connections.find((c) => c.id === 'ollama')).toMatchObject({ state: 'live', detail: expect.stringContaining('asked at http://127.0.0.1:47011') });
  });
  it('a chosen local model that does not answer is unreachable; Studio and the companion not started are set up, not running', async () => {
    env.OLLAMA_HOST = 'http://127.0.0.1:11434';
    env.TIMMY_COMPANION_PORT = '3101';
    const asked: string[] = [];
    await checkConnections({
      env, cwd: project, now: () => NOW, key: () => null, openRouter: async () => 'no-key',
      ollama: async () => ({ ok: false, models: [], answer: { state: 'no answer', why: 'connection refused' } }),
      studio: async () => ({ state: 'not-running' }),
      companion: async (u) => { asked.push(u); return 'refused'; },
      edge: async () => null,
    });
    expect(asked).toEqual(['http://127.0.0.1:3101/']);
    const f = await frame(NOW + 1000);
    expect(f.connections.find((c) => c.id === 'ollama')?.state).toBe('unreachable');
    for (const id of ['studio', 'companion'] as const) {
      expect(f.connections.find((c) => c.id === id), id).toMatchObject({ state: 'configured', words: expect.stringContaining('not running when checked') });
      expect(f.surfaces[id].state).toBe('not running');
    }
    expect(f.connections.filter((c) => c.state === 'unreachable').map((c) => c.id)).toEqual(['ollama']);
  });
  it('with no key asks nothing of OpenRouter and drops an old observation of it, so the frame says not set up', async () => {
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { openrouter: { answer: 'accepted', at: new Date(NOW - 1000).toISOString() } } }, env);
    const { record } = await checkConnections({
      env, cwd: project, now: () => NOW, key: () => null,
      openRouter: async (k) => (k ? 'accepted' : 'no-key'),
      ollama: async () => ({ ok: true, models: ['qwen3.8:27b-mlx'] }),
      studio: async () => ({ state: 'not-running' }),
      companion: async () => 'refused',
      edge: async () => null,
    });
    expect(record.checks.openrouter).toBeUndefined();
    expect(record.checks.ollama).toMatchObject({ answer: 'accepted', detail: '1 local model' });
    expect(record.checks.studio).toMatchObject({ answer: 'not running' });
    expect(record.checks.companion).toMatchObject({ answer: 'not running' });
    const f = await frame(NOW + 1000);
    expect(f.connections.find((c) => c.id === 'openrouter')?.state).toBe('not set up');
  });
  it('an unreadable record counts as nothing observed', () => {
    mkdirSync(join(env.TIMMY_HOME!, 'state'), { recursive: true });
    writeFileSync(connectionsPath(env), '{not json');
    expect(readConnections(env).checks).toEqual({});
  });
});

describe('the command', () => {
  it('prints every state with its word and mark, the next step, the actions by tab and the revision', async () => {
    const lines = workspaceLines(await frame()).join('\n');
    expect(lines).toContain('Next     Set up chat');
    expect(lines).toContain('· not set up');
    expect(lines).toContain('? unknown');
    expect(lines).toContain('▸ 1 Set up chat: an OpenRouter key (asked hidden) or a local model: timmy init --chat openrouter');
    expect(lines).toMatch(/Revision [0-9a-f]{16}/);
    expect(lines).not.toContain('\x1b[');
  });
  it('R6 (H140; the R5 interaction review, defect 10): prints the chat turns in words, how each ended and who asked, a turn being answered first', async () => {
    const id = projectId(project);
    const hash = (n: number) => `sha256_${String(n).repeat(64).slice(0, 64)}`;
    // FAKE receipts as the seal writes them: a REPL turn the companion stopped, a Workbench turn stopped there, one answered
    const chain = [
      { kind: 'turn', subject: 'repl · 1 step', project_id: id, status: 'ok', ts: '2026-10-15T19:57:00.000Z', ms: 900, model_resolved: 'qwen3:8b', hash: hash(1) },
      { kind: 'chat', subject: 'chat.turn · workbench · cancelled · 0 steps · qwen3:8b', project_id: id, status: 'cancelled', ts: '2026-10-15T19:58:00.000Z', ms: 4400, model_resolved: 'qwen3:8b', operation_id: 'o22222222', hash: hash(2) },
      { kind: 'turn', subject: 'repl · cancelled · 0 steps', project_id: id, status: 'cancelled', stopped_by: 'companion', ts: '2026-10-15T19:59:00.000Z', ms: 2200, model_resolved: 'qwen3:8b', hash: hash(3) },
    ];
    const t = takeTurnHold(project, 'repl');
    expect(t.ok).toBe(true);
    try {
      const f = await buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => chain as never, onPath: () => null, now: NOW });
      const lines = workspaceLines(f);
      const at = lines.findIndex((l) => l.startsWith('Chat turns'));
      expect(lines[at]).toBe('Chat turns (3 sealed, 1 being answered; every surface\'s, read from their receipts)');
      expect(lines[at + 1]).toMatch(/^ {2}▶ running {2}a chat turn is being answered in the REPL · since \d{4}-\d{2}-\d{2}T/);
      expect(lines.slice(at + 2, at + 5)).toEqual([
        '  ■ 2026-10-15T19:59:00.000Z  turn stopped (asked from the companion) in the REPL · qwen3:8b · receipt 33333333 · 2.2 s',
        '  ■ 2026-10-15T19:58:00.000Z  turn stopped (asked from the Workbench) in the Workbench · qwen3:8b · receipt 22222222 · 4.4 s  (op o22222222)',
        '  ✓ 2026-10-15T19:57:00.000Z  turn answered in the REPL · qwen3:8b · receipt 11111111 · 0.9 s',
      ]);
      // the job word never names a chat turn
      expect(lines.slice(at, at + 5).join('\n')).not.toMatch(/cancel/i);
    } finally {
      if (t.ok) t.hold.release();
    }
    // no turn at all: said, never an empty block
    const none = workspaceLines(await frame());
    expect(none[none.findIndex((l) => l.startsWith('Chat turns')) + 1]).toBe('  none sealed yet: a turn is listed once its receipt is sealed, whichever surface sent it');
  });
  it('refuses an unknown verb with the usage and exit 2', async () => {
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
    try { expect(await workspaceMain(['launch'])).toBe(2); } finally { (process.stderr as unknown as { write: typeof write }).write = write; }
    expect(chunks.join('')).toContain('Usage: timmy workspace [check] [--json] [--help]');
  });
});

describe('R5 lead: H131\'s contract notes', () => {
  it('a refusal said as one paragraph ends each line as a sentence, so "…/model in the REPL" never runs into the next line', () => {
    expect(sentences(['Error: no model is chosen.', 'Try: timmy init --chat local --model <name>, or /model in the REPL', 'Nothing was sent to any model.']))
      .toBe('Error: no model is chosen. Try: timmy init --chat local --model <name>, or /model in the REPL. Nothing was sent to any model.');
    expect(sentences(['  ', 'Cause: none recorded (see above)'])).toBe('Cause: none recorded (see above)');
  });
  it('a frame can be read for the project the caller names, whichever project another surface made active', async () => {
    const other = join(home, 'other');
    mkdirSync(other, { recursive: true });
    mkdirSync(join(home, 'timmy', 'state'), { recursive: true });
    writeFileSync(join(home, 'timmy', 'state', 'active-project.json'), JSON.stringify({ name: 'other', root: other }));
    const saved = process.env.TIMMY_HOME;
    process.env.TIMMY_HOME = env.TIMMY_HOME;
    try {
      const active = await buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => [], onPath: () => null, now: NOW });
      expect(active.project.name).toBe('other');
      const named = await buildWorkspaceFrame({ env, cwd: project, project: { name: 'proj', root: project }, jobs: () => [], chain: () => [], onPath: () => null, now: NOW });
      expect(named.project.name).toBe('proj');
      expect(named.project.id).not.toBe(active.project.id);
    } finally {
      if (saved === undefined) delete process.env.TIMMY_HOME; else process.env.TIMMY_HOME = saved;
    }
  });
  it('Home lists its connections first, as every surface draws it', () => {
    expect(TABS[0]).toMatchObject({ id: 'home', workbench: ['connections', 'overview'] });
  });
});

describe('R5 lead: a chat turn being answered (the independent review, defect 1)', () => {
  it('counts as running: Stop the turn becomes the Chat tab\'s one next step, a second message waits, Stop current names the turn', async () => {
    const t = takeTurnHold(project, 'workbench');
    expect(t.ok).toBe(true);
    try {
      const f = await frame();
      expect(f.activity.running).toBe(1);
      expect(f.activity.chatTurn).toMatchObject({ surface: 'workbench' });
      expect(f.activity.stopCurrent.words).toMatch(/^Stop current: the chat turn in .*Workbench.*\(Esc in its composer\)$/);
      const chat = f.actions.chat;
      expect(chat[0]).toMatchObject({ label: 'Send a message', enabled: false, primary: false });
      expect(chat[0].why).toMatch(/^one turn at a time: a turn is being answered in /);
      expect(chat[2]).toMatchObject({ label: 'Stop the turn', enabled: true, primary: true });
      expect(chat.filter((a) => a.primary)).toHaveLength(1);
    } finally {
      if (t.ok) t.hold.release();
    }
    const after = await frame();
    expect(after.activity.running).toBe(0);
    expect(after.activity.chatTurn).toBeNull();
    expect(after.actions.chat[2]).toMatchObject({ enabled: false, primary: false });
  });
});

describe('R5 lead: H132\'s notes on the frame', () => {
  it('a revision does not tick with the clock: the same records a few seconds apart give the same revision', async () => {
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { studio: { answer: 'accepted', at: new Date(NOW - 5_000).toISOString(), detail: 'running' } } }, env);
    const a = await frame(NOW);
    const b = await frame(NOW + 20_000);
    expect(b.revision).toBe(a.revision);
    expect(a.connections.find((c) => c.id === 'studio')?.words).toContain('just now');
    const c = await frame(NOW + 70_000);
    expect(c.connections.find((x) => x.id === 'studio')?.words).toContain('1 min ago');
  });
  it('each tab carries its purpose', async () => {
    const f = await frame();
    for (const t of f.tabs) expect(t.purpose, t.id).toBe(TABS.find((x) => x.id === t.id)?.purpose);
  });
});

describe('R5 lead: the QA round on the installed build (defects 3, 4, 9)', () => {
  const noModel = ['Error: the chat is set to the local model, and no model is chosen.', 'Cause: the setup recorded none.', 'Try: /model', 'Nothing was sent to any model.'];
  it('with no local model chosen and Ollama not answering, starting Ollama comes before choosing a model (defect 3)', () => {
    const down = [{ id: 'ollama', state: 'unreachable' as const, words: 'no answer when checked 2 min ago', observedAt: '2026-10-15T19:58:00.000Z' }];
    const fix = chatFix({ kind: 'local', ready: false, refusal: noModel }, down)!;
    expect(fix).toMatchObject({ problem: 'ollama-unreachable', command: 'timmy workspace check', effect: 'network' });
    expect(fix.words).toMatch(/start it \(ollama serve\), check again, then choose one with \/model\.$/);
    // R6 (H140): how it is started fits this computer (no program here, Linux: its install, never Homebrew)
    const linux = chatFix({ kind: 'local', ready: true }, down, [], { start: 'install Ollama: ollama.com/download/linux; then ollama pull <model>' })!;
    expect(linux.words).toBe('Ollama: no answer when checked 2 min ago. Start it (install Ollama: ollama.com/download/linux; then ollama pull <model>), then check again.');
    expect(linux.words).not.toMatch(/brew/);
    // Ollama answered (or not checked yet): choose the model among what it lists
    expect(chatFix({ kind: 'local', ready: false, refusal: noModel }, [{ id: 'ollama', state: 'live', words: 'answered just now' }])).toMatchObject({ problem: 'no-local-model', command: '/model' });
    expect(chatFix({ kind: 'local', ready: false, refusal: noModel }, [{ id: 'ollama', state: 'configured', words: 'set up, not checked yet' }])).toMatchObject({ problem: 'no-local-model' });
  });
  it('a check that asked another Ollama address than the chat asks now says nothing about this one (defect 3)', async () => {
    mkdirSync(join(home, 'timmy'), { recursive: true });
    writeFileSync(join(home, 'timmy', 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'FAKE', chat: 'local', ollama: 'http://127.0.0.1:47011', model: 'qwen3:8b' } }));
    // FAKE: the last check asked the default address, before the setup named another
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { ollama: { answer: 'no answer', at: new Date(NOW - 120_000).toISOString(), detail: 'connection refused', asked: 'http://127.0.0.1:11434' } } }, env);
    const f = await frame();
    const o = f.connections.find((c) => c.id === 'ollama')!;
    expect(o).toMatchObject({ state: 'configured', observedAt: null });
    expect(o.detail).toBe('asked at http://127.0.0.1:47011, no charge (local); not checked at this address yet (the last check asked http://127.0.0.1:11434)');
    // the check records the address it asked, so the same reading counts for that address
    await checkConnections({
      env, cwd: project, now: () => NOW, key: () => null, openRouter: async () => 'no-key',
      ollama: async () => ({ ok: false, models: [], answer: { state: 'no answer', why: 'connection refused' } }),
      studio: async () => ({ state: 'not-running' }), companion: async () => 'refused', edge: async () => null,
    });
    expect(readConnections(env).checks.ollama).toMatchObject({ answer: 'no answer', asked: 'http://127.0.0.1:47011' });
    expect((await frame(NOW + 1000)).connections.find((c) => c.id === 'ollama')?.state).toBe('unreachable');
  });
  it('an observation counts only for the key or address it asked: a key replaced since, or a port moved, is not said refused or live (the operator\'s 22:32 order, item 1)', async () => {
    mkdirSync(join(home, 'timmy'), { recursive: true });
    const providers = join(home, 'timmy', 'providers.json');
    writeFileSync(providers, JSON.stringify({ openrouter_api_key: 'sk-or-v1-FAKE-key-one-for-a-test' }));
    env.TIMMY_COMPANION_PORT = '3101';
    await checkConnections({
      env, cwd: project, now: () => NOW, key: () => 'sk-or-v1-FAKE-key-one-for-a-test', openRouter: async () => 'rejected',
      ollama: async () => ({ ok: false, models: [], answer: { state: 'no answer', why: 'connection refused' } }),
      studio: async () => ({ state: 'not-running' }), companion: async () => 'refused', edge: async () => null,
    });
    const rec = readConnections(env).checks;
    // the record names the key by a fingerprint, never the key
    expect(rec.openrouter).toMatchObject({ answer: 'refused', asked: expect.stringMatching(/^key [0-9a-f]{12}$/) });
    expect(JSON.stringify(rec)).not.toContain('FAKE-key-one');
    expect(rec.companion).toMatchObject({ answer: 'not running', asked: 'http://127.0.0.1:3101' });
    const before = await frame(NOW + 1000);
    expect(before.connections.find((c) => c.id === 'openrouter')?.state).toBe('refused');
    // a new key (timmy init --openrouter - writes it there): the refusal was of the other key
    writeFileSync(providers, JSON.stringify({ openrouter_api_key: 'sk-or-v1-FAKE-key-two-for-a-test' }));
    // the companion asked at another port now
    env.TIMMY_COMPANION_PORT = '3102';
    const after = await frame(NOW + 2000);
    const or = after.connections.find((c) => c.id === 'openrouter')!;
    expect(or).toMatchObject({ state: 'configured', observedAt: null });
    expect(or.detail).toMatch(/not checked with this key yet \(the last check asked with another key\)$/);
    expect(after.connections.find((c) => c.id === 'companion')).toMatchObject({ state: 'configured', observedAt: null, detail: expect.stringMatching(/not checked at this address yet \(the last check asked http:\/\/127\.0\.0\.1:3101\)$/) });
    // no "give a working key" fix for a key nobody checked
    expect(after.actions.home.find((x) => x.primary)?.command).not.toBe('timmy init --openrouter -');
  });
  it('a surface notes that it answered and that it stopped, so none says it answered after it ended (defects 4, 19)', async () => {
    expect(noteAnswered('companion', 'its page asked for its frame', env, NOW)).toBe(true);
    expect((await frame(NOW + 1000)).connections.find((c) => c.id === 'companion')).toMatchObject({ state: 'live', words: expect.stringContaining('its page asked for its frame') });
    expect(noteStopped('companion', env, NOW + 2000)).toBe(true);
    const after = (await frame(NOW + 3000)).connections.find((c) => c.id === 'companion')!;
    expect(after).toMatchObject({ state: 'configured', words: expect.stringMatching(/^not running when checked just now; c in the Workbench, or timmy watch, starts it$/) });
    // and starting again is an answer again (the throttle counts only an answer)
    expect(noteAnswered('companion', 'it started listening', env, NOW + 4000)).toBe(true);
  });
  it('a turn being answered is matched to its receipt by its identity (turn_id), never by surface and time: a delayed receipt, a next turn taken at once (the operator\'s 22:32 order, item 1)', async () => {
    const id = projectId(project);
    const t = takeTurnHold(project, 'repl');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    try {
      expect(t.hold.id).toMatch(/^t[0-9]+-[0-9a-f]{8}$/);
      const receipt = (turn: string | undefined, ts: string, n: number) => ({ kind: 'turn', subject: 'repl · 1 step', project_id: id, status: 'ok', ts, ms: 900, model_resolved: 'qwen3:8b', operation_id: `o${String(n).repeat(8)}`, hash: `sha256_${String(n).repeat(64)}`, ...(turn ? { turn_id: turn } : {}) });
      const build = (chain: unknown[]) => buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => chain as never, onPath: () => null, now: NOW });
      const later = new Date(Date.now() + 60_000).toISOString();
      // the turn before it, sealed with its own id even a minute after this hold was taken (clocks, a slow seal): this one runs
      const running = await build([receipt('t1-0000000a', later, 3)]);
      expect(running.activity.running).toBe(1);
      expect(running.activity.chatTurn).toMatchObject({ surface: 'repl', id: t.hold.id });
      // and a receipt that names no turn (sealed before turn ids) says nothing about it
      expect((await build([receipt(undefined, later, 4)])).activity.chatTurn?.id).toBe(t.hold.id);
      // Stop current names the REPL's own key (it has no composer), and so does Stop the turn
      expect(running.activity.stopCurrent.words).toBe('Stop current: the chat turn in the REPL (Ctrl+C in the REPL)');
      expect(running.actions.chat[2]).toMatchObject({ label: 'Stop the turn', primary: true, command: 'Ctrl+C in the REPL that sent it' });
      // its own receipt sealed while its hold is still there (the hold goes a moment after the seal): ended, whatever its time
      const ended = await build([receipt(t.hold.id, '2026-01-01T00:00:00.000Z', 5)]);
      expect(ended.activity.running).toBe(0);
      expect(ended.activity.chatTurn).toBeNull();
      expect(ended.chat?.turns[0]).toMatchObject({ turn: t.hold.id, state: 'answered' });
    } finally {
      t.hold.release();
    }
    // the hold given back and no receipt yet (a surface that seals after its turn): nothing runs, and no turn is made up
    expect((await frame()).activity.chatTurn).toBeNull();
    expect(turnStopWords('workbench')).toBe('Esc in its composer');
    expect(turnStopCommand('workbench')).toBe('Esc in the composer that sent it (the Workbench)');
    expect(turnStopCommand('companion')).toBe('Stop on the companion page that sent it');
  });
});
