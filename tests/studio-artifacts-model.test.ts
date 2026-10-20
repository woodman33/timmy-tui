/**
 * R6 (H145): the artifact card's pure rules (companion/studio-canvas/src/artifacts.js), in Node: what a card shows on each board
 * state (its own project's board on screen, another project's, a switch under way, a pause), what a placed card keeps (its name and
 * its last reading in words: never an image, never a verified mark), the overlays as SVG shapes in the image's own frame, the
 * receipt's mark (green only when it verifies now), and the words a refused placement says. The real browser runs them in
 * tests/studio-artifacts-browser.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { artifactCommand, artifactFollowed, artifactMode, artifactProps, cardImage, notNowWords, overlayLine, overlayShapes, receiptMark, runOutputs } from '../companion/studio-canvas/src/artifacts.js';

const tray = { id: 'a'.repeat(16), name: 'tray' };
const blank = { id: 'b'.repeat(16), name: 'blank' };

describe('the artifact card\'s rules (R6 H145)', () => {
  it('follows its artifact only while its own project\'s board is on screen, and says why not otherwise', () => {
    const card = { projectId: tray.id, project: 'tray' };
    expect(artifactMode(card, { project: tray, state: 'shown' })).toEqual({ follows: true, words: '' });
    expect(artifactMode(card, { project: blank, state: 'shown' })).toEqual({ follows: false, words: "An artifact of tray: it is shown on tray's own board only, and this board is blank's." });
    expect(artifactMode(card, { project: tray, state: 'switching', switching: blank })).toEqual({ follows: false, words: 'Studio is switching to blank: this card shows nothing until a board is on screen.' });
    expect(artifactMode(card, { project: tray, state: 'paused', paused: 'The canvas shows a project of another Timmy REPL now.' })).toEqual({ follows: false, words: 'Not shown now: The canvas shows a project of another Timmy REPL now.' });
    expect(artifactMode(card, { project: null, state: 'none' }).follows).toBe(false);
    expect(artifactMode({ projectId: 'nope', project: 'x' }, { project: tray, state: 'shown' })).toEqual({ follows: false, words: 'This card names no project, so it shows nothing.' });
  });

  it('a placed card keeps its name and its last reading in words: no image, no verified mark, no preview', () => {
    const row = { id: 'vox:v1a2b3c4d', kind: 'vox', title: 'detect refs/photo.png', state: 'ok · verified', at: '2026-10-16T10:00:00.000Z', record: 'results/vox/v1a2b3c4d.json', fake: true,
      receipt: { short: 'feedbeef', verified: true, words: 'sealed and verified now' }, preview: { kind: 'vox', id: 'v1a2b3c4d' }, counts: { images: 2, overlays: 3, values: 3 } };
    const p = artifactProps(row, tray, new Date('2026-10-16T12:00:00.000Z'));
    expect(p).toEqual({
      w: 360, h: 180, card: 'vox:v1a2b3c4d', kind: 'vox', projectId: tray.id, project: 'tray', title: 'detect refs/photo.png', command: '/open results/vox/v1a2b3c4d.json',
      data: { type: 'artifact', kind: 'vox', state: 'ok · verified', at: '2026-10-16T10:00:00.000Z', record: 'results/vox/v1a2b3c4d.json', fake: true },
      readAt: '2026-10-16T12:00:00.000Z', open: false, gone: false,
    });
    expect(JSON.stringify(p)).not.toMatch(/verified now|receipt|feedbeef/);
    expect(artifactCommand({ id: 'run:o1a2b3c4d', kind: 'run', preview: { kind: 'run', op: 'o1a2b3c4d' } })).toBe('/op o1a2b3c4d');
    expect(artifactCommand({ id: 'receipt:0f0e0d0c', kind: 'receipt', receipt: { short: '0f0e0d0c' } })).toBe('/web 0f0e0d0c');
  });

  it('draws the record\'s overlays in the image\'s own frame, each with its label, provenance and evidence', () => {
    const overlays = [
      { id: 'qr-1#1', entity: 'qr-1', image: 'input:a', shape: 'polygon', points: [0, 0, 3, 0, 3, 1, 0, 1], label: 'QR 1 "x"', provenance: 'measured', evidence: 'constructed', word: 'measured' },
      { id: 'c#1', entity: 'c', image: 'input:a', shape: 'box', points: [1, 0, 3, 1], label: 'colour region', provenance: 'measured', evidence: 'constructed', word: 'measured' },
      { id: 'c#2', entity: 'c', image: 'input:a', shape: 'point', points: [1.5, 0.5], label: 'centroid', provenance: 'measured', evidence: 'constructed', word: 'measured' },
      { id: 'm#1', entity: 'm', image: 'highlight:x', shape: 'box', points: [0, 0, 1, 1], label: 'a model box', provenance: 'generated', evidence: 'inferred', word: 'model prediction' },
      { id: 'bad', entity: 'b', image: 'input:a', shape: 'box', points: [0, 'x', 1, 1], label: 'not numbers', provenance: 'measured', evidence: 'constructed', word: '' },
    ];
    const shapes = overlayShapes(overlays, 'input:a');
    expect(shapes.map((s) => [s.shape, s.id])).toEqual([['polygon', 'qr-1#1'], ['rect', 'c#1'], ['point', 'c#2']]);
    expect(shapes[0]).toMatchObject({ points: '0,0 3,0 3,1 0,1' });
    expect(shapes[1]).toMatchObject({ x: 1, y: 0, w: 2, h: 1 });
    expect(shapes[2]).toMatchObject({ x: 1.5, y: 0.5 });
    expect(shapes.map(overlayLine)).toEqual(['QR 1 "x" · measured · constructed', 'colour region · measured · constructed', 'centroid · measured · constructed']);
    // the card's image: the observed input that has overlays, else the first the route serves
    const preview = { images: [{ key: 'highlight:x', path: 'h.png', servable: true, role: 'highlight' }, { key: 'input:a', path: 'refs/a.png', servable: true, role: 'input' }, { key: 'input:b', path: 'refs/b.png', servable: false, role: 'input' }], overlays };
    expect(cardImage(preview)?.path).toBe('refs/a.png');
    expect(cardImage({ images: [{ key: 'k', path: 'only.png', servable: true, role: 'frame' }], overlays: [] })?.path).toBe('only.png');
    expect(cardImage({ images: [{ key: 'k', path: 'x.svg', servable: false }], overlays: [] })).toBeNull();
  });

  it('a receipt is green only when it verifies now; one that does not verify is said with ✕; outputs are what a run made', () => {
    expect(receiptMark({ short: '1a2b3c4d', verified: true, words: 'sealed and verified now' })).toEqual({ tone: 'verified', text: '✓ sealed and verified · receipt 1a2b3c4d' });
    expect(receiptMark({ short: '1a2b3c4d', verified: false, words: 'receipt 1a2b3c4d does not verify now: its signature does not verify' })).toEqual({ tone: 'failed', text: '✕ receipt 1a2b3c4d does not verify now: its signature does not verify' });
    expect(receiptMark({ short: '', verified: false, words: 'not sealed: no vox receipt of this project names this record' })).toEqual({ tone: 'none', text: 'not sealed: no vox receipt of this project names this record' });
    expect(receiptMark(null)).toEqual({ tone: 'none', text: 'no receipt read' });
    const files = [{ path: './BUILD.md', role: 'input' }, { path: './out/a.stl', role: 'output' }, { path: './out/log', role: 'log' }, { path: './r.json', role: 'record' }];
    expect(runOutputs({ files }).outputs.map((f) => f.path)).toEqual(['./out/a.stl', './out/log']);
  });

  it('a placement refused while Studio switches, or shows no board, says so', () => {
    expect(notNowWords({ state: 'switching', switching: blank })).toBe('Not placed: Studio is switching to blank, so nothing is placed on either board until its board is loaded.');
    expect(notNowWords({ state: 'paused', paused: 'Another REPL holds it.' })).toBe('Not placed: Another REPL holds it.');
    expect(notNowWords({ state: 'none' })).toBe('Not placed: no board is on screen yet.');
  });

  it('a card fitting its own height while a call of Timmy\'s runs is the page\'s change, never the call\'s; any other change of it is', () => {
    const card = { id: 'shape:a1', typeName: 'shape', type: 'timmy-artifact', x: 10, y: 20, parentId: 'page:page', meta: {}, props: { w: 360, h: 180, card: 'vox:v12345678', title: 'detect refs/photo.png', data: { state: 'ok' } } };
    expect(artifactFollowed(card, { ...card, props: { ...card.props, h: 412 } })).toBe(true);
    expect(artifactFollowed(card, { ...card, props: { ...card.props, h: 412, title: 'another title' } })).toBe(false);
    expect(artifactFollowed(card, { ...card, x: 11, props: { ...card.props, h: 412 } })).toBe(false);
    expect(artifactFollowed(card, { ...card, meta: { timmyDraft: { id: 'draft-00aa11bb' } } })).toBe(false);
    expect(artifactFollowed(card, { ...card, props: { ...card.props, data: { state: 'changed' } } })).toBe(false);
    // only an artifact card: a note or a drawn card is not this rule's
    expect(artifactFollowed({ ...card, type: 'note' }, { ...card, type: 'note', props: { ...card.props, h: 412 } })).toBe(false);
    expect(artifactFollowed(card, undefined)).toBe(false);
  });
});
