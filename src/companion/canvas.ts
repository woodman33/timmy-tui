/**
 * What the browser companion shows of Timmy Canvas (fourth order, step 5): the same revision, source
 * revision and jobs as the canvas page and the terminal, each job with the receipt that sealed it.
 * The companion can be opened from a phone on the network, so it reads only those, never the drawing,
 * and it never moves a canvas file it cannot read (it says so instead).
 */
import { STUDIO_PORT } from '../studio/config.js';
import { boardOfFolder } from '../studio/boards.js';
import { CanvasDocuments, canvasDir, type CanvasJob } from '../studio/document.js';

export interface CanvasSummary {
  revision: number | null;
  sourceRevision: string | null;
  savedAt: string | null;
  unreadable?: true;
  /** The newest 12 jobs. */
  jobs: CanvasJob[];
  /** Where Timmy Canvas opens, on the computer that runs Timmy. */
  open: string;
}

/**
 * R6 lead (after H139's per-project boards): the board of the project the page shows (`projectRoot`), as Studio keeps it
 * under <TIMMY_HOME>/canvas/projects/<project id>/; without a project, the home-wide canvas of the layout before R6 (which
 * Studio no longer writes, and copies once into the project it belonged to).
 */
export function canvasSummary(env: Record<string, string | undefined>, projectRoot?: string): CanvasSummary {
  const docs = projectRoot ? boardOfFolder(projectRoot, env) : new CanvasDocuments(canvasDir(env));
  return { ...docs.peek(), jobs: docs.jobs().slice(0, 12), open: `http://127.0.0.1:${env.TIMMY_STUDIO_PORT ?? STUDIO_PORT}/` };
}
