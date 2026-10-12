// R4 (H110): `timmy workbench` in a real terminal (tmux), over a sandbox of its own: HOME, the XDG folders, the Timmy home,
// the settings folder, the store, TMPDIR and the tmux server are all inside this test's temporary folder. The home is made by
// `timmy init --yes`, the project by the REPL's own `/project new tray1 --from tray-workflow` (through `timmy act`), and the
// Workbench is started as the installed command starts it (src/cli.ts through tsx's loader).
//
// FAKE here: one job, started through Timmy's real job store by a helper this test writes (a session that ends without
// stopping its job, as a REPL killed outright leaves one; the job runs a real `sleep 300`), and the browser openers on PATH
// (`open` and `xdg-open` stubs that only log; nothing in this file presses Show). Everything else is the real program.
//
// The screens are kept (capture-pane -e as .ansi, plain as .txt) in <tmpdir>/timmy-workbench-captures, whose path the test
// prints: 160x45 Workflows, 100x30 Control Room and 80x24 Files.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const JOBS = pathToFileURL(resolve('src/jobs/index.ts')).href;
const CAPTURES = join(tmpdir(), 'timmy-workbench-captures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let box = '';
let repo = '';
let timmyHome = '';
let env: NodeJS.ProcessEnv = {};

const cli = (args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout });
const recordOf = (id: string) => JSON.parse(readFileSync(join(timmyHome, 'jobs', `${id}.json`), 'utf8')) as { state: string; pid?: number; error?: string; cleanup?: string };
const argsOf = (pid: number): string | null => {
  try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null; } catch { return null; }
};
const activeRoot = (): string => JSON.parse(readFileSync(join(timmyHome, 'state', 'active-project.json'), 'utf8')).root;

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-pty-'));
  const home = join(box, 'home');
  repo = join(box, 'repo');
  timmyHome = join(home, 'timmy');
  const bin = join(box, 'fakebin');
  for (const d of [home, repo, bin, join(box, 'tmp'), join(box, 'settings'), CAPTURES]) mkdirSync(d, { recursive: true });
  // FAKE openers: a Show pressed here would only be logged (none is pressed in this file)
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${box}/opened.log'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const base = withoutRunner(process.env);
  delete base.NODE_PATH;
  env = {
    ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: timmyHome, TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(box, 'store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo']);
  expect(init.status, init.stderr).toBe(0);
  // the project, by the REPL's own /project new (it also writes the shared active-project record)
  const made = await cli(['act', '/project new tray1 --from tray-workflow']);
  expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
}, 150_000);

