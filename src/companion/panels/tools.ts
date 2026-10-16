/**
 * R6 (owner H142): the Tools & MCP panel's routes (tab 9; references 08 and 17), under /api/panel/tools/….
 * Placeholder from the lead's extension point: the owner fills it (src/companion/panels.ts says how a panel is mounted).
 */
import type express from 'express';
import type { PanelContext } from '../panels.js';

export function mountToolsPanel(_app: express.Express, _ctx: PanelContext): void {
  // no routes yet
}
