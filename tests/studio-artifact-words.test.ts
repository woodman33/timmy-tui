/**
 * R7 (H151; H148's R6 finding N5, REMAINING-DEFECTS row 8): Studio's Artifacts says an operation's state in the shared words
 * (src/contracts/stop-words.ts): a stop that ended a job is the job's word, "cancelled" (JOB_CANCELLED), its runs' words too
 * ("job j… cancelled"); a chat turn's operation keeps "stopped" (the turn's word), as the lead's src/ops/run-detail.ts stopKind
 * rules it. H148 saw Studio's Artifacts list a cancelled job's operation as "stopped". The operation records here are FAKE
 * (written by this test into a temporary project, in the record's own schema).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { JOB_CANCELLED, TURN_STOPPED } from '../src/contracts/stop-words.js';
import { OPERATION_SCHEMA, OPERATIONS_DIR } from '../src/ops/operations.js';
import { runRows, runStateWords } from '../src/studio/artifacts.js';

const root = mkdtempSync(join(tmpdir(), 'timmy-artifact-words-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A FAKE operation record, in its own schema. */
function record(id: string, o: { state: string; why: string; runs?: Array<{ kind: string; id: string }>; started: string; request?: string }): void {
  mkdirSync(join(root, OPERATIONS_DIR), { recursive: true });
  writeFileSync(join(root, OPERATIONS_DIR, `${id}.json`), `${JSON.stringify({
    schema: OPERATION_SCHEMA, id, request: o.request ?? `FAKE request ${id}`, via: 'repl', project: '.', started: o.started, ended: o.started, state: o.state, why: o.why,
    parent: null, runs: (o.runs ?? []).map((r) => ({ ...r, at: o.started })), owner: { pid: 1, started: o.started },
  }, null, 2)}\n`);
}

describe("Studio's Artifacts: an operation's state in the shared job and turn words (R7 H151)", () => {
  it('a cancelled job\'s operation says cancelled, its job "cancelled" too; a chat turn\'s stays stopped; other states as recorded', () => {
    record('o0000aaa1', { state: 'stopped', why: 'job jb0cc98 stopped', runs: [{ kind: 'job', id: 'jb0cc98' }], started: '2026-10-16T21:00:00.000Z' });
    record('o0000aaa2', { state: 'stopped', why: "the REPL's chat turn was stopped (receipt 1a2b3c4d)", started: '2026-10-16T21:01:00.000Z' });
    record('o0000aaa3', { state: 'succeeded', why: 'job jb0cc99 done: 1 of 1 step', runs: [{ kind: 'job', id: 'jb0cc99' }], started: '2026-10-16T21:02:00.000Z' });
    record('o0000aaa4', { state: 'stopped', why: 'stopped: the person asked /stop; flow f0a1b2c3d stopped', runs: [{ kind: 'flow', id: 'f0a1b2c3d' }], started: '2026-10-16T21:03:00.000Z' });
    const { rows } = runRows({ root });
    const state = (id: string): string => rows.find((r) => r.id === `run:${id}`)!.state;
    expect(state('o0000aaa1')).toBe(`${JOB_CANCELLED} · job jb0cc98 ${JOB_CANCELLED} · 1 run`);
    expect(state('o0000aaa2')).toBe(`${TURN_STOPPED} · the REPL's chat turn was stopped (receipt 1a2b3c4d)`);
    expect(state('o0000aaa3')).toBe('succeeded · job jb0cc99 done: 1 of 1 step · 1 run');
    expect(state('o0000aaa4')).toBe(`${JOB_CANCELLED} · ${JOB_CANCELLED}: the person asked /stop; flow f0a1b2c3d ${JOB_CANCELLED} · 1 run`);
    // nothing of a cancelled job's row says "stopped"
    expect(state('o0000aaa1')).not.toMatch(/stopped/);
  });

  it('the rule on its own: the stop of an operation that ran a job (any run) is the job\'s cancel; with no run, a chat turn\'s stop', () => {
    expect(runStateWords({ state: 'stopped', why: 'job j1234567 stopped', runs: [{ kind: 'job', id: 'j1234567', at: '' }] })).toBe(`${JOB_CANCELLED} · job j1234567 ${JOB_CANCELLED}`);
    expect(runStateWords({ state: 'stopped', why: "the Workbench's chat turn was stopped (receipt 0badc0de)", runs: [] })).toBe(`${TURN_STOPPED} · the Workbench's chat turn was stopped (receipt 0badc0de)`);
    expect(runStateWords({ state: 'stopped', runs: [{ kind: 'native', id: 'n1', at: '' }] })).toBe(JOB_CANCELLED);
    expect(runStateWords({ state: 'failed', why: 'job j1 failed', runs: [{ kind: 'job', id: 'j1', at: '' }] })).toBe('failed · job j1 failed');
    // a record that already says cancelled stays so
    expect(runStateWords({ state: 'stopped', why: `job j7654321 ${JOB_CANCELLED}`, runs: [{ kind: 'job', id: 'j7654321', at: '' }] })).toBe(`${JOB_CANCELLED} · job j7654321 ${JOB_CANCELLED}`);
  });
});
