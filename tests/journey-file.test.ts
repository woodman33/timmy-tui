// R10 (H164): a project file as the companion's preview draws it (journey step 3, "open a project artifact in the companion
// preview": openTarget sends a reference or a result no run's detail holds to ?tab=home&file=<hex>, and no route served it):
//   GET /api/journey/file?project=<id>&path=<its path in the project>   projectFile (src/journey/file.ts)
// An image (png, jpg/jpeg, webp, gif; up to 4 MB) as a data URL with its width and height from its own header, or a text
// file's first lines (its first 64 KB); every other file, and any path that is not plainly a file in the project's own folder
// (a "..", an absolute path, a link on the way, a dot-folder, a key file), refused in words. Behind the companion's token, and
// no answer carries a path of this computer: only the path in the project.
//
// REAL here: the companion server on 127.0.0.1:4481 (this owner's port), its token check and project rule, the file system's
// links and a named pipe. FAKE here: the project (FAKE-shots) and its files, written by the test (a real PNG made with zlib;
// JPEG, GIF and WebP headers written byte by byte).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { FILE_IMAGE_MAX, FILE_TEXT_MAX, imageHeader, projectFile } from '../src/journey/file.js';
import { projectId } from '../src/project/index.js';
import { png } from './helpers/vox-fakes.js';

const PORT = 4481;
const TOKEN = 'c5'.repeat(32);
const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
let box = '';
let root = '';
let pid = '';
let companion: CompanionServer;
let fifo = false;
const answers: unknown[] = [];

const u16le = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const jpeg = (w: number, h: number): Buffer => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), // APP0 (JFIF)
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]), // SOF0
  Buffer.from([0xff, 0xd9]),
]);
const gif = (w: number, h: number): Buffer => Buffer.concat([Buffer.from('GIF89a', 'latin1'), u16le(w), u16le(h), Buffer.from([0, 0, 0, 0x3b])]);
const riff = (chunk: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(chunk, 'latin1'), u32le(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(4 + body.length), Buffer.from('WEBP', 'latin1'), body]);
};
const u24le = (n: number): Buffer => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
const webpX = (w: number, h: number): Buffer => riff('VP8X', Buffer.concat([Buffer.from([0, 0, 0, 0]), u24le(w - 1), u24le(h - 1)]));
const webpL = (w: number, h: number): Buffer => riff('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le((w - 1) | ((h - 1) << 14))]));
const webpLossy = (w: number, h: number): Buffer => riff('VP8 ', Buffer.concat([Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]), u16le(w), u16le(h)]));
const shot = png(37, 21, (x, y) => [x * 6, y * 12, 128]);

const put = (rel: string, body: string | Buffer, at = root): void => { mkdirSync(dirname(join(at, rel)), { recursive: true }); writeFileSync(join(at, rel), body); };
const get = (path: string, token: string | null = TOKEN): Promise<Response> => fetch(`http://127.0.0.1:${companion.port}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
/** The route's answer for `path` in the project, its status checked, kept for the check that no answer names this computer. */
const ask = async (path: string | null, status = 200): Promise<any> => {
  const r = await get(`/api/journey/file?project=${pid}${path === null ? '' : `&path=${encodeURIComponent(path)}`}`);
  expect(r.status, String(path)).toBe(status);
  expect(r.headers.get('cache-control'), String(path)).toBe('no-store');
  const body = await r.json();
  answers.push(body);
  return body;
};

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'journey-file-'));
  process.env.TIMMY_HOME = join(box, 'home');
  delete process.env.TIMMY_REPO;
  root = join(box, 'home', 'projects', 'FAKE-shots');
  mkdirSync(join(root, '.timmy'), { recursive: true });
  pid = projectId(root);
  put('refs/shot.png', shot);
  put('refs/photo.jpg', jpeg(64, 48));
  put('refs/anim.gif', gif(5, 7));
  put('refs/pic.webp', webpX(300, 200));
  put('refs/lossless.webp', webpL(17, 9));
  put('refs/lossy.webp', webpLossy(320, 240));
  put('notes/plan.md', '# Plan\n\n- one\n- two\n');
  put('data/rows.csv', 'a,b\n1,2\n');
  put('logs/long.txt', Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'x'.repeat(24)}\n`).join(''));
  put('notes/home.md', `see ${homedir()}/notes\n`);
  put('refs/fake.png', 'not an image at all\n');
  put('notes/binary.txt', Buffer.from([0x61, 0x00, 0x62, 0x0a]));
  put('notes/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  put('refs/big.png', Buffer.concat([shot.subarray(0, 24), Buffer.alloc(FILE_IMAGE_MAX + 1 - 24)]));
  put('refs/cube.stl', 'solid cube\nendsolid cube\n');
  put('refs/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  put('.timmy/state.json', '{}');
  put('.git/config', '[core]\n');
  put('notes/.hidden/x.md', 'hidden\n');
  put('.env', 'OPENROUTER_API_KEY=sk-or-FAKE\n');
  put('secrets.json', '{"key":"FAKE"}');
  // outside the project's folder, and links to it: a file, a folder on the way; and a link that stays inside
  put('secret.png', shot, join(box, 'outside'));
  put('notes.md', 'outside\n', join(box, 'outside'));
  symlinkSync(join(box, 'outside', 'secret.png'), join(root, 'refs', 'out.png'));
  symlinkSync(join(box, 'outside'), join(root, 'linked'));
  symlinkSync(join(root, 'refs', 'shot.png'), join(root, 'refs', 'same.png'));
  symlinkSync(root, join(box, 'root-link'));
  try { execFileSync('mkfifo', [join(root, 'notes', 'pipe.txt')]); fifo = true; } catch { fifo = false; }
  companion = await startCompanionServer(PORT, { token: TOKEN, workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, PATH: process.env.PATH }, shareMs: 0 } });
}, 60_000);
afterAll(async () => {
  await companion?.shutdown();
  for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (box) rmSync(box, { recursive: true, force: true });
});

