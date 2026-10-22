/**
 * R6 (H144): the Workbench's tab 3 in a real terminal (tmux, 160x45), on a project whose newest run is the FAKE run of
 * tests/helpers/run-inspect-fixture.ts, made by the REPL's own Workspace in this process (its job, its operation and its
 * receipts, sealed for real on the project's own chain). The real program (src/cli.ts workbench, through tsx's loader, as
 * the installed command starts it) draws that run inspected: its source as it ran, its changes with the first one's diff
 * (− and + marked), its log, and each stage's receipts verified now. Its screen is kept (capture-pane -e as .ansi, plain as
 * .txt, and the .ansi drawn cell for cell in Chromium as a .png, in the colours the terminal was sent) only when
 * TIMMY_H144_CAPTURES names a folder.
 *
 * FAKE, as there: upmd (tests/fixtures/fake-upmd.mjs, a TEST DOUBLE of upmd 0.2.7) and the `change` block's flow
 * (tests/fixtures/fake-params-flow.ts, a TEST DOUBLE of /iterate: no agent runs, nothing is built). Every folder is the
 * test's own, under os.tmpdir(): HOME, the Timmy home, the store, TMPDIR and the tmux server.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { HOMEBREW } from '../src/theme/tokens.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { opsKit, replOf, sandbox } from './helpers/ops-sandbox.js';
import { reportProject, runOf } from './helpers/run-inspect-fixture.js';
import { keepScreen, sendKeys, waitScreen, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = path.resolve('src/cli.ts');
const FAKE_UPMD = path.resolve('tests/fixtures/fake-upmd.mjs');
const CAPS = process.env.TIMMY_H144_CAPTURES ? path.resolve(process.env.TIMMY_H144_CAPTURES) : '';
const tmuxHere = ((): boolean => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!tmuxHere) console.warn('workbench-run-inspect-pty: no tmux here, so the terminal check is skipped');

/** A screen kept by capture-pane -e as HTML: each run of its text in the colour, weight and ground its escape codes set. */
function screenHtml(ansi: string, label: string): string {
  const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // links and character-set switches carry no colour: left out
  const text = ansi.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '');
  let fg = HOMEBREW.text;
  let bg = HOMEBREW.ground;
  let bold = false;
  let inverse = false;
  let underline = false;
  const out: string[] = [];
  const put = (t: string): void => {
    if (!t) return;
    const [f, b] = inverse ? [bg, fg] : [fg, bg];
    out.push(`<span style="color:${f};background:${b};${bold ? 'font-weight:700;' : ''}${underline ? 'text-decoration:underline;' : ''}">${esc(t)}</span>`);
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    put(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = HOMEBREW.text; bg = HOMEBREW.ground; bold = false; inverse = false; underline = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 4) underline = true;
      else if (c === 24) underline = false;
      else if (c === 7) inverse = true;
      else if (c === 27) inverse = false;
      else if (c === 39) fg = HOMEBREW.text;
      else if (c === 49) bg = HOMEBREW.ground;
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) { const rgb = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; if (c === 38) fg = rgb; else bg = rgb; i += 4; }
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) i += 2;
    }
  }
  put(text.slice(last));
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:10px 14px;background:${HOMEBREW.ground};color:${HOMEBREW.text};font:13px/1.32 'Monaspace Argon','DejaVu Sans Mono',monospace}pre{margin:0;font:inherit;white-space:pre}.label{color:${HOMEBREW.textSecondary};white-space:pre-wrap;margin:0 0 10px;max-width:160ch}</style><p class="label">${esc(label)}</p><pre>${out.join('')}</pre>`;
}

const kit = opsKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);

describe.skipIf(!tmuxHere)('the Workbench\'s tab 3 in a real terminal: the newest run inspected (R6 H144)', () => {
  it('3 shows the FAKE run\'s source as it ran, its changes with the parameter file\'s diff (− 140, + 150), its log and each stage\'s receipts verified now', async () => {
    const s = sandbox(kit, 'wb-inspect-pty-');
    reportProject(s);
    const { ws } = replOf(kit, s);
    const { op } = await runOf(ws, 'REPORT.md', 'report');
    for (const d of ['tmp', 'settings']) mkdirSync(path.join(s.base, d), { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...withoutRunner(s.env), TMPDIR: path.join(s.base, 'tmp'), TIMMY_SETTINGS_DIR: path.join(s.base, 'settings'), XDG_CONFIG_HOME: path.join(s.home, '.config'),
      XDG_DATA_HOME: path.join(s.home, '.local', 'share'), XDG_STATE_HOME: path.join(s.home, '.local', 'state'), XDG_CACHE_HOME: path.join(s.home, '.cache'),
      UPMD_BIN: FAKE_UPMD, OPENROUTER_API_KEY: '', COLORTERM: 'truecolor', TMUX: '', TMUX_TMPDIR: s.base, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    };
    delete env.NO_COLOR;
    const tmux = (...args: string[]): string => execFileSync('tmux', ['-L', 'wbinspect', ...args], { env, encoding: 'utf8', timeout: 10_000 });
    const pane: Pane = { tmux, target: 't', folders: [s.base] };
    try {
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', s.root, 'bash', '--norc', '-c',
        `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
      await waitScreen(pane, { what: 'the Workbench on its project', re: /Activity/, ms: 60_000 });
      await sendKeys(pane, ['3']);
      // the run inspected (read with the tab) and its run detail (read by the controller through the producer): the .predict
      // card frozen before the run, and the checks
      const screen = await waitScreen(pane, {
        what: 'tab 3 with the run inspected and its run detail read', ms: 30_000,
        test: (t) => /RESULT · \d+ files written/.test(t) && /\.predict ✓ · run ✓ 3 · \.receipt ✓/.test(t) && /frozen before the run/.test(t) && /✓ block \w+ matches/.test(t),
      });
      // (R10 H167: the source as it ran, its hash, and the review command are the Inspector's, [i])
      expect(screen).toMatch(/SOURCE · REPORT\.md as it ran/);
      expect(screen).not.toMatch(/sha256 [0-9a-f]{12}/);
      expect(screen).toMatch(/✓ the same bytes now/);
      expect(screen).not.toContain(`/review ${op}`);
      expect(screen).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@ against the version Timmy kept/);
      expect(screen).toMatch(/− +"width": 140,/);
      expect(screen).toContain('The companion (c) draws this run');
      expect(screen).not.toContain(`/run/${op}`);
      if (CAPS) {
        const name = 'workbench-tab3-160x45-tmux-source-changes-receipts';
        mkdirSync(CAPS, { recursive: true });
        keepScreen(pane, CAPS, name, { what: 'tab 3, whole', foot: 'drawn' });
        const exe = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium'].find((x): x is string => Boolean(x) && existsSync(x!));
        if (exe) {
          const browser = await chromium.launch({ headless: true, executablePath: exe });
          try {
            const page = await browser.newPage({ viewport: { width: 1300, height: 400 }, deviceScaleFactor: 1 });
            await page.setContent(screenHtml(readFileSync(path.join(CAPS, `${name}.ansi`), 'utf8'), `The terminal Workbench (src/cli.ts workbench) in tmux at 160x45, tab 3: its screen as capture-pane -e kept it (${name}.ansi), drawn cell for cell in Chromium in the colours the terminal was sent. FAKE run: REPORT.md (tests/helpers/run-inspect-fixture.ts; upmd and the change block's flow are test doubles).`));
            await page.screenshot({ path: path.join(CAPS, `${name}.png`), fullPage: true });
          } finally { await browser.close(); }
        }
      }
      await sendKeys(pane, ['C-c']);
      const end = await waitScreen(pane, { what: 'the Workbench ended', re: /EXIT=\d+/, frame: false, ms: 20_000 });
      // the FAKE run had ended before the Workbench started, so Ctrl+C stopped nothing: 0 since H141's quit (ff17f40;
      // 130 only when it stopped a job or a chat turn this Workbench started). CI at f035d28 found the old 130 here.
      expect(end).toMatch(/EXIT=0\b/);
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
    }
  }, 180_000);
});
