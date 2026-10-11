/**
 * upmd adapter: Timmy drives the operator's installed upmd instead of rebuilding it. upmd is
 * executable Markdown ("Run tasks and dependency-aware workflows from Markdown in a real terminal";
 * github.com/rezigned/upmd, MIT; observed at 0.2.7). This module reads Markdown, predicts what a run
 * will do, builds upmd's argv and reads upmd's output. upmd itself runs every block.
 *
 * Observed upmd 0.2.7 behaviour this adapter relies on (tests/fixtures/fake-upmd.mjs, a labelled
 * test double, reproduces it for the tests):
 * - a task is a fenced code block with an attribute list after its language:
 *     ```bash [name:setup]    ```bash [name:build, deps:setup]    ```bash [name:verify, deps:"lint | test"]
 * - `upmd --ci -b <name> -d <dir> <file.md>` runs the named block after its dependencies, without
 *   prompting, with <dir> as the working directory. Around each block's output (its stdout and
 *   stderr merged) it prints `==> <name> [block <n>]` and `<== <name> exited with code <c>`, where
 *   <n> counts fenced code blocks in document order from 1;
 * - a failing block's end line carries its code, upmd writes `Block <n> failed - stopping dependency
 *   chain` to stderr and exits 1; success exits 0;
 * - `upmd --version` prints `upmd 0.2.7`.
 * - (R4, H58; ledger row 157) with its output a pipe, upmd 0.2.7 prints a block's start line, its output and its end
 *   line all at once, when the block ends: the lines above say how each block ended, never that one is running. On a
 *   terminal it draws each block as it starts and its output as it runs; src/workflows/upmd-live.ts runs it on a pty of
 *   its own (workers/upmd/pty_run.py) and reads that format, and this pipe format where no pty can be had.
 *
 * A run, wired by its caller: findUpmd(env, onPath) → upmdVersion(bin) → parseWorkflow + runOrder
 * (the prediction shown before the run) → spawnProcess(bin, upmdRunArgs(file, block, dir)) with each
 * stdout and stderr line passed through parseUpmdLine into stepsFromEvent (upmd-live.ts: upmdJob and
 * upmdLineParser for a job of either kind).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { JobStep } from '../jobs/index.js';
import { spawnProcess } from '../runtime/spawn-runtime.js';

export interface WorkflowBlock {
  /** 1-based position among all fenced code blocks in the document: upmd's `[block n]` */
  index: number;
  /** the `name:` attribute; an unnamed block cannot be run by name but still counts in `index` */
  name?: string;
  /** the info string's first word (`bash`, `sh`, …); '' when the fence has none */
  lang: string;
  /** the block names the `deps:` value mentions, first mention first, without repeats */
  deps: string[];
  /** the `deps:` value as written, quotes removed: `setup`, `lint | test` */
  depsExpr?: string;
  /** 1-based line of the opening fence */
  line: number;
  /** the block's content between its fences, lines joined with \n */
  code: string;
}

interface OpenFence { char: string; size: number; base: number; indent: number; line: number; info: string; body: string[] }

/** an opening fence after its indentation: three or more backticks or tildes, then the info string */
const FENCE = /^(`{3,}|~{3,})(.*)$/;
/** a closing fence after its indentation: the fence characters alone */
const CLOSING = /^(`{3,}|~{3,})[ \t]*$/;
/** a list item's marker and the whitespace after it (or the end of the line) */
const LIST_MARKER = /^([-+*]|\d{1,9}[.)])([ \t]+|$)/;
/** `- - -`, `***`: a thematic break, not a list item */
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** one `key:value` of an attribute list; the value is double-quoted, single-quoted or bare */
const ATTR = /\s*([A-Za-z_][\w-]*)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,\]]*))\s*(,|\]|$)/y;
/** a block name inside a deps expression; operators and spaces (`|`, `&`, `,`, `(`, …) separate names */
const NAME_TOKEN = /[\p{L}\p{N}_](?:[\p{L}\p{N}_.:/-]*[\p{L}\p{N}_])?/gu;

/** Leading indentation in columns; a tab advances to the next multiple of 4 (CommonMark). */
function indentOf(line: string): number {
  return advance(0, /^[ \t]*/.exec(line)![0]);
}

