// R4 H19: `timmy drop` through the real CLI entry (src/cli.ts run by tsx, as tests/repl-follow.test.ts runs it). Each test
// is a temporary project (the working folder) with its own HOME, TIMMY_HOME, receipt store and TMPDIR; the drop and out
// folders are the defaults under that HOME (~/timmy/drop and ~/timmy/out), so printed paths start with ~.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyChain } from '../src/utils/receipts.js';

const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, 'project', 'refs', 'locked.jpg'), 0o644); } catch { /* not made */ }
    rmSync(d, { recursive: true, force: true });
  }
});

interface Sandbox { base: string; home: string; project: string; store: string; drop: string; out: string; env: NodeJS.ProcessEnv }

function sandbox(): Sandbox {
  const base = mkdtempSync(join(tmpdir(), 'timmy-drop-cli-'));
  dirs.push(base);
  const home = join(base, 'home');
  const project = join(base, 'project');
  const store = join(base, 'store');
  for (const d of [home, join(project, 'refs'), join(base, 'tmp')]) mkdirSync(d, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_STORE: store, TMPDIR: join(base, 'tmp'), NO_COLOR: '1', NODE_ENV: '' };
  for (const k of ['TIMMY_DROP_ROOT', 'TIMMY_OUT_ROOT', 'TIMMY_PROJECTS_ROOT', 'ROBOFLOW_API_KEY', 'TIMMY_FORGE', 'TIMMY_DEFOLD_BUILD']) delete env[k];
  return { base, home, project, store, drop: join(home, 'timmy', 'drop'), out: join(home, 'timmy', 'out'), env };
}

/** Root reads any file whatever its mode; without the two DAC capabilities it is held to the mode like anyone else. */
const asRoot = process.getuid?.() === 0;
const setpriv = asRoot ? spawnSync('setpriv', ['--version'], { encoding: 'utf8' }).status === 0 : false;

function drop(s: Sandbox, args: string[], opts: { honourModes?: boolean } = {}): SpawnSyncReturns<string> {
  const argv = [TSX, CLI, 'drop', ...args];
  const [cmd, ...rest] = opts.honourModes && asRoot ? ['setpriv', '--bounding-set=-dac_override,-dac_read_search', ...argv] : argv;
  return spawnSync(cmd, rest, { cwd: s.project, env: s.env, encoding: 'utf8', timeout: 90_000 });
}

