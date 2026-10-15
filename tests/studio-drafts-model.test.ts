/**
 * R5 (H133): Timmy Canvas's rules for drafts and for the save line (companion/studio-canvas/src/drafts.js and save-state.js), run
 * here in Node on store records written by hand (FIXTURES in tldraw's record shape: no editor runs here; the real page is
 * exercised in Chromium by tests/studio-drafts-browser.test.ts and tests/studio-save-browser.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { acceptPlan, decisionWords, discardPlan, documentChanges, DRAFT_LABEL, draftLine, draftMark, draftOf, draftRefusal, followed, pendingDrafts, remarkPlan, staleWords } from '../companion/studio-canvas/src/drafts.js';
import { SAVE_GLYPH, saveState } from '../companion/studio-canvas/src/save-state.js';

type Rec = Record<string, unknown> & { id: string; typeName: string };
const D1 = 'draft-0a1b2c3d4e5f';
const D2 = 'draft-ffeeddccbbaa';
const mark = (id: string, from = 3, job = 'turn-1', at = '2026-10-15T20:00:00.000Z') => ({ timmyDraft: { id, job, from, at } });
const shape = (id: string, o: Partial<Rec> = {}): Rec => ({ id, typeName: 'shape', type: 'geo', parentId: 'page:p1', x: 0, y: 0, props: { w: 10, h: 10 }, meta: {}, ...o });
const page = (id: string): Rec => ({ id, typeName: 'page', name: id, meta: {} });
const store = (...records: Rec[]): Record<string, Rec> => Object.fromEntries(records.map((r) => [r.id, r]));

describe('a draft mark', () => {
  it('is read only in its own shape: an id the server makes, with its job, the revision it was made from, and when', () => {
    expect(draftOf(shape('shape:a', { meta: mark(D1) }))).toEqual({ id: D1, job: 'turn-1', from: 3, at: '2026-10-15T20:00:00.000Z' });
    for (const meta of [{}, { timmyDraft: null }, { timmyDraft: { id: 'draft-XYZ' } }, { timmyDraft: { id: '"); alert(1); ("' } }, { timmyDraft: 'draft-0a1b2c3d' }]) {
      expect(draftOf(shape('shape:a', { meta })), JSON.stringify(meta)).toBeNull();
    }
    expect(draftMark({ id: D1, job: 'turn-9', from: 7, at: 'now' })).toEqual({ id: D1, job: 'turn-9', from: 7, at: 'now' });
    expect(() => draftMark({ id: 'not-a-draft', from: 1 })).toThrow(/Not a draft id/);
  });
  it('groups pending drafts by id, with their shapes, pages and assets, oldest first; a draft whose shapes are all gone is not pending', () => {
    const records = [
      page('page:p1'), page('page:p2'),
      shape('shape:frame', { type: 'frame', meta: mark(D2, 5, 'turn-2', '2026-10-15T21:00:00.000Z') }),
      shape('shape:inside', { parentId: 'shape:frame', meta: mark(D2, 5, 'turn-2', '2026-10-15T21:00:00.000Z') }),
      shape('shape:a', { meta: mark(D1) }),
      shape('shape:b', { parentId: 'page:p2', meta: mark(D1) }),
      shape('shape:mine'),
      { id: 'asset:img', typeName: 'asset', type: 'image', props: {}, meta: mark(D1) },
      { id: 'asset:orphan', typeName: 'asset', type: 'image', props: {}, meta: mark('draft-000000000000') },
    ];
    expect(pendingDrafts(records)).toEqual([
      { id: D1, job: 'turn-1', from: 3, at: '2026-10-15T20:00:00.000Z', shapes: ['shape:a', 'shape:b'], pages: ['page:p1', 'page:p2'], assets: ['asset:img'] },
      { id: D2, job: 'turn-2', from: 5, at: '2026-10-15T21:00:00.000Z', shapes: ['shape:frame', 'shape:inside'], pages: ['page:p1'], assets: [] },
    ]);
    expect(draftLine(pendingDrafts(records)[0])).toBe(`${DRAFT_LABEL} · 2 shapes · job turn-1 · from revision 3`);
    expect(DRAFT_LABEL).toBe('DRAFT · proposed by Timmy');
  });
});

describe('a draft only adds', () => {
  const before = store(page('page:p1'), shape('shape:mine'), shape('shape:proposed', { meta: mark(D1) }), { id: 'binding:old', typeName: 'binding', type: 'arrow', fromId: 'shape:proposed', toId: 'shape:mine', props: {}, meta: {} });
  it('takes new shapes, bindings (to the board\'s shapes too) and assets', () => {
    const after = { ...before, 'shape:new': shape('shape:new', { meta: mark(D2) }), 'binding:new': { id: 'binding:new', typeName: 'binding', type: 'arrow', fromId: 'shape:new', toId: 'shape:mine', props: {}, meta: {} }, 'asset:new': { id: 'asset:new', typeName: 'asset', type: 'image', props: {}, meta: {} } } as Record<string, Rec>;
    const changes = documentChanges(before, after);
    expect(changes).toEqual({ created: ['shape:new', 'binding:new', 'asset:new'], changed: [], removed: [] });
    expect(draftRefusal(changes, before, after)).toBeNull();
  });
  it('may arrange a pending draft of its own (move it, remove its arrow), never the board\'s own shapes', () => {
    const moved = { ...before, 'shape:proposed': { ...before['shape:proposed'], x: 40 } } as Record<string, Rec>;
    delete moved['binding:old'];
    expect(draftRefusal(documentChanges(before, moved), before, moved)).toBeNull();
    const mine = { ...before, 'shape:mine': { ...before['shape:mine'], x: 40 } } as Record<string, Rec>;
    expect(draftRefusal(documentChanges(before, mine), before, mine)).toBe('Refused: a draft only adds to the board, and it changed or removed 1 record already on the board (shape:mine). Nothing was kept. Propose new shapes as a draft; to change the board\'s own shapes, ask the person, or run the call without draft (it asks them first in Timmy).');
    const gone = { ...before } as Record<string, Rec>;
    delete gone['shape:mine'];
    expect(draftRefusal(documentChanges(before, gone), before, gone)).toMatch(/changed or removed 1 record already on the board \(shape:mine\)/);
  });
  it('adds no page, and ignores what is not the document (the camera, the selection)', () => {
    const paged = { ...before, 'page:p2': page('page:p2'), 'camera:x': { id: 'camera:x', typeName: 'camera', x: 9 } } as Record<string, Rec>;
    expect(draftRefusal(documentChanges(before, paged), before, paged)).toMatch(/it added 1 page, which a draft does not/);
    const viewed = { ...before, 'instance_page_state:x': { id: 'instance_page_state:x', typeName: 'instance_page_state', selectedShapeIds: ['shape:mine'] } } as Record<string, Rec>;
    expect(documentChanges(before, viewed)).toEqual({ created: [], changed: [], removed: [] });
  });
  it("never counts a drawn card following its record (the page's own reading, which can land while a call awaits)", () => {
    const card = shape('shape:card', { type: 'timmy-workflow', props: { w: 380, h: 200, card: 'workflow:RUN.md', data: { a: 1 }, readAt: 't1', title: 'Run', gone: false } });
    const read = { ...card, props: { ...card.props as object, data: { a: 2 }, readAt: 't2', h: 240 } };
    expect(followed(card, read)).toBe(true);
    expect(followed(card, { ...read, x: 5 })).toBe(false);
    expect(followed(card, { ...card, props: { ...card.props as object, card: 'workflow:OTHER.md' } })).toBe(false);
    expect(followed(shape('shape:g'), { ...shape('shape:g'), props: { w: 10, h: 99 } })).toBe(false);
    const b = store(card);
    const a = store(read as Rec);
    expect(draftRefusal(documentChanges(b, a), b, a)).toBeNull();
  });
  it('puts its mark back on whatever the call created without it (code that stripped the mark lands nothing unreviewed)', () => {
    const m = draftMark({ id: D1, job: 'turn-1', from: 3, at: 'then' });
    const created = [shape('shape:kept', { meta: { timmyDraft: m } }), shape('shape:stripped', { meta: { other: 1 } }), shape('shape:moved', { meta: mark(D2) }), { id: 'asset:a', typeName: 'asset', meta: {} }, { id: 'binding:b', typeName: 'binding', meta: {} }, undefined];
    expect(remarkPlan(created as Rec[], m).map((r) => [r.id, (r.meta as Record<string, unknown>).timmyDraft, (r.meta as Record<string, unknown>).other])).toEqual([
      ['shape:stripped', m, 1], ['shape:moved', m, undefined], ['asset:a', m, undefined],
    ]);
  });
  it('says plainly when a draft was made from a revision the canvas has left', () => {
    expect(staleWords(4, 9)).toBe('Refused: this draft was made from revision 4, but the canvas is at revision 9 now: it changed after Timmy read it. Nothing was drawn. Read the canvas again (canvas_read), then propose again.');
  });
});

describe('Accept and Discard', () => {
  const records: Rec[] = [
    page('page:p1'),
    shape('shape:frame', { type: 'frame', meta: { ...mark(D1), timmyJob: 'turn-1' } }),
    shape('shape:child', { parentId: 'shape:frame', meta: mark(D1) }),
    shape('shape:yours', { parentId: 'shape:frame' }),
    shape('shape:img', { type: 'image', props: { assetId: 'asset:img', w: 1, h: 1 }, meta: mark(D1) }),
    shape('shape:other', { meta: mark(D2) }),
    shape('shape:mine', { type: 'image', props: { assetId: 'asset:shared', w: 1, h: 1 } }),
    { id: 'asset:img', typeName: 'asset', type: 'image', props: {}, meta: mark(D1) },
    { id: 'asset:shared', typeName: 'asset', type: 'image', props: {}, meta: mark(D1) },
  ];
  it('Accept clears the mark on everything the draft marks, keeps the rest of its meta, and says who proposed it', () => {
    const plan = acceptPlan(records, D1, '2026-10-15T22:00:00.000Z');
    expect(plan.map((r) => r.id)).toEqual(['shape:frame', 'shape:child', 'shape:img', 'asset:img', 'asset:shared']);
    for (const r of plan) {
      expect(draftOf(r), r.id).toBeNull();
      expect((r.meta as Record<string, unknown>).timmyProposed).toEqual({ by: 'Timmy', draft: D1, job: 'turn-1', accepted: '2026-10-15T22:00:00.000Z' });
    }
    expect((plan[0].meta as Record<string, unknown>).timmyJob).toBe('turn-1');
    expect(plan[0]).toMatchObject({ x: 0, y: 0, type: 'frame', parentId: 'page:p1' });
  });
  it('Discard removes the draft\'s shapes (the top of each), moves the person\'s own shapes out first, and its assets no other shape shows', () => {
    expect(discardPlan(records, D1)).toEqual({
      shapes: ['shape:frame', 'shape:img'],
      all: ['shape:frame', 'shape:child', 'shape:img'],
      keepOut: { 'shape:yours': 'page:p1' },
      assets: ['asset:img'],
    });
    expect(discardPlan(records, D2)).toEqual({ shapes: ['shape:other'], all: ['shape:other'], keepOut: {}, assets: [] });
  });
  it('says what was decided, that nothing ran, and whether its save is on disk yet', () => {
    const d = { shapes: ['a', 'b'], job: 'turn-1' };
    expect(decisionWords('accepted', d, { revision: 12 })).toBe("Accepted Timmy's draft (2 shapes, job turn-1): kept on the board; saved at revision 12 and recorded. No tool or job ran.");
    expect(decisionWords('discarded', { count: 1, job: null }, null)).toBe("Discarded Timmy's draft (1 shape): removed from the board; not saved yet (the save line says why). No tool or job ran.");
  });
});

describe('a drawn card Timmy proposed as a draft', () => {
  it('is a diagram until a person accepts it: nothing on it acts, and it says so (companion/studio-canvas/src/cards.js cardMode)', async () => {
    const { cardMode } = await import('../companion/studio-canvas/src/cards.js');
    // a reading in which the same card, without the mark, is executable (FIXTURE: the shape of GET /api/project?detail=1)
    const props = { project: 'demo', projectId: 'a1b2c3d4e5f60718', card: 'workflow:RUN.md' };
    const answer = { project: { id: 'a1b2c3d4e5f60718', name: 'demo' }, cards: [{ id: 'workflow:RUN.md', detail: {} }], detail: true, actions: { holder: true } };
    expect(cardMode('workflow', props, answer, true)).toMatchObject({ executable: true });
    expect(cardMode('workflow', props, answer, true, {})).toMatchObject({ executable: true });
    expect(cardMode('workflow', props, answer, true, mark(D1))).toEqual({ executable: false, badge: 'diagram', follows: false, draft: true, words: "A draft proposed by Timmy: nothing on it acts until you accept it in Timmy's panel (Drafts)." });
  });
});

describe('the save line', () => {
  const base = { revision: 4, savedRevision: 4, savedAt: null, saving: false, conflict: null, stale: null, refused: null, failed: null, kept: null };
  it('says saved, saving and not saved yet, in words and a glyph, never in green or amber', () => {
    expect(saveState({ ...base, revision: 0, savedRevision: 0 })).toEqual({ state: 'saved', glyph: '■', needsYou: false, words: 'Saved: nothing drawn yet (revision 0).' });
    expect(saveState(base)).toMatchObject({ state: 'saved', needsYou: false, words: 'Saved: revision 4.' });
    expect(saveState({ ...base, savedAt: '2026-10-15T20:00:00.000Z' }).words).toMatch(/^Saved: revision 4, at .+\.$/);
    expect(saveState({ ...base, revision: 6 })).toEqual({ state: 'unsaved', glyph: '○', needsYou: false, words: 'Not saved yet: revision 6 (saving in a moment).' });
    expect(saveState({ ...base, revision: 6, saving: true })).toEqual({ state: 'saving', glyph: '◔', needsYou: false, words: 'Saving revision 6…' });
  });
  it('says failed to save with why and what tries again, and a refusal in Timmy\'s words: each needs you', () => {
    expect(saveState({ ...base, revision: 5, failed: 'Timmy could not be reached to save the canvas (Failed to fetch).' })).toEqual({ state: 'failed', glyph: '✕', needsYou: true, words: 'Failed to save revision 5: Timmy could not be reached to save the canvas (Failed to fetch). The next change tries again; Retry tries now.' });
    expect(saveState({ ...base, refused: 'the session ended. In Timmy: /canvas open.' })).toEqual({ state: 'refused', glyph: '✕', needsYou: true, words: 'Not saved: the session ended. In Timmy: /canvas open.' });
  });
  it('says a newer version is on disk (a refused save, or one seen first), that nothing was overwritten, and where a copy went', () => {
    expect(saveState({ ...base, revision: 7, conflict: { words: 'x', revision: 9 } })).toEqual({ state: 'conflict', glyph: '⇄', needsYou: true, words: "Not saved: a newer version of this canvas is on disk (revision 9), saved after this page opened it. This page's 3 changes since revision 4 are not saved. Nothing was overwritten." });
    expect(saveState({ ...base, stale: { revision: 6 }, kept: 'copies/canvas-r4-x.json' })).toEqual({ state: 'stale', glyph: '⇄', needsYou: true, words: "A newer version of this canvas is on disk (revision 6), saved after this page's last save (revision 4). This page has no unsaved changes. This page will not save over it. This page's version was kept as copies/canvas-r4-x.json." });
    // the conflict comes first, then a newer version seen, then a refusal, then a failure
    expect(saveState({ ...base, conflict: { words: 'x', revision: 9 }, stale: { revision: 9 }, refused: 'r', failed: 'f' }).state).toBe('conflict');
    expect(saveState({ ...base, stale: { revision: 9 }, refused: 'r', failed: 'f' }).state).toBe('stale');
    expect(Object.values(SAVE_GLYPH).every((g) => g.length === 1)).toBe(true);
  });
});
