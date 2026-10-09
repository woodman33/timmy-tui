// R1 workspace direction (2026-10-08): one active project for every REPL surface, its files labelled by
// role, and reads and writes that stay inside it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseProject, classify, createProject, groupFiles, listProjectFiles, projectsHome, readActiveProject, readProjectFile, resolveInside, saveActiveProject, writeProjectFile } from '../src/project/index.js';

const dirs: string[] = [];
const temp = (prefix = 'proj-'): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer = 'x'): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('file roles', () => {
  it('labels source, references, scripts, workflows, outputs and history', () => {
    const workflow = '# Build\n\n```bash [name:build]\nnpm run build\n```\n';
    expect(classify('src/app.ts')).toBe('source');
    expect(classify('index.html')).toBe('source');
    expect(classify('scripts/deploy.sh')).toBe('script');
    expect(classify('Makefile')).toBe('script');
    expect(classify('BUILD.md', () => workflow)).toBe('workflow');
    expect(classify('README.md', () => '# Hello')).toBe('reference');
    expect(classify('refs/mood.png')).toBe('reference');
    expect(classify('models/chair.glb')).toBe('reference');
    expect(classify('dist/index.html')).toBe('output');
    expect(classify('.sessions/session-1.jsonl')).toBe('history');
    expect(classify('notes.xyz')).toBe('other');
  });
});

describe('the project listing', () => {
  it('skips dependencies, git, dotfiles and private files, and groups the rest by role', () => {
    const root = temp();
    put(root, 'src/app.js', 'console.log(1)');
    put(root, 'BUILD.md', '```bash [name:build]\necho hi\n```\n');
    put(root, 'node_modules/x/index.js'); put(root, '.git/HEAD'); put(root, '.env', 'KEY=1'); put(root, '.timmy/private/notes.txt'); put(root, 'dist/index.html');
    const { files, truncated } = listProjectFiles(root);
    expect(truncated).toBe(false);
    expect(files.map((f) => f.rel).sort()).toEqual(['BUILD.md', 'dist/index.html', 'src/app.js']);
    expect(groupFiles(files).map((g) => g.label)).toEqual(['Source', 'Workflows', 'Outputs']);
  });

  it('stops at its limit and says so', () => {
    const root = temp();
    for (let i = 0; i < 5; i++) put(root, `f${i}.ts`);
    const r = listProjectFiles(root, { max: 3 });
    expect(r.files).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });
});

