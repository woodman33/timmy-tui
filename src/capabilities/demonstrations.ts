/**
 * Round R4 (H76, the owner's addition of 13:07 PT): what was demonstrated on the operator's Mac, per /tools row. A
 * demonstration is a recorded, scripted real run of Timmy on the operator's Mac, entered in the ledger
 * (docs/ui-cockpit/CHECKPOINTS.md). It is a fact about the project, kept apart from the ladder:
 *
 * - it is not "exercised": exercised is this machine's own sealed run on a chain that verifies. A demonstration elsewhere
 *   never raises a rung here, and a run here never makes a tool demonstrated;
 * - it is not "qualified": qualified needs a formal qualification record only.
 *
 * Each entry rests on its ledger row alone: `cites` are words that stand verbatim in that row (tests/capabilities-ladder
 * checks them against the ledger). PASS or FAIL is as the row says; a failed demonstration stays listed as failed. The
 * lead updates this table at each checkpoint. Filled from rows 158 (r19), 159 (r19o), 162 (r20) and 163 (r21).
 */

export interface Demonstration {
  /** the /tools row it is about */
  tool: string;
  /** the Mac run as the ledger names it */
  run: string;
  /** its ledger row in docs/ui-cockpit/CHECKPOINTS.md */
  row: number;
  /** the day of the run (PT) */
  date: string;
  /** the revision the run was built from, as the row says */
  revision: string;
  how: 'scripted';
  /** the row's own part, when it names one */
  part?: string;
  /** the outcome in a few words */
  outcome: string;
  result: 'PASS' | 'FAIL';
  /** words that stand verbatim in the row */
  cites: readonly string[];
}

/** Where the rows are. */
export const LEDGER = 'docs/ui-cockpit/CHECKPOINTS.md';

const r19 = { run: 'r19', row: 158, date: '2026-10-10', revision: 'c8a0cf7', how: 'scripted' } as const;
const r19o = { run: 'r19o', row: 159, date: '2026-10-10', revision: 'c8a0cf7', how: 'scripted' } as const;
const r20 = { run: 'r20', row: 162, date: '2026-10-10', revision: '10e9b9b', how: 'scripted' } as const;
const r21 = { run: 'r21', row: 163, date: '2026-10-10', revision: 'aae9e82', how: 'scripted' } as const;

