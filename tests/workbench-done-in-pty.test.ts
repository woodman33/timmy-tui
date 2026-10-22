// R7 (H150; H148's N3, REMAINING-DEFECTS row 5): in real terminals (tmux), a REPL (`timmy repl`) and a Workbench (`timmy
// workbench`) on one project, each a process of its own. While the REPL answers, 2 → Enter in the Workbench opens its
// composer (the README's "2 → Enter → type") and never stops the REPL's turn: the turn runs to its end and seals answered;
// what is typed goes into the composer, and Enter there sends nothing while the turn runs (it says so, and keeps the text).
// As soon as RUNNING NOW is 0, after the REPL's answer and, separately, after a stop from the REPL's own Ctrl+C, the
// Workbench's send is accepted. No screen of the Workbench says a turn is being answered while it also says RUNNING NOW (0).
// H148 saw Enter stop the REPL's turn, then "a turn is being answered in the REPL" beside "RUNNING NOW (0)".
//
// FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts: no model behind it):
// each REPL answer a scripted stream whose every piece says "FAKE model", one piece every 150 ms; each Workbench answer three
// quick pieces that say FAKE. The browser openers on PATH are stubs that only log. Everything else is the real REPL and
// Workbench, set up by `timmy init --yes` and the REPL's own `/project new` (through `timmy act`), in a sandbox of their own.
//
// Screens are kept as text with the time each was read, in TIMMY_PTY_CAPTURES (else <tmpdir>/timmy-workbench-captures).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const slow = (n: number, lines: number) => textChunks('qwen3:8b', Array.from({ length: lines }, (_, i) => `(FAKE model, REPL turn ${n}, line ${i + 1} of ${lines}.) `));
const quick = (n: number) => textChunks('qwen3:8b', ['FAKE model: ', `the Workbench's message ${n} `, 'is answered.']);
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const c of cleanups.splice(0).reverse()) await c(); }, 30_000);

