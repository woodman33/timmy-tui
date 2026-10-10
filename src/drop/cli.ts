/**
 * `timmy drop` (R4 H19). Files and folders go into the hot-drop lanes through the one processor the watched drop folder
 * uses (./index.ts: dropInPlace, then processDrop). A file is copied into its lane's folder, never moved (a name already
 * there gets -2, -3), then the processor seals drop.intake, finds the rule that takes the name, writes a board in the
 * out folder and seals drop.result, which says what became of the work. No drop rule starts its tool yet, so no job is
 * started, and each result says why.
 *
 * The lane: --lane, else the one lane whose rules take the name; a name two lanes take is refused until --lane
 * chooses. A folder drops the visible files directly inside it; a lane folder, or a file in one, is processed where it
 * is. Refused, with nothing copied or sealed: a missing or unreadable file, a name no rule takes, a symbolic link that
 * leads outside the project (the active project when `timmy drop` runs inside it, else the working folder), private
 * files (keys, .env files) and hidden files.
 *
 * `timmy drop --list [project]` lists the files waiting in each project's drop/ folder (project-folder/v0, read through
 * fleet/harness-menu.mjs): the warroom-v2-c4m8 listing, which read the word "drop" as the project name.
 */
import { accessSync, constants, copyFileSync, lstatSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { privatePath, readActiveProject, sameFolder } from '../project/index.js';
import { cannotRead, dropInPlace, dropRoot, ensureDropLanes, laneNames, laneRules, matchRule, outRoot, type DropResult } from './index.js';

export interface DropCliOptions { json?: boolean; cwd?: string; out?: (line: string) => void; err?: (line: string) => void }

type Row =
  | { name: string; dropped: true; copy: string; inPlace: boolean; result: DropResult }
  | { name: string; dropped: false; reason: string; copyLeft?: string };

const PRIVATE = 'a private file (keys, .env files, .git and .timmy/private stay out)';

/** A path under the home folder, written from ~ (so a pasted result carries no home folder). */
export function tilde(p: string): string {
  const h = homedir();
  return h && (p === h || p.startsWith(h + sep)) ? `~${p.slice(h.length)}` : p;
}

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const lstatOr = (p: string): Stats | null => { try { return lstatSync(p); } catch { return null; } };
const statOr = (p: string): Stats | null => { try { return statSync(p); } catch { return null; } };
const realOr = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
const entries = (d: string): string[] => { try { return readdirSync(d).sort(); } catch { return []; } };
const code = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? 'error';
const numbered = (name: string, n: number): string => {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem}-${n}${ext && ext !== name ? ext : ''}`;
};

/** The project a symbolic link must stay inside: the active project when `timmy drop` runs inside it, else the working folder. */
function projectRoot(cwd: string): string {
  const p = readActiveProject(cwd);
  const root = realOr(p.root);
  const here = realOr(cwd);
  return p.chosen && (here === root || here.startsWith(root + sep)) ? root : here;
}

/** Where a symbolic link leads, when that stays in the project and is not a private file. */
function follow(path: string, project: string): { real: string } | { error: string } {
  let real: string;
  try { real = realpathSync(path); } catch { return { error: 'a broken symbolic link' }; }
  if (real !== project && !real.startsWith(project + sep)) return { error: 'a symbolic link that leads outside the project' };
  if (privatePath(relative(project, real))) return { error: 'a symbolic link to a private file (keys, .env files, .git and .timmy/private stay out)' };
  return { real };
}

/** A lane folder of the drop root (`<drop>/<lane>`), compared after links resolve. */
const isLaneFolder = (dir: string): boolean => sameFolder(dirname(dir), dropRoot()) && laneNames().includes(basename(dir));

function usage(): string {
  const lanes = laneNames().map((l) => `  ${l.padEnd(9)} ${laneRules(l).map((r) => `${r.glob} → ${r.template}`).join(' · ') || 'no rules'}`);
  return [
    'Usage: timmy drop <file|folder>… [--lane <lane>] [--json]',
    '       timmy drop --list [project] [--json]',
    '',
    `Copies each file into its lane's folder in ${tilde(dropRoot())} (never moves it) and hands it to the drop`,
    `processor: a drop.intake receipt, the rule that takes it, a board in ${tilde(outRoot())}/<lane>/ and a`,
    'drop.result receipt that says what became of the work. No drop rule starts its tool yet, so no job is',
    'started. A folder drops the files directly inside it; a file already in a lane folder is processed there.',
    '',
    '  --lane <lane>     the lane, for a name more than one lane takes',
    "  --list [project]  the files waiting in each project's drop/ folder",
    '  --json            one JSON object, for scripts',
    '',
    'Lanes and their rules:',
    ...lanes,
    '',
    'Exit 0: every file dropped. 1: a file not dropped. 2: a usage mistake.',
  ].join('\n');
}

