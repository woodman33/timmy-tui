/**
 * Round R4 (H22): workflow documents on the board as small node graphs, and the live board's node editing.
 *
 * A workflow document is Markdown with named, runnable blocks (upmd; src/workflows/upmd.ts parseWorkflow).
 * On the board each document is drawn as a graph: its named blocks are the nodes (name, language and the
 * first lines of the command), its `deps:` are the edges, laid out left to right in dependency order. The
 * read-only snapshot shows the graph; the live board adds Run on each node (the existing run action) and,
 * for a document the board can rewrite safely, an editor: add, remove, rename and reorder blocks, edit a
 * block's command and language, add or remove a need. Save posts one structured edit ('save-workflow').
 *
 * What a save does, on the server (saveWorkflow), each step a refusal in plain words when it fails:
 * - the document must be one the board shows now: an existing .md workflow inside the project, reached
 *   through no symbolic link, and its bytes must still be the ones the editor started from (sha256);
 * - names are unique and well formed (letters, digits, _, . and -), each need names a block of the edited
 *   document, no block needs itself, the needs have no loop, and every size is bounded;
 * - the Markdown is rewritten block by block: every line outside the named blocks (prose, headings,
 *   unnamed code blocks) stays as it was, an unchanged block keeps its exact lines, and a changed block keeps
 *   its fence, indentation and any other attributes. The result is parsed again and must hold exactly the
 *   edited blocks and the same unnamed blocks, or nothing is written;
 * - the previous bytes are kept first, under .timmy/workflow-history/<document>/ (named .bak so they are not
 *   taken for workflows), then the document is replaced atomically, and an edit receipt is sealed.
 * Nothing here runs a block or any other command.
 */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { resolveInside, writeProjectFile } from '../project/index.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { ReceiptInput } from '../utils/receipts.js';
import { parseWorkflow, type WorkflowBlock } from '../workflows/upmd.js';
import { esc, type Kit } from './board-kit.js';

// ── bounds ───────────────────────────────────────────────────────────────────

