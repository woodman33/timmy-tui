/**
 * Round R4 (H51): `timmy act "<slash command>"` as a real child process (the CLI through tsx) in a temporary project: its
 * exit codes (0 succeeded or answered, 1 failed, 2 refused or usage, 3 stopped), its --json object, its operation record,
 * and a stop by SIGTERM through the normal stop path.
 *
 * FAKE pieces, each labelled: the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing
 * sent), run through /agent's own start as Qwen Code on a local endpoint; its task's words choose what it does (SLEEP waits
 * 30 s, EXIT3 exits 3). Everything else is real: the CLI, the Workspace, the job manager, the records and the receipt chain
 * (the project's own, .timmy/receipts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { OPERATION_ID } from '../src/ops/context.js';
import { readOperationRecord } from '../src/ops/operations.js';
import { needsPerson, parseActArgs, parseDuration, startsWork } from '../src/ops/act.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';
import { act, json, opsKit, sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

/** The one JSON object --json ends with (the last line of stdout). */
const lastJson = (stdout: string): Record<string, unknown> => {
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
};

describe('timmy act: its arguments, what needs a person, what starts work', () => {
  it('parses one quoted command and its options; refuses two words, an unknown option, a bad duration', () => {
    expect(parseActArgs(['/iterate tray "x"', '--wait', '--timeout', '90s', '--project=p'])).toEqual({ line: '/iterate tray "x"', wait: true, json: false, project: 'p', timeoutMs: 90_000 });
    expect(parseActArgs(['/op'], { json: true })).toMatchObject({ line: '/op', json: true, wait: false });
    expect(parseActArgs(['/op', 'extra'])).toMatchObject({ error: expect.stringContaining('Quote the command as one argument') });
    expect(parseActArgs(['--frobnicate', '/op'])).toMatchObject({ error: expect.stringContaining('No option --frobnicate') });
    expect(parseActArgs(['/op', '--timeout', 'soon'])).toMatchObject({ error: expect.stringContaining('is not a duration') });
    expect(parseActArgs([])).toMatchObject({ error: expect.stringContaining('Name the command') });
    expect([parseDuration('500ms'), parseDuration('5m'), parseDuration('2'), parseDuration('0'), parseDuration('x')]).toEqual([500, 300_000, 2000, undefined, undefined]);
  });

  it('a command that would ask a person is named; one that starts work is told from one that answers', () => {
    expect(needsPerson('make the tray wider')).toMatch(/chat request/);
    for (const l of ['/edit notes.md', '/watch', '/center', '/web', '/browser', '/canvas', '/board live', '/model x', '/new', '/exit']) expect(needsPerson(l), l).toBeDefined();
    for (const l of ['/op', '/ops', '/room', '/board', '/jobs', '/iterate tray "x"', '/inspect a.step']) expect(needsPerson(l), l).toBeUndefined();
    for (const l of ['/iterate tray "x"', '/run WORKFLOW.md result', '/inspect a.step', '/agent qwen fix it', '/recipe tray', '/mcp call s t']) expect(startsWork(l), l).toBe(true);
    for (const l of ['/iterate', '/run', '/agent', '/agent last', '/op', '/ops', '/room', '/jobs', '/recipe', '/mcp']) expect(startsWork(l), l).toBe(false);
  });
});

