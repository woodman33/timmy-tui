/**
 * Every glyph Timmy prints, with its ASCII stand-in (playbook §16.7: `[OK]` `[FAIL]` `[WARN]`
 * `[INFO]`, `+-|` borders, `|/-\` spinner). Meaning always survives without color or Unicode.
 */
export interface GlyphSet {
  ok: string;
  fail: string;
  warn: string;
  info: string;
  /** Made by a model, or sent over the network (DESIGN.md §10 B4). */
  ai: string;
  estimate: string;
  bullet: string;
  sep: string;
  ellipsis: string;
  arrow: string;
  prompt: string;
  rail: string;
  railOpen: string;
  branch: string;
  branchEnd: string;
  rule: string;
  boxTopLeft: string;
  boxTopRight: string;
  boxBottomLeft: string;
  boxBottomRight: string;
  boxHorizontal: string;
  boxVertical: string;
  barFull: string;
  barEmpty: string;
  spinner: string[];
}

const UNICODE: GlyphSet = {
  ok: '✓',
  fail: '✖',
  warn: '⚠',
  info: 'ℹ',
  ai: '◉',
  estimate: '~',
  bullet: '●',
  sep: '·',
  ellipsis: '…',
  arrow: '→',
  prompt: '›',
  rail: '│',
  railOpen: '┆',
  branch: '├',
  branchEnd: '└',
  rule: '─',
  boxTopLeft: '╭',
  boxTopRight: '╮',
  boxBottomLeft: '╰',
  boxBottomRight: '╯',
  boxHorizontal: '─',
  boxVertical: '│',
  barFull: '█',
  barEmpty: '░',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

const ASCII: GlyphSet = {
  ok: '[OK]',
  fail: '[FAIL]',
  warn: '[WARN]',
  info: '[INFO]',
  ai: '[AI]',
  estimate: '~',
  bullet: '*',
  sep: '-',
  ellipsis: '...',
  arrow: '->',
  prompt: '>',
  rail: '|',
  railOpen: ':',
  branch: '|',
  branchEnd: '`',
  rule: '-',
  boxTopLeft: '+',
  boxTopRight: '+',
  boxBottomLeft: '+',
  boxBottomRight: '+',
  boxHorizontal: '-',
  boxVertical: '|',
  barFull: '#',
  barEmpty: '-',
  spinner: ['|', '/', '-', '\\'],
};

export const glyphSet = (unicode: boolean): GlyphSet => (unicode ? UNICODE : ASCII);
