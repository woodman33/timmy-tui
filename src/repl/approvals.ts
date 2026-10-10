/**
 * NEEDS YOU (plan C-7, playbook §17.8). A dangerous-only policy decides which tool calls wait for the
 * operator: read-only tools never ask; calls that send data or actions off the machine always ask;
 * every workspace shell command asks; unknown tools ask. The box offers y (once), a (this session),
 * n, Esc or Enter (deny, the default); a shell command and get_env ask every time, so their box has
 * no a. Without a terminal: deny.
 */
import { emitKeypressEvents, type Key } from 'node:readline';
import { currentOperation } from '../ops/context.js';
import { sanitize } from '../term/sanitize.js';
import { keySet } from '../utils/keys.js';
import type { TerminalSession } from '../term/session.js';
import { serialize, type Role, type Segment, type Theme } from '../term/theme.js';
import { truncate, visibleWidth } from '../term/width.js';

/** Past this many characters, or with a newline in it, the box shows the whole argument, not one line of it. */
const DETAIL_OVER = 60;

export type Decision = 'once' | 'session' | 'deny';

export interface ApprovalRequest {
  tool: string;
  reason: string;
  summary: string;
  /** The whole code or command, cleaned, when one line cannot show it (LIVE-01, row 65). */
  detail?: string;
  /**
   * false: this tool asks every time, so the box offers no `a` (round R1 review). A command that runs
   * on this machine, or a value read from your environment, is judged one call at a time.
   */
  session?: false;
}

const READ_ONLY = new Set([
  'get_current_time', 'calculate', 'get_system_info', 'list_local_spatial_models', 'read_spatial_model_context',
  'review_spatial_with_local_model', 'browser_get_snapshot', 'browser_take_screenshot', 'cloudflare_get_feature_flag',
  // Timmy Canvas: fixed read-only code (the model's words arrive only as a JSON string).
  'canvas_read', 'canvas_api',
  // The active project (R1 workspace direction): listing and reading stay inside it and never reach keys,
  // .env files or .timmy/private (src/project); writing asks (ALWAYS below).
  'list_project_files', 'read_project_file',
  // R4 (H50): Timmy Memory's recall: it reads the project's records and the runs chain, and writes, seals and runs nothing.
  'recall_project_work',
  // Round R2: MCP routes and configured servers by name (never a command line); a fixed local OpenCV script
  // that reads one project file and writes only its own observation file.
  'list_mcp_tools', 'observe_image',
]);

const ALWAYS: Record<string, { reason: string; keys: string[]; session?: false }> = {
  get_env: { reason: 'sends a value from your environment to the model', keys: ['name'], session: false },
  stress_test_endpoint: { reason: 'sends load to a remote endpoint', keys: ['url', 'endpoint'] },
  cloudflare_send_durable_pulse: { reason: 'writes to a remote service', keys: ['message', 'payload'] },
  trigger_background_workflow: { reason: 'starts work on a remote service', keys: ['workflow', 'name', 'job'] },
  manage_composio_integrations: { reason: 'changes your connected integrations', keys: ['action', 'app'] },
  browser_launch_cdp: { reason: 'opens a browser', keys: ['url'] },
  browser_click_element: { reason: 'acts on a web page', keys: ['refId'] },
  list_card: { reason: 'posts a listing to a marketplace', keys: ['title', 'name'] },
  canvas_exec: { reason: 'runs code in the canvas page, which can reach the network', keys: ['code'] },
  // R4 (H55): fixed code; one note on the canvas, saved with it (Undo removes it); without a card it only lists them.
  canvas_place_project_card: { reason: 'places a card of your project on Timmy Canvas (one note, saved with the canvas)', keys: ['card'] },
  write_project_file: { reason: 'changes a file in your project', keys: ['path'] },
  // Round R2
  list_mcp_command_tools: { reason: 'starts an MCP server to list its tools: a configured server by name, or a program you give, on this machine or at an address', keys: ['server'], session: false },
  call_mcp_tool: { reason: 'runs an MCP server and calls one of its tools', keys: ['server', 'tool'], session: false },
  run_native: { reason: 'starts Cinema 4D, After Effects, Blender, OpenSCAD or FreeCAD on this machine', keys: ['app', 'script', 'project_file', 'comp'] },
  // Round R3 (/recipe): the CadQuery enclosure-tray recipe as a durable background job (src/agent/recipe-tools.ts).
  run_recipe: { reason: 'builds a CAD tray with CadQuery on this machine, as a background job', keys: ['recipe', 'parameters'] },
  // Round R4 (/iterate): a local code agent edits the tray's parameter file, then a rebuild and a readback; asked each time.
  iterate_recipe: { reason: 'starts a local code agent that may change recipes/tray.params.json, then rebuilds the CAD tray and reads it back on this machine', keys: ['instruction'], session: false },
  // Round R4 (H33): the same for an OpenSCAD model's parameter file or a FreeCAD script (the file named); asked each time.
  iterate_native: { reason: 'starts a local code agent that may change one file in your project (an OpenSCAD model\'s <model>.params.json, or a FreeCAD script), then runs OpenSCAD or FreeCAD on this machine and reads the result back', keys: ['file', 'instruction'], session: false },
  describe_image: { reason: 'sends an image from your project to a model, and costs money', keys: ['path'], session: false },
};

