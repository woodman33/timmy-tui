/**
 * Round R4 (H47): a workflow document's own prose, drawn as readable text on the board. A small Markdown subset,
 * safe by construction: every character of the document is escaped, and the only markup this module writes is its
 * own (headings, paragraphs, lists, block quotes, rules, code, strong and emphasis, and links).
 *
 * What it draws, in document order:
 *   headings        `#` to `######`, and a line underlined with `===` or `---`
 *   paragraphs      lines joined; a line ending in two spaces or a backslash breaks there
 *   lists           `-`, `*`, `+` and `1.` / `1)` items, nested by indentation
 *   block quotes    `>` lines, their content drawn the same way
 *   rules           `---`, `***`, `___`
 *   code            `inline code`; an indented block; an unnamed fenced block as code (an example: upmd does not
 *                   run it by name)
 *   strong, em      `**strong**`, `*em*` (and `__`, `_` outside words)
 *   links           `[text](target)`, `[text][label]` with `[label]: target` lines, `<https://…>` and bare
 *                   http(s) addresses. A target is drawn as a link only when it is an http(s) address or a file of
 *                   the project (a relative path, resolved from the document's folder, that stays inside the
 *                   project); any other target (javascript:, data:, mailto:, an absolute path, a heading anchor)
 *                   keeps its text and is not a link.
 * Raw HTML is not markup here: a tag, an entity or an HTML comment is shown as the text it is.
 *
 * The named blocks: where upmd's parser (src/workflows/upmd.ts parseWorkflow) finds a fenced block, the block is
 * drawn by the caller (a chip that leads to its node), at that very line, so the prose and the graph name the same
 * blocks in the same places. This module reads the fences only through parseWorkflow's result (the block's line and
 * its lines of code), never by a second reading of its own; a fence parseWorkflow does not count (inside an HTML
 * comment, an indented block or a block quote) stays part of the text it sits in.
 */
import { posix } from 'node:path';
import { parseWorkflow, type WorkflowBlock } from './upmd.js';

