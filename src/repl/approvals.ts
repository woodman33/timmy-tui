/**
 * NEEDS YOU (plan C-7, playbook §17.8). A dangerous-only policy decides which tool calls wait for the
 * operator: read-only tools never ask; calls that send data or actions off the machine always ask;
 * workspace shell commands ask when they look destructive; unknown tools ask. The box offers
 * y (once), a (this session), n, Esc or Enter (deny, the default). Without a terminal: deny.
 */
import { emitKeypressEvents, type Key } from 'node:readline';
import { sanitize } from '../term/sanitize.js';
import type { TerminalSession } from '../term/session.js';
import { serialize, type Role, type Segment, type Theme } from '../term/theme.js';
import { truncate, visibleWidth } from '../term/width.js';

export type Decision = 'once' | 'session' | 'deny';

export interface ApprovalRequest {
  tool: string;
  reason: string;
  summary: string;
}

const READ_ONLY = new Set([
  'get_current_time', 'calculate', 'get_system_info', 'list_local_spatial_models', 'read_spatial_model_context',
  'review_spatial_with_local_model', 'browser_get_snapshot', 'browser_take_screenshot', 'cloudflare_get_feature_flag',
  // Timmy Canvas: fixed read-only code (the model's words arrive only as a JSON string).
  'canvas_read', 'canvas_api',
]);

const ALWAYS: Record<string, { reason: string; keys: string[] }> = {
  get_env: { reason: 'sends a value from your environment to the model', keys: ['name'] },
  stress_test_endpoint: { reason: 'sends load to a remote endpoint', keys: ['url', 'endpoint'] },
  cloudflare_send_durable_pulse: { reason: 'writes to a remote service', keys: ['message', 'payload'] },
  trigger_background_workflow: { reason: 'starts work on a remote service', keys: ['workflow', 'name', 'job'] },
  manage_composio_integrations: { reason: 'changes your connected integrations', keys: ['action', 'app'] },
  browser_launch_cdp: { reason: 'opens a browser', keys: ['url'] },
  browser_click_element: { reason: 'acts on a web page', keys: ['selector', 'ref'] },
  list_card: { reason: 'posts a listing to a marketplace', keys: ['title', 'name'] },
  canvas_exec: { reason: 'runs code in the canvas page, which can reach the network', keys: ['code'] },
};

const SHELL: Record<string, string[]> = { run_in_daytona_workspace: ['command'] };
const DESTRUCTIVE = /\brm\b|sudo|chmod|chown|\bdd\b|mkfs/;

/** What the box shows, cleaned: the model wrote it, and a backspace must not disguise a command. */
function summarize(args: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (typeof args[k] === 'string' && args[k]) return sanitize(args[k] as string).replace(/\s+/g, ' ').trim();
  const json = JSON.stringify(args) ?? '';
  return json === '{}' ? '' : sanitize(json);
}

/** Why this call must wait for the operator, or null when it may run. */
export function approvalNeeded(tool: string, args: Record<string, unknown> = {}): { reason: string; summary: string } | null {
  if (READ_ONLY.has(tool)) return null;
  const always = ALWAYS[tool];
  if (always) return { reason: always.reason, summary: summarize(args, always.keys) };
  // Every workspace command asks: without a Daytona key it runs on this machine, and no pattern can
  // tell a safe command from a harmful one (review finding).
  const shell = SHELL[tool];
  if (shell) {
    const command = summarize(args, shell);
    return { reason: DESTRUCTIVE.test(command) ? 'destructive shell command' : 'runs a shell command', summary: command };
  }
  return { reason: 'unknown tool', summary: summarize(args, []) };
}

interface ToolLike {
  type: string;
  function: { name: string; execute?: unknown; [k: string]: unknown };
}

/** Wrap each tool's execute so a call that needs approval waits for `ask`; a denial reaches the model. */
export function gateTools<T>(tools: readonly T[], ask: (req: ApprovalRequest) => Promise<Decision>): T[] {
  const allowed = new Set<string>();
  // The SDK runs a round's tool calls in parallel; asks wait in line so one keypress answers one box.
  let line: Promise<unknown> = Promise.resolve();
  const inTurn = <R>(fn: () => Promise<R>): Promise<R> => {
    const next = line.then(fn, fn);
    line = next.catch(() => {});
    return next;
  };
  return tools.map((original) => {
    const t = original as unknown as ToolLike;
    const execute = t.function?.execute;
    if (typeof execute !== 'function') return original;
    const name = t.function.name;
    const gated = async (args: Record<string, unknown>, ctx: unknown) => {
      const need = approvalNeeded(name, args ?? {});
      if (need && !allowed.has(name)) {
        // Re-check after waiting: an earlier box may have allowed this tool for the session.
        const decision = await inTurn(async () => (allowed.has(name) ? 'session' : ask({ tool: name, ...need })));
        if (decision === 'deny') throw new Error(`The operator denied ${name}; it did not run.`);
        if (decision === 'session') allowed.add(name);
      }
      return (execute as (a: unknown, c: unknown) => unknown)(args, ctx);
    };
    return { ...t, function: { ...t.function, execute: gated } } as unknown as T;
  });
}

/** The one box on screen: what, why, and the keys. Deny is the default. Yellow frame, never red or violet. */
export function renderApproval(req: ApprovalRequest, theme: Theme, columns: number): string[] {
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
  const what = truncate(`${req.tool}${req.summary ? `: ${req.summary}` : ''}`, inner - visibleWidth(g.warn) - 1, g.ellipsis);
  const indent = ' '.repeat(visibleWidth(g.warn) + 1);
  const key = (text: string, role?: Role): Segment => ({ text, role });
  const keys: Segment[] = [
    key('y', 'strong'), key(' allow once ', 'secondary'), key(g.sep, 'secondary'), key(' '),
    key('a', 'strong'), key(' allow for session ', 'secondary'), key(g.sep, 'secondary'), key(' '),
    key('n, Esc, Enter', 'strong'), key(' deny', 'secondary'),
  ];
  return [
    serialize(top, theme),
    serialize(pad([{ text: g.warn, role: 'estimate' }, { text: ` ${what}` }]), theme),
    serialize(pad([{ text: truncate(`${indent}${req.reason}`, inner, g.ellipsis), role: 'secondary' }]), theme),
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
        : k === 'y' ? 'once' : k === 'a' ? 'session' : k === 'n' || k === 'escape' || k === 'return' || k === 'enter' ? 'deny' : null;
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
