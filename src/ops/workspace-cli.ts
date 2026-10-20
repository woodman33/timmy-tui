/**
 * R5 lead (2026-10-15): `timmy workspace`, the one workspace frame (src/contracts/workspace.ts) that the terminal Workbench,
 * the browser companion and Timmy Studio draw around their own content: the project, the ten tabs, each tab's actions with
 * one primary next step, the connections as observed, what runs and waits, the newest activity.
 *
 *   timmy workspace [--json]          the frame (reads the records only; never the network)
 *   timmy workspace check [--json]    asks each service once with free requests (OpenRouter's key endpoint, the local Ollama's
 *                                     model list, Studio's health, the Cloudflare edge's /health when one is set up), records
 *                                     what answered in <Timmy home>/state/connections.json, then prints the frame
 *
 * No model is called and nothing is spent. A connection is `live` only when one of those requests was answered within the
 * last 30 minutes (R6, H140: the browser companion and Studio within the last 60 s, by a process that still runs); a setting
 * alone is `configured`.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { realOnPath } from '../repl/center.js';
import { timmyHome } from '../setup/home.js';
import type { WorkspaceConnection, WorkspaceFrame } from '../contracts/workspace.js';
import { STOP_MARK } from '../contracts/stop-words.js';
import { buildWorkspaceFrame, checkConnections, type CheckDeps } from './workspace-frame.js';

export const WORKSPACE_USAGE = 'timmy workspace [check] [--json] [--help]';

export function workspaceHelp(): string {
  return [
    'timmy workspace: the frame every surface shares (the terminal Workbench, the browser companion, Timmy Studio).',
    '',
    'USAGE',
    `  ${WORKSPACE_USAGE}`,
    '',
    '  timmy workspace          the project, the ten tabs and their keys, each tab\'s actions (one primary next step),',
    '                           the connections as last observed, what runs and waits on you, the chat turns (how each',
    '                           ended and who asked), the newest activity',
    '  timmy workspace check    asks each service once with a free request and records what answered, then prints it:',
    '                           OpenRouter\'s key endpoint (no model call), the local Ollama\'s model list, Timmy Studio\'s',
    '                           health, and the Cloudflare edge\'s /health when one is set up',
    '  --json                   the frame as JSON (schema timmy.workspace/1), one object',
    '',
    'WORDS',
    '  live         a request it answered was observed in the last 30 minutes (and when, is said); the browser',
    '               companion and Timmy Studio: in the last 60 s, by a process that still runs (a start is no answer)',
    '  configured   set up, not observed answering lately: a setting is not a connection',
    '  not set up   with the step that sets it up',
    '  unreachable  asked, and nothing answered · refused: asked, and it answered no (a rejected key)',
    '  unknown      nothing on this computer says',
    '',
    'EXIT',
    '  0 the frame was printed · 2 usage',
    '',
  ].join('\n');
}

const MARK: Record<WorkspaceConnection['state'], string> = {
  live: '● live', configured: '○ configured', 'not set up': '· not set up', unreachable: '✕ unreachable', refused: '✕ refused', unknown: '? unknown',
};
/** R6 (H140): a sealed chat turn's mark (its words say how it ended): as the Workbench's Control Room marks them. */
const TURN_MARK: Readonly<Record<string, string>> = { answered: '✓', stopped: STOP_MARK, failed: '✕' };

