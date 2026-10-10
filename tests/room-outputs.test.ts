/**
 * Round R4 (helper H59; r18, ledger row 157): the Control Room lists an output only when its file is there; a file a
 * record names that is not there is named as missing in words ("result.json: not written"), never listed or linked as an
 * output (src/room/outputs.ts, src/room/index.ts, src/room/text.ts, src/repl/board-room.ts). Every record here is FAKE,
 * written by hand in the shapes Timmy writes them (no agent, model or app ran); every id, hash and task says FAKE or is
 * made up. The real crash and recovery that leave such records are tests/recover-agent-record.test.ts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectId } from '../src/project/index.js';
import { kit } from '../src/repl/board-kit.js';
import { roomSection } from '../src/repl/board-room.js';
import { gatherRoom, type RoomContext } from '../src/room/index.js';
import { isThere, missingWords, sealedBy, splitOutputs } from '../src/room/outputs.js';
import { roomItemLines } from '../src/room/text.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt } from '../src/utils/receipts.js';
import { fakeTray } from './fixtures/fake-flow-records.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'room-outputs-')); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): string => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); return createHash('sha256').update(body).digest('hex'); };
const json = (root: string, rel: string, v: unknown): string => put(root, rel, `${JSON.stringify(v, null, 2)}\n`);
const lines = (l: { text: string }[][]): string => l.map((s) => s.map((x) => x.text).join('')).join('\n');
const glyphs = glyphSet(true);
const RUN = 'a0000c001';

/** A FAKE agent run record as run.json says it: submitted at its start, or interrupted by recovery (src/code-agents/run-end.ts). */
const runRecord = (state: 'submitted' | 'interrupted', o: Record<string, unknown> = {}) => ({
  agent_run: 1, run: RUN, agent: 'qwen', agent_version: '0.0.0-fake', model: 'fake-model', endpoint: 'local', where: '127.0.0.1:11434',
  task: 'FAKE: a task', job: 'j0c0c01', started_at: '2026-10-10T09:00:00.000Z', state,
  ...(state === 'interrupted' ? {
    ended_at: '2026-10-10T09:05:00.000Z', why: 'its REPL ended while it ran; recovery stopped its process group 4242 (2 processes) with SIGTERM; no result was written',
    recovered: { at: '2026-10-10T09:05:00.000Z', by: 'recovery', process: 'stopped by recovery', job: { id: 'j0c0c01', state: 'cancelled', error: 'FAKE' }, stopped: { process_group: 4242, processes: 2, signals: ['SIGTERM'], cleanup: 'complete' }, flow: 'f0000c001', result: 'not written' },
  } : {}),
  ...o,
});

/** A FAKE flow interrupted in its agent step, as recover.ts writes one: its agent part names the result.json path. */
function interruptedFlow(root: string): void {
  const base = fakeTray();
  json(root, 'results/flows/f0000c001.json', {
    ...base, id: 'f0000c001', outcome: 'interrupted', ended_in: 'agent', why: 'FAKE: the REPL running it ended while its agent ran; nothing was built',
    agent: { run: RUN, agent: 'qwen', version: '0.0.0-fake', route: 'local endpoint, no charge', where: '127.0.0.1', model: 'fake-model', job: 'j0c0c01', result: `.timmy/agents/${RUN}/result.json`, progress: `.timmy/agents/${RUN}/progress.log` },
    rebuild: undefined, readback: undefined, receipts: {},
    parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: 'a'.repeat(64), values: {} } },
  });
}

function context(root: string, chain: Receipt[] = []): RoomContext {
  return { root, project: 'fake-room', projectId: projectId(root), jobs: [], chain, mine: () => false, activeFlows: [], scrub: (t) => t.split(root).join('.'), now: () => Date.parse('2026-10-10T10:00:00.000Z') };
}

