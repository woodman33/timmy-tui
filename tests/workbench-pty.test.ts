// R4 (H110): `timmy workbench` in a real terminal (tmux), over a sandbox of its own: HOME, the XDG folders, the Timmy home,
// the settings folder, the store, TMPDIR and the tmux server are all inside this test's temporary folder. The home is made by
// `timmy init --yes`, the project by the REPL's own `/project new tray1 --from tray-workflow` (through `timmy act`), and the
// Workbench is started as the installed command starts it (src/cli.ts through tsx's loader).
//
// FAKE here: one job, started through Timmy's real job store by a helper this test writes (a session that ends without
// stopping its job, as a REPL killed outright leaves one; the job runs a real `sleep 300`); upmd, a TEST DOUBLE of upmd
// 0.2.7 (tests/fixtures/fake-upmd.mjs, through UPMD_BIN; its blocks run for real through sh, on a pty through Timmy's own
// workers/upmd/pty_run.py where python3 is on PATH); and the browser openers on PATH (`open` and `xdg-open` stubs that only
// log; nothing in this file presses Show). The person at the NEEDS YOU box is this test's key presses. Everything else is the
// real program: the run detail's and the chat session's producers are absent in this revision, and the screens say so.
//
// The screens are kept (capture-pane -e as .ansi, plain as .txt) in <tmpdir>/timmy-workbench-captures, whose path the test
// prints: 160x45 Home and Workflows, 100x30 Control Room and 80x24 Files (slice A); the NEEDS YOU box, Activity after the run
// and Control Room with the run, at 160x45 (slice B).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const JOBS = pathToFileURL(resolve('src/jobs/index.ts')).href;
// FAKE: upmd is a TEST DOUBLE of upmd 0.2.7's --ci behaviour (tests/fixtures/fake-upmd.mjs); each block runs for real through sh
const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
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
const widest = (s: string) => Math.max(...s.split('\n').map((l) => [...l].length));

