/**
 * Round R4 (H51): one project, two Timmy processes. The one-flow rule (src/repl/flow-lock.ts) and the live board's 409 on
 * a parameter save see a flow another live process runs in the project (its hold file, .timmy/flow-holds/, proved by its
 * writer's pid and start), name it in the refusal, and never trust a stale hold.
 *
 * The two processes are real: this test's process as the REPL (a Workspace, its live board on 127.0.0.1) and `timmy act`
 * (the real CLI through tsx) as a child process. FAKE pieces, each labelled: the code agent is
 * tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent; SLEEP holds its flow in the agent step), and
 * OpenSCAD is tests/fixtures/fake-openscad.mjs (a TEST DOUBLE), never reached here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { HOLDS_DIR, HOLD_SCHEMA, holdWords, otherHolds, takeProjectHold } from '../src/ops/flow-hold.js';
import { processStartMs, THIS_PROCESS, writerState } from '../src/ops/process-proof.js';
import { readOperationRecord } from '../src/ops/operations.js';
import { act, opsKit, replOf, sandbox, sleep, text, until } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

function post(port: number, token: string, pathname: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((done, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: pathname, setHost: false, agent: false,
      headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}
const PARAMS = { width: 150, wall: 3, supportOffset: 10, bore: 3 };
const holdFiles = (root: string): string[] => { try { return fs.readdirSync(path.join(root, HOLDS_DIR)).filter((n) => n.endsWith('.json')); } catch { return []; } };

describe('one project, two Timmy processes: the one-flow rule and the board\'s 409 see the other process', () => {
  it('a flow in a `timmy act` process: this REPL\'s start is refused naming that process and its operation; the board\'s parameter save gets 409; once it is stopped, both go through', async () => {
    const s = sandbox(kit, 'ops-two-a-');
    const { ws } = replOf(kit, s);
    expect(text(await ws.boardLive('live'))).toContain('Live board');
    const { port, url } = ws.liveBoard!;
    const token = url.split('#t=')[1];

    const other = act(kit, s, ['/iterate scad box.scad "FAKE: SLEEP, then make it wider"', '--wait']);
    const [, op] = await other.waitFor(/operation (o[0-9a-f]{8})/);
    const [, flow] = await other.waitFor(/\b(f[0-9a-f]{8})\b/);
    // Its hold, named by its flow, its operation and its process (the node process tsx runs, not tsx itself).
    await until(() => holdFiles(s.root).length === 1 && JSON.parse(fs.readFileSync(path.join(s.root, HOLDS_DIR, holdFiles(s.root)[0]), 'utf8')).flow === flow, 20_000, 'the hold naming the flow');
    const hold = JSON.parse(fs.readFileSync(path.join(s.root, HOLDS_DIR, holdFiles(s.root)[0]), 'utf8')) as { schema: string; kind: string; flow: string; operation: string; owner: { pid: number; started: string } };
    expect(hold).toMatchObject({ schema: HOLD_SCHEMA, kind: 'scad', flow, operation: op });
    const pid = hold.owner.pid;
    expect(pid).not.toBe(process.pid);
    expect(writerState(hold.owner)).toBe('alive');
    const rec = readOperationRecord(s.root, op);
    expect(rec.ok && rec.record.owner.pid).toBe(pid);

    // This REPL's start (any kind) is refused, naming the other process; nothing is started.
    const refused = text(await ws.operate('/iterate scad box.scad "make it taller"', 'repl', () => ws.iterate('scad box.scad "make it taller"')));
    expect(refused).toContain(`Flow ${flow} is still running in this project in another Timmy process (pid ${pid}, operation ${op}), and one flow at a time runs in a project`);
    expect(refused).toContain('wait for it, or stop it in the Timmy that runs it. Nothing was started.');
    expect(fs.readdirSync(path.join(s.root, '.timmy', 'flows'))).toEqual([flow]);
    // The live board's parameter save: 409, naming the other process; nothing written.
    const busy = await post(port, token, '/edit', { action: 'set-params', recipe: 'tray', base: null, parameters: PARAMS });
    expect(busy).toEqual({ status: 409, body: expect.stringContaining(`flow ${flow} is running in this project in another Timmy process (pid ${pid}, operation ${op}): save after it ends`) });
    expect(fs.existsSync(path.join(s.root, 'recipes', 'tray.params.json'))).toBe(false);

    // Stopped in its own process (SIGTERM, act's normal stop path): its hold goes with its flow.
    other.child.kill('SIGTERM');
    const r = await other.done;
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(holdFiles(s.root)).toEqual([]);
    expect(otherHolds(s.root)).toEqual([]);
    const saved = await post(port, token, '/edit', { action: 'set-params', recipe: 'tray', base: null, parameters: PARAMS });
    expect(saved.status, saved.body).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(s.root, 'recipes', 'tray.params.json'), 'utf8')).parameters.width).toBe(150);
  }, 120_000);

  it('a flow in this REPL: a `timmy act` start in the same project is refused (exit 2) naming this process and its operation', async () => {
    const s = sandbox(kit, 'ops-two-b-');
    const { ws } = replOf(kit, s);
    const started = text(await ws.operate('/iterate scad box.scad "FAKE: SLEEP, then make it wider"', 'repl', () => ws.iterate('scad box.scad "FAKE: SLEEP, then make it wider"')));
    const flow = /\b(f[0-9a-f]{8})\b/.exec(started)?.[1];
    expect(flow, started).toBeDefined();
    const op = ws.ops.latest!.id;
    expect(holdFiles(s.root)).toHaveLength(1);

    const r = await act(kit, s, ['/iterate scad box.scad "make it taller"', '--wait', '--json']).done;
    expect(r.code, r.stdout + r.stderr).toBe(2);
    const o = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { outcome: string; operation: string; lines: string[]; runs: unknown[] };
    expect(o).toMatchObject({ outcome: 'refused', runs: [] });
    expect(o.lines.join('\n')).toContain(`Flow ${flow} is still running in this project in another Timmy process (pid ${process.pid}, operation ${op})`);
    expect(readOperationRecord(s.root, o.operation)).toMatchObject({ ok: true, record: { state: 'refused' } });
    // Its refused start left no hold of its own; this REPL's stays until its flow ends.
    expect(holdFiles(s.root)).toHaveLength(1);
    expect(text(await ws.stop(flow!))).toContain(`${flow} cancelled`);
    await until(() => holdFiles(s.root).length === 0, 20_000, 'the hold to go with the flow');
  }, 120_000);
});

describe('flow holds: the proof rule (pid and process start), never a stale hold trusted', () => {
  it('a hold whose writer is gone, or whose pid now names a process that started at another time, is removed; a live writer\'s refuses', async () => {
    const s = sandbox(kit, 'ops-holds-');
    const dir = path.join(s.root, HOLDS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const put = (name: string, owner: { pid: number; started: string }, extra: Record<string, unknown> = {}): void =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ schema: HOLD_SCHEMA, kind: 'tray', owner, taken: new Date().toISOString(), ...extra }));
    // A process that has ended: its pid names nothing now.
    const ended = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => ended.on('close', r));
    put(`h${ended.pid}-00000001.json`, { pid: ended.pid!, started: new Date(Date.now() - 1000).toISOString() });
    // A process that runs, with the start the process table gives it, and the same pid with another start (a reused pid).
    const live = spawn('sleep', ['30']);
    kit.children.push(live);
    await sleep(300);
    const at = processStartMs(live.pid!);
    expect(at).toBeDefined();
    put(`h${live.pid}-00000002.json`, { pid: live.pid!, started: new Date(at!).toISOString() }, { flow: 'f00000002', operation: 'o00000002' });
    put(`h${live.pid}-00000003.json`, { pid: live.pid!, started: new Date(at! - 3_600_000).toISOString() });
    // This process with another start, and a file that is not a hold (left as it is).
    put(`h${process.pid}-00000004.json`, { pid: process.pid, started: '2001-01-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(dir, `h${process.pid}-00000005.json`), 'not JSON');

    const seen = otherHolds(s.root);
    expect(seen).toEqual([{ rel: `${HOLDS_DIR}/h${live.pid}-00000002.json`, kind: 'tray', flow: 'f00000002', operation: 'o00000002', pid: live.pid, taken: expect.any(String), proof: 'alive' }]);
    expect(holdWords(seen[0])).toBe(`in another Timmy process (pid ${live.pid}, operation o00000002)`);
    expect(fs.readdirSync(dir).sort()).toEqual([`h${live.pid}-00000002.json`, `h${process.pid}-00000005.json`].sort());

    // A start is refused by the live hold, and leaves nothing; once that writer is gone, the start takes the project.
    const t = takeProjectHold(s.root, { kind: 'scad', operation: 'o00000009' });
    expect(t).toMatchObject({ ok: false, by: { flow: 'f00000002', pid: live.pid } });
    expect(fs.readdirSync(dir)).toHaveLength(2);
    live.kill('SIGKILL');
    await new Promise((r) => live.on('close', r));
    const mine = takeProjectHold(s.root, { kind: 'scad', operation: 'o00000009' });
    expect(mine.ok).toBe(true);
    if (!mine.ok || !mine.hold) throw new Error('no hold');
    expect(JSON.parse(fs.readFileSync(path.join(dir, mine.hold.rel), 'utf8'))).toMatchObject({ kind: 'scad', operation: 'o00000009', owner: { pid: THIS_PROCESS.pid, started: THIS_PROCESS.started } });
    // Another start of this process (another lock, as a second Workspace would be) is refused by it; released, it goes.
    expect(takeProjectHold(s.root, { kind: 'tray' })).toMatchObject({ ok: false, by: { kind: 'scad', pid: process.pid, proof: 'alive' } });
    mine.hold.name('f00000009');
    expect(otherHolds(s.root)[0]).toMatchObject({ flow: 'f00000009' });
    mine.hold.release();
    expect(otherHolds(s.root)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([`h${process.pid}-00000005.json`]);
  }, 60_000);
});