const SHELL: Record<string, string[]> = { run_in_daytona_workspace: ['command'] };
const DESTRUCTIVE = /\brm\b|sudo|chmod|chown|\bdd\b|mkfs/;
/**
 * R4 (H74): the one rule for a destructive shell command. The agent's shell tool's box says "destructive shell command" for
 * these (approvalNeeded below), and a workflow's risky blocks are the blocks whose code it matches (src/repl/workflow-gate.ts).
 */
export const destructiveCommand = (command: string): boolean => DESTRUCTIVE.test(command);

/** What the box shows, cleaned: the model wrote it, and a backspace must not disguise a command. */
function summarize(args: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (typeof args[k] === 'string' && args[k]) return sanitize(args[k] as string).replace(/\s+/g, ' ').trim();
  const json = JSON.stringify(args) ?? '';
  return json === '{}' ? '' : sanitize(json);
}

/**
 * The operator approves what they can read: code or a command that one line cannot show goes to the
 * box whole (cleaned, newlines and indentation kept). LIVE-01 (row 65) asked about canvas code with
 * only its first line on screen.
 */
function withDetail(args: Record<string, unknown>, keys: string[], need: { reason: string; summary: string }): Omit<ApprovalRequest, 'tool'> {
  const raw = keys.map((k) => args[k]).find((v): v is string => typeof v === 'string' && v.length > 0);
  if (raw === undefined) return need;
  const detail = sanitize(raw).replace(/\s+$/, '');
  return detail.includes('\n') || detail.length > DETAIL_OVER ? { ...need, detail } : need;
}

/** A value the model wrote, cleaned for the box: no escapes or control characters; trailing space dropped; newlines kept. */
const cleaned = (v: unknown): string => (typeof v === 'string' ? sanitize(v).replace(/\s+$/, '') : '');
/** The same on one line, at most `max` characters (an ellipsis says it was cut). */
const shortened = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : one;
};

/**
 * R4 (H40): the box for a tool whose first key cannot say what it will do. Its line names each part, shortened; when
 * that line is long, or a part has a newline, the box also shows every part whole (cleaned, newlines kept), so nothing
 * the operator approves is hidden behind the first key.
 */