/** A tmux server of the test's own (its socket in the test's folder), its screen, its keys, and a kept capture. */
function terminal(label: string) {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const screen = () => tmux('capture-pane', '-p', '-t', 't');
  // R4 lead (full suite 35, at bfb7fe5: slice B's `a` did not expand Activity in 30 s, while the Workbench went on drawing;
  // the cause was not found, and loaded reruns and the next full suite passed): a wait that times out also says what the
  // terminal and its processes were doing, so a recurrence names its cause. tmux's flags for the pane; the bytes typed into
  // the pane's terminal that no process has read yet (FIONREAD: 1 for a key that never reached the Workbench); and each
  // process in the pane, with its state (and, on Linux, what it waits in).
  const diagnose = (): string => {
    const out: string[] = [];
    try {
      const [pid, tty, mode, inputOff, dead] = tmux('display', '-p', '-t', 't', '#{pane_pid} #{pane_tty} #{pane_in_mode} #{pane_input_off} #{pane_dead}').trim().split(' ');
      out.push(`the pane: shell pid ${pid}, terminal ${tty}, in a tmux mode ${mode}, input off ${inputOff}, dead ${dead}`);
      try {
        const unread = execFileSync('python3', ['-c', 'import fcntl,os,struct,sys,termios\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOCTTY|os.O_NONBLOCK)\nprint(struct.unpack("i",fcntl.ioctl(fd,termios.FIONREAD,b"\\0"*4))[0])', tty], { encoding: 'utf8', timeout: 5000 }).trim();
        out.push(`bytes typed into ${tty} and not read yet: ${unread}`);
      } catch (e) { out.push(`bytes not read yet: unknown (${String((e as Error).message).split('\n')[0]})`); }
      const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,etime=,args='], { encoding: 'utf8', timeout: 5000 }).split('\n').map((l) => l.trim()).filter(Boolean);
      const inPane = new Set([pid]);
      for (let grew = true; grew;) {
        grew = false;
        for (const r of rows) { const [p, pp] = r.split(/\s+/); if (inPane.has(pp) && !inPane.has(p)) { inPane.add(p); grew = true; } }
      }
      for (const r of rows) {
        const p = r.split(/\s+/)[0];
        if (!inPane.has(p)) continue;
        let wchan = '';
        try { wchan = ` (waits in ${readFileSync(`/proc/${p}/wchan`, 'utf8').trim() || 'nothing'})`; } catch { /* not Linux, or it has ended */ }
        out.push(`  ${r.slice(0, 200)}${wchan}`);
      }
    } catch (e) { out.push(`no diagnosis: ${String((e as Error).message).split('\n')[0]}`); }
    return out.join('\n');
  };
  const waitFor = async (re: RegExp, ms = 30_000): Promise<string> => {
    let s = '';
    for (const end = Date.now() + ms; Date.now() < end;) {
      s = screen();
      if (re.test(s)) return s;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${re}:\n${s}\n${diagnose()}`);
  };
  const keys = async (...k: string[]) => { for (const one of k) { tmux('send-keys', '-t', 't', one); await sleep(250); } };
  const typed = async (text: string) => { tmux('send-keys', '-t', 't', '-l', text); await sleep(250); };
  // the workspace search: '/', then its prompt on screen, the text, the text on screen, then Enter (under a loaded machine
  // the full suite once sent the text before the search was drawn)
  const find = async (name: string) => {
    tmux('send-keys', '-t', 't', '/');
    await waitFor(/^\S?\s*\/ /m, 10_000);
    tmux('send-keys', '-t', 't', '-l', name);
    await waitFor(new RegExp(`/ ${name}`), 10_000);
    tmux('send-keys', '-t', 't', 'Enter');
    await sleep(250);
  };
  const capture = (name: string): string => {
    const txt = screen();
    writeFileSync(join(CAPTURES, `${name}.ansi`), tmux('capture-pane', '-e', '-p', '-t', 't'));
    writeFileSync(join(CAPTURES, `${name}.txt`), txt);
    return txt;
  };
  const close = () => { try { tmux('kill-server'); } catch { /* gone */ } };
  return { tmux, screen, waitFor, keys, typed, find, capture, close };
}

/** R5 (H131; the QA round's defect 4): what waits on you over a tab, as row 1 draws it without moving a tab: ⚠ and the count
 *  in the top edge of the box whose label starts with `label` ('' when nothing is drawn there). */
function badgeOver(rows: readonly string[], label: string): string {
  for (let y = 1; y < Math.min(3, rows.length); y++) {
    const at = rows[y].indexOf(label);
    if (at < 0) continue;
    const left = Math.max(rows[y].lastIndexOf('│', at), rows[y].lastIndexOf('┃', at));
    const ends = ['│', '┃'].map((b) => rows[y].indexOf(b, at)).filter((i) => i >= 0);
    if (left < 0 || !ends.length) return '';
    return /⚠\d*/.exec(rows[y - 1].slice(left, Math.min(...ends) + 1))?.[0] ?? '';
  }
  return '';
}

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
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`, UPMD_BIN: FAKE_UPMD,
  };
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo']);
  expect(init.status, init.stderr).toBe(0);
  // the project, by the REPL's own /project new (it also writes the shared active-project record)
  const made = await cli(['act', '/project new tray1 --from tray-workflow']);
  expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
}, 150_000);