const lanesLine = (): string => laneNames().map((l) => `${l} ${laneRules(l).map((r) => r.glob).join(' ')}`).join(' · ');

export async function dropMain(argv: string[], opts: DropCliOptions = {}): Promise<number> {
  const out = opts.out ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const err = opts.err ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const cwd = opts.cwd ?? process.cwd();
  let lane: string | undefined;
  let list = false;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { paths.push(...argv.slice(i + 1)); break; }
    if (a === '--help' || a === '-h') { out(usage()); return 0; }
    if (a === '--list') { list = true; continue; }
    if (a === '--lane' || a.startsWith('--lane=')) {
      const v = a === '--lane' ? argv[++i] : a.slice('--lane='.length);
      if (!v || v.startsWith('-')) { err('--lane needs a lane name.'); err(usage()); return 2; }
      lane = v;
      continue;
    }
    if (a.startsWith('-') && a !== '-') { err(`Unknown option ${a}.`); err(usage()); return 2; }
    paths.push(a);
  }
  if (list) return listShelves(paths, Boolean(opts.json), out, err);
  if (!paths.length) { err('Name a file or folder to drop.'); err(usage()); return 2; }
  if (lane !== undefined && !laneNames().includes(lane)) { err(`No lane named ${lane}: the lanes are ${laneNames().join(', ')}.`); return 2; }

  const project = projectRoot(cwd);
  let made: string | null = null; // why the lanes could not be made, once tried
  const rows: Row[] = [];
  const skipped: string[] = [];
  let noRule = false;
  const refuse = (name: string, reason: string): void => { rows.push({ name, dropped: false, reason }); };
  /** The lane folders and their rules, made once, the first time a file gets that far (never for a usage mistake). */
  const lanesMade = (): string | null => {
    if (made === null) {
      try { ensureDropLanes(); made = ''; } catch (e) { made = `the drop folder ${tilde(dropRoot())} cannot be made (${code(e)})`; }
    }
    return made || null;
  };

  /** A file in a lane folder: processed where it is, by the processor the watched folder uses. */
  const inPlace = (name: string, path: string): void => {
    const here = basename(dirname(path));
    if (lane !== undefined && lane !== here) return refuse(name, `it is in the ${here} lane's folder, not ${lane}`);
    const cannot = lanesMade();
    if (cannot) return refuse(name, cannot);
    const o = dropInPlace(path);
    rows.push(o.ok ? { name, dropped: true, copy: name, inPlace: true, result: o.result } : { name, dropped: false, reason: o.reason });
  };

  /** Any other file: checked, given a lane, copied into it, then processed there. */
  const copyIn = (name: string, path: string, real: string): void => {
    if (privatePath(path) || privatePath(name) || privatePath(real)) return refuse(name, PRIVATE);
    if (name.startsWith('.')) return refuse(name, 'a hidden file: the drop folders skip hidden files');
    const st = statOr(real);
    if (!st) return refuse(name, 'no such file');
    if (!st.isFile()) return refuse(name, 'not a regular file');
    try { accessSync(real, constants.R_OK); } catch (e) { return refuse(name, cannotRead(e)); }
    const cannot = lanesMade();
    if (cannot) return refuse(name, cannot);
    // The lane: --lane, else the one lane a rule of which takes the name (the same match the processor makes).
    let to: string;
    if (lane !== undefined) {
      if (!matchRule(lane, name)) return refuse(name, `no rule in the ${lane} lane takes ${name}`);
      to = lane;
    } else {
      const fits = laneNames().map((l) => ({ l, r: matchRule(l, name) })).filter((x) => x.r);
      if (!fits.length) { noRule = true; return refuse(name, `no drop rule takes ${name}`); }
      if (fits.length > 1) {
        const named = fits.map((x) => `${x.l} (${x.r!.glob} → ${x.r!.template})`);
        return refuse(name, `${fits.length === 2 ? 'two' : fits.length} lanes take it, ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}; choose one with --lane`);
      }
      to = fits[0].l;
    }
    // Copied, never moved; COPYFILE_EXCL never replaces what is there, so a name already in the lane gets -2, -3.
    let copy: string | undefined;
    for (let n = 1; n < 1000 && !copy; n++) {
      const candidate = n === 1 ? name : numbered(name, n);
      try { copyFileSync(real, join(dropRoot(), to, candidate), constants.COPYFILE_EXCL); copy = candidate; } catch (e) {
        if (code(e) === 'EEXIST') continue;
        return refuse(name, `could not be copied into the ${to} lane (${code(e)})`);
      }
    }
    if (!copy) return refuse(name, `no free name in the ${to} lane`);
    const o = dropInPlace(join(dropRoot(), to, copy));
    if (o.ok) rows.push({ name, dropped: true, copy, inPlace: false, result: o.result });
    else rows.push({ name, dropped: false, reason: o.reason, copyLeft: tilde(join(dropRoot(), to, copy)) });
  };

  /** One file named on the command line or found in a named folder. */
  const one = (name: string, path: string): void => {
    const st = lstatOr(path);
    if (!st) return refuse(name, 'no such file');
    let real = path;
    if (st.isSymbolicLink()) {
      const f = follow(path, project);
      if ('error' in f) return refuse(name, f.error);
      real = f.real;
    }
    if (sameFolder(dirname(dirname(path)), dropRoot()) && laneNames().includes(basename(dirname(path)))) return inPlace(name, path);
    copyIn(name, path, real);
  };

  for (const raw of paths) {
    const given = expandHome(raw);
    const path = isAbsolute(given) ? given : resolve(cwd, given);
    const name = basename(path) || raw;
    const st = lstatOr(path);
    if (!st) { refuse(name, 'no such file'); continue; }
    let real = path;
    if (st.isSymbolicLink()) {
      const f = follow(path, project);
      if ('error' in f) { refuse(name, f.error); continue; }
      real = f.real;
    }
    if (!statOr(real)?.isDirectory()) { one(name, path); continue; }
    // A folder: the drop root (every lane), a lane folder (its files where they are), or any other folder. Only the
    // files directly inside are taken; a lane folder's hidden files (.rules.cue) are never drops and go unmentioned.
    const before = rows.length;
    const here: string[] = [];
    const lanes = sameFolder(real, dropRoot()) ? laneNames().map((l) => join(path, l)) : isLaneFolder(real) ? [path] : null;
    for (const d of lanes ?? []) {
      for (const f of entries(d)) {
        if (f.startsWith('.')) continue;
        if (statOr(join(d, f))?.isDirectory()) { here.push(`${lanes!.length > 1 ? `${basename(d)}/` : ''}${f} (a folder)`); continue; }
        inPlace(f, join(d, f));
      }
    }
    if (!lanes) {
      for (const f of entries(real)) {
        const p = join(real, f);
        if (f.startsWith('.')) { here.push(`${f} (hidden)`); continue; }
        const fst = lstatOr(p);
        if (fst?.isDirectory() || (fst?.isSymbolicLink() && statOr(p)?.isDirectory())) { here.push(`${f} (a folder)`); continue; }
        one(f, p);
      }
    }
    if (rows.length === before) refuse(name, 'no files to drop in it (hidden files and folders inside it are skipped)');
    else if (here.length) skipped.push(`Skipped in ${name}: ${here.join(', ')}`);
  }

  const dropped = rows.filter((r) => r.dropped).length;
  const refused = rows.length - dropped;
  if (opts.json) {
    out(JSON.stringify({
      v: 1, dropped, refused,
      results: rows.map((r) => (r.dropped
        ? { name: r.name, dropped: true, lane: r.result.lane, copy: r.copy, in_place: r.inPlace, rule: r.result.rule, template: r.result.template, status: r.result.status, why: r.result.why, job: null, board: r.result.out ? tilde(r.result.out) : null, receipts: r.result.receipts }
        : { name: r.name, dropped: false, reason: r.reason, ...(r.copyLeft ? { copy_left: r.copyLeft } : {}) })),
      skipped,
    }, null, 1));
    return refused ? 1 : 0;
  }
  for (const r of rows) {
    if (!r.dropped) { out(`Not dropped ${r.name}: ${r.reason}${r.copyLeft ? `; its copy stays at ${r.copyLeft}` : ''}`); continue; }
    const x = r.result;
    const where = r.inPlace ? `in the ${x.lane} lane (already in its folder)` : `${r.copy !== r.name ? `as ${r.copy} ` : ''}into the ${x.lane} lane`;
    out(`Dropped ${r.name} ${where}: rule ${x.rule} → ${x.template}`);
    out(`  not started: ${x.why}. No job was started.`);
    if (x.out) out(`  board ${tilde(x.out)}`);
    out(`  receipts drop.intake ${x.receipts.intake.slice(7, 15)} · drop.result ${x.receipts.result.slice(7, 15)}`);
  }
  for (const s of skipped) out(s);
  if (noRule) out(`The lanes take: ${lanesLine()}`);
  if (rows.length > 1) out(`${dropped} dropped, ${refused} not dropped.`);
  return refused ? 1 : 0;
}