/** The sealed receipts in the store (bus event lines carry no top-level hash). */
function receipts(s: Sandbox): Array<Record<string, unknown> & { subject: string; hash: string }> {
  const p = join(s.store, 'runs.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => typeof r.hash === 'string');
}
const short = (hash: string): string => hash.slice(7, 15);
const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const laneFiles = (s: Sandbox, lane: string): string[] => (existsSync(join(s.drop, lane)) ? readdirSync(join(s.drop, lane)).filter((n) => n !== '.rules.cue').sort() : []);
const LANES_LINE = 'The lanes take: defold *.riv *.spine · houdini *.png *.jpg · observer *.png *.mp4';

describe('timmy drop <file|folder>…', { timeout: 120_000 }, () => {
  it('drops a file a rule takes: copies it into the lane, runs the processor, prints the result and seals both receipts', () => {
    const s = sandbox();
    const bytes = 'reference sheet bytes';
    writeFileSync(join(s.project, 'refs', 'ref.jpg'), bytes);
    const r = drop(s, ['refs/ref.jpg']);
    expect(r.status, r.stderr).toBe(0);
    const recs = receipts(s);
    const intake = recs.find((x) => x.subject === 'drop.intake houdini/ref.jpg');
    const result = recs.find((x) => x.subject === 'drop.result houdini/ref.jpg');
    expect(intake && result).toBeTruthy();
    expect(r.stdout.split('\n')).toEqual([
      'Dropped ref.jpg into the houdini lane: rule *.jpg → houdini-sceneforge',
      '  not started: SceneForge is in the forge lane, which is off unless TIMMY_FORGE=1 (decisions.md D1). No job was started.',
      '  board ~/timmy/out/houdini/ref.jpg.board.json',
      `  receipts drop.intake ${short(intake!.hash)} · drop.result ${short(result!.hash)}`,
      '',
    ]);
    // copied, never moved: the source is untouched and the lane folder holds an identical copy
    expect(readFileSync(join(s.project, 'refs', 'ref.jpg'), 'utf8')).toBe(bytes);
    expect(readFileSync(join(s.drop, 'houdini', 'ref.jpg'), 'utf8')).toBe(bytes);
    // the processor's own outputs: the board, and the two receipts it seals
    const board = JSON.parse(readFileSync(join(s.out, 'houdini', 'ref.jpg.board.json'), 'utf8'));
    expect(board).toMatchObject({ lane: 'houdini', file: 'ref.jpg', sha: sha256(bytes), template: 'houdini-sceneforge', rule: '*.jpg', status: 'not_configured', armed: false });
    expect(intake).toMatchObject({ status: 'ok', path: 'houdini/ref.jpg', sha: sha256(bytes), lane: 'houdini' });
    expect(result).toMatchObject({ status: 'failed', error_class: 'not_configured', template: 'houdini-sceneforge', rule: '*.jpg', out: 'houdini/ref.jpg.board.json' });
    // receipts name the file by lane and name: no folder of this machine reaches the chain
    const raw = readFileSync(join(s.store, 'runs.jsonl'), 'utf8');
    expect(raw).not.toContain(s.home);
    expect(raw).not.toContain(s.project);
    const prev = process.env.TIMMY_STORE;
    process.env.TIMMY_STORE = s.store;
    try { expect(verifyChain('runs')).toMatchObject({ ok: true, count: 2 }); } finally { if (prev === undefined) delete process.env.TIMMY_STORE; else process.env.TIMMY_STORE = prev; }
  });

  it('a name two lanes take is refused until --lane chooses one', () => {
    const s = sandbox();
    writeFileSync(join(s.project, 'refs', 'frame.png'), 'png bytes');
    const r = drop(s, ['refs/frame.png']);
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')).toEqual([
      'Not dropped frame.png: two lanes take it, houdini (*.png → houdini-sceneforge) and observer (*.png → observer-roboflow); choose one with --lane',
      '',
    ]);
    expect(laneFiles(s, 'houdini').concat(laneFiles(s, 'observer'))).toEqual([]);
    expect(receipts(s)).toEqual([]);
    const ok = drop(s, ['--lane', 'observer', 'refs/frame.png']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.split('\n').slice(0, 2)).toEqual([
      'Dropped frame.png into the observer lane: rule *.png → observer-roboflow',
      '  not started: Roboflow detection needs ROBOFLOW_API_KEY. No job was started.',
    ]);
    expect(laneFiles(s, 'observer')).toEqual(['frame.png']);
    expect(receipts(s).map((x) => x.subject)).toEqual(['drop.intake observer/frame.png', 'drop.result observer/frame.png']);
  });

  it('with no file named, says so with the usage and exits 2, writing nothing', () => {
    const s = sandbox();
    const r = drop(s, []);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^Name a file or folder to drop\.\n/);
    expect(r.stderr).toContain('Usage: timmy drop <file|folder>… [--lane <lane>] [--json]');
    expect(existsSync(s.drop)).toBe(false);
    expect(existsSync(s.store)).toBe(false);
  });

  it('a missing file is not dropped: no such file, exit 1, nothing sealed', () => {
    const s = sandbox();
    const r = drop(s, ['--lane', 'observer', 'refs/nope.png']);
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')).toEqual(['Not dropped nope.png: no such file', '']);
    expect(receipts(s)).toEqual([]);
  });

  it.skipIf(asRoot && !setpriv)('an unreadable file is not dropped: cannot be read, exit 1, nothing copied or sealed', () => {
    const s = sandbox();
    const locked = join(s.project, 'refs', 'locked.jpg');
    writeFileSync(locked, 'secret');
    chmodSync(locked, 0o000);
    const r = drop(s, ['refs/locked.jpg'], { honourModes: true });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')).toEqual(['Not dropped locked.jpg: cannot be read (permission denied)', '']);
    expect(laneFiles(s, 'houdini')).toEqual([]);
    expect(receipts(s)).toEqual([]);
  });

  it('a name no rule takes is not dropped: the rules are named, exit 1, nothing sealed', () => {
    const s = sandbox();
    writeFileSync(join(s.project, 'refs', 'notes.txt'), 'notes');
    const r = drop(s, ['refs/notes.txt']);
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')).toEqual(['Not dropped notes.txt: no drop rule takes notes.txt', LANES_LINE, '']);
    expect(receipts(s)).toEqual([]);
  });

  it('a symbolic link that leads outside the project is not dropped: exit 1, its target never copied', () => {
    const s = sandbox();
    mkdirSync(join(s.base, 'outside'));
    writeFileSync(join(s.base, 'outside', 'secret.jpg'), 'outside bytes');
    symlinkSync(join(s.base, 'outside', 'secret.jpg'), join(s.project, 'refs', 'escape.jpg'));
    const r = drop(s, ['refs/escape.jpg']);
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')).toEqual(['Not dropped escape.jpg: a symbolic link that leads outside the project', '']);
    expect(laneFiles(s, 'houdini')).toEqual([]);
    expect(receipts(s)).toEqual([]);
  });

  it('a folder drops the files directly inside it, follows a link that stays in the project, and refuses one that leaves', () => {
    const s = sandbox();
    const refs = join(s.project, 'refs');
    writeFileSync(join(refs, 'a.jpg'), 'a');
    writeFileSync(join(refs, 'b.mp4'), 'b');
    writeFileSync(join(refs, '.DS_Store'), 'finder');
    mkdirSync(join(refs, 'sub'));
    writeFileSync(join(refs, 'sub', 'c.jpg'), 'c');
    mkdirSync(join(s.project, 'assets'));
    writeFileSync(join(s.project, 'assets', 'real.riv'), 'rive');
    symlinkSync(join('..', 'assets', 'real.riv'), join(refs, 'inside.riv'));
    mkdirSync(join(s.base, 'outside'));
    writeFileSync(join(s.base, 'outside', 'x.jpg'), 'x');
    symlinkSync(join(s.base, 'outside', 'x.jpg'), join(refs, 'escape.jpg'));
    const r = drop(s, ['refs']);
    expect(r.status).toBe(1);
    const lines = r.stdout.split('\n');
    expect(lines.filter((l) => !l.startsWith('  '))).toEqual([
      'Dropped a.jpg into the houdini lane: rule *.jpg → houdini-sceneforge',
      'Dropped b.mp4 into the observer lane: rule *.mp4 → observer-roboflow',
      'Not dropped escape.jpg: a symbolic link that leads outside the project',
      'Dropped inside.riv into the defold lane: rule *.riv → defold-build',
      'Skipped in refs: .DS_Store (hidden), sub (a folder)',
      '3 dropped, 1 not dropped.',
      '',
    ]);
    expect(lines).toContain('  not started: a Defold build needs TIMMY_DEFOLD_BUILD. No job was started.');
    expect(laneFiles(s, 'houdini')).toEqual(['a.jpg']);
    expect(laneFiles(s, 'observer')).toEqual(['b.mp4']);
    expect(readFileSync(join(s.drop, 'defold', 'inside.riv'), 'utf8')).toBe('rive');
    expect(receipts(s).filter((x) => x.subject.startsWith('drop.intake')).map((x) => x.subject).sort()).toEqual(['drop.intake defold/inside.riv', 'drop.intake houdini/a.jpg', 'drop.intake observer/b.mp4']);
  });

  it('a file already in a lane folder is processed where it is, by the processor the watched folder uses', () => {
    const s = sandbox();
    mkdirSync(join(s.drop, 'observer'), { recursive: true });
    writeFileSync(join(s.drop, 'observer', 'clip.mp4'), 'clip');
    const r = drop(s, [join(s.drop, 'observer')]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('Dropped clip.mp4 in the observer lane (already in its folder): rule *.mp4 → observer-roboflow');
    expect(laneFiles(s, 'observer')).toEqual(['clip.mp4']);
    expect(receipts(s).map((x) => x.subject)).toEqual(['drop.intake observer/clip.mp4', 'drop.result observer/clip.mp4']);
  });

  it('--json gives one object for scripts, with no job for any file', () => {
    const s = sandbox();
    writeFileSync(join(s.project, 'refs', 'hero.riv'), 'rive');
    const r = drop(s, ['refs/hero.riv', 'refs/missing.riv', '--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ v: 1, dropped: 1, refused: 1 });
    expect(j.results[0]).toMatchObject({ name: 'hero.riv', dropped: true, lane: 'defold', rule: '*.riv', template: 'defold-build', status: 'not_configured', job: null, board: '~/timmy/out/defold/hero.riv.board.json' });
    expect(j.results[1]).toEqual({ name: 'missing.riv', dropped: false, reason: 'no such file' });
  });
});

describe('timmy drop --list [project]', { timeout: 120_000 }, () => {
  it('reads the project it is given, with each file\'s size, and names a project that is not there', () => {
    const s = sandbox();
    const projects = join(s.home, 'timmy', 'projects');
    mkdirSync(join(projects, 'alpha', 'drop'), { recursive: true });
    writeFileSync(join(projects, 'alpha', 'drop', 'shot.png'), '12345');
    mkdirSync(join(projects, 'beta', 'drop'), { recursive: true });
    writeFileSync(join(projects, 'beta', 'drop', 'take.mov'), '1234567');
    const row = (project: string, bytes: number, file: string): string => `${project.padEnd(14)} ${String(bytes).padStart(9)}  ${file}\n`;
    const one = drop(s, ['--list', 'beta']);
    expect(one.status, one.stderr).toBe(0);
    expect(one.stdout).toBe(row('beta', 7, 'drop/take.mov'));
    const all = drop(s, ['--list']);
    expect(all.stdout).toBe(row('alpha', 5, 'drop/shot.png') + row('beta', 7, 'drop/take.mov'));
    const none = drop(s, ['--list', 'gamma']);
    expect(none.status).toBe(1);
    expect(none.stderr).toBe('no project named gamma in ~/timmy/projects\n');
  });
});