describe('timmy act, a real child process: exit codes, --json, the operation record', () => {
  it('succeeds (exit 0) with --wait --json: one JSON object; the operation recorded; the agent run, its job and receipts carry its id', async () => {
    const s = sandbox(kit, 'ops-act-ok-');
    const r = await act(kit, s, ['/agent qwen FAKE: say hello', '--wait', '--json']).done;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const o = lastJson(r.stdout);
    // Only the one JSON object on stdout; the progress went to stderr.
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(o).toMatchObject({ schema: 'timmy.act/1', joined: false, parent: null, request: '/agent qwen FAKE: say hello', project: 'project', outcome: 'succeeded', exit_code: 0 });
    const op = String(o.operation);
    expect(op).toMatch(OPERATION_ID);
    const runs = o.runs as Array<{ kind: string; id: string }>;
    const agent = runs.find((x) => x.kind === 'agent')!.id;
    const job = runs.find((x) => x.kind === 'job')!.id;
    expect(o.records).toEqual([`.timmy/operations/${op}.json`, `.timmy/agents/${agent}/result.json`]);
    expect((o.receipts as Array<{ kind: string }>).map((x) => x.kind)).toEqual(['agent']);
    // The progress lines went to stderr: the agent's start and its end.
    expect(r.stderr).toMatch(new RegExp(`agent qwen ${agent}`));
    // The record: the request, from act, ended succeeded, its runs.
    const rec = readOperationRecord(s.root, op);
    expect(rec.ok && rec.record).toMatchObject({ schema: 'timmy.operation/1', id: op, request: '/agent qwen FAKE: say hello', via: 'act', state: 'succeeded', parent: null, project: 'project' });
    if (rec.ok) expect(rec.record.runs.map((x) => `${x.kind}:${x.id}`).sort()).toEqual([`agent:${agent}`, `job:${job}`].sort());
    expect(json(path.join(s.root, '.timmy', 'agents', agent, 'result.json'))).toMatchObject({ operation: op, outcome: 'completed' });
    expect(json(path.join(s.home, 'timmy', 'jobs', `${job}.json`))).toMatchObject({ operation: op, state: 'completed' });
    const chain = readChain('runs', s.root);
    expect(chain.map((x) => [x.kind, x.operation_id])).toEqual([['agent', op]]);
    expect(verifyChain('runs', s.root).ok).toBe(true);
    // Nothing of the sandbox's folders in what it printed or recorded.
    expect(r.stdout).not.toContain(s.base);
    expect(fs.readFileSync(path.join(s.root, '.timmy', 'operations', `${op}.json`), 'utf8')).not.toContain(s.base);
  }, 90_000);

  it('a command that answers (exit 0) records an operation that started nothing; a failed run exits 1', async () => {
    const s = sandbox(kit, 'ops-act-fail-');
    const answered = await act(kit, s, ['/jobs']).done;
    expect(answered.code, answered.stdout + answered.stderr).toBe(0);
    expect(answered.stdout).toMatch(/operation o[0-9a-f]{8} answered/);
    const failed = await act(kit, s, ['/agent qwen FAKE: EXIT3 right after starting', '--wait']).done;
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    const op = /operation (o[0-9a-f]{8}) failed/.exec(failed.stdout)?.[1];
    expect(op, failed.stdout).toBeDefined();
    const rec = readOperationRecord(s.root, op!);
    expect(rec.ok && rec.record.state).toBe('failed');
    expect(rec.ok && rec.record.why).toMatch(/failed/);
  }, 90_000);

  it('refuses (exit 2): a command that needs a person, with the line to type in the REPL; a start that started nothing; a usage error', async () => {
    const s = sandbox(kit, 'ops-act-refuse-');
    const edit = await act(kit, s, ['/edit box.scad', '--json']).done;
    expect(edit.code).toBe(2);
    expect(edit.stderr).toContain('Not run: /edit opens a file in your editor, which needs a person. Type this in the REPL instead: /edit box.scad');
    expect(lastJson(edit.stdout)).toMatchObject({ schema: 'timmy.act/1', operation: null, outcome: 'refused', exit_code: 2, records: [], receipts: [] });
    const chat = await act(kit, s, ['make the box wider']).done;
    expect(chat.code).toBe(2);
    expect(chat.stdout).toContain('Type this in the REPL instead: make the box wider');
    // Nothing was begun for either: no operation record.
    expect(fs.existsSync(path.join(s.root, '.timmy', 'operations'))).toBe(false);

    // A start of work that started nothing and sealed nothing (no such model): refused, and recorded as refused.
    const missing = await act(kit, s, ['/iterate scad nothing-here.scad "make it wider"', '--wait']).done;
    expect(missing.code, missing.stdout + missing.stderr).toBe(2);
    const op = /operation (o[0-9a-f]{8}) refused/.exec(missing.stdout)?.[1];
    expect(op, missing.stdout).toBeDefined();
    expect(readOperationRecord(s.root, op!)).toMatchObject({ ok: true, record: { state: 'refused', runs: [] } });

    const usage = await act(kit, s, ['/op', 'extra', '--json']).done;
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('Quote the command as one argument');
    expect(lastJson(usage.stdout)).toMatchObject({ operation: null, outcome: 'usage', exit_code: 2 });
    expect(readChain('runs', s.root)).toEqual([]);
  }, 120_000);

  it('stopped by SIGTERM (exit 3): what it started stops through the normal stop path and is recorded stopped', async () => {
    const s = sandbox(kit, 'ops-act-term-');
    const run = act(kit, s, ['/agent qwen FAKE: SLEEP until stopped', '--wait']);
    const [, op] = await run.waitFor(/operation (o[0-9a-f]{8})/);
    // Its agent's job runs (its line says so) before the signal is sent.
    const [, job] = await run.waitFor(/\b(j[0-9a-f]{6})\b/);
    await new Promise((r) => { setTimeout(r, 500); });
    run.child.kill('SIGTERM');
    const r = await run.done;
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toContain('stopping: SIGTERM received');
    expect(r.stdout).toMatch(new RegExp(`operation ${op} stopped: SIGTERM received`));
    // Its record: stopped, by the signal first, then how its run ended by the run's own record.
    expect(readOperationRecord(s.root, op)).toMatchObject({ ok: true, record: { state: 'stopped', why: expect.stringMatching(/^SIGTERM received; agent a[0-9a-f]{8} cancelled/) } });
    expect(json(path.join(s.home, 'timmy', 'jobs', `${job}.json`))).toMatchObject({ state: 'cancelled', operation: op });
    const agentRuns = fs.readdirSync(path.join(s.root, '.timmy', 'agents'));
    expect(agentRuns).toHaveLength(1);
    expect(json(path.join(s.root, '.timmy', 'agents', agentRuns[0], 'result.json'))).toMatchObject({ outcome: 'cancelled', operation: op });
    // Its stop was sealed under its operation too.
    const chain = readChain('runs', s.root);
    expect(chain.length).toBeGreaterThan(0);
    for (const x of chain) expect(x.operation_id).toBe(op);
  }, 90_000);

  it('without --wait (exit 3): what the command started is stopped as act exits, never left without its record', async () => {
    const s = sandbox(kit, 'ops-act-nowait-');
    const r = await act(kit, s, ['/agent qwen FAKE: SLEEP until stopped', '--json']).done;
    expect(r.code, r.stdout + r.stderr).toBe(3);
    const o = lastJson(r.stdout);
    expect(o).toMatchObject({ outcome: 'stopped', exit_code: 3, why: expect.stringContaining('was not given --wait') });
    const agent = (o.runs as Array<{ kind: string; id: string }>).find((x) => x.kind === 'agent')!.id;
    expect(json(path.join(s.root, '.timmy', 'agents', agent, 'result.json'))).toMatchObject({ outcome: 'cancelled', operation: o.operation });
    expect(readOperationRecord(s.root, String(o.operation))).toMatchObject({ ok: true, record: { state: 'stopped' } });
  }, 90_000);
});