/** A block name the board writes: letters, digits, _, . and -, starting and ending with a letter, digit or _. */
export const BLOCK_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_])?$/;
/** A block's language (the fence's first word); empty is allowed, as upmd's parser reads it. */
export const BLOCK_LANG = /^[A-Za-z0-9_+#.-]{0,32}$/;
export const MAX_BLOCKS = 64;
export const MAX_NEEDS = 32;
export const MAX_COMMAND = 32 * 1024;
/** A document the board rewrites: at most this large (findWorkflowDocs reads up to 1 MiB). */
export const MAX_EDIT_DOC = 256 * 1024;
/** Above this much command text in one document, the board draws it but does not carry it for editing. */
const MAX_EDIT_CODE = 128 * 1024;
/** The largest document a save may write. */
const MAX_DOC = 1024 * 1024;
/** How many nodes one graph draws; the list under it names every block. */
const GRAPH_MAX = 40;
export const HISTORY_DIR = '.timmy/workflow-history';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;

// ── the board's view of a document ───────────────────────────────────────────

/**
 * A named block as the board shows it. `code` is the whole command for an editable document, else its first
 * lines, with `lines` the command's whole length in lines.
 */
export interface NodeInput { name: string; deps: string[]; lang?: string; code?: string; index?: number; lines?: number }
/** A workflow document as the board shows it (src/repl/board.ts BoardWorkflow has the same shape). */
export interface WorkflowDocInput {
  rel: string;
  blocks: NodeInput[];
  /** the sha256 of the bytes the board read: what a save must still find */
  sha256?: string;
  /** why the live board cannot rewrite it; absent when it can (and `sha256` is known) */
  readOnly?: string;
}

/** The first `n` lines of a command, leading blank lines skipped. */
const firstLines = (code: string, n: number): string[] => {
  const lines = code.split('\n');
  const start = lines.findIndex((l) => l.trim() !== '');
  return start < 0 ? [] : lines.slice(start, start + n);
};
/** How many lines a command has from its first non-blank one (0 when it is blank). */
const lineCount = (code: string): number => {
  const lines = code.split('\n');
  const start = lines.findIndex((l) => l.trim() !== '');
  return start < 0 ? 0 : lines.length - start;
};

/** The first loop of needs, as a path back to its start; a need is the first block with that name. */
export function findLoop(blocks: ReadonlyArray<{ name: string; deps: readonly string[] }>): string[] | undefined {
  const first = new Map<string, number>();
  blocks.forEach((b, i) => { if (!first.has(b.name)) first.set(b.name, i); });
  const state = new Array<0 | 1 | 2>(blocks.length).fill(0);
  const path: number[] = [];
  const visit = (i: number): string[] | undefined => {
    state[i] = 1;
    path.push(i);
    for (const d of blocks[i].deps) {
      const j = first.get(d);
      if (j === undefined || state[j] === 2) continue;
      if (state[j] === 1) return [...path.slice(path.indexOf(j)).map((k) => blocks[k].name), blocks[j].name];
      const found = visit(j);
      if (found) return found;
    }
    path.pop();
    state[i] = 2;
    return undefined;
  };
  for (let i = 0; i < blocks.length; i++) {
    if (state[i] !== 0) continue;
    const found = visit(i);
    if (found) return found;
  }
  return undefined;
}

/**
 * A workflow document read for the board: its named blocks (document order) with their language and command,
 * and whether the live board can rewrite it. `read` is the document's text and the sha256 of its bytes, or
 * undefined when it could not be read whole.
 */
export function workflowForBoard(rel: string, read: { text: string; sha256?: string } | undefined): WorkflowDocInput {
  if (!read) return { rel, blocks: [], readOnly: 'it could not be read whole' };
  const named = parseWorkflow(read.text).filter((b): b is WorkflowBlock & { name: string } => b.name !== undefined);
  const total = named.reduce((n, b) => n + b.code.length, 0);
  const why = !read.sha256 ? 'its bytes could not be hashed'
    : Buffer.byteLength(read.text) > MAX_EDIT_DOC ? `it is larger than ${MAX_EDIT_DOC / 1024} KB`
      : named.length > MAX_BLOCKS ? `it has more than ${MAX_BLOCKS} named blocks`
        : named.some((b) => b.code.length > MAX_COMMAND) ? `a command is longer than ${MAX_COMMAND} characters`
          : total > MAX_EDIT_CODE ? `its commands hold more than ${MAX_EDIT_CODE / 1024} KB`
            : (() => { const s = segmentWorkflow(read.text); return s.ok ? undefined : s.why; })();
  return {
    rel,
    blocks: named.map((b) => ({ index: b.index, name: b.name, lang: b.lang, deps: b.deps, ...(why ? { code: firstLines(b.code, 3).join('\n'), lines: lineCount(b.code) } : { code: b.code }) })),
    ...(read.sha256 ? { sha256: read.sha256 } : {}),
    ...(why ? { readOnly: why } : {}),
  };
}

// ── the graph ────────────────────────────────────────────────────────────────

const NODE_W = 216;
const NODE_H = 78;
const GAP_X = 52;
const GAP_Y = 14;
const PAD = 6;
/** characters one line of a node holds at the graph's 12 px */
const CHARS = 27;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

export interface GraphLayout {
  nodes: Array<{ i: number; name: string; lang: string; lines: string[]; more: number; layer: number; row: number; x: number; y: number; missing: string[]; duplicate: boolean; loop: boolean }>;
  edges: Array<{ from: number; to: number; loop: boolean }>;
  width: number;
  height: number;
  /** the first loop of needs met, as a path back to its start */
  cycle?: string[];
  missing: Array<{ block: string; need: string }>;
  duplicates: string[];
  /** blocks not drawn (more than GRAPH_MAX) */
  hidden: number;
}

/**
 * Lays the blocks out left to right: a block's column is one more than the deepest block it needs, so every
 * edge runs forward; a loop's closing edge is marked instead. Within a column, blocks sit near what they need.
 * A need is resolved as upmd resolves it (the first block with that name).
 */
export function layoutGraph(blocks: NodeInput[]): GraphLayout {
  const shown = blocks.slice(0, GRAPH_MAX);
  const first = new Map<string, number>();
  shown.forEach((b, i) => { if (!first.has(b.name)) first.set(b.name, i); });
  const duplicates = [...new Set(shown.filter((b, i) => first.get(b.name) !== i).map((b) => b.name))];
  const missing: Array<{ block: string; need: string }> = [];
  const deps = shown.map((b) => b.deps.flatMap((d) => {
    const j = first.get(d);
    if (j === undefined) { missing.push({ block: b.name, need: d }); return []; }
    return [j];
  }));
  // Columns by depth; an edge into a block still being visited closes a loop and does not count.
  const layer = new Array<number>(shown.length).fill(-1);
  const state = new Array<0 | 1 | 2>(shown.length).fill(0);
  const loops = new Set<string>();
  let cycle: string[] | undefined;
  const path: number[] = [];
  const visit = (i: number): number => {
    if (state[i] === 2) return layer[i];
    state[i] = 1;
    path.push(i);
    let depth = 0;
    for (const j of deps[i]) {
      if (state[j] === 1) {
        loops.add(`${j}>${i}`);
        cycle ??= [...path.slice(path.indexOf(j)).map((k) => shown[k].name), shown[j].name];
        continue;
      }
      depth = Math.max(depth, visit(j) + 1);
    }
    path.pop();
    state[i] = 2;
    layer[i] = depth;
    return depth;
  };
  shown.forEach((_, i) => visit(i));
  const columns: number[][] = [];
  shown.forEach((_, i) => { (columns[layer[i]] ??= []).push(i); });
  const row = new Array<number>(shown.length).fill(0);
  columns.forEach((members, c) => {
    if (c > 0) {
      const at = (i: number): number => {
        const back = deps[i].filter((j) => layer[j] < c);
        return back.length ? back.reduce((s, j) => s + row[j], 0) / back.length : Number.POSITIVE_INFINITY;
      };
      members.sort((a, b) => (at(a) === at(b) ? a - b : at(a) - at(b)));
    }
    members.forEach((i, r) => { row[i] = r; });
  });
  const top = loops.size ? 30 : 0;
  const rows = Math.max(1, ...columns.map((m) => m?.length ?? 0));
  const cols = Math.max(1, columns.length);
  const onLoop = new Set<number>(cycle ? shown.flatMap((b, i) => (cycle!.includes(b.name) ? [i] : [])) : []);
  return {
    nodes: shown.map((b, i) => {
      const code = b.code ?? '';
      const lines = firstLines(code, 3);
      return {
        i, name: b.name, lang: b.lang ?? '', lines, more: Math.max(0, (b.lines ?? lineCount(code)) - lines.length), layer: layer[i], row: row[i],
        x: PAD + layer[i] * (NODE_W + GAP_X), y: PAD + top + row[i] * (NODE_H + GAP_Y),
        missing: missing.filter((m) => m.block === b.name).map((m) => m.need), duplicate: first.get(b.name) !== i, loop: onLoop.has(i),
      };
    }),
    edges: shown.flatMap((_, i) => deps[i].map((j) => ({ from: j, to: i, loop: loops.has(`${j}>${i}`) }))),
    width: PAD * 2 + cols * NODE_W + (cols - 1) * GAP_X,
    height: PAD * 2 + top + rows * NODE_H + (rows - 1) * GAP_Y,
    ...(cycle ? { cycle } : {}),
    missing, duplicates, hidden: Math.max(0, blocks.length - shown.length),
  };
}

/**
 * The graph as inline SVG: geometry in attributes and classes only (the live page's CSP allows no style
 * attribute), arrowheads as plain triangles (no marker reference, so nothing on the page names a url()).
 */
export function graphSvg(doc: string, blocks: NodeInput[]): string {
  const g = layoutGraph(blocks);
  const edges = g.edges.map((e) => {
    const a = g.nodes[e.from];
    const b = g.nodes[e.to];
    if (e.loop || a.layer >= b.layer) {
      const x1 = a.x + NODE_W / 2 - 12;
      const x2 = b.x + NODE_W / 2 + 12;
      const yTop = Math.min(a.y, b.y) - 26;
      return `<path class="wf-edge wf-edge-loop" d="M ${x1} ${a.y} C ${x1} ${yTop}, ${x2} ${yTop}, ${x2} ${b.y - 7}"/>`
        + `<path class="wf-arrow wf-arrow-loop" d="M ${x2} ${b.y} L ${x2 - 4} ${b.y - 7} L ${x2 + 4} ${b.y - 7} Z"/>`;
    }
    const sx = a.x + NODE_W;
    const sy = a.y + NODE_H / 2;
    const ex = b.x;
    const ey = b.y + NODE_H / 2;
    const c = Math.max(18, (ex - 7 - sx) / 2);
    return `<path class="wf-edge" d="M ${sx} ${sy} C ${sx + c} ${sy}, ${ex - 7 - c} ${ey}, ${ex - 7} ${ey}"/>`
      + `<path class="wf-arrow" d="M ${ex} ${ey} L ${ex - 7} ${ey - 4} L ${ex - 7} ${ey + 4} Z"/>`;
  }).join('');
  const nodes = g.nodes.map((n) => {
    const cls = ['wf-box', ...(n.missing.length ? ['wf-box-missing'] : []), ...(n.duplicate ? ['wf-box-dup'] : []), ...(n.loop ? ['wf-box-loop'] : [])].join(' ');
    const lang = n.lang ? cut(n.lang, 9) : '';
    const name = cut(n.name, CHARS - (lang ? lang.length + 1 : 0));
    const body = n.lines.length
      ? n.lines.slice(0, n.more ? 2 : 3).map((l, k) => `<text class="wf-code" x="${n.x + 10}" y="${n.y + 38 + k * 15}">${esc(cut(l.replace(/\t/g, '  '), CHARS))}</text>`).join('')
        + (n.more ? `<text class="wf-more" x="${n.x + 10}" y="${n.y + 68}">${esc(`+ ${n.more + 1} more line${n.more ? 's' : ''}`)}</text>` : '')
      : `<text class="wf-more" x="${n.x + 10}" y="${n.y + 38}">(an empty command)</text>`;
    return `<g class="wf-node"><title>${esc(`${n.name}${n.lang ? ` (${n.lang})` : ''}`)}</title><rect class="${cls}" x="${n.x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="6"/>`
      + `<text class="wf-name" x="${n.x + 10}" y="${n.y + 20}">${esc(name)}</text>${lang ? `<text class="wf-lang" x="${n.x + NODE_W - 10}" y="${n.y + 20}" text-anchor="end">${esc(lang)}</text>` : ''}${body}</g>`;
  }).join('');
  const label = cut(`${doc}: ${blocks.slice(0, GRAPH_MAX).map((b) => (b.deps.length ? `${b.name} (needs ${b.deps.join(', ')})` : b.name)).join('; ')}`, 400);
  return `<div class="wf-graph"><svg class="wf-svg" role="img" aria-label="${esc(label)}" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}">`
    + `${edges}${nodes}</svg></div>`;
}

/** What the graph found that will stop a run, in plain words. */
function graphWarnings(blocks: NodeInput[]): string[] {
  const g = layoutGraph(blocks);
  return [
    ...(g.cycle ? [`These blocks need each other in a loop: ${g.cycle.join(' → ')}. A loop cannot run.`] : []),
    ...g.missing.map((m) => `${m.block} needs ${m.need}, but no block is named ${m.need}.`),
    ...g.duplicates.map((d) => `Two blocks are named ${d}: upmd runs the first.`),
    ...(g.hidden ? [`The graph shows the first ${GRAPH_MAX} blocks; the list names all ${blocks.length}.`] : []),
  ];
}

/**
 * A workflow document's card: the graph, then each block with its needs, a Run button (live) and the /run
 * command; on the live board an editable document also carries its blocks as data for the editor (escaped
 * JSON in an attribute; the page reads it with JSON.parse, never as markup).
 */
export function renderWorkflowCard(w: WorkflowDocInput, k: Kit): string {
  const nodes = w.blocks;
  const items = nodes.map((b) => `<li><span class="block">${esc(b.name)}</span>${b.lang ? `<span class="lang">${esc(b.lang)}</span>` : ''}`
    + `${b.deps.length ? ` <span class="deps">${esc(`needs ${b.deps.join(', ')}`)}</span>` : ''}`
    + `${k.act('Run', { act: 'run', doc: w.rel, block: b.name })}${k.cmd(`/run ${w.rel} ${b.name}`)}</li>`).join('');
  const warnings = graphWarnings(nodes);
  const meta = [`${nodes.length} named block${nodes.length === 1 ? '' : 's'}`, ...(w.sha256 ? [`sha256 ${w.sha256.slice(0, 12)}`] : [])].join(' · ');
  const editable = k.live && !w.readOnly && w.sha256 !== undefined && nodes.every((b) => b.index !== undefined && b.code !== undefined);
  const data = editable ? ` data-wf-doc="${esc(w.rel)}" data-wf-sha="${esc(w.sha256)}" data-wf="${esc(JSON.stringify(nodes.map((b) => ({ index: b.index, name: b.name, lang: b.lang ?? '', deps: b.deps, code: b.code }))))}"` : '';
  const how = editable
    ? `<div class="wf-actions">${k.act('Edit blocks', { 'wf-edit': w.rel })}</div><div class="wf-editor" hidden></div>`
    : k.live
      ? `<p class="meta">${esc(`The board does not edit this document: ${w.readOnly ?? 'its blocks were not read whole'}. /edit ${w.rel} opens your editor.`)}</p>`
      : `<p class="meta">${esc(`Read-only here: /board live edits its blocks${w.readOnly ? ` (not this one: ${w.readOnly})` : ''}; /edit ${w.rel} opens your editor.`)}</p>`;
  return `<article class="card wide wf"${data}>${k.fileLink(w.rel)}<div class="meta"><span class="kind">workflow</span> ${esc(meta)}</div>`
    + `${nodes.length ? graphSvg(w.rel, nodes) : ''}${warnings.map((x) => `<p class="wf-warn">${esc(x)}</p>`).join('')}`
    + `<ol class="blocks">${items}</ol>${how}${k.cmds([`/open ${w.rel}`])}</article>`;
}

// ── the Markdown, block by block ─────────────────────────────────────────────

interface SrcLine { text: string; eol: string }

/** Lines with their own endings ('\n', '\r\n', or '' for a last line without one), as parseWorkflow counts them. */
function splitLines(src: string): SrcLine[] {
  const out: SrcLine[] = [];
  let i = 0;
  while (i < src.length) {
    const j = src.indexOf('\n', i);
    if (j < 0) { out.push({ text: src.slice(i), eol: '' }); break; }
    const crlf = j > i && src[j - 1] === '\r';
    out.push({ text: src.slice(i, crlf ? j - 1 : j), eol: crlf ? '\r\n' : '\n' });
    i = j + 1;
  }
  return out;
}

/** A named block's place in the document. */
export interface Slot {
  index: number; name: string; lang: string; deps: string[]; depsExpr?: string; code: string;
  /** 0-based lines of its opening and closing fences */
  open: number; close: number;
  indent: string; fenceChar: string; fenceSize: number;
  /** the info string after the fence, trimmed */
  info: string;
}

const OPEN_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const CLOSE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const stripSpaces = (line: string, n: number): string => { let i = 0; while (i < n && line[i] === ' ') i++; return line.slice(i); };

export type Segmented = { ok: true; lines: SrcLine[]; slots: Slot[]; eol: string; unnamed: Array<{ lang: string; code: string }> } | { ok: false; why: string };

/**
 * The document cut into its named blocks and everything else, or why the board cannot rewrite it. Each
 * named block must be a fence of its own (0 to 3 spaces of indentation, a closing fence) whose lines read
 * back exactly as parseWorkflow read them, and no other block may start inside it.
 */
export function segmentWorkflow(text: string): Segmented {
  const lines = splitLines(text);
  const blocks = parseWorkflow(text);
  const slots: Slot[] = [];
  let after = -1;
  for (const b of blocks) {
    if (b.name === undefined) continue;
    const o = b.line - 1;
    const m = o > after && o < lines.length ? OPEN_LINE.exec(lines[o].text) : null;
    if (!m) return { ok: false, why: `block ${b.name} (line ${b.line}) is inside a list or a layout the board does not rewrite` };
    const char = m[2][0];
    const size = m[2].length;
    let close = -1;
    for (let k = o + 1; k < lines.length; k++) {
      const c = CLOSE_LINE.exec(lines[k].text);
      if (c && c[1][0] === char && c[1].length >= size) { close = k; break; }
    }
    if (close < 0) return { ok: false, why: `block ${b.name} (line ${b.line}) has no closing fence` };
    const indent = m[1];
    if (lines.slice(o + 1, close).map((l) => stripSpaces(l.text, indent.length)).join('\n') !== b.code) {
      return { ok: false, why: `block ${b.name} (line ${b.line}) does not read back exactly (a list or an indented layout)` };
    }
    slots.push({ index: b.index, name: b.name, lang: b.lang, deps: b.deps, ...(b.depsExpr !== undefined ? { depsExpr: b.depsExpr } : {}), code: b.code, open: o, close, indent, fenceChar: char, fenceSize: size, info: m[3].trim() });
    after = close;
  }
  for (const b of blocks) {
    const o = b.line - 1;
    if (slots.some((s) => o > s.open && o <= s.close)) return { ok: false, why: `a block starts inside block ${slots.find((s) => o > s.open && o <= s.close)!.name}` };
  }
  return { ok: true, lines, slots, eol: lines.some((l) => l.eol === '\r\n') ? '\r\n' : '\n', unnamed: blocks.filter((b) => b.name === undefined).map((b) => ({ lang: b.lang, code: b.code })) };
}

/** A block as the editor sends it: `from` is the block's index in the document as read, absent for a new one. */
export interface EditBlock { from?: number; name: string; lang: string; needs: string[]; command: string }

const ATTR = /\s*([A-Za-z_][\w-]*)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,\]]*))\s*(,|\]|$)/y;
const NAME_TOKEN = /[\p{L}\p{N}_](?:[\p{L}\p{N}_.:/-]*[\p{L}\p{N}_])?/gu;
const quoteValue = (v: string): string | null => (/^[A-Za-z0-9_.-]+$/.test(v) ? v : !v.includes('"') ? `"${v}"` : !v.includes("'") ? `'${v}'` : null);