describe('Enter on tab 2 never stops another surface\'s turn; the send is accepted once RUNNING NOW is 0 (R7 H150; tmux, FAKE model)', () => {
  it('2 → Enter while the REPL answers opens the composer, the REPL\'s turn ends answered, and the Workbench\'s message is sent once RUNNING NOW is 0; after the REPL\'s own Ctrl+C, the same', async () => {
    // the /api/chat requests in the order they come: the REPL's first turn (100 pieces, 15 s), the Workbench's first message,
    // the REPL's second turn (stopped in the REPL), the Workbench's second message
    const ollama: FakeOllama = await startFakeOllama({ models: [{ name: 'qwen3:8b' }], chat: [
      () => ({ chunks: slow(1, 100), delayMs: 150 }), () => ({ chunks: quick(1), delayMs: 30 }),
      () => ({ chunks: slow(2, 200), delayMs: 150 }), () => ({ chunks: quick(2), delayMs: 30 }),
    ] });
    cleanups.push(() => ollama.close());
    const box = mkdtempSync(join(tmpdir(), 'wb-done-in-pty-'));
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
    const init = await cli(['init', '--yes', '--operator', 'Sample', '--project', 'demo', '--ollama', ollama.url, '--chat', 'local', '--model', 'qwen3:8b']);
    expect(init.status, init.stderr).toBe(0);
    const made = await cli(['act', '/project new tray --from tray-workflow']);
    expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
    const holdsDir = join(home, 'timmy', 'projects', 'tray', '.timmy', 'chat-turns');
    const heldNow = (): string[] => (existsSync(holdsDir) ? readdirSync(holdsDir).filter((n) => /^t\d+-[0-9a-f]{8}\.json$/.test(n)) : []);

    const server = (label: string) => {
      const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
      cleanups.push(() => { try { tmux('kill-server'); } catch { /* gone */ } });
      return tmux;
    };
    const wt = server('h150-wb');
    const rt = server('h150-repl');
    const wb: Pane = { tmux: wt, target: 't', folders: [box] };
    wt('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
    rt('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '120', '-y', '40', '-c', join(home, 'timmy', 'projects', 'tray'), 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} ${CLI} repl; echo EXIT=$?; sleep 600`);
    const repl = () => rt('capture-pane', '-p', '-J', '-S', '-1000', '-t', 't');
    const replWait = async (re: RegExp, ms = 30_000): Promise<string> => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const s = repl(); if (re.test(s)) return s; }
      throw new Error(`timed out waiting for ${re} in the REPL:\n${scrub(repl(), [box])}`);
    };
    const t0 = Date.now();
    const keep = (name: string, text: string, what: string) => writeFileSync(join(CAPTURES, `${name}.txt`), `# ${new Date().toISOString()} · +${Date.now() - t0} ms · ${what}\n${scrub(text, [box])}`);
    const wbScreen = () => readPane(wb).text;
    /** Every Workbench screen read while a check runs: none may say a turn is being answered beside RUNNING NOW (0) (the
     *  Activity strip's "last:" line, an event with its time, is history and is not read for it). */
    const contradictions: string[] = [];
    const look = (): string => {
      const s = wbScreen();
      const now = s.split('\n').filter((l) => !/ last: \d\d:\d\d:\d\d /.test(l)).join('\n');
      if (/RUNNING NOW \(0\)/.test(now) && /turn is being answered|being answered in the REPL/.test(now)) contradictions.push(s);
      return s;
    };
    const seen = async (re: RegExp, ms = 15_000): Promise<string> => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const s = look(); if (re.test(s)) return s; }
      throw new Error(`the Workbench did not show ${re} in ${ms} ms:\n${scrub(wbScreen(), [box])}`);
    };
    const sendInRepl = async (text: string): Promise<string> => {
      const before = new Set(heldNow());
      rt('send-keys', '-t', 't', '-l', text);
      rt('send-keys', '-t', 't', 'Enter');
      for (const end = Date.now() + 15_000; Date.now() < end; await sleep(5)) {
        const fresh = heldNow().find((n) => !before.has(n));
        if (fresh) return fresh;
      }
      throw new Error(`no chat hold appeared in 15 s after the REPL's Enter:\n${scrub(repl(), [box])}`);
    };

    await waitScreen(wb, { what: 'the Workbench on tray', re: /tray \/ [\s\S]*Activity & log/, ms: 60_000 });
    await replWait(/Enter to send/, 60_000);
    // the Chat tab opened once first: its chat session opens then (the first opening loads the agent), then Home again
    await sendKeys(wb, ['2']);
    // (R10 H167: the composer's closed row names where a message goes once its chat session is open: "· to" the model)
    await seen(/tray \/ Chat[\s\S]*\[Enter\] Type a message +· to qwen3:8b/, 60_000);
    await sendKeys(wb, ['1']);
    await seen(/2 Check connections \(free requests\)/, 20_000);

    // 1. the REPL answers; 2 → Enter in the Workbench: the composer, and the REPL's turn goes on
    await sendInRepl('the first long question (turn 1)');
    await seen(/run: 1 running \(the chat turn in the REPL\)/);
    await sendKeys(wb, ['2']);
    const chat = await seen(/▸\[1 Send a message\][\s\S]*tray \/ Chat/);
    expect(chat).toMatch(/\[▶ 3 Stop the turn\]/);
    keep('done-in-1-tab2-while-repl-answers', chat, 'tab 2 while the REPL answers: Send selected, Stop the turn done in the REPL');
    await sendKeys(wb, ['Enter']);
    // (R10 H167: the composer is a box of its own, titled Message)
    const composer = await seen(/Message[\s\S]*› /);
    keep('done-in-2-composer-open', composer, '2 → Enter while the REPL answers: the composer');
    expect(composer).not.toMatch(/Stop asked of the turn/);
    await sendKeys(wb, ['hello from the Workbench'], { literal: true });
    await seen(/› hello from the Workbench/);
    await sendKeys(wb, ['Enter']);
    const waiting = await seen(/Not sent yet: one turn at a time per project, and a turn is being answered in the REPL/);
    keep('done-in-3-send-waits', waiting, 'Enter in the composer while the REPL answers: not sent, the text kept');
    expect(waiting).toMatch(/› hello from the Workbench/);
    expect(waiting).toMatch(/RUNNING NOW \(1\)/);
    // the REPL's turn runs to its end and seals answered (nothing stopped it)
    const answered = await replWait(/REPL turn 1, line 100 of 100[\s\S]*RECEIPT [0-9a-f]{8} signed and verified[\s\S]*Enter to send/, 40_000);
    keep('done-in-4-repl-answered', answered, 'the REPL\'s turn 1 ran to its end and sealed (no stop)');
    expect(answered).not.toMatch(/Stopped/);
    // RUNNING NOW 0: the send is accepted at once
    const idle = await seen(/RUNNING NOW \(0\)/);
    expect(idle).toMatch(/› hello from the Workbench/);
    await sendKeys(wb, ['Enter']);
    // (R10 H167: the notice says the receipt is sealed; its id is the details', [i])
    const sent1 = await seen(/Answered: its receipt is sealed/, 20_000);
    keep('done-in-5-sent-after-repl-answered', sent1, 'RUNNING NOW 0 after the REPL\'s answer: the Workbench\'s message sent and answered');
    expect(sent1).not.toMatch(/Not sent/);
    expect(ollama.chats().length).toBe(2);
    expect(JSON.stringify(ollama.chats()[1])).toContain('hello from the Workbench');

    // 2. the REPL's own Ctrl+C stops its next turn; the Workbench's send is accepted as soon as RUNNING NOW is 0
    await replWait(/Enter to send/);
    await sendInRepl('the second long question (turn 2)');
    await replWait(/REPL turn 2, line 3 of 200/, 20_000);
    await seen(/RUNNING NOW \(1\)/);
    await sendKeys(wb, ['and once it is stopped'], { literal: true });
    await seen(/› and once it is stopped/);
    rt('send-keys', '-t', 't', 'C-c');
    const stopped = await replWait(/Stopped by you\./, 10_000);
    keep('done-in-6-repl-ctrl-c', stopped, 'the REPL\'s own Ctrl+C stopped its turn 2');
    await seen(/RUNNING NOW \(0\)/);
    await sendKeys(wb, ['Enter']);
    // (the first answer's notice is long gone: it holds for its few seconds, and the REPL's turn 2 ran meanwhile; this one is
    // the second answer's, after Ollama was asked the fourth time)
    for (const end = Date.now() + 20_000; ollama.chats().length < 4 && Date.now() < end;) await sleep(20);
    const sent2 = await seen(/Answered: its receipt is sealed/, 20_000);
    keep('done-in-7-sent-after-repl-stop', sent2, 'RUNNING NOW 0 after the REPL\'s Ctrl+C: the Workbench\'s message sent and answered');
    expect(sent2).not.toMatch(/Not sent/);
    expect(ollama.chats().length).toBe(4);
    expect(JSON.stringify(ollama.chats()[3])).toContain('and once it is stopped');
    expect(contradictions.length, `a screen said a turn is being answered beside RUNNING NOW (0):\n${contradictions.map((s) => scrub(s, [box])).join('\n----\n')}`).toBe(0);
    // the REPL stopped turn 2 itself, asked by no other surface
    expect(stopped).not.toMatch(/asked from the Workbench/);

    rt('send-keys', '-t', 't', '-l', '/exit');
    rt('send-keys', '-t', 't', 'Enter');
    await replWait(/EXIT=0/, 30_000);
    await sendKeys(wb, ['Escape']);
    await sendKeys(wb, ['C-c']);
    await waitScreen(wb, { what: 'the Workbench ended', re: /EXIT=0\b/, ms: 20_000 });
  }, 220_000);
});
