// R4 (H98, journey-2, item 7): a notice longer than the terminal is wrapped onto indented continuation lines (a hanging
// indent), never cut. At 80 columns a /run that fails ends in a line that names the job, the reason and the operation's
// id; each of them is on the screen, whole. Before, the REPL cut every notice at the width with "…" (main.ts
// fitSegments), and the operation id and the reason were lost. The REPL runs for real in a tmux terminal of 80 columns,
// its workflow under tests/fixtures/fake-upmd.mjs (UPMD_BIN), a labelled TEST DOUBLE of upmd 0.2.7 (it is not upmd) whose
// block runs for real in sh. Nothing here calls a model.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';

const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCK = 'a-block-that-fails-on-purpose';
const DOC = ['# Wrap', '', `\`\`\`bash [name:${BLOCK}]`, 'echo "this block fails on purpose" >&2', 'exit 3', '```', ''].join('\n');

/** A REPL in a tmux terminal of 80 x 50 of its own; `screen()` joins only what the terminal itself wrapped (-J). */
function terminal(dir: string, cwd: string, env: NodeJS.ProcessEnv) {
  const tenv = { ...env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'wrap', ...args], { env: tenv, encoding: 'utf8', timeout: 10_000 });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '50', '-c', cwd, 'bash', '--norc', '-c', `${TSX} ${CLI} repl; echo EXIT=$?; sleep 60`);
  const screen = () => tmux('capture-pane', '-p', '-J', '-S', '-400', '-t', 't');
  const waitFor = async (re: RegExp): Promise<string> => {
    for (let i = 0; i < 900; i++) {
      const s = screen();
      if (re.test(s)) return s;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${re}:\n${screen()}`);
  };
  const type = (text: string) => { tmux('send-keys', '-t', 't', '-l', text); tmux('send-keys', '-t', 't', 'Enter'); };
  const close = () => { try { tmux('kill-server'); } catch { /* gone */ } };
  return { waitFor, type, close };
}

describe('a notice wider than the terminal (R4 H98, journey-2)', () => {
  it('a failed /run at 80 columns: its end line wraps with a hanging indent, the job, the reason and the operation id whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'repl-wrap-'));
    const project = join(dir, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'WRAP.md'), DOC);
    const env = { ...withoutRunner(process.env), HOME: join(dir, 'home'), TIMMY_HOME: join(dir, 'home', 'timmy'), TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', UPMD_BIN: FAKE_UPMD, TIMMY_PALETTE: 'night' };
    mkdirSync(env.HOME, { recursive: true });
    const t = terminal(dir, project, env);
    try {
      await t.waitFor(/Enter to send/);
      t.type(`/run WRAP.md ${BLOCK}`);
      const s = await t.waitFor(/ failed {2}[\s\S]*Enter to send/);
      const lines = s.split('\n');
      // nothing the REPL wrote ran past the terminal's width (-J would have joined such a line back)
      for (const l of lines) expect([...l].length, l).toBeLessThanOrEqual(80);
      const at = lines.findIndex((l) => /^ {2}\S+ j[0-9a-f]{6} failed {2}/.test(l));
      expect(at, s).toBeGreaterThanOrEqual(0);
      const id = /(j[0-9a-f]{6}) failed/.exec(lines[at])![1];
      // its continuation lines: indented two columns more than the line they continue
      const more: string[] = [];
      for (let i = at + 1; i < lines.length && /^ {4}\S/.test(lines[i]); i++) more.push(lines[i]);
      expect(more.length, s).toBeGreaterThan(0);
      const notice = [lines[at], ...more].join('\n');
      expect(notice, notice).not.toContain('…');
      const whole = [lines[at].trim(), ...more.map((l) => l.trim())].join(' ');
      expect(whole).toContain(`${id} failed`);
      expect(whole).toContain(`${BLOCK} exited 3`);
      // the operation's id, whole, wherever the words put it
      expect(whole).toMatch(/\bo[0-9a-f]{8}\b/);
      t.type('/exit');
      await t.waitFor(/EXIT=\d+/);
    } finally {
      t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
