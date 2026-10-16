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

Status as of `r5/review-build` @ cfe652d (the frame and the palette are in; the layouts are being built by their
owners). Updated at each integration.

| Ref | What it shows | Tab | Terminal route | Browser route | Source | Status | Capture | Discrepancy |
|---|---|---|---|---|---|---|---|---|
| 01 | Opening hub (modern): tabs, the next-step strip, connection cards, a live preview, the session log | 1 Home | `timmy workbench`, key 1; `timmy workspace` | companion `/`, Home | src/workbench/*, src/companion/client/*, src/ops/workspace-frame.ts | not yet | | Frame and palette in; card and preview layout in progress (H131 terminal, H132 browser). |
| 02 | Main chat (modern): the chat stream with model chips beside the event log | 2 Chat | Workbench key 2; `timmy` (the REPL) | companion Chat | src/workbench/*, src/repl/main.ts, src/companion/chat-route.ts | not yet | | The one shared conversation exists; the two-column chat and log layout is in progress. |
| 03 | OpenHands and Playwright sandbox | 3 Workflows | Workbench key 3; `/run <doc> <block>`, `/op <id>` | companion `/run/:op` | src/repl/workflow-blocks.ts, src/ops/run-detail.ts, scripts/openhands-sdk-bridge.py | not yet | | The stage row (Intent to Analyze) is not drawn yet; a browser sandbox preview is not available in a terminal (see the limits below). |
| 04 | Rerun 0.37.1 VoxVision inspector | 5 VoxVision | Workbench key 5; `/observe`, `/measure`, `/vox` | companion VoxVision panel | src/vox/*, src/forge/observe/rerun.ts | not yet | | Rerun is a separate viewer; Timmy shows its records and opens the viewer where installed. |
| 05 | VoxVision with Roboflow | 5 VoxVision | Workbench key 5; `/tools` | companion VoxVision panel | src/vision/platform.ts | not yet | | Each tool's observed availability must be shown; a catalog entry is not an installation. |
| 06 | Rive, Theatre, Hyperframes and Rerun studio | 4 Studio, 6 3D & Motion | Workbench keys 4 and 6; `/studio`, `/blender`, `/ae` | Studio (`timmy studio`) | companion/studio-canvas/*, src/studio/*, lanes/engines/engines.json | not yet | | Studio's theme, drafts and templates are in progress (H133); engines without an adapter stay marked unavailable. |
| 07 | tmux panes with live previews | 7 Control Room | Workbench key 7; `timmy cockpit` | companion Control Room | src/workbench/*, src/agent/lanes.ts | not yet | | |
| 08 | Wireforge MCP inspector | 9 Tools & MCP | Workbench key 9; `/mcp call --route sdk` and `--route mcporter` | companion Tools | lanes/schema/lane.mjs, src/repl/commands.ts | not yet | | Both MCP-to-CLI routes exist; the inspector layout does not. |
| 09 | Cloudflare and Clef preview | 8 Fleet & Clef | Workbench key 8; `timmy fleet …`, `timmy decide …` | companion Fleet | src/fleet/*, src/decision/*, lanes/cf/pane.mjs | not yet | | Clef is off by default and uncalibrated; Cloudflare is optional and is not the chat provider. |
| 10 | Durable logs and the Rerun verifier | 0 Logs & Receipts | Workbench key 0; `/receipts`, `timmy events --follow --human` | companion Logs | src/utils/receipts.ts, src/ops/run-detail.ts | not yet | | |
| 11 | Main chat (classic) | 2 Chat | as 02 | as 02 | as 02 | not yet | | The intent, predict, sandbox and receipt row above the chat is in progress. |
| 12 | OpenHands SDK: intent, predict, receipt (classic) | 3 Workflows | as 03; `timmy act` seals | as 03 | as 03 | not yet | | The prediction stays sealed before a run and is never shown as an observed receipt. |
| 13 | Opening hub with the session log (classic) | 1 Home | as 01 | as 01 | as 01 | not yet | | |
| 14 | tmux multi-agent harness control room (classic) | 7 Control Room | as 07 | as 07 | as 07 | not yet | | |
| 15 | VoxVision: 3D, SAM 3, Depth Anything 3 (classic) | 5 VoxVision | as 04 | as 04 | as 04 | not yet | | Generated depth and masks stay model claims until checked (AGENTS.md §4). |
| 16 | VoxVision with Roboflow options (classic) | 5 VoxVision | as 05 | as 05 | as 05 | not yet | | |
| 17 | Wireforge: mcporter, clyanything, apisnip (classic) | 9 Tools & MCP | as 08 | as 08 | as 08 | not yet | | Tools without an installed adapter are named with what they need. |
| 18 | Cloudflare, Clef and services (classic) | 8 Fleet & Clef | as 09 | as 09 | as 09 | not yet | | |

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
