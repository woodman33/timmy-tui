/**
 * Round R4 (helper H107; r25, the scripted rehearsal on the operator's Mac at 5e5cbb3, findings D5 and D6): whole lines.
 *
 * D5: upmd's output in a workflow job's log wrapped at about 40 columns, mid-word. Timmy runs upmd on a terminal of its own
 * (workers/upmd/pty_run.py), and that terminal had no size (a new pty's is 0 by 0). The wrapper now gives it a wide one, so
 * a long line a block prints reaches the job's log whole.
 *
 * D6: at 80 columns a progress line broke "run 1 s" with the "s" alone on the next line. The REPL's wrapper
 * (src/repl/notice-wrap.ts) now never breaks inside a number and its unit ("1 s", "4.2 s", "1 min 30 s"), after "run" or
 * "exit" before their number, or inside "1 of 3".
 *
 * FAKE: upmd is tests/fixtures/fake-upmd.mjs, a TEST DOUBLE of upmd 0.2.7 (it is not upmd), in its pty mode; with
 * FAKE_UPMD_WRAP=1 it also wraps each line a block prints at its terminal's width, at 40 columns when its terminal has no
 * size: a model of what r25 saw on the Mac (upmd's own rule is not known here). The wrapper and the terminal are real
 * (python3's pty), and so are the /run job and its log.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { wrapSegments } from '../src/repl/notice-wrap.js';
import { elapsedWords, progressWords } from '../src/repl/run-progress.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Segment } from '../src/term/theme.js';
import { visibleWidth } from '../src/term/width.js';
import { PTY_RUN_SCRIPT } from '../src/workflows/upmd-live.js';

const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
const STTY = String(spawnSync('sh', ['-c', 'command -v stty'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!PYTHON3) console.warn('run-lines-whole: no python3 here, so the pty checks are skipped');
const FAKE_UPMD = path.resolve('tests/fixtures/fake-upmd.mjs');
const g = glyphSet(true);
const dirs: string[] = [];
const spaces: Workspace[] = [];
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };

describe.skipIf(!PYTHON3 || !STTY)('D5: the terminal workers/upmd/pty_run.py gives a command has a wide size (a real pty)', () => {
  it('stty on that terminal reads a size, wide enough for a long line (a new pty is 0 by 0)', () => {
    const r = spawnSync(PYTHON3!, ['-I', PTY_RUN_SCRIPT, '--', STTY!, 'size'], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const m = /^(\d+) (\d+)\s*$/m.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(24); // rows
    expect(Number(m![2])).toBeGreaterThanOrEqual(1000); // columns
  });
});

describe.skipIf(!PYTHON3)('D5: a long line a block prints, kept whole in the /run job\'s log (FAKE upmd in its pty mode, a real pty)', () => {
  it('a 300-character line reaches the job log as one line', async () => {
    const root = temp('h107-long-');
    const home = temp('h107-long-home-');
    const LONG = Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(2, '0')}xx`).join(' '); // 30 words, 299 characters
    fs.writeFileSync(path.join(root, 'LONG.md'), ['# FAKE workflow', '', '```bash [name:long]', `echo "${LONG}"`, '```', ''].join('\n'));
    vi.stubEnv('FAKE_UPMD_WRAP', '1'); // the FAKE upmd's model of the Mac: it wraps what a block prints at its terminal's width
    vi.stubEnv('TIMMY_STORE', path.join(root, '.timmy', 'receipts'));
    const ws = new Workspace({
      glyphs: g, env: { ...process.env, UPMD_BIN: FAKE_UPMD }, onPath: (cmd) => (cmd === 'python3' ? PYTHON3 : null),
      notify: () => {}, openWeb: (u) => u, link: (t) => t, seal: () => undefined,
      jobsDir: path.join(home, 'jobs'), chdir: () => {}, recoverAtStart: false, roomTools: async () => [],
    }, folderProject(root));
    spaces.push(ws);
    const started = (await ws.run('LONG.md long')).map((l) => l.map((x) => x.text).join('')).join('\n');
    const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
    expect(job, started).toBeDefined();
    expect(started).not.toContain('Live block states are not available');
    const done = await ws.jobs.done(job!);
    expect(done.state).toBe('completed');
    const log = fs.readFileSync(done.logPath, 'utf8');
    // upmd's summary of the block gives its output again, indented by two spaces: the whole line, once a line of its own
    const lines = log.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));
    expect(lines.filter((l) => l.trim() === LONG).length, log).toBeGreaterThan(0);
    expect(lines.some((l) => l.trim() === LONG.slice(0, 38).trim()), 'a line cut at about 40 columns').toBe(false);
  }, 60_000);
});

const rows = (line: Segment[], width: number): string[] => wrapSegments(line, width).map((r) => r.map((s) => s.text).join(''));
/** A progress line as src/repl/run-progress.ts writes one, its head padded by `pad` characters. */
const progress = (pad: number, elapsedMs: number): Segment[] => [
  { text: `  ${g.bullet} ` }, { text: 'ja8e289', role: 'strong' },
  { text: `  still running: ${progressWords({ ended: 0, of: 3, elapsedMs, block: `change${'x'.repeat(pad)}`, flow: { id: 'f1a2b3c4d', kind: 'scad', step: 'agent' } }, ` ${g.sep} `)}`, role: 'secondary' },
];

describe('D6: a progress line never breaks inside "run 1 s" and its like (src/repl/notice-wrap.ts)', () => {
  it('at 80 columns, wherever the line puts it, "run 1 s" and "run 1 min 30 s" stay on one row, and every row fits', () => {
    for (const ms of [1_000, 90_000]) {
      const said = `run ${elapsedWords(ms)}`;
      for (let pad = 0; pad <= 60; pad++) {
        const r = rows(progress(pad, ms), 80);
        for (const row of r) expect(visibleWidth(row), row).toBeLessThanOrEqual(80);
        expect(r.some((row) => row.includes(said)), `${said}, pad ${pad}:\n${r.join('\n')}`).toBe(true);
      }
    }
  });

  it('"exit 4", "4.2 s", "1 of 3" and "12 KB" stay whole too; other words still break between them', () => {
    const words = ['exit 4', '4.2 s', '1 of 3', '12 KB'];
    for (const w of words) {
      for (let pad = 0; pad <= 40; pad++) {
        const line: Segment[] = [{ text: `  ${g.bullet} ` }, { text: 'j1a2b3c', role: 'strong' }, { text: `  ${'word '.repeat(6)}${'y'.repeat(pad)} ${w} after it`, role: 'secondary' }];
        const r = rows(line, 60);
        for (const row of r) expect(visibleWidth(row), row).toBeLessThanOrEqual(60);
        expect(r.some((row) => row.includes(w)), `${w}, pad ${pad}:\n${r.join('\n')}`).toBe(true);
      }
    }
    // the words of a line are kept, only the breaks move
    const line: Segment[] = [{ text: '  the run took 4.2 s and exit 4 came after 1 of 3 blocks, then the log of 12 KB was kept', role: 'secondary' }];
    const r = rows(line, 30);
    expect(r.join(' ').split(/\s+/).filter(Boolean)).toEqual(line[0].text.split(/\s+/).filter(Boolean));
    for (const row of r) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
  });

  it('a row too narrow for such a group breaks it as words again (never by cells, never wider than the row)', () => {
    const r = rows([{ text: '  run 1 min 30 s' }], 8);
    for (const row of r) expect(visibleWidth(row), row).toBeLessThanOrEqual(8);
    expect(r.join(' ').split(/\s+/).filter(Boolean)).toEqual(['run', '1', 'min', '30', 's']);
  });
});