describe('the outputs rule: listed only when there; missing ones named in words', () => {
  it('splits a record\'s files by whether they are there (as themselves, nothing followed); an agent\'s result says what its run record says', () => {
    const root = temp();
    put(root, 'out/a.stl', 'FAKE');
    expect(isThere(root, 'out/a.stl')).toBe(true);
    expect(isThere(root, 'out/b.stl')).toBe(false);
    expect(splitOutputs(root, [{ role: 'STL', path: 'out/a.stl' }, { role: 'STEP', path: 'out/b.step' }])).toEqual({
      outputs: [{ role: 'STL', path: 'out/a.stl' }],
      missing: [{ role: 'STEP', path: 'out/b.step', words: 'not there' }],
    });
    const result = `.timmy/agents/${RUN}/result.json`;
    expect(missingWords(root, result)).toBe('not there'); // no record of the run at all
    json(root, `.timmy/agents/${RUN}/run.json`, runRecord('submitted'));
    expect(missingWords(root, result)).toBe('not written yet');
    json(root, `.timmy/agents/${RUN}/run.json`, runRecord('interrupted'));
    expect(missingWords(root, result)).toBe('not written');
    // A record of another run under this run's folder says nothing about this one.
    json(root, `.timmy/agents/${RUN}/run.json`, { ...runRecord('interrupted'), run: 'a0000c999' });
    expect(missingWords(root, result)).toBe('not there');
  });

  it('a flow interrupted in its agent step: /room <flow> names result.json as not written, never under Outputs; the board names it without a link', () => {
    const root = temp();
    interruptedFlow(root);
    json(root, `.timmy/agents/${RUN}/run.json`, runRecord('interrupted'));
    put(root, 'recipes/tray.params.json', '{"width": 140}\n');
    const room = gatherRoom(context(root));
    const flow = room.all.find((r) => r.id === 'f0000c001')!;
    expect(flow.outputs.map((o) => o.path)).toEqual(['recipes/tray.params.json', 'results/flows/f0000c001.json']);
    expect(flow.missing).toEqual([{ role: 'agent result', path: `.timmy/agents/${RUN}/result.json`, words: 'not written' }]);
    const out = lines(roomItemLines(room, 'f0000c001', { glyphs, link: (rel) => `[${rel}]` }));
    expect(out).toMatch(new RegExp(`Missing {4}\\.timmy/agents/${RUN}/result\\.json: not written {2}agent result`));
    expect(out).not.toContain(`[.timmy/agents/${RUN}/result.json]`);
    const outputs = out.split('\n').filter((l) => /^ {2}(Outputs| {11}\[)/.test(l)).join('\n');
    expect(outputs).not.toContain('result.json');
    // The board: the missing file in words, in its own list, never a link; the summary counts it apart.
    const html = roomSection(room.view, kit({ live: false, base: '../../' })).html;
    expect(html).toContain(`outputs (2), 1 not there, and record`);
    expect(html).toContain(`<li class="room-missing"><span class="art-role">agent result</span> <span class="room-missing-path">.timmy/agents/${RUN}/result.json: not written</span></li>`);
    expect(html).not.toContain(`href="../../.timmy/agents/${RUN}/result.json"`);
    expect(html).toContain('href="../../recipes/tray.params.json"');
  });

  it('an agent run interrupted by recovery: its state in its record\'s words, its record an output, its result "none written", the receipt that seals its record', () => {
    const root = temp();
    const sha = json(root, `.timmy/agents/${RUN}/run.json`, runRecord('interrupted'));
    const pid = projectId(root);
    const recover = { v: 1, id: 'rc_1', stream: 'runs', ts: '2026-10-10T09:05:01.000Z', subject: 'FAKE recover', policy: 'human-gated', project: 'fake-room', project_id: pid, prev_hash: 'genesis',
      hash: `sha256_${'d'.repeat(64)}`, kind: 'recover', outputs: [{ path: `.timmy/agents/${RUN}/run.json`, sha256: sha, bytes: 1 }] } as unknown as Receipt;
    const run = gatherRoom(context(root, [recover])).all.find((r) => r.id === RUN)!;
    expect(run).toMatchObject({
      state: 'interrupted: its REPL ended while it ran; recovery stopped its process group 4242 (2 processes) with SIGTERM; no result was written',
      tone: 'attention', running: false, record: `.timmy/agents/${RUN}/run.json`, receipt: 'dddddddd', endedAt: '2026-10-10T09:05:00.000Z',
    });
    expect(run.outputs).toEqual([{ role: 'record', path: `.timmy/agents/${RUN}/run.json` }]);
    expect(run.missing).toBeUndefined();
    expect(run.handoff?.[1]).toMatchObject({ name: 'result', state: 'none written' });
    // A receipt that names other bytes (the record changed since) does not seal it.
    expect(sealedBy(root, `.timmy/agents/${RUN}/run.json`, [{ ...recover, outputs: [{ path: `.timmy/agents/${RUN}/run.json`, sha256: 'e'.repeat(64), bytes: 1 }] } as Receipt], pid)).toBeUndefined();
    // Its process found gone: when it ended is not recorded, so no end time or duration is shown.
    json(root, `.timmy/agents/${RUN}/run.json`, runRecord('interrupted', { why: 'its REPL ended while it ran, and its process is gone (when it ended is not recorded); no result was written', recovered: { ...runRecord('interrupted').recovered as object, process: 'gone', stopped: undefined } }));
    const gone = gatherRoom(context(root)).all.find((r) => r.id === RUN)!;
    expect(gone.state).toBe('interrupted: its REPL ended while it ran, and its process is gone (when it ended is not recorded); no result was written');
    expect(gone.endedAt).toBeUndefined();
    expect(gone.elapsed).toBeUndefined();
  });

  it('an agent run\'s files: one it added that is there, one deleted since, its transcript gone: only what is there is listed', () => {
    const root = temp();
    json(root, `.timmy/agents/${RUN}/result.json`, {
      ...runRecord('submitted'), state: undefined, ended_at: '2026-10-10T09:01:00.000Z', outcome: 'completed', why: 'FAKE',
      files: { added: [{ path: 'notes/kept.txt', size: 4, sha256: 'a'.repeat(64) }, { path: 'notes/deleted.txt', size: 4, sha256: 'b'.repeat(64) }], changed: [], deleted: [], truncated: false },
      transcript: 'transcript.log', cost_usd: 0, cost_basis: 'local endpoint',
    });
    put(root, 'notes/kept.txt', 'FAKE');
    put(root, 'notes/deleted.txt', 'FAKE');
    unlinkSync(join(root, 'notes/deleted.txt'));
    const run = gatherRoom(context(root)).all.find((r) => r.id === RUN)!;
    expect(run.outputs.map((o) => `${o.role} ${o.path}`)).toEqual(['added notes/kept.txt', `record .timmy/agents/${RUN}/result.json`]);
    expect(run.missing).toEqual([
      { role: 'added', path: 'notes/deleted.txt', words: 'not there' },
      { role: 'transcript', path: `.timmy/agents/${RUN}/transcript.log`, words: 'not there' },
    ]);
    const out = lines(roomItemLines(gatherRoom(context(root)), RUN, { glyphs }));
    expect(out).toMatch(/Missing {4}notes\/deleted\.txt: not there {2}added/);
    expect(out).toContain(`.timmy/agents/${RUN}/transcript.log: not there  transcript`);
  });
});
