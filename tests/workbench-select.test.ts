// R4 (H112): the terminal Workbench's selection and scrolling while the records change (src/workbench/select.ts). Pure
// functions over the Workbench's own Ui; the items are made here (no records, no process).
import { describe, expect, it } from 'vitest';
import type { Item, Ui } from '../src/workbench/model.js';
import { endOf, keepInView, remember, resolve, scrollFor, select } from '../src/workbench/select.js';

const ui = (): Ui => ({ cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, activityFollow: true } as unknown as Ui);
const items = (keys: string[], start = 0, step = 1): Array<{ line: number; item: Item }> =>
  keys.map((k, i) => ({ line: start + i * step, item: { kind: 'action', key: k, action: k } as Item }));

describe('selection and scrolling that stay put while rows arrive (R4 H112)', () => {
  it('the selection is an item: rows that arrive above move its place, not the selection; an item that is gone leaves its place', () => {
    const u = ui();
    select(u, 'L', items(['a', 'b', 'c']), 1);
    expect(u.sel.L).toBe('b');
    resolve(u, 'L', items(['new1', 'new2', 'a', 'b', 'c']));
    expect(u.cursor.L).toBe(3);
    // b is gone: the place stays selected (clamped), and the next frame remembers what is there
    resolve(u, 'L', items(['a', 'c']));
    expect(u.cursor.L).toBe(1);
    // following the newest: the last item, whatever was selected
    resolve(u, 'L', items(['a', 'c', 'd']), { follow: true });
    expect(u.cursor.L).toBe(2);
  });

  it('the anchor keeps the selected item on the same row of its zone as rows arrive above it', () => {
    const u = ui();
    const before = items(Array.from({ length: 30 }, (_, i) => `e${i}`));
    select(u, 'L', before, 20);
    const s1 = scrollFor(u, 'L', before, { at: 20, height: 10, total: 30 });
    remember(u, 'L', before, s1);
    const row = 20 - s1;
    // five rows arrive above: the item is at line 25 now, and it is drawn on the same row
    const after = items([...Array.from({ length: 5 }, (_, i) => `n${i}`), ...before.map((x) => x.item.key)]);
    resolve(u, 'L', after);
    expect(u.cursor.L).toBe(25);
    const s2 = scrollFor(u, 'L', after, { at: 25, height: 10, total: 35 });
    expect(25 - s2).toBe(row);
    // rows that arrive below change nothing
    const more = items([...after.map((x) => x.item.key), 'z1', 'z2']);
    remember(u, 'L', after, s2);
    expect(scrollFor(u, 'L', more, { at: 25, height: 10, total: 37 })).toBe(s2);
  });

  it('the wheel\'s view is not pulled back to the selection until the person moves it; the first shown item is its anchor', () => {
    const u = ui();
    const list = items(Array.from({ length: 40 }, (_, i) => `r${i}`));
    select(u, 'L', list, 2);
    remember(u, 'L', list, scrollFor(u, 'L', list, { at: 2, height: 10, total: 40 }));
    // the wheel: 15 rows down, the selection (row 2) out of view and left there
    u.scroll.L = 15; u.wheel.L = true; delete u.anchor.L;
    const s = scrollFor(u, 'L', list, { at: 2, height: 10, total: 40 });
    expect(s).toBe(15);
    remember(u, 'L', list, s);
    expect(u.anchor.L).toEqual({ key: 'r15', row: 0 });
    // three rows arrive at the top: the view keeps r15 on its row
    const grown = items(['x1', 'x2', 'x3', ...list.map((x) => x.item.key)]);
    expect(scrollFor(u, 'L', grown, { at: 5, height: 10, total: 43 })).toBe(18);
    // the person moves the selection: the wheel's view is let go, and the selection shows
    select(u, 'L', grown, 6);
    expect(u.wheel.L).toBeUndefined();
    expect(scrollFor(u, 'L', grown, { at: 6, height: 10, total: 43 })).toBeLessThanOrEqual(6);
  });

  it('a wrapped item is brought into view whole when it fits; its first row is kept in view when it does not', () => {
    expect(keepInView(18, 0, 10, 30, 21)).toBe(12);
    expect(keepInView(18, 0, 3, 30, 25)).toBe(18);
    const list = items(['a', 'b', 'c'], 0, 4);
    expect(endOf(list, 0, 12)).toBe(3);
    expect(endOf(list, 2, 12)).toBe(11);
  });
});
