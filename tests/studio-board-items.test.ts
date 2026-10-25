/**
 * R6 (H145): what tab 4 reads of a board (src/studio/board-items.ts), on a FIXTURE snapshot shaped as Studio saves one (tldraw
 * records: pages, shapes, assets; Timmy's cards with their props and meta): each kind, its page (through a group), the reading
 * order (page by page, top to bottom, left to right), what each links to, the draft marks, and another project's cards and
 * reference images named as kept apart with nothing of them read. No browser, no server.
 */
import { describe, expect, it } from 'vitest';
import { boardItems, richWords } from '../src/studio/board-items.js';

const TRAY = 'a1b2c3d4e5f60718';
const BLANK = 'f0e1d2c3b4a59687';
const SHA = 'ab'.repeat(32);
const rich = (...lines: string[]) => ({ type: 'doc', content: lines.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) });
const shape = (id: string, type: string, x: number, y: number, props: Record<string, unknown>, o: { parent?: string; meta?: Record<string, unknown> } = {}) =>
  [`shape:${id}`, { id: `shape:${id}`, typeName: 'shape', type, x, y, parentId: o.parent ?? 'page:one', index: 'a1', props, meta: o.meta ?? {} }] as const;
const card = (projectId: string, project: string, extra: Record<string, unknown>) => ({ w: 360, h: 180, projectId, project, command: '', readAt: '', open: false, gone: false, ...extra });

/** FIXTURE: a board of tray's, as Studio saves it (its records only; FIXTURE words throughout). */
const SNAPSHOT = {
  schema: { schemaVersion: 2 },
  store: Object.fromEntries([
    ['page:one', { id: 'page:one', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} }],
    ['page:two', { id: 'page:two', typeName: 'page', name: 'Fixtures', index: 'a2', meta: {} }],
    ['asset:ref', { id: 'asset:ref', typeName: 'asset', type: 'image', props: { name: 'photo.png', src: `/api/canvas/ref/${TRAY}/${SHA}.png` }, meta: { timmyRef: { path: 'refs/photo.png', sha256: SHA, bytes: 1234, from: "tray's own file refs/photo.png, copied into tray's board", project: TRAY, projectName: 'tray' } } }],
    ['asset:theirs', { id: 'asset:theirs', typeName: 'asset', type: 'image', props: { name: 'green.png', src: `/api/canvas/ref/${BLANK}/${SHA}.png` }, meta: { timmyRef: { path: 'refs/green.png', sha256: SHA, bytes: 99, from: "blank's own file", project: BLANK, projectName: 'blank' } } }],
    ['asset:hand', { id: 'asset:hand', typeName: 'asset', type: 'image', props: { name: 'pasted.png', src: 'data:image/png;base64,AAAA' }, meta: {} }],
    // page one, top to bottom: a placed project card (a note), a drawn result card of an operation, the artifacts, the images
    shape('placed', 'note', 0, 0, { richText: rich('FIXTURE placed card words') }, { meta: { timmyProjectCard: { card: 'vox:v12345678', kind: 'vox', projectId: TRAY, project: 'tray', title: 'FIXTURE detect refs/photo.png', state: 'FIXTURE ok', command: '/open x', receipt: '1a2b3c4d', operation: null } } }),
    shape('result', 'timmy-result', 400, 0, card(TRAY, 'tray', { card: 'result:results/r.json', kind: 'result', title: 'FIXTURE result', command: '/op o1a2b3c4d', data: null }), { meta: { timmyOperation: 'o1a2b3c4d' } }),
    shape('vox', 'timmy-artifact', 0, 200, card(TRAY, 'tray', { card: 'vox:v12345678', kind: 'vox', title: 'FIXTURE detect refs/photo.png', data: { type: 'artifact', kind: 'vox', state: 'FIXTURE ok · 3 values', fake: true } })),
    shape('run', 'timmy-artifact', 400, 200, card(TRAY, 'tray', { card: 'run:o1a2b3c4d', kind: 'run', title: 'FIXTURE operation o1a2b3c4d', data: { type: 'artifact', kind: 'run', state: 'FIXTURE succeeded', fake: false } })),
    shape('receipt', 'timmy-artifact', 800, 200, card(TRAY, 'tray', { card: 'receipt:1a2b3c4d', kind: 'receipt', title: 'FIXTURE vox receipt', data: { type: 'artifact', kind: 'receipt', state: 'FIXTURE sealed' } })),
    shape('odd', 'timmy-artifact', 1200, 200, card(TRAY, 'tray', { card: 'vox:../../etc', kind: 'vox', title: 'FIXTURE odd id', data: { state: '' } })),
    shape('theirs', 'timmy-artifact', 0, 400, card(BLANK, 'blank', { card: 'vox:vfeedbeef', kind: 'vox', title: "FIXTURE blank's title", data: { state: "FIXTURE blank's words" } })),
    shape('theirs-placed', 'note', 400, 400, { richText: rich("FIXTURE blank's placed words") }, { meta: { timmyProjectCard: { card: 'vox:vfeedbeef', kind: 'vox', projectId: BLANK, project: 'blank', title: "FIXTURE blank's placed title" } } }),
    shape('img', 'image', 0, 600, { w: 160, h: 80, assetId: 'asset:ref', altText: 'x' }),
    shape('cap', 'text', 0, 690, { richText: rich('photo.png · from refs/photo.png in tray') }, { meta: { timmyRefCaption: { asset: 'asset:ref', sha256: SHA } } }),
    shape('their-img', 'image', 400, 600, { w: 80, h: 80, assetId: 'asset:theirs', altText: 'y' }),
    shape('hand', 'image', 800, 600, { w: 10, h: 10, assetId: 'asset:hand', altText: '' }),
    shape('drafted', 'geo', 0, 800, { richText: rich('FIXTURE drafted box') }, { meta: { timmyDraft: { id: 'draft-0011aabb', job: 'turn-1' } } }),
    shape('drafted2', 'text', 400, 800, { richText: rich('FIXTURE drafted text') }, { meta: { timmyDraft: { id: 'draft-0011aabb', job: 'turn-1' } } }),
    shape('empty-geo', 'geo', 800, 800, { richText: rich('') }),
    shape('arrow', 'arrow', 0, 900, { richText: rich('an arrow label') }),
    // page two: a frame, and a note inside a group (its page is the group's)
    shape('group', 'group', 0, 0, {}, { parent: 'page:two' }),
    shape('in-group', 'note', 10, 10, { richText: rich('FIXTURE grouped', 'second line') }, { parent: 'shape:group' }),
    shape('frame', 'frame', 0, -100, { name: 'FIXTURE frame name', w: 100, h: 100 }, { parent: 'page:two' }),
  ]),
};