function advance(column: number, whitespace: string): number {
  for (const ch of whitespace) column = ch === '\t' ? column + 4 - (column % 4) : column + 1;
  return column;
}

/** Remove up to `n` leading spaces: a fence's own indentation, taken off each of its lines. */
function stripSpaces(line: string, n: number): string {
  let i = 0;
  while (i < n && line[i] === ' ') i++;
  return line.slice(i);
}

/** `[name:build, deps:"lint | test"]`, read from just after the `[`. The first value of a key wins. */
function parseAttrs(info: string, from: number): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR.lastIndex = from;
  for (let m = ATTR.exec(info); m; m = ATTR.exec(info)) {
    if (!attrs.has(m[1])) attrs.set(m[1], (m[2] ?? m[3] ?? m[4] ?? '').trim());
    if (m[5] !== ',') break;
  }
  return attrs;
}

function toBlock(index: number, fence: OpenFence): WorkflowBlock {
  const lang = /^[^\s\[]*/.exec(fence.info)![0];
  const open = fence.info.indexOf('[', lang.length);
  const attrs = open < 0 ? new Map<string, string>() : parseAttrs(fence.info, open + 1);
  const block: WorkflowBlock = { index, lang, deps: [], line: fence.line, code: fence.body.join('\n') };
  const name = attrs.get('name');
  if (name) block.name = name;
  const depsExpr = attrs.get('deps');
  if (depsExpr) {
    block.depsExpr = depsExpr;
    block.deps = [...new Set(depsExpr.match(NAME_TOKEN) ?? [])];
  }
  return block;
}

/**
 * Every fenced code block (``` or ~~~) in document order, numbered from 1 the way upmd numbers them,
 * with its `[name:…, deps:…]` attributes. Fences follow CommonMark: a closing fence uses the opening
 * character at least as many times; a backtick fence's info string has no backtick; an unclosed fence
 * runs to the end of the document. Fences inside list items count; fences in indented code or inside
 * an HTML comment (`<!-- … -->`, a commented-out block) do not. Lazy paragraph continuations,
 * blockquotes and other HTML blocks are not modelled.
 */
export function parseWorkflow(markdown: string): WorkflowBlock[] {
  const blocks: WorkflowBlock[] = [];
  const items: number[] = []; // content columns of the open list items, innermost last
  let fence: OpenFence | null = null;
  let comment = false;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const blank = raw.trim() === '';
    const indent = indentOf(raw);
    if (fence) {
      if (blank || indent >= fence.base) {
        const closing = indent - fence.base <= 3 ? CLOSING.exec(raw.trimStart()) : null;
        if (closing && closing[1][0] === fence.char && closing[1].length >= fence.size) {
          blocks.push(toBlock(blocks.length + 1, fence));
          fence = null;
        } else {
          fence.body.push(stripSpaces(raw, fence.indent));
        }
        continue;
      }
      // a less indented line ends the list item holding the fence, and the fence with it
      blocks.push(toBlock(blocks.length + 1, fence));
      fence = null;
    }
    if (comment) {
      if (raw.includes('-->')) comment = false;
      continue;
    }
    if (blank) continue;
    while (items.length && items[items.length - 1] > indent) items.pop();
    let base = items.length ? items[items.length - 1] : 0;
    if (indent - base > 3) continue; // indented code or a continuation line: nothing opens here
    let column = indent;
    let text = raw.trimStart();
    // list markers open containers whose content may hold a fence, possibly on this same line
    while (text && !THEMATIC_BREAK.test(text)) {
      const marker = LIST_MARKER.exec(text);
      if (!marker) break;
      const afterMarker = column + marker[1].length;
      const gap = advance(afterMarker, marker[2]) - afterMarker;
      const rest = text.slice(marker[0].length);
      const indentedCode = rest !== '' && gap >= 5;
      base = rest === '' || indentedCode ? afterMarker + 1 : afterMarker + gap;
      items.push(base);
      column = base;
      text = indentedCode ? '' : rest;
    }
    if (text.startsWith('<!--')) {
      comment = !text.includes('-->', 4);
      continue;
    }
    const open = FENCE.exec(text);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], size: open[1].length, base, indent: column, line: i + 1, info: open[2].trim(), body: [] };
    }
  }
  if (fence) blocks.push(toBlock(blocks.length + 1, fence));
  return blocks;
}