export interface MarkdownDraw {
  /** the document's path in the project, '/'-separated: its relative links resolve from its folder */
  doc: string;
  /** a named block (one upmd runs by name), drawn in place of its fenced lines */
  chip: (block: WorkflowBlock & { name: string }) => string;
  /** a link to a file of the project: `rel` is checked to stay inside the project; `html` is the link's text, as HTML */
  file: (rel: string, html: string) => string;
  /** an unnamed fenced block; default: its code, escaped */
  code?: (block: WorkflowBlock) => string;
  /** at most this many lines are drawn (default 4,000); the rest is named, not drawn */
  maxLines?: number;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text as HTML text or as an attribute value: every markup character escaped. */
export const escapeHtml = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** A line of the document, with what its containers (list items, block quotes) took off its start. */
interface Ln { no: number; text: string }

/** an ATX heading's opening: its #s, then a space, a tab or the line's end (its text: atxText) */
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST = /^( {0,3})([-+*]|(\d{1,9})([.)]))([ \t]+|$)/;
const QUOTE = /^ {0,3}>/;
const COMMENT = /^ {0,3}<!--/;
/** a fence that parseWorkflow did not count (inside a block quote): drawn as code, never as a block */
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const DEFINITION = /^ {0,3}\[((?:[^\]\\\n]|\\.){1,999})\]:[ \t]*(?:<([^<>\n]*)>|(\S+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$/;
const PUNCT = /[!-/:-@[-`{-~]/;
const blank = (t: string): boolean => t.trim() === '';
/** lists and block quotes drawn inside each other at most this deep */
const MAX_DEPTH = 16;

/** Leading whitespace in columns, a tab to the next multiple of 4 (as upmd.ts counts it). */
function indentOf(t: string): number {
  let col = 0;
  for (const ch of /^[ \t]*/.exec(t)![0]) col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
  return col;
}
/** The line with `n` columns of its indentation taken off (a tab that straddles the cut becomes spaces). */
function dedent(t: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < t.length && col < n && (t[i] === ' ' || t[i] === '\t')) {
    const next = t[i] === '\t' ? col + 4 - (col % 4) : col + 1;
    if (next > n) return ' '.repeat(next - n) + t.slice(i + 1);
    col = next;
    i++;
  }
  return t.slice(i);
}

/** A link reference label as CommonMark compares them: case and inner whitespace folded. */
const label = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

type Target = { kind: 'web'; href: string } | { kind: 'file'; rel: string } | { kind: 'none'; why: string };

/** What a link target is: an http(s) address, a file of the project (resolved from the document's folder), or neither. */
export function linkTarget(raw: string, doc: string): Target {
  const dest = raw.trim();
  if (!dest) return { kind: 'none', why: 'an empty link' };
  if (/[\u0000-\u001f\u007f]/.test(dest)) return { kind: 'none', why: 'a target with a control character' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) {
    if (!/^https?:/i.test(dest)) return { kind: 'none', why: `a ${dest.slice(0, dest.indexOf(':') + 1).toLowerCase()} link is not followed here: only http(s) addresses and project files are links` };
    try {
      const u = new URL(dest);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) return { kind: 'web', href: u.href };
    } catch { /* not an address */ }
    return { kind: 'none', why: 'not a valid http(s) address' };
  }
  if (dest.startsWith('//')) return { kind: 'none', why: 'an address without its scheme' };
  if (dest.startsWith('#')) return { kind: 'none', why: 'a heading anchor: not a link on the board' };
  if (dest.startsWith('/') || dest.startsWith('\\') || dest.startsWith('~') || dest.includes('\\')) return { kind: 'none', why: 'an absolute or Windows path: the board links files only by their place in the project' };
  let path = dest.replace(/[?#].*$/, '');
  try { path = decodeURIComponent(path); } catch { /* kept as written */ }
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return { kind: 'none', why: 'not a file name' };
  const dir = posix.dirname(doc.replace(/\\/g, '/'));
  const rel = posix.normalize(posix.join(dir === '.' ? '' : dir, path)).replace(/\/+$/, '');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return { kind: 'none', why: 'a path outside the project' };
  return { kind: 'file', rel };
}

/** Where each named or unnamed block parseWorkflow found begins and ends (1-based lines, inclusive). */
function blockSpans(lines: string[], blocks: WorkflowBlock[]): Map<number, { block: WorkflowBlock; end: number }> {
  const opens = new Set(blocks.map((b) => b.line));
  const spans = new Map<number, { block: WorkflowBlock; end: number }>();
  const closes = (no: number, ch: string, size: number): boolean => {
    if (no > lines.length || opens.has(no)) return false;
    const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(lines[no - 1]);
    return !!m && m[1][0] === ch && m[1].length >= size;
  };
  for (const b of blocks) {
    const fence = /(`{3,}|~{3,})/.exec(lines[b.line - 1] ?? '');
    const ch = fence ? fence[1][0] : '`';
    const size = fence ? fence[1].length : 3;
    // parseWorkflow keeps one line of code per line of the document; an empty block is no line or one blank line.
    let body = b.code === '' ? 0 : b.code.split('\n').length;
    if (b.code === '' && !closes(b.line + 1, ch, size) && b.line + 1 <= lines.length && blank(lines[b.line]) && !opens.has(b.line + 1)) body = 1;
    const last = b.line + body;
    spans.set(b.line, { block: b, end: closes(last + 1, ch, size) ? last + 1 : last });
  }
  return spans;
}

/**
 * The document's prose as HTML, with each block parseWorkflow found drawn in its place (a named one by `chip`).
 * Every character of the document is escaped; links lead only to http(s) addresses and project files.
 */
export function renderMarkdown(text: string, draw: MarkdownDraw): string {
  const all = text.replace(/[-]/g, '�').split(/\r?\n/);
  const max = draw.maxLines ?? 4000;
  const blocks = parseWorkflow(text);
  const spans = blockSpans(all, blocks);
  const inSpan = new Set<number>();
  for (const [open, s] of spans) for (let n = open + 1; n <= s.end; n++) inSpan.add(n);
  const defs = new Map<string, string>();
  all.forEach((t, i) => {
    if (inSpan.has(i + 1) || spans.has(i + 1)) return;
    const m = DEFINITION.exec(t.replace(/^(?: {0,3}> ?)+/, ''));
    if (m && !defs.has(label(m[1]))) defs.set(label(m[1]), m[2] ?? m[3]);
  });
  const shown = all.slice(0, max).map((t, i): Ln => ({ no: i + 1, text: t }));
  const ctx: Ctx = { draw, spans, inSpan, defs };
  let html = renderBlocks(shown, ctx, false);
  if (all.length > max) html += `<p class="md-more">${escapeHtml(`${all.length - max} more lines of ${draw.doc} are not drawn here: open it to read them.`)}</p>`;
  return `<div class="md">${html}</div>`;
}

/** The project files a document links to, as `renderMarkdown` resolves them (for checking which exist). */
export function markdownLinks(text: string, doc: string): string[] {
  const found = new Set<string>();
  renderMarkdown(text, { doc, chip: () => '', file: (rel, html) => { found.add(rel); return html; } });
  return [...found];
}

interface Ctx {
  draw: MarkdownDraw;
  spans: Map<number, { block: WorkflowBlock; end: number }>;
  inSpan: Set<number>;
  defs: Map<string, string>;
}

const defaultCode = (b: WorkflowBlock): string => {
  const lines = b.code.split('\n');
  const shown = lines.slice(0, 40).join('\n');
  return `<pre class="md-code">${b.lang ? `<span class="md-lang">${escapeHtml(b.lang)}</span>` : ''}<code>${escapeHtml(shown)}</code></pre>`
    + (lines.length > 40 ? `<p class="md-more">${escapeHtml(`and ${lines.length - 40} more lines in this block`)}</p>` : '');
};

/** A block parseWorkflow found, drawn in place: a named one by the caller, an unnamed one as code. */
function drawBlock(b: WorkflowBlock, ctx: Ctx): string {
  if (b.name !== undefined) return ctx.draw.chip(b as WorkflowBlock & { name: string });
  return (ctx.draw.code ?? defaultCode)(b);
}

/** Lines into blocks: `quoted` is inside a block quote (where parseWorkflow counts no fence); `tight` is a tight list
 *  item's content, whose paragraphs are drawn without <p>; `depth` counts the lists and quotes around them (past
 *  MAX_DEPTH a list or quote marker is drawn as the text it is, so a line of 10,000 markers stays one paragraph). */
function renderBlocks(lines: Ln[], ctx: Ctx, quoted: boolean, tight = false, depth = 0): string {
  const out: string[] = [];
  let i = 0;
  const starts = (l: Ln): boolean => ctx.spans.has(l.no);
  const nests = depth < MAX_DEPTH;
  while (i < lines.length) {
    const l = lines[i];
    if (ctx.inSpan.has(l.no)) { i++; continue; }
    if (starts(l)) {
      const s = ctx.spans.get(l.no)!;
      out.push(drawBlock(s.block, ctx));
      i++;
      while (i < lines.length && lines[i].no <= s.end) i++;
      continue;
    }
    const t = l.text;
    if (blank(t)) { i++; continue; }
    const ind = indentOf(t);
    if (ind >= 4) {
      // an indented code block: its lines (and the blank lines between them) with four columns taken off
      const body: string[] = [];
      while (i < lines.length && !starts(lines[i]) && !ctx.inSpan.has(lines[i].no) && (blank(lines[i].text) || indentOf(lines[i].text) >= 4)) body.push(dedent(lines[i++].text, 4));
      while (body.length && blank(body[body.length - 1])) body.pop();
      out.push(`<pre class="md-code"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (COMMENT.test(t)) {
      // raw HTML: shown as the text it is, up to the line that closes the comment (as parseWorkflow skips it)
      const body = [t];
      let closed = t.indexOf('-->', t.indexOf('<!--') + 4) >= 0;
      i++;
      while (!closed && i < lines.length && !starts(lines[i])) { body.push(lines[i].text); closed = lines[i].text.includes('-->'); i++; }
      out.push(`<p class="md-raw">${escapeHtml(body.join('\n'))}</p>`);
      continue;
    }
    if (DEFINITION.test(t)) { i++; continue; }
    const atx = ATX.exec(t);
    if (atx) {
      out.push(heading(atx[1].length, inline(atxText(t.slice(atx[0].length)), ctx)));
      i++;
      continue;
    }
    if (THEMATIC.test(t)) { out.push('<hr class="md-hr">'); i++; continue; }
    if (nests && QUOTE.test(t)) {
      const inner: Ln[] = [];
      while (i < lines.length && !starts(lines[i]) && QUOTE.test(lines[i].text)) {
        inner.push({ no: lines[i].no, text: lines[i].text.replace(/^ {0,3}> ?/, '') });
        i++;
      }
      out.push(`<blockquote class="md-quote">${renderBlocks(inner, ctx, true, false, depth + 1)}</blockquote>`);
      continue;
    }
    if (quoted) {
      const f = FENCE.exec(t);
      if (f && !(f[2][0] === '`' && f[3].includes('`'))) {
        const body: string[] = [];
        i++;
        while (i < lines.length) {
          const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i].text);
          if (c && c[1][0] === f[2][0] && c[1].length >= f[2].length) { i++; break; }
          body.push(dedent(lines[i++].text, f[1].length));
        }
        out.push(`<pre class="md-code"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
        continue;
      }
    }
    const item = nests ? LIST.exec(t) : null;
    if (item) {
      const { html, next } = list(lines, i, ctx, quoted, depth + 1);
      out.push(html);
      i = next;
      continue;
    }
    // A paragraph: up to a blank line, a line that starts a block, or an underline that makes it a heading.
    const para: string[] = [];
    let setext = 0;
    while (i < lines.length) {
      const c = lines[i];
      if (blank(c.text) || starts(c) || ctx.inSpan.has(c.no)) break;
      if (para.length) {
        const u = SETEXT.exec(c.text);
        if (u) { setext = u[1][0] === '=' ? 1 : 2; i++; break; }
        if (ATX.test(c.text) || THEMATIC.test(c.text) || (nests && QUOTE.test(c.text)) || COMMENT.test(c.text) || (quoted && FENCE.test(c.text))) break;
        const li = nests ? LIST.exec(c.text) : null;
        if (li && c.text.slice(li[0].length).trim() && (!li[3] || li[3] === '1')) break;
      }
      para.push(c.text);
      i++;
    }
    const body = inline(para.map((p, k) => (k === para.length - 1 ? p.trim() : breakAt(p))).join('\n'), ctx);
    out.push(setext ? heading(setext, body) : tight ? body : `<p class="md-p">${body}</p>`);
  }
  return out.join('');
}

/** A paragraph line's end: two spaces or a backslash before the line break is a hard break (marked U+E002 for inline).
 *  Counted from the end, without a regular expression (a long run of spaces mid-line would make one backtrack). */
function breakAt(line: string): string {
  let k = line.length;
  while (k > 0 && line[k - 1] === ' ') k--;
  if (line.length - k >= 2) return `${line.slice(0, k).trimStart()}`;
  let b = line.length;
  while (b > 0 && line[b - 1] === '\\') b--;
  if ((line.length - b) % 2 === 1) return `${line.slice(0, -1).trimStart()}`;
  return line.trim();
}

/** An ATX heading's text: trimmed, without its closing #s (a run of # at the end after a space or tab, or alone).
 *  Read from the end, without a regular expression (a long run of spaces would make one backtrack). */
function atxText(rest: string): string {
  const text = rest.trim();
  let k = text.length;
  while (k > 0 && text[k - 1] === '#') k--;
  if (k === text.length) return text;
  return k === 0 ? '' : text[k - 1] === ' ' || text[k - 1] === '\t' ? text.slice(0, k).trim() : text;
}

/** Headings sit inside a card: the document's # is the card's own heading level, four, and so on down. */
function heading(level: number, html: string): string {
  const tag = level === 1 ? 'h4' : level === 2 ? 'h5' : 'h6';
  return `<${tag} class="md-h md-h${level}">${html}</${tag}>`;
}

/** A list starting at line `start`: its items, each drawn as blocks (one plain paragraph is drawn without <p>). */
function list(lines: Ln[], start: number, ctx: Ctx, quoted: boolean, depth: number): { html: string; next: number } {
  const first = LIST.exec(lines[start].text)!;
  const ordered = first[3] !== undefined;
  const kind = ordered ? first[4] : first[2];
  const items: Ln[][] = [];
  // Loose: a blank line between its items, or between the blocks of an item (its paragraphs keep their <p>).
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (ctx.inSpan.has(l.no)) { i++; continue; }
    const m = THEMATIC.test(l.text) ? null : LIST.exec(l.text);
    if (!m || (m[3] !== undefined) !== ordered || (ordered ? m[4] : m[2]) !== kind) break;
    const markerEnd = indentOf(m[1]) + m[2].length;
    const gap = m[5].replace(/\t/g, '    ').length;
    const rest = l.text.slice(m[0].length);
    const content = !rest.trim() || gap >= 5 ? markerEnd + 1 : markerEnd + gap;
    const body: Ln[] = [{ no: l.no, text: rest.trim() ? (gap >= 5 ? ' '.repeat(gap - 1) + rest : rest) : '' }];
    i++;
    // The item's other lines: indented to its content, or blank lines followed by such a line; a block parseWorkflow
    // opened inside the item (on its first line too) keeps all its lines here.
    let open = ctx.spans.get(l.no)?.end ?? -1;
    while (i < lines.length) {
      const c = lines[i];
      if (open >= 0 && c.no <= open) { body.push({ no: c.no, text: dedent(c.text, content) }); i++; continue; }
      if (ctx.spans.has(c.no) && indentOf(c.text) >= content) {
        open = ctx.spans.get(c.no)!.end;
        body.push({ no: c.no, text: dedent(c.text, content) });
        i++;
        continue;
      }
      if (blank(c.text)) {
        let k = i;
        while (k < lines.length && blank(lines[k].text)) k++;
        if (k < lines.length && indentOf(lines[k].text) >= content) { while (i < k) body.push({ no: lines[i].no, text: '' }), i++; continue; }
        break;
      }
      if (indentOf(c.text) < content) break;
      body.push({ no: c.no, text: dedent(c.text, content) });
      i++;
    }
    items.push(body);
    let last = body.length - 1;
    while (last > 0 && blank(body[last].text)) last--;
    if (body.slice(1, last).some((b) => blank(b.text) && !ctx.inSpan.has(b.no))) loose = true;
    // blank lines between items keep the list going
    let k = i;
    while (k < lines.length && blank(lines[k].text)) k++;
    if (k < lines.length && k > i) {
      const n = LIST.exec(lines[k].text);
      if (n && !THEMATIC.test(lines[k].text) && (n[3] !== undefined) === ordered && (ordered ? n[4] : n[2]) === kind) { i = k; loose = true; }
    }
  }
  // The item's first line may itself hold a block parseWorkflow found (`- ```bash [name:a]`): drawn in place.
  const html = items.map((body) => `<li>${renderBlocks(body, ctx, quoted, !loose, depth)}</li>`).join('');
  const startAt = ordered ? Number(first[3]) : 1;
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag} class="md-list"${ordered && startAt !== 1 ? ` start="${startAt}"` : ''}>${html}</${tag}>`, next: i };
}

// ── inline ────────────────────────────────────────────────────────────────────
//
// Every step here is linear in the text's length (the live board draws a document on every poll, on the REPL's
// thread): backtick runs, bracket pairs and the ends of link destinations are found once per text, what follows a
// destination is read once per place, a reference label is looked up only for brackets that hold no other bracket,
// delimiters are paired with a bounded stack, and no regular expression is run on a slice of the rest of the text.

interface Link { text: string; dest: string; end: number }

const SPACE = /\s/;
const TITLE = /"[^"]*"|'[^']*'|\([^()]*\)/y;
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y;
const BARE_URL = /https?:\/\/[^\s<]+/iy;
/** what ends a sentence after a bare address: not part of it */
const TRAILING = `?!.,:;*_~'"`;
/** CommonMark's longest link label */
const LABEL_MAX = 999;

