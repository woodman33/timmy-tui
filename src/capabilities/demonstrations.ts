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
 * lead updates this table at each checkpoint. Filled from rows 158 (r19), 159 (r19o), 162 (r20) and 163 (r21); since R4
 * H111, also 166 (u23), 168 (r22), 171 (r23), 173 (r23c), 176 (r24) and 180 (r25). A part the row calls partial is
 * entered by what of it passed or failed, each with the row's own words; what a row says was only found (a program on
 * PATH, a lane "found (not checked)") is no demonstration and is not entered.
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
const u23 = { run: 'u23', row: 166, date: '2026-10-10', revision: '796485a', how: 'scripted' } as const;
const r22 = { run: 'r22', row: 168, date: '2026-10-10', revision: '28d1aa4', how: 'scripted' } as const;
const r23 = { run: 'r23', row: 171, date: '2026-10-11', revision: 'b234164', how: 'scripted' } as const;
const r23c = { run: 'r23c', row: 173, date: '2026-10-11', revision: 'a99f409', how: 'scripted' } as const;
const r24 = { run: 'r24', row: 176, date: '2026-10-11', revision: 'a300851', how: 'scripted' } as const;
const r25 = { run: 'r25', row: 180, date: '2026-10-11', revision: '5e5cbb3', how: 'scripted' } as const;

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

  // ── u23, row 166: Unreal through Timmy's own /unreal (the installed package from 796485a)
  { ...u23, tool: 'unreal', part: '1, 3, 4', result: 'PASS', outcome: 'Unreal 5.8.2 through /unreal: the starter built, a second Unreal agreed on 9 of 9 actors; timmy act exit 0',
    cites: ['Unreal Engine 5.8.2', 'the automatic readback agreed, 9 of 9 actors', 'exit 0 in 57 s, outcome succeeded'] },

  // ── r22, row 168: batch 9 and the lead's r21 fixes (the installed package from 28d1aa4)
  { ...r22, tool: 'workflows', part: 'W', result: 'PASS', outcome: 'a /run whose REPL ended was stopped by its own wrapper and recorded by /recover; the rerun reached 3 of 3',
    cites: ['a `/run` whose REPL ended was stopped by its own wrapper', 'the rerun reached 3 of 3 (receipt `903db7c8`)'] },
  { ...r22, tool: 'openhands', part: 'O1, O2', result: 'PASS', outcome: 'the first completed run: native tool calls, 10 steps, NOTES.md written; a stop ended its container first',
    cites: ['O1: PASS, the first real OpenHands success', 'NOTES.md written (718 bytes, 8 lines) naming all 6 files; receipt `d6e2a7cc`', 'O2: PASS: the container stopped first'] },
  { ...r22, tool: 'vox:rerun', part: 'V', result: 'PASS', outcome: '/vox view warned at 0.44 s, Rerun bound to 127.0.0.1, a STEP shown as its tessellation',
    cites: ['V: PASS: `/vox view` warned at 0.44 s, Rerun bound to 127.0.0.1:9876, the STEP file tessellated; receipt `0564a96f`'] },
  { ...r22, tool: 'illustrator', part: 'I', result: 'PASS', outcome: 'author, edit and inspect passed; timmy act stopped at a macOS prompt left unanswered (the row: partial)',
    cites: ['`/illustrator` author, edit and inspect passed (receipts `9e413308`, `9ed143ec`, `9846cc5e`)'] },

  // ── r23, row 171: the installed package from b234164 (r23a and r23b)
  { ...r23, tool: 'workflows', part: 'r23a U', result: 'PASS', outcome: 'real upmd 0.2.7 ran the bytes NEEDS YOU checked; a document naming two blocks alike refused on every path',
    cites: ['U, real upmd 0.2.7', 'upmd ran the checked bytes', 'refused by the REPL, the board\'s Run (real clicks), `timmy md` (exit 2) and `timmy act` (exit 2)'] },
  { ...r23, tool: 'unreal', part: 'r23a R', result: 'PASS', outcome: 'five runs through /unreal: one to its end, its readback agreeing 9 of 9; two stops, each said as it happened',
    cites: ['R, Unreal through `/unreal` (5 runs', 'the readback agreeing 9 of 9'] },
  { ...r23, tool: 'canvas', part: 'r23b C', result: 'PASS', outcome: 'its cards and credentials: Run up to here to completed, a save with its receipt; reused grants and another project refused',
    cites: ['C, Timmy Canvas\'s cards and credentials: PASS', 'Run up to here through to completed (receipt `4f0243b2`)'] },
  { ...r23, tool: 'openscad', part: 'r23b T', result: 'PASS', outcome: '/tools openscad: installed, then exercised after one judged-ok /scad',
    cites: ['`/tools openscad` installed, then exercised after one judged-ok `/scad`, receipt `be70f65e`'] },

  // ── r23c, row 173: the installed package from a99f409
  { ...r23c, tool: 'monitor', part: 'M', result: 'PASS', outcome: 'the monitor started no lane program, lane socket or model request; its FIRST RUN screen answered its keys',
    cites: ['the monitor started no lane program, no lane socket and no model request', 'a canary `ortui-keep` session survived'] },
  { ...r23c, tool: 'workflows', part: 'H', result: 'PASS', outcome: 'a second SIGINT: timmy md and timmy act each exited 3 with one JSON object; /recover sealed each cut block once',
    cites: ['`timmy md` and `timmy act` exited 3 within 64 ms with one JSON object each', '`/recover` sealed each cut block once'] },

  // ── r24, row 176: the first preview (the installed package from a300851)
  { ...r24, tool: 'workflows', part: 'U4b', result: 'PASS', outcome: '/run WORKFLOW.md result: 3 of 3 blocks in 220 s, prediction met',
    cites: ['`/run WORKFLOW.md result`: 3 of 3 blocks, 220 s, prediction met, operation `o9170961c`'] },
  { ...r24, tool: 'workflows', part: 'U4c', result: 'FAIL', outcome: 'the board\'s Run up to here on a request already satisfied read FAILED (D3; "no change" since, row 178)',
    cites: ['U4c, FAIL', 'read as FAILED after 67 s'] },
  { ...r24, tool: 'workflows', part: 'U4d', result: 'PASS', outcome: 'NEEDS YOU: y ran a risky block once; timmy md (answered n) and timmy act refused it, exit 2',
    cites: ['the REPL\'s NEEDS YOU box, y allowed it once (the job completed)', '`timmy act` refused it, exit 2'] },
  { ...r24, tool: 'qwen-code', part: 'U4b', result: 'PASS', outcome: 'Qwen Code 0.22.2 on a local model set the tray\'s width to 150 mm in the workflow\'s change block',
    cites: ['Qwen Code 0.22.2 on the local qwen3.8:27b-mlx made the width 140 → 150'] },
  { ...r24, tool: 'recipe-tray', part: 'U4b', result: 'PASS', outcome: 'the workflow\'s CadQuery rebuild in 14 s and its STEP readback in 1.5 s, prediction met',
    cites: ['the CadQuery rebuild took 14 s and the STEP readback 1.5 s'] },
  { ...r24, tool: 'canvas', part: 'U6', result: 'PASS', outcome: '/canvas open, Place card on three cards, Open on the board through the token handoff (found: D6)',
    cites: ['`/canvas open` (the page\'s 71 requests, all to 127.0.0.1)', 'Open on the board through the token handoff'] },
  { ...r24, tool: 'monitor', part: 'U7', result: 'PASS', outcome: 'timmy watch: exit 78 on a blank home, then FIRST RUN and HOME (found: its companion\'s port ignored, D1; a paid model named with no key, D7)',
    cites: ['`timmy watch` on a blank home exited 78', 'the monitor\'s FIRST RUN, HOME, q (the pairing card) and Ctrl+C (130)'] },

  // ── r25, row 180: the second preview (the installed package from 5e5cbb3)
  { ...r25, tool: 'workflows', part: 'U5, U6', result: 'PASS', outcome: '/run WORKFLOW.md result: 3 of 3 blocks in 5 min 16 s, prediction met; a satisfied rerun said no change (found: D2)',
    cites: ['3 of 3 blocks, 5 min 16 s, prediction met, operation `o0a9ed5a0`', 'no change in 51 s'] },
  { ...r25, tool: 'workflows', part: 'U7', result: 'FAIL', outcome: 'a stale build: no change in the end line and /jobs, failed in the block line and receipts (D3; one rule since, row 182)',
    cites: ['U7, partial', 'its block line and receipts say failed (D3)'] },
  { ...r25, tool: 'workflows', part: 'U8', result: 'PASS', outcome: 'NEEDS YOU: nothing ran while it waited, y ran the block once; the board\'s Run disabled with the reason',
    cites: ['y allowed it once (the job completed, 3 receipts)', 'the board\'s Run on it disabled with the reason'] },
  { ...r25, tool: 'recipe-tray', part: 'U7', result: 'PASS', outcome: '/recipe tray: 30 of 30 geometry checks, 160 × 80 × 30 mm',
    cites: ['`/recipe tray`: 30 of 30 geometry checks passed, bounds 160 × 80 × 30 mm'] },
  { ...r25, tool: 'canvas', part: 'U4, U9', result: 'PASS', outcome: '/studio; Place this operation placed 3 cards and 2 arrows in run order (found: D9)',
    cites: ['`/studio` opened Studio\'s page with its grant (71 requests, all to 127.0.0.1)', 'Place this operation placed 3 cards and 2 arrows in run order'] },
  { ...r25, tool: 'monitor', part: 'U2', result: 'PASS', outcome: 'timmy watch --companion-port: HOME in 1.2 s, the next port when that one was taken, exit 78 with no terminal (found: D7, D10, D12)',
    cites: ['`timmy watch --companion-port 4422`: HOME in 1.2 s', 'the companion took 4423 when 4422 was taken'] },
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