/**
 * The info string for a block: its language, then the attribute list with `name` and `deps` set and every
 * other attribute kept as written. `deps` is the text to write after `deps:` (already quoted), or null for none.
 */
function infoFor(original: string | undefined, lang: string, name: string, deps: string | null): string {
  const pieces: Array<{ key: string; raw: string }> = [];
  let rest = '';
  if (original !== undefined) {
    const word = /^[^\s\[]*/.exec(original)![0];
    const open = original.indexOf('[', word.length);
    if (open >= 0) {
      ATTR.lastIndex = open + 1;
      let end = open + 1;
      for (let m = ATTR.exec(original); m; m = ATTR.exec(original)) {
        pieces.push({ key: m[1], raw: original.slice(end, ATTR.lastIndex - (m[5] ? 1 : 0)).trim() });
        end = ATTR.lastIndex;
        if (m[5] !== ',') break;
      }
      rest = original.slice(end).trim();
    }
  }
  const out: string[] = [];
  let named = false;
  let depped = false;
  for (const p of pieces) {
    if (p.key === 'name' && !named) { out.push(`name:${name}`); named = true; continue; }
    if (p.key === 'deps' && !depped) { if (deps !== null) out.push(`deps:${deps}`); depped = true; continue; }
    out.push(p.raw);
  }
  if (!named) out.unshift(`name:${name}`);
  if (!depped && deps !== null) out.splice(out.indexOf(`name:${name}`) + 1, 0, `deps:${deps}`);
  return `${lang}${lang ? ' ' : ''}[${out.join(', ')}]${rest ? ` ${rest}` : ''}`;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The text after `deps:` for an edited block: the original expression when only renames touched it, else a new one. */
function depsText(e: EditBlock, orig: Slot | undefined, renames: Map<string, string>): string | null {
  if (orig && sameList(orig.deps.map((d) => renames.get(d) ?? d), e.needs)) {
    if (orig.depsExpr === undefined || !orig.deps.length) return null;
    const expr = orig.deps.some((d) => renames.has(d)) ? orig.depsExpr.replace(NAME_TOKEN, (t) => renames.get(t) ?? t) : orig.depsExpr;
    const tokens = [...new Set(expr.match(NAME_TOKEN) ?? [])];
    const q = quoteValue(expr);
    if (q !== null && sameList(tokens, e.needs)) return q;
  }
  if (!e.needs.length) return null;
  return e.needs.length === 1 ? e.needs[0] : `"${e.needs.join(' | ')}"`;
}

/** The longest run of `ch` at the start of any line (after its indentation): a fence must be longer. */
const longestRun = (code: string, ch: string): number => code.split('\n').reduce((n, l) => {
  const m = /^[ \t]*([`~]+)/.exec(l);
  return m && m[1][0] === ch ? Math.max(n, /^([`~])\1*/.exec(m[1])![0].length) : n;
}, 0);

/** The lines of an edited block, at `indent`, keeping the original's fence character where it can. */
function blockLines(e: EditBlock, indent: string, orig: Slot | undefined, deps: string | null, eol: string, keepInfo: boolean): SrcLine[] {
  const info = keepInfo && orig ? orig.info : infoFor(orig?.info, e.lang, e.name, deps);
  let ch = orig?.fenceChar ?? '`';
  if (ch === '`' && info.includes('`')) ch = '~';
  const size = Math.max(orig && orig.fenceChar === ch ? orig.fenceSize : 3, longestRun(e.command, ch) + 1);
  const fence = ch.repeat(size);
  const body = e.command === '' ? [] : e.command.split('\n').map((l) => ({ text: l === '' ? '' : indent + l, eol }));
  return [{ text: `${indent}${fence}${info}`, eol }, ...body, { text: `${indent}${fence}`, eol }];
}

export type Rewritten = { ok: true; text: string; changes: string[] } | { ok: false; why: string };

/**
 * The document with its named blocks replaced by `edits` (already checked by checkEdits), prose unchanged.
 * Kept blocks stay in their own places unless the edit reorders them; then the places are filled in the new
 * order. A new block goes right after the block before it in the list (a new first block, before the first).
 * A removed block's place goes, with one of the blank lines around it.
 */
export function rewriteWorkflow(text: string, seg: Extract<Segmented, { ok: true }>, edits: EditBlock[]): Rewritten {
  const byIndex = new Map(seg.slots.map((s) => [s.index, s]));
  const firstOfName = new Map<string, Slot>();
  for (const s of seg.slots) if (!firstOfName.has(s.name)) firstOfName.set(s.name, s);
  const renames = new Map<string, string>();
  for (const e of edits) {
    const o = e.from !== undefined ? byIndex.get(e.from) : undefined;
    if (o && o.name !== e.name && firstOfName.get(o.name) === o) renames.set(o.name, e.name);
  }
  const keptInEdits = edits.filter((e) => e.from !== undefined);
  const keptSlots = seg.slots.filter((s) => keptInEdits.some((e) => e.from === s.index));
  const reordered = keptInEdits.some((e, i) => i > 0 && e.from! < keptInEdits[i - 1].from!);
  const fill = new Map<Slot, EditBlock>();
  keptSlots.forEach((s, i) => fill.set(s, reordered ? keptInEdits[i] : keptInEdits.find((e) => e.from === s.index)!));
  // New blocks: after the nearest kept block before them in the list, or before the first kept place.
  const after = new Map<EditBlock, EditBlock[]>();
  const before: EditBlock[] = [];
  let anchor: EditBlock | undefined;
  for (const e of edits) {
    if (e.from !== undefined) { anchor = e; continue; }
    if (anchor) { const list = after.get(anchor) ?? []; list.push(e); after.set(anchor, list); } else before.push(e);
  }
  const unchanged = (e: EditBlock, o: Slot): boolean => e.name === o.name && e.lang === o.lang && e.command === o.code
    && depsText(e, o, renames) === (o.depsExpr === undefined || !o.deps.length ? null : quoteValue(o.depsExpr) ?? '\0');
  const out: SrcLine[] = [];
  const emit = (e: EditBlock, indent: string, own?: Slot): void => {
    const o = e.from !== undefined ? byIndex.get(e.from) : undefined;
    if (o && own === o && unchanged(e, o)) { out.push(...seg.lines.slice(o.open, o.close + 1)); return; }
    const keepInfo = !!o && unchanged(e, o);
    out.push(...blockLines(e, indent, o, depsText(e, o, renames), seg.eol, keepInfo));
  };
  const blank = (): SrcLine => ({ text: '', eol: seg.eol });
  const isBlank = (l: SrcLine | undefined): boolean => l !== undefined && l.text.trim() === '';
  let i = 0;
  seg.slots.forEach((s, n) => {
    out.push(...seg.lines.slice(i, s.open));
    i = s.close + 1;
    const e = fill.get(s);
    if (e) {
      if (s === keptSlots[0]) for (const b of before) { emit(b, s.indent); out.push(blank()); }
      emit(e, s.indent, s);
      for (const b of after.get(e) ?? []) { out.push(blank()); emit(b, s.indent); }
      return;
    }
    if (!keptSlots.length && n === 0) {
      before.forEach((b, k) => { if (k) out.push(blank()); emit(b, s.indent); });
      return;
    }
    // A removed block: one of the blank lines around it goes with it.
    if (isBlank(seg.lines[i]) && (!out.length || isBlank(out[out.length - 1]))) i++;
    else if (i >= seg.lines.length && isBlank(out[out.length - 1])) out.pop();
  });
  out.push(...seg.lines.slice(i));
  // The document keeps its final-newline state; every other line ends with one.
  const finalEol = seg.lines.length ? seg.lines[seg.lines.length - 1].eol : seg.eol;
  const next = out.map((l, k) => l.text + (k === out.length - 1 ? finalEol : l.eol || seg.eol)).join('');
  // Read back: exactly the edited blocks, the same unnamed blocks, and a document the board can edit again.
  const back = parseWorkflow(next);
  const named = back.filter((b) => b.name !== undefined);
  const want = edits.map((e) => ({ name: e.name, lang: e.lang, deps: e.needs, code: e.command }));
  const got = named.map((b) => ({ name: b.name!, lang: b.lang, deps: b.deps, code: b.code }));
  const diff = want.length !== got.length ? `${got.length} named blocks read back, ${want.length} written`
    : want.map((w, k) => (w.name !== got[k].name ? `block ${k + 1} reads back as ${got[k].name}` : w.lang !== got[k].lang ? `${w.name}'s language reads back as ${got[k].lang || 'none'}`
      : !sameList(w.deps, got[k].deps) ? `${w.name}'s needs read back as ${got[k].deps.join(', ') || 'none'}` : w.code !== got[k].code ? `${w.name}'s command does not read back exactly` : '')).find(Boolean);
  if (diff) return { ok: false, why: diff };
  const unnamed = back.filter((b) => b.name === undefined).map((b) => ({ lang: b.lang, code: b.code }));
  if (unnamed.length !== seg.unnamed.length || unnamed.some((u, k) => u.lang !== seg.unnamed[k].lang || u.code !== seg.unnamed[k].code)) return { ok: false, why: 'an unnamed code block would read differently' };
  const again = segmentWorkflow(next);
  if (!again.ok) return { ok: false, why: `the result could not be edited again (${again.why})` };
  return { ok: true, text: next, changes: describeChanges(seg.slots, edits, reordered || before.length > 0 || [...after.values()].some((l) => l.length > 0)) };
}

/** What an edit changes, in plain words, from the blocks as read to the blocks as edited. */
function describeChanges(slots: Slot[], edits: EditBlock[], orderMoved: boolean): string[] {
  const out: string[] = [];
  const byIndex = new Map(slots.map((s) => [s.index, s]));
  const kept = new Set(edits.flatMap((e) => (e.from !== undefined ? [e.from] : [])));
  for (const e of edits) {
    const o = e.from !== undefined ? byIndex.get(e.from) : undefined;
    if (!o) { out.push(`added ${e.name}${e.needs.length ? ` (needs ${e.needs.join(', ')})` : ''}`); continue; }
    if (o.name !== e.name) out.push(`renamed ${o.name} to ${e.name}`);
    if (o.lang !== e.lang) out.push(`${e.name}'s language ${o.lang || 'none'} → ${e.lang || 'none'}`);
    if (o.code !== e.command) {
      const a = o.code === '' ? 0 : o.code.split('\n').length;
      const b = e.command === '' ? 0 : e.command.split('\n').length;
      out.push(`edited ${e.name}'s command (${a} → ${b} line${b === 1 ? '' : 's'})`);
    }
    const renamedDeps = o.deps.map((d) => edits.find((x) => x.from !== undefined && byIndex.get(x.from)?.name === d && byIndex.get(x.from)!.name !== x.name)?.name ?? d);
    if (!sameList(renamedDeps, e.needs)) out.push(`${e.name} ${e.needs.length ? `now needs ${e.needs.join(', ')}` : 'now needs nothing'} (was ${o.deps.join(', ') || 'nothing'})`);
  }
  for (const s of slots) if (!kept.has(s.index)) out.push(`removed ${s.name}`);
  if (orderMoved) out.push(`order: ${edits.map((e) => e.name).join(', ')}`);
  return out;
}

// ── checking an edit ─────────────────────────────────────────────────────────

export type Checked<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = <T>(status: number, error: string): Checked<T> => ({ ok: false, status, error });
const keysWithin = (o: Record<string, unknown>, allowed: string[], required: string[]): boolean =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(o, k));

