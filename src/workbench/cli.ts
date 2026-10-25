/**
 * `timmy workbench`: the terminal Workbench, one project in five zones: navigation; the project, task, state and Stop;
 * the work; Tools, Inspector and Files; task controls and Activity (R4 H110, the operator's Workbench direction of
 * 2026-10-11: the terminal is the primary operating space; the Companion and Studio share its project, records and
 * operation ids).
 *
 *   timmy workbench           the full-screen app, at a terminal (its alternate screen; the terminal is restored on every
 *                             way out, Ctrl+C included)
 *   timmy workbench --json    the shell's state model (project, navigation, activity, route, files, workflows, jobs) and exit 0
 *   no terminal, no --json    exit 78 with its cause and fix
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../term/session.js';
import { realOnPath } from '../repl/center.js';
import { timmyHome } from '../setup/home.js';
import { workbenchJson } from './state.js';

export const WORKBENCH_USAGE = 'timmy workbench [--json] [--help]';

export function workbenchHelp(): string {
  return [
    'timmy workbench: the terminal Workbench, one project: ten tabs, their workflow actions, and what runs.',
    '',
    'USAGE',
    `  ${WORKBENCH_USAGE}`,
    '',
    'WHAT IT SHOWS (R5: the operator\'s reference layouts; R11 round 7: the hierarchy in cells)',
    '  Row 1    TIMMY, the project, the next turn\'s route and what runs and waits; then the destinations in their groups,',
    '           as the Chat screen\'s rail groups them: Chat · WORK Files, Workflows, Runs & receipts, Canvas · CREATE Vision,',
    '           Motion & 3D · CONNECT Models & accounts, Tools & integrations, Control Room. The one shown is amber (▸);',
    '           ⚠ marks a page where something waits on you, ◌ an unfinished one. The keys stay 1 to 9 and 0: 1 Models &',
    '           accounts (Home), 2 Chat, 3 Workflows, 4 Canvas (Studio), 5 Vision, 6 Motion & 3D, 7 Control Room, 8 Fleet &',
    '           Clef (under Control Room), 9 Tools, 0 Runs & receipts (0 again: Files)',
    '  Row 2    The page head: its title and one-line description, then its numbered actions as the shared workspace frame',
    '           names them (timmy workspace), the one primary next step amber, one that cannot run now grey (#8E8E93;',
    '           selected, it says why); what Enter does with the selected one; the run state and Stop current',
    '  Body     Home: the connections as last observed, and a preview in words of what the companion and Studio show',
    '           (c and s show them rendered). Chat: the pipeline (intent, predict, run, receipt, from the records, else',
    '           "not run yet"), the conversation and its composer, and the event log, the newest first. Every other tab:',
    '           its workspace, with Context (Tools, Inspector, Files) beside it from 120 columns, a drawer below (i)',
    '  Foot     Activity & log: the newest events (a expands it), then the keys',
    '',
    '  Marks    ● live (green: an answer seen in the last 30 minutes) · ○ configured · ✕ unreachable or refused (amber)',
    '           · not set up (with its step) · ? unknown. Green is only ever live, a check that passed, or a receipt that',
    '           verifies here; every state is also said in words.',
    '',
    '  The destinations take the fullest form that fits: their names with their keys and the group names (from 176 columns),',
    '  the rail\'s shorter names with keys (163), the short names with keys (134), the short names with keys and a rule',
    '  between the groups instead of their names (120, so at 122), the short names alone with the rules (100), or the keys',
    '  alone with the shown destination\'s name (80). Under 20 rows the header is one row. The navigation (the same groups,',
    '  every workspace) is a drawer at every size (g; / finds a workspace).',
    '',
    'KEYS',
    '  1 to 9, 0 the tabs (not while a field has the keyboard; a tab\'s key again shows its next workspace)',
    '  Tab, Shift+Tab zones · arrows or j k move · Enter acts · Esc closes · ? lists every key · Ctrl+C quits',
    '  x Stop current · c Companion · Show · s Studio · Show · , Quick settings · m mouse capture on or off',
    '  g the navigation · / find a workspace · i Context · a Activity & log · p switch project · n new project',
    '  r read the records again',
    '',
    '  Enter on a workflow action runs it through the Workbench\'s own path (a tab, Stop, Show, the composer, the Run',
    '  confirm) or shows the command to copy, and says that nothing was run from here.',
    '',
    'THE SAME PROJECT',
    '  Switching or making a project writes the shared active-project record (<Timmy home>/state/active-project.json):',
    '  the REPL, the monitor and Studio follow it. Stop reaches a job through the REPL\'s own /stop (a job this Workbench',
    '  started) or recovery\'s stop (one a session that ended left); another live session\'s job is named, not stopped.',
    '  Closing the companion or Studio never cancels a job.',
    '',
    'EXIT',
    '  0 --json or --help, or Ctrl+C that stopped nothing (another session\'s work keeps running) · 130 Ctrl+C that stopped',
    '  a job or a chat turn this Workbench started · 78 no terminal (run it in one, or use --json) · 2 usage',
    '',
  ].join('\n');
}

export async function workbenchMain(argv: string[], o: { json?: boolean } = {}): Promise<number> {
  const help = argv.includes('--help') || argv.includes('-h');
  const json = o.json === true || argv.includes('--json');
  const unknown = argv.filter((a) => !['--help', '-h', '--json'].includes(a));
  if (help) { process.stdout.write(workbenchHelp()); return 0; }
  if (unknown.length) {
    process.stderr.write(`Error: timmy workbench takes no ${unknown.length === 1 ? 'argument' : 'arguments'} ${unknown.map((a) => JSON.stringify(a)).join(', ')}.\nUsage: ${WORKBENCH_USAGE}\n`);
    return EXIT.usage;
  }
  if (json) {
    let cwd = process.cwd();
    try { cwd = realpathSync(cwd); } catch { /* as given */ }
    const state = await workbenchJson({ cwd, jobsDir: join(timmyHome(), 'jobs'), onPath: (cmd) => realOnPath(cmd, process.env) });
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write([
      'Error: timmy workbench needs a terminal.',
      `  Cause: its ${!process.stdin.isTTY && !process.stdout.isTTY ? 'input and output are' : !process.stdin.isTTY ? 'input is' : 'output is'} not a terminal here (a pipe, a file or a script).`,
      '  Try: run it in a terminal window; timmy workbench --json prints the shell\'s state without one.',
      '',
    ].join('\n'));
    return EXIT.config;
  }
  const { runWorkbench } = await import('./run.js');
  return runWorkbench();
}
