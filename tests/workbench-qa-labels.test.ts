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
import { destinationsRow } from '../src/workbench/destinations.js';
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

  it('defect 21: the help says grey (#8E8E93), never dim, and the destinations\' forms at the widths destinationsRow draws them', () => {
    const help = workbenchHelp();
    expect(help).toContain('one that cannot run now grey (#8E8E93;');
    expect(help).toContain('selected, it says why)');
    expect(help).not.toMatch(/\bdim\b/);
    expect(help).not.toMatch(/Under 120 columns/);
    // R11 round 7 (H177): the grouped destinations' forms, at the widths the help names
    expect(help).toContain('their names with their keys and the group names (from 176 columns)');
    expect(help).toContain('the rail\'s shorter names with keys (163), the short names with keys (134), the short names alone (114, so at 122)');
    expect(help).toContain('short names with a rule between the groups (100), or the keys alone with the shown destination\'s name (80)');
    const tabs = TABS.map((t) => ({ id: t.id, key: t.key, label: t.label, refs: t.refs, purpose: t.purpose, waiting: 0, ...(t.unfinished ? { unfinished: t.unfinished } : {}) }));
    const form = (width: number) => destinationsRow({ tabs, page: 'home', workspace: 'connections', width, g }).form;
    expect([form(180), form(176), form(175), form(163), form(162), form(134), form(133), form(122), form(114), form(113), form(100), form(99), form(80), form(60)])
      .toEqual(['full', 'full', 'wide', 'wide', 'short', 'short', 'words', 'words', 'words', 'rules', 'rules', 'keys', 'keys', 'keys']);
    // (the ten tabs' bar keeps its own forms; the frame no longer draws it)
    const bar = (w: number) => tabBar(tabs, 'home', 'tray1', w, 3, g).form;
    expect([bar(160), bar(155), bar(108)]).toEqual(['full', 'short', 'keys']);
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
