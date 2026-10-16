/**
 * R6 (owner H145): the Studio panel's routes (tab 4; reference 06), under /api/panel/studio/…: the shown project's board
 * artifacts (its reference images, its custom nodes, the project's results, renders, VoxVision records, workflow outputs and
 * receipts placed on its board), each with where it came from and the preview it opens.
 * Placeholder from the lead's extension point: the owner fills it (src/companion/panels.ts says how a panel is mounted).
 */
import type express from 'express';
import type { PanelContext } from '../panels.js';

export function mountStudioPanel(_app: express.Express, _ctx: PanelContext): void {
  // no routes yet
}