afterAll(async () => {
  try { execFileSync('tmux', ['-L', 'wb', 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ }
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
});

describe('`timmy workbench` in a terminal (tmux; R4 H110)', () => {
  it('opens tray1 at 160x45 on Workflows; Control Room and Activity show a FAKE job a session left; at 100x30 Stop names it and recovery\'s stop cancels it; at 80x24 Files shows the tree; the picker changes the active project; Ctrl+C restores the terminal', async () => {
    const trayRoot = join(timmyHome, 'projects', 'tray1');
    expect(activeRoot()).toBe(trayRoot);

    // FAKE: a session that starts one job through Timmy's real job store and ends without stopping it
    const helper = join(box, 'fake-left-job.mts');
    writeFileSync(helper, [
      '// FAKE job (test only): a session that starts one job and ends without stopping it; prints the job id',
      `import { JobManager } from '${JOBS}';`,
      'const [dir, root, project] = process.argv.slice(2);',
      'const jobs = new JobManager({ dir });',
      "const j = jobs.start({ kind: 'task', label: 'FAKE job (test): sleep 300', project, root, command: 'sleep', args: ['300'] });",
      "for (let i = 0; i < 100 && jobs.get(j.id)?.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 50));",
      'console.log(j.id);',
      'process.exit(0);',
      '',
    ].join('\n'));
    const left = await runAsync(process.execPath, ['--import', LOADER, helper, join(timmyHome, 'jobs'), trayRoot, 'tray1'], { cwd: repo, env, timeout: 30_000 });
    expect(left.status, left.stderr).toBe(0);
    const id = left.stdout.trim();
    expect(id).toMatch(/^j[0-9a-f]+$/);
    const pid = recordOf(id).pid!;
    expect(recordOf(id).state).toBe('running');
    expect(argsOf(pid)).toBe('sleep 300');

    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'wb', ...args], { env, encoding: 'utf8', timeout: 10_000 });
    const screen = () => tmux('capture-pane', '-p', '-t', 't');
    const waitFor = async (re: RegExp, ms = 30_000): Promise<string> => {
      let s = '';
      for (const end = Date.now() + ms; Date.now() < end;) {
        s = screen();
        if (re.test(s)) return s;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${re}:\n${s}`);
    };
    const keys = async (...k: string[]) => { for (const one of k) { tmux('send-keys', '-t', 't', one); await sleep(250); } };
    const typed = async (text: string) => { tmux('send-keys', '-t', 't', '-l', text); await sleep(250); };
    const capture = (name: string): string => {
      const txt = screen();
      writeFileSync(join(CAPTURES, `${name}.ansi`), tmux('capture-pane', '-e', '-p', '-t', 't'));
      writeFileSync(join(CAPTURES, `${name}.txt`), txt);
      return txt;
    };
    const widest = (s: string) => Math.max(...s.split('\n').map((l) => [...l].length));

    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c',
      `stty -a > '${box}/stty-before.txt'; ${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; stty -a > '${box}/stty-after.txt'; sleep 600`);

    // 160x45: every zone; the project; the tray workflow's blocks; the left job named by Stop and counted by Activity
    const wide = await waitFor(new RegExp(`Stop current: ${id}[\\s\\S]*Activity\\s+\\S* ?1 running`));
    expect(wide).toContain('tray1 / Workflows');
    expect(wide).toMatch(/◆ TIMMY|TIMMY/);
    expect(wide).toMatch(/CREATE[\s\S]*OPERATE[\s\S]*LIBRARY[\s\S]*Connections/);
    expect(wide).toContain('Timmy Workbench');
    expect(wide).toContain('Context');
    for (const block of ['change', 'inspect', 'result', 'lesson', 'tidy']) expect(wide).toContain(block);
    expect(wide).toContain('⚠ needs you before it runs');
    expect(wide).toContain(`Stop current: ${id} FAKE job (test): sleep 300`);
    const workflows = capture('wb-160x45-workflows');
    expect(widest(workflows)).toBeLessThanOrEqual(160);

    // Control Room, by the workspace search
    await keys('/');
    await typed('Control');
    await keys('Enter');
    const control = await waitFor(/tray1 \/ Control Room[\s\S]*RUNNING NOW \(1\)/);
    expect(control).toMatch(new RegExp(`${id}\\s+running\\s+FAKE job \\(test\\): sleep 300`));

    // 100x30: the right dock is a drawer; the project, the task, the state and Stop stay on top
    tmux('resize-window', '-t', 't', '-x', '100', '-y', '30');
    const medium = await waitFor(new RegExp(`tray1 / Control Room[\\s\\S]*RUNNING NOW \\(1\\)[\\s\\S]*${id}`));
    expect(medium).not.toMatch(/╭─ Context|┏━ ◆ Context/);
    expect(medium).toContain(`Stop current: ${id}`);
    const controlShot = capture('wb-100x30-control');
    expect(widest(controlShot)).toBeLessThanOrEqual(100);

    // x: the job a session that ended left, stopped through recovery's stop; its record says cancelled; its process is gone
    await keys('x');
    // the outcome first, so the one row of a narrow terminal shows it; the whole answer in Activity, expanded
    await waitFor(new RegExp(`Stopped ${id}; its record says cancelled\\.`));
    for (const end = Date.now() + 10_000; recordOf(id).state === 'running' && Date.now() < end;) await sleep(100);
    expect(recordOf(id)).toMatchObject({ state: 'cancelled', cleanup: 'complete' });
    for (const end = Date.now() + 5000; argsOf(pid) === 'sleep 300' && Date.now() < end;) await sleep(100);
    expect(argsOf(pid)).not.toBe('sleep 300');
    await waitFor(/Stop current: idle/);
    await keys('a');
    const activity = await waitFor(/▾ Activity[\s\S]*All operations/);
    expect(activity.replace(/[│┃]/g, ' ').replace(/\s+/g, ' ')).toContain(`Stopped ${id}; its record says cancelled. FAKE job (test): sleep 300: the session that started it had ended, so recovery's stop ended its process group`);
    await keys('a');

    // 80x24: the navigation is a drawer too; Files shows the project's tree
    tmux('resize-window', '-t', 't', '-x', '80', '-y', '24');
    await waitFor(/tray1 \/ Control Room/);
    await keys('/');
    await typed('Files');
    await keys('Enter');
    const files = await waitFor(/tray1 \/ Files[\s\S]*WORKFLOW\.md/);
    for (const f of ['APPROVAL.md', 'WORKFLOW.md', 'README.md']) expect(files).toContain(f);
    expect(files).toMatch(/recipes/);
    expect(files).not.toMatch(/CREATE/);
    expect(files).toMatch(/run: idle\s+Stop current: idle/);
    const filesShot = capture('wb-80x24-files');
    expect(widest(filesShot)).toBeLessThanOrEqual(80);

    // the picker: another project, written to the shared active-project record
    await keys('p');
    await waitFor(/Switch project/);
    await typed('demo');
    await keys('Enter');
    await waitFor(/demo \/ Files/);
    expect(activeRoot()).toBe(join(timmyHome, 'projects', 'demo'));

    // Ctrl+C: nothing of the Workbench's own runs, so it quits at once (130); the terminal is as it was
    await keys('C-c');
    const after = await waitFor(/EXIT=(\d+)/, 20_000);
    expect(after.match(/EXIT=(\d+)/)![1]).toBe('130');
    for (const end = Date.now() + 5000; !existsSync(join(box, 'stty-after.txt')) && Date.now() < end;) await sleep(100);
    expect(tmux('display-message', '-p', '-t', 't', '#{alternate_on} #{cursor_flag} #{mouse_any_flag}').trim()).toBe('0 1 0');
    // the terminal's modes as before (its first line, speed and size, differs only by the resizes above)
    const modes = (f: string) => readFileSync(join(box, f), 'utf8').split('\n').slice(1).join('\n');
    expect(modes('stty-after.txt')).toBe(modes('stty-before.txt'));
    expect(modes('stty-after.txt')).toMatch(/(^|\s)icanon(\s|$)[\s\S]*(^|\s)echo(\s|$)/);
    expect(existsSync(join(box, 'opened.log'))).toBe(false);

    console.log(`Workbench captures (160x45 Workflows, 100x30 Control Room, 80x24 Files): ${CAPTURES}`);
  }, 180_000);

  it('without a terminal: --json prints the state model and exits 0; plain exits 78 with its cause and fix; --help 0; an unknown argument 2', async () => {
    const json = await cli(['workbench', '--json']);
    expect(json.status, json.stderr).toBe(0);
    const s = JSON.parse(json.stdout);
    expect(s.schema).toBe('timmy.workbench/1');
    // the project the shared record names (the picker above chose demo)
    expect(s.project.name).toBe(JSON.parse(readFileSync(join(timmyHome, 'state', 'active-project.json'), 'utf8')).name);
    expect(s.navigation.map((g: { group: string }) => g.group)).toEqual(['CREATE', 'OPERATE', 'LIBRARY', 'FOOT']);
    expect(s.activity).toMatchObject({ running: 0, stop_current: { job: null, words: 'Stop current: idle' } });
    expect(s.route.words).toMatch(/^chat: /);

    const plain = await cli(['workbench']);
    expect(plain.status).toBe(78);
    expect(plain.stderr).toMatch(/^Error: timmy workbench needs a terminal\.\n {2}Cause: .*not a terminal here.*\n {2}Try: run it in a terminal window; timmy workbench --json/);
    expect(plain.stdout).toBe('');

    const help = await cli(['workbench', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('timmy workbench [--json] [--help]');

    const wrong = await cli(['workbench', 'extra']);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('Usage: timmy workbench [--json] [--help]');
  }, 120_000);
});
