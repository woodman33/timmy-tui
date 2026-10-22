// R9 (H160; R8's open item G′): `timmy workbench` in a real terminal (tmux, a server of this test's own) on a project with the
// demo tray in its three kinds and a recording. Tab 6 opens with its first mesh an item, whole in view, the cursor's mark on it,
// at 100x30 and at 60x16 (the smallest size the Workbench draws); the page's key line under the meshes' heading says what
// Enter and c do to it, and they do that: Enter shows its measurements in Context (the drawer; the keys scroll it past the
// Unfinished words Context shows first where the page's box is shortened), and c opens the companion on tab 6 with that mesh
// chosen (the address the private launch page carries names it: mesh=<its path as hex>).
//
// Over a sandbox of its own (HOME, the XDG folders, the Timmy home, the settings folder, the store, TMPDIR and the tmux
// server, all inside this test's temporary folder), made as tests/workbench-control-grid-pty.test.ts makes it. FAKE here, each
// said so: the browser openers on PATH (`open` and `xdg-open` stubs that only log what they were given: no browser opens).
// Real: the program as the installed command starts it (src/cli.ts through tsx's loader), Timmy's mesh readers, the companion
// server it starts on 127.0.0.1 when c is pressed. The screens are kept (capture-pane -e as .ansi and plain as .txt) in
// <tmpdir>/timmy-workbench-captures/r9-h160-tab6, or in H160_PTY_CAPS when it is set.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { keepScreen, sendKeys, settledScreen, waitScreen, type Pane } from './helpers/tmux-frame.js';
import { DEMO_MESH, DEMO_OBJ, DEMO_PLY } from '../scripts/demo-mesh.mjs';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const RRD = resolve('studio/ctx-c3w8/checkpoints/C5/exports/context.rrd');
const CAPTURES = process.env.H160_PTY_CAPS ? resolve(process.env.H160_PTY_CAPS) : join(tmpdir(), 'timmy-workbench-captures', 'r9-h160-tab6');
const SOCKET = 'h160-tab6';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

let box = '';
let repo = '';
let timmyHome = '';
let env: NodeJS.ProcessEnv = {};

const cli = (args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout });

function terminal(label: string) {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const pane: Pane = { tmux, target: 't', folders: [box] };
  const screen = () => settledScreen(pane);
  const waitFor = async <T>(what: string, get: (s: string) => T | null | undefined | false, ms = 30_000): Promise<T> => {
    const s = await waitScreen(pane, { what, test: (x) => !!get(x), ms });
    return get(s) as T;
  };
  const keys = (...k: string[]) => sendKeys(pane, k);
  const capture = (name: string, shows?: RegExp): string => keepScreen(pane, CAPTURES, name, { what: `the ${name} screen, whole, with its key-hint line`, re: shows });
  return { tmux, screen, waitFor, keys, capture };
}

/** The page box's rows (tab 6's body), between its side borders: the rows of the region whose title names 3D & Motion. */
function pageRows(screen: string): string[] {
  const lines = screen.split('\n');
  const top = lines.findIndex((l) => /^[┏╭]/.test(l) && / \/ 3D & Motion/.test(l));
  const bottom = lines.findIndex((l, i) => i > top && /^[┗╰]/.test(l));
  if (top < 0 || bottom < 0) return [];
  return lines.slice(top + 1, bottom).map((l) => { const side = l[0]; const end = l.indexOf(side, 1); return (side === '┃' || side === '│') && end > 0 ? l.slice(1, end) : ''; });
}

/** The Context drawer's rows, between its side borders (its title names it). */
function drawerRows(screen: string): string[] {
  const lines = screen.split('\n');
  const top = lines.findIndex((l) => /Context \(drawer\)/.test(l));
  if (top < 0) return [];
  // the drawer's own corner: the last one before its title (the page box beside it has its own, further left)
  const head = [...lines[top]];
  const title = head.join('').indexOf('Context (drawer)');
  const x0 = Math.max(...['╭', '┏'].map((ch) => head.slice(0, [...lines[top].slice(0, title)].length).lastIndexOf(ch)));
  const out: string[] = [];
  for (let i = top + 1; i < lines.length; i++) {
    const row = [...lines[i]];
    if (row[x0] === '╰' || row[x0] === '┗') break;
    // its right border is the row's last (Context's tab row has │ between its tabs)
    let end = row.length - 1;
    while (end > x0 && row[end] !== '│' && row[end] !== '┃') end -= 1;
    out.push(row.slice(x0 + 1, end > x0 ? end : undefined).join(''));
  }
  return out;
}

