// R6 (H140; the operator's order of 2026-10-16, priority 2; the R5 interaction review's claim e): the one table of stop words.
// A chat turn is "stopped" and says who asked; a workflow job is "cancelled", the step a cancel ended is cancelled and the
// steps it never reached are "not run". Sealed receipts keep their stored values: only the words shown change.
import { describe, expect, it } from 'vitest';
import {
  JOB_CANCELLED, STEP_CANCELLED, STEP_NOT_RUN, STOP_MARK, TURN_NOT_ROLLED_BACK, TURN_STOPPED,
  jobStateWords, receiptSubjectWords, stepStateWords, surfaceName, turnEndWords, turnState, turnStopHead, turnStoppedWords,
} from '../src/contracts/stop-words.js';

describe('the table', () => {
  it('names a chat turn and a job differently, with one mark beside each word', () => {
    expect(TURN_STOPPED).toBe('stopped');
    expect(JOB_CANCELLED).toBe('cancelled');
    expect(STEP_CANCELLED).toBe('cancelled');
    expect(STEP_NOT_RUN).toBe('not run');
    expect(STOP_MARK).toBe('■');
    expect(TURN_NOT_ROLLED_BACK).toBe('what its tools did stands: nothing is rolled back');
  });
  it('reads a turn\'s sealed status: ok answered, cancelled stopped, anything else failed', () => {
    expect(turnState('ok')).toBe('answered');
    expect(turnState(undefined)).toBe('answered');
    expect(turnState('cancelled')).toBe('stopped');
    expect(turnState('error')).toBe('failed');
  });
});

describe('a stopped chat turn says who asked', () => {
  it('another surface that asked (stopped_by), else the surface that sent it; "by you" on the surface that asked', () => {
    expect(turnStoppedWords({ surface: 'repl', stoppedBy: 'companion' })).toBe('stopped (asked from the companion)');
    expect(turnStoppedWords({ surface: 'workbench' })).toBe('stopped (asked from the Workbench)');
    expect(turnStoppedWords({ surface: 'repl', stoppedBy: 'unknown' })).toBe('stopped (asked from another surface)');
    expect(turnStoppedWords({ surface: 'repl' }, 'repl')).toBe('stopped by you');
    expect(turnStoppedWords({ surface: 'repl', stoppedBy: 'companion' }, 'companion')).toBe('stopped by you');
    // the REPL, showing a turn the companion stopped, never says "by you"
    expect(turnStoppedWords({ surface: 'repl', stoppedBy: 'companion' }, 'repl')).toBe('stopped (asked from the companion)');
    expect(turnEndWords({ state: 'answered', surface: 'repl' })).toBe('answered');
    expect(turnEndWords({ state: 'failed', surface: 'repl' })).toBe('failed');
    expect(surfaceName('monitor')).toBe('the monitor');
  });
  it('the REPL\'s line: "Stopped by you." or "Stopped, asked from …", never "Cancelled"', () => {
    expect(turnStopHead()).toBe('Stopped by you.');
    expect(turnStopHead('the companion')).toBe('Stopped, asked from the companion.');
    expect(`${turnStopHead()} ${turnStopHead('x')}`).not.toMatch(/cancel/i);
  });
});

describe('a job is cancelled; its steps cancelled or not run', () => {
  it('a job record\'s state and a step\'s', () => {
    expect(jobStateWords('cancelled')).toBe('cancelled');
    expect(jobStateWords('completed')).toBe('completed');
    expect(stepStateWords('stopped')).toBe('cancelled');
    expect(stepStateWords('interrupted')).toBe('interrupted');
    expect(stepStateWords('not run')).toBe('not run');
  });
});

describe('a receipt\'s subject as shown (the receipt itself is never changed)', () => {
  it('a stopped chat turn\'s sealed "cancelled" is said "stopped (asked from …)"; a job\'s "cancelled" stays', () => {
    const repl = { kind: 'turn', subject: 'repl · cancelled · 0 steps', status: 'cancelled' };
    expect(receiptSubjectWords(repl)).toBe('repl · stopped (asked from the REPL) · 0 steps');
    expect(repl.subject).toBe('repl · cancelled · 0 steps');
    expect(receiptSubjectWords({ kind: 'chat', subject: 'chat.turn · workbench · cancelled · 0 steps · qwen3:8b', status: 'cancelled', stopped_by: 'companion' }))
      .toBe('chat.turn · workbench · stopped (asked from the companion) · 0 steps · qwen3:8b');
    // an answered turn, a job, a block and a flow keep their sealed words
    expect(receiptSubjectWords({ kind: 'chat', subject: 'chat.turn · workbench · 0 steps · qwen3:8b', status: 'ok' })).toBe('chat.turn · workbench · 0 steps · qwen3:8b');
    expect(receiptSubjectWords({ kind: 'workflow', subject: 'workflow · LONG.md › wait · cancelled', status: 'cancelled' })).toBe('workflow · LONG.md › wait · cancelled');
    expect(receiptSubjectWords({ kind: 'flow', subject: 'flow · iterate · scad · f1 · cancelled', status: 'cancelled' })).toBe('flow · iterate · scad · f1 · cancelled');
    expect(receiptSubjectWords({ kind: 'workflow-block', subject: 'workflow · block · LONG.md › wait · wait · interrupted' })).toBe('workflow · block · LONG.md › wait · wait · interrupted');
  });
});
