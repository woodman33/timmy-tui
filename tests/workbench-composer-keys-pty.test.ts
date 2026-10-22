// R10 (H167; H168's pass 1, finding F1, High): in a real terminal (tmux, 122x37, the operator's size), keys meant for the
// Workbench never become a message. While the composer has the keyboard the key-hint row says only the composer's keys, and
// an Esc that stops the turn being answered also leaves the composer. The reviewer's sequence, typed as he typed it: from
// Home, Enter (the composer), a message, Enter (sent: a turn being answered), then Tab, x, Esc, 1, Enter. Before this fix the
// composer kept the keyboard after the Esc, "x1" went into it and the last Enter sent it to the model as a second turn (on a
// paid route that spends money); now the FAKE Ollama is asked once, for the message typed.
//
// FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts: no model behind it),
// named fake-qwen3:8b so every screen labels the route FAKE; its answer is a scripted stream whose every piece says "FAKE
// model", one piece every 150 ms (long enough that the keys arrive while it is being answered). The browser openers on PATH
// are stubs that only log. Everything else is the real Workbench, set up by `timmy init --yes` and the REPL's own
// `/project new` (through `timmy act`), in a sandbox of its own.
//
// Screens are kept as text in TIMMY_PTY_CAPTURES (else <tmpdir>/timmy-workbench-captures).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { readPane, scrub, sendKeys, waitScreen, type Pane } from './helpers/tmux-frame.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const CAPTURES = process.env.TIMMY_PTY_CAPTURES || join(tmpdir(), 'timmy-workbench-captures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL = 'fake-qwen3:8b';
const slow = textChunks(MODEL, Array.from({ length: 200 }, (_, i) => `(FAKE model, line ${i + 1} of 200.) `));
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const c of cleanups.splice(0).reverse()) await c(); }, 30_000);

/** The key-hint row: the last row inside Activity & log's box (a notice takes its place for a few seconds). */
const footOf = (screen: string): string => {
  const rows = screen.replace(/\n+$/, '').split('\n');
  return rows[rows.length - 2] ?? '';
};