/** Where each backtick run starts, by its length: the closing run of a code span is the next one of the same length. */
class Ticks {
  private readonly byLength = new Map<number, number[]>();
  constructor(s: string) {
    for (let i = 0; i < s.length;) {
      if (s[i] !== '`') { i++; continue; }
      let k = i;
      while (s[k] === '`') k++;
      const list = this.byLength.get(k - i) ?? [];
      list.push(i);
      this.byLength.set(k - i, list);
      i = k;
    }
  }
  /** The first run of exactly `n` backticks that starts at or after `from`, or -1. */
  next(from: number, n: number): number {
    const list = this.byLength.get(n);
    if (!list) return -1;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < from) lo = mid + 1; else hi = mid; }
    return lo < list.length ? list[lo] : -1;
  }
}

/**
 * A text's brackets, paired in one pass (backslash escapes and code spans skipped): `pair[i]` is the ']' that closes
 * the '[' at i, or -1; `plain[i]` is 1 when no other bracket sits between them (a reference label may hold none).
 */
function brackets(s: string, ticks: Ticks): { pair: Int32Array; plain: Uint8Array } {
  const pair = new Int32Array(s.length).fill(-1);
  const plain = new Uint8Array(s.length);
  const open: number[] = [];
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      let k = i;
      while (s[k] === '`') k++;
      const close = ticks.next(k, k - i);
      i = (close >= 0 ? close + (k - i) : k) - 1;
      continue;
    }
    if (c === '[') { open.push(i); last = i; } else if (c === ']') {
      if (open.length) { const o = open.pop()!; pair[o] = i; plain[o] = last === o ? 1 : 0; }
      last = i;
    }
  }
  return { pair, plain };
}