/** The frame in plain words, for a terminal or a log: no color, every state carries its word and its mark. */
export function workspaceLines(f: WorkspaceFrame): string[] {
  const out: string[] = [];
  out.push(`Project  ${f.project.name}  (${f.project.shown})${f.project.chosen ? '' : '  the current folder; nothing chosen'}`);
  out.push(`         switch: ${f.project.switch} · new: ${f.project.create}`);
  // R9 lead, after the R9 independent review (its claim 7): an unfinished tab carries ◌ here too, as on every surface
  out.push(`Tabs     ${f.tabs.map((t) => `${t.key} ${t.label}${t.unfinished ? ' ◌' : ''}${t.waiting ? ` (${t.waiting} waiting)` : ''}`).join(' · ')}`);
  const home = f.actions.home;
  const next = home.find((a) => a.primary);
  out.push(`Next     ${next ? `${next.label}: ${next.command}` : 'nothing is next'}`);
  out.push(`Activity ${f.activity.running} running · ${f.activity.waitingOnYou} waiting on you · ${f.activity.stopCurrent.words}`);
  out.push('');
  out.push('Connections');
  const w = Math.max(...f.connections.map((c) => c.label.length));
  for (const c of f.connections) {
    out.push(`  ${c.label.padEnd(w)}  ${MARK[c.state].padEnd(14)} ${c.words}${c.setup && c.state !== 'live' ? `  → ${c.setup}` : ''}`);
  }
  // R6 (H140; the R5 interaction review, defect 10: the words had no line for any turn though --json had them): the chat turns,
  // a turn being answered first, then the sealed ones newest first, each with how it ended and who asked (the frame's words:
  // src/contracts/stop-words.ts), its model, receipt and time
  const turns = f.chat?.turns ?? [];
  const live = f.activity.chatTurn ?? null;
  out.push('');
  out.push(`Chat turns (${turns.length} sealed${live ? ', 1 being answered' : ''}; every surface's, read from their receipts)`);
  if (live) out.push(`  ▶ running  ${live.words}${live.since ? ` · since ${live.since}` : ''}`);
  if (!turns.length && !live) out.push('  none sealed yet: a turn is listed once its receipt is sealed, whichever surface sent it');
  for (const t of turns) out.push(`  ${TURN_MARK[t.state] ?? '?'} ${t.at}  ${t.words}${t.operation ? `  (op ${t.operation})` : ''}`);
  out.push('');
  out.push('Actions by tab');
  for (const t of f.tabs) {
    const acts = f.actions[t.id] ?? [];
    out.push(`  ${t.key} ${t.label}${t.unfinished ? ' ◌ unfinished' : ''}`);
    // what works on an unfinished tab now and what does not yet, in the words every surface draws (src/contracts/workspace.ts)
    if (t.unfinished) out.push(`    works now: ${t.unfinished.works}`, `    not yet: ${t.unfinished.missing}`);
    for (const a of acts) {
      const mark = a.primary ? '▸' : ' ';
      out.push(`    ${mark} ${a.n} ${a.label}: ${a.command}${a.enabled ? '' : `  (not now: ${a.why ?? 'unavailable'})`}  [${a.effect}]`);
    }
  }
  if (f.log.length) {
    out.push('');
    out.push('Newest activity');
    for (const e of f.log.slice(0, 8)) out.push(`  ${e.at}  ${e.words}${e.operation ? `  (op ${e.operation})` : ''}`);
  }
  if (f.unknown.length) {
    out.push('');
    out.push('Not known');
    for (const u of f.unknown) out.push(`  ${u.field}: ${u.why}`);
  }
  out.push('');
  out.push(`Revision ${f.revision} · made ${f.at}`);
  return out;
}

export async function workspaceMain(argv: string[], o: { json?: boolean; check?: CheckDeps } = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(workspaceHelp()); return 0; }
  const json = o.json === true || argv.includes('--json');
  const rest = argv.filter((a) => a !== '--json');
  const verb = rest[0];
  if (rest.length > 1 || (verb !== undefined && verb !== 'check')) {
    process.stderr.write(`Error: timmy workspace takes ${verb && verb !== 'check' ? `no ${JSON.stringify(verb)}` : 'one verb at most'}.\nUsage: ${WORKSPACE_USAGE}\n`);
    return 2;
  }
  let cwd = process.cwd();
  try { cwd = realpathSync(cwd); } catch { /* as given */ }
  if (verb === 'check') {
    const { path } = await checkConnections({ cwd, ...(o.check ?? {}) });
    if (!json) process.stdout.write(`Checked: recorded in ${path.replace(timmyHome(), '<Timmy home>')}\n\n`);
  }
  const frame = await buildWorkspaceFrame({ cwd, jobsDir: join(timmyHome(), 'jobs'), onPath: (cmd) => realOnPath(cmd, process.env) });
  process.stdout.write(json ? `${JSON.stringify(frame)}\n` : `${workspaceLines(frame).join('\n')}\n`);
  return 0;
}