/** The first mesh as tab 6 lists it, with the cursor on it: its rows from its marked one (its words go on under it). */
function firstMeshRows(screen: string): string[] | null {
  const page = pageRows(screen);
  const at = page.findIndex((l) => /^\s*▸ refs\/demo-tray\.obj {2}OBJ · 28 triangles/.test(l));
  if (at < 0) return null;
  const rows = [page[at]];
  for (let i = at + 1; i < page.length && /^ {5}\S/.test(page[i]); i++) rows.push(page[i]);
  return rows;
}

/** The launch pages the FAKE openers were given, in order. */
const openedPages = (): string[] => (existsSync(join(box, 'opened.log')) ? readFileSync(join(box, 'opened.log'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(1).join(' ')) : []);

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-tab6-pty-'));
  const home = join(box, 'home');
  repo = join(box, 'repo');
  timmyHome = join(home, 'timmy');
  const bin = join(box, 'fakebin');
  for (const d of [home, repo, bin, join(box, 'tmp'), join(box, 'settings'), CAPTURES]) mkdirSync(d, { recursive: true });
  // FAKE openers: they log the page they are given; no browser opens
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${box}/opened.log'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const base = withoutRunner(process.env);
  delete base.NODE_PATH;
  env = {
    ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: timmyHome, TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(home, '.timmy-store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo']);
  expect(init.status, init.stderr).toBe(0);
  const made = await cli(['act', '/project new tray1 --from tray-workflow']);
  expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
  const root = join(timmyHome, 'projects', 'tray1');
  mkdirSync(join(root, 'refs'), { recursive: true });
  mkdirSync(join(root, 'rec'), { recursive: true });
  for (const f of [DEMO_MESH, DEMO_OBJ, DEMO_PLY]) copyFileSync(resolve(f), join(root, 'refs', f.split('/').pop()!));
  copyFileSync(RRD, join(root, 'rec', 'context.rrd'));
}, 150_000);

afterAll(async () => {
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ }
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
}, 30_000);

