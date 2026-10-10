/**
 * Round R4 (H55): the Project panel's own rules (companion/studio-canvas/src/project.js), run here in Node: what a placed
 * card holds, where "Open on the board" may lead, and what a refresh does to a placed card. The page itself runs in a real
 * Chromium in tests/studio-project-browser.test.ts.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the page's module is plain JavaScript, bundled for the browser
import { boardHref, cardMeta, cardText, GROUPS, placedMeta, refreshPlan, refreshWords } from '../companion/studio-canvas/src/project.js';

const project = { name: 'demo', id: 'abcdef0123456789' };
const card = { id: 'flow:f1a2b3c4d', kind: 'flow', title: '/iterate tray · f1a2b3c4d: wider', state: 'succeeded · verified', record: 'results/flows/f1a2b3c4d.json', receipt: '1a2b3c4d', command: '/room f1a2b3c4d', section: 'flows' };
const at = new Date('2026-10-10T05:40:00.000Z');

describe('the Project panel', () => {
  it('a placed card holds its title, state and command, one line each, and keeps its record and receipt in its meta (no board, no token)', () => {
    expect(cardText({ ...card, title: 'two\nlines' })).toBe('two lines\nsucceeded · verified\n/room f1a2b3c4d');
    const meta = cardMeta(card, project, at);
    expect(meta).toEqual({ v: 1, card: card.id, kind: 'flow', project: 'demo', projectId: project.id, title: card.title, state: card.state, command: card.command, record: card.record, receipt: card.receipt, section: 'flows', placedAt: at.toISOString() });
    expect(placedMeta({ meta: { timmyProjectCard: meta } })).toBe(meta);
    expect(placedMeta({ meta: {} })).toBeNull();
    expect(cardMeta({ ...card, section: 'javascript:alert(1)', record: null, receipt: undefined }, project, at)).toMatchObject({ section: null, record: null, receipt: null });
  });
  it("links only the live board's bare address on this machine, to the card's section", () => {
    expect(boardHref({ address: 'http://127.0.0.1:40123/' }, card)).toBe('http://127.0.0.1:40123/#flows');
    expect(boardHref({ address: `http://127.0.0.1:40123/#t=${'a'.repeat(64)}` }, card)).toBeNull();
    expect(boardHref({ address: 'http://evil.example:40123/' }, card)).toBeNull();
    expect(boardHref({ address: 'javascript:alert(1)//' }, card)).toBeNull();
    expect(boardHref(null, card)).toBeNull();
    expect(boardHref({ address: 'http://127.0.0.1:40123/' }, { ...card, section: 'x"onclick' })).toBe('http://127.0.0.1:40123/');
  });
  it('a refresh: unchanged writes nothing; a changed state gives new text; a record gone says so once; another project or none is left as it is', () => {
    const meta = cardMeta(card, project, at);
    const api = (cards: unknown[], p: unknown = project) => ({ project: p, cards });
    expect(refreshPlan(meta, api([card]), at)).toEqual({ action: 'same' });
    const failed = refreshPlan(meta, api([{ ...card, state: 'failed · not verified', receipt: null }]), at);
    expect(failed).toMatchObject({ action: 'update', text: `${card.title}\nfailed · not verified\n${card.command}`, meta: { state: 'failed · not verified', receipt: null, placedAt: at.toISOString(), refreshedAt: at.toISOString() } });
    const gone = refreshPlan(meta, api([]), at);
    expect(gone).toEqual({ action: 'gone', text: `${card.title}\nrecord gone: its record ${card.record} is not in demo now (checked 2026-10-10 05:40 UTC)\n${card.command}`, meta: { ...meta, gone: true, goneAt: at.toISOString() } });
    expect(refreshPlan((gone as { meta: Record<string, unknown> }).meta, api([]), at)).toEqual({ action: 'same' });
    // Back again: the note follows its record, and is no longer said to be gone.
    const back = refreshPlan((gone as { meta: Record<string, unknown> }).meta, api([card]), at) as { action: string; meta: Record<string, unknown> };
    expect(back.action).toBe('update');
    expect(back.meta.gone).toBeUndefined();
    expect(refreshPlan(meta, api([card], { name: 'other', id: 'ffffffffffffffff' }), at)).toEqual({ action: 'other', project: 'demo', now: 'other' });
    expect(refreshPlan(meta, { project: null, cards: [] }, at)).toEqual({ action: 'none' });
    expect(refreshWords({ same: 2, update: 1, gone: 1, other: 0, none: 0 })).toBe('4 placed cards checked: 1 changed, 1 record gone, 2 unchanged.');
    expect(refreshWords({ same: 0, update: 0, gone: 0, other: 0, none: 0 })).toBe('No project cards are placed on this canvas yet.');
  });
  it('shows the editable artifacts first, then the Control Room, then what cannot be read', () => {
    expect(GROUPS.map(([kind]: [string, string]) => kind)).toEqual(['workflow', 'params', 'flow', 'vox', 'run', 'unreadable']);
  });
});
