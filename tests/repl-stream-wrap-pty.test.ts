// R6 (H141; the interaction review of a77d80d, defect 4): the REPL (`timmy repl`) in a real terminal (tmux) keeps a long
// single-paragraph answer visibly streaming at 160, 120 and 80 columns: while it streams, the screen changes again and again,
// its rows stay within the terminal's width (none soft-wrapped by the terminal), and the newest sentence the model has sent is
// on screen, the answer wrapped; at its end the whole answer is in scrollback, wrapped, with its receipt. The review saw the
// live line grow to 159 characters within a second at 160 columns and then not change for 9.5 s, until the whole answer
// appeared at once.
//
// FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts: no model behind it), its
// answer a scripted paragraph whose every sentence says "FAKE model", one sentence every 150 ms. Everything else is the real
// REPL, set up by `timmy init --yes` for the local route, in a sandbox of its own (HOME, the Timmy home, the store, TMPDIR and
// the tmux server inside this test's temporary folder).
//
// Screens are kept as text with the time each was read, in TIMMY_PTY_CAPTURES (else <tmpdir>/timmy-workbench-captures).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { scrub } from './helpers/tmux-frame.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const CAPTURES = process.env.TIMMY_PTY_CAPTURES || join(tmpdir(), 'timmy-workbench-captures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PIECES = 40;
const EVERY_MS = 150;
/** The FAKE model's answer: one paragraph, no newline, a sentence per piece (the review's FAKE B#3 had this shape). */
const piece = (i: number, w: number): string => `(FAKE model, ${w} columns, line ${i} of ${PIECES}: a tray holds things.) `;
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const c of cleanups.splice(0).reverse()) await c(); }, 30_000);

