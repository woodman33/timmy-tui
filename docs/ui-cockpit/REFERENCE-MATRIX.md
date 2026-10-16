# The 18 reference layouts: where each one lives in Timmy

The operator's completion order of 2026-10-15 asks Timmy to match the 18 reference layouts (numbered 01 to 18) in
layout, density, hierarchy, pane proportions and interaction structure, and to keep one row per reference: the actual
route, the source component, the implementation status, a capture and the remaining discrepancy. This file is that
table. The reference pack itself stays on the operator's computer and is not distributed with this repository.

How to read it:

- **Modern (01 to 10) and classic (11 to 18) describe related states of one product**, not 18 applications. Each
  reference maps onto one of the ten tabs of the shared workspace frame (`src/contracts/workspace.ts`, keys 1 to 9 and
  0), which the terminal Workbench, the browser companion and Timmy Studio all draw.
- **A reference's numbers, model names, images and measurements are example data.** Timmy shows its own records; a
  value no record holds is shown as unknown, never copied from a reference.
- **Status words:** `matched` (layout, hierarchy and interaction follow the reference, with a capture), `partly` (the
  structure is there, with the listed discrepancy), `not yet` (the route exists without the reference's layout), and
  `not available` (Timmy has no implementation; carried forward, never faked).
- **Captures** are from the installed review build unless said otherwise, and name any FAKE fixture they show.

## Palette (DESIGN.md §10 B10)

Every reference uses the same four categories, and so does every surface: canvas and wells `#000000` / `#070707`;
structure and secondary controls `#333333` / `#444444` with text `#F2EFE9` / `#8E8E93`; amber `#FFB000` (with silver
`#E8E4D9`) for focus, the active tab, the one primary next step, `.intent` and `.predict`, and target geometry; green
`#28FE14` / `#00D700` only for an observed live connection, a passed check or a verified sealed receipt. Imported images,
video, reference artwork and measured data keep their own colors.

## The table

Status as of the frozen review candidate `r5/review-build` @ a77d80d, as the independent visual review of its installed
package judged it (2026-10-16): 0 matched, 14 partly, 4 not yet, 0 not available. The captures are those of the review
package's scripted rehearsal (a FAKE model; the names are the package's `captures/` files). Updated at each integration.

