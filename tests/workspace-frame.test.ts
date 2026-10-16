// R5 lead (2026-10-15, the operator's completion order): the one workspace frame the terminal Workbench, the browser companion
// and Timmy Studio share. These drive the producer with FAKE records and FAKE service answers: nothing leaves the process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TABS, WORKSPACE_SCHEMA, tabByKey, type WorkspaceFrame } from '../src/contracts/workspace.js';
import {
  CONNECTIONS_SCHEMA, LIVE_FOR_MS, actionsOf, buildWorkspaceFrame, checkConnections, connectionOf, connectionsPath, readConnections, sentences, writeConnections,
} from '../src/ops/workspace-frame.js';
import { workspaceLines, workspaceMain } from '../src/ops/workspace-cli.js';
import { takeTurnHold } from '../src/agent/chat-turn.js';

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
    expect(c.words).toBe('not running when checked under a minute ago; s starts it');
  });
  it('an optional service nobody chose that does not answer is not set up, with its step, not a failure', () => {
    const c = connectionOf('ollama', 'Ollama', { ...base, configured: false, setupWords: 'optional: run Ollama', check: { answer: 'no answer', at: at(2000), detail: 'connection refused' } });
    expect(c.state).toBe('not set up');
    expect(c.words).toBe('nothing answered when checked under a minute ago (connection refused); optional: run Ollama');
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
    expect(next?.command).toBe('timmy setup');
    expect(f.actions.chat[0].enabled).toBe(false);
    expect(f.unknown.map((u) => u.field)).toContain('chat');
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
    expect(lines).toContain('▸ 1 Set up chat: an OpenRouter key or a local model: timmy setup');
    expect(lines).toMatch(/Revision [0-9a-f]{16}/);
    expect(lines).not.toContain('\x1b[');
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
    expect(a.connections.find((c) => c.id === 'studio')?.words).toContain('under a minute ago');
    const c = await frame(NOW + 70_000);
    expect(c.connections.find((x) => x.id === 'studio')?.words).toContain('1 min ago');
  });
  it('each tab carries its purpose', async () => {
    const f = await frame();
    for (const t of f.tabs) expect(t.purpose, t.id).toBe(TABS.find((x) => x.id === t.id)?.purpose);
  });
});
