/**
 * Project starters (round R2): `/project new <name> --from <starter>` makes the project from one of the
 * folders in templates/ instead of an empty folder. A starter is a set of ordinary editable files: the
 * project's own source from the first moment, with nothing generated behind it.
 *
 *   web-starter  a page, a zero-dependency development server (npm run dev) and a build workflow
 *   c4d-starter  a Cinema 4D scene script (/c4d scene.py) and its build workflow
 *
 * Only regular files are copied (a link in a starter is skipped), into a project folder that is new.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { packagedPath } from '../utils/asset-dirs.js';

export const STARTERS: Readonly<Record<string, string>> = {
  'web-starter': 'a page, a development server (npm run dev) and a build workflow',
  'c4d-starter': 'a Cinema 4D scene script (/c4d scene.py) and its build workflow',
};

/**
 * templates/ at the package root, found from this module's place in a checkout (src/project), the TypeScript build
 * (dist/src/project) or the bundled CLI (dist/<chunk>.js) by src/utils/asset-dirs.ts; undefined when it has none.
 */
export function startersDir(): string | undefined {
  return packagedPath('templates', import.meta.url, { kind: 'dir' });
}

/** The starters this Timmy has, with what each holds. */
export function listStarters(dir = startersDir()): { name: string; about: string }[] {
  if (!dir) return [];
  return Object.entries(STARTERS)
    .filter(([name]) => { try { return statSync(join(dir, name)).isDirectory(); } catch { return false; } })
    .map(([name, about]) => ({ name, about }));
}

function walk(dir: string, base: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, e.name);
    const st = lstatSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else if (st.isFile()) out.push(relative(base, abs));
  }
}

/** Copies a starter's files into `dest` (which must hold no files yet): their project-relative paths. */
export function copyStarter(name: string, dest: string, dir = startersDir()): { files: string[] } | { error: string } {
  if (!Object.hasOwn(STARTERS, name)) return { error: `no starter named ${name}: ${Object.keys(STARTERS).join(', ')}` };
  const from = dir ? join(dir, name) : '';
  try { if (!dir || !statSync(from).isDirectory()) throw new Error('missing'); } catch { return { error: `the ${name} starter is not in this Timmy (templates/${name})` }; }
  try { if (readdirSync(dest).length) return { error: 'the project folder is not empty; a starter only fills a new project' }; } catch { /* made below */ }
  const files: string[] = [];
  walk(from, from, files);
  try {
    for (const rel of files) {
      mkdirSync(dirname(join(dest, rel)), { recursive: true });
      copyFileSync(join(from, rel), join(dest, rel));
    }
  } catch (err) {
    return { error: `the copy stopped part way (${err instanceof Error ? err.message : 'error'}); the project holds what was copied` };
  }
  return { files };
}
