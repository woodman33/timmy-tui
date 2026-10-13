/**
 * Round R4 (H76): the /tools rows that are only proposed: a plan in this repository names the tool and no code here runs
 * it. Each cites the plan's file and section, and the plan's own words (tests/capabilities-ladder checks that the words
 * stand in that section). Never the operator's private register. A row leaves this table when code that runs it lands.
 */
import type { ProposedEvidence } from './ladder.js';

export interface Proposal extends ProposedEvidence {
  /** why no code here runs it, in words */
  noCode: string;
}

const F6 = { plan: 'docs/ui-cockpit/COMMAND-CENTER-PLAN.md', section: 'The orders, in order: F-6 The vision observatory' } as const;

/** By /tools row id. */
export const PROPOSED: Readonly<Record<string, Proposal>> = {
  // VoxVision's layers (src/vox/layers.ts LATER_LAYERS): named by the plan, with no layer that starts them.
  'vox:viser': { ...F6, says: 'Viser as the 3D view', noCode: 'VoxVision has no Viser layer: nothing here starts Viser for /vox view' },
  'vox:fiftyone': { ...F6, says: 'FiftyOne as the scoreboard', noCode: 'VoxVision has no FiftyOne layer: nothing here starts FiftyOne' },
};
