// R6 (H140; the operator's order of 2026-10-16, priority 2; the R5 interaction review, claim e): every surface takes its stop
// words from the one table (src/contracts/stop-words.ts): the REPL's cancel line and turn footer, `timmy receipts`, the board's
// chat-turn card and job word, the Workbench's Control Room and Workflows tab, `timmy op`, the Workbench's quit line and the
// frame. Each surface's own renderer is driven here with FAKE records (no model, no job ran) and its words compared with the
// table's.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JOB_CANCELLED, STEP_CANCELLED, STOP_MARK, TURN_STOPPED, receiptSubjectWords, turnEndWords, turnStopHead, turnStopStage, turnStoppedWords,
} from '../src/contracts/stop-words.js';
import { detectCapabilities } from '../src/term/capabilities.js';
import { LiveRegion } from '../src/term/live-region.js';
import { buildTheme } from '../src/term/theme.js';
import { Transcript } from '../src/repl/transcript.js';
import { showReceipts } from '../src/repl/follow.js';
import { gatherRoom } from '../src/room/index.js';
import { turnEndWords as workbenchTurnEndWords } from '../src/workbench/hub.js';
import { runWord, stateMark } from '../src/workbench/workflows-tab.js';
import { verdictWord } from '../src/ops/op-cli.js';
import { turnOf } from '../src/ops/workspace-frame.js';
import { projectId } from '../src/project/index.js';
import { projectCards } from '../src/studio/project-cards.js';
import type { Receipt } from '../src/utils/receipts.js';

class Sink { writes: string[] = []; constructor(public isTTY: boolean, public columns = 100) {} write(s: string) { this.writes.push(s); return true; } get text() { return this.writes.join(''); } }
const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, stdin: { isTTY: false }, stdout: { isTTY: false, columns: 100, rows: 24 }, stderr: { isTTY: false } });
const theme = buildTheme(caps);

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'h140-stop-surfaces-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('a chat turn is "stopped", with who asked, on every surface', () => {
  it('the REPL: its cancel line and its turn footer', () => {
    for (const by of [undefined, 'the companion']) {
      const out = new Sink(false);
      const t = new Transcript(theme, new LiveRegion({ out, err: new Sink(false) }, { live: false }), { columns: 100 });
      t.handle({ type: 'cancelled', at: 'before-tools', tools: [], ...(by ? { by } : {}) });
      t.handle({ type: 'receipt', id: 'c4ace1ed', verified: true, lanes: 0, steps: 0, spend: 'cost unknown', seconds: 1.5, cancelled: true });
      t.endTurn();
      expect(out.text).toContain(`  ${turnStopHead(by)} No tool had started.`);
      expect(out.text).toContain(`0 steps · cost unknown · 1.5s · ${TURN_STOPPED}`);
      expect(out.text).not.toMatch(/cancel/i);
    }
  });
  it('timmy receipts: a stopped turn\'s subject with who asked; a job\'s "cancelled" as sealed', async () => {
    const chain = [
      { hash: `sha256:${'a'.repeat(64)}`, kind: 'turn', subject: 'repl · cancelled · 0 steps', status: 'cancelled', stopped_by: 'companion', ts: '2026-10-16T10:22:00.000Z' },
      { hash: `sha256:${'b'.repeat(64)}`, kind: 'chat', subject: 'chat.turn · workbench · cancelled · 0 steps · qwen3:8b', status: 'cancelled', ts: '2026-10-16T10:23:00.000Z' },
      { hash: `sha256:${'c'.repeat(64)}`, kind: 'workflow', subject: 'workflow · LONG.md › wait · cancelled', status: 'cancelled', ts: '2026-10-16T10:25:00.000Z' },
    ] as unknown as Receipt[];
    const lines: string[] = [];
    await showReceipts({ follow: false, last: 10, theme, write: (l) => lines.push(l), read: () => chain, verify: () => ({ ok: true, count: 3 }) });
    const text = lines.join('\n');
    for (const r of chain) expect(text).toContain(receiptSubjectWords(r));
    expect(text).toContain('repl · stopped (asked from the companion) · 0 steps');
    expect(text).toContain('chat.turn · workbench · stopped (asked from the Workbench) · 0 steps · qwen3:8b');
    expect(text).toContain('workflow · LONG.md › wait · cancelled');
  });
  it('the board\'s chat-turn card (the Control Room on the board): stopped, who asked, and where the stop came', () => {
    const pid = projectId(root);
    const chain = [{ kind: 'turn', subject: 'repl · cancelled · 1 step', status: 'cancelled', stopped_by: 'companion', cancelled_at: 'during-tool', rollback: 'none', project_id: pid, ts: '2026-10-16T10:22:00.000Z', ms: 900, hash: `sha256_${'d'.repeat(64)}` }] as unknown as Receipt[];
    const { view } = gatherRoom({ root, project: 'p', projectId: pid, jobs: [], chain, mine: () => false, activeFlows: [], scrub: (t) => t });
    const chat = view.groups.find((g) => g.kind === 'chat')!;
    expect(chat.recent.map((r) => r.state)).toEqual([`${turnStoppedWords({ surface: 'repl', stoppedBy: 'companion' })}, ${turnStopStage('during-tool')}`]);
    expect(chat.recent[0].state).toBe('stopped (asked from the companion), while a tool ran');
  });
  it('the Workbench\'s Control Room and the frame: the table\'s words, who asked always said', () => {
    for (const t of [{ state: 'stopped' as const, surface: 'repl', stoppedBy: 'companion' }, { state: 'stopped' as const, surface: 'workbench' }, { state: 'stopped' as const, surface: 'repl' }, { state: 'answered' as const, surface: 'repl' }]) {
      expect(workbenchTurnEndWords(t)).toBe(turnEndWords(t, 'workbench'));
    }
    // the Workbench's own stop is "by you" there (as its chat pane says it); a stop asked elsewhere names where
    expect(workbenchTurnEndWords({ state: 'stopped', surface: 'workbench' })).toBe('stopped by you');
    expect(workbenchTurnEndWords({ state: 'stopped', surface: 'repl' })).toBe('stopped (asked from the REPL)');
    expect(workbenchTurnEndWords({ state: 'stopped', surface: 'workbench', stoppedBy: 'companion' })).toBe('stopped (asked from the companion)');
    const words = turnOf({ receipt: 'e0e0e0e0', surface: 'repl', state: 'stopped', model: 'FAKE', at: '2026-10-16T10:22:00.000Z', operation: null, stoppedBy: 'workbench' } as never).words;
    expect(words.startsWith(`turn ${turnEndWords({ state: 'stopped', surface: 'repl', stoppedBy: 'workbench' })} in the REPL`)).toBe(true);
  });
});