export const DEMONSTRATIONS: readonly Demonstration[] = [
  // ── r19, row 158: the owner's first connected product demonstration (the installed package built from c8a0cf7)
  { ...r19, tool: 'workflows', part: 'A3', result: 'PASS', outcome: 'upmd 0.2.7 ran the tray workflow up to its lesson block: 4 of 4 steps, prediction met',
    cites: ['upmd 0.2.7', 'the run ended "4 of 4 steps · prediction met", receipt `4629a2b4`'] },
  { ...r19, tool: 'qwen-code', part: 'A3', result: 'PASS', outcome: 'Qwen Code 0.22.2 on a local model set the tray width to 160 mm in the flow\'s agent step',
    cites: ['Qwen Code 0.22.2 with the local qwen3.8:27b-mlx', 'and set the width to 160'] },
  { ...r19, tool: 'recipe-tray', part: 'A4', result: 'PASS', outcome: 'CadQuery 2.8.0 built the tray\'s STEP: 160 × 80 × 30 mm, 6 of 6 checks',
    cites: ['CadQuery 2.8.0 with OCP 7.9.3.1', '160 × 80 × 30 mm, 79,616.097 mm³; 6 of 6 checks'] },
  { ...r19, tool: 'vox:step', part: 'A4', result: 'PASS', outcome: 'OCP read that STEP back as 160 × 80 × 30 mm (VoxVision record vd2b1368d)',
    cites: ['VoxVision `vd2b1368d` (OCP\'s reading, 160 × 80 × 30 mm, receipt `d16bc6f3`)'] },
  { ...r19, tool: 'vox:look', part: 'B', result: 'PASS', outcome: '/inspect, /detect and /compare on OpenCV 5.0.0; an independent OpenCV and NumPy read agreed',
    cites: ['OpenCV 5.0.0 in a sandbox venv', 'an independent OpenCV and NumPy read agrees on every value'] },
  { ...r19, tool: 'canvas', part: 'D', result: 'PASS', outcome: '/canvas open named the project (21 cards); a card placed as a note followed a board save',
    cites: ['`/canvas open` named the project to the canvas (21 cards, no absolute path)', 'Refresh placed cards updated the note'] },

  // ── r19o, row 159: the first real runs of /agent openhands --local (the sandbox clone at c8a0cf7)
  { ...r19o, tool: 'openhands', result: 'FAIL', outcome: 'four runs, each ended at the agent\'s first tool call (D1): no completed run',
    cites: ['**Not demonstrated: a completed run.**', 'Every run ended at the agent\'s first tool call'] },

  // ── r20, row 162: batch 7 and the r19 and r19o fixes (the installed package from 10e9b9b)
  { ...r20, tool: 'workflows', part: 'A, B', result: 'PASS', outcome: 'upmd on a pty: live block states, /stop mid-block, recovery after a kill; 4 of 4 blocks, prediction met',
    cites: ['upmd 0.2.7 on a pty', 'the run completed 4 of 4 blocks in 9 min, prediction met (receipt `f10e0b7b`)'] },
  { ...r20, tool: 'qwen-code', part: 'B, G', result: 'PASS', outcome: 'Qwen Code worked the workflow\'s change block; a run left by a killed REPL was stopped by /recover',
    cites: ['the card showed `change` running while Qwen Code worked', 'a REPL killed during a plain `/agent qwen` left its agent\'s group running'] },
  { ...r20, tool: 'recipe-tray', part: 'B', result: 'PASS', outcome: 'the workflow\'s build: 160 × 80 × 30 mm, the readback matching',
    cites: ['operation `oaac50609` succeeded (160 × 80 × 30 mm, the readback matching'] },
  { ...r20, tool: 'vox:step', part: 'D', result: 'PASS', outcome: '/inspect of the STEP: CAD checked against the recipe\'s sealed prediction',
    cites: ['`/inspect` of the STEP said "CAD checked: checked against the recipe\'s prediction sealed before flow f586fabe5\'s build (receipt 14852832)'] },
  { ...r20, tool: 'vox:stl', part: 'D', result: 'PASS', outcome: '/compare of two STLs: "estimated: units not declared", nothing drawn of both',
    cites: ['`/compare` of two STLs read "estimated: units not declared … never as millimetres" and drew nothing of both'] },
  { ...r20, tool: 'vox:rerun', part: 'D', result: 'PASS', outcome: 'an STL record opened in Rerun 0.37.1, the STEP record refused; found: the warning came late, Rerun on all interfaces',
    cites: ['the operator\'s Rerun CLI 0.37.1', 'opened an STL record in Rerun (pid recorded, receipt `58c65d15`)', '`/vox view` printed its window warning after Rerun had started, and Rerun listened on all interfaces'] },
  { ...r20, tool: 'canvas', part: 'C', result: 'PASS', outcome: 'the canvas\'s Open on the board reached a live board tab through the token handoff',
    cites: ['a tab opened from the canvas\'s Open on the board said it was asking the other tabs, and 2.8 s later was live'] },
  { ...r20, tool: 'openhands', part: 'F', result: 'FAIL', outcome: 'not demonstrated: the tool call came back as text, 0 steps, recorded "✓ completed"',
    cites: ['**F, OpenHands: not demonstrated.**', 'the SDK said finished after 0 steps'] },

  // ── r21, row 163: batch 8 (the installed package from aae9e82)
  { ...r21, tool: 'openscad', part: 'R', result: 'PASS', outcome: 'OpenSCAD 2026.09.23 in /iterate scad: 190 × 40 × 30 mm, matching OpenSCAD\'s own summary',
    cites: ['OpenSCAD 2026.09.23', '(flow `fa771e6b6`, 190 × 40 × 30 mm, matching OpenSCAD\'s own summary)'] },
  { ...r21, tool: 'illustrator', part: 'I', result: 'PASS', outcome: '/illustrator author ok in 35 s, Timmy\'s SVG reading agreeing; a macOS prompt was answered by an unknown click',
    cites: ['Adobe Illustrator 2026 (30.8.2)', '`/illustrator author badge.jsx --name badge` ok in 35 s', 'not the helper\'s click'] },
  { ...r21, tool: 'unreal', part: 'U', result: 'FAIL', outcome: 'Unreal 5.8.2: no actor spawned in the commandlet, judged failed; caches written outside the sandbox',
    cites: ['**U, Unreal (H63): failed.**', 'Timmy judged it failed (receipt `ab7f87ca`)'] },
  { ...r21, tool: 'openhands', part: 'O', result: 'PASS', outcome: 'the stop order: /stop and a time limit ended the container first, then its docker client',
    cites: ['**O, OpenHands\' stop order (H62):**', 'ended its container first (docker stop, exit 0)'] },
  { ...r21, tool: 'openhands', part: 'O', result: 'FAIL', outcome: 'a completed run not shown: 0 steps, the tool call as text, recorded "✓ completed" (H69 since)',
    cites: ['r20\'s finding 4 again, fixed since in H69', '(4) OpenHands\' 0-step ✓ again'] },
];

/** A row's demonstrations, newest run first (the ledger's row order), in the table's order within a run. */
export function demonstrationsOf(tool: string, table: readonly Demonstration[] = DEMONSTRATIONS): Demonstration[] {
  return table.filter((d) => d.tool === tool).sort((a, b) => b.row - a.row);
}

/** One short phrase for a row's demonstrations: each run, newest first, with its results ("r21 PASS, FAIL · r20 FAIL"). */
export function demonstratedWords(list: readonly Demonstration[], sep = '·'): string {
  const runs: Array<{ run: string; results: string[] }> = [];
  for (const d of list) {
    const at = runs.find((r) => r.run === d.run);
    if (at) at.results.push(d.result); else runs.push({ run: d.run, results: [d.result] });
  }
  return runs.map((r) => `${r.run} ${r.results.join(', ')}`).join(` ${sep} `);
}