/**
 * The editor's blocks checked against the document as read (its slots): shapes and sizes, names unique and
 * well formed, every need a block of the edited document, no block needing itself, no loop.
 */
export function checkEdits(raw: unknown, slots: Slot[]): Checked<EditBlock[]> {
  if (!Array.isArray(raw) || !raw.length) return no(422, 'A workflow keeps at least one named block; to remove the document, use your editor.');
  if (raw.length > MAX_BLOCKS) return no(422, `A document the board edits has at most ${MAX_BLOCKS} blocks.`);
  const indexes = new Set(slots.map((s) => s.index));
  const used = new Set<number>();
  const blocks: EditBlock[] = [];
  for (const [k, item] of raw.entries()) {
    const at = `block ${k + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return no(400, `${at} is not an object.`);
    const o = item as Record<string, unknown>;
    if (!keysWithin(o, ['from', 'name', 'lang', 'needs', 'command'], ['name', 'lang', 'needs', 'command'])) return no(400, `${at} is {"from"?, "name", "lang", "needs", "command"} and nothing else.`);
    if (o.from !== undefined) {
      if (typeof o.from !== 'number' || !Number.isInteger(o.from) || !indexes.has(o.from)) return no(400, `${at} names block ${String(o.from)}, which is not a named block of the document as the board read it.`);
      if (used.has(o.from)) return no(400, `Block ${o.from} of the document is sent twice.`);
      used.add(o.from);
    }
    if (typeof o.name !== 'string' || typeof o.lang !== 'string' || typeof o.command !== 'string' || !Array.isArray(o.needs)) return no(400, `${at}: name, lang and command are text, needs a list of names.`);
    if (!BLOCK_NAME.test(o.name)) return no(422, `${JSON.stringify(o.name.slice(0, 80))} is not a block name: use letters, digits, _, . and - (up to 64), starting and ending with a letter, digit or _.`);
    if (!BLOCK_LANG.test(o.lang)) return no(422, `${o.name}'s language ${JSON.stringify(o.lang.slice(0, 40))} is not one word of letters, digits, _, +, #, . or - (up to 32).`);
    if (o.command.length > MAX_COMMAND) return no(422, `${o.name}'s command is longer than ${MAX_COMMAND} characters.`);
    if (CONTROL.test(o.command)) return no(422, `${o.name}'s command holds a carriage return or another control character.`);
    if (o.needs.length > MAX_NEEDS) return no(422, `${o.name} needs more than ${MAX_NEEDS} blocks.`);
    const needs: string[] = [];
    for (const n of o.needs) {
      if (typeof n !== 'string' || !n || n.length > 64 || CONTROL.test(n)) return no(400, `${o.name}'s needs are block names.`);
      if (!needs.includes(n)) needs.push(n);
    }
    blocks.push({ ...(o.from !== undefined ? { from: o.from as number } : {}), name: o.name, lang: o.lang, needs, command: o.command });
  }
  const names = new Set<string>();
  for (const b of blocks) {
    if (names.has(b.name)) return no(422, `Two blocks are named ${b.name}: each name is used once.`);
    names.add(b.name);
  }
  for (const b of blocks) {
    if (b.needs.includes(b.name)) return no(422, `${b.name} needs itself.`);
    const ghost = b.needs.find((n) => !names.has(n));
    if (ghost !== undefined) return no(422, `${b.name} needs ${ghost}, but no block is named ${ghost}.`);
  }
  const loop = findLoop(blocks.map((b) => ({ name: b.name, deps: b.needs })));
  if (loop) return no(422, `These blocks need each other in a loop: ${loop.join(' → ')}. A workflow runs in order, so a loop cannot run.`);
  return { ok: true, value: blocks };
}

