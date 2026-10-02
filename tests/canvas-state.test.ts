import { describe, expect, it } from 'vitest';
const { canvasStorageKey, createCanvasCheckpoint, formatCanvasError, parseCanvas, serializeCanvas } = await import(
  /* @vite-ignore */ new URL('../studio/tldraw-mission-map/canvas-state.js', import.meta.url).href);
const original = { document: { store: { 'shape:one': { id: 'shape:one', typeName: 'shape', props: { text: 'synthetic note' } } }, schema: { schemaVersion: 2 } }, session: {} };
function fixture() {
  let snapshot = structuredClone(original); const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, text: string) => { entries.set(key, text); } };
  const checkpoint = createCanvasCheckpoint({ board: 'blank', storage,
    getSnapshot: () => structuredClone(snapshot),
    loadSnapshot: (next: any) => { snapshot = structuredClone(next); if (next.document.store.bad) throw Error('Native schema rejected'); } });
  return { checkpoint, entries, storage, get: () => snapshot, set: (next: any) => { snapshot = next; } };
}
describe('browser-local canvas checkpoints', () => {
  it('separates blank planning and dispatch boards, refusing unknown namespaces', () => {
    expect(canvasStorageKey('blank')).not.toBe(canvasStorageKey('dispatch'));
    expect(() => canvasStorageKey('other')).toThrow('Unknown board');
  });
  it('saves editable records and restores only after explicit replacement', () => {
    const f = fixture(); f.checkpoint.save(); f.set({ document: { store: {}, schema: {} } });
    expect(() => f.checkpoint.restore()).toThrow('confirmation'); expect(f.get().document.store).toEqual({});
    f.checkpoint.restore({ replace: true }); expect(f.get()).toEqual(original);
  });
  it('exports and imports editable snapshots without dispatch execution', () => {
    const f = fixture(); const text = f.checkpoint.exportSnapshot(); f.set({ document: { store: {}, schema: {} } });
    f.checkpoint.importSnapshot(text, { replace: true }); expect(f.get()).toEqual(original); expect(f.entries.size).toBe(0);
  });
  it.each(['{}', 'invalid JSON', JSON.stringify({ format: 'other' })])('refuses malformed files without mutation (%s)', text => {
    const f = fixture(); expect(() => f.checkpoint.importSnapshot(text, { replace: true })).toThrow(); expect(f.get()).toEqual(original);
  });
  it('rejects different-board files', () => { expect(() => parseCanvas(serializeCanvas(original, 'dispatch'), 'blank')).toThrow('different board'); });
  it('retains saved bytes when storage refuses a write', () => {
    const f = fixture(); f.checkpoint.save(); const before = [...f.entries]; f.storage.setItem = () => { throw Error('Quota exceeded'); };
    expect(() => f.checkpoint.save()).toThrow('Quota'); expect([...f.entries]).toEqual(before);
  });
  it('rolls back failed native schema loads and preserves the refusal', () => {
    const f = fixture(); const bad = serializeCanvas({ document: { store: { bad: {} }, schema: {} } }, 'blank');
    expect(() => f.checkpoint.importSnapshot(bad, { replace: true })).toThrow('Native schema rejected'); expect(f.get()).toEqual(original);
  });
  it('preserves the exact native refusal and the entire document after successful rollback', () => {
    const before = { ...structuredClone(original), session: { currentPageId: 'page:one', camera: { x: 4, y: 9, z: 2 } } };
    let current: any = structuredClone(before);
    const refusal = new Error('Shape x must be numeric');
    const checkpoint = createCanvasCheckpoint({ board: 'blank', storage: fixture().storage,
      getSnapshot: () => current,
      loadSnapshot: (next: any) => {
        current = structuredClone(next);
        if (next.document.store['shape:one']?.x === 'invalid') throw refusal;
      } });
    const invalid = structuredClone(before) as any; invalid.document.store['shape:one'].x = 'invalid';
    expect(checkpoint.getRecoverySnapshot()).toBeNull();
    let caught: unknown;
    try { checkpoint.importSnapshot(serializeCanvas(invalid, 'blank'), { replace: true }); } catch (error) { caught = error; }
    expect(caught).toBe(refusal); expect(current).toEqual(before);
    expect(checkpoint.getRecoverySnapshot()).toEqual(before);
  });
  it.each([false, true])('retains both failures and an independent usable preimage (mutating rollback: %s)', mutateRollback => {
    const before = structuredClone(original);
    let current: any = structuredClone(before); let calls = 0;
    const importError = new Error('Fixed import refusal'); const rollbackError = new Error('Fixed rollback refusal');
    const checkpoint = createCanvasCheckpoint({ board: 'blank', storage: fixture().storage,
      getSnapshot: () => current,
      loadSnapshot: (next: any) => {
        calls++;
        if (calls === 1) { current.document.store = {}; throw importError; }
        if (mutateRollback) { next.document.store = {}; next.document.schema.schemaVersion = -1; next.session.damaged = true; }
        throw rollbackError;
      } });
    let caught: any;
    try { checkpoint.importSnapshot(serializeCanvas(original, 'blank'), { replace: true }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors).toHaveLength(2);
    expect(caught.errors[0]).toBe(importError); expect(caught.errors[1]).toBe(rollbackError);
    expect(caught.cause).toBe(importError);
    expect(importError.message).toBe('Fixed import refusal'); expect(rollbackError.message).toBe('Fixed rollback refusal');
    expect(formatCanvasError(caught)).toBe('Fixed import refusal · Fixed rollback refusal');
    expect(calls).toBe(2); expect(current).not.toEqual(before);
    const recovery = checkpoint.getRecoverySnapshot(); expect(recovery).toEqual(before);
    recovery.document.store = {}; recovery.document.schema.schemaVersion = 999; recovery.session.poisoned = true;
    expect(checkpoint.getRecoverySnapshot()).toEqual(before);
    const healthyRecovery = (next: any) => { current = structuredClone(next); next.document.store = {}; };
    healthyRecovery(checkpoint.getRecoverySnapshot());
    expect(current).toEqual(before); expect(checkpoint.getRecoverySnapshot()).toEqual(before);
    expect(caught.errors[0]).toBe(importError); expect(caught.errors[1]).toBe(rollbackError);
  });
  it('formats ordinary refusals without changing their message', () => {
    const refusal = new Error('Original refusal');
    expect(formatCanvasError(refusal)).toBe(refusal.message);
  });
  it('reports missing checkpoints and refuses oversized files', () => {
    const f = fixture(); expect(() => f.checkpoint.restore({ replace: true })).toThrow('No saved checkpoint');
    expect(() => parseCanvas('x'.repeat(8 * 1024 * 1024 + 1), 'blank')).toThrow('8 MB');
  });
});
