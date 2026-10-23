// R5 (H131; the QA of the installed build e7f853e, defects 20, 21 and 24): what three labels say, read from the code that draws
// them. Pure: no terminal, no network, no file written.
// - defect 20: Home's OpenRouter card says free-only first, on or off, as the workspace frame's detail has it;
// - defect 21: `timmy workbench --help` says a disabled action is grey (#8E8E93), never "dim", and the widths at which the tabs
//   change form are the ones tabBar draws (measured here with a short project name);
// - defect 24: the run detail's durations are labelled: the job's or the turn's own, and the operation's, with the time
//   between them said for what it holds (never said to be a wait on you, which no record keeps apart).
// FAKE here: the connections and run times are made in this test (no check ran; no job or operation ran).
import { describe, expect, it } from 'vitest';
import { TABS, type WorkspaceConnection } from '../src/contracts/workspace.js';
import { workbenchHelp } from '../src/workbench/cli.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { connectionCard, freeOnlyOf, tabBar, tookWords } from '../src/workbench/hub.js';
import type { ViewCtx } from '../src/workbench/views.js';

const g = glyphsFor(true);
const cardText = (conn: WorkspaceConnection): string => connectionCard(conn, false, false, 70, { g } as unknown as ViewCtx).map((l) => l.map((s) => s.text).join('')).join('\n').replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
const FAKE_OR = (detail?: string): WorkspaceConnection => ({ id: 'openrouter', label: 'OpenRouter', state: 'live', words: 'FAKE: answered 2 min ago', observedAt: '2026-10-16T07:00:00.000Z', setup: 'timmy init --openrouter -', ...(detail ? { detail } : {}) });

describe('the QA of e7f853e: three labels (R5 H131)', () => {
  it('defect 20: Home\'s OpenRouter card says free-only on or off first, from the frame\'s detail, and says it once', () => {
    const on = FAKE_OR('key from settings; free-only on (a model not known to be free is refused)');
    expect(freeOnlyOf(on)).toBe('on');
    const onText = cardText(on);
    expect(onText).toContain('free-only on: a model not known to be free is refused');
    expect(onText).toContain('key from settings');
    expect(onText.match(/free-only on/g)).toHaveLength(1);
    const off = FAKE_OR('key from settings');
    expect(freeOnlyOf(off)).toBe('off');
    expect(cardText(off)).toContain('free-only off: a paid model can be asked');
    // with no key the frame says neither, and nor does the card; another connection never says it
    expect(freeOnlyOf(FAKE_OR())).toBeNull();
    expect(cardText(FAKE_OR())).not.toContain('free-only');
    expect(freeOnlyOf({ id: 'ollama', detail: 'key from settings' })).toBeNull();
  });

  it('defect 21: the help says grey (#8E8E93), never dim, and the tab forms at the widths tabBar draws them', () => {
    const help = workbenchHelp();
    expect(help).toContain('one that cannot run now grey (#8E8E93; selected, it says why)');
    expect(help).not.toMatch(/\bdim\b/);
    expect(help).not.toMatch(/Under 120 columns/);
    expect(help).toContain('full labels at 156 columns or more, short labels at 109 to');
    expect(help).toContain('155 (120 among them) and keys at 108 or fewer (100 among them)');
    // the numbers, as tabBar draws row 1 for a project named tray1
    const tabs = TABS.map((t) => ({ id: t.id, key: t.key, label: t.label, refs: t.refs, purpose: t.purpose, waiting: 0 }));
    const form = (w: number) => tabBar(tabs, 'home', 'tray1', w, 3, g).form;
    expect([form(160), form(156), form(155), form(120), form(109), form(108), form(100)]).toEqual(['full', 'full', 'short', 'short', 'short', 'keys', 'keys']);
  });

  it('defect 24: the job\'s or the turn\'s own time and the operation\'s, each labelled; what lies between is not said to be a wait on you', () => {
    const ended = { startedAt: '2026-10-16T07:00:00.000Z', endedAt: '2026-10-16T07:00:01.600Z', elapsedMs: 1600 };
    expect(tookWords(ended, { kind: 'job', ms: 400 })).toBe('job ran 0.4 s · operation took 1.6 s, 1.2 s of it around the job (its prediction, any wait on you, its receipts: not recorded apart)');
    expect(tookWords(ended, { kind: 'turn', ms: 1550 })).toBe('turn took 1.6 s · operation took 1.6 s');
    expect(tookWords(ended)).toBe('operation took 1.6 s');
    expect(tookWords({ startedAt: ended.startedAt, endedAt: null, elapsedMs: 5000 }, { kind: 'job', ms: 4000, running: true })).toBe('job running for 4.0 s · operation running for 5.0 s');
    expect(tookWords({ startedAt: null, endedAt: null, elapsedMs: null }, { kind: 'job', ms: null })).toBe('the operation\'s time is not recorded');
    expect(tookWords(ended, { kind: 'job', ms: 400 })).not.toMatch(/of it waiting on you/);
  });
});
