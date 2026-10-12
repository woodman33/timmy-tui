// R4 (H103, D1, D7, D10), in a real terminal (tmux): the monitor's chat (`timmy watch`, ShellV2's drawer) sends nothing it
// was not asked to send, and says where everything happens.
//
// r25 read in the code (D1, suspected) that the monitor's chat sent any text but /setup, /studio and /model test to the agent,
// with no model key too: OpenRouter with an empty key, then the last-resort fallback (a local model nobody chose), while its
// drawer said nothing was sent. Here the monitor runs as the operator runs it (cli.tsx, Ink, in a tmux pane), with:
// - a recording fetch (tests/fixtures/record-fetch-preload.mjs, FAKE network, loaded with node --import): every request the
//   monitor makes through fetch (the OpenRouter SDK's included) is written to a file, and any not to the FAKE Ollama is
//   refused before it leaves the process;
// - a FAKE Ollama (tests/fixtures/fake-ollama-chat.ts: a real HTTP server on 127.0.0.1, no model behind it) as the Ollama the
//   setup names and as OLLAMA_HOST (where the last-resort fallback would look), recording what it is asked.
// The setup's answers are this test's own files (a home `timmy init --yes` made, its chat answer set per test).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MONITOR_STUDIO_WORDS } from '../src/setup/surfaces.js';
import { MONITOR_UNKNOWN_WORDS } from '../src/tui/monitor-chat.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { LOADER, MONITOR, monitorHome, type MonitorHome } from './fixtures/ui-monitor-home.js';

const PRELOAD = pathToFileURL(resolve('tests/fixtures/record-fetch-preload.mjs')).href;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flat = (s: string): string => s.replace(/\s+/g, ' ');

interface Run {
  h: MonitorHome;
  ollama: FakeOllama;
  screen(): string;
  /** every request the monitor made through fetch (the recording fetch's file) */
  fetches(): Array<{ method: string; url: string }>;
  /** the receipts the monitor sealed */
  receipts(): Array<Record<string, unknown>>;
  /** opens the drawer (c) and types a line into it, then Enter */
  chat(line: string): Promise<void>;
  close(): Promise<void>;
}
const runs: Run[] = [];
afterEach(async () => { for (const r of runs.splice(0)) await r.close(); });

