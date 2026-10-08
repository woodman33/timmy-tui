/**
 * `timmy repl`: the inline REPL (DESIGN.md §10 B1). One turn, one column: the block input, then the
 * agent's turn rendered inline, then the input again. `--demo` drives the same renderer with a script.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { emitKeypressEvents, type Key } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgent } from '../agent/core.js';
import { defaultTools } from '../agent/tools.js';
import { loadConfig } from '../utils/config.js';
import { readChain, receiptsDir, verifyChain } from '../utils/receipts.js';
import { identityPath } from '../utils/init.js';
import { setupCheck } from './setup.js';
import { sealTurn, type SealedTurn, type TurnFacts } from './seal.js';
import { editExternally } from './external-editor.js';
import { listLanes } from '../utils/dispatch.js';
import { currentCapabilities, type TerminalCapabilities } from '../term/capabilities.js';
import { LiveRegion } from '../term/live-region.js';
import { measuredFromPalette, namedPalette, TIMMY_DAY, TIMMY_HOMEBREW, TIMMY_NIGHT, type MeasuredColors } from '../term/palettes.js';
import { measureTerminal } from '../term/probe.js';
import { EXIT, TerminalSession } from '../term/session.js';
import { buildTheme, fitSegments, roleSlots, serialize, type Segment, type Theme } from '../term/theme.js';
import { DEMO_LOADER, DEMO_TURN, type DemoStep } from './demo.js';
import { hyperlink, OSC133 } from '../term/marks.js';
import { gateTools, readDecision } from './approvals.js';
import { COMMANDS, runSlash, type ReceiptsView, type ReplContext, type ThemeInfo } from './commands.js';
import { LineEditor } from './editor.js';
import { readPrompt } from './input.js';
import { nearest } from './suggest.js';
import { runTurn, type TurnAbandon, type TurnAgent, type TurnInspect } from './turn.js';
import { Transcript, type InspectRow } from './transcript.js';
import { onPath, packageRoot, realOnPath } from './center.js';
import { planWeb, RECEIPT_ID, receiptUrl, resolveWebTarget } from './web.js';
import { CanvasTurnJob, createCanvasTools, linkCanvasReceipt, type CanvasJobResult } from '../agent/canvas-tools.js';
import { studioBaseUrl, studioPort } from '../studio/config.js';
import { ensureStudioServer, type EnsureResult } from '../studio/server.js';
import { studioHealth } from '../studio/health.js';
import { canvasView } from './canvas-view.js';
import { capabilities } from '../capabilities/index.js';
import { liveDeps } from '../capabilities/live.js';
import { capabilityLines } from '../capabilities/render.js';

export interface ReplFlags {
  demo?: boolean;
  demoLoader?: boolean;
  plain?: boolean;
  color?: boolean;
  help?: boolean;
}

/** One registry for the flags: parsing and --help both read it (playbook §16.6). */
const FLAGS: Array<{ names: string[]; description: string; set: (f: ReplFlags) => void }> = [
  { names: ['--demo'], description: 'Play one scripted turn on the real renderer (no network, no key)', set: (f) => { f.demo = true; } },
  { names: ['--demo-loader'], description: 'Hold the loader for about 10 seconds', set: (f) => { f.demoLoader = true; } },
  { names: ['--plain'], description: 'One line per status change, words for glyphs, no redraws', set: (f) => { f.plain = true; } },
  { names: ['--color'], description: 'Color even when the output is not a terminal', set: (f) => { f.color = true; } },
  { names: ['--no-color'], description: 'No color (NO_COLOR works too)', set: (f) => { f.color = false; } },
  { names: ['-h', '--help'], description: 'Show this help', set: (f) => { f.help = true; } },
];

export function parseReplArgs(argv: string[]): ReplFlags | { error: string } {
  const flags: ReplFlags = {};
  for (const arg of argv) {
    const known = FLAGS.find((f) => f.names.includes(arg));
    if (known) {
      known.set(flags);
      continue;
    }
    const near = nearest(arg, FLAGS.flatMap((f) => f.names));
    return { error: `Unknown option: ${arg}.${near ? ` Did you mean ${near}?` : ' Try timmy repl --help.'}` };
  }
  return flags;
}