function described(parts: Array<[string, string]>, line: string): { summary: string; detail?: string } {
  const long = line.length > DETAIL_OVER || parts.some(([, v]) => v.includes('\n') || v.length > DETAIL_OVER);
  return long ? { summary: line, detail: parts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') } : { summary: line };
}

/** R4 (H63): what Unreal's run_native call does, said in its box (it asks every time: no `a`). */
const UNREAL_REASON = 'starts Unreal Engine on this machine (UnrealEditor-Cmd, headless): it runs a Python script of your project inside the editor, which may save levels in your project; a second Unreal process then reads them back';
/** R4 (H64): an Illustrator run is asked every time, with its own reason (its window opens; macOS may ask for Automation). */
export const ILLUSTRATOR_APPROVAL_REASON = 'starts Adobe Illustrator on this machine through osascript: its window opens, and the script draws in a document it makes or opens (macOS may ask you to allow Automation; that stays yours)';

const DESCRIBE: Record<string, (args: Record<string, unknown>) => { summary: string; detail?: string; reason?: string; session?: false } | undefined> = {
  // R4 (H40): the app, the file the local agent may change, and the instruction it is given (its first key, file, hid the rest)
  iterate_native: (a) => {
    const app = cleaned(a.app);
    const file = cleaned(a.file);
    const instruction = cleaned(a.instruction);
    const head = [shortened(app, 16), shortened(file, 60)].filter(Boolean).join(' ');
    return described([['app', app], ['file', file], ['instruction', instruction]], `${head}${instruction ? `: ${shortened(instruction, 120)}` : ''}`);
  },
  // R4 (H40): Blender's run says its script and the script's arguments (its first key, app, said "blender" alone); the
  // other apps' line is the app, as before
  run_native: (a) => {
    // R4 (H63): Unreal's call names its project file, script and arguments, and is judged one call at a time
    if (a.app === 'unreal') {
      const project = cleaned(a.project_file);
      const script = cleaned(a.script);
      const args = Array.isArray(a.args) ? a.args.map(cleaned).filter(Boolean).join(' ') : '';
      const line = `unreal${project ? ` ${shortened(project, 50)}` : ''}${script ? ` ${shortened(script, 50)}` : ''}${args ? ` ${shortened(args, 60)}` : ''}`;
      return { ...described([['app', 'unreal'], ['project_file', project], ['script', script], ['args', args]], line), reason: UNREAL_REASON, session: false };
    }
    if (a.app === 'illustrator') {
      // R4 (H64): the mode, the script and the document, each named; never allowed for the whole session
      const mode = cleaned(a.mode) || 'author';
      const script = cleaned(a.script);
      const doc = cleaned(a.project_file);
      const line = `illustrator ${shortened(mode, 10)}${doc ? ` ${shortened(doc, 60)}` : ''}${script ? ` ${shortened(script, 60)}` : ''}`;
      return { ...described([['app', 'illustrator'], ['mode', mode], ['project_file', doc], ['script', script]], line), reason: ILLUSTRATOR_APPROVAL_REASON, session: false };
    }
    if (a.app !== 'blender') return undefined;
    const script = cleaned(a.script);
    const args = Array.isArray(a.args) ? a.args.map(cleaned).filter(Boolean).join(' ') : '';
    return described([['app', 'blender'], ['script', script], ['args', args]], `blender${script ? ` ${shortened(script, 60)}` : ''}${args ? ` -- ${shortened(args, 80)}` : ''}`);
  },
};

/** A Daytona key that is set and is not a template's placeholder (the tool's own test). */
const daytonaKeySet = (env: Record<string, string | undefined>): boolean => keySet(env.DAYTONA_API_KEY);

/** Why this call must wait for the operator, or null when it may run. */
export function approvalNeeded(tool: string, args: Record<string, unknown> = {}, env: Record<string, string | undefined> = process.env): Omit<ApprovalRequest, 'tool'> | null {
  if (READ_ONLY.has(tool)) return null;
  const always = ALWAYS[tool];
  if (always) {
    // R4 (H40): a tool whose first key cannot say what it will do names each of its parts instead
    const own = Object.hasOwn(DESCRIBE, tool) ? DESCRIBE[tool](args) : undefined;
    const need = own ? { reason: always.reason, ...own } : withDetail(args, always.keys, { reason: always.reason, summary: summarize(args, always.keys) });
    return always.session === false ? { ...need, session: false } : need;
  }
  // Every workspace command asks: without a Daytona key it runs on this machine, and no pattern can
  // tell a safe command from a harmful one (review finding).
  const shell = SHELL[tool];
  if (shell) {
    const command = summarize(args, shell);
    // Round R1: the box says where it runs. Without a Daytona key the tool runs it on this machine.
    const where = daytonaKeySet(env) ? 'in Daytona' : 'on this machine';
    // Each command is its own decision: `a` would let every later command run unseen (review finding).
    return { ...withDetail(args, shell, { reason: destructiveCommand(command) ? `destructive shell command ${where}` : `runs a shell command ${where}`, summary: command }), session: false };
  }
  return { reason: 'unknown tool', summary: summarize(args, []) };
}

/** Words greedily into rows of `first` cells, then `rest` cells; a word longer than a row is cut across rows. */
function wrapRows(text: string, first: number, rest: number): string[] {
  const rows: string[] = [];
  let row = '';
  const room = (): number => Math.max(1, rows.length === 0 ? first : rest);
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const joined = row ? `${row} ${word}` : word;
    if (visibleWidth(joined) <= room()) {
      row = joined;
      continue;
    }
    if (row) {
      rows.push(row);
      row = '';
    }
    let left = word;
    while (visibleWidth(left) > room()) {
      let cut = '';
      for (const ch of Array.from(left)) {
        if (visibleWidth(cut + ch) > room()) break;
        cut += ch;
      }
      rows.push(cut);
      left = left.slice(cut.length);
    }
    row = left;
  }
  if (row || rows.length === 0) rows.push(row);
  return rows;
}

