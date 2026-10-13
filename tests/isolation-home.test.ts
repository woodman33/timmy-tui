// R4 (H97; found by H93): every test file gets a Timmy home of its own (tests/isolation-setup.ts), and the account's own is
// watched while it runs (tests/helpers/path-watch.ts); a file that used it fails after its tests. Before, a test that built
// the overview through a REPL naming no Timmy home read the account's own ~/timmy/connect, ~/timmy/jobs and ~/timmy/cloud.
//
// Real files, a real Workspace and its real /overview --json; the device below is a record only (no computer is reached,
// its key file is a placeholder that is never read: its mode is checked, as Timmy Connect does).
import { randomBytes } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveDeps } from '../src/capabilities/live.js';
import { addDevice } from '../src/connect/devices.js';
import { connectPaths } from '../src/connect/store.js';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { watchPaths } from './helpers/path-watch.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const re = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('a Timmy home of its own for every test file (R4 H97)', () => {
  it('TIMMY_HOME is a temporary folder of this file\'s, never the account\'s own ~/timmy', () => {
    const home = process.env.TIMMY_HOME;
    expect(home).toBeTruthy();
    expect(path.resolve(home!).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)).toBe(true);
    expect(path.basename(home!)).toMatch(/^timmy-home-/);
    expect(path.resolve(home!)).not.toBe(path.join(os.homedir(), 'timmy'));
    expect(fs.statSync(home!).isDirectory()).toBe(true);
  });

  let first = '';
  it('a test that removes TIMMY_HOME (as some clean up after themselves) ...', () => {
    first = process.env.TIMMY_HOME!;
    delete process.env.TIMMY_HOME;
    expect(process.env.TIMMY_HOME).toBeUndefined();
  });
  it('... leaves the next test the file\'s own again, the same folder', () => {
    expect(process.env.TIMMY_HOME).toBe(first);
  });

  it('the overview built through a REPL that names no Timmy home reads this file\'s: the device recorded there, and nothing of the account\'s', async () => {
    // a device recorded in this file's Timmy home (its key file a placeholder: only its mode is looked at)
    const keys = temp('h97-iso-keys-');
    const key = path.join(keys, 'id_placeholder');
    fs.writeFileSync(key, 'placeholder: never read\n', { mode: 0o600 });
    expect(addDevice(connectPaths(process.env.TIMMY_HOME!), { id: 'h97-isolated', address: '127.0.0.1', user: 'tester', identity: key }).problems).toEqual([]);
    // a REPL whose environment names no Timmy home (as tests/helpers/memory-kit.ts's does)
    const root = temp('h97-iso-project-');
    const ws = new Workspace({
      glyphs: glyphSet(true), env: {}, onPath: () => null, notify: () => {}, openWeb: (url) => url, link: (t) => t,
      seal: () => undefined, jobsDir: path.join(temp('h97-iso-jobs-'), 'jobs'), chdir: () => {}, receipts: () => [], recoverAtStart: false,
      roomTools: async () => [], // no probe of this computer's tools: only the records are read here
    }, folderProject(root));
    try {
      const o = JSON.parse(text(await ws.overview('--json'))) as { devices: { items: Array<{ id: string }> }; project: { canvas: { state: string } } };
      expect(o.devices.items.map((d) => d.id)).toEqual(['h97-isolated']);
      expect(o.project.canvas.state).toBe('off');
    } finally { await ws.close(); }
  });
});

describe('code that is given an environment naming no Timmy home reads this process\'s, never ~/timmy behind it (R4 H97)', () => {
  it('/tools\' model key: the providers file of the environment\'s Timmy home, else this process\'s (src/capabilities/live.ts)', () => {
    // found by the watch: a REPL whose environment named no Timmy home (env {}) looked for ~/timmy/providers.json
    const cwd = process.cwd();
    const home = temp('h97-key-home-');
    const own = path.join(process.env.TIMMY_HOME!, 'providers.json');
    fs.writeFileSync(own, `${JSON.stringify({ openrouter_api_key: randomBytes(16).toString('hex') })}\n`, { mode: 0o600 });
    process.chdir(temp('h97-key-work-')); // no .env or timmy-tui.config.json of a checkout's in the way
    try {
      const env = { PATH: '', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
      expect(liveDeps({ env, model: 'FAKE' }).modelKeySource()).toBe('providers.json');
      expect(liveDeps({ env: { ...env, TIMMY_HOME: temp('h97-key-empty-') }, model: 'FAKE' }).modelKeySource()).toBe(null);
    } finally { process.chdir(cwd); fs.rmSync(own, { force: true }); }
  });
});

describe('the watch on the account\'s Timmy home (tests/helpers/path-watch.ts), shown on a folder of this test\'s own', () => {
  it('records each use of a path under the folder, by a default or a named import, with where it came from; nothing else', async () => {
    const watched = temp('h97-watched-');
    const outside = temp('h97-outside-');
    fs.writeFileSync(path.join(watched, 'a.json'), '{}');
    fs.writeFileSync(path.join(outside, 'b.json'), '{}');
    const w = watchPaths([watched]);
    try {
      fs.existsSync(path.join(watched, 'a.json'));
      readFileSync(path.join(watched, 'a.json'), 'utf8'); // the named import: its ES module binding is the watch's too
      await fs.promises.readdir(watched);
      fs.readFileSync(path.join(outside, 'b.json'));
      fs.renameSync(path.join(outside, 'b.json'), path.join(watched, 'b.json')); // a second path argument is checked too
    } finally { w.stop(); }
    fs.readFileSync(path.join(watched, 'a.json')); // after stop: not watched
    const from = `\\(from .*${re(path.basename(__filename))}:\\d+:\\d+\\)+$`;
    expect(w.seen).toEqual([
      expect.stringMatching(new RegExp(`^existsSync ${re(path.join(watched, 'a.json'))} ${from}`)),
      expect.stringMatching(new RegExp(`^readFileSync ${re(path.join(watched, 'a.json'))} ${from}`)),
      expect.stringMatching(new RegExp(`^promises\\.readdir ${re(watched)} ${from}`)),
      expect.stringMatching(new RegExp(`^renameSync ${re(path.join(watched, 'b.json'))} ${from}`)),
    ]);
  });

  it('a use from an exempt file (a guard that lists the folder on purpose) is not counted; stop puts the functions back', () => {
    const watched = temp('h97-watched-');
    const before = { read: fs.readFileSync, list: fs.readdirSync, stat: fs.promises.stat };
    const w = watchPaths([watched], { exempt: [path.basename(__filename)] });
    expect(fs.readFileSync).not.toBe(before.read);
    fs.readdirSync(watched);
    w.stop();
    expect(w.seen).toEqual([]);
    expect({ read: fs.readFileSync, list: fs.readdirSync, stat: fs.promises.stat }).toEqual(before);
  });
});
