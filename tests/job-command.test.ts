/**
 * Round R4 (helper H88; the Mac run r23): how `/jobs <id>` says how a job ran (src/repl/job-command.ts): its program and its
 * arguments as its record keeps them, the project, Timmy's home and Timmy's own folder by name, any other path under a home
 * folder from "~"; and when a later recovery recorded a job's end, that, not the time until then ("88 min").
 * Pure functions over records in the shapes src/jobs writes (SYNTHETIC: built here, nothing ran); the folders are temporary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobRecord } from '../src/jobs/index.js';
import { endedByRecovery, jobCommandWords, ranWords } from '../src/repl/job-command.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };

describe('/jobs <id>: how the job ran', () => {
  it('a /run on a pty: python3, the wrapper, then upmd --ci -b <block> -d <project> <run folder>/checked.md, with no absolute path under a home', () => {
    const home = temp('h88-home-');
    const timmy = path.join(home, 'timmy');
    const root = path.join(home, 'work', 'my tray');
    const pkg = temp('h88-pkg-');
    const run = path.join(timmy, 'jobs', 'runs', 'w0a1b2c3d');
    const j = {
      root, project: 'my tray', command: '/usr/bin/python3',
      args: ['-I', path.join(pkg, 'workers', 'upmd', 'pty_run.py'), '--parent', '4242', '--stop-file', path.join(run, 'stop.json'), '--', path.join(home, '.local', 'bin', 'upmd'), '--ci', '-b', 'build', '-d', root, path.join(run, 'checked.md')],
    };
    const said = jobCommandWords(j, { timmyHome: timmy, env: { HOME: home }, packageRoot: pkg });
    expect(said).toBe("/usr/bin/python3 -I [Timmy]/workers/upmd/pty_run.py --parent 4242 --stop-file [Timmy home]/jobs/runs/w0a1b2c3d/stop.json -- ~/.local/bin/upmd --ci -b build -d '[project my tray]' [Timmy home]/jobs/runs/w0a1b2c3d/checked.md");
    expect(said).not.toContain(home);
    // a folder that only begins like the project's is not the project's
    expect(jobCommandWords({ ...j, args: [`${root}-copy/x`] }, { timmyHome: timmy, env: { HOME: home }, packageRoot: pkg })).toBe("/usr/bin/python3 '~/work/my tray-copy/x'");
  });

  it('the account\'s own home is written from ~ too, when HOME is another folder (r23\'s sandbox)', () => {
    const account = os.userInfo().homedir;
    const said = jobCommandWords({ root: '/nowhere/p', project: 'p', command: path.join(account, 'bin', 'tool'), args: [] }, { timmyHome: '/nowhere/timmy', env: { HOME: temp('h88-sandbox-home-') }, packageRoot: null });
    expect(said).toBe('~/bin/tool');
  });
});

describe('/jobs: a job whose end a later recovery recorded', () => {
  const base = { steps: [] as JobRecord['steps'] };
  it('says when its end was recorded and why, and its blocks\' own times; never the time until that recovery (r23: "88 min")', () => {
    const j = {
      ...base, endedAt: '2026-10-11T14:30:00.000Z', error: 'interrupted: its timmy md ended while long was running; its process is gone', interrupted: { step: 'long' },
      steps: [{ name: 'first', state: 'completed' as const, startedAt: '2026-10-11T13:02:00.000Z', endedAt: '2026-10-11T13:02:00.050Z' }, { name: 'long', state: 'interrupted' as const, startedAt: '2026-10-11T13:02:00.100Z', endedAt: '2026-10-11T13:02:05.400Z' }],
    };
    expect(endedByRecovery(j)).toBe(true);
    expect(ranWords(j, '88 min')).toBe("ended unseen: a later recovery recorded its end at 2026-10-11 14:30 UTC, after the Timmy that ran it had ended; its blocks' own times: first <0.1 s, long 5.3 s");
  });
  it('a job that ended in its own Timmy (a stop, an exit, a second Ctrl-C) keeps its time', () => {
    expect(ranWords({ ...base, endedAt: '2026-10-11T14:30:00.000Z', error: 'stopped by timmy md at once (a second SIGINT): …' }, '5.3 s')).toBe('5.3 s');
    expect(ranWords({ ...base, endedAt: undefined }, '12 s')).toBe('12 s');
  });
});
