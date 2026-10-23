// R6 (H141; the interaction review of a77d80d, defect 6): the `?` Keys list in a real terminal (tmux) at 160x45, 120x40 and
// 100x30 scrolls from the keyboard, by the keys it lists itself: ↓ and j a row, k and ↑ back, PgDn and PgUp a page, End to its
// last rows and Home to its first; its title says which rows show (a–b of n), and every entry it lists is brought into view.
// The review saw it stay "1–28 of 65", "1–23 of 88", "1–14 of 123" under ↓, j, PgDn and End.
//
// `timmy workbench` runs as the installed command runs it (src/cli.ts through tsx's loader) over a sandbox of its own (HOME,
// the XDG folders, the Timmy home, the settings folder, the store, TMPDIR and the tmux server all inside this test's temporary
// folder), made by `timmy init --yes`. FAKE here: the browser openers on PATH (stubs that only log; nothing here presses Show).
// Keys go through tmux send-keys, each once the Workbench has read the one before (tests/helpers/tmux-frame.ts).
//
// Screens are kept as text with the time each was read, in TIMMY_PTY_CAPTURES (else <tmpdir>/timmy-workbench-captures).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELP } from '../src/workbench/views.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { scrub, sendKeys, waitScreen, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const CAPTURES = process.env.TIMMY_PTY_CAPTURES || join(tmpdir(), 'timmy-workbench-captures');

let box = '';
let repo = '';
let env: NodeJS.ProcessEnv = {};
const cli = (args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout });

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-keys-pty-'));
  const home = join(box, 'home');
  repo = join(box, 'repo');
  const bin = join(box, 'fakebin');
  for (const d of [home, repo, bin, join(box, 'tmp'), join(box, 'settings'), CAPTURES]) mkdirSync(d, { recursive: true });
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${box}/opened.log'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const base = withoutRunner(process.env);
  delete base.NODE_PATH;
  env = {
    ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    // R10 CHAT (H167): the Workbench as it was before the Chat screen (Home first, the classic Chat tab): this file checks what
    // it opens there; the Chat screen's own are tests/workbench-chat-shell.test.ts and tests/workbench-chat-landing-pty.test.ts
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_WORKBENCH_CHAT: 'classic', TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(box, 'store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--project', 'demo']);
  expect(init.status, init.stderr).toBe(0);
}, 120_000);