// ── saving ───────────────────────────────────────────────────────────────────

export interface EditContext {
  root: string;
  project: string;
  projectId: string;
  /** the workflow documents the board shows now, relative to the project */
  workflows: readonly string[];
  /** the recipes whose parameter card the board shows now ('tray') */
  recipes: readonly string[];
  /** seals the edit's receipt on the runs chain; its short id back */
  seal?: (input: ReceiptInput) => string | undefined;
}
/** An edit's answer: the HTTP status, the page's text, and one line for the REPL's transcript. */
export interface EditAnswer { status: number; text: string; line: string }

const answer = (status: number, text: string, line = text): EditAnswer => ({ status, text, line });
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The document's place, checked: a workflow the board shows, an existing regular .md file inside the project,
 * reached through no symbolic link (neither the file nor a folder on its way).
 */
export function docPlace(root: string, doc: string, shown: readonly string[]): Checked<{ abs: string; rel: string; mode: number }> {
  if (!shown.includes(doc)) return no(404, `No workflow ${doc} on this board: /workflows lists them.`);
  if (!/\.(md|markdown)$/i.test(doc)) return no(422, `${doc} is not a Markdown document.`);
  // Containment first (a path or a link that leads outside the project is refused here).
  const at = resolveInside(root, doc);
  if ('error' in at) return no(403, `Refused: ${at.error}.`);
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return no(500, 'The project folder is gone.'); }
  if (doc.split('/').some((p) => !p || p === '.' || p === '..')) return no(403, `Refused: ${doc} is not a plain path inside the project.`);
  // Then in place: the file as named is a regular file, not a link, and no folder on its way is a link.
  const abs = join(realRoot, ...doc.split('/'));
  let st;
  try { st = lstatSync(abs); } catch { return no(404, `${doc} is not there any more.`); }
  if (st.isSymbolicLink()) return no(403, `Refused: ${doc} is a symbolic link; the board edits a document only in place.`);
  if (!st.isFile()) return no(403, `Refused: ${doc} is not a regular file.`);
  let real: string;
  try { real = realpathSync(abs); } catch { return no(404, `${doc} cannot be resolved.`); }
  if (real !== abs || relative(realRoot, real).split(sep).join('/') !== doc) return no(403, `Refused: ${doc} is reached through a symbolic link; the board edits a document only in place.`);
  return { ok: true, value: { abs, rel: doc, mode: st.mode & 0o7777 } };
}