/** The detail's rows at `width` cells: each line keeps its indentation, and wrapped rows indent two more. */
function detailRows(detail: string, width: number): string[] {
  return detail.split('\n').flatMap((line) => {
    const lead = Math.min(visibleWidth(/^\s*/.exec(line)?.[0] ?? ''), Math.max(0, width - 12));
    const body = line.trim();
    if (!body) return [''];
    return wrapRows(body, width - lead, width - lead - 2).map((r, i) => `${' '.repeat(lead + (i > 0 ? 2 : 0))}${r}`);
  });
}

interface ToolLike {
  type: string;
  function: { name: string; execute?: unknown; [k: string]: unknown };
}

/**
 * R4 (H60): a call that waits for the operator, as the Control Room's Decisions part shows it: from the moment it waits
 * (queued behind another box, or with its own box on screen) until it is answered. Read only through waitingApprovals();
 * nothing outside the gate can answer it.
 */
export interface WaitingApproval {
  tool: string;
  reason: string;
  summary: string;
  /** false: the box offers no `a` (this tool asks every time) */
  session: boolean;
  /** when it began to wait (ms) */
  since: number;
  /** its box is on screen now (else it waits behind another one) */
  shown: boolean;
  /** the operation (one request) it belongs to, when the request has one */
  operation?: string;
  /**
   * R4 (H74): a wait that is not the chat agent's tool call (a workflow run whose blocks include a destructive shell
   * command): the Control Room's "Waiting on you" says it in these words, cleaned there. `keys`: its box is the way to
   * answer it (else the commands are). Absent for a tool call.
   */
  words?: { title: string; needed: string; why: string; commands: string[]; keys: boolean };
}
const waiting = new Map<number, WaitingApproval>();
let waitSeq = 0;
/** The calls waiting for the operator in this process now, oldest first (a copy). */
export function waitingApprovals(): WaitingApproval[] { return [...waiting.values()].map((w) => ({ ...w, ...(w.words ? { words: { ...w.words, commands: [...w.words.commands] } } : {}) })); }

/**
 * The SDK runs a round's tool calls in parallel; asks wait in line so one keypress answers one box. R4 (H74): one line for
 * the whole process, so a workflow run's box (askPerson) never shares the terminal with a tool call's.
 */
let line: Promise<unknown> = Promise.resolve();
const inLine = <R>(fn: () => Promise<R>): Promise<R> => {
  const next = line.then(fn, fn);
  line = next.catch(() => {});
  return next;
};

