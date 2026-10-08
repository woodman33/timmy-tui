/** Display-width text helpers (CJK and most emoji take 2 cells), shared with the existing TUI. */
import { truncateVisible, visibleWidth as cellWidth, wrapVisible } from '../tui/utils/text.js';

// Escapes are removed before measuring. The shared helper's OSC pattern is greedy across an ST
// terminator (`ESC \`), so an OSC 8 link would measure as zero cells; strip them here first.
const ESCAPES = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export const stripEscapes = (text: string): string => text.replace(ESCAPES, '');

export const visibleWidth = (text: string): number => cellWidth(stripEscapes(text));

/** Cut `text` to `width` cells, ending in `ellipsis` when it had to cut. Never `slice()`. */
export const truncate = (text: string, width: number, ellipsis = '…'): string => truncateVisible(stripEscapes(text), width, ellipsis);

export const wrap = (text: string, width: number): string[] => wrapVisible(stripEscapes(text), width);
