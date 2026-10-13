/**
 * R4 (H110): `timmy workbench` at a terminal. The Workbench takes the terminal's alternate screen and gives it back as it was
 * on every way out (Ctrl+C, SIGTERM, SIGHUP, an error: src/term/session.ts), mouse reporting included. It opens the project
 * the shared record names (else this folder), moves into its folder as the REPL does, and makes one Workspace, the REPL's own
 * (src/repl/workspace.ts), for what it does: /project, /run (its NEEDS YOU box drawn in the Workbench), /stop and the
 * overview. It recovers nothing at start (the REPL does).
 */
import React from 'react';
import { join } from 'node:path';
import { render } from 'ink';
import { projectId, readActiveProject } from '../project/index.js';
import { realOnPath } from '../repl/center.js';
import type { ApprovalRequest, Decision } from '../repl/approvals.js';
import { Workspace } from '../repl/workspace.js';
import { timmyHome } from '../setup/home.js';
import { currentCapabilities } from '../term/capabilities.js';
import { glyphSet } from '../term/glyphs.js';
import { screenStream } from '../term/screen-stream.js';
import { TerminalSession } from '../term/session.js';
import { MOUSE_OFF, MOUSE_ON } from '../tui/mouse.js';
import { tildePath } from '../utils/home-scrub.js';
import { appendReceipt, receiptsDir } from '../utils/receipts.js';
import { WorkbenchApp } from './app.js';
import { Controller } from './controller.js';
import { glyphsFor } from './frame.js';
import { CompanionControl, StudioControl, systemOpener } from './servers.js';

export async function runWorkbench(): Promise<number> {
  const env = process.env;
  const caps = currentCapabilities();
  const glyphs = glyphsFor(caps.unicode);
  const colour = caps.color > 0;
  const onPath = (cmd: string): string | null => realOnPath(cmd, env);
  const jobsDir = join(timmyHome(env), 'jobs');

  const session = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  session.enterAltScreen();
  session.hideCursor();
  process.stdout.write('\x1b[2J\x1b[H');

  // the project the shared record names, else this folder; the Workbench works in its folder, as the REPL does
  const start = readActiveProject(process.cwd());
  try { process.chdir(start.root); } catch { /* the folder is gone: the views say so */ }
  let say: (text: string) => void = () => undefined;
  // the Workbench's own NEEDS YOU box, once the app is up; until then (and after it ends) deny, the default
  let ask: (req: ApprovalRequest) => Promise<Decision> = async () => 'deny';
  const ws = new Workspace({
    glyphs: glyphSet(caps.unicode), env, onPath,
    notify: (line) => say(line.map((s) => s.text).join('').trim()),
    openWeb: (url, o) => (o?.secret ? 'a page that carries a key (the Workbench opens none from here)' : `${url} (not opened by the Workbench)`),
    link: (text) => text,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15),
    jobsDir, recoverAtStart: false, tildify: (p) => tildePath(p, env),
    askPerson: (req) => ask(req),
  }, start);

  const opener = systemOpener(env, onPath);
  const companion = new CompanionControl({ opener, env });
  const studio = new StudioControl({
    env, opener, project: () => ws.project, projectId: (root) => projectId(root), jobsDir, receipts: () => receiptsDir(),
    act: (envelope) => ws.canvasAct(envelope),
  });

  const mouseWanted = env.TIMMY_MOUSE !== '0';
  const setMouse = (on: boolean): void => { process.stdout.write(on ? MOUSE_ON : MOUSE_OFF); };
  session.beforeRestore(() => setMouse(false));

  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => { finish = resolve; });
  let after: string[] = [];
  const controller = new Controller({
    env, jobsDir, onPath, glyphs, workspace: ws, companion, studio, setMouse, interactive: true,
    capabilities: async () => {
      const { capabilities } = await import('../capabilities/index.js');
      const { liveDeps } = await import('../capabilities/live.js');
      // no model key is given, so OpenRouter is never asked; the other checks are this computer's own
      return capabilities(liveDeps({ env, model: 'the configured model', projectRoot: ws.root }));
    },
    onExit: (code, words) => { after = words; finish(code); },
  });
  say = (text) => { if (text) controller.say(text); };
  ask = (req) => controller.askPerson(req);
  if (mouseWanted) { controller.ui.mouse = true; setMouse(true); }

  // a narrower terminal reflows the old frame: start the new one on a clear screen (as the monitor does)
  const clear = (): void => { process.stdout.write('\x1b[2J\x1b[H'); };
  process.stdout.prependListener('resize', clear);
  session.beforeRestore(() => { process.stdout.off('resize', clear); });

  const app = render(React.createElement(WorkbenchApp, { controller, colour }), { exitOnCtrlC: false, patchConsole: false, stdout: screenStream(process.stdout) });
  session.beforeRestore(() => app.unmount());
  // SIGTERM or SIGHUP: what this Workbench started stops with it (its records say so), then the terminal comes back
  session.install(process, { drain: async () => { controller.dispose(); await ws.close({ by: 'as the Workbench ended (a signal)' }); } });
  controller.start();

  const code = await done;
  session.restore();
  for (const line of after) process.stdout.write(`${line}\n`);
  return code;
}