// R5 (H131): the hook's own retries take up to 10 s (50 x 200 ms), the default hook timeout: under a loaded machine it
// timed out while it still had retries left (seen once in a 4-file run); it gets the time its loop needs
afterAll(async () => {
  for (const label of ['wb', 'wbB']) { try { execFileSync('tmux', ['-L', label, 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ } }
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
}, 30_000);

describe('`timmy workbench` in a terminal (tmux; R4 H110)', () => {
  it('opens tray1 at 160x45 on Home (R5: row 1 the tabs, row 2 the workflow actions); 3 shows Workflows; Control Room and Activity show a FAKE job a session left; at 100x30 Stop names it and recovery\'s stop cancels it; at 80x24 Files shows the tree; the picker changes the active project; Ctrl+C restores the terminal', async () => {
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

    const { tmux, screen, waitFor, keys, typed, find, capture } = terminal('wb');

    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c',
      `stty -a > '${box}/stty-before.txt'; ${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; stty -a > '${box}/stty-after.txt'; sleep 600`);

    // 160x45: row 1 (TIMMY, the project, the ten tabs), row 2 (the workflow actions, the run state and Stop), Home's body,
    // Activity & log; the left job named by Stop and counted by Activity
    const home = await waitFor(new RegExp(`Stop current: ${id}[\\s\\S]*Activity\\s+\\S* ?1 running`));
    expect(home).toContain('TIMMY · tray1');
    for (const label of ['1 Home', '2 Chat & Intent', '3 Workflows', '7 Control Room', '0 Logs & Receipts']) expect(home).toContain(label);
    expect(home).toContain('Workflow actions');
    expect(home).toContain('tray1 / Home · connections, as observed');
    expect(home).toContain('Preview · the companion and Studio, in words');
    expect(home).toContain(`Stop current: ${id} FAKE job (test): sleep 300`);
    expect(widest(capture('wb-160x45-home'))).toBeLessThanOrEqual(160);
    // 3: Workflows, the tray workflow's blocks in its three columns (R5, H136: the whole width; Context a drawer, i)
    await keys('3');
    const wide = await waitFor(/tray1 \/ Workflows[\s\S]*SANDBOX/);
    for (const block of ['change', 'inspect', 'result', 'lesson', 'tidy']) expect(wide).toContain(block);
    expect(wide).toContain('⚠ needs you before it runs');
    expect(wide).toContain(`Stop current: ${id} FAKE job (test): sleep 300`);
    const workflows = capture('wb-160x45-workflows');
    expect(widest(workflows)).toBeLessThanOrEqual(160);

    // Control Room, by the workspace search
    await find('Control');
    const control = await waitFor(/tray1 \/ Control Room[\s\S]*RUNNING NOW \(1\)/);
    // (R5 H137: a pane, its id on the box's edge, its mark, word and label on the row below)
    expect(control).toMatch(new RegExp(`${id} [━─][^\\n]*\\n[^\\n]*▶ running {2}FAKE job \\(test\\): sleep 300`));

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
    await find('Files');
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

    console.log(`Workbench captures (160x45 Home and Workflows, 100x30 Control Room, 80x24 Files): ${CAPTURES}`);
  }, 180_000);

  it('slice B: runs APPROVAL.md › tidy from Workflows in the terminal: the NEEDS YOU box drawn in the Workbench (y), the run\'s progress in Activity, one job, one operation and one workflow receipt, the same operation for the REPL\'s /op and Studio\'s cards', async () => {
    // the project the run is in, by the REPL's own /project (the shared record)
    const chosen = await cli(['act', '/project tray1']);
    expect(chosen.status, chosen.stderr).toBe(0);
    const trayRoot = join(timmyHome, 'projects', 'tray1');
    expect(activeRoot()).toBe(trayRoot);
    const jobsDir = join(timmyHome, 'jobs');
    const runsOf = () => (existsSync(jobsDir) ? readdirSync(jobsDir) : []).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(jobsDir, n), 'utf8')) as { id: string; label: string; root: string; state: string; operation?: string }).filter((j) => j.root === trayRoot && j.label === 'APPROVAL.md › tidy');
    const store = join(box, 'store', 'runs.jsonl');
    const chain = (): Array<{ kind: string; operation_id?: string; decisions?: Array<{ decision: string }> }> => (existsSync(store) ? readFileSync(store, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => typeof r.prev_hash === 'string' && typeof r.hash === 'string') : []);
    expect(runsOf()).toEqual([]);
    const sealedBefore = chain().length;

    const { tmux, screen, waitFor, keys, typed, find, capture, close } = terminal('wbB');
    let runId = '';
    let op = '';
    try {
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c',
        `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
      await waitFor(/tray1 \/ [\s\S]*Activity/);
      await find('Workflows');
      const wf = await waitFor(/tray1 \/ Workflows[\s\S]*\[Enter\] Run it here/);
      expect(wf).toContain('upmd found');
      // Enter asks first; Enter again runs it through the REPL's own /run, whose NEEDS YOU box is drawn here
      await keys('Enter');
      await waitFor(/Run APPROVAL\.md › tidy\?/);
      await keys('Enter');
      const box = await waitFor(/⚠ NEEDS YOU[\s\S]*deny \(the default\)/);
      expect(box).toContain('/run APPROVAL.md tidy');
      expect(box).toContain('runs a destructive shell command on this machine: tidy');
      expect(box).toContain('mkdir -p scratch && touch scratch/x && rm scratch/x');
      // what waits on you, beside the Control Room's tab (R5: the workspace frame's count, read again within a second)
      for (const end = Date.now() + 10_000; badgeOver(screen().split('\n'), '7 Control') !== '⚠1';) {
        if (Date.now() > end) throw new Error(`timed out waiting for ⚠1 over 7 Control Room:\n${screen()}`);
        await sleep(100);
      }
      capture('wb-160x45-needs-you');
      // nothing of the run has started while the box waits
      expect(runsOf()).toEqual([]);
      expect(chain().length).toBe(sealedBefore);
      await sleep(500); // past the box's type-ahead guard
      await keys('y');
      for (const end = Date.now() + 30_000; !(runsOf()[0]?.state === 'completed') && Date.now() < end;) await sleep(100);
      const [run] = runsOf();
      expect(run).toMatchObject({ state: 'completed' });
      runId = run.id;
      op = run.operation!;
      expect(op).toMatch(/^o[0-9a-f]{8}$/);
      await waitFor(new RegExp(`${run.id} completed\\s+operation ${op}`));
      await waitFor(/Activity\s+0 running/);
      await keys('a');
      await waitFor(/▾ Activity[\s\S]*All operations/);
      const activity = capture('wb-160x45-activity-after-run');
      expect(activity).toMatch(new RegExp(`${run.id} tidy completed`));
      await keys('a');

      // one job, one operation, one prediction, one block receipt and one workflow receipt: no second execution
      expect(runsOf()).toHaveLength(1);
      const sealed = chain().slice(sealedBefore);
      expect(sealed.map((r) => r.kind)).toEqual(['predict', 'workflow-block', 'workflow']);
      expect(sealed.every((r) => r.operation_id === op)).toBe(true);
      expect(sealed[0].decisions?.[0]?.decision).toBe('allow once');
      for (let i = 0; i < 50 && !JSON.parse(readFileSync(join(trayRoot, '.timmy', 'operations', `${op}.json`), 'utf8')).ended; i++) await sleep(100);
      expect(JSON.parse(readFileSync(join(trayRoot, '.timmy', 'operations', `${op}.json`), 'utf8'))).toMatchObject({ request: '/run APPROVAL.md tidy', via: 'workbench', state: 'succeeded', runs: [{ kind: 'job', id: run.id }] });

      // Control Room: the same job and operation; the Inspector shows its run detail
      await find('Control');
      // (R5 H137: with nothing running, a quiet pane: its id on the box's edge, its word and label on the row below)
      const room = await waitFor(new RegExp(`${run.id} [━─][^\\n]*\\n[^\\n]*completed {2}APPROVAL\\.md › tidy`));
      expect(room).toContain(op);
      // R4 lead (merged with H102's producer, src/ops/run-detail.ts): the Inspector draws that operation's real run detail
      await waitFor(/RUN DETAIL/);
      const detail = await waitFor(/Verdict\s+completed/);
      expect(detail).toContain(op);
      capture('wb-160x45-control-run');

      await keys('C-c');
      expect((await waitFor(/EXIT=(\d+)/, 20_000)).match(/EXIT=(\d+)/)![1]).toBe('130');
    } finally {
      close();
    }

    // the same operation, read by the REPL's own /op (a separate process) and by Studio's cards (this process)
    const card = await cli(['act', `/op ${op}`, '--project', trayRoot]);
    expect(card.status, card.stderr).toBe(0);
    expect(card.stdout).toContain(op);
    expect(card.stdout).toContain('/run APPROVAL.md tidy');
    expect(card.stdout).toContain(runId);
    const { projectCards } = await import('../src/studio/project-cards.js');
    const cards = projectCards({ root: trayRoot, name: 'tray1', jobs: jobsDir, receipts: join(box, 'store') });
    expect(cards.operations?.find((o) => o.id === op)).toMatchObject({ request: '/run APPROVAL.md tidy', via: 'workbench' });
    // still one run of it
    expect(runsOf()).toHaveLength(1);
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
