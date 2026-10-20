// R7 (H150; REMAINING-DEFECTS row 3, H147's R6 finding 1): the colours the real Workbench (`timmy workbench`) writes in a real
// terminal (tmux, TERM=xterm-256color), read back with `capture-pane -e`: with no COLORTERM and TIMMY_PALETTE=homebrew, the
// Timmy Homebrew profile's slots (33 amber, 90 secondary grey) and the grey ramp's 238 for structure; with no COLORTERM and
// no known palette (this tmux does not answer the colour query), the nearest of the 256 (255 text, 245 secondary, 214 amber,
// 238 structure); with COLORTERM=truecolor, B10's colours exactly. Never chalk's own 256 guesses (231 white, 145 grey, 82
// green), which H147 measured before. Nothing FAKE is needed: the Workbench opens an empty folder of a sandbox of its own.
//
// Screens are kept, with their escape sequences, in TIMMY_PTY_CAPTURES (else <tmpdir>/timmy-workbench-captures).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { scrub, sendKeys, waitScreen, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const CAPTURES = process.env.TIMMY_PTY_CAPTURES || join(tmpdir(), 'timmy-workbench-captures');
const cleanups: Array<() => void> = [];
afterAll(() => { for (const c of cleanups.splice(0).reverse()) c(); });

/** The SGR parameter groups a screen holds (each colour or attribute set, as tmux writes them back). */
function sgrs(screen: string): Set<string> {
  const out = new Set<string>();
  for (const m of screen.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const p = m[1].split(';');
    for (let i = 0; i < p.length; i++) {
      if ((p[i] === '38' || p[i] === '48') && p[i + 1] === '5') { out.add(p.slice(i, i + 3).join(';')); i += 2; }
      else if ((p[i] === '38' || p[i] === '48') && p[i + 1] === '2') { out.add(p.slice(i, i + 5).join(';')); i += 4; }
      else out.add(p[i]);
    }
  }
  return out;
}

describe('the real Workbench\'s colours without truecolor (R7 H150; tmux)', () => {
  it('no COLORTERM: the Homebrew profile\'s slots under TIMMY_PALETTE=homebrew, else the nearest 256; truecolor exact; never chalk\'s 231, 145 or 82', async () => {
    const box = mkdtempSync(join(tmpdir(), 'wb-colours-pty-'));
    cleanups.push(() => rmSync(box, { recursive: true, force: true }));
    mkdirSync(CAPTURES, { recursive: true });
    const run = async (name: string, extra: NodeJS.ProcessEnv): Promise<Set<string>> => {
      const home = join(box, name, 'home');
      const repo = join(box, name, 'repo');
      for (const d of [home, repo, join(box, name, 'tmp')]) mkdirSync(d, { recursive: true });
      const base = withoutRunner(process.env);
      delete base.NODE_PATH;
      delete base.COLORTERM;
      delete base.TIMMY_PALETTE;
      const env: NodeJS.ProcessEnv = {
        ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(box, name, 'store'),
        TIMMY_SETTINGS_DIR: join(box, name, 'settings'), TMPDIR: join(box, name, 'tmp'), OPENROUTER_API_KEY: '', TERM: 'xterm-256color',
        TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...extra,
      };
      const label = `h150-col-${name}`;
      const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
      cleanups.push(() => { try { tmux('kill-server'); } catch { /* gone */ } });
      const exports = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ');
      // (tmux's server gives a new pane its own TERM: the Workbench's is set on its command line, with the case's variables)
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c',
        `env -u COLORTERM -u TIMMY_PALETTE TERM=xterm-256color ${exports} ${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
      const pane: Pane = { tmux, target: 't', folders: [box] };
      await waitScreen(pane, { what: `the Workbench (${name})`, re: /Activity & log/, ms: 90_000 });
      const screen = tmux('capture-pane', '-p', '-e', '-t', 't');
      writeFileSync(join(CAPTURES, `colours-${name}.txt`), `# ${new Date().toISOString()} · TERM=xterm-256color, ${exports || 'no COLORTERM, no TIMMY_PALETTE'} · capture-pane -e\n${scrub(screen, [box])}`);
      await sendKeys(pane, ['C-c']);
      await waitScreen(pane, { what: `the Workbench ended (${name})`, re: /EXIT=0\b/, ms: 20_000, frame: false });
      return sgrs(screen);
    };

    const homebrew = await run('homebrew', { TIMMY_PALETTE: 'homebrew' });
    for (const p of ['33', '90', '38;5;238']) expect(homebrew, `Homebrew's slots: ${p}`).toContain(p);
    for (const p of homebrew) expect(p, 'no 24-bit colour without COLORTERM').not.toMatch(/^[34]8;2;/);
    for (const p of ['38;5;231', '38;5;145', '38;5;82', '38;5;214', '38;5;255']) expect(homebrew, `under the profile, not ${p}`).not.toContain(p);

    const unknown = await run('unknown', {});
    for (const p of ['38;5;255', '38;5;245', '38;5;214', '38;5;238']) expect(unknown, `the nearest 256: ${p}`).toContain(p);
    for (const p of unknown) expect(p, 'no 24-bit colour without COLORTERM').not.toMatch(/^[34]8;2;/);
    for (const p of ['38;5;231', '38;5;145', '38;5;82']) expect(unknown, `never chalk's own guess ${p}`).not.toContain(p);

    const truecolor = await run('truecolor', { COLORTERM: 'truecolor' });
    for (const p of ['38;2;242;239;233', '38;2;142;142;147', '38;2;255;176;0', '38;2;68;68;68']) expect(truecolor, `B10 exactly: ${p}`).toContain(p);
    for (const p of truecolor) expect(p, 'no 256-colour guess with truecolor').not.toMatch(/^38;5;/);
  }, 220_000);
});
