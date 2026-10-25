// The build's version files (npm's prebuild and pretest run this).
//
// - src/version.ts: the package's version, as before (a tracked file; its content changes only with package.json's version).
// - dist/build-info.json (R10, H163): the git revision a packed build was made from (src/build-info.ts reads it). Written only
//   when TIMMY_BUILD_REVISION names the checkout's HEAD, which scripts/review/build-review.sh sets for its npm pack; a value
//   that is not HEAD stops the build. Without it (npm test, a plain build) a stamp an earlier build left is removed, so a build
//   never carries another revision's stamp: it says its revision is unknown instead.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Env = Record<string, string | undefined>;
const STAMP_SCHEMA = 'timmy-build-info/1';

export interface GenerateResult { ok: boolean; version: string; stamp: 'written' | 'removed' | 'none'; words: string }

export function generateBuildFiles(o: { root: string; env?: Env; now?: () => Date }): GenerateResult {
  const env = o.env ?? process.env;
  const pkg = JSON.parse(fs.readFileSync(path.join(o.root, 'package.json'), 'utf8')) as { version: string };
  const version = pkg.version;
  fs.writeFileSync(path.join(o.root, 'src', 'version.ts'), `// This file is generated automatically. Do not edit.\nexport const VERSION = '${version}';\n`, 'utf8');
  const stampPath = path.join(o.root, 'dist', 'build-info.json');
  const removeStamp = (): boolean => { try { fs.rmSync(stampPath); return true; } catch { return false; } };

  const asked = env.TIMMY_BUILD_REVISION?.trim();
  if (!asked) {
    const removed = removeStamp();
    return { ok: true, version, stamp: removed ? 'removed' : 'none', words: `Generated src/version.ts with version ${version}${removed ? '; removed the stamp an earlier build left (dist/build-info.json): this build says its revision is unknown' : ''}` };
  }
  const git = (args: string[]): string => execFileSync('git', ['-C', o.root, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let head: string;
  try { head = git(['rev-parse', 'HEAD']); } catch (e) {
    removeStamp();
    return { ok: false, version, stamp: 'none', words: `TIMMY_BUILD_REVISION is set, but git could not read the checkout's HEAD (${String((e as Error).message).split('\n')[0]}): no stamp written` };
  }
  if (asked !== head) {
    removeStamp();
    return { ok: false, version, stamp: 'none', words: `TIMMY_BUILD_REVISION is ${asked}, but the checkout's HEAD is ${head}: no stamp written` };
  }
  let branch: string | null = null;
  try { branch = git(['branch', '--show-current']) || null; } catch { branch = null; }
  let dirty: boolean;
  try { dirty = git(['status', '--porcelain', '--untracked-files=no']) !== ''; } catch (e) {
    removeStamp();
    return { ok: false, version, stamp: 'none', words: `git could not say whether the checkout has uncommitted changes (${String((e as Error).message).split('\n')[0]}): no stamp written` };
  }
  const stamp = { schema: STAMP_SCHEMA, version, revision: head, branch, builtAt: (o.now ?? (() => new Date()))().toISOString(), dirty };
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  return { ok: true, version, stamp: 'written', words: `Generated src/version.ts with version ${version}, and dist/build-info.json: revision ${head.slice(0, 7)}${branch ? ` (${branch})` : ''}${dirty ? ', with uncommitted changes' : ''}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = generateBuildFiles({ root });
  (r.ok ? console.log : console.error)(r.ok ? r.words : `generate-version: ${r.words}`);
  if (!r.ok) process.exit(1);
}
