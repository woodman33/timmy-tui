// Round R2: /project new <name> --from <starter> makes a project from templates/<starter>, and the web
// starter's own development server serves its files (and nothing hidden or outside its folder).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { copyStarter, listStarters, startersDir, STARTERS } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function workspace(root: string): Workspace {
  return new Workspace({
    glyphs: glyphSet(true), env: {}, onPath: () => null, notify: () => {}, openWeb: (u) => u, link: (t) => t,
    seal: () => 'id', jobsDir: join(temp('jobs-'), 'jobs'), chdir: () => {}, receipts: () => [],
  }, folderProject(root));
}

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

describe('project starters', () => {
  it('lists the starters this checkout has', () => {
    expect(startersDir()).toBeDefined();
    expect(listStarters().map((s) => s.name).sort()).toEqual(Object.keys(STARTERS).sort());
  });

  it('/project new <name> --from web-starter makes the project from the starter\'s files', async () => {
    const home = temp('home-');
    vi.stubEnv('TIMMY_HOME', home);
    const ws = workspace(temp('cwd-'));
    const out = text(ws.project_('new site --from web-starter'));
    expect(out).toContain('Made site from web-starter: 6 files, yours to edit.');
    const root = join(home, 'projects', 'site');
    for (const f of ['package.json', 'server.mjs', 'index.html', 'BUILD.md', 'src/main.js', 'src/style.css']) expect(existsSync(join(root, f))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.dev).toBe('node server.mjs');
    expect(out).toContain('Project  site');
    await ws.close();
  });

  it('names the starters when one is missing or unknown, and makes nothing', async () => {
    const home = temp('home-');
    vi.stubEnv('TIMMY_HOME', home);
    const ws = workspace(temp('cwd-'));
    expect(text(ws.project_('new x --from nope'))).toContain('No starter named nope. Starters: web-starter');
    expect(text(ws.project_('new x --from'))).toContain('Name a starter.');
    expect(existsSync(join(home, 'projects', 'x'))).toBe(false);
    await ws.close();
  });

  it('copies only regular files, and only into an empty folder', () => {
    const dir = temp('templates-');
    mkdirSync(join(dir, 'web-starter', 'src'), { recursive: true });
    writeFileSync(join(dir, 'web-starter', 'index.html'), '<h1>x</h1>');
    writeFileSync(join(dir, 'web-starter', 'src', 'a.js'), '1');
    symlinkSync('/etc/hosts', join(dir, 'web-starter', 'link'));
    const dest = temp('dest-');
    const r = copyStarter('web-starter', dest, dir);
    expect(r).toEqual({ files: ['index.html', 'src/a.js'] });
    expect(existsSync(join(dest, 'link'))).toBe(false);
    expect(copyStarter('web-starter', dest, dir)).toEqual({ error: 'the project folder is not empty; a starter only fills a new project' });
    expect('error' in copyStarter('../boards', temp('d-'), dir)).toBe(true);
  });

  it("the web starter's server serves its files on $PORT, and nothing hidden or outside its folder", async () => {
    const root = temp('web-');
    expect('files' in copyStarter('web-starter', root)).toBe(true);
    writeFileSync(join(root, '.env'), 'SECRET=1');
    const port = await freePort();
    const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('<h1>Web starter</h1>');
      expect((await fetch(`${base}/src/main.js`)).headers.get('content-type')).toContain('text/javascript');
      expect((await fetch(`${base}/.env`)).status).toBe(404);
      expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/hosts`)).status).toBe(404);
      expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(404);
      expect((await fetch(`${base}/`)).status).toBe(200);
    } finally { child.kill(); }
  });
});