describe('keys meant for the Workbench are never sent as a message (R10 H167, H168 F1; tmux, FAKE model)', () => {
  it('the hint row says the composer\'s keys while it has the keyboard; Esc stops the turn and leaves the composer; Tab, x, Esc, 1, Enter send nothing more', async () => {
    // the /api/chat requests in order: the message typed; a second script that no request may reach
    const ollama: FakeOllama = await startFakeOllama({ models: [{ name: MODEL }], chat: [
      () => ({ chunks: slow, delayMs: 150 }), () => ({ chunks: textChunks(MODEL, ['FAKE model: a second turn, which must not be asked for']) }),
    ] });
    cleanups.push(() => ollama.close());
    const box = mkdtempSync(join(tmpdir(), 'wb-composer-keys-pty-'));
    cleanups.push(() => rmSync(box, { recursive: true, force: true }));
    const home = join(box, 'home');
    const repo = join(box, 'repo');
    const bin = join(box, 'fakebin');
    for (const d of [home, repo, bin, join(box, 'tmp'), join(box, 'settings'), CAPTURES]) mkdirSync(d, { recursive: true });
    for (const name of ['open', 'xdg-open']) { writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${box}/opened.log'\n`); chmodSync(join(bin, name), 0o755); }
    const base = withoutRunner(process.env);
    delete base.NODE_PATH;
    const env: NodeJS.ProcessEnv = {
      ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(box, 'store'),
      TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor', TIMMY_PALETTE: 'night',
      TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`,
    };
    const cli = (args: string[]) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout: 60_000 });
    const init = await cli(['init', '--yes', '--operator', 'Sample', '--project', 'demo', '--ollama', ollama.url, '--chat', 'local', '--model', MODEL]);
    expect(init.status, init.stderr).toBe(0);
    const made = await cli(['act', '/project new tray --from tray-workflow']);
    expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);

    const label = `h167-keys-${process.pid}`;
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
    cleanups.push(() => { try { tmux('kill-server'); } catch { /* gone */ } });
    const wb: Pane = { tmux, target: 't', folders: [box] };
    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '122', '-y', '37', '-c', repo, 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
    const t0 = Date.now();
    const keep = (name: string, text: string, what: string) => writeFileSync(join(CAPTURES, `${name}.txt`), `# ${new Date().toISOString()} · +${Date.now() - t0} ms · ${what}\n${scrub(text, [box])}`);
    const screen = () => readPane(wb).text;
    const seen = async (re: RegExp, ms = 20_000): Promise<string> => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const s = screen(); if (re.test(s)) return s; }
      throw new Error(`the Workbench did not show ${re} in ${ms} ms:\n${scrub(screen(), [box])}`);
    };
    /** the Workbench's chat turns as their receipts were sealed (the store's lines: kind chat, subject "chat.turn · workbench …") */
    const turns = (): Array<{ status?: string }> => {
      const file = join(box, 'store', 'runs.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind?: string; subject?: string; status?: string })
        .filter((r) => r.kind === 'chat' && /^chat\.turn · workbench\b/.test(String(r.subject ?? '')));
    };

    await waitScreen(wb, { what: 'the Workbench on tray', re: /tray \/ Home · recent work[\s\S]*Activity & log/, ms: 60_000 });
    // the route is ready (FAKE, by its name): Home's one next step opens the composer in one key
    // (the status row says the route shorter where the row is short: "next: FAKE fake-qwen3:8b · here · no price" at 122)
    await seen(/next(?: turn)?: FAKE fake-qwen3:8b/, 20_000);
    await sendKeys(wb, ['Enter']);
    await seen(/Message[\s\S]*› /, 60_000);
    // 1. while the composer has the keyboard, the hint row says only its keys (read once no notice holds its place)
    const open = await seen(/\[Enter\] sends[^\n]*\[Esc\] leaves the composer/, 15_000);
    keep('h167-f1-122x37-01-composer-open', open, 'Enter on Home\'s next step: the composer has the keyboard');
    const foot = footOf(open);
    expect(foot, `the hint row with the composer open:\n${foot}`).toMatch(/\[Enter\] sends/);
    expect(foot).toMatch(/\[Esc\] leaves the composer/);
    expect(foot).not.toMatch(/\[x\] Stop|\[1–0\] tabs|\[Tab\] zones|\[c\] Companion|\[i\] details|\[\?\] keys/);

    // 2. the message, sent: a turn being answered, and the hint row says what Esc does now
    await sendKeys(wb, ['the first message (FAKE route)'], { literal: true });
    await seen(/› the first message \(FAKE route\)/);
    await sendKeys(wb, ['Enter']);
    const answering = await seen(/BEING ANSWERED NOW[\s\S]*FAKE model, line \d+ of 200/, 30_000);
    keep('h167-f1-122x37-02-being-answered', answering, 'the message sent; the turn being answered, the composer still has the keyboard');
    await seen(/\[Esc\] stops the turn and leaves the composer/);

    // 3. the reviewer's keys, one at a time, as he typed them: Tab, x, Esc, 1, Enter
    await sendKeys(wb, ['Tab']);
    await sendKeys(wb, ['x'], { literal: true });
    await sendKeys(wb, ['Escape']);
    // Esc stopped the turn and left the composer (its closed row is back, and the turn says stopped): what was typed (x) is not
    // kept as a message
    const left = await seen(/■ stopped by you[\s\S]*\[Enter\] Type a message/, 15_000);
    keep('h167-f1-122x37-03-esc', left, 'Tab, x, then Esc: the turn stopped and the composer left');
    expect(left).not.toMatch(/› x/);
    await sendKeys(wb, ['1']);
    await seen(/\[1 Home\][\s\S]*tray \/ Home · recent work/, 10_000);
    await sendKeys(wb, ['Enter']);
    // Home's next step opens the composer again, empty: nothing typed before is in it
    const again = await seen(/Message[\s\S]*› /, 20_000);
    keep('h167-f1-122x37-04-composer-again', again, '1, then Enter: Home, then the composer again, empty');
    expect(again).not.toMatch(/› x/);
    // nothing more was sent: the FAKE Ollama was asked once, for the message typed
    await sleep(1500);
    expect(ollama.chats().length, `the FAKE Ollama's chat requests: ${JSON.stringify(ollama.chats().map((c) => c.messages?.at?.(-1)?.content))}`).toBe(1);
    expect(JSON.stringify(ollama.chats()[0])).toContain('the first message (FAKE route)');
    expect(JSON.stringify(ollama.chats())).not.toContain('"x1"');
    // the one turn sealed, stopped (its receipt: the store's line)
    for (const end = Date.now() + 10_000; !turns().length && Date.now() < end;) await sleep(200);
    expect(turns().map((r) => r.status)).toEqual(['cancelled']);

    await sendKeys(wb, ['Escape']);
    await sendKeys(wb, ['C-c']);
    await waitScreen(wb, { what: 'the Workbench ended', re: /EXIT=0\b/, ms: 20_000 });
    expect(existsSync(join(box, 'opened.log'))).toBe(false);
  }, 180_000);
});
