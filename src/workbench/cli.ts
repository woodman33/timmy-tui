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
    'timmy workbench: the terminal Workbench, one project in five zones.',
    '',
    'USAGE',
    `  ${WORKBENCH_USAGE}`,
    '',
    'WHAT IT SHOWS',
    '  Left     the project (p switch, n new), a workspace search (/), CREATE (Chat, Studio, VoxVision, 3D Create, Motion),',
    '           OPERATE (Workflows, Control Room, God\'s Eye View, REA), LIBRARY (Files, Templates, All tools), Connections',
    '  Top      project and workspace, what it is for, this computer, the chat route, the run state, Stop current,',
    '           Companion · Show, Studio · Show and Quick settings',
    '  Center   the workspace: its real records (an empty project says so, with blank guides)',
    '  Right    Tools (named actions; one that cannot run says what it needs), Inspector (the selection), Files',
    '  Bottom   the task\'s controls and Activity (running, waiting on you, the last event; a expands it)',
    '',
    '  At 160 columns and more every zone shows; at 110 to 159 the right dock is a drawer (i); under 110 the navigation',
    '  is a drawer too (g). The project, the task, the state and Stop show at every size.',
    '',
    'KEYS',
    '  Tab, Shift+Tab regions · arrows or j k move · Enter acts · Esc closes · ? lists every key · Ctrl+C quits',
    '  x Stop current · c Companion · Show · s Studio · Show · , Quick settings · m mouse capture on or off',
    '',
    'THE SAME PROJECT',
    '  Switching or making a project writes the shared active-project record (<Timmy home>/state/active-project.json):',
    '  the REPL, the monitor and Studio follow it. Stop reaches a job through the REPL\'s own /stop (a job this Workbench',
    '  started) or recovery\'s stop (one a session that ended left); another live session\'s job is named, not stopped.',
    '',
    'EXIT',
    '  0 --json or --help · 78 no terminal (run it in one, or use --json) · 130 quit with Ctrl+C · 2 usage',
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
