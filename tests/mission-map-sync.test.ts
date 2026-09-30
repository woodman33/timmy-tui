import { describe, expect, it } from 'vitest';
const moduleUrl = new URL('../studio/tldraw-mission-map/plan-sync.js', import.meta.url);
const { applyPlanSync, createPlanSync } = await import(/* @vite-ignore */ moduleUrl.href);
const rich = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
function fixture() {
  const shapes: any[] = [{ id: 'shape:operator', type: 'note', x: 41, y: 53, props: { richText: rich('my notes'), color: 'red' }, meta: {} }];
  let page = 'page:one';
  let counter = 0;
  const editor = {
    getCurrentPageShapes: () => shapes,
    getCurrentPageId: () => page,
    run: (fn: () => void, options: { history: string }) => { expect(options.history).toBe('ignore'); fn(); },
    createShape: (shape: any) => shapes.push(structuredClone(shape)),
    updateShape: (update: any) => { const shape = shapes.find(s => s.id === update.id); Object.assign(shape, { ...update, props: { ...shape.props, ...update.props } }); },
  };
  return { shapes, editor, setPage: (id: string) => { page = id; },
    dependencies: { createShapeId: () => `shape:generated-${++counter}`, toRichText: rich } };
}
const plan = { id: 'plan:one', lifecycle: 'running', harness: 'fixture', plan_hash: '1234567890123456' };

describe('mission-map dispatch synchronization', () => {
  it.each(['unrecognized-state', 'constructor', 'toString', '__proto__'])('uses grey for unknown lifecycle %s', lifecycle => {
    const f = fixture(); applyPlanSync(f.editor, [{ ...plan, lifecycle }], f.dependencies);
    expect(f.shapes[1].props.color).toBe('grey');
  });
  it('adds and updates only owned notes, preserving drawings, geometry, styling, and metadata', () => {
    const f = fixture(); const original = structuredClone(f.shapes[0]);
    applyPlanSync(f.editor, [plan], f.dependencies);
    const note = f.shapes[1]; note.x = 900; note.props.color = 'orange'; note.meta.operator = 'keep';
    applyPlanSync(f.editor, [{ ...plan, lifecycle: 'passed' }], f.dependencies);
    expect(f.shapes).toHaveLength(2); expect(f.shapes[0]).toEqual(original);
    expect(note).toMatchObject({ x: 900, props: { color: 'orange', richText: rich('plan:one\npassed\nfixture\nhash 123456789012') }, meta: { operator: 'keep' } });
    expect(note.props.text).toBeUndefined();
  });
  it('preserves edited rich text and never adopts unrelated dispatch metadata', () => {
    const f = fixture(); f.shapes[0].meta.dispatchId = plan.id;
    applyPlanSync(f.editor, [plan], f.dependencies);
    f.shapes[1].props.richText = rich('operator edit');
    const before = structuredClone(f.shapes);
    applyPlanSync(f.editor, [{ ...plan, lifecycle: 'passed' }], f.dependencies);
    expect(f.shapes).toEqual(before);
  });
  it('does not delete notes on an empty response or when a plan disappears', () => {
    const f = fixture(); applyPlanSync(f.editor, [plan], f.dependencies);
    const before = structuredClone(f.shapes); applyPlanSync(f.editor, [], f.dependencies);
    expect(f.shapes).toEqual(before);
  });
  it.each([null, {}, [plan, plan], [plan, { id: 'invalid', lifecycle: {} }]])('refuses malformed payloads before mutation (%j)', input => {
    const f = fixture(); const before = structuredClone(f.shapes);
    expect(() => applyPlanSync(f.editor, input, f.dependencies)).toThrow();
    expect(f.shapes).toEqual(before);
  });
  it('refuses conflicting ownership without overwriting either note', () => {
    const f = fixture(); applyPlanSync(f.editor, [plan], f.dependencies);
    f.shapes.push({ ...structuredClone(f.shapes[1]), id: 'shape:copy' });
    const before = structuredClone(f.shapes);
    expect(() => applyPlanSync(f.editor, [plan], f.dependencies)).toThrow('More than one');
    expect(f.shapes).toEqual(before);
  });
  it.each(['http', 'network', 'json'])('retains every note on %s failure and requests only same-origin dispatch', async failure => {
    const f = fixture(); let requested = '';
    const sync = createPlanSync(f.editor, { ...f.dependencies, fetch: async (url: string) => {
      requested = url;
      if (failure === 'network') throw Error('unavailable');
      return { ok: failure !== 'http', json: async () => { throw Error('invalid JSON'); } };
    } });
    const before = structuredClone(f.shapes);
    expect(await sync()).toEqual({ state: 'unavailable' });
    expect(requested).toBe('/dispatch'); expect(f.shapes).toEqual(before);
  });
  it('applies successful responses without adding automatic changes to undo history', async () => {
    const f = fixture();
    const sync = createPlanSync(f.editor, { ...f.dependencies,
      fetch: async () => ({ ok: true, json: async () => [plan] }),
    });
    expect(await sync()).toEqual({ state: 'synced', count: 1 });
    expect(f.shapes).toHaveLength(2);
  });
  it('prevents overlap and discards responses for a page left during fetch', async () => {
    const f = fixture(); let resolve!: (value: any) => void; let requests = 0;
    const sync = createPlanSync(f.editor, { ...f.dependencies, fetch: () => {
      requests++; return new Promise(r => { resolve = r; });
    } });
    const first = sync(); expect(await sync()).toEqual({ state: 'pending' });
    f.setPage('page:two'); resolve({ ok: true, json: async () => [plan] });
    expect(await first).toEqual({ state: 'page_changed' });
    expect(requests).toBe(1); expect(f.shapes).toHaveLength(1);
  });
});