/** `timmy repl --help`, built from the flag registry and the slash-command registry. */
export function replHelp(): string {
  const flagRows = FLAGS.map((f) => `  ${f.names.join(', ').padEnd(16)} ${f.description}`);
  const commandRows = COMMANDS.map((c) => `  /${c.name.padEnd(11)} ${c.description}`);
  return [
    'timmy repl: the inline REPL. You type, Timmy works in your scrollback, and every step stays on screen.',
    '',
    'USAGE',
    '  timmy repl [options]',
    '',
    'OPTIONS',
    ...flagRows,
    '',
    'COMMANDS (type them at the prompt)',
    ...commandRows,
    '',
    'KEYS',
    '  Enter sends, Ctrl+J adds a line, Ctrl+C cancels a turn (twice, or on an empty prompt, quits)',
    '',
    'EXAMPLES',
    '  # chat in this folder',
    '  timmy repl',
    '  # see the renderer without a model key',
    '  timmy repl --demo',
    '  # one question from a pipe; only the answer goes to stdout',
    '  echo "summarize README.md" | timmy repl > answer.txt',
    '',
  ].join('\n');
}

// The REPL and the monitor measure the same way (row 28); the function lives with the probe.
export { measureTerminal };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function play(transcript: Transcript, steps: DemoStep[]): Promise<void> {
  for (const s of steps) {
    if (s.delayMs) await sleep(s.delayMs);
    transcript.handle(s.event);
  }
  transcript.endTurn();
}

/** What the REPL agent is told: concise, path-explicit, verify with tools, finish the task (§17.4). */
export const REPL_INSTRUCTIONS = [
  'You are Timmy, an agent working in the operator\'s terminal.',
  'Be concise. Name files and paths exactly.',
  'Verify with tools before you report a result, and say plainly what you could not verify.',
  'Finish the task instead of asking whether to continue.',
  'Never claim a receipt, a signature or a verification that a tool did not return.',
].join(' ');

const tildify = (path: string): string => {
  const home = homedir();
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
};

/**
 * The agent's tools in the REPL: the defaults and Timmy Canvas (F-4), each under a NEEDS YOU rule. The
 * canvas calls of one turn share that turn's canvas job (fourth order, step 5).
 */
export function replTools(job?: CanvasTurnJob): typeof defaultTools {
  return [...defaultTools, ...createCanvasTools({ job })];
}