/**
 * Where a link destination that starts at each place of the text ends: at the first space, or at the first ')' it did
 * not open itself (escaped punctuation skipped). Found for every place in one pass, with the places still open kept
 * on a stack by their depth of parentheses (a ')' closes the places at its depth, a space all of them).
 */
function destinationEnds(s: string): Int32Array {
  const end = new Int32Array(s.length + 1).fill(s.length);
  const starts: number[] = [];
  const depths: number[] = [];
  let depth = 0;
  for (let q = 0; q < s.length; q++) {
    starts.push(q);
    depths.push(depth);
    const c = s[q];
    // A destination starts after '(' or a space, never on the character an escape takes (that one is not a place).
    if (c === '\\' && q + 1 < s.length && PUNCT.test(s[q + 1])) { q++; continue; }
    if (SPACE.test(c)) {
      for (const p of starts) end[p] = q;
      starts.length = 0;
      depths.length = 0;
      depth = 0;
    } else if (c === '(') depth++;
    else if (c === ')') {
      while (depths.length && depths[depths.length - 1] === depth) { end[starts.pop()!] = q; depths.pop(); }
      depth--;
    }
  }
  return end;
}

/** One text's links, read in time linear in its length: brackets paired once, destinations' ends found once, and
 *  what follows a destination (a title, then ')') read once per place. */