/**
 * R4 (H74): a request that is not a tool call waits for the operator in the same NEEDS YOU box, in the same line as the
 * tool calls' boxes, and is listed as waiting (waitingApprovals: the Control Room's "Waiting on you") from now until it is
 * answered. `ask` is the REPL's own (its terminal's box); a caller with no terminal to ask has none and asks nothing.
 */
export async function askPerson(req: ApprovalRequest, ask: (req: ApprovalRequest) => Promise<Decision>, words?: WaitingApproval['words']): Promise<Decision> {
  const id = ++waitSeq;
  const operation = currentOperation();
  waiting.set(id, { tool: req.tool, reason: req.reason, summary: req.summary, session: req.session !== false, since: Date.now(), shown: false, ...(operation ? { operation } : {}), ...(words ? { words } : {}) });
  try {
    return await inLine(async () => {
      const w = waiting.get(id);
      if (w) w.shown = true;
      return ask(req);
    });
  } finally { waiting.delete(id); }
}

/** Wrap each tool's execute so a call that needs approval waits for `ask`; a denial reaches the model. */
export function gateTools<T>(tools: readonly T[], ask: (req: ApprovalRequest) => Promise<Decision>): T[] {
  const allowed = new Set<string>();
  const inTurn = inLine;
  return tools.map((original) => {
    const t = original as unknown as ToolLike;
    const execute = t.function?.execute;
    if (typeof execute !== 'function') return original;
    const name = t.function.name;
    const gated = async (args: Record<string, unknown>, ctx: unknown) => {
      const need = approvalNeeded(name, args ?? {});
      // R4 (H64): a call that asks every time (session: false) is asked even when an earlier call of its tool was allowed
      // for the session (an Illustrator run after a Blender run allowed with "a").
      if (need && (need.session === false || !allowed.has(name))) {
        // R4 (H60): the call waits for the operator from here until it is answered (the Control Room's Decisions).
        const id = ++waitSeq;
        const operation = currentOperation();
        waiting.set(id, { tool: name, reason: need.reason, summary: need.summary, session: need.session !== false, since: Date.now(), shown: false, ...(operation ? { operation } : {}) });
        let decision: Decision;
        try {
          // Re-check after waiting: an earlier box may have allowed this tool for the session.
          decision = await inTurn(async () => {
            if (need.session !== false && allowed.has(name)) return 'session';
            const w = waiting.get(id);
            if (w) w.shown = true;
            return ask({ tool: name, ...need });
          });
        } finally { waiting.delete(id); }
        if (decision === 'deny') throw new Error(`The operator denied ${name}; it did not run.`);
        if (decision === 'session' && need.session !== false) allowed.add(name);
      }
      return (execute as (a: unknown, c: unknown) => unknown)(args, ctx);
    };
    return { ...t, function: { ...t.function, execute: gated } } as unknown as T;
  });
}

/**
 * The one box on screen: what, why, the code or command when one line cannot show it, and the keys.
 * Deny is the default. Yellow frame, never red or violet. `maxDetail` caps the code's rows (the
 * transcript fits it to the terminal); the box says how many rows it left out.
 */
