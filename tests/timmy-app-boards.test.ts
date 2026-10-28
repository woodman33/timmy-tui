/**
 * The unified Workspace order (2026-10-27): several saved boards per project (src/companion/timmy-app.ts). The project's
 * first board is the desk it already had (app-desk/, untouched); a new board is its own CanvasDocuments under app-boards/,
 * blank, named in app-boards/boards.json. Real files in a temporary Timmy home; two projects and two homes never share a list.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { boardDocsOf, boardName, createBoard, deskOf, FIRST_BOARD, readBoards, renameBoard } from '../src/companion/timmy-app.js';

const box = mkdtempSync(join(tmpdir(), 'boards-'));
const a = join(box, 'project-a'); const b = join(box, 'project-b');
mkdirSync(a); mkdirSync(b);
const home1 = { TIMMY_HOME: join(box, 'home1') }; const home2 = { TIMMY_HOME: join(box, 'home2') };
afterAll(() => rmSync(box, { recursive: true, force: true }));

describe('boards of a project', () => {
  it('the desk is the first board, named Desk, and its documents are the desk’s own folder', () => {
    expect(readBoards(a, home1)).toEqual([{ id: FIRST_BOARD, name: 'Desk', createdAt: null }]);
    expect(boardDocsOf(a, home1, FIRST_BOARD)!.load().revision).toBe(deskOf(a, home1).load().revision);
  });

  it('a new board gets a unique id from its name and starts blank; renaming keeps its id and its work', () => {
    const s = createBoard(a, home1, 'Storyboard one');
    expect('id' in s && s.id).toBe('storyboard-one');
    const again = createBoard(a, home1, 'Storyboard one');
    expect('id' in again && again.id).toBe('storyboard-one-2');
    const desk = createBoard(a, home1, 'Desk');
    expect('id' in desk && desk.id).toBe('desk-2');
    const docs = boardDocsOf(a, home1, 'storyboard-one')!;
    expect(docs.load().snapshot).toBeNull();
    const saved = docs.save({ snapshot: { store: {}, schema: { schemaVersion: 2, sequences: {} } }, baseRevision: 0, revision: 1 });
    expect(saved.ok).toBe(true);
    expect(renameBoard(a, home1, 'storyboard-one', 'Shot list')!.name).toBe('Shot list');
    expect(boardDocsOf(a, home1, 'storyboard-one')!.load().revision).toBe(1);
    expect(readBoards(a, home1).map((x) => [x.id, x.name])).toEqual([[FIRST_BOARD, 'Desk'], ['storyboard-one', 'Shot list'], ['storyboard-one-2', 'Storyboard one'], ['desk-2', 'Desk']]);
    expect(renameBoard(a, home1, FIRST_BOARD, 'Main desk')!.name).toBe('Main desk');
    expect(readBoards(a, home1)[0]).toMatchObject({ id: FIRST_BOARD, name: 'Main desk' });
  });

  it('another project, and another principal’s home, have their own boards', () => {
    expect(readBoards(b, home1).map((x) => x.id)).toEqual([FIRST_BOARD]);
    expect(readBoards(a, home2).map((x) => x.id)).toEqual([FIRST_BOARD]);
    expect(boardDocsOf(b, home1, 'storyboard-one')).toBeNull();
    expect(boardDocsOf(a, home2, 'storyboard-one')).toBeNull();
  });

  it('refuses what is not a board: an unknown id, a path, an empty name', () => {
    expect(boardDocsOf(a, home1, '../app-desk')).toBeNull();
    expect(boardDocsOf(a, home1, 'nope')).toBeNull();
    expect(boardName('   ')).toBeNull();
    expect(boardName(' a\n  b ')).toBe('a b');
    expect(boardName('x'.repeat(200))!.length).toBe(80);
  });
});
