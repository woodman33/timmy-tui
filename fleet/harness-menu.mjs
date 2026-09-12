// Harness menu reader — project-folder/v0 (mindship-v5c2 step 5).
//
// Every harness menu reads the project folder through this one module, so a
// harness sees exactly what the folder holds: skills it may load, plans it
// may run, boards it may compile, what was dropped in, what came out, and the
// profile that bounds it (allowed harnesses, budget, models, receipt store).
// The reader never writes anything except out/menu.json when asked to.
//
//   import { readProject, harnessMenu, PROJECTS_ROOT } from '../fleet/harness-menu.mjs'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

export const STANDARD = 'project-folder/v0';
export const PROJECTS_ROOT = process.env.TIMMY_PROJECTS_ROOT ?? join(homedir(), 'timmy', 'projects');
export const LAYOUT = ['skills', 'plans', 'boards', 'drop', 'out'];
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Parse profile.cue: `cue export` when cue is installed, else the plain key: value subset. */
export function readProfile(dir) {
  const p = join(dir, 'profile.cue');
  if (!existsSync(p)) return { ok: false, error: 'profile.cue missing', path: p };
  const text = readFileSync(p, 'utf8');
  const cue = spawnSync('cue', ['export', p, '-e', 'profile'], { encoding: 'utf8' });
  if (cue.status === 0) {
    try { return { ok: true, via: 'cue', path: p, profile: JSON.parse(cue.stdout) }; } catch { /* fall through */ }
  }
  return { ok: true, via: 'plain', path: p, profile: plainProfile(text), cue_error: cue.status === 0 ? null : (cue.stderr ?? cue.error?.message ?? 'cue not available').split('\n')[0] };
}

function plainProfile(text) {
  const body = text.slice(text.indexOf('profile:'));
  const str = (k) => (body.match(new RegExp(`\\b${k}:\\s*"([^"]*)"`)) ?? [])[1] ?? null;
  const num = (k) => { const m = body.match(new RegExp(`\\b${k}:\\s*([0-9.]+)`)); return m ? Number(m[1]) : null; };
  const list = (k) => { const m = body.match(new RegExp(`\\b${k}:\\s*\\[([^\\]]*)\\]`)); return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : []; };
  return {
    name: str('name'), owner: str('owner'), created: str('created'), standard: str('standard') ?? STANDARD,
    harnesses: { allowed: list('allowed'), preferred: str('preferred') ?? '' },
    budget: { max_spend_usd: num('max_spend_usd') ?? 2 },
    models: { mind: str('mind') ?? 'google/gemini-3.7-flash', actors: list('actors') },
    receipts: { store: str('store') },
    tags: list('tags')
  };
}

const listFiles = (dir, depth = 1) => {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (depth > 0) out.push(...listFiles(p, depth - 1).map((f) => ({ ...f, path: join(name, f.path) }))); else out.push({ path: name, dir: true }); }
    else out.push({ path: name, bytes: st.size, mtime: st.mtime.toISOString() });
  }
  return out;
};

function firstLine(p, re) {
  try { for (const line of readFileSync(p, 'utf8').split('\n')) { const m = line.match(re); if (m) return m[1].trim(); } } catch { /* unreadable */ }
  return null;
}

/** The whole folder as data. */
export function readProject(name, root = PROJECTS_ROOT) {
  const dir = join(root, name);
  if (!existsSync(dir)) return { ok: false, error: `no project at ${dir}`, dir };
  const missing = LAYOUT.filter((d) => !existsSync(join(dir, d)));
  const profile = readProfile(dir);
  const skills = existsSync(join(dir, 'skills')) ? readdirSync(join(dir, 'skills')).filter((n) => !n.startsWith('.') && statSync(join(dir, 'skills', n)).isDirectory()).sort().map((n) => {
    const md = join(dir, 'skills', n, 'SKILL.md');
    return { name: n, path: join('skills', n), skill_md: existsSync(md), description: existsSync(md) ? (firstLine(md, /^description:\s*(.+)$/) ?? firstLine(md, /^#\s+(.+)$/)) : null };
  }) : [];
  const plans = listFiles(join(dir, 'plans')).map((f) => ({ ...f, path: join('plans', f.path), title: /\.md$/.test(f.path) ? firstLine(join(dir, 'plans', f.path), /^#\s+(.+)$/) : null }));
  const boards = listFiles(join(dir, 'boards')).filter((f) => extname(f.path) === '.json').map((f) => {
    let kind = null; let title = null;
    try { const j = JSON.parse(readFileSync(join(dir, 'boards', f.path), 'utf8')); kind = j.kind ?? null; title = j.name ?? j.title ?? null; } catch { /* not a board */ }
    return { ...f, path: join('boards', f.path), kind, title };
  });
  return {
    ok: missing.length === 0 && profile.ok,
    standard: STANDARD,
    name,
    dir,
    missing,
    profile: profile.profile ?? null,
    profile_via: profile.via ?? null,
    profile_error: profile.error ?? profile.cue_error ?? null,
    skills,
    plans,
    boards,
    drop: listFiles(join(dir, 'drop')).map((f) => ({ ...f, path: join('drop', f.path) })),
    out: listFiles(join(dir, 'out')).map((f) => ({ ...f, path: join('out', f.path) }))
  };
}

/** What one harness is offered: the folder, filtered by the profile, plus how to launch it there. */
export function harnessMenu(project, harness, runners = {}) {
  const allowed = project.profile?.harnesses?.allowed ?? [];
  const permitted = !harness || allowed.length === 0 || allowed.includes(harness);
  const runner = harness ? runners[harness] ?? null : null;
  return {
    v: 1,
    standard: STANDARD,
    generated_at: new Date().toISOString(),
    project: project.name,
    dir: project.dir,
    harness: harness ?? null,
    permitted,
    reason: permitted ? null : `profile allows ${allowed.join(', ') || 'nobody'}; ${harness} is not listed`,
    budget_usd: project.profile?.budget?.max_spend_usd ?? null,
    models: project.profile?.models ?? null,
    receipts_store: project.profile?.receipts?.store ?? null,
    skills: project.skills,
    plans: project.plans,
    boards: project.boards,
    drop: project.drop,
    out: project.out.filter((f) => f.path !== 'out/menu.json'),
    launch: runner ? { cmd: runner.cmd, cwd: project.dir, task: runner.task ?? null, blurb: runner.blurb ?? null, env: { TIMMY_PROJECT: project.name, TIMMY_PROJECT_DIR: project.dir, TIMMY_WORKSPACE: join(project.dir, 'out') } } : null,
    rules: [
      'read this menu before acting; the folder is the whole world for this run',
      'inputs come from drop/, outputs go to out/, never elsewhere',
      'plans in plans/ are proposals until the controller arms them',
      'every receipt seals into receipts_store (the root store), never a subdirectory'
    ]
  };
}

export function writeMenu(project, menu) {
  const p = join(project.dir, 'out', 'menu.json');
  writeFileSync(p, JSON.stringify(menu, null, 1));
  return p;
}

export const projectNames = (root = PROJECTS_ROOT) => existsSync(root) ? readdirSync(root).filter((n) => !n.startsWith('.') && statSync(join(root, n)).isDirectory()).sort() : [];
export { basename };