describe('`timmy workbench` in a terminal: tab 6 opens on its first mesh, whole in view, at 100x30 and 60x16; Enter and c do what its key line says (tmux; R9 H160)', () => {
  it('at 100x30, then 60x16: the first mesh whole in view as tab 6 opens; Enter shows its measurements in Context; c opens the companion on tab 6 with it chosen', async () => {
    const t = terminal(SOCKET);
    t.tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '30', '-c', repo, 'bash', '--norc', '-c',
      `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
    await t.waitFor('the Workbench, at the start', (s) => /tray1 \/ Home · recent work[\s\S]*Activity & log/.test(s), 90_000);
    const seen: Record<string, string[]> = {};
    for (const [cols, rows] of [[100, 30], [60, 16]] as const) {
      const size = `${cols}x${rows}`;
      if (cols !== 100) {
        t.tmux('resize-window', '-t', 't', '-x', String(cols), '-y', String(rows));
        await t.waitFor(`the Workbench redrawn at ${size}`, (s) => s.split('\n')[0].length <= cols && s.replace(/\n$/, '').split('\n').length === rows);
      }
      // tab 6 afresh (from Home), its meshes measured: the first mesh whole in view, the cursor's mark on it
      await t.keys('1');
      await t.waitFor(`Home at ${size}`, (s) => /\/ Home · recent work/.test(s));
      await t.keys('6');
      const mesh = await t.waitFor(`tab 6 at ${size}, its first mesh in view with the cursor on it`, (s) => firstMeshRows(s), 30_000);
      seen[size] = mesh;
      const opened = t.capture(`h160-tab6-${size}-opens`, /▸ refs\/demo-tray\.obj {2}OBJ · 28 triangles/);
      const page = pageRows(opened);
      expect(page[0], `${size}: the page's first row`).toMatch(/◌ Unfinished/);
      // whole: its words end in view (box and volume, then nothing cut), and the row after it is not more of it
      const words = mesh.map((r) => r.trim()).join(' ');
      expect(words, size).toMatch(/OBJ · 28 triangles · box 80 × 50 × 20 · .*volume 21392 \(enclosed; normals outward\)/);
      for (const r of mesh) expect(r.trimEnd().endsWith('…'), `${size}: a row of it is cut: ${r}`).toBe(false);
      // the key line says what Enter and c do (under the heading, at the window's top where it is short)
      const keyLine = page.join(' ').replace(/\s+/g, ' ');
      expect(keyLine, `${size}: the key line`).toContain("[Enter] its measurements in Context · [c] it chosen in the companion's view you can turn");

      // Enter, with the keyboard in the body: Context opens on the Inspector; ↓ scrolls it to the measurements
      for (let k = 0; k < 6 && !/┏━ ◆ tray1 \/ 3D & Motion/.test(t.screen()); k++) await t.keys('Tab');
      await t.waitFor(`the body with the keyboard at ${size}`, (s) => /┏━ ◆ tray1 \/ 3D & Motion/.test(s));
      await t.keys('Enter');
      await t.waitFor(`Context's drawer on the Inspector at ${size}`, (s) => drawerRows(s).some((r) => /▸ Inspector|▸Inspector/.test(r)));
      for (let k = 0; k < 6 && !/┏━ ◆ Context \(drawer\)/.test(t.screen()); k++) await t.keys('Tab');
      await t.waitFor(`Context with the keyboard at ${size}`, (s) => /┏━ ◆ Context \(drawer\)/.test(s));
      let ctx = '';
      for (let k = 0; k < 40 && !/Triangles\s+28/.test(ctx); k++) {
        await t.keys('Down');
        ctx = drawerRows(t.screen()).join(' ').replace(/\s+/g, ' ');
      }
      expect(ctx, `${size}: the measurements in Context`).toMatch(/Triangles 28/);
      t.capture(`h160-tab6-${size}-enter-context`, /Triangles\s+28/);
      await t.keys('Escape');
      await t.waitFor(`the drawer closed at ${size}`, (s) => !/Context \(drawer\)/.test(s) && /◆ tray1 \/ 3D & Motion/.test(s));

      // c: the companion on tab 6 with this mesh chosen (the launch page the FAKE opener was given carries the address)
      const before = openedPages().length;
      await t.keys('c');
      // (R10 H167; H168's F3: said in words, the mesh by its file's name; the address is the details', [i])
      await t.waitFor(`the Companion opened at ${size}`, (s) => /Opened in the companion: demo-tray\.obj/.test(s), 60_000);
      for (const end = Date.now() + 10_000; openedPages().length <= before && Date.now() < end;) await sleep(100);
      const pages = openedPages();
      expect(pages.length, `${size}: one more page given to the FAKE opener`).toBe(before + 1);
      const launch = readFileSync(fileURLToPath(pages[pages.length - 1]), 'utf8');
      expect(launch, `${size}: the address names tab 6 and the mesh`).toMatch(new RegExp(`\\?tab=create(?:&|\\\\u0026)mesh=${hex('refs/demo-tray.obj')}#`));
      t.capture(`h160-tab6-${size}-c-companion`);
    }
    expect(Object.keys(seen)).toEqual(['100x30', '60x16']);
    const txt = t.screen();
    expect(txt.includes(box), 'a folder of this machine').toBe(false);
    expect(txt.includes(hostname()), 'this machine\'s name').toBe(false);
    await t.keys('C-c');
    await t.waitFor('the Workbench quitting at Ctrl+C', (s) => /EXIT=\d+/.test(s), 20_000);
    console.log(`tab 6 captures (R9 H160, .ansi and .txt): ${CAPTURES}`);
  }, 240_000);
});