/** A workflow document has at least one named block: something upmd can run by name. */
export function isWorkflowDoc(markdown: string): boolean {
  return parseWorkflow(markdown).some((block) => block.name !== undefined);
}

/**
 * The prediction shown before a run: `target` and its dependency closure in run order, dependencies
 * first, each name once. Names no block carries are listed in `missing`; the first dependency cycle
 * met is reported as a path that returns to its start (`['a', 'b', 'a']`) and its closing edge is
 * skipped. Nothing throws. When two blocks share a name, the first one counts.
 */
export function runOrder(blocks: WorkflowBlock[], target: string): { order: string[]; missing: string[]; cycle?: string[] } {
  const byName = new Map<string, WorkflowBlock>();
  for (const block of blocks) if (block.name !== undefined && !byName.has(block.name)) byName.set(block.name, block);
  const order: string[] = [];
  const missing: string[] = [];
  const done = new Set<string>();
  const frames: { name: string; deps: string[]; next: number }[] = []; // the current path, outermost first
  let cycle: string[] | undefined;
  const enter = (name: string): void => {
    if (done.has(name)) return;
    const onPath = frames.findIndex((frame) => frame.name === name);
    if (onPath >= 0) {
      cycle ??= [...frames.slice(onPath).map((frame) => frame.name), name];
      return;
    }
    const block = byName.get(name);
    if (!block) {
      if (!missing.includes(name)) missing.push(name);
      return;
    }
    frames.push({ name, deps: block.deps, next: 0 });
  };
  enter(target);
  while (frames.length) {
    const top = frames[frames.length - 1];
    if (top.next < top.deps.length) {
      enter(top.deps[top.next++]);
    } else {
      frames.pop();
      done.add(top.name);
      order.push(top.name);
    }
  }
  return cycle ? { order, missing, cycle } : { order, missing };
}

/** The upmd to run: `UPMD_BIN` when set (used as given, PATH is not consulted), else `upmd` on PATH. */
export function findUpmd(env: NodeJS.ProcessEnv, onPath: (cmd: string) => string | null): { bin: string } | null {
  const pinned = env.UPMD_BIN?.trim();
  if (pinned) return { bin: pinned };
  const found = onPath('upmd');
  return found ? { bin: found } : null;
}

/** `upmd 0.2.7` → `0.2.7`; the line must name upmd, so another program's version is not taken for one. */
const VERSION_LINE = /^upmd\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)\s*$/m;

/**
 * `<bin> --version` through spawnProcess (nonblocking; SIGTERM after 5 s), e.g. '0.2.7'. Null when
 * the binary does not start, times out, exits non-zero or does not print an upmd version line: a
 * binary found on disk is not yet a working upmd.
 */
export async function upmdVersion(bin: string): Promise<string | null> {
  try {
    const { child, outcome } = spawnProcess(bin, ['--version'], { timeoutMs: 5_000, maxBuffer: 64 * 1024 });
    child.stdin.on('error', () => { /* the child may exit before stdin closes */ });
    child.stdin.end();
    const result = await outcome;
    if (result.error || result.timedOut || result.status !== 0) return null;
    return VERSION_LINE.exec(result.stdout)?.[1] ?? null;
  } catch {
    return null; // spawn rejected the arguments themselves (an empty path, …)
  }
}

/** The argv of one non-interactive run: `block` after its dependencies, with `workingDir` as cwd. */
export function upmdRunArgs(file: string, block: string, workingDir: string): string[] {
  return ['--ci', '-b', block, '-d', workingDir, file];
}

export type UpmdEvent = { type: 'start'; name: string; index: number } | { type: 'end'; name: string; code: number } | { type: 'chain-stopped'; index: number };
/** A run's step as a job keeps it (src/jobs JobStep): R4 (H58) adds stopped and interrupted, and when it started and ended. */
export type UpmdStep = JobStep;

// ANSI colour and cursor sequences, in case upmd styles its lines
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const START_LINE = /^==> (.+) \[block (\d+)\]$/;
// unanchored at the start: a block whose output does not end in a newline leaves upmd's end line
// on the same line as that output
const END_LINE = /<== (.+) exited with code (-?\d+)$/;
const CHAIN_LINE = /^Block (\d+) failed [-–—] stopping dependency chain$/;

