/**
 * Round R4 (H34): an MCP call kept as a record, its answer made readable.
 *
 * Every call from the REPL's /mcp call and from the agent's call_mcp_tool is kept in the project, in
 * .timmy/mcp/<call-id>/ (the id is 'm' and 8 hex digits, as a flow's is 'f' and 8):
 *
 *   call.json    schema timmy.mcp-call/1: the server (its name, the route, the transport and the safe form of its
 *                URL), the tool and its arguments as given, when it started and ended and how long it took, the
 *                outcome (answered, failed, needs authorization or stopped), the server's isError, how many bytes
 *                the route printed and their sha256, whether output.json holds only the first part of them, and the
 *                server's own annotations for this tool when the route passes them on (MCPorter 0.12.4 does not).
 *   output.json  what the route printed for the call, byte for byte, at most MCP_OUTPUT_LIMIT (32 KB) of it; mode
 *                0600. Not always JSON: a cut output, or a route that printed text, is kept as it came. One change only:
 *                a private part of a configured server's URL (a gateway key in its path), should the route echo it, is
 *                replaced by "…" there too, and `redacted` counts them; output_sha256 stays the sha256 of the bytes as
 *                printed, kept_sha256 is output.json's own.
 *
 * Then an `mcp.call` receipt is sealed on the runs chain binding call.json's sha256 and the output's. Never stored:
 * header or environment values (names only), and never a server URL beyond its safe form (mcp-cli.ts safeServerUrl).
 *
 * The answer is read from what the route printed (readRouteAnswer) and shown as its content items (answerLines): text
 * as text, JSON text pretty-printed, images, audio and resources named by type and size, never dumped. What a route
 * cannot pass on is said, never filled in: MCPorter's `--output json` prints a result's structuredContent, or its
 * text read as JSON, instead of the result itself when it has one (src: mcporter dist/cli/output-utils.js and
 * result-utils.js), so its content items are then not in its output.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { humanBytes, projectId, resolveInside } from '../project/index.js';
import { stripEscapes, visibleWidth } from '../term/width.js';
import type { Receipt, ReceiptInput } from '../utils/receipts.js';
import type { McpRouteId } from './mcp-cli.js';
// R4 (H51): each call record names the operation (one request) it was made in.
import { operationField } from '../ops/context.js';

export const MCP_CALLS_DIR = '.timmy/mcp';
export const MCP_CALL_SCHEMA = 'timmy.mcp-call/1';
/** A call's id: 'm' and 8 hex digits (a flow is 'f' and 8, an agent run 'a' and 8, a job 'j' and 6). */
export const MCP_CALL_ID = /^m[0-9a-f]{8}$/;
export const newMcpCallId = (): string => `m${randomBytes(4).toString('hex')}`;
export const mcpCallRel = (id: string): string => `${MCP_CALLS_DIR}/${id}/call.json`;
export const mcpOutputRel = (id: string): string => `${MCP_CALLS_DIR}/${id}/output.json`;

export type McpOutcome = 'answered' | 'failed' | 'needs authorization' | 'stopped';

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// ── reading what a route printed ─────────────────────────────────────────────────

/** A route's printed answer, read: an MCP result, other JSON, plain text, the route's own failure, or nothing. */
export type RouteAnswer =
  | { kind: 'result'; content: unknown[]; isError: boolean; structured?: { value: unknown } }
  /** JSON that is not an MCP result: on MCPorter's route, its extraction of the answer (structuredContent or text read as JSON) */
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'issue'; error: string }
  | { kind: 'none' };

