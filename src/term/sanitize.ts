/**
 * Untrusted text (model output, tool arguments and results, network errors) is cleaned before it is
 * drawn: escape sequences and control characters could erase or rewrite what a box shows, set the
 * clipboard (OSC 52) or plant links (OSC 8). Tabs become spaces so width math holds.
 */
import { visibleWidth } from './width.js';

const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const OSC_OPEN = /\x1b\][^\x07]*$/;
const STRING_SEQ = /\x1b[P^_X][\s\S]*?\x1b\\/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SHORT = /\x1b[@-Z\\-_]/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g;

export function sanitize(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(OSC, '')
    .replace(OSC_OPEN, '')
    .replace(STRING_SEQ, '')
    .replace(CSI, '')
    .replace(SHORT, '')
    .replace(/\t/g, '    ')
    .replace(CONTROLS, '');
}

const ESCAPE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-Z\\-_])/;
const OSC8_CLOSE = /^\x1b\]8;[^;]*;(?:\x07|\x1b\\)$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Cut a styled line to `width` cells, keeping its escapes; a cut closes any open link and resets. */
export function cutAnsi(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  let out = '';
  let used = 0;
  let linkOpen = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const m = ESCAPE.exec(line.slice(i));
      if (m) {
        if (m[0].startsWith('\x1b]8;')) linkOpen = !OSC8_CLOSE.test(m[0]);
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const next = line.indexOf('\x1b', i + 1);
    const run = line.slice(i, next === -1 ? undefined : next);
    let stopped = false;
    for (const { segment } of graphemes.segment(run)) {
      const w = visibleWidth(segment);
      if (used + w > width) {
        stopped = true;
        break;
      }
      out += segment;
      used += w;
    }
    if (stopped) break;
    i += run.length;
  }
  return out + (linkOpen ? '\x1b]8;;\x1b\\' : '') + '\x1b[0m';
}
