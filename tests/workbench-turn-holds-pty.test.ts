// R6 (H141; the interaction review of a77d80d, defect 3): in real terminals (tmux), a REPL (`timmy repl`) and a Workbench
// (`timmy workbench`) on one project, each a process of its own. A message sent in the REPL takes the project's chat hold; the
// Workbench's run line names that turn within about half a second of the hold being written (timed from the hold file's
// appearance, which this test watches), and x pressed about 0.5 s into the turn, then y in the box it opens, stops it there; x
// pressed at once, as soon as the hold is there, names that turn too (the Workbench reads the holds before it answers: never
// "nothing runs" while a turn is held). R7 (H150; H148's N3): Enter on Stop the turn, done in the REPL, never stops it: it says
// where it is done, and the turn goes on until x and y. The review saw "Stop current: nothing runs in tray." for the first 1
// to 4.5 s of a REPL turn, which went on. R10 (H163): turn 1 is sent once the Workbench has settled (its readings after the
// first frame landed, then 300 ms without a new frame), so its time is a hold's, not the Workbench's own start.
//
// FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts: no model behind it), each
// answer a scripted long paragraph whose every sentence says "FAKE model", one sentence every 120 ms (12 s in all, so only a
// stop ends it early); the browser openers on PATH are stubs that only log. Everything else is the real REPL and Workbench,
// set up by `timmy init --yes` and the REPL's own `/project new` (through `timmy act`), in a sandbox of their own.
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
const TURNS = 3;
const answer = (n: number) => textChunks('qwen3:8b', Array.from({ length: 100 }, (_, i) => `(FAKE model, turn ${n}, line ${i + 1} of 100: a tray holds things.) `));
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const c of cleanups.splice(0).reverse()) await c(); }, 30_000);

