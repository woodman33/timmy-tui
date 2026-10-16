/**
 * R6 (owner H143): the VoxVision panel's routes (tab 5; references 04, 05, 15 and 16), under /api/panel/voxvision/….
 * Placeholder from the lead's extension point: the owner fills it (src/companion/panels.ts says how a panel is mounted).
 */
import type express from 'express';
import type { PanelContext } from '../panels.js';

export function mountVoxPanel(_app: express.Express, _ctx: PanelContext): void {
  // no routes yet
}