describe('the REPL keeps a long answer streaming at the terminal\'s width (R6 H141; tmux, FAKE model)', () => {
  it('at 160, 120 and 80 columns: the screen changes while the answer streams, its rows within the width, the newest sentence on screen; at its end the answer is whole, wrapped, with its receipt', async () => {
    const widths = [160, 120, 80] as const;
    const ollama: FakeOllama = await startFakeOllama({
      models: [{ name: 'qwen3:8b' }],
      chat: widths.map((w) => () => ({ chunks: textChunks('qwen3:8b', Array.from({ length: PIECES }, (_, i) => piece(i + 1, w))), delayMs: EVERY_MS })),
    });
    cleanups.push(() => ollama.close());
    const dir = mkdtempSync(join(tmpdir(), 'repl-stream-pty-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(CAPTURES, { recursive: true });
    const base = withoutRunner(process.env);
    delete base.NODE_PATH;
    const env: NodeJS.ProcessEnv = { ...base, HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, 'store'), TMPDIR: join(dir, 'tmp'), OPENROUTER_API_KEY: '', TIMMY_PALETTE: 'night' };
    mkdirSync(env.TMPDIR!, { recursive: true });
    const init = await runAsync(TSX, [CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo', '--ollama', ollama.url, '--chat', 'local', '--model', 'qwen3:8b'], { cwd: dir, env, timeout: 60_000 });
    expect(init.status, init.stderr).toBe(0);

    const tenv = { ...env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'replstream', ...args], { env: tenv, encoding: 'utf8', timeout: 10_000 });
    cleanups.push(() => { try { tmux('kill-server'); } catch { /* gone */ } });
    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', dir, 'bash', '--norc', '-c', `${TSX} ${CLI} repl; echo EXIT=$?; sleep 60`);
    // the screen as the terminal shows it (its rows, no scrollback), and with soft-wrapped rows joined (-J): a row the REPL
    // wrote wider than the terminal would come back joined, longer than the width
    const shown = () => tmux('capture-pane', '-p', '-t', 't');
    const joined = () => tmux('capture-pane', '-p', '-J', '-t', 't');
    const history = () => tmux('capture-pane', '-p', '-J', '-S', '-2000', '-t', 't');
    const waitFor = async (re: RegExp, ms = 60_000): Promise<string> => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const s = history(); if (re.test(s)) return s; }
      throw new Error(`timed out waiting for ${re}:\n${scrub(history(), [dir])}`);
    };
    // the newest sentence of this width's answer on a screen (its rows joined: a sentence may be broken across two rows)
    const newestOn = (s: string, w: number): number => Math.max(0, ...[...s.replace(/\s*\n\s*/g, ' ').matchAll(new RegExp(`${w} columns, line (\\d+) of ${PIECES}`, 'g'))].map((m) => Number(m[1])));
    await waitFor(/Enter to send/);

    for (const w of widths) {
      if (w !== 160) {
        tmux('resize-window', '-t', 't', '-x', String(w), '-y', '45');
        for (const end = Date.now() + 10_000; Number(tmux('display-message', '-p', '-t', 't', '#{pane_width}').trim()) !== w && Date.now() < end;) await sleep(50);
        await sleep(300);
      }
      const ask = `stream a long answer at ${w} columns`;
      // what the screen shows of this turn: from its prompt, while the prompt is on screen (an earlier turn's receipt is above it)
      const ofThisTurn = (screen: string): string => (screen.includes(ask) ? screen.slice(screen.lastIndexOf(ask)) : screen);
      tmux('send-keys', '-t', 't', '-l', ask);
      tmux('send-keys', '-t', 't', 'Enter');
      const sent = Date.now();
      // sampled every 100 ms while it streams: when the screen changed, the newest sentence on it, the widest row
      const samples: Array<{ at: number; screen: string; newest: number; widest: number; ended: boolean }> = [];
      const kept: Array<{ at: number; screen: string }> = [];
      for (let done = false; !done && Date.now() - sent < 40_000; await sleep(100)) {
        const screen = shown();
        const at = Date.now() - sent;
        const widest = Math.max(...joined().split('\n').map((l) => [...l].length));
        done = /RECEIPT [0-9a-f]{8} signed and verified/.test(ofThisTurn(screen));
        const prev = samples[samples.length - 1];
        if (!prev || prev.screen !== screen) samples.push({ at, screen, newest: newestOn(screen, w), widest, ended: done });
        if ((w === 160 || w === 80) && kept.length < 3 && at >= 1500 * (kept.length + 1) && !done) kept.push({ at, screen });
      }
      const streaming = samples.filter((s) => !s.ended);
      const said = (s: { at: number; newest: number }) => `+${s.at} ms: line ${s.newest}`;
      // the screen changed again and again while the answer streamed (not once at the start and once at its end)
      expect(streaming.length, `screens while streaming at ${w} columns: ${streaming.map(said).join(', ')}`).toBeGreaterThanOrEqual(10);
      // the newest sentence on screen kept growing through the stream, to its last before the end
      const lines = streaming.map((s) => s.newest).filter((n) => n > 0);
      expect(lines.length).toBeGreaterThanOrEqual(10);
      // R6 lead (CI at a621632, 80 columns: "+6037 ms: line 40, +6286 ms: line 39"): after the last sentence had been on screen,
      // and before the receipt, one screen read showed the one before last (most likely mid-way through the answer's move into
      // the scrollback). The growth is checked up to the last sentence; the end (below) checks every sentence in order in the
      // scrollback, then the receipt.
      const streamed = lines.indexOf(PIECES) >= 0 ? lines.slice(0, lines.indexOf(PIECES) + 1) : lines;
      for (let i = 1; i < streamed.length; i++) expect(streamed[i], `at ${w} columns: ${streaming.map(said).join(', ')}`).toBeGreaterThanOrEqual(streamed[i - 1]);
      expect(Math.max(...lines), `at ${w} columns: ${streaming.map(said).join(', ')}`).toBeGreaterThanOrEqual(PIECES - 4);
      // between +2 s and +4 s (sentences 13 to 26 sent), the screen showed sentences of that time, not only the first ones
      const middle = streaming.filter((s) => s.at >= 2000 && s.at <= 4000);
      expect(middle.length).toBeGreaterThan(0);
      expect(Math.max(...middle.map((s) => s.newest)), `at ${w} columns, +2 s to +4 s: ${middle.map(said).join(', ')}`).toBeGreaterThanOrEqual(8);
      // no row wider than the terminal (none came back joined), and the answer wrapped at 80 columns or the width
      for (const s of samples) expect(s.widest, `at ${w} columns, +${s.at} ms`).toBeLessThanOrEqual(w);
      // the end: every sentence, in order, in scrollback, wrapped, then its receipt
      const end = await waitFor(new RegExp(`${ask}[\\s\\S]*RECEIPT [0-9a-f]{8} signed and verified[\\s\\S]*Enter to send`));
      const answer = end.slice(end.lastIndexOf(ask));
      const flat = answer.replace(/\s+/g, ' ');
      let from = 0;
      for (let i = 1; i <= PIECES; i++) {
        const at = flat.indexOf(piece(i, w).trim(), from);
        expect(at, `sentence ${i} of ${PIECES} at ${w} columns, in order`).toBeGreaterThanOrEqual(0);
        from = at;
      }
      // its rows (the rows of the FAKE answer, after the prompt, up to the receipt): each within 80 columns or the width
      const rows = answer.split('\n');
      const receiptAt = rows.findIndex((l) => /RECEIPT [0-9a-f]{8} signed and verified/.test(l));
      const answerRows = rows.slice(1, receiptAt).filter((l) => /FAKE|model|columns|line|of \d+|tray|holds|things/.test(l));
      expect(answerRows.length).toBeGreaterThan(10);
      for (const r of answerRows) expect([...r].length, r).toBeLessThanOrEqual(Math.min(w, 80));
      for (const [n, k] of kept.entries()) {
        writeFileSync(join(CAPTURES, `repl-stream-${w}x45-${n + 1}.txt`), `# ${new Date(sent + k.at).toISOString()} · +${k.at} ms after Enter · the REPL streaming a long single-paragraph answer (FAKE model) at ${w}x45, moment ${n + 1} of 3 (newest sentence on screen: ${newestOn(k.screen, w)} of ${PIECES})\n${scrub(k.screen, [dir])}`);
      }
    }
    expect(ollama.chats()).toHaveLength(widths.length);
    tmux('send-keys', '-t', 't', '-l', '/exit');
    tmux('send-keys', '-t', 't', 'Enter');
    await waitFor(/EXIT=0/, 30_000);
  }, 240_000);
});