/** The monitor on a home whose setup chose `chat` (null: no chat answer), in a `cols` x `rows` terminal. */
async function monitor(o: { cols: number; rows: number; chat: 'openrouter' | 'local' | null; model?: string; ollama: FakeOllama; key?: string }): Promise<Run> {
  const h = monitorHome('initialized', { git: true });
  const home = h.env.TIMMY_HOME!;
  const setupFile = join(home, 'setup.json');
  const setup = JSON.parse(readFileSync(setupFile, 'utf8'));
  const answers = { ...setup.answers, ollama: o.ollama.url };
  delete answers.model;
  if (o.chat === null) delete answers.chat; else answers.chat = o.chat;
  if (o.model !== undefined) answers.model = o.model;
  writeFileSync(setupFile, JSON.stringify({ ...setup, answers }));
  const providersFile = join(home, 'providers.json');
  const providers = existsSync(providersFile) ? JSON.parse(readFileSync(providersFile, 'utf8')) : {};
  writeFileSync(providersFile, JSON.stringify({ ...providers, ollama_host: o.ollama.url }));
  const log = join(h.box, 'fetches.jsonl');
  const env = `OPENROUTER_API_KEY='${o.key ?? ''}' OLLAMA_HOST='${o.ollama.url}' TIMMY_TEST_FETCH_LOG='${log}' TIMMY_TEST_FETCH_ALLOW='${new URL(o.ollama.url).port}'`;
  h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', String(o.cols), '-y', String(o.rows), '-c', h.repo, 'bash', '--norc', '-c',
    `${env} ${process.execPath} --import ${LOADER} --import ${PRELOAD} ${MONITOR} --no-companion; echo EXIT=$?; sleep 60`);
  const run: Run = {
    h, ollama: o.ollama,
    screen: () => h.tmux('capture-pane', '-p', '-t', 't'),
    fetches: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    receipts: () => {
      const file = join(h.env.TIMMY_STORE!, 'runs.jsonl');
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    async chat(line: string) {
      if (!/SOVEREIGN CHAT/.test(run.screen())) {
        h.tmux('send-keys', '-t', 't', 'c');
        await h.waitFor(/SOVEREIGN CHAT/, 15_000);
      }
      h.tmux('send-keys', '-t', 't', '-l', line);
      await sleep(300);
      h.tmux('send-keys', '-t', 't', 'Enter');
    },
    async close() { await o.ollama.close(); await h.dispose(); },
  };
  runs.push(run);
  await h.waitFor(/YOUR JOURNEY/);
  return run;
}
const toModels = (r: Run): Array<{ method: string; url: string }> => r.fetches().filter((f) => /openrouter\.ai/.test(f.url) || new URL(f.url).port === new URL(r.ollama.url).port);
/** Wait until the screen, its whitespace made single spaces, holds `text`. */
async function waitForText(r: Run, text: string, ms = 30_000): Promise<string> {
  for (let i = 0; i < ms / 100; i++) {
    const s = r.screen();
    if (flat(s).includes(text)) return s;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)}:\n${r.screen()}`);
}
const listening = (port: number): Promise<boolean> => new Promise((done) => {
  const s = connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});

describe('the monitor\'s chat and its route, in a real terminal (R4 H103)', () => {
  it('no model key and no local route: the message is refused in the drawer, and nothing is sent to OpenRouter or to an Ollama', async () => {
    const r = await monitor({ cols: 120, rows: 36, chat: 'openrouter', ollama: await startFakeOllama({ models: [{ name: 'granite4.2:latest' }], completions: [() => ({ content: 'FAKE answer nobody asked for' })] }) });
    expect(r.screen().split('\n')[0]).toContain('chat: no model key · /setup');
    await r.chat('hello there');
    await waitForText(r, 'Not sent: no model key, and the chat is not set to the local model, so this message was not sent.');
    const s = flat(r.screen());
    expect(s).toContain('No model key: nothing is sent to a model.');
    expect(s).toContain('Try: timmy init --chat openrouter (it asks for the key, hidden), or the local model: timmy init --chat local --model <name>');
    expect(s).toContain('Nothing was sent to any model.');
    await sleep(3000);
    expect(toModels(r)).toEqual([]);
    expect(r.ollama.requests).toEqual([]);
    expect(r.receipts().filter((x) => x.kind === 'chat')).toEqual([]);
  }, 120_000);

  it('the local route (FAKE Ollama): the top line names the model, the answer streams into the drawer, and no request goes to OpenRouter', async () => {
    const ollama = await startFakeOllama({ models: [{ name: 'qwen3:8b' }], chat: [() => ({ chunks: textChunks('qwen3:8b', ['Hello', ' from the', ' FAKE local model.']), delayMs: 150 })] });
    const r = await monitor({ cols: 120, rows: 36, chat: 'local', model: 'qwen3:8b', ollama });
    expect(r.screen().split('\n')[0]).toContain('chat: local qwen3:8b · Ollama');
    await r.chat('hello');
    await waitForText(r, 'ai: Hello from the FAKE local model.');
    const done = await waitForText(r, 'Answered by qwen3:8b · no charge (local endpoint) · receipt');
    expect(flat(done)).toContain(`Local: qwen3:8b on this computer's Ollama (127.0.0.1:${new URL(ollama.url).port}).`);
    expect(r.fetches().some((f) => /openrouter\.ai/.test(f.url))).toBe(false);
    expect(ollama.requests.map((q) => `${q.method} ${q.path}`)).toEqual(['POST /api/show', 'POST /api/chat']);
    const asked = ollama.chats()[0];
    expect(asked).toMatchObject({ model: 'qwen3:8b', stream: true });
    // the gated tools are offered (a write would ask in the NEEDS YOU box)
    expect(asked.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('write_project_file');
    const sealed = r.receipts().filter((x) => x.kind === 'chat');
    expect(sealed).toHaveLength(1);
    // R4 (H113): the REPL's own seal, the surface and the turn's steps in its subject
    expect(sealed[0]).toMatchObject({ subject: 'chat.turn · monitor · 0 steps · qwen3:8b', status: 'ok', via: 'ollama', model_resolved: 'qwen3:8b', cost_usd: 0, cost_measured: true });
  }, 120_000);

  it('the local route with no model chosen (as `timmy init --yes` leaves it): the top line says so, a message is refused, nothing is sent', async () => {
    const r = await monitor({ cols: 120, rows: 36, chat: 'local', ollama: await startFakeOllama({ models: [{ name: 'qwen3:8b' }] }) });
    expect(r.screen().split('\n')[0]).toContain('chat: local · no model chosen · /setup');
    await r.chat('hello');
    await waitForText(r, 'Not sent: the chat is set to the local model, and no model is chosen.');
    expect(flat(r.screen())).toContain('Try: timmy init --chat local --model <name> (in a terminal: Timmy checks that Ollama lists it), or /model in the REPL');
    await sleep(1500);
    expect(toModels(r)).toEqual([]);
    expect(r.ollama.requests).toEqual([]);
  }, 120_000);

  it('NEEDS YOU in the monitor (D1d): a write the model asks for waits for the person; n runs nothing, y writes the file', async () => {
    const { toolCallChunks } = await import('./fixtures/fake-ollama-chat.js');
    const write = { name: 'write_project_file', arguments: { path: 'notes.md', content: 'from the FAKE model\n' } };
    const ollama = await startFakeOllama({
      models: [{ name: 'qwen3:8b' }],
      chat: [
        () => ({ chunks: toolCallChunks('qwen3:8b', [write]) }), () => ({ chunks: textChunks('qwen3:8b', ['It was not written.']) }),
        () => ({ chunks: toolCallChunks('qwen3:8b', [write]) }), () => ({ chunks: textChunks('qwen3:8b', ['Written.']) }),
      ],
    });
    const r = await monitor({ cols: 120, rows: 36, chat: 'local', model: 'qwen3:8b', ollama });
    await r.chat('write notes.md');
    await waitForText(r, 'NEEDS YOU · write_project_file: notes.md');
    expect(flat(r.screen())).toContain('changes a file in your project');
    await sleep(500);
    r.h.tmux('send-keys', '-t', 't', 'n');
    await waitForText(r, 'ai: It was not written.');
    expect(existsSync(join(r.h.repo, 'notes.md'))).toBe(false);
    // the model was told the call was denied: the tool's answer is an error, and nothing ran
    expect(JSON.parse(ollama.chats()[1].messages.at(-1).content)).toMatchObject({ error: expect.stringContaining('denied write_project_file') });
    await r.chat('write it now');
    await waitForText(r, 'NEEDS YOU · write_project_file: notes.md');
    await sleep(500);
    r.h.tmux('send-keys', '-t', 't', 'y');
    await waitForText(r, 'ai: Written.');
    expect(readFileSync(join(r.h.repo, 'notes.md'), 'utf8')).toBe('from the FAKE model\n');
    const sealed = r.receipts().filter((x) => x.kind === 'chat');
    expect(sealed.map((x) => x.tool_outcomes)).toEqual([[{ name: 'write_project_file', outcome: 'failed' }], [{ name: 'write_project_file', outcome: 'completed' }]]);
    expect(r.fetches().some((f) => /openrouter\.ai/.test(f.url))).toBe(false);
  }, 120_000);

  it('/storyboard runs in the monitor\'s chat (its preview on 127.0.0.1 only), and no model is asked', async () => {
    const busy = await listening(4273);
    const r = await monitor({ cols: 120, rows: 36, chat: 'openrouter', ollama: await startFakeOllama({ models: [{ name: 'granite4.2:latest' }] }) });
    await r.chat('/storyboard a tray demo');
    const s = flat(await waitForText(r, 'Storyboard written under'));
    expect(s).toContain('preview http://127.0.0.1:4273/studio/a-tray-demo/index.html');
    expect(s).toContain('No model was asked.');
    expect(readFileSync(join(r.h.repo, 'studio', 'a-tray-demo', 'STORYBOARD.md'), 'utf8')).toContain('Brief: a tray demo');
    const page = readFileSync(join(r.h.repo, 'studio', 'a-tray-demo', 'index.html'), 'utf8');
    if (busy) console.warn('monitor-chat-route-pty: port 4273 was in use here before the monitor started, so the served preview was not checked');
    else {
      let served: { status: number; body: string } | null = null;
      for (let i = 0; i < 50 && !served; i++) {
        try { const res = await fetch('http://127.0.0.1:4273/studio/a-tray-demo/index.html'); served = { status: res.status, body: await res.text() }; } catch { await sleep(100); }
      }
      expect(served).toEqual({ status: 200, body: page });
    }
    await sleep(1000);
    expect(toModels(r)).toEqual([]);
    expect(r.ollama.requests).toEqual([]);
  }, 120_000);

  it('any other /command: said to be the REPL\'s, and not sent to a model', async () => {
    const r = await monitor({ cols: 120, rows: 36, chat: 'local', model: 'qwen3:8b', ollama: await startFakeOllama({ models: [{ name: 'qwen3:8b' }] }) });
    await r.chat('/frobnicate the widget');
    await waitForText(r, MONITOR_UNKNOWN_WORDS);
    await sleep(1500);
    expect(toModels(r)).toEqual([]);
    expect(r.ollama.requests).toEqual([]);
  }, 120_000);

  it('at 80 columns the flash wraps whole (D7), the top line stays, and the drawer is a full-width band (D10)', async () => {
    const r = await monitor({ cols: 80, rows: 24, chat: 'openrouter', ollama: await startFakeOllama({ models: [] }) });
    await r.chat('/studio');
    const screen = await waitForText(r, MONITOR_STUDIO_WORDS);
    const lines = screen.split('\n');
    // the top line stays (the frame is no taller than the terminal), and no row is wider than it
    expect(lines[0], screen).toMatch(/^TIMMY/);
    expect(lines.every((l) => l.length <= 80), screen).toBe(true);
    // the flash's three rows end with its last words, and the footer is the last row
    expect(lines.findIndex((l) => l.trim() === 'cannot.'), screen).toBeGreaterThan(lines.findIndex((l) => l.includes('[Enter] send · [Esc] leave')));
    expect(lines.filter((l) => l.trim()).at(-1), screen).toMatch(/CHAT\s+sovereign/);
    // the band: from its title to its keys, each row holds the drawer's words only (no card border or HOME words beside them)
    const top = lines.findIndex((l) => l.includes('SOVEREIGN CHAT'));
    const end = lines.findIndex((l) => l.includes('[Enter] send · [Esc] leave'));
    expect(top).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(top);
    for (const l of lines.slice(top, end + 1)) {
      expect(l, `a row of the drawer: ${l}`).not.toMatch(/[│┃┆╎║╭╮╰╯]/);
      expect(l).not.toMatch(/YOUR JOURNEY|LATEST RECEIPT|ACTIVITY/);
    }
  }, 120_000);
});