describe('a workflow job is "cancelled"; the step a cancel ended is cancelled', () => {
  it('the Workbench\'s Workflows tab: the run\'s word and its mark', () => {
    expect(runWord({ kind: 'workflow', state: 'cancelled', steps: [] } as never)).toBe(JOB_CANCELLED);
    expect(stateMark(JOB_CANCELLED, { unicode: true, ok: '✓', fail: '✕', next: '▶', ellipsis: '…', dot: '·', warn: '⚠' }).glyph).toBe(STOP_MARK);
    expect(stateMark(STEP_CANCELLED, { unicode: true, ok: '✓', fail: '✕', next: '▶', ellipsis: '…', dot: '·', warn: '⚠' }).glyph).toBe(STOP_MARK);
  });
  it('the board\'s Control Room: a job a cancel ended reads "cancelled"', () => {
    const job = { id: 'j0c0ffee', kind: 'workflow', label: 'LONG.md › wait', command: 'upmd', args: [], state: 'cancelled', startedAt: '2026-10-16T10:25:00.000Z', endedAt: '2026-10-16T10:25:06.000Z', root, steps: [{ name: 'wait', state: 'stopped' }] };
    const { view } = gatherRoom({ root, project: 'p', projectId: projectId(root), jobs: [job as never], chain: [], mine: () => false, activeFlows: [], scrub: (t) => t });
    const runs = view.groups.flatMap((g) => [...g.running, ...g.recent]).filter((r) => r.id === 'j0c0ffee');
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r.state).toMatch(new RegExp(`^${JOB_CANCELLED}\\b`));
  });
  it('Studio\'s Board: a run card reads the Control Room\'s words: a stopped chat turn with who asked, a cancelled job', () => {
    const pid = projectId(root);
    const chain = [{ kind: 'turn', subject: 'repl · cancelled · 0 steps', status: 'cancelled', stopped_by: 'workbench', cancelled_at: 'before-tools', rollback: 'none', project_id: pid, ts: '2026-10-16T10:22:00.000Z', ms: 700, hash: `sha256_${'e'.repeat(64)}` }] as unknown as Receipt[];
    const job = { id: 'j0dec0de', kind: 'workflow', label: 'LONG.md › wait', command: 'upmd', args: [], state: 'cancelled', startedAt: '2026-10-16T10:25:00.000Z', endedAt: '2026-10-16T10:25:06.000Z', root, steps: [{ name: 'wait', state: 'stopped' }] };
    const runs = projectCards({ root, name: 'p', jobs: null, receipts: null }, { chain, jobs: [job as never] }).cards.filter((k) => k.kind === 'run');
    const turn = runs.find((k) => k.id.startsWith('run:chat:'));
    const cancelled = runs.find((k) => k.id === 'run:job:j0dec0de');
    expect(turn?.state.startsWith(`${turnStoppedWords({ surface: 'repl', stoppedBy: 'workbench' })}, ${turnStopStage('before-tools')}`)).toBe(true);
    expect(cancelled?.state.startsWith(JOB_CANCELLED)).toBe(true);
  });
  it('timmy op: an operation whose chat turn was stopped says stopped; one whose job was cancelled, cancelled', () => {
    const verdict = { state: 'cancelled' as const, words: 'stopped: FAKE', from: 'FAKE' };
    expect(verdictWord({ verdict, receipts: [{ id: 'f3617a98', kind: 'chat' }], exits: [] })).toBe(TURN_STOPPED);
    expect(verdictWord({ verdict, receipts: [{ id: '09ee7465', kind: 'workflow' }], exits: [{ who: 'upmd', code: null, from: 'FAKE' }] })).toBe(JOB_CANCELLED);
    expect(verdictWord({ verdict: { ...verdict, state: 'completed' }, receipts: [], exits: [] })).toBe('completed');
  });
});