/**
 * One line of upmd's stdout or stderr as an event: `==> setup [block 1]` (start), `<== setup exited
 * with code 0` (end), `Block 3 failed - stopping dependency chain` (chain-stopped); null for any other
 * line, such as a block's own output. Trailing whitespace, a CR and ANSI sequences are ignored. A block
 * that itself prints a line in upmd's format at the start of a line is read as upmd's.
 */
export function parseUpmdLine(line: string): UpmdEvent | null {
  const text = line.replace(ANSI, '').trimEnd();
  const start = START_LINE.exec(text);
  if (start) return { type: 'start', name: start[1], index: Number(start[2]) };
  const end = END_LINE.exec(text);
  if (end) return { type: 'end', name: end[1], code: Number(end[2]) };
  const chain = CHAIN_LINE.exec(text);
  if (chain) return { type: 'chain-stopped', index: Number(chain[1]) };
  return null;
}

/**
 * Fold one event into a run's step list, in place. `start` appends a running step. `end` gives its
 * code to the latest step of that name still without one and marks it completed (code 0) or failed;
 * that step may already read failed, because the end line comes on stdout and the chain-stopped line
 * on stderr, two pipes read in no fixed order. An `end` whose start was not seen appends the finished
 * step. `chain-stopped` marks the step with that block number failed if it is still running.
 */
export function stepsFromEvent(steps: UpmdStep[], ev: UpmdEvent): void {
  if (ev.type === 'start') {
    steps.push({ name: ev.name, index: ev.index, state: 'running' });
    return;
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (ev.type === 'end' && step.name === ev.name && step.code === undefined) {
      step.state = ev.code === 0 ? 'completed' : 'failed';
      step.code = ev.code;
      return;
    }
    if (ev.type === 'chain-stopped' && step.index === ev.index && step.state === 'running') {
      step.state = 'failed';
      return;
    }
  }
  if (ev.type === 'end') steps.push({ name: ev.name, state: ev.code === 0 ? 'completed' : 'failed', code: ev.code });
}

/** directory names never searched, at any depth (`.timmy/private` is handled separately) */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out']);
const MARKDOWN_FILE = /\.(md|markdown)$/i;
/** bounds on one search, so a large tree cannot stall the caller */
const MAX_DIRS = 5_000;
const MAX_FILE_BYTES = 1024 * 1024;

function listDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

function readDoc(file: string): string | null {
  try {
    return statSync(file).size > MAX_FILE_BYTES ? null : readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The Markdown files (`.md`, `.markdown`) under `root` that are workflow documents, as `/`-separated
 * paths relative to `root`, shallowest first, then by path; at most `opts.max` (default 50). Skips
 * node_modules, .git, dist, build and out at any depth and `.timmy/private`; does not follow symlinks;
 * reads at most 5,000 directories and no file over 1 MiB.
 */
export function findWorkflowDocs(root: string, opts: { max?: number } = {}): { rel: string; blocks: number; named: string[] }[] {
  const max = opts.max !== undefined && opts.max >= 1 ? Math.floor(opts.max) : 50;
  const found: { rel: string; depth: number; blocks: number; named: string[] }[] = [];
  const rootName = basename(resolve(root));
  let level = [''];
  let dirs = 0;
  // breadth first: once a whole level is read and `max` documents are known, no deeper one can rank higher
  for (let depth = 0; level.length && found.length < max; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (++dirs > MAX_DIRS) break;
      const dirName = dir ? dir.slice(dir.lastIndexOf('/') + 1) : rootName;
      for (const entry of listDir(join(root, dir))) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          const timmyPrivate = entry.name === 'private' && dirName === '.timmy';
          if (!SKIP_DIRS.has(entry.name) && !timmyPrivate) next.push(rel);
        } else if (entry.isFile() && MARKDOWN_FILE.test(entry.name)) {
          const markdown = readDoc(join(root, rel));
          if (markdown === null) continue;
          const blocks = parseWorkflow(markdown);
          const named = blocks.flatMap((block) => (block.name === undefined ? [] : [block.name]));
          if (named.length) found.push({ rel, depth, blocks: blocks.length, named });
        }
      }
    }
    level = dirs > MAX_DIRS ? [] : next;
  }
  found.sort((a, b) => a.depth - b.depth || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return found.slice(0, max).map(({ rel, blocks, named }) => ({ rel, blocks, named }));
}