afterAll(async () => {
  try { execFileSync('tmux', ['-L', 'wbkeys', 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ }
  rmSync(box, { recursive: true, force: true });
}, 30_000);

/** The Keys list as a whole frame draws it: its title's range note, and its rows inside its border (the body's left column). */
function keysPanel(screen: string): { from: number; to: number; of: number; rows: string[] } | null {
  const lines = screen.split('\n');
  const top = lines.findIndex((l) => /[╭┏][─━] (?:◆ )?Keys\b/.test(l));
  if (top < 0) return null;
  const x = lines[top].search(/[╭┏]/);
  const right = lines[top].slice(x + 1).search(/[╮┓]/) + x + 1;
  const note = /(\d+)–(\d+) of (\d+)/.exec(lines[top].slice(x, right + 1));
  if (!note) return null;
  const rows: string[] = [];
  for (let y = top + 1; y < lines.length && !/^[╰┗]/.test(lines[y].slice(x)); y++) rows.push(lines[y].slice(x + 1, right).trim());
  return { from: Number(note[1]), to: Number(note[2]), of: Number(note[3]), rows };
}

describe('the `?` Keys list in a terminal scrolls from the keyboard (R6 H141; tmux)', () => {
  it('at 160x45, 120x40 and 100x30: ↓ j k ↑ a row, PgDn PgUp a page, End and Home; its title says which rows show; every entry it lists is brought into view', async () => {
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'wbkeys', ...args], { env, encoding: 'utf8', timeout: 10_000 });
    const pane: Pane = { tmux, target: 't', folders: [box] };
    const keys = (...k: string[]) => sendKeys(pane, k);
    const t0 = Date.now();
    /** Waits for the Keys list drawn whole, its note meeting `test`. */
    const keysWhen = async (what: string, test: (k: NonNullable<ReturnType<typeof keysPanel>>) => boolean) => {
      const screen = await waitScreen(pane, { what, test: (s) => { const k = keysPanel(s); return !!k && test(k); }, ms: 15_000 });
      return { screen, k: keysPanel(screen)! };
    };
    const keep = (name: string, screen: string, what: string) => writeFileSync(join(CAPTURES, `${name}.txt`), `# ${new Date().toISOString()} · +${Date.now() - t0} ms · ${what}\n${scrub(screen, [box])}`);
    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c',
      `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
    try {
      await waitScreen(pane, { what: 'the Workbench on its first frame', re: /Activity & log/, ms: 60_000 });
      for (const [w, h] of [[160, 45], [120, 40], [100, 30]] as const) {
        if (w !== 160) {
          tmux('resize-window', '-t', 't', '-x', String(w), '-y', String(h));
          await waitScreen(pane, { what: `the Workbench redrawn at ${w}x${h}`, test: (s) => s.split('\n')[0].trimEnd().length <= w && s.replace(/\n$/, '').split('\n').length === h, ms: 15_000 });
        }
        await keys('?');
        const first = await keysWhen(`the Keys list at its first rows (${w}x${h})`, (k) => k.from === 1);
        const { to: height, of: total } = first.k;
        expect(total, `the Keys list fits at ${w}x${h}: nothing to scroll`).toBeGreaterThan(height);
        const rows: string[] = [];
        const keepRows = (k: NonNullable<ReturnType<typeof keysPanel>>) => { k.rows.forEach((r, i) => { rows[k.from - 1 + i] = r; }); };
        keepRows(first.k);
        await keys('Down');
        await keysWhen(`↓: rows 2–${height + 1} (${w}x${h})`, (k) => k.from === 2 && k.to === height + 1);
        await keys('j');
        await keysWhen(`j: rows 3–${height + 2} (${w}x${h})`, (k) => k.from === 3);
        await keys('k');
        await keysWhen(`k: rows 2– (${w}x${h})`, (k) => k.from === 2);
        await keys('Up');
        await keysWhen(`↑: rows 1– (${w}x${h})`, (k) => k.from === 1);
        await keys('PageDown');
        const paged = await keysWhen(`PgDn: a page down (${w}x${h})`, (k) => k.from > 3);
        keepRows(paged.k);
        expect(paged.k.to - paged.k.from + 1).toBe(height);
        await keys('PageUp');
        await keysWhen(`PgUp: rows 1– again (${w}x${h})`, (k) => k.from === 1);
        await keys('End');
        const end = await keysWhen(`End: its last rows (${w}x${h})`, (k) => k.to === total);
        expect(end.k.from).toBe(total - height + 1);
        keepRows(end.k);
        if (w === 100) keep('keys-100x30-end', end.screen, `the ? Keys list scrolled to its end with End at 100x30 (rows ${end.k.from}–${end.k.to} of ${end.k.of})`);
        if (w === 160) keep('keys-160x45-end', end.screen, `the ? Keys list scrolled to its end with End at 160x45 (rows ${end.k.from}–${end.k.to} of ${end.k.of})`);
        // the entries the review could not reach are on screen now: x, c s, C S, ",", i g, ?, Ctrl+C and the Marks legend's end
        const shown = end.k.rows.join(' ').replace(/\s+/g, ' ');
        expect(shown).toContain('Activity collapsed: the log');
        expect(shown).toContain('select an older row and it stays put as rows arrive');
        // Home: its first rows again; then a page at a time to its end, each row kept at its own place
        await keys('Home');
        await keysWhen(`Home: rows 1– again (${w}x${h})`, (k) => k.from === 1);
        for (let i = 0, at = 1; i < 30 && at < total - height + 1; i++) {
          await keys('PageDown');
          const p = await keysWhen(`PgDn, page ${i + 2} (${w}x${h})`, (k) => k.from > at);
          keepRows(p.k);
          at = p.k.from;
        }
        expect(rows.length).toBe(total);
        expect(rows.every((r) => r !== undefined), `a row of the Keys list never came into view at ${w}x${h}`).toBe(true);
        const all = rows.join(' ').replace(/\s+/g, ' ');
        for (const [key, words] of HELP) expect(all, `the Keys list's ${key} at ${w}x${h}`).toContain(`${key} ${words}`.replace(/\s+/g, ' '));
        await keys('Escape');
        await waitScreen(pane, { what: `the Keys list closed (${w}x${h})`, test: (s) => keysPanel(s) === null, ms: 10_000 });
      }
      await keys('C-c');
      // (it stopped nothing: R6 H141, exit 0)
      const after = await waitScreen(pane, { what: 'the Workbench ended', re: /EXIT=\d+/, ms: 20_000 });
      expect(after).toMatch(/EXIT=0\b/);
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
    }
  }, 240_000);
});