/** `--list [project]`: the files waiting in each project's drop/ folder, with their sizes. */
async function listShelves(names: string[], json: boolean, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  if (names.length > 1) { err('--list takes one project name.'); return 2; }
  const hm = await import('../../fleet/harness-menu.mjs');
  const root = hm.PROJECTS_ROOT;
  const want = names[0];
  const isDir = (p: string): boolean => Boolean(statOr(p)?.isDirectory());
  if (want !== undefined && (!want || want.includes('/') || want.startsWith('.') || !isDir(join(root, want)))) {
    err(`no project named ${want} in ${tilde(root)}`);
    return 1;
  }
  const projects = want !== undefined ? [want] : entries(root).filter((n) => !n.startsWith('.') && isDir(join(root, n)));
  const rows: { project: string; file: string; bytes: number }[] = [];
  for (const n of projects) {
    const p = hm.readProject(n, root);
    for (const d of (p.drop ?? []) as Array<{ path?: string; name?: string; bytes?: number; dir?: boolean }>) {
      if (d.dir) continue; // a folder deeper than the shelf's first level
      rows.push({ project: n, file: String(d.path ?? d.name ?? ''), bytes: d.bytes ?? 0 });
    }
  }
  if (json) out(JSON.stringify({ v: 1, count: rows.length, rows }, null, 1));
  else if (!rows.length) out(want !== undefined ? `No files in ${want}'s drop/ folder (${tilde(join(root, want, 'drop'))}).` : `No files in any project's drop/ folder in ${tilde(root)}.`);
  else for (const r of rows) out(`${r.project.padEnd(14)} ${String(r.bytes).padStart(9)}  ${r.file}`);
  return 0;
}
