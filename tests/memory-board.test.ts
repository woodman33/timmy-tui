/**
 * Timmy Memory on the board (round R4, helper H50): the Memory section of the snapshot (/board) and of the live board
 * (/board live), on real files in a temporary project with a REAL receipts chain (tests/helpers/memory-kit.ts). Hostile
 * lesson text is escaped; a stale lesson says what changed; the live board's Check runs the typed /lesson check <id>
 * through the action path, under its token, Host and Origin rules. Every request goes to 127.0.0.1 on the board's own
 * ephemeral port. No model or agent runs here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLessonAction } from '../src/memory/board.js';
import { checkAction, type LiveState } from '../src/repl/board-live.js';
import type { Lesson } from '../src/memory/lessons.js';
import { chainOf, memoryKit, put, read, text, workspace, writeFlow } from './helpers/memory-kit.js';

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); });

const HOSTILE = '<script>alert(1)</script> & "quoted" \'single\' <img src=x onerror=alert(2)>';
const idIn = (out: string): string => /Lesson\s+(l[0-9a-f]{8})/.exec(out)![1];

function project() {
  const root = kit.temp('memory-board-');
  put(root, 'evidence/one.txt', 'the run where it held\n');
  const { ws, notes } = workspace(root, kit);
  const hostile = idIn(text(ws.lesson(`add "${HOSTILE.replace(/"/g, "'")}" --from evidence/one.txt --applies tray`)));
  const plain = idIn(text(ws.lesson('add "Keep the lid gap at 0.4 mm." --from evidence/one.txt --applies scad')));
  const retired = idIn(text(ws.lesson('add "An old one." --from evidence/one.txt --applies scad')));
  text(ws.lesson(`check ${plain}`));
  text(ws.lesson(`retire ${retired}`));
  writeFlow(root, { kind: 'scad', instruction: 'wider', lessons: [plain] });
  return { root, ws, notes, hostile, plain, retired };
}

describe('the Memory section of the snapshot', () => {
  it('lessons with their status, text (escaped), evidence links and receipts, and the runs that used each; a stale one says what changed', () => {
    const { root, ws, hostile, plain, retired } = project();
    writeFileSync(join(root, 'evidence/one.txt'), 'it changed since\n'); // every lesson's evidence changed now
    text(ws.board(''));
    const html = read(root, '.timmy/board/index.html');
    const memory = html.slice(html.indexOf('<h2 id="memory">'));
    expect(html).toContain('<a href="#memory">Memory <b>3</b></a>');
    expect(memory).toContain('Lessons are text with evidence, given to an agent as context where they apply; no model is trained');
    // Hostile text is text: escaped, never markup.
    expect(memory).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;quoted&#39; &#39;single&#39; &lt;img src=x onerror=alert(2)&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    // Each card: its status in words, its evidence as a link with its receipt (none: a plain file), the runs that used it.
    const card = (id: string): string => memory.slice(memory.indexOf(`data-lesson-card="${id}"`), memory.indexOf('</article>', memory.indexOf(`data-lesson-card="${id}"`)));
    expect(card(plain)).toContain('<span class="lesson-status">stale now</span>');
    expect(card(plain)).toContain('recorded checked, but its evidence changed since: item 1: evidence/one.txt changed: sha256 ');
    expect(card(plain)).toContain('<a class="file" href="../../evidence/one.txt">evidence/one.txt</a>');
    expect(card(plain)).toContain('no receipt');
    expect(card(plain)).toContain('1 run (flows and /agent runs whose records name it)');
    expect(card(plain)).toMatch(/lesson receipt [0-9a-f]{8}/);
    expect(card(hostile)).toContain('<span class="lesson-status">draft</span>');
    expect(card(hostile)).toContain('not checked yet, and its evidence does not check now: item 1: evidence/one.txt changed');
    expect(card(retired)).toContain('<span class="lesson-status">retired</span>');
    // The snapshot has commands, no buttons.
    expect(memory).toContain(`data-cmd="/lesson check ${plain}"`);
    expect(memory).not.toContain('data-act="lesson-check"');
    expect(card(retired)).not.toContain(`/lesson check ${retired}`);
  });
});

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) }, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const json = (token: string): Record<string, string> => ({ ...auth(token), 'Content-Type': 'application/json' });
const post = (port: number, headers: Record<string, string>, body: unknown): Promise<Reply> => raw(port, { method: 'POST', path: '/action', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('the Memory section of the live board: its Check runs /lesson check <id> under the board\'s rules', () => {
  it('offers Check on every lesson but a retired one; refuses without the token, from another Host or Origin, and any other shape; runs the typed command', async () => {
    const { root, ws, notes, hostile, plain, retired } = project();
    await ws.boardLive('live');
    const lb = ws.liveBoard!;
    const port = lb.port;
    const token = lb.url.split('#t=')[1];
    const s = JSON.parse((await raw(port, { path: '/state', headers: auth(token) })).body) as LiveState;
    expect(s.lessons?.sort()).toEqual([hostile, plain].sort());
    expect(s.html).toContain(`<button type="button" class="act" data-act="lesson-check" data-lesson="${hostile}">Check</button>`);
    expect(s.html).not.toContain(`data-lesson="${retired}"`);
    expect(s.html).not.toContain('<script>alert(1)');
    const body = { action: 'lesson', verb: 'check', id: hostile };
    const before = chainOf(root).length;
    expect((await post(port, { 'Content-Type': 'application/json' }, body)).status).toBe(401);
    expect((await post(port, { ...json(token), Authorization: `Bearer ${'0'.repeat(64)}` }, body)).status).toBe(401);
    expect((await post(port, { ...json(token), Host: `localhost:${port}` }, body)).status).toBe(403);
    expect((await post(port, { ...json(token), Origin: 'http://evil.example' }, body)).status).toBe(403);
    expect((await post(port, { ...auth(token), 'Content-Type': 'text/plain' }, body)).status).toBe(415);
    const shape = await post(port, json(token), { ...body, extra: 1 });
    expect([shape.status, shape.body]).toEqual([400, 'A lesson action is {"action":"lesson","verb":"check","id":"<lesson id>"}.']);
    expect((await post(port, json(token), { ...body, verb: 'retire' })).status).toBe(400);
    expect((await post(port, json(token), { ...body, id: '../../x' })).status).toBe(422);
    expect((await post(port, json(token), { ...body, id: 'l00000000' })).status).toBe(404);
    expect((await post(port, json(token), { ...body, id: retired })).status).toBe(404);
    expect(chainOf(root).length).toBe(before); // nothing ran, nothing sealed
    // The one shape, for a lesson on the board: the typed /lesson check <id>, echoed as from the board.
    const ok = await post(port, { ...json(token), Origin: `http://127.0.0.1:${port}` }, body);
    expect(ok.status).toBe(200);
    expect(ok.body.split('\n')[0]).toBe(`board /lesson check ${hostile}`);
    expect(ok.body).toContain(`${hostile} checked: every evidence file (1) has the bytes it was added with`);
    expect(notes).toContain(`  board  /lesson check ${hostile}`);
    expect((JSON.parse(read(root, `.timmy/memory/lessons/${hostile}.json`)) as Lesson).status).toBe('checked');
    expect(chainOf(root).at(-1)).toMatchObject({ kind: 'lesson', lesson: { id: hostile, action: 'check', status: 'checked' } });
    expect(readFileSync(join(root, 'evidence/one.txt'), 'utf8')).toBe('the run where it held\n');
  });

  it('the action is checked against the state alone: exact keys, a lesson id, a lesson the board offers', () => {
    const state = { project: 'p', madeAt: '', toc: '', html: '', shape: '', jobs: [], workflows: [], files: [], lessons: ['l12345678'] } as LiveState;
    expect(checkAction({ action: 'lesson', verb: 'check', id: 'l12345678' }, state)).toEqual({ ok: true, command: { name: 'lesson', args: 'check l12345678', line: '/lesson check l12345678' } });
    expect(checkAction({ action: 'lesson', verb: 'check', id: 'l87654321' }, state)).toMatchObject({ ok: false, status: 404 });
    expect(checkAction({ action: 'lesson', verb: 'check', id: 'l12345678' }, { ...state, lessons: undefined })).toMatchObject({ ok: false, status: 404 });
    expect(checkLessonAction({ action: 'lesson', verb: 'check', id: 'l12345678; /stop all' }, ['l12345678'])).toMatchObject({ ok: false, status: 422 });
    expect(checkLessonAction({ action: 'lesson', id: 'l12345678' }, ['l12345678'])).toMatchObject({ ok: false, status: 400 });
  });
});