| Ref | What it shows | Tab | Terminal route | Browser route | Source | Status | Capture | Discrepancy |
|---|---|---|---|---|---|---|---|---|
| 01 | Opening hub (modern): tabs, the next-step strip, connection cards, a live preview, the session log | 1 Home | `timmy workbench`, key 1; `timmy workspace` | companion `/`, Home | src/workbench/*, src/companion/client/*, src/ops/workspace-frame.ts | partly | `together-160x45-01-workbench-tray`, `switch-160x45-03-home-tray`, `pages-companion-1376x768-tab1` | No rendered preview, only words (companion). No free-only cloud model lock (Workbench, REPL). The companion card stays green after the companion stops (shared frame, companion). "last:" can name an older event (shared frame) |
| 02 | Main chat (modern): the chat stream with model chips beside the event log | 2 Chat | Workbench key 2; `timmy` (the REPL) | companion Chat | src/workbench/*, src/repl/main.ts, src/companion/chat-route.ts | partly | `chat-160x45-07-workbench-long-answered`, `chat-160x45-11-workbench-stopped`, `pages-companion-1376x768-tab2` | No model chips and no preview panes (Workbench, companion). The companion shows receipts, not words, and has no pipeline row (companion). Just after a stop, the companion still says "1 running" and offers Stop (companion). The Workbench says "stopped by you" for a turn the companion stopped (Workbench) |
| 03 | OpenHands and Playwright sandbox | 3 Workflows | Workbench key 3; `/run <doc> <block>`, `/op <id>` | companion `/run/:op` | src/repl/workflow-blocks.ts, src/ops/run-detail.ts, scripts/openhands-sdk-bridge.py | partly | `w2-160x45-04-after-y`, `stop-160x45-02-running`, `pages-companion-run-detail` | No live preview or code view on any surface (companion). The companion's receipt column has no verified mark, and its receipt list is cut at the panel's edge (companion). One frame at a run's start says running and "no job has run" at once (Workbench) |
| 04 | Rerun 0.37.1 VoxVision inspector | 5 VoxVision | Workbench key 5; `/observe`, `/measure`, `/vox` | companion VoxVision panel | src/vox/*, src/forge/observe/rerun.ts | not yet | `w1-160x45-05-tab5-voxvision`, `pages-companion-1376x768-tab5` | No entity tree, viewport, model panes or timeline anywhere. The terminal says so truthfully; the companion has only the actions (companion, VoxVision lane) |
| 05 | VoxVision with Roboflow | 5 VoxVision | Workbench key 5; `/tools` | companion VoxVision panel | src/vision/platform.ts | partly | `w1-160x45-05-tab5-voxvision`, `pages-companion-1376x768-tab5` | No imagery, depth, voxel or embedding panes (companion). No operator verdict or learning queue, not even marked as absent (Workbench) |
| 06 | Rive, Theatre, Hyperframes and Rerun studio | 4 Studio, 6 3D & Motion | Workbench keys 4 and 6; `/studio`, `/blender`, `/ae` | Studio (`timmy studio`) | companion/studio-canvas/*, src/studio/*, lanes/engines/engines.json | partly | `w1-160x45-06-tab6-3d-motion`, `w1-160x45-04-tab4-studio`, `pages-studio-03-draft-waiting`, `pages-studio-04-accepted-saved` | No hero stage, state machine or timeline (Studio). After a project switch, Studio keeps the other project's board and canvas job (Studio). Studio says nothing waits while a draft waits (shared frame, Studio). Tab 6 has no primary (Workbench). The companion's tabs 4 and 6 are only actions (companion) |
| 07 | tmux panes with live previews | 7 Control Room | Workbench key 7; `timmy cockpit` | companion Control Room | src/workbench/*, src/agent/lanes.ts | partly | `stop-160x45-04-click-control-room-tab`, `stop-160x45-05-after-x`, `pages-companion-1376x768-tab7` | The panes follow runs, not harnesses. No carbonyl panes and no tmux status bar (Workbench). Raw rules inside panes (Workbench). The stop words omit the companion's Stop (Workbench). The companion has no pane grid (companion) |
| 08 | Wireforge MCP inspector | 9 Tools & MCP | Workbench key 9; `/mcp call --route sdk` and `--route mcporter` | companion Tools | lanes/schema/lane.mjs, src/repl/commands.ts | not yet | `w1-160x45-09-tab9-tools-mcp`, `pages-companion-1376x768-tab9` | No ingest form, generated CLI, flame graph or verification pane anywhere; the terminal says so (companion, MCP lane). Neither route was called. The companion says "unknown" where the terminal says "installed" (shared frame) |
| 09 | Cloudflare and Clef preview | 8 Fleet & Clef | Workbench key 8; `timmy fleet …`, `timmy decide …` | companion Fleet | src/fleet/*, src/decision/*, lanes/cf/pane.mjs | partly | `w1-160x45-08-tab8-fleet-clef`, `pages-companion-1376x768-tab8` | Two columns, no preview column (stated). No probability bars, even empty (Workbench). No primary (Workbench). The services' remedies are cut at 160x45 and dropped at 120x40 (Workbench). The companion has no decisions section (companion) |
| 10 | Durable logs and the Rerun verifier | 0 Logs & Receipts | Workbench key 0; `/receipts`, `timmy events --follow --human` | companion Logs | src/utils/receipts.ts, src/ops/run-detail.ts | partly | `w2-160x45-06-logs-receipts`, `pages-companion-1376x768-tab0`, `words-receipts.txt` | No "verify the chain" primary (Workbench). No durable-spine table and no replay (Workbench, companion). The companion shows no chain check (companion) |
| 11 | Main chat (classic) | 2 Chat | as 02 | as 02 | as 02 | partly | `chat-160x45-21-workbench-stopped-from-companion`, `chat-160x45-29-workbench-after-repl-stop`, `chat-27-companion-after` | As 02. The REPL and the receipts say "cancelled" where the other surfaces say "stopped" (shared frame, REPL). The REPL does not mark a partial answer (REPL) |
| 12 | OpenHands SDK: intent, predict, receipt (classic) | 3 Workflows | as 03; `timmy act` seals | as 03 | as 03 | partly | `w2-160x45-04-after-y`, `pages-companion-run-detail` | No agent canvas, cross-section or code view (companion). The companion's receipt column has no verified mark (companion) |
| 13 | Opening hub with the session log (classic) | 1 Home | as 01 | as 01 | as 01 | partly | `switch-160x45-03-home-tray`, `together-160x45-01-workbench-tray`, `pages-companion-1376x768-tab1` | Four actions and no free-only lock, where the reference has five and a lock (Workbench, REPL). The Workbench log shows 4 lines until `a` (Workbench) |
| 14 | tmux multi-agent harness control room (classic) | 7 Control Room | as 07 | as 07 | as 07 | partly | `stop-160x45-04-click-control-room-tab`, `chat-160x45-09-control-room-all-turns` | No add or remove of harnesses and panes, and no broadcast; the screen says "not in Timmy yet" (Workbench). The panes follow runs (Workbench) |
| 15 | VoxVision: 3D, SAM 3, Depth Anything 3 (classic) | 5 VoxVision | as 04 | as 04 | as 04 | not yet | `w1-160x45-05-tab5-voxvision`, `pages-companion-1376x768-tab5` | No viewport, SAM 3, Depth Anything 3, pin tray or timeline anywhere; the terminal says so (companion, VoxVision lane) |
| 16 | VoxVision with Roboflow options (classic) | 5 VoxVision | as 05 | as 05 | as 05 | partly | `w1-160x45-05-tab5-voxvision`, `w1-100x30-29-tab5-voxvision` | No operator verdict, learning queue, sealed-receipt card or imagery (Workbench, companion) |
| 17 | Wireforge: mcporter, clyanything, apisnip (classic) | 9 Tools & MCP | as 08 | as 08 | as 08 | not yet | `w1-160x45-09-tab9-tools-mcp`, `w1-120x40-23-tab9-tools-mcp` | No ingest modes and no generated CLI anywhere (MCP lane, companion) |
| 18 | Cloudflare, Clef and services (classic) | 8 Fleet & Clef | as 09 | as 09 | as 09 | partly | `w1-160x45-08-tab8-fleet-clef`, `w1-120x40-22-tab8-fleet-clef` | No probability distribution (no decision is recorded). No service cards (Cloudflare is not set up). Service remedies cut (Workbench) |

## What a terminal can and cannot show

A terminal draws text cells. It cannot render a browser page, a WebGL or Rerun viewport, a tldraw canvas or a video, so
the terminal never pretends to: where a reference shows a live 3D or canvas preview, the Workbench draws a terminal
representation (what is on the canvas or in the scene, its files, its last run and its state) and offers Companion ·
Show (`c`) or Studio · Show (`s`) to see it rendered. Timmy has Kitty, iTerm2 and Sixel image pipelines with an ANSI
fallback (src/graphics, chosen by what the terminal answers it supports), used by the older full-screen app
(src/tui); the Workbench does not draw images yet, so it shows the text representation. Box-drawing lines, the amber focus and
the green live, passed and sealed states all use the 16 terminal colors the Timmy themes set (slot 3 amber, slot 2
green, slot 7 silver, slot 8 secondary text), so a terminal with another palette still shows each state's word and
glyph.