describe('what tab 4 reads of a board (R6 H145)', () => {
  it('lists each kind in reading order, with its page, what it links to and its marks; another project\'s cards and images are kept apart, unread', () => {
    const b = boardItems(SNAPSHOT, TRAY);
    expect(b.schema).toBe('timmy.studio-board/1');
    expect(b.items.map((i) => [i.shape.slice('shape:'.length), i.kind, i.sub ?? null, i.page])).toEqual([
      ['placed', 'card', 'vox', 'Page 1'], ['result', 'card', 'result', 'Page 1'],
      ['vox', 'artifact', 'vox', 'Page 1'], ['run', 'artifact', 'run', 'Page 1'], ['receipt', 'artifact', 'receipt', 'Page 1'], ['odd', 'artifact', 'vox', 'Page 1'],
      ['theirs', 'other-project', null, 'Page 1'], ['theirs-placed', 'other-project', null, 'Page 1'],
      ['img', 'reference', null, 'Page 1'], ['their-img', 'other-project', null, 'Page 1'], ['hand', 'image', null, 'Page 1'],
      ['drafted', 'words', 'geo', 'Page 1'], ['drafted2', 'words', 'text', 'Page 1'],
      ['frame', 'words', 'frame', 'Fixtures'], ['in-group', 'words', 'note', 'Fixtures'],
    ]);
    const at = (id: string) => b.items.find((i) => i.shape === `shape:${id}`)!;
    expect(at('placed')).toMatchObject({ title: 'FIXTURE detect refs/photo.png', excerpt: 'as placed: FIXTURE ok', target: { vox: 'v12345678', receipt: '1a2b3c4d' } });
    expect(at('result')).toMatchObject({ title: 'FIXTURE result', excerpt: '/op o1a2b3c4d', target: { run: 'o1a2b3c4d' } });
    expect(at('vox')).toMatchObject({ title: 'FIXTURE detect refs/photo.png', excerpt: 'as placed: FIXTURE ok · 3 values', fake: true, target: { vox: 'v12345678' }, draft: null });
    expect(at('run').target).toEqual({ run: 'o1a2b3c4d' });
    expect(at('run').fake).toBeUndefined();
    expect(at('receipt').target).toEqual({ receipt: '1a2b3c4d' });
    expect(at('odd').target).toBeUndefined();
    expect(at('img')).toMatchObject({ title: 'photo.png', excerpt: "tray's own file refs/photo.png, copied into tray's board", ref: { file: `${SHA}.png`, path: 'refs/photo.png', sha256: SHA, bytes: 1234 } });
    expect(at('hand')).toMatchObject({ title: 'pasted.png' });
    expect(at('hand').ref).toBeUndefined();
    expect(at('in-group')).toMatchObject({ title: 'FIXTURE grouped second line' });
    expect(at('frame').title).toBe('FIXTURE frame name');
    expect([at('drafted').draft, at('drafted2').draft, at('vox').draft]).toEqual(['draft-0011aabb', 'draft-0011aabb', null]);
    expect(b.drafts).toEqual(['draft-0011aabb']);
    // kept apart: named by its project, nothing of it read (no title, words, target or file)
    // (R11 round 7, H176: `box` is where it sits on the page — its place, no content — so the Canvas page can draw the board's map)
    const box = { x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) };
    for (const id of ['theirs', 'theirs-placed']) expect(at(id)).toEqual({ shape: `shape:${id}`, page: 'Page 1', kind: 'other-project', title: 'a card of blank', excerpt: "kept apart: shown on blank's own board only, so nothing of it is read here", draft: null, box });
    expect(at('their-img')).toEqual({ shape: 'shape:their-img', page: 'Page 1', kind: 'other-project', title: 'a reference image of blank', excerpt: "kept apart: shown on blank's own board only, so nothing of it is read here", draft: null, box });
    expect(JSON.stringify(b)).not.toMatch(/blank's (title|words|placed)|vfeedbeef|green\.png/);
    // a reference's caption, a group, an arrow and a shape with no words are not listed apart
    expect(b.items.some((i) => ['shape:cap', 'shape:group', 'shape:arrow', 'shape:empty-geo'].includes(i.shape))).toBe(false);
    expect(b.counts).toEqual({ card: 2, artifact: 4, 'other-project': 3, reference: 1, image: 1, words: 4 });
    expect(b.more).toBe(0);
  });

  it('the same board read for blank names tray\'s cards as kept apart and lists blank\'s own; a cap keeps the first in reading order and counts the rest', () => {
    const b = boardItems(SNAPSHOT, BLANK);
    const kinds = Object.fromEntries(b.items.map((i) => [i.shape.slice('shape:'.length), i.kind]));
    expect(kinds).toMatchObject({ vox: 'other-project', result: 'other-project', placed: 'other-project', theirs: 'artifact', 'theirs-placed': 'card', 'their-img': 'reference', img: 'other-project' });
    expect(b.items.find((i) => i.shape === 'shape:vox')).toMatchObject({ title: 'a card of tray' });
    expect(JSON.stringify(b.items.filter((i) => i.kind === 'other-project'))).not.toMatch(/FIXTURE/);
    const capped = boardItems(SNAPSHOT, TRAY, 3);
    expect(capped.items.map((i) => i.shape)).toEqual(['shape:placed', 'shape:result', 'shape:vox']);
    expect(capped.more).toBe(12);
    expect(capped.counts.words).toBe(4);
  });

  it('nothing is listed of no board, an unreadable one, or a project id that is not one; rich text reads as its words', () => {
    for (const s of [null, undefined, 'x', {}, { store: null }, { store: [] }]) expect(boardItems(s, TRAY)).toEqual({ schema: 'timmy.studio-board/1', items: [], counts: {}, drafts: [], more: 0 });
    expect(boardItems(SNAPSHOT, 'not-an-id').items).toEqual([]);
    expect(richWords(rich('one', 'two  three'))).toBe('one two three');
    expect(richWords({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('');
    expect(richWords(null)).toBe('');
  });
});
