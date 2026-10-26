/**
 * R13 (the operator's 15:31 order, item 4): `timmy video`, `timmy animate`, Animate's agent tools and MCP tools, through the
 * one mini-app host (C1). Against a LABELLED FAKE app (tests/fixtures/fake-jobs-app: Film Room's and Animate's job records
 * and routes as their owners ship them, jobs ~400 ms, FAKE bytes) and a FAKE authoring engine: no model, no network, no
 * Blender, no ffmpeg. What is pinned: each command runs the app's own job to its own end state, cancels it when asked, and
 * hands back the receipt Timmy sealed for that job in the project's runs chain; one worker per app folder across processes.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAnimateCli, runVideoCli } from '../src/miniapps/app-commands.js';
import { ANIMATE_TOOLS, callAnimateTool } from '../src/agent/animate-tools.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { openAppSession } from '../src/companion/miniapps/session.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-jobs-app', import.meta.url));
let box = '';
let env: Record<string, string | undefined> = {};
let root = '';
const lines: string[] = [];
const io = () => ({ env, out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) });
const chain = () => readChain('runs', root).filter((r) => r.kind === 'miniapp');

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'timmy-app-commands-'));
  root = join(box, 'project');
  mkdirSync(join(root, '.timmy'), { recursive: true });
  writeFileSync(join(root, '.timmy', 'store-pin'), join(root, '.timmy', 'receipts'));
  env = { PATH: process.env.PATH, HOME: box, TIMMY_HOME: join(box, 'timmy'), TIMMY_FILM_ROOM_DIR: FAKE, TIMMY_ANIMATE_DIR: FAKE };
  // (the active project, as other surfaces read it)
  mkdirSync(join(box, 'timmy', 'state'), { recursive: true });
  writeFileSync(join(box, 'timmy', 'state', 'active-project.json'), JSON.stringify({ name: 'project', root }));
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });

describe('timmy video and timmy animate through the C1 host (FAKE app)', () => {
  it('timmy video import: the app’s ingest runs to its own end; Timmy seals one receipt, the media hashed from the app’s bytes', async () => {
    const prev = process.env.TIMMY_HOME; process.env.TIMMY_HOME = env.TIMMY_HOME;
    try {
      const clip = join(box, 'clip.mp4'); writeFileSync(clip, 'FAKE video bytes');
      lines.length = 0;
      expect(await runVideoCli(['import', clip], io())).toBe(0);
      expect(lines.join('\n')).toMatch(/Film Room job [a-f0-9-]{36}: complete\.\nreceipt rc_\S+: ok \(the app said complete\)/);
      const r = chain().at(-1)!;
      expect(r).toMatchObject({ status: 'ok', job: { kind: 'ingest', state: 'complete' }, miniapp: { app: 'film-room', principal: 'operator' } });
      expect(r.outputs?.[0]).toMatchObject({ sha256: createHash('sha256').update('FAKE video bytes').digest('hex'), bytes: 16 });
    } finally { if (prev === undefined) delete process.env.TIMMY_HOME; else process.env.TIMMY_HOME = prev; }
  }, 60_000);

  it('timmy video render --cancel-after: the app cancels its job; the receipt says cancelled (exit 130), never ok; a render that ends is ok with each clip hashed', async () => {
    const prev = process.env.TIMMY_HOME; process.env.TIMMY_HOME = env.TIMMY_HOME;
    try {
      const manifest = join(box, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ schema_version: 1, clips: [{ id: 'a', start_seconds: 0, end_seconds: 1 }, { id: 'b', start_seconds: 1, end_seconds: 2 }] }));
      lines.length = 0;
      expect(await runVideoCli(['render', '00000000-0000-4000-8000-000000000000', manifest, '--cancel-after', '0.05'], io())).toBe(130);
      expect(lines.join('\n')).toMatch(/: cancelled \(cancel asked\)\.\nreceipt rc_\S+: cancelled/);
      expect(chain().at(-1)).toMatchObject({ status: 'cancelled', job: { kind: 'render', state: 'cancelled' }, outputs: [] });
      lines.length = 0;
      expect(await runVideoCli(['render', '00000000-0000-4000-8000-000000000000', manifest, '--json'], io())).toBe(0);
      const out = JSON.parse(lines.join('\n'));
      expect(out).toMatchObject({ app: 'film-room', state: 'complete', cancelRequested: false, receipts: [{ status: 'ok', state: 'complete' }] });
      expect(chain().at(-1)!.outputs!.map((o) => o.path.split('/').pop())).toEqual(['clip-001.mp4', 'clip-002.mp4']);
      expect(verifyChain('runs', root).ok).toBe(true);
    } finally { if (prev === undefined) delete process.env.TIMMY_HOME; else process.env.TIMMY_HOME = prev; }
  }, 60_000);

  it('timmy animate render: a failed export stays failed in its receipt; a good one is ok with its artifacts hashed; authoring commands need the hosted copy', async () => {
    const prev = process.env.TIMMY_HOME; process.env.TIMMY_HOME = env.TIMMY_HOME;
    try {
      const bad = join(box, 'bad.json'); writeFileSync(bad, JSON.stringify({ version: 1, name: 'FAIL', objects: [] }));
      const good = join(box, 'good.json'); writeFileSync(good, JSON.stringify({ version: 1, name: 'ok', objects: [] }));
      lines.length = 0;
      expect(await runAnimateCli(['render', bad], io())).toBe(1);
      expect(chain().at(-1)).toMatchObject({ status: 'failed', job: { kind: 'export', state: 'failed', error: 'FAKE export failure' }, miniapp: { app: 'animate' } });
      lines.length = 0;
      expect(await runAnimateCli(['render', good], io())).toBe(0);
      expect(chain().at(-1)).toMatchObject({ status: 'ok', job: { state: 'succeeded' } });
      expect(chain().at(-1)!.outputs!.map((o) => o.sha256)).toEqual([createHash('sha256').update('FAKE scene.blend').digest('hex'), createHash('sha256').update('FAKE preview.png').digest('hex')]);
      lines.length = 0;
      expect(await runAnimateCli(['example', join(box, 'x.json')], { ...io(), env: { ...env, TIMMY_ANIMATE_DIR: join(box, 'nowhere') } })).toBe(2);
      expect(lines.join('\n')).toMatch(/authoring commands are not installed here/);
    } finally { if (prev === undefined) delete process.env.TIMMY_HOME; else process.env.TIMMY_HOME = prev; }
  }, 60_000);

  it('the agent’s and MCP’s Animate tools: authoring is the owner’s engine from the hosted copy, read-only; the export runs the app’s job, asks first, and returns its receipt', async () => {
    const prev = process.env.TIMMY_HOME; process.env.TIMMY_HOME = env.TIMMY_HOME;
    try {
      expect(ANIMATE_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['timmy_animate_catalog', 'timmy_animate_svg', 'timmy_animate_export']));
      expect(await callAnimateTool('timmy_animate_svg', { sceneJson: '{"version":1}', time: 1 }, env)).toEqual({ fake: true, name: 'studio_svg', input: { time: 1, scene: { version: 1 } } });
      expect(approvalNeeded('timmy_animate_svg', {})).toBeNull();
      expect(approvalNeeded('timmy_animate_export', { sceneJson: '{}' })).toMatchObject({ reason: expect.stringMatching(/Blender/) });
      const r = await callAnimateTool('timmy_animate_export', { sceneJson: JSON.stringify({ version: 1, name: 'ok' }) }, env) as { ok: boolean; state: string; receipts: Array<{ status: string }> };
      expect(r).toMatchObject({ ok: true, state: 'succeeded', receipts: [{ status: 'ok' }] });
      const c = await callAnimateTool('timmy_animate_export', { sceneJson: JSON.stringify({ version: 1, name: 'ok' }), cancelAfterSeconds: 0.05 }, env) as { ok: boolean; state: string; receipts: Array<{ status: string }> };
      expect(c).toMatchObject({ ok: false, state: 'cancelled', receipts: [{ status: 'cancelled' }] });
    } finally { if (prev === undefined) delete process.env.TIMMY_HOME; else process.env.TIMMY_HOME = prev; }
  }, 60_000);

  it('the MCP server lists Timmy Animate’s tools and runs an authoring one', async () => {
    const child = spawn(resolve('node_modules/.bin/tsx'), [resolve('src/mcp/server.ts')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies: Array<{ id: number; result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } }> = [];
    let buf = '';
    child.stdout.on('data', (c: Buffer) => { buf += c.toString(); for (;;) { const i = buf.indexOf('\n'); if (i < 0) break; const line = buf.slice(0, i); buf = buf.slice(i + 1); try { replies.push(JSON.parse(line)); } catch { /* not a reply */ } } });
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const wait = async (id: number) => { for (let i = 0; i < 400; i++) { const r = replies.find((x) => x.id === id); if (r) return r; await new Promise((x) => setTimeout(x, 50)); } throw new Error(`no reply ${id}`); };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
      await wait(1);
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const list = await wait(2);
      expect(list.result!.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(['timmy_animate_catalog', 'timmy_animate_export']));
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'timmy_animate_catalog', arguments: {} } });
      const called = await wait(3);
      expect(JSON.parse(called.result!.content![0]!.text)).toEqual({ fake: true, name: 'studio_catalog', input: {} });
    } finally { child.kill('SIGTERM'); }
  }, 90_000);

  it('one worker per app folder: while one Timmy process has the app open for the project, another is told so and starts none', async () => {
    const prev = process.env.TIMMY_HOME; process.env.TIMMY_HOME = env.TIMMY_HOME;
    try {
      const s = await openAppSession('film-room', { env });
      if ('error' in s) throw new Error(s.error);
      const lock = `${s.app.dataDir}.timmy-worker.lock`;
      // another process's lock (a live pid that is not this one): this test's parent
      writeFileSync(lock, JSON.stringify({ pid: process.ppid, since: 'FAKE' }));
      const again = await openAppSession('film-room', { env });
      expect(again).toEqual({ error: expect.stringMatching(/already open for this project in another Timmy process \(pid \d+/) });
      // (the lock is this session's again when it closes; a stale lock of a gone process is taken over)
      writeFileSync(lock, JSON.stringify({ pid: process.pid }));
      await s.close();
      writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345 }));
      const later = await openAppSession('film-room', { env });
      expect('error' in later).toBe(false);
      if (!('error' in later)) await later.close();
    } finally { if (prev === undefined) delete process.env.TIMMY_HOME; else process.env.TIMMY_HOME = prev; }
  }, 60_000);
});