/** Keeps the previous bytes under .timmy/workflow-history/<doc>/, never over another kept version. */
export function keepPrevious(root: string, doc: string, bytes: Buffer): { ok: true; rel: string } | { ok: false; error: string } {
  const when = new Date().toISOString().replace(/[:.]/g, '-');
  const h = sha(bytes).slice(0, 12);
  for (let n = 1; n <= 20; n++) {
    const rel = `${HISTORY_DIR}/${doc}/${when}-${h}${n > 1 ? `-${n}` : ''}${extname(doc)}.bak`;
    const at = resolveInside(root, rel);
    if ('error' in at) return { ok: false, error: at.error };
    let fd: number | undefined;
    try {
      mkdirSync(dirname(at.path), { recursive: true });
      const realRoot = realpathSync(root);
      const realDir = realpathSync(dirname(at.path));
      if (!realDir.startsWith(realRoot + sep)) return { ok: false, error: `${HISTORY_DIR} leads outside the project` };
      fd = openSync(at.path, 'wx', 0o644);
      writeSync(fd, bytes);
      closeSync(fd);
      fd = undefined;
      if (sha(readFileSync(at.path)) !== sha(bytes)) return { ok: false, error: `${rel} reads back differently` };
      return { ok: true, rel: at.rel };
    } catch (e) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { ok: false, error: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
    }
  }
  return { ok: false, error: 'no free name for the kept version' };
}