describe('another process\'s chat turn, seen and stopped from the Workbench at once (R6 H141; tmux, FAKE model)', () => {
  it('the run line names a REPL turn within about half a second of its hold; x about 0.5 s into it (then y) stops it; x at once (then y) stops it; Enter on Stop the turn says it is done in the REPL and stops nothing', async () => {
    const ollama: FakeOllama = await startFakeOllama({ models: [{ name: 'qwen3:8b' }], chat: Array.from({ length: TURNS }, (_, i) => () => ({ chunks: answer(i + 1), delayMs: 120 })) });
    cleanups.push(() => ollama.close());
    const box = mkdtempSync(join(tmpdir(), 'wb-holds-pty-'));
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

    // two terminals of their own: the Workbench (160x45) and the REPL (120x40)
    const server = (label: string) => {
      const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
      cleanups.push(() => { try { tmux('kill-server'); } catch { /* gone */ } });
      return tmux;
    };
    const wt = server('wbholdsW');
    const rt = server('wbholdsR');
    const wb: Pane = { tmux: wt, target: 't', folders: [box] };
    wt('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
    // (the REPL's project is the folder it starts in: tray's, the project the Workbench follows as the active one)
    rt('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '120', '-y', '40', '-c', join(home, 'timmy', 'projects', 'tray'), 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} ${CLI} repl; echo EXIT=$?; sleep 600`);
    const repl = () => rt('capture-pane', '-p', '-J', '-S', '-1000', '-t', 't');
    const replWait = async (re: RegExp, ms = 30_000): Promise<string> => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const s = repl(); if (re.test(s)) return s; }
      throw new Error(`timed out waiting for ${re} in the REPL:\n${scrub(repl(), [box])}`);
    };
    const replCount = (re: RegExp): number => (repl().match(new RegExp(re.source, 'g')) ?? []).length;
    const keep = (name: string, text: string, what: string, t0: number) => writeFileSync(join(CAPTURES, `${name}.txt`), `# ${new Date().toISOString()} · +${Date.now() - t0} ms after the REPL's Enter · ${what}\n${scrub(text, [box])}`);
    const wbScreen = () => readPane(wb).text;

    await waitScreen(wb, { what: 'the Workbench on tray', re: /tray \/ [\s\S]*Activity & log/, ms: 60_000 });
    await replWait(/Enter to send/, 60_000);
    expect(wbScreen()).toContain('run: idle');

    /** Sends a message in the REPL; resolves when its hold file is there, with the times of the Enter and of the hold. */
    const sendInRepl = async (text: string): Promise<{ sent: number; held: number; hold: string }> => {
      const before = new Set(heldNow());
      rt('send-keys', '-t', 't', '-l', text);
      rt('send-keys', '-t', 't', 'Enter');
      const sent = Date.now();
      for (const end = sent + 15_000; Date.now() < end; await sleep(5)) {
        const fresh = heldNow().find((n) => !before.has(n));
        if (fresh) return { sent, held: Date.now(), hold: fresh };
      }
      throw new Error(`no chat hold appeared in 15 s after the REPL's Enter:\n${scrub(repl(), [box])}`);
    };
    /** The time (ms after `from`) the Workbench's screen first matches `re`, sampled every 20 ms. */
    const seen = async (re: RegExp, from: number, ms = 10_000): Promise<{ at: number; screen: string }> => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const s = wbScreen(); if (re.test(s)) return { at: Date.now() - from, screen: s }; }
      throw new Error(`the Workbench did not show ${re} in ${ms} ms:\n${scrub(wbScreen(), [box])}`);
    };
    const RUNNING = /run: 1 running \(the chat turn in the REPL\)/;
    const STOPPED_THERE = /asked from the Workbench/;
    /**
     * R10 (H163; the lead's order on the turn-holds latency): the Workbench has settled: what it reads right after its first
     * frame has landed (Home's project line counts the files and workflow documents instead of saying they are being read),
     * then no new frame for 300 ms (its screen, read every 25 ms, the same throughout). Turn 1 is sent then, so its time
     * measures how soon a hold is named, not the Workbench's own start (on a loaded computer it worked for up to a second after
     * its first frame, and turn 1 waited behind that). The budget is unchanged.
     */
    const settled = async (ms = 60_000): Promise<number> => {
      await waitScreen(wb, { what: 'the Workbench\'s counts (its readings after the first frame landed)', re: /\b\d+ files? · \d+ workflow documents? · \d+ jobs?\b/, ms });
      const begun = Date.now();
      let last = wbScreen();
      let since = Date.now();
      while (Date.now() - since < 300) {
        if (Date.now() - begun > ms) throw new Error(`the Workbench drew a new frame at least every 300 ms for ${ms} ms:\n${scrub(last, [box])}`);
        await sleep(25);
        const s = wbScreen();
        if (s !== last) { last = s; since = Date.now(); }
      }
      return Date.now() - begun;
    };

    // 1. x about 0.5 s into the turn (sent once the Workbench has settled)
    const quiet = await settled();
    expect(wbScreen()).toContain('run: idle');
    const one = await sendInRepl('the first long question (turn 1)');
    const named = await seen(RUNNING, one.held);
    expect(named.at, `the run line named the REPL's turn ${named.at} ms after its hold was written`).toBeLessThan(700);
    expect(named.screen).toMatch(/\[x\] Stop current: the chat turn in the REPL \(Ctrl\+C in the REPL stops it there; x here asks you first\)/);
    keep('holds-1-workbench-running', named.screen, `the Workbench naming the REPL's turn ${named.at} ms after its hold was written (turn 1)`, one.sent);
    await sleep(Math.max(0, one.sent + 500 - Date.now()));
    const xAt = Date.now();
    await sendKeys(wb, ['x']);
    await seen(/Stop the chat turn being answered in the REPL\?/, xAt);
    await sendKeys(wb, ['y']);
    const asked = await seen(/Stop asked of the turn being answered in the REPL \(x, then y\)/, xAt);
    keep('holds-1-workbench-after-x', asked.screen, `x pressed ${xAt - one.sent} ms into the REPL's turn (turn 1): the Workbench asks it to stop`, one.sent);
    const stopped1 = await replWait(STOPPED_THERE, 10_000);
    const stoppedIn = Date.now() - xAt;
    keep('holds-1-repl-stopped', stopped1, `the REPL's turn 1 stopped ${stoppedIn} ms after x was pressed in the Workbench (${xAt - one.sent} ms into the turn)`, one.sent);
    expect(stoppedIn, 'the REPL stopped its turn after x').toBeLessThan(3000);
    // nothing more of turn 1 streams after the stop
    const lines1 = (s: string) => Math.max(0, ...[...s.matchAll(/turn 1, line (\d+) of 100/g)].map((m) => Number(m[1])));
    const at1 = lines1(repl());
    expect(at1).toBeLessThan(100);
    await seen(/run: idle/, Date.now(), 5000);
    await sleep(600);
    expect(lines1(repl())).toBe(at1);
    await replWait(/Enter to send/);

    // 2. x at once, as soon as the hold is there (the Workbench reads the holds before x answers)
    const two = await sendInRepl('the second long question (turn 2)');
    const xAt2 = Date.now();
    await sendKeys(wb, ['x']);
    const asked2 = await seen(/Stop the chat turn being answered in the REPL\?|Stop current: nothing runs in tray\./, xAt2);
    keep('holds-2-workbench-after-x', asked2.screen, `x pressed ${xAt2 - two.held} ms after the REPL's hold was written (turn 2)`, two.sent);
    expect(asked2.screen, 'x said nothing runs while a turn was held').not.toMatch(/Stop current: nothing runs in tray\./);
    await sendKeys(wb, ['y']);
    await replWait(/the second long question \(turn 2\)[\s\S]*asked from the Workbench/, 10_000);
    expect(replCount(STOPPED_THERE)).toBe(2);
    await seen(/run: idle/, Date.now(), 5000);
    await replWait(/Enter to send/);

    // 3. Stop the turn on the Chat tab (2), the one next step while the turn runs, is done in the REPL (R7 H150): the cursor on
    // it and Enter say so and stop nothing; x, then y, stops it
    await sendKeys(wb, ['2']);
    await waitScreen(wb, { what: 'the Chat tab', re: /tray \/ Chat/, ms: 10_000 });
    const three = await sendInRepl('the third long question (turn 3)');
    const offered = await seen(/▶ 3 Stop the turn/, three.held);
    expect(offered.at, `the Chat tab offered Stop the turn ${offered.at} ms after the hold was written`).toBeLessThan(700);
    await sendKeys(wb, ['Right', 'Right']);
    // (R10 H167: row 2 says where it is done first, then the command there)
    await seen(/3 Stop the turn · done in the REPL, not here: Enter does not stop it; x asks you first · Ctrl\+C in the REPL that sent it/, Date.now());
    await sendKeys(wb, ['Enter']);
    await seen(/3 Stop the turn is done in the REPL \(Ctrl\+C in the REPL that sent it\): Enter here does not stop it/, Date.now());
    await sleep(600);
    expect(replCount(STOPPED_THERE), 'Enter stopped the REPL\'s turn').toBe(2);
    await sendKeys(wb, ['x']);
    await seen(/Stop the chat turn being answered in the REPL\?/, Date.now());
    await sendKeys(wb, ['y']);
    await replWait(/the third long question \(turn 3\)[\s\S]*asked from the Workbench/, 10_000);
    await seen(/run: idle/, Date.now(), 5000);
    expect(replCount(STOPPED_THERE)).toBe(3);
    // (a stop that lands before a turn's request leaves sends none: at most one request per turn)
    expect(ollama.chats().length).toBeLessThanOrEqual(TURNS);

    // the times seen, for the report
    console.log(`R6 H141 holds PTY: the Workbench settled in ${quiet} ms; turn 1 named in the run line ${named.at} ms after its hold; x at +${xAt - one.sent} ms stopped it in ${stoppedIn} ms; turn 2's x came ${xAt2 - two.held} ms after its hold; turn 3's Stop the turn offered ${offered.at} ms after its hold`);

    rt('send-keys', '-t', 't', '-l', '/exit');
    rt('send-keys', '-t', 't', 'Enter');
    await replWait(/EXIT=0/, 30_000);
    await sendKeys(wb, ['C-c']);
    // (it stopped nothing of its own: R6 H141, exit 0)
    await waitScreen(wb, { what: 'the Workbench ended', re: /EXIT=0\b/, ms: 20_000 });
  }, 240_000);
});
