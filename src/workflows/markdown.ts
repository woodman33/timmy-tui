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

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
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
 *  item's content, whose paragraphs are drawn without <p>. */
function renderBlocks(lines: Ln[], ctx: Ctx, quoted: boolean, tight = false): string {
  const out: string[] = [];
  let i = 0;
  const starts = (l: Ln): boolean => ctx.spans.has(l.no);
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
      const level = atx[1].length;
      const content = (atx[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim();
      out.push(heading(level, inline(content, ctx)));
      i++;
      continue;
    }
    if (THEMATIC.test(t)) { out.push('<hr class="md-hr">'); i++; continue; }
    if (QUOTE.test(t)) {
      const inner: Ln[] = [];
      while (i < lines.length && !starts(lines[i]) && QUOTE.test(lines[i].text)) {
        inner.push({ no: lines[i].no, text: lines[i].text.replace(/^ {0,3}> ?/, '') });
        i++;
      }
      out.push(`<blockquote class="md-quote">${renderBlocks(inner, ctx, true)}</blockquote>`);
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
    const item = LIST.exec(t);
    if (item) {
      const { html, next } = list(lines, i, ctx, quoted);
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
        if (ATX.test(c.text) || THEMATIC.test(c.text) || QUOTE.test(c.text) || COMMENT.test(c.text) || (quoted && FENCE.test(c.text))) break;
        const li = LIST.exec(c.text);
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

/** A paragraph line's end: two spaces or a backslash before the line break is a hard break (the  mark). */
function breakAt(line: string): string {
  if (/ {2,}$/.test(line) || /(?:^|[^\\])(?:\\\\)*\\$/.test(line)) return `${line.replace(/(?: {2,}|\\)$/, '').trimStart()}`;
  return line.trim();
}

/** Headings sit inside a card: the document's # is the card's own heading level, four, and so on down. */
function heading(level: number, html: string): string {
  const tag = level === 1 ? 'h4' : level === 2 ? 'h5' : 'h6';
  return `<${tag} class="md-h md-h${level}">${html}</${tag}>`;
}

/** A list starting at line `start`: its items, each drawn as blocks (one plain paragraph is drawn without <p>). */
function list(lines: Ln[], start: number, ctx: Ctx, quoted: boolean): { html: string; next: number } {
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
  const html = items.map((body) => `<li>${renderBlocks(body, ctx, quoted, !loose)}</li>`).join('');
  const startAt = ordered ? Number(first[3]) : 1;
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag} class="md-list"${ordered && startAt !== 1 ? ` start="${startAt}"` : ''}>${html}</${tag}>`, next: i };
}

// ── inline ────────────────────────────────────────────────────────────────────

interface Link { text: string; dest: string; end: number }

/** The closing run of exactly `n` backticks after `from`, or -1. */
function closingTicks(s: string, from: number, n: number): number {
  for (let j = s.indexOf('`', from); j >= 0; j = s.indexOf('`', j)) {
    let k = j;
    while (s[k] === '`') k++;
    if (k - j === n) return j;
    j = k;
  }
  return -1;
}

/** `[text](dest)`, `[text][label]`, `[text][]` or `[label]` from `i` (at the `[`), with defined labels only. */
function parseLink(s: string, i: number, defs: Map<string, string>): Link | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') { const n = /^`+/.exec(s.slice(j))![0].length; const close = closingTicks(s, j + n, n); if (close >= 0) { j = close + n - 1; continue; } j += n - 1; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (j >= s.length) return null;
  const text = s.slice(i + 1, j);
  if (s[j + 1] === '(') {
    let k = j + 2;
    while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
    let dest = '';
    if (s[k] === '<') {
      const close = s.indexOf('>', k);
      if (close < 0 || s.slice(k + 1, close).includes('\n') || s.slice(k + 1, close).includes('<')) return null;
      dest = s.slice(k + 1, close);
      k = close + 1;
    } else {
      let parens = 0;
      const from = k;
      for (; k < s.length; k++) {
        const c = s[k];
        if (c === '\\' && k + 1 < s.length) { k++; continue; }
        if (/\s/.test(c)) break;
        if (c === '(') parens++;
        else if (c === ')') { if (parens === 0) break; parens--; }
      }
      dest = s.slice(from, k);
    }
    while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
    const title = /^(?:"[^"]*"|'[^']*'|\([^()]*\))/.exec(s.slice(k));
    if (title) { k += title[0].length; while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++; }
    if (s[k] !== ')') return null;
    return { text, dest: dest.replace(/\\([!-/:-@[-`{-~])/g, '$1'), end: k + 1 };
  }
  if (s[j + 1] === '[') {
    const close = s.indexOf(']', j + 2);
    if (close < 0) return null;
    const ref = s.slice(j + 2, close) || text;
    const dest = defs.get(label(ref));
    return dest === undefined ? null : { text, dest, end: close + 1 };
  }
  const dest = defs.get(label(text));
  return dest === undefined ? null : { text, dest, end: j + 1 };
}

/** A bare http(s) address at `i`: up to a space or `<`, without the punctuation that ends a sentence. */
function bareUrl(s: string, i: number): string | null {
  const m = /^https?:\/\/[^\s<]+/i.exec(s.slice(i));
  if (!m) return null;
  let url = m[0];
  for (;;) {
    const last = url[url.length - 1];
    if (/[?!.,:;*_~'"]/.test(last)) { url = url.slice(0, -1); continue; }
    if (last === ')' && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) { url = url.slice(0, -1); continue; }
    break;
  }
  return url.length > 'https://'.length ? url : null;
}

/** Inline text as HTML: everything escaped; code, links, strong and emphasis drawn; nothing else. */
function inline(src: string, ctx: Ctx, inLink = false): string {
  const slots: string[] = [];
  const put = (html: string): string => `${slots.push(html) - 1}`;
  let out = '';
  let i = 0;
  const s = src;
  while (i < s.length) {
    const c = s[i];
    if (c === '') { out += put('<br>'); i++; continue; }
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { out += put(escapeHtml(s[i + 1])); i += 2; continue; }
    if (c === '`') {
      const n = /^`+/.exec(s.slice(i))![0].length;
      const close = closingTicks(s, i + n, n);
      if (close >= 0) {
        let code = s.slice(i + n, close).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out += put(`<code class="md-c">${escapeHtml(code)}</code>`);
        i = close + n;
        continue;
      }
      out += s.slice(i, i + n);
      i += n;
      continue;
    }
    if (!inLink && (c === '[' || (c === '!' && s[i + 1] === '['))) {
      const image = c === '!';
      const l = parseLink(s, image ? i + 1 : i, ctx.defs);
      if (l) {
        const text = inline(l.text, ctx, true);
        out += put(linkHtml(image ? `image: ${text || escapeHtml(l.dest)}` : text || escapeHtml(l.dest), l.dest, ctx));
        i = l.end;
        continue;
      }
    }
    if (!inLink && c === '<') {
      const a = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(s.slice(i));
      if (a) { out += put(linkHtml(escapeHtml(a[1]), a[1], ctx)); i += a[0].length; continue; }
    }
    if (!inLink && (c === 'h' || c === 'H') && (i === 0 || /[\s(*_~"']/.test(s[i - 1]))) {
      const url = bareUrl(s, i);
      if (url) { out += put(linkHtml(escapeHtml(url), url, ctx)); i += url.length; continue; }
    }
    out += c;
    i++;
  }
  let html = escapeHtml(out);
  html = html
    .replace(/\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?![\w])/g, '$1<em>$2</em>');
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