/**
 * `save-workflow`: {"action":"save-workflow","doc":"<path>","sha256":"<the bytes the editor started from>",
 * "blocks":[{"from"?:<index>,"name","lang","needs":[…],"command"}…]}. Checked, rewritten, verified, the old
 * bytes kept, then written atomically and sealed; the answer says what changed, or why nothing was written.
 */
export function saveWorkflow(body: Record<string, unknown>, ctx: EditContext): EditAnswer {
  if (!keysWithin(body, ['action', 'doc', 'sha256', 'blocks'], ['action', 'doc', 'sha256', 'blocks'])
    || typeof body.doc !== 'string' || !body.doc || body.doc.length > 512 || CONTROL.test(body.doc) || typeof body.sha256 !== 'string') {
    return answer(400, 'A save is {"action":"save-workflow","doc":"<workflow>","sha256":"<its sha256>","blocks":[…]}.');
  }
  const doc = body.doc;
  if (!HEX64.test(body.sha256)) return answer(400, 'sha256 is the 64 hex characters of the document as the board read it.');
  const place = docPlace(ctx.root, doc, ctx.workflows);
  if (!place.ok) return answer(place.status, place.error, `refused an edit of ${doc}: ${place.error}`);
  let bytes: Buffer;
  try {
    if (statSync(place.value.abs).size > MAX_EDIT_DOC) return answer(422, `${doc} is larger than ${MAX_EDIT_DOC / 1024} KB: edit it with /edit ${doc}.`);
    bytes = readFileSync(place.value.abs);
  } catch (e) { return answer(500, `${doc} could not be read: ${(e as NodeJS.ErrnoException).code ?? 'error'}.`); }
  const before = sha(bytes);
  if (before !== body.sha256) return answer(409, `${doc} changed since the board read it (it is now sha256 ${before.slice(0, 12)}); nothing was written. Your edits stay in the editor: Discard shows the document as it is now.`, `refused an edit of ${doc}: it changed since the board read it`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return answer(422, `${doc} is not UTF-8 text: edit it with /edit ${doc}.`);
  const seg = segmentWorkflow(text);
  if (!seg.ok) return answer(422, `The board cannot rewrite ${doc} safely: ${seg.why}. Nothing was written; /edit ${doc} opens your editor.`, `refused an edit of ${doc}: ${seg.why}`);
  const checked = checkEdits(body.blocks, seg.slots);
  if (!checked.ok) return answer(checked.status, `Refused: ${checked.error} Nothing was written.`, `refused an edit of ${doc}: ${checked.error}`);
  const next = rewriteWorkflow(text, seg, checked.value);
  if (!next.ok) return answer(422, `Refused: the rewritten ${doc} did not read back as edited (${next.why}). Nothing was written.`, `refused an edit of ${doc}: ${next.why}`);
  if (next.text === text) return answer(200, `No change: ${doc} already holds these blocks (sha256 ${before.slice(0, 12)}); nothing was written.`, `no change to ${doc}`);
  if (Buffer.byteLength(next.text) > MAX_DOC) return answer(422, `Refused: ${doc} would be larger than 1 MiB. Nothing was written.`);
  const kept = keepPrevious(ctx.root, doc, bytes);
  if (!kept.ok) return answer(500, `Nothing was written: the previous version of ${doc} could not be kept (${kept.error}).`);
  // The document must still be the bytes that were kept, right before it is replaced.
  try { if (sha(readFileSync(place.value.abs)) !== before) return answer(409, `${doc} changed while it was being saved; nothing was written over it (the version the editor started from is kept at ${kept.rel}).`); } catch { return answer(409, `${doc} went away while it was being saved; nothing was written.`); }
  const w = writeProjectFile(ctx.root, doc, next.text);
  if (!w.ok) return answer(500, `${doc} could not be written (${w.error}); the previous version is kept at ${kept.rel}.`);
  const after = w.sha256;
  let receipt: string | undefined;
  try {
    receipt = ctx.seal?.({
      kind: 'edit', subject: `edit · ${doc} · workflow blocks from the live board`, policy: 'human-gated', status: 'ok', project: ctx.project, project_id: ctx.projectId,
      files: [{ path: doc, sha256: after, previous_sha256: before, created: false, bytes: w.bytes }],
      sources: [{ path: kept.rel, sha256: before, role: 'previous version' }],
    });
  } catch { receipt = undefined; }
  const said = next.changes.length ? next.changes.join('; ') : 'its layout';
  return answer(200,
    `Saved ${doc}: ${said}. sha256 ${after.slice(0, 12)} (was ${before.slice(0, 12)}); the previous version is kept at ${kept.rel}${receipt ? `; receipt ${receipt}` : '; no receipt was sealed'}.`,
    `saved ${doc}: ${said}${receipt ? ` · receipt ${receipt}` : ''}`);
}

// ── the look ─────────────────────────────────────────────────────────────────

export const NODES_CSS = `
.wf .wf-graph { overflow-x: auto; background: ${HOMEBREW.ground}; border: 1px solid ${HOMEBREW.line}; border-radius: 6px; padding: 4px; }
.wf-svg { display: block; font-family: ${TYPE.stack}; }
.wf-box { fill: ${HOMEBREW.raised}; stroke: ${HOMEBREW.lineStrong}; stroke-width: 1; }
.wf-box-missing { stroke: ${HOMEBREW.attention}; stroke-dasharray: 4 3; }
.wf-box-dup { stroke: ${HOMEBREW.attention}; }
.wf-box-loop { stroke: ${HOMEBREW.failure}; stroke-width: 1.5; }
.wf-name { fill: ${HOMEBREW.text}; font-size: 12.5px; font-weight: ${TYPE.weight.strong}; }
.wf-lang { fill: ${HOMEBREW.textSecondary}; font-size: 11px; }
.wf-code { fill: ${HOMEBREW.textSecondary}; font-size: 11.5px; white-space: pre; }
.wf-more { fill: ${HOMEBREW.textSecondary}; font-size: 11px; font-style: italic; }
.wf-edge { fill: none; stroke: ${HOMEBREW.lineStrong}; stroke-width: 1.4; }
.wf-edge-loop { stroke: ${HOMEBREW.failure}; stroke-dasharray: 5 4; }
.wf-arrow { fill: ${HOMEBREW.lineStrong}; }
.wf-arrow-loop { fill: ${HOMEBREW.failure}; }
.wf-warn { margin: 0; color: ${HOMEBREW.attention}; font-size: ${TYPE.size.small}px; }
.blocks .lang { display: inline-block; border: 1px solid ${HOMEBREW.line}; border-radius: 999px; padding: 0 6px; margin-right: 8px; font-size: 11px; color: ${HOMEBREW.textSecondary}; }
`;