export function renderApproval(req: ApprovalRequest, theme: Theme, columns: number, maxDetail = 20): string[] {
  const g = theme.glyphs;
  const width = Math.max(24, Math.min(columns - 1, 72));
  const inner = width - 4;
  const frame = (text: string): Segment => ({ text, role: 'estimate' });
  const pad = (segments: Segment[]): Segment[] => {
    const used = segments.reduce((n, s) => n + visibleWidth(s.text), 0);
    return [frame(`${g.boxVertical} `), ...segments, { text: ' '.repeat(Math.max(0, inner - used)) }, frame(` ${g.boxVertical}`)];
  };
  const title = ' NEEDS YOU ';
  const top: Segment[] = [frame(`${g.boxTopLeft}${g.boxHorizontal}`), { text: ' ' }, { text: 'NEEDS YOU', role: 'strong' }, { text: ' ' }, frame(`${g.boxHorizontal.repeat(width - 3 - visibleWidth(title))}${g.boxTopRight}`)];
  const what = truncate(req.detail ? req.tool : `${req.tool}${req.summary ? `: ${req.summary}` : ''}`, inner - visibleWidth(g.warn) - 1, g.ellipsis);
  const indent = ' '.repeat(visibleWidth(g.warn) + 1);
  const codeIndent = `${indent}  `;
  const rows = req.detail ? detailRows(req.detail, inner - codeIndent.length) : [];
  const shown = rows.length > maxDetail ? rows.slice(0, Math.max(1, maxDetail)) : rows;
  const code = shown.map((r) => serialize(pad([{ text: `${codeIndent}${r}` }]), theme));
  if (shown.length < rows.length) {
    const more = rows.length - shown.length;
    code.push(serialize(pad([{ text: `${codeIndent}${g.ellipsis} ${more} more ${more === 1 ? 'line' : 'lines'} not shown`, role: 'secondary' }]), theme));
  }
  const key = (text: string, role?: Role): Segment => ({ text, role });
  const keys: Segment[] = [
    key('y', 'strong'), key(' allow once ', 'secondary'), key(g.sep, 'secondary'), key(' '),
    ...(req.session === false ? [] : [key('a', 'strong'), key(' allow for session ', 'secondary'), key(g.sep, 'secondary'), key(' ')]),
    key('n, Esc, Enter', 'strong'), key(' deny', 'secondary'),
  ];
  return [
    serialize(top, theme),
    serialize(pad([{ text: g.warn, role: 'estimate' }, { text: ` ${what}` }]), theme),
    serialize(pad([{ text: truncate(`${indent}${req.reason}`, inner, g.ellipsis), role: 'secondary' }]), theme),
    ...code,
    serialize(pad(keys), theme),
    serialize([frame(`${g.boxBottomLeft}${g.boxHorizontal.repeat(width - 2)}${g.boxBottomRight}`)], theme),
  ];
}

/** Read one answer: y once, a session, n/Esc/Enter/Ctrl+C deny. Raw mode only for the read. */
export interface DecisionOptions {
  /** Clock for the type-ahead guard (tests pass their own). */
  now?: () => number;
  /** Keys in this window after the box appears are ignored, so type-ahead never answers. Ctrl+C still denies. */
  guardMs?: number;
  /** false: `a` is not an answer here (the box did not offer it); the tool asks every time. */
  session?: boolean;
}

export function readDecision(stdin: NodeJS.ReadStream, session: TerminalSession, opts: DecisionOptions = {}): Promise<Decision> {
  const now = opts.now ?? Date.now;
  const opened = now();
  const guardMs = opts.guardMs ?? 300;
  emitKeypressEvents(stdin);
  // Leave the terminal as it was found: a running turn keeps raw mode on to watch for Ctrl+C.
  const wasRaw = stdin.isRaw === true;
  const wasFlowing = stdin.readableFlowing === true;
  session.setRaw(true);
  return new Promise((resolve) => {
    const onKey = (str: string | undefined, key: Key = {}): void => {
      const k = (key.name ?? str ?? '').toLowerCase();
      const ctrlC = key.ctrl === true && k === 'c';
      // A paste is never an answer: it denies, whatever it holds (a pasted `y` must not approve).
      const pasted = k === 'paste-start';
      if (!ctrlC && !pasted && now() - opened < guardMs) return;
      const decision: Decision | null = pasted || ctrlC
        ? 'deny'
        : k === 'y' ? 'once' : k === 'a' && opts.session !== false ? 'session' : k === 'n' || k === 'escape' || k === 'return' || k === 'enter' ? 'deny' : null;
      if (!decision) return;
      stdin.off('keypress', onKey);
      session.setRaw(wasRaw);
      if (!wasFlowing) stdin.pause();
      resolve(decision);
    };
    stdin.on('keypress', onKey);
    stdin.resume();
  });
}
