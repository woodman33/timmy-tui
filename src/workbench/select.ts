/**
 * R4 (H112): selection and scrolling that stay where the person left them while the records change (the operator's direction:
 * "Preserve text selection, scrolling and focus while output streams"; the brief's slice C, items 1 and 5).
 *
 * Before (H110), a list's selection was a place (its row number): a job that started above the selected one, an event that
 * arrived, or a run that moved from Running now to Recent moved the selection to another item under the same row, and Stop,
 * the Inspector and Activity's filter then followed that other item. Here:
 *
 *   the selection is an item      Ui.sel keeps each list's selected item by its key; each frame finds it again (resolve),
 *                                  wherever its row is now; only an item that is gone leaves its place selected
 *   the view keeps its anchor      Ui.anchor keeps the item drawn at a row of the zone (the selected one; the first shown when
 *                                  the wheel scrolled the list) and the next frame draws it on the same row, so rows that
 *                                  arrive above or below move nothing the person is looking at
 *   the wheel scrolls the view     Ui.wheel marks a list the wheel scrolled: its view is not pulled back to the selection
 *                                  until the person moves the selection (a key or a click)
 *   Activity follows its newest    while the selection is the newest row (Ui.activityFollow), a new row becomes the selection;
 *                                  once the person selects an older row it stays there
 *
 * Pure functions over the Ui; the controller calls resolve() before it acts or draws and remember() after it draws.
 */
import type { Item, Ui } from './model.js';

type Items = ReadonlyArray<{ line: number; item: Item }>;

/** The list's cursor set to its selected item's place now (by key); follow: the last item (Activity's newest). */
export function resolve(ui: Ui, list: string, items: Items, o: { follow?: boolean } = {}): void {
  if (!items.length) return;
  if (o.follow) { ui.cursor[list] = items.length - 1; return; }
  const key = ui.sel[list];
  if (key === undefined) return;
  const at = items.findIndex((x) => x.item.key === key);
  if (at >= 0) ui.cursor[list] = at;
  else ui.cursor[list] = Math.max(0, Math.min(items.length - 1, ui.cursor[list] ?? 0));
}

/** The person moved a list's selection to `at` (a key or a click): it is that item now, and the wheel's view is let go. */
export function select(ui: Ui, list: string, items: Items, at: number): void {
  if (!items.length) return;
  const i = Math.max(0, Math.min(items.length - 1, at));
  ui.cursor[list] = i;
  ui.sel[list] = items[i].item.key;
  delete ui.wheel[list];
  (ui.chosen ??= {})[list] = true;
}

/**
 * Where a list's view starts so that the rows `at` to `end` show, keeping the earlier start `prev` where it already shows
 * them. `first`: the selection is the list's first item, so the rows above it (its headings) show too when they fit.
 */
export function keepInView(at: number | undefined, prev: number, height: number, total: number, end?: number, first = false): number {
  const max = Math.max(0, total - height);
  let s = Math.min(Math.max(0, prev), max);
  if (at === undefined) return s;
  const last = Math.max(at, end ?? at);
  if (last >= s + height) s = last - height + 1;
  if (at < s) s = at;
  if (first && last < height) s = 0;
  return Math.min(Math.max(0, s), max);
}

/**
 * The view's first row for this frame: from the anchor (the same item on the same row) when it is still there, else the
 * last start; then, unless the wheel scrolled the list, the selection's rows (`at` to `end`) brought into view.
 */
export function scrollFor(ui: Ui, list: string, items: Items, a: { at?: number; end?: number; height: number; total: number; first?: boolean }): number {
  const anchor = ui.anchor[list];
  const found = anchor ? items.find((x) => x.item.key === anchor.key) : undefined;
  const prev = found && anchor ? found.line - anchor.row : ui.scroll[list] ?? 0;
  if (ui.wheel[list]) return keepInView(undefined, prev, a.height, a.total);
  return keepInView(a.at, prev, a.height, a.total, a.end, a.first === true);
}

/** After a frame: the list's selected item, and the anchor the next frame keeps on its row. */
export function remember(ui: Ui, list: string, items: Items, scroll: number): void {
  ui.scroll[list] = scroll;
  if (!items.length) { delete ui.anchor[list]; return; }
  const cur = Math.max(0, Math.min(items.length - 1, ui.cursor[list] ?? 0));
  ui.sel[list] = items[cur].item.key;
  const pin = ui.wheel[list] ? items.find((x) => x.line >= scroll) : items[cur];
  if (pin) ui.anchor[list] = { key: pin.item.key, row: pin.line - scroll };
  else delete ui.anchor[list];
}

/** The last row an item takes (its wrapped rows end where the next item, or the list, begins). */
export function endOf(items: Items, i: number, total: number): number {
  const next = items[i + 1];
  return Math.max(items[i]?.line ?? 0, (next ? next.line : total) - 1);
}