export async function runRepl(argv: string[]): Promise<number> {
  const flags = parseReplArgs(argv);
  if ('error' in flags) {
    process.stderr.write(`${flags.error}\n`);
    return EXIT.usage;
  }
  if (flags.help) {
    process.stdout.write(replHelp());
    return EXIT.ok;
  }
  const caps = currentCapabilities({ plain: flags.plain, color: flags.color });
  const session = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  session.install();
  const measured = await measureTerminal(caps, process.env, { stdin: process.stdin, stdout: process.stdout });
  const theme = buildTheme(caps, measured);
  const region = new LiveRegion({ out: process.stdout, err: process.stderr }, { live: caps.animate });
  // However the REPL ends (a signal mid-turn included), its live line goes first, so whatever the shell
  // prints next starts a clean line, not the spinner's (the 20:14 order).
  session.beforeRestore(() => region.close());
  // Into a pipe, stdout carries only the answer; steps, footers and errors go to stderr (§16.7).
  const log = process.stdout.isTTY ? undefined : new LiveRegion({ out: process.stderr, err: process.stderr }, { live: false });
  const transcript = new Transcript(theme, region, { columns: caps.columns, rows: caps.rows, err: process.stderr, log });
  if (flags.demo || flags.demoLoader) {
    if (caps.animate) session.hideCursor();
    await play(transcript, flags.demoLoader ? DEMO_LOADER : DEMO_TURN);
    session.restore();
    return EXIT.ok;
  }

  const config = loadConfig();
  const interactive = caps.interactive && region.live && !caps.plain;
  // C-14: in a terminal a missing key does not end the REPL: the first run opens with the setup check,
  // which says what is missing. A pipe or a script still gets the config error (exit 78).
  if (!config.apiKey && !interactive) {
    const fail = serialize([{ text: `${theme.glyphs.fail} Error:`, role: 'failure' }], theme);
    process.stderr.write(`  ${fail} no model key, so Timmy cannot answer.\n    Cause: OPENROUTER_API_KEY is not set and timmy init stored no key.\n    Try: timmy init, or export OPENROUTER_API_KEY=<your key>\n    Help: timmy repl --help\n`);
    session.restore();
    return EXIT.config;
  }
  const agent = createAgent(
    { apiKey: config.apiKey ?? '', model: config.model, instructions: REPL_INSTRUCTIONS, maxSteps: 10, maxCost: 1 },
    { multiplexer: 'none' },
  );
  const approval = { active: false };
  const canvasJob = new CanvasTurnJob();
  // NEEDS YOU: risky calls wait for the operator; with no terminal to ask, they are denied (§17.8).
  agent.setTools(
    gateTools(replTools(canvasJob), async (req) => {
      if (!interactive) {
        transcript.handle({ type: 'needs-you-answered', tool: req.tool, decision: 'no-terminal' });
        return 'deny';
      }
      transcript.handle({ type: 'needs-you', ...req });
      approval.active = true;
      const decision = await readDecision(process.stdin, session).finally(() => { approval.active = false; });
      transcript.handle({ type: 'needs-you-answered', tool: req.tool, decision });
      return decision;
    }),
  );
  const themeInfo = (): ThemeInfo => {
    const named = namedPalette(process.env.TIMMY_PALETTE);
    const secondary = theme.open('secondary');
    return {
      source: named ? `TIMMY_PALETTE=${process.env.TIMMY_PALETTE}` : measured.background ? 'measured (OSC 11)' : 'unknown (the terminal did not answer)',
      background: measured.background,
      secondary: secondary === '\x1b[37m' ? 'white (37)' : secondary === '\x1b[90m' ? 'gray (90)' : 'your text color',
      tint: theme.tint,
      files: join(packageRoot(), 'assets', 'themes'),
      color: caps.color > 0,
      meanings: (({ verified, estimate, failure, ai }) => ({ verified, estimate, failure, ai }))(roleSlots(caps, measured)),
    };
  };
  const receipts = (): ReceiptsView => {
    const v = verifyChain('runs');
    const when = (iso: string): string => {
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const recent = readChain('runs').slice(-5).reverse().map((r) => ({ hash: r.hash, kind: r.kind, when: when(r.ts) }));
    return { verify: { ok: v.ok, count: v.count, reason: v.reason }, recent };
  };
  const openWatch = (): string => {
    const again = [...process.execArgv, process.argv[1], 'watch'];
    const line = [process.execPath, ...again].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    if (process.env.TMUX) {
      spawnSync('tmux', ['split-window', '-h', '-l', '42%', line], { stdio: 'ignore' });
      return 'in a tmux pane';
    }
    if (process.env.ZELLIJ !== undefined) {
      spawnSync('zellij', ['action', 'new-pane', '--direction', 'right', '--', process.execPath, ...again], { stdio: 'ignore' });
      return 'in a zellij pane';
    }
    spawnSync(process.execPath, again, { stdio: 'inherit' });
    return 'and closed; back in the REPL';
  };
  // /center (C-10): inside tmux or zellij a new cockpit would nest (and stack tabs), so it says so;
  // otherwise the cockpit takes this terminal and the REPL comes back when it ends or detaches.
  const openCenter = (): string => {
    if (process.env.TMUX || process.env.ZELLIJ !== undefined) return 'This terminal is already in a multiplexer. Run timmy center in a new terminal.';
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], 'center'], { stdio: 'inherit' });
    return r.status === 0 ? 'Cockpit closed; back in the REPL.' : `The cockpit ended with exit ${r.status ?? 'signal'}; back in the REPL.`;
  };
  // /web studio: Timmy Canvas runs inside this REPL unless another Timmy already serves it. listen()
  // binds at once, so the viewer's first request waits in the socket's queue, never on a closed port.
  // Round R1: one address (TIMMY_STUDIO_URL, else TIMMY_STUDIO_PORT, else 4337). An address set by
  // TIMMY_STUDIO_URL is someone else's to serve; only a server this REPL started is kept for reuse.
  const external = Boolean(process.env.TIMMY_STUDIO_URL?.trim());
  let owned: Promise<EnsureResult> | null = null;
  const ensureCanvas = (): Promise<EnsureResult> | null => {
    if (external) return null;
    owned ??= ensureStudioServer(studioPort(process.env), { env: process.env }).then((r) => {
      if (r.state !== 'started') owned = null;
      return r;
    });
    return owned;
  };
  const openWeb = (target: string, allowRemote: boolean): string => {
    // Timmy Canvas and the receipt pages (C-13) are served by this REPL unless another Timmy already does.
    if (target.trim() === 'studio' || RECEIPT_ID.test(target.trim())) void ensureCanvas();
    const plan = planWeb({ url: resolveWebTarget(target), has: (bin) => onPath(bin, process.env), locate: (bin) => realOnPath(bin, process.env), env: process.env, allowRemote });
    if (plan.route === 'link') return `Open ${caps.cursor ? hyperlink(plan.url, plan.url, true) : plan.url} in your browser.`;
    if (plan.route === 'refused' || !plan.command) return plan.note;
    if (plan.route === 'tmux') {
      // display-popup waits until the page closes; run it beside the REPL so the REPL is not held.
      const child = spawn(plan.command, plan.args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
      return plan.note;
    }
    const r = spawnSync(plan.command, plan.args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    const why = r.error?.message ?? (r.status !== 0 ? (r.stderr?.split('\n').find((l) => l.trim()) ?? `exit ${r.status}`) : '');
    return why ? `Could not open the web view (${why}). Open ${plan.url} in your browser.` : plan.note;
  };
  // Round R1: /canvas, and where to inspect each turn's result, preview and receipt.
  const canvas = (args: string): Promise<Segment[][]> => canvasView(args, {
    base: studioBaseUrl(process.env),
    ensure: async () => {
      const r = ensureCanvas();
      if (!r) return null;
      const done = await r;
      return done.state === 'failed' ? { state: 'failed', error: done.error } : { state: done.state };
    },
    health: (base) => studioHealth(base),
    open: () => openWeb('studio', false),
    glyphs: theme.glyphs,
  });
  // Round R1: /tools, every capability on the ladder, from live checks that write nothing.
  const tools = async (args: string): Promise<Segment[][]> => {
    const rows = await capabilities(liveDeps({ env: process.env, key: () => config.apiKey ?? null, model: agent.getModel() }), { all: args.trim() === 'all' });
    return capabilityLines(rows, theme.glyphs, caps.columns);
  };
  let lastCanvas: CanvasJobResult[] = [];
  let lastLinks: Array<Promise<{ job: string; ok: boolean }>> = [];
  const inspect: NonNullable<TurnInspect['inspect']> = async (sealed) => {
    const base = studioBaseUrl(process.env);
    const started = await (ensureCanvas() ?? Promise.resolve(null));
    const health = await studioHealth(base, 800);
    const serving = health.state === 'running';
    const jobs = lastCanvas;
    const links = await Promise.all(lastLinks);
    lastCanvas = [];
    lastLinks = [];
    const rows: InspectRow[] = [];
    for (const c of jobs) {
      const linked = links.find((l) => l.job === c.job)?.ok;
      const page = serving && health.pageConnected ? 'open in your browser' : '/canvas open';
      rows.push({ label: 'Canvas', text: `job ${c.job}, rev ${c.revision}`, url: `${base}/`, hint: linked === false ? 'not linked to its receipt on the board' : page });
    }
    if (sealed) {
      const url = receiptUrl(sealed.id);
      rows.push(serving
        ? { label: 'Receipt', text: url, url, hint: 'or timmy receipts' }
        : { label: 'Receipt', text: 'timmy receipts', hint: started?.state === 'failed' ? `no receipt page: ${started.error}` : 'the receipt page is not served' });
    }
    return rows;
  };
  const where = async (): Promise<Segment[]> => {
    const base = studioBaseUrl(process.env);
    const h = await studioHealth(base, 500);
    const store = receiptsDir();
    const rel = relative(process.cwd(), store);
    const shownStore = rel && !rel.startsWith('..') ? rel : tildify(store);
    const sep = ` ${theme.glyphs.sep} `;
    const canvasNow = h.state === 'running' ? `canvas ${base}/${h.pageConnected ? ' (page open)' : ''}` : 'canvas not running (/canvas)';
    return [{ text: `  ${tildify(process.cwd())}${sep}receipts ${shownStore}${sep}${canvasNow}`, role: 'secondary' }];
  };
  const setup = (): Segment[][] => setupCheck({
    operator: readOperator(),
    key: Boolean(config.apiKey),
    palette: timmyPalette(measured, process.env),
    themes: join(packageRoot(), 'assets', 'themes'),
  }, theme.glyphs).lines;
  return replLoop({
    agent, caps, theme, region, transcript, session, stdin: process.stdin, stdout: process.stdout, approval, themeInfo, receipts, openWatch, openWeb,
    setup, noKey: !config.apiKey, firstRun: readChain('runs').length === 0, lanes: listLanes, openCenter, canvas, inspect, where, tools,
    // C-13: the receipt line links to its page; the local server that shows it starts with the first seal.
    seal: (facts) => {
      // Fourth order, step 5: a turn that used the canvas names each job and the saved canvas it left,
      // and the canvas server learns which receipt sealed each job.
      const jobs = canvasJob.close();
      const sealed = sealTurn({ ...facts, model: agent.getModel(), ...(jobs.length ? { canvas: jobs } : {}) });
      void ensureCanvas();
      // Round R1: the links' outcomes reach the turn's "where to inspect" rows; a failed link is said.
      lastCanvas = jobs;
      lastLinks = jobs.map((c) => linkCanvasReceipt(c.job, sealed.id).then((ok) => ({ job: c.job, ok })));
      return { ...sealed, url: receiptUrl(sealed.id) };
    },
  });
}

/** The operator named in identity.json, or null on a blank slate (or an unreadable file). */
function readOperator(): string | null {
  try {
    const id = JSON.parse(readFileSync(identityPath(), 'utf8')) as { operator?: unknown };
    return typeof id.operator === 'string' && id.operator ? id.operator : null;
  } catch {
    return null;
  }
}

/** Timmy Homebrew, Night or Day when TIMMY_PALETTE names it or the terminal's answers match it; otherwise null. */
export function timmyPalette(measured: MeasuredColors, env: Record<string, string | undefined>): 'homebrew' | 'night' | 'day' | null {
  const named = (env.TIMMY_PALETTE ?? '').toLowerCase();
  if (namedPalette(named)) return named as 'homebrew' | 'night' | 'day';
  for (const [name, p] of [['homebrew', TIMMY_HOMEBREW], ['night', TIMMY_NIGHT], ['day', TIMMY_DAY]] as const) {
    const ref = measuredFromPalette(p);
    const same = (a: string | null | undefined, b: string | null | undefined): boolean => Boolean(a) && a?.toUpperCase() === b?.toUpperCase();
    if (same(measured.background, ref.background) && [7, 8].every((n) => same(measured.slots[n], ref.slots[n]))) return name;
  }
  return null;
}

export interface ReplAgent extends TurnAgent {
  getModel(): string;
  setModel(model: string): void;
  startSession(): string;
}

export interface ReplDeps {
  agent: ReplAgent;
  caps: TerminalCapabilities;
  theme: Theme;
  region: LiveRegion;
  transcript: Transcript;
  session: TerminalSession;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /** Set while NEEDS YOU reads a key, so Ctrl+C there denies the call instead of cancelling the turn. */
  approval?: { active: boolean };
  themeInfo?: () => ThemeInfo;
  receipts?: () => ReceiptsView;
  openWatch?: () => string;
  openWeb?: (target: string, allowRemote: boolean) => string;
  /** The setup check (C-14). */
  setup?: () => Segment[][];
  /** No model key: messages get the cause and the fix instead of a turn (C-14). */
  noKey?: boolean;
  /** No receipts yet: the first prompt holds the setup check, ready for Enter (C-14). */
  firstRun?: boolean;
  /** Seals each finished turn as a receipt (C-8); without it a turn closes with its footer. */
  seal?: (facts: TurnFacts) => SealedTurn;
  /** /lanes and /center (C-10). */
  lanes?: ReplContext['lanes'];
  openCenter?: () => string;
  /** Round R1: /canvas; where each turn's result, preview and receipt are; where this REPL works. */
  canvas?: ReplContext['canvas'];
  inspect?: TurnInspect['inspect'];
  where?: () => Promise<Segment[]>;
  /** Round R1: /tools, what works here. */
  tools?: ReplContext['tools'];
}

/** During a turn, Ctrl+C arrives as a key in raw mode; it cancels the turn (playbook §16.2). */
function watchCtrlC(stdin: NodeJS.ReadStream, session: TerminalSession, onCtrlC: () => void): () => void {
  emitKeypressEvents(stdin);
  session.setRaw(true);
  const onKey = (_s: string | undefined, key: Key = {}): void => {
    if (key.ctrl && key.name === 'c') onCtrlC();
  };
  stdin.on('keypress', onKey);
  stdin.resume();
  return () => {
    stdin.off('keypress', onKey);
    session.setRaw(false);
    stdin.pause();
  };
}

/** The slash menu's entries: the registry itself (C-10, B6). */
const MENU = COMMANDS.map(({ name, description }) => ({ name, description }));

/** Prompt, turn, prompt: the REPL itself, independent of how the agent was made. */
export async function replLoop(d: ReplDeps): Promise<number> {
  const { agent, caps, theme, region, transcript, session } = d;
  const interactive = caps.interactive && region.live && !caps.plain;
  const say = (segments: Segment[]): void => void region.commit([serialize(fitSegments(segments, caps.columns, theme.glyphs.ellipsis), theme)]);
  if (interactive) {
    say([{ text: 'TIMMY', role: 'accent' }, { text: `  ${agent.getModel()}`, role: 'secondary' }]);
    // Round R1: where this REPL works: the folder, where receipts go, and Timmy Canvas's state.
    if (d.where) {
      const line = await Promise.race([d.where(), sleep(1500).then(() => null)]).catch(() => null);
      if (line) say(line);
    }
    say([{ text: `Type a message to start. ${d.tools ? '/tools shows what works here, ' : ''}/help for commands, /exit to quit.`, role: 'secondary' }]);
    // A first run offers the setup check and leaves the prompt empty: a prefilled /setup turned a typed
    // /exit into /setup/exit (the 20:14 order).
    if (d.firstRun && d.setup) say([{ text: 'First run: type ', role: 'secondary' }, { text: '/setup', role: 'strong' }, { text: ' to check what Timmy needs.', role: 'secondary' }]);
    region.commit(['']);
  }
  const marks = d.stdout.isTTY === true;
  const turnMarks = marks
    ? { start: () => void d.stdout.write(OSC133.outputStart), end: (status: number) => void d.stdout.write(OSC133.end(status)) }
    : undefined;
  const editor = new LineEditor();
  let status: number = EXIT.ok;
  for (;;) {
    const r = await readPrompt({ stdin: d.stdin, stdout: d.stdout, caps, theme, region, session, editor, marks, commands: MENU, openEditor: (text) => editExternally(text) });
    if (r.kind === 'cancel') {
      session.restore();
      return EXIT.cancelled;
    }
    if (r.kind === 'eof') break;
    const text = r.text.trim();
    if (!text) continue;
    if (text === 'exit' || text === 'quit') break;
    if (text.startsWith('/')) {
      const ctx = { agent, print: say, glyphs: theme.glyphs, themeInfo: d.themeInfo, receipts: d.receipts, openWatch: d.openWatch, openWeb: d.openWeb, setup: d.setup, lanes: d.lanes, openCenter: d.openCenter, canvas: d.canvas, tools: d.tools };
      if ((await runSlash(text, ctx)) === 'exit') break;
      region.commit(['']);
      continue;
    }
    if (d.noKey) {
      say([{ text: `${theme.glyphs.fail} Error:`, role: 'failure' }, { text: ' no model key, so Timmy cannot answer.' }]);
      say([{ text: '  Cause: no OPENROUTER_API_KEY, and init stored none.', role: 'secondary' }]);
      say([{ text: '  Try: timmy init, or export OPENROUTER_API_KEY', role: 'secondary' }]);
      say([{ text: '  Help: /help, or timmy repl --help', role: 'secondary' }]);
      region.commit(['']);
      continue;
    }
    if (interactive) transcript.handle({ type: 'prompt', text, cwd: tildify(process.cwd()), echoed: true, model: agent.getModel() });
    const controller = new AbortController();
    const abandon: TurnAbandon = {};
    // First Ctrl+C cancels the turn; a second, while that cancel has not landed, quits (exit 130),
    // as the note on screen says. Ctrl+C while NEEDS YOU waits belongs to the approval (it denies).
    // Before quitting, the turn is sealed as it stands: a cancel that never landed is still a cancel.
    const onCtrlC = (): void => {
      if (d.approval?.active) return;
      if (controller.signal.aborted) {
        abandon.now?.();
        region.close();
        turnMarks?.end(EXIT.cancelled);
        return session.exit(EXIT.cancelled);
      }
      controller.abort();
      transcript.handle({ type: 'cancelling' });
    };
    const stopWatching = interactive ? watchCtrlC(d.stdin, session, onCtrlC) : () => {};
    if (caps.animate) session.hideCursor();
    const result = await runTurn(agent, transcript, text, Date.now, turnMarks, controller.signal, d.seal, abandon, { inspect: d.inspect });
    stopWatching();
    if (!interactive && result === 'failed') status = EXIT.failure;
    if (interactive) region.commit(['']);
  }
  session.restore();
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRepl(process.argv.slice(2)).then((code) => process.exit(code));
}