class LinkReader {
  private readonly pair: Int32Array;
  private readonly plain: Uint8Array;
  private ends?: Int32Array;
  private readonly tails = new Map<number, number>();
  constructor(private readonly s: string, ticks: Ticks, private readonly defs: Map<string, string>) {
    ({ pair: this.pair, plain: this.plain } = brackets(s, ticks));
  }

  /** `[text](dest)`, `[text][label]`, `[text][]` or `[label]` from `i` (at the `[`), with defined labels only. */
  at(i: number): Link | null {
    const { s, pair, plain, defs } = this;
    const j = pair[i];
    if (j < 0) return null;
    if (s[j + 1] === '(') {
      let k = j + 2;
      while (k < s.length && SPACE.test(s[k])) k++;
      let from = k;
      let to: number;
      let after: number;
      if (s[k] === '<') {
        let close = k + 1;
        while (close < s.length && s[close] !== '>' && s[close] !== '<' && s[close] !== '\n') close++;
        if (s[close] !== '>') return null;
        from = k + 1;
        to = close;
        after = close + 1;
      } else {
        to = after = (this.ends ??= destinationEnds(s))[k];
      }
      const end = this.tail(after);
      if (end < 0) return null;
      return { text: s.slice(i + 1, j), dest: s.slice(from, to).replace(/\\([!-/:-@[-`{-~])/g, '$1'), end };
    }
    if (!defs.size) return null;
    if (s[j + 1] === '[' && pair[j + 1] >= 0) {
      const close = pair[j + 1];
      // `[text][]` takes its text as the label; a label holds no bracket and at most 999 characters
      const [a, b] = close === j + 2 ? [i, j] : [j + 1, close];
      if (!plain[a] || b - a - 1 > LABEL_MAX) return null;
      const dest = defs.get(label(s.slice(a + 1, b)));
      return dest === undefined ? null : { text: s.slice(i + 1, j), dest, end: close + 1 };
    }
    if (!plain[i] || j - i - 1 > LABEL_MAX) return null;
    const text = s.slice(i + 1, j);
    const dest = defs.get(label(text));
    return dest === undefined ? null : { text, dest, end: j + 1 };
  }

  /** After a destination at `k`: spaces, an optional title, spaces and ')'. The place after the ')', or -1. */
  private tail(k: number): number {
    const known = this.tails.get(k);
    if (known !== undefined) return known;
    const { s } = this;
    let p = k;
    while (p < s.length && SPACE.test(s[p])) p++;
    TITLE.lastIndex = p;
    if (p > k && TITLE.test(s)) { p = TITLE.lastIndex; while (p < s.length && SPACE.test(s[p])) p++; }
    const end = s[p] === ')' ? p + 1 : -1;
    this.tails.set(k, end);
    return end;
  }
}

/** A bare http(s) address at `i`: up to a space or `<`, without the punctuation that ends a sentence. */
function bareUrl(s: string, i: number): string | null {
  BARE_URL.lastIndex = i;
  if (!BARE_URL.test(s)) return null;
  let end = BARE_URL.lastIndex;
  let opens = 0;
  let closes = 0;
  for (let k = i; k < end; k++) { if (s[k] === '(') opens++; else if (s[k] === ')') closes++; }
  while (end > i) {
    const last = s[end - 1];
    if (TRAILING.includes(last)) { end--; continue; }
    if (last === ')' && opens < closes) { end--; closes--; continue; }
    break;
  }
  return end - i > 'https://'.length ? s.slice(i, end) : null;
}

/**
 * Strong and emphasis in escaped text, in one pass: `**`/`__` and `*`/`_` runs that can open (followed by a non-space,
 * not preceded by a letter or digit) and close (preceded by a non-space, not followed by a letter or digit) are paired
 * with the nearest opener of the same kind; an opener left between a pair stays text. Marks inside a word stay text
 * for both `*` and `_` (so `2*3*4` is arithmetic, not emphasis), a deliberate narrowing of CommonMark. The stack is
 * searched at most 32 deep, so a run of unpaired marks stays linear.
 */
function emphasis(text: string): string {
  const tags = new Map<number, { len: number; html: string }>();
  const stack: Array<{ at: number; ch: string; n: number }> = [];
  const space = (c: string | undefined): boolean => c === undefined || SPACE.test(c);
  const word = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch !== '*' && ch !== '_') { i++; continue; }
    let j = i;
    while (text[j] === ch) j++;
    const n = j - i;
    const prev = text[i - 1];
    const next = text[j];
    const opens = !space(next) && !word(prev);
    const closes = !space(prev) && !word(next);
    if (n <= 2) {
      let paired = false;
      if (closes) {
        for (let k = stack.length - 1; k >= 0 && k >= stack.length - 32; k--) {
          if (stack[k].ch !== ch || stack[k].n !== n) continue;
          tags.set(stack[k].at, { len: n, html: n === 2 ? '<strong>' : '<em>' });
          tags.set(i, { len: n, html: n === 2 ? '</strong>' : '</em>' });
          stack.length = k;
          paired = true;
          break;
        }
      }
      if (!paired && opens) stack.push({ at: i, ch, n });
    }
    i = j;
  }
  if (!tags.size) return text;
  let out = '';
  for (let p = 0; p < text.length;) {
    const t = tags.get(p);
    if (t) { out += t.html; p += t.len; } else { out += text[p]; p++; }
  }
  return out;
}

/** Inline text as HTML: everything escaped; code, links, strong and emphasis drawn; nothing else. */
function inline(src: string, ctx: Ctx, inLink = false): string {
  const slots: string[] = [];
  const put = (html: string): string => `${slots.push(html) - 1}`;
  const s = src;
  const ticks = new Ticks(s);
  let links: LinkReader | undefined;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '') { out += put('<br>'); i++; continue; }
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { out += put(escapeHtml(s[i + 1])); i += 2; continue; }
    if (c === '`') {
      let k = i;
      while (s[k] === '`') k++;
      const n = k - i;
      const close = ticks.next(k, n);
      if (close >= 0) {
        let code = s.slice(k, close).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out += put(`<code class="md-c">${escapeHtml(code)}</code>`);
        i = close + n;
        continue;
      }
      out += s.slice(i, k);
      i = k;
      continue;
    }
    if (!inLink && (c === '[' || (c === '!' && s[i + 1] === '['))) {
      const image = c === '!';
      const l = (links ??= new LinkReader(s, ticks, ctx.defs)).at(image ? i + 1 : i);
      if (l) {
        const text = inline(l.text, ctx, true);
        out += put(linkHtml(image ? `image: ${text || escapeHtml(l.dest)}` : text || escapeHtml(l.dest), l.dest, ctx));
        i = l.end;
        continue;
      }
    }
    if (!inLink && c === '<') {
      AUTOLINK.lastIndex = i;
      const a = AUTOLINK.exec(s);
      if (a) { out += put(linkHtml(escapeHtml(a[1]), a[1], ctx)); i = AUTOLINK.lastIndex; continue; }
    }
    if (!inLink && (c === 'h' || c === 'H') && (i === 0 || /[\s(*_~"']/.test(s[i - 1]))) {
      const url = bareUrl(s, i);
      if (url) { out += put(linkHtml(escapeHtml(url), url, ctx)); i += url.length; continue; }
    }
    out += c;
    i++;
  }
  let html = emphasis(escapeHtml(out));
  for (let k = 0; k < 3 && html.includes(''); k++) html = html.replace(/(\d+)/g, (_, n: string) => slots[Number(n)] ?? '');
  return html;
}

/** A link's HTML: an http(s) address opens in a new tab, a project file is the caller's, anything else is text. */
function linkHtml(text: string, dest: string, ctx: Ctx): string {
  const t = linkTarget(dest, ctx.draw.doc);
  if (t.kind === 'web') return `<a class="md-a md-web" href="${escapeHtml(t.href)}" rel="noopener noreferrer" target="_blank">${text}</a>`;
  if (t.kind === 'file') return ctx.draw.file(t.rel, text);
  return `<span class="md-a md-nolink" title="${escapeHtml(`not a link here: ${t.why}`)}">${text}</span>`;
}