describe('reads and writes stay inside the project', () => {
  it('refuses paths outside it, through links, and private files', () => {
    const root = temp(); const outside = temp('outside-');
    put(outside, 'secret.txt', 'no');
    symlinkSync(outside, join(root, 'escape'));
    expect('error' in resolveInside(root, '../x')).toBe(true);
    expect('error' in resolveInside(root, join(outside, 'secret.txt'))).toBe(true);
    expect(readProjectFile(root, 'escape/secret.txt').ok).toBe(false);
    put(root, '.env', 'K=1');
    expect(readProjectFile(root, '.env').ok).toBe(false);
    expect(writeProjectFile(root, '.timmy/private/x.txt', 'no').ok).toBe(false);
    expect(writeProjectFile(root, 'escape/new.txt', 'no').ok).toBe(false);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('reads text with its hash, cuts long files, and names binary files without their bytes', () => {
    const root = temp();
    put(root, 'a.txt', 'hello');
    put(root, 'b.bin', Buffer.from([0, 1, 2]));
    put(root, 'long.txt', 'y'.repeat(100));
    const a = readProjectFile(root, 'a.txt');
    expect(a.ok && a.text).toBe('hello');
    expect(a.ok && a.sha256).toMatch(/^[0-9a-f]{64}$/);
    const l = readProjectFile(root, 'long.txt', 10);
    expect(l.ok && l.truncated).toBe(true);
    expect(l.ok && l.text).toBe('y'.repeat(10));
    const b = readProjectFile(root, 'b.bin');
    expect(b.ok && b.binary).toBe(true);
    expect(b.ok && b.text).toBeUndefined();
  });

  it('writes a new file in a new folder, then replaces it and reports both hashes', () => {
    const root = temp();
    const w1 = writeProjectFile(root, 'src/new/page.html', '<p>one</p>');
    expect(w1.ok && w1.created).toBe(true);
    const w2 = writeProjectFile(root, 'src/new/page.html', '<p>two</p>');
    expect(w2.ok && w2.created).toBe(false);
    expect(w2.ok && w2.previousSha256).toBe(w1.ok ? w1.sha256 : 'x');
    expect(readFileSync(join(root, 'src/new/page.html'), 'utf8')).toBe('<p>two</p>');
  });
});

// Independent source review at c7475458 (2026-10-08), findings 1 and 2.
describe('review: a link cannot reach a private file, and a write cannot be redirected', () => {
  it('refuses a public-looking name whose link leads to .env or into .timmy/private', () => {
    const root = temp();
    put(root, '.env', 'OPENROUTER_API_KEY=sk-or-v1-not-a-real-key');
    put(root, '.timmy/private/notes.txt', 'private');
    put(root, 'src/a.txt', 'shared');
    symlinkSync('.env', join(root, 'public.txt'));
    symlinkSync('.timmy/private', join(root, 'open'));
    symlinkSync('src/a.txt', join(root, 'alias.txt'));
    const leak = readProjectFile(root, 'public.txt');
    expect(leak.ok).toBe(false);
    expect(!leak.ok && leak.error).toMatch(/private/);
    expect(readProjectFile(root, 'open/notes.txt').ok).toBe(false);
    expect(writeProjectFile(root, 'public.txt', 'overwrite').ok).toBe(false);
    expect(writeProjectFile(root, 'open/new.txt', 'no').ok).toBe(false);
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('not-a-real-key');
    expect(existsSync(join(root, '.timmy/private/new.txt'))).toBe(false);
    // A link to an ordinary project file still works, and a write through it edits that file.
    const alias = readProjectFile(root, 'alias.txt');
    expect(alias.ok && alias.text).toBe('shared');
    expect(writeProjectFile(root, 'alias.txt', 'edited').ok).toBe(true);
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('edited');
  });

  it('never writes through a link planted at the temporary name, and leaves no temporary file', () => {
    const root = temp(); const outside = temp('outside-');
    put(outside, 'victim.txt', 'untouched');
    put(root, 'index.html', '<p>old</p>');
    // The name the first version used, predictable from the process id.
    symlinkSync(join(outside, 'victim.txt'), join(root, `index.html.timmy-${process.pid}.tmp`));
    // And a planted link at whatever name a write tries first: the write must create its file exclusively.
    const planted = join(root, '.index.html.timmy-planted.tmp');
    symlinkSync(join(outside, 'victim.txt'), planted);
    const names = ['.index.html.timmy-planted.tmp', '.index.html.timmy-second.tmp'];
    const w = writeProjectFile(root, 'index.html', '<p>new</p>', { tempName: () => names.shift() ?? '.index.html.timmy-third.tmp' });
    expect(w.ok).toBe(true);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('untouched');
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<p>new</p>');
    expect(existsSync(join(root, '.index.html.timmy-second.tmp'))).toBe(false);
    const w2 = writeProjectFile(root, 'index.html', '<p>newer</p>');
    expect(w2.ok).toBe(true);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('untouched');
  });
});

describe('the active project', () => {
  it('is chosen by name or path, made under the Timmy home, and remembered outside the project', () => {
    const home = temp('home-');
    vi.stubEnv('TIMMY_HOME', home);
    expect('error' in createProject('demo-site')).toBe(false);
    expect(existsSync(join(projectsHome(), 'demo-site'))).toBe(true);
    expect('error' in createProject('demo-site')).toBe(true);
    const byName = chooseProject('demo-site');
    expect('root' in byName && byName.root).toBe(join(home, 'projects', 'demo-site'));
    const other = temp('folder-');
    const byPath = chooseProject(other);
    expect('root' in byPath && byPath.name).toBe(basename(other));
    expect('error' in chooseProject('no-such-project', home)).toBe(true);
    expect(readActiveProject(other).chosen).toBe(false);
    if ('root' in byName) saveActiveProject(byName);
    expect(readActiveProject(other).root).toBe(join(home, 'projects', 'demo-site'));
    expect(existsSync(join(home, 'projects', 'demo-site', '.timmy'))).toBe(false);
  });
});