/** JSON from a route's output: the whole of it, or the last block that opens a line (MCPorter may print the server's stderr first). */
export function parseRouteJson(s: string): { ok: true; value: unknown } | { ok: false } {
  const t = s.trim();
  if (!t) return { ok: false };
  try { return { ok: true, value: JSON.parse(t) }; } catch { /* a notice may come before the JSON */ }
  const starts = [...t.matchAll(/^[[{]/gm)].map((m) => m.index ?? 0).filter((i) => i > 0);
  for (const at of starts.reverse()) {
    try { return { ok: true, value: JSON.parse(t.slice(at)) }; } catch { /* not this one */ }
  }
  return { ok: false };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ENVELOPE_KEYS = new Set(['content', 'structuredContent', 'isError', '_meta']);
/** An MCP CallToolResult: a content array of typed items, and nothing but a result's own fields. */
const isResult = (v: unknown): v is { content: unknown[]; isError?: unknown; structuredContent?: unknown } =>
  isObject(v) && Array.isArray(v.content) && Object.keys(v).every((k) => ENVELOPE_KEYS.has(k))
  && v.content.every((c) => isObject(c) && typeof c.type === 'string');
/** MCPorter's own failure, as its call prints it in JSON mode (buildConnectionIssueEnvelope): { server, tool, error, issue }. */
const isIssue = (v: unknown): v is { error?: unknown; issue?: { rawMessage?: unknown } } =>
  isObject(v) && typeof v.error === 'string' && 'tool' in v && Object.keys(v).every((k) => ['server', 'tool', 'error', 'issue'].includes(k));

const asResult = (v: { content: unknown[]; isError?: unknown; structuredContent?: unknown }): RouteAnswer => ({
  kind: 'result', content: v.content, isError: v.isError === true,
  ...('structuredContent' in v && v.structuredContent !== undefined ? { structured: { value: v.structuredContent } } : {}),
});

/** What a route printed for a call, read for showing (never for deciding the outcome: callTool does that). */
export function readRouteAnswer(stdout: string, route: McpRouteId): RouteAnswer {
  if (!stdout.trim()) return { kind: 'none' };
  const parsed = parseRouteJson(stdout);
  return parsed.ok ? routeAnswerOf(parsed.value, route) : { kind: 'text', text: stdout };
}

/** readRouteAnswer for output already read as JSON. */
export function routeAnswerOf(v: unknown, route: McpRouteId): RouteAnswer {
  if (route === 'sdk' && isObject(v) && typeof v.ok === 'boolean') {
    if (isResult(v.result)) return asResult(v.result);
    if (typeof v.error === 'string') return { kind: 'issue', error: v.error };
    return { kind: 'json', value: 'result' in v ? v.result : v };
  }
  if (isResult(v)) return asResult(v);
  if (isIssue(v)) return { kind: 'issue', error: String(v.error ?? (isObject(v.issue) ? v.issue.rawMessage : '') ?? '') };
  return { kind: 'json', value: v };
}

// ── showing it ───────────────────────────────────────────────────────────────────

/** A server's text made safe to print: no terminal escapes, no control characters but line ends, tabs as spaces. */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return stripEscapes(s.replace(/\r\n?/g, '\n')).replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

const pretty = (v: unknown): string[] => {
  let s: string | undefined;
  try { s = JSON.stringify(v, null, 2); } catch { s = undefined; }
  return cleanText(s ?? String(v)).split('\n');
};

/** The size of base64 data, decoded. */
const base64Bytes = (data: unknown): number | undefined => {
  if (typeof data !== 'string') return undefined;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
};
const short = (s: unknown, n = 120): string => { const t = cleanText(String(s)).replace(/\n/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sizeWords = (n: number | undefined): string => (n === undefined ? 'size not given' : humanBytes(n));

/** One content item as lines: text as text (JSON text pretty-printed), anything else named by type and size. */
function itemLines(item: unknown): string[] {
  if (!isObject(item)) return [`[an item that is not an object]`];
  const type = String(item.type);
  if (type === 'text') {
    const text = cleanText(typeof item.text === 'string' ? item.text : '');
    if (/^\s*[[{]/.test(text)) {
      try { const v = JSON.parse(text) as unknown; if (v && typeof v === 'object') return pretty(v); } catch { /* text after all */ }
    }
    return text.split('\n');
  }
  if (type === 'image' || type === 'audio') return [`[${type} · ${short(item.mimeType ?? 'type not given', 60)} · ${sizeWords(base64Bytes(item.data))}]`];
  if (type === 'resource') {
    const r = isObject(item.resource) ? item.resource : {};
    const body = typeof r.text === 'string' ? `text, ${humanBytes(Buffer.byteLength(r.text))}` : typeof r.blob === 'string' ? `binary, ${sizeWords(base64Bytes(r.blob))}` : 'no body';
    return [`[resource · ${short(r.uri ?? 'no uri')}${r.mimeType ? ` · ${short(r.mimeType, 60)}` : ''} · ${body}]`];
  }
  if (type === 'resource_link') return [`[resource link · ${short(item.uri ?? 'no uri')}${item.name ? ` · ${short(item.name, 60)}` : ''}]`];
  return [`[${short(type, 40)} item]`];
}

const describe = (v: unknown): string => (Array.isArray(v) ? `an array of ${v.length}` : isObject(v) ? `an object with ${Object.keys(v).length} key${Object.keys(v).length === 1 ? '' : 's'}` : `a ${typeof v}`);

/** The answer as lines to read, and notes on what they are (or are not). */
export function answerLines(a: RouteAnswer, route: McpRouteId): { lines: string[]; notes: string[] } {
  if (a.kind === 'none') return { lines: [], notes: [] };
  if (a.kind === 'text') return { lines: cleanText(a.text).replace(/\n+$/, '').split('\n'), notes: [] };
  if (a.kind === 'issue') return { lines: cleanText(a.error).split('\n'), notes: [] };
  if (a.kind === 'json') {
    return {
      lines: pretty(a.value),
      notes: [route === 'mcporter'
        ? "MCPorter's JSON output: the answer's structuredContent, or its text read as JSON; MCPorter does not print the content items then"
        : 'the route printed JSON that is not an MCP result'],
    };
  }
  const lines = a.content.flatMap(itemLines);
  const notes: string[] = [];
  if (a.structured) {
    if (!lines.length) lines.push(...pretty(a.structured.value));
    else notes.push(`it also carries structuredContent (${describe(a.structured.value)}); output.json keeps it`);
  }
  if (!a.content.length && !a.structured) notes.push('the answer holds no content items');
  return { lines, notes };
}

/** The server's own words for an error answer (isError), as lines. */
export function serverSaid(a: RouteAnswer, route: McpRouteId): string[] {
  if (a.kind === 'result' || a.kind === 'json' || a.kind === 'text') return answerLines(a, route).lines;
  return [];
}

/**
 * One line cut to `width` display cells, breaking at a space when one is near; continuation lines keep its indent.
 * At most `max` lines are made (an answer can be one line of megabytes), each found by one walk from where the last ended.
 */
function wrapLine(line: string, width: number, max = Number.POSITIVE_INFINITY): string[] {
  if (line.length <= width * 4 && visibleWidth(line) <= width) return [line];
  const indent = /^ */.exec(line)?.[0].slice(0, Math.max(0, Math.floor(width / 2))) ?? '';
  const out: string[] = [];
  let pos = 0;
  let lead = '';
  while (pos < line.length && out.length < max) {
    const room = Math.max(8, width - visibleWidth(lead));
    let j = pos;
    let cells = 0;
    while (j < line.length) {
      const ch = String.fromCodePoint(line.codePointAt(j) ?? 32);
      const w = visibleWidth(ch);
      if (cells + w > room) break;
      cells += w;
      j += ch.length;
    }
    if (j >= line.length) { out.push(lead + line.slice(pos)); break; }
    if (j === pos) j = pos + String.fromCodePoint(line.codePointAt(pos) ?? 32).length;
    // Prefer a break at the last space in the second half of the room.
    const space = line.lastIndexOf(' ', j);
    const at = space > pos + (j - pos) / 2 ? space + 1 : j;
    out.push(lead + line.slice(pos, at).trimEnd());
    pos = at;
    lead = indent;
  }
  return out;
}

/**
 * Lines fitted to a width and a budget of display lines: what fits, and how much is left out, in words
 * ("12 more lines", "the rest of that line and 3 more lines"), or none when everything fits.
 */
export function fitLines(lines: string[], width: number, budget: number): { shown: string[]; left?: string } {
  const shown: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const room = budget - shown.length;
    const wrapped = wrapLine(lines[i], Math.max(16, width), room + 1);
    if (wrapped.length <= room) { shown.push(...wrapped); continue; }
    if (room > 0) shown.push(...wrapped.slice(0, room));
    const after = lines.length - i - 1;
    const more = (n: number): string => `${n} more line${n === 1 ? '' : 's'}`;
    return { shown, left: room > 0 ? `the rest of that line${after ? ` and ${more(after)}` : ''}` : more(lines.length - i) };
  }
  return { shown };
}

/** The server's annotations in words, as its claim: "read-only, closed world"; empty when it gives none. */
export function hintWords(a: unknown): string {
  if (!isObject(a)) return '';
  const words: string[] = [];
  const say = (key: string, yes: string, no: string): void => { if (a[key] === true) words.push(yes); else if (a[key] === false) words.push(no); };
  say('readOnlyHint', 'read-only', 'not read-only');
  say('destructiveHint', 'destructive', 'not destructive');
  say('idempotentHint', 'idempotent', 'not idempotent');
  say('openWorldHint', 'open world', 'closed world');
  return words.join(', ');
}

/** A server's annotations, kept bounded: known value types only, short strings, at most 16 keys. */
export function boundedAnnotations(v: unknown): Record<string, boolean | number | string> | undefined {
  if (!isObject(v)) return undefined;
  const out: Record<string, boolean | number | string> = {};
  for (const [k, x] of Object.entries(v).slice(0, 16)) {
    if (typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) out[k.slice(0, 64)] = x;
    else if (typeof x === 'string') out[k.slice(0, 64)] = x.slice(0, 200);
  }
  return out;
}

// ── the record ───────────────────────────────────────────────────────────────────

/** What a call ran to: what mcp-cli.ts runToolCall hands over for its record. */
export interface McpCallFacts {
  route: McpRouteId;
  /** the server as recorded: its name (a command line is named by its program and script only), transport and safe URL */
  server: { name: string; transport: string; url?: string };
  tool: string;
  args: Record<string, unknown>;
  passEnv?: string[];
  startedAt: string;
  endedAt: string;
  ms: number;
  outcome: McpOutcome;
  /** whether the call itself was started (false: Timmy refused, or the route could not start) */
  called: boolean;
  /** the server's isError; null when no answer was read */
  isError: boolean | null;
  error?: string;
  /** what the route printed for the call: every byte counted and hashed, the first MCP_OUTPUT_LIMIT kept (`redacted`:
   *  how many private parts of the server's URL were replaced by "…" in the kept bytes) */
  output?: { bytes: number; sha256: string; kept: Buffer; truncated: boolean; redacted?: number };
  annotations: Record<string, boolean | number | string> | null;
  annotationsNote?: string;
  notes: string[];
}

/** Where a record goes and how it is sealed: the project, its name, and the REPL's seal (a short receipt id back). */
export interface McpRecordContext {
  root: string;
  project?: string;
  seal?: (input: ReceiptInput) => string | undefined;
}

export type McpRecordWritten =
  | { ok: true; id: string; call: string; output?: string; callSha256: string; receipt?: string }
  | { ok: false; error: string; receipt?: string };

/** Creates a new file that must not exist, mode 0600 whatever the umask, and writes it whole. */
function writeNew(path: string, data: Buffer | string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let at = 0;
    while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at);
  } finally { closeSync(fd); }
}

/**
 * The record of one call (call.json, output.json) in .timmy/mcp/<call-id>/, then its `mcp.call` receipt. A record that
 * cannot be written is said, and the receipt is still sealed with why (the call happened either way).
 */
export function writeMcpCall(ctx: McpRecordContext, f: McpCallFacts): McpRecordWritten {
  let written: { id: string; call: string; output?: string; callSha256: string; callBytes: number } | undefined;
  let failure: string | undefined;
  try {
    let id = '';
    let dir = '';
    for (let attempt = 0; attempt < 6 && !dir; attempt++) {
      id = newMcpCallId();
      const at = resolveInside(ctx.root, `${MCP_CALLS_DIR}/${id}`);
      if ('error' in at) throw new Error(at.error);
      mkdirSync(dirname(at.path), { recursive: true });
      try { mkdirSync(at.path, { mode: 0o700 }); dir = at.path; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    if (!dir) throw new Error('no free call id');
    const kept = f.output?.kept;
    if (f.output && kept) writeNew(`${dir}/output.json`, kept);
    const record = {
      schema: MCP_CALL_SCHEMA,
      id,
      server: f.server.name,
      route: f.route,
      transport: f.server.transport,
      ...(f.server.url ? { url: f.server.url } : {}),
      tool: f.tool,
      arguments: f.args,
      ...(f.passEnv?.length ? { pass_env: f.passEnv } : {}),
      started_at: f.startedAt,
      ended_at: f.endedAt,
      ms: f.ms,
      outcome: f.outcome,
      called: f.called,
      isError: f.isError,
      ...(f.error ? { error: f.error } : {}),
      output_file: f.output ? 'output.json' : null,
      output_bytes: f.output?.bytes ?? 0,
      output_sha256: f.output?.sha256 ?? null,
      truncated: f.output?.truncated ?? false,
      ...(f.output && kept ? { kept_bytes: kept.length, kept_sha256: sha256(kept) } : {}),
      ...(f.output?.redacted ? { redacted: f.output.redacted } : {}),
      annotations: f.annotations,
      ...(f.annotationsNote ? { annotations_note: f.annotationsNote } : {}),
      ...(f.notes.length ? { notes: f.notes } : {}),
      ...(ctx.project ? { project: ctx.project } : {}),
      project_id: projectId(ctx.root),
      ...operationField('mcp', id), // R4 (H51): the request it was made in
    };
    const text = `${JSON.stringify(record, null, 2)}\n`;
    writeNew(`${dir}/call.json`, text);
    written = { id, call: mcpCallRel(id), ...(f.output ? { output: mcpOutputRel(id) } : {}), callSha256: sha256(text), callBytes: Buffer.byteLength(text) };
  } catch (e) {
    // Its code (EACCES, ENOSPC, …) or Timmy's own words: an OS message would name the folder by its absolute path.
    const code = (e as NodeJS.ErrnoException).code;
    failure = code ? `${code} in ${MCP_CALLS_DIR}` : e instanceof Error ? e.message : String(e);
  }
  let receipt: string | undefined;
  try {
    receipt = ctx.seal?.({
      kind: 'mcp.call',
      subject: `mcp.call · ${f.tool} on ${f.server.name} via ${f.route} · ${f.outcome}`,
      policy: 'human-gated',
      status: f.outcome === 'answered' ? 'ok' : 'failed',
      ...(ctx.project ? { project: ctx.project } : {}),
      project_id: projectId(ctx.root),
      ms: f.ms,
      ...(written ? {
        outputs: [
          { path: written.call, sha256: written.callSha256, bytes: written.callBytes },
          ...(written.output && f.output ? [{ path: written.output, sha256: sha256(f.output.kept), bytes: f.output.kept.length }] : []),
        ],
      } : {}),
      ...(f.output ? { output_sha256: f.output.sha256 } : {}),
      sources: [{
        mcp_call: written?.id ?? null, server: f.server.name, route: f.route, transport: f.server.transport, ...(f.server.url ? { url: f.server.url } : {}),
        tool: f.tool, outcome: f.outcome, called: f.called, isError: f.isError, output_bytes: f.output?.bytes ?? 0, truncated: f.output?.truncated ?? false,
      }],
      // Never the server's own words or the arguments: the receipt binds them through call.json's sha256.
      ...(failure ? { discrepancies: [`the record could not be written: ${failure}`] } : {}),
    });
  } catch { receipt = undefined; }
  if (!written) return { ok: false, error: failure ?? 'the record could not be written', ...(receipt ? { receipt } : {}) };
  return { ok: true, id: written.id, call: written.call, ...(written.output ? { output: written.output } : {}), callSha256: written.callSha256, ...(receipt ? { receipt } : {}) };
}

// ── reading records back (the board) ─────────────────────────────────────────────

export interface McpCallRecord {
  schema: string; id: string; server: string; route: McpRouteId; transport: string; url?: string; tool: string; arguments: unknown;
  started_at: string; ended_at: string; ms: number; outcome: McpOutcome; called: boolean; isError: boolean | null; error?: string;
  output_file: string | null; output_bytes: number; output_sha256: string | null; truncated: boolean; kept_bytes?: number; kept_sha256?: string;
  annotations: Record<string, unknown> | null; annotations_note?: string; notes?: string[]; project?: string; project_id?: string;
  /** Round R4 (H51): the operation (one request) the call was made in; absent before, or outside one */
  operation?: string;
}

export interface McpCallRead {
  record: McpCallRecord;
  /** project-relative paths */
  call: string;
  output?: string;
  /** whether a `mcp.call` receipt of this project sealed exactly call.json's bytes, and which */
  check: { status: 'verified'; receipt: string } | { status: 'unverified'; reason: string };
  /** output.json as it is now, read back (at most the cap); its sha256 compared with the record's */
  outputText?: string;
  outputCheck?: 'matches' | 'differs' | 'missing';
}

const OUTCOMES = new Set<string>(['answered', 'failed', 'needs authorization', 'stopped']);

/** The project's MCP call records, newest first, at most `max`, each checked against the runs chain. */
export function readMcpCalls(root: string, chain: readonly Receipt[], max = 6): { list: McpCallRead[]; more: number } {
  const at = resolveInside(root, MCP_CALLS_DIR);
  if ('error' in at) return { list: [], more: 0 };
  let all: string[];
  try { all = readdirSync(at.path).filter((n) => MCP_CALL_ID.test(n)); } catch { return { list: [], more: 0 }; }
  // The live board asks every 2 s: only the newest folders (by their time) are read, a few more than shown.
  const timed = all.map((id) => { let t = 0; try { t = statSync(`${at.path}/${id}`).mtimeMs; } catch { /* unreadable: last */ } return { id, t }; });
  const ids = timed.sort((a, b) => b.t - a.t).slice(0, max * 2 + 4).map((x) => x.id);
  const pid = projectId(root);
  const read: McpCallRead[] = [];
  for (const id of ids) {
    const callRel = mcpCallRel(id);
    const c = resolveInside(root, callRel);
    if ('error' in c) continue;
    let bytes: Buffer;
    try { if (statSync(c.path).size > 512 * 1024) continue; bytes = readFileSync(c.path); } catch { continue; }
    let rec: McpCallRecord;
    try { rec = JSON.parse(bytes.toString('utf8')) as McpCallRecord; } catch { continue; }
    if (!isObject(rec) || rec.schema !== MCP_CALL_SCHEMA || rec.id !== id || typeof rec.tool !== 'string' || typeof rec.server !== 'string' || !OUTCOMES.has(String(rec.outcome))) continue;
    const sha = sha256(bytes);
    const sealed = [...chain].reverse().find((r) => r.kind === 'mcp.call' && r.project_id === pid && r.outputs?.[0]?.path === callRel);
    const check: McpCallRead['check'] = !sealed ? { status: 'unverified', reason: 'no mcp.call receipt of this project names this record' }
      : sealed.outputs?.[0]?.sha256 === sha ? { status: 'verified', receipt: typeof sealed.hash === 'string' && sealed.hash.length > 15 ? sealed.hash.slice(7, 15) : String(sealed.id) }
        : { status: 'unverified', reason: 'call.json changed after its receipt sealed it' };
    const out: Pick<McpCallRead, 'output' | 'outputText' | 'outputCheck'> = {};
    if (rec.output_file === 'output.json') {
      out.output = mcpOutputRel(id);
      const o = resolveInside(root, out.output);
      try {
        if ('error' in o) throw new Error(o.error);
        const ob = readFileSync(o.path);
        out.outputText = ob.subarray(0, 64 * 1024).toString('utf8');
        out.outputCheck = rec.kept_sha256 === sha256(ob) ? 'matches' : 'differs';
      } catch { out.outputCheck = 'missing'; }
    }
    read.push({ record: rec, call: callRel, ...out, check });
  }
  const time = (r: McpCallRead): number => { const t = Date.parse(r.record.started_at); return Number.isNaN(t) ? 0 : t; };
  read.sort((a, b) => time(b) - time(a));
  return { list: read.slice(0, max), more: Math.max(0, all.length - Math.min(max, read.length)) };
}