describe('a project file as the companion\'s preview draws it: GET /api/journey/file (R10 H164)', () => {
  it('needs the companion\'s token: refused (401) before anything is read, a pipe included', async () => {
    for (const path of ['refs/shot.png', 'notes/pipe.txt', '../outside/secret.png']) {
      const q = `/api/journey/file?project=${pid}&path=${encodeURIComponent(path)}`;
      const r = await get(q, null);
      expect(r.status, path).toBe(401);
      expect(await r.json()).toEqual({ ok: false, error: expect.stringMatching(/^Refused: this needs the browser companion's token/) });
      expect((await get(q, 'e5'.repeat(32))).status, path).toBe(401);
    }
    expect((await get(`/api/journey/file?project=${pid}&path=refs%2Fshot.png&t=${TOKEN}`)).status).toBe(401);
  });

  it('an image: its bytes as a data URL, its width and height from its own header (a real PNG; a JPEG, a GIF and WebP too)', async () => {
    const r = await ask('refs/shot.png');
    expect(r).toEqual({ ok: true, path: 'refs/shot.png', kind: 'image', mime: 'image/png', size: shot.length, width: 37, height: 21, data: expect.stringMatching(/^data:image\/png;base64,/), words: expect.any(String) });
    expect(Buffer.from(r.data.slice('data:image/png;base64,'.length), 'base64').equals(shot)).toBe(true);
    expect(r.words).toMatch(/^refs\/shot\.png: a PNG image, 37 × 21 pixels, /);
    for (const [path, mime, width, height] of [
      ['refs/photo.jpg', 'image/jpeg', 64, 48], ['refs/anim.gif', 'image/gif', 5, 7], ['refs/pic.webp', 'image/webp', 300, 200],
      ['refs/lossless.webp', 'image/webp', 17, 9], ['refs/lossy.webp', 'image/webp', 320, 240],
    ] as const) expect(await ask(path), path).toMatchObject({ ok: true, path, kind: 'image', mime, width, height, data: expect.stringMatching(new RegExp(`^data:${mime.replace('/', '\\/')};base64,`)) });
    // the header reader alone: what is not one of the four is not an image
    expect(imageHeader(shot)).toEqual({ type: 'png', mime: 'image/png', width: 37, height: 21 });
    expect(imageHeader(Buffer.from('not an image at all\n'))).toBeNull();
    expect(imageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });

  it('a text file: whole when short; its first 64 KB, cut at a line, when long; the home folder written as ~', async () => {
    expect(await ask('notes/plan.md')).toEqual({ ok: true, path: 'notes/plan.md', kind: 'text', mime: 'text/markdown', size: 20, data: '# Plan\n\n- one\n- two\n', truncated: false, words: 'notes/plan.md: text, 20 B, shown whole, in FAKE-shots.' });
    expect(await ask('data/rows.csv')).toMatchObject({ ok: true, kind: 'text', mime: 'text/csv', data: 'a,b\n1,2\n', truncated: false });
    const whole = Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'x'.repeat(24)}\n`).join('');
    const long = await ask('logs/long.txt');
    expect(long).toMatchObject({ ok: true, kind: 'text', mime: 'text/plain', size: whole.length, truncated: true });
    expect(Buffer.byteLength(long.data)).toBeLessThanOrEqual(FILE_TEXT_MAX);
    expect(long.data.endsWith('\n')).toBe(true);
    expect(whole.startsWith(long.data)).toBe(true);
    expect(long.data.length).toBeGreaterThan(FILE_TEXT_MAX - 64);
    expect(long.words).toMatch(/its first 64 KB shown/);
    const home = await ask('notes/home.md');
    expect(home.data).toContain('see ~/notes');
    expect(home.data).not.toContain(homedir());
  });

  it('refuses in words a path that is not plainly in the project: "..", absolute, a link out, a link on the way, any link, a dot-folder, a key file', async () => {
    // not a path in the project at all: 400, and the path asked is not repeated
    for (const path of ['../outside/secret.png', 'refs/../../outside/notes.md', '/etc/hosts', `${root}/refs/shot.png`, 'C:\\shots\\x.png', 'refs/\u0000x.png', './refs/shot.png', 'refs/./shot.png']) {
      const r = await ask(path, 400);
      expect(r, path).toEqual({ ok: false, path: null, refusal: 'path', why: expect.stringMatching(/is not a path in the project/) });
    }
    expect(await ask(null, 400)).toEqual({ ok: false, path: null, refusal: 'path', why: 'Name the file to preview as ?path=<its path in the project>.' });
    // a link: out of the project, a linked folder on the way, or a link that stays inside (none is followed)
    for (const path of ['refs/out.png', 'linked/secret.png', 'linked/notes.md', 'refs/same.png']) {
      expect(await ask(path), path).toEqual({ ok: false, path, refusal: 'link', why: `${path} is reached through a link: the preview reads only a file in the project's own folder, with no link on the way.` });
    }
    // a dot-folder (.timmy, .git, any), a dotfile, a key file: refused before anything is read
    for (const path of ['.timmy/state.json', '.git/config', 'notes/.hidden/x.md', '.env', 'secrets.json', 'refs/.shot.png']) {
      expect(await ask(path), path).toEqual({ ok: false, path, refusal: 'private', why: expect.stringMatching(/the preview never reads one/) });
    }
  });

  it('refuses in words a type it does not draw, a folder, a pipe, an image over 4 MB, a .png that is not one, a text that is not UTF-8, a file that is not there', async () => {
    expect(await ask('refs/cube.stl')).toEqual({ ok: false, path: 'refs/cube.stl', refusal: 'type', why: expect.stringMatching(/^refs\/cube\.stl is a \.stl file: the preview draws png, jpg, jpeg, webp and gif images, and text files \(/) });
    expect(await ask('refs/icon.svg')).toMatchObject({ ok: false, refusal: 'type' });
    expect(await ask('refs')).toEqual({ ok: false, path: 'refs', refusal: 'not-file', why: 'refs is a folder, not a file, so nothing is previewed.' });
    if (fifo) {
      const t0 = Date.now();
      expect(await ask('notes/pipe.txt')).toMatchObject({ ok: false, refusal: 'not-file' });
      expect(Date.now() - t0).toBeLessThan(5_000);
    }
    expect(await ask('refs/big.png')).toEqual({ ok: false, path: 'refs/big.png', refusal: 'too-big', why: 'refs/big.png is 4.0 MB: the preview draws an image up to 4 MB.' });
    expect(await ask('refs/fake.png')).toMatchObject({ ok: false, refusal: 'not-image', why: expect.stringMatching(/does not read as a PNG, JPEG, GIF or WebP image/) });
    for (const path of ['notes/binary.txt', 'notes/latin1.txt']) expect(await ask(path), path).toMatchObject({ ok: false, path, refusal: 'not-text' });
    expect(await ask('refs/none.png')).toEqual({ ok: false, path: 'refs/none.png', refusal: 'missing', why: 'refs/none.png is not a file of this project, so nothing is previewed.' });
  });

  it('never names a path of this computer; a project the companion does not know is 404; a project reached through a link reads its real folder', async () => {
    expect(answers.length).toBeGreaterThan(20);
    // every answer's words and fields (an image's data is its own bytes, written as base64, not words)
    const all = JSON.stringify(answers.map((a) => (a as { kind?: string }).kind === 'image' ? { ...(a as object), data: '' } : a));
    for (const p of [box, root, realpathSync(box), tmpdir(), homedir()]) expect(all).not.toContain(p);
    expect((await get('/api/journey/file?project=0000000000000000&path=refs%2Fshot.png')).status).toBe(404);
    // the function itself, for a project whose folder is named through a link (macOS's /var is /private/var)
    expect(projectFile({ name: 'FAKE-shots', root: join(box, 'root-link') }, 'refs/shot.png')).toMatchObject({ ok: true, width: 37, height: 21 });
    expect(projectFile({ name: 'FAKE-shots', root: join(box, 'root-link') }, 'refs/out.png')).toMatchObject({ ok: false, refusal: 'link' });
  });
});
