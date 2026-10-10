/**
 * Round R4 (H48): the Control Room through the Workspace: `/room`, the board's section, and its Stop on the live board,
 * which must reach the existing /stop path under the live board's token, Host and Origin rules.
 *
 * FAKE pieces, each labelled:
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent), run through /agent's own
 *   start as Qwen Code on a local endpoint; its task says SLEEP, so its job runs (a real child process) until it is stopped;
 * - the flow is /iterate tray with that same FAKE agent, held in its agent step; TIMMY_CADQUERY_PYTHON names a FAKE file
 *   that is never executed (the flow is stopped before its build);
 * - the tools check is a FAKE list of /tools rows given through the roomTools seam (nothing on this machine is probed).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { folderProject } from '../src/project/index.js';
import type { LiveState } from '../src/repl/board-live.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Segment } from '../src/term/theme.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const FAKE_AGENT = resolve('tests/fixtures/fake-code-agent.mjs');
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const tick = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** FAKE /tools rows (what a check might find): nothing on this machine was probed for them. */
const FAKE_ROWS: CapabilityRow[] = [
  { id: 'blender', kind: 'adapter', name: 'Blender (Python, headless)', rung: 'needs setup', detail: 'not found: FAKE', setup: 'brew install --cask blender (FAKE step)' },
  { id: 'qwen-code', kind: 'harness', name: 'Qwen Code', rung: 'installed', detail: '/agent qwen <task>: FAKE row', exercised: '2026-10-09T08:00:00.000Z' },
  { id: 'mcp-cli', kind: 'tool', name: 'MCP servers (/mcp)', rung: 'installed', detail: 'FAKE: 1 of 2 command-line routes installed' },
];

function make() {
  const root = temp('room-live-');
  const fixtures = temp('room-live-fixtures-');
  const fakePython = join(fixtures, 'fake-python');
  writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  put(root, 'README.md', '# FAKE project for the Control Room tests\n');
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: fakePython },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => `Open ${url} in your browser.`,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('room-live-jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, ts: new Date(Date.now() + i).toISOString(), hash: `sha256_${String(i).padStart(64, '0')}` })) as unknown as Receipt[],
    recoverAtStart: false,
    roomTools: async () => FAKE_ROWS,
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, root, notes, sealed, jobsDir: deps.jobsDir };
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
/** One HTTP request to 127.0.0.1:<port>, with exactly the headers given (Host defaults to the board's own). */
function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = (token: string): Record<string, string> => ({ ...auth(token), 'Content-Type': 'application/json' });
async function live(ws: Workspace): Promise<{ port: number; token: string }> {
  await ws.boardLive('live');
  const lb = ws.liveBoard!;
  return { port: lb.port, token: lb.url.split('#t=')[1] };
}
async function state(port: number, token: string): Promise<LiveState> {
  const r = await raw(port, { path: '/state', headers: auth(token) });
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as LiveState;
}
const post = (port: number, headers: Record<string, string>, body: unknown): Promise<Reply> => raw(port, { method: 'POST', path: '/action', headers, body: JSON.stringify(body) });
/** Polls the live state until `ok` holds (the page polls the same way), at most `ms`. */
async function until(port: number, token: string, ok: (s: LiveState) => boolean, ms = 8000): Promise<LiveState> {
  const end = Date.now() + ms;
  for (;;) {
    const s = await state(port, token);
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`the state never held: ${s.html.slice(0, 300)}`);
    await tick(150);
  }
}
const jobIdOf = (out: string): string => { const m = out.match(/\b(j[0-9a-f]{6})\b/); if (!m) throw new Error(`no job id in: ${out}`); return m[1]; };
const flowIdOf = (out: string): string => { const m = out.match(/\b(f[0-9a-f]{8})\b/); if (!m) throw new Error(`no flow id in: ${out}`); return m[1]; };

