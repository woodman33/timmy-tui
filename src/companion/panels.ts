/**
 * R6 lead: the browser companion's tab panels, server side.
 *
 * A panel is what a workspace tab shows of its own records on the page: Studio's board artifacts (tab 4,
 * src/companion/panels/studio.ts), VoxVision's observations and recordings (tab 5, src/companion/panels/vox.ts) and Tools & MCP's
 * servers, schemas, calls and results (tab 9, src/companion/panels/tools.ts); R8 (H155): the Control Room's panes (tab 7,
 * src/companion/panels/control.ts, from src/ops/panes.ts, the Workbench's tab 7's own source).
 * Each panel's module mounts its own routes under /api/panel/<tab>/…, each behind the token check, each answering for the
 * project its page shows (?project=<id>, else the one followed). The page side is src/companion/client/panels.js (the
 * registry companion.js draws through) and src/companion/client/panel-<tab>.js (each panel's own drawing).
 *
 * A panel draws what Timmy's records hold and says plainly what is not there; an engine that is not installed stays
 * named as not installed. Nothing here starts an engine on its own.
 */
import type express from 'express';
import type { WorkspaceFrame } from '../contracts/workspace.js';
import type { ActiveProject } from '../project/index.js';
import { mountVoxPanel } from './panels/vox.js';
import type { InventorySource } from './panels/tools.js';
import { mountToolsPanel } from './panels/tools.js';
import { mountStudioPanel } from './panels/studio.js';
import { mountCreatePanel } from './panels/create.js';
import { mountControlPanel } from './panels/control.js';

export interface PanelContext {
  /** The token check every content route of the companion uses (a request without the token is refused, 401). */
  withToken: express.RequestHandler;
  /** The project a request is about: the one its page names (?project=<id>), else the one followed; null when unknown. */
  projectFor: (req: express.Request) => ActiveProject | null;
  /** The words a request for a project this companion does not know is answered with (404). */
  projectUnknown: string;
  /** The environment the panels read with: a test's (its TIMMY_HOME), else this process's. */
  env: Record<string, string | undefined>;
  /** R8 (H155): the workspace frame of a project, as the page's GET /api/workspace makes it (src/companion/workspace.ts: one
   *  made in the last moment answers again); absent: a panel that would say the frame's words says it has none. */
  frame?: (project: ActiveProject) => Promise<WorkspaceFrame>;
  /** R11 Phase 2 (H171): the rows of a project's Tools & integrations inventory, in the capability inventory's shape (a test's
   *  FAKE rows), with one sentence of how they were read; absent: the ladder's own checks (src/capabilities, local programs
   *  asked, no key given) behind the same shape. */
  inventory?: (project: ActiveProject) => Promise<InventorySource>;
}

/** Mounts every panel's routes (server.ts calls it once, after the workspace routes and before the page's own). */
export function mountPanels(app: express.Express, ctx: PanelContext): void {
  mountVoxPanel(app, ctx);
  mountToolsPanel(app, ctx);
  mountStudioPanel(app, ctx);
  // R7 (H153): tab 6, the project's meshes and recordings (src/companion/panels/create.ts)
  mountCreatePanel(app, ctx);
  // R8 (H155): tab 7, the Control Room's panes (src/companion/panels/control.ts)
  mountControlPanel(app, ctx);
}