describe('the Control Room on the live board: Stop reaches the existing /stop path, under the same token, Host and Origin rules', () => {
  it('a running FAKE agent job: its Stop is refused without the token, from another Host or Origin, then stops it as the typed /stop', async () => {
    const { ws, notes, root, jobsDir } = make();
    const started = text(await ws.agent('qwen FAKE: SLEEP until stopped'));
    const job = jobIdOf(started);
    const { port, token } = await live(ws);
    const s = await until(port, token, (x) => x.html.includes(`data-act="room-stop" data-job="${job}"`));
    expect(s.toc).toContain('Control Room <b>1 running</b>');
    expect(s.html).toContain('<h3 id="room-running">Running now <span class="count">1</span></h3>');
    expect(s.jobs.find((j) => j.id === job)).toMatchObject({ stoppable: true });
    // The room says who owns it and how it is routed, from its own record.
    expect(s.html).toContain('<strong class="room-owner">Qwen Code</strong> <span class="room-state">running</span>');
    expect(s.html).toContain('local endpoint, no charge');
    expect(s.html).not.toContain(root);
    expect(s.html).not.toContain(jobsDir);

    const body = { action: 'stop', job };
    const noToken = await post(port, { 'Content-Type': 'application/json' }, body);
    expect(noToken.status).toBe(401);
    const badToken = await post(port, jsonHeaders('0'.repeat(64)), body);
    expect(badToken.status).toBe(401);
    const otherOrigin = await post(port, { ...jsonHeaders(token), Origin: 'http://127.0.0.1:1' }, body);
    expect(otherOrigin.status).toBe(403);
    const otherHost = await post(port, { ...jsonHeaders(token), Host: `localhost:${port}` }, body);
    expect(otherHost.status).toBe(403);
    const notJson = await raw(port, { method: 'POST', path: '/action', headers: { ...auth(token), 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
    expect(notJson.status).toBe(415);
    // Nothing was stopped by any of them.
    expect(ws.jobs.get(job)?.state).toBe('running');
    expect(notes.filter((n) => n.includes('board  /stop'))).toEqual([]);

    const stopped = await post(port, jsonHeaders(token), body);
    expect(stopped.status).toBe(200);
    expect(stopped.body.split('\n')[0]).toBe(`board /stop ${job}`);
    expect(stopped.body).toContain(`${job} cancelled`);
    expect(notes).toContain(`  board  /stop ${job}`);
    expect(ws.jobs.get(job)?.state).toBe('cancelled');
    // The room moves it to the recent runs, stopped; no Stop is offered for it any more.
    const after = await until(port, token, (x) => !x.html.includes(`data-act="room-stop" data-job="${job}"`) && x.html.includes('<span class="room-state">stopped</span>'));
    expect(after.toc).toContain('Control Room <b>idle</b>');
    const again = await post(port, jsonHeaders(token), body);
    expect(again.status).toBe(409);
  }, 30_000);

  it('a running flow (FAKE agent, held in its agent step): its Stop is /stop <flow-id>, refused from another Origin, and the flow ends cancelled', async () => {
    const { ws, root, notes } = make();
    const started = text(await ws.iterate('tray "FAKE: SLEEP, then make the tray wider"'));
    const flow = flowIdOf(started);
    const { port, token } = await live(ws);
    const s = await until(port, token, (x) => x.html.includes(`data-act="room-stop" data-flow="${flow}"`));
    expect(s.flows).toEqual([{ id: flow, state: 'running', stoppable: true }]);
    // Its handoff chain from its state file: the agent step runs, the others wait.
    expect(s.html).toContain(`<ol class="handoff" aria-label="the handoffs of flow ${flow}">`);
    expect(s.html).toContain('<div class="ho-top"><span class="ho-name">agent</span> <span class="ho-state">running</span> <span class="ho-here-words">running now</span></div><div class="ho-owner">Qwen Code</div>');
    expect(s.html).toContain('<div class="ho-top"><span class="ho-name">readback</span> <span class="ho-state">waiting</span></div>');
    // Its agent run is in the room too, as the agent step of the flow.
    expect(s.html).toContain(`the agent step of flow ${flow}`);

    const refused = await post(port, { ...jsonHeaders(token), Origin: 'http://evil.invalid' }, { action: 'stop', flow });
    expect(refused.status).toBe(403);
    const unknown = await post(port, jsonHeaders(token), { action: 'stop', flow: 'f00000000' });
    expect(unknown.status).toBe(404);
    // Neither refusal stopped it: the board still offers its Stop.
    expect((await state(port, token)).flows).toEqual([{ id: flow, state: 'running', stoppable: true }]);

    const stopped = await post(port, jsonHeaders(token), { action: 'stop', flow });
    expect(stopped.status).toBe(200);
    expect(stopped.body.split('\n')[0]).toBe(`board /stop ${flow}`);
    expect(stopped.body).toContain(`${flow} cancelled`);
    expect(notes).toContain(`  board  /stop ${flow}`);
    const record = JSON.parse(readFileSync(join(root, 'results', 'flows', `${flow}.json`), 'utf8')) as { outcome: string; ended_in: string };
    expect(record).toMatchObject({ outcome: 'cancelled', ended_in: 'agent' });
    // Not running any more: the board has no running flow of that id to stop.
    const after = await until(port, token, (x) => !(x.flows ?? []).some((f) => f.id === flow));
    expect(after.html).not.toContain(`data-flow="${flow}"`);
    const again = await post(port, jsonHeaders(token), { action: 'stop', flow });
    expect(again.status).toBe(404);
  }, 40_000);
});

describe('/room in the REPL', () => {
  it('prints running first, then the recent runs, the costs line and the tools that need setup (FAKE rows), through the command registry', async () => {
    const { ws, root } = make();
    const job = jobIdOf(text(await ws.agent('qwen FAKE: SLEEP until stopped')));
    await tick(400);
    const printed: Segment[][] = [];
    const ctx = { print: (s: Segment[]) => printed.push(s), glyphs: glyphSet(true), workspace: ws } as unknown as ReplContext;
    await runSlash('/room', ctx);
    const out = text(printed);
    expect(out).toContain('Control Room ');
    const at = (s: string): number => { const i = out.indexOf(s); expect(i, s).toBeGreaterThanOrEqual(0); return i; };
    expect(at('RUNNING NOW')).toBeLessThan(at('Qwen Code'));
    expect(at('Qwen Code')).toBeLessThan(at('RECENT, BY OWNER'));
    expect(at('RECENT, BY OWNER')).toBeLessThan(at('COSTS'));
    expect(at('COSTS')).toBeLessThan(at('NEEDS SETUP'));
    expect(out).toContain(`/stop ${job} stops it`);
    expect(out).toContain('1 run free (local endpoint)');
    expect(out).toContain('1 of 3 tools');
    expect(out).toContain('do: brew install --cask blender (FAKE step)');
    expect(out).not.toContain(root);
    // One run by its job id: its route, its handoff (its job, then its result, not written yet).
    const one = text(await ws.room(job));
    expect(one).toContain('Qwen Code');
    expect(one).toMatch(/Handoff\s+1\. job {2}Qwen Code · running · job j[0-9a-f]{6}/);
    expect(one).toContain('2. result  Timmy (its result.json, read by its own rules) · not written yet');
    expect(one).toContain(`Stop       /stop ${job}`);
    // The board's snapshot now has the tools panel from that check, with the FAKE rows' words kept.
    ws.board('');
    const html = readFileSync(join(root, '.timmy', 'board', 'index.html'), 'utf8');
    expect(html).toContain('<h3 id="room-tools">Tools and connections</h3>');
    expect(html).toContain('do: <code>brew install --cask blender (FAKE step)</code>');
    expect(html).toContain('used 2026-10-09');
    expect(html).toContain('/tools has no row for Houdini');
    expect(html).toContain(`data-cmd="/stop ${job}"`);
    expect(html.indexOf('id="room"')).toBeLessThan(html.indexOf('id="references"'));
    await ws.stop(job);
  }, 30_000);
});
