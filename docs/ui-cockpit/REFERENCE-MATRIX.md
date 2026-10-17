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
- **Done and still differs are kept apart.** The table's last column is what still differs. What R6 completed is in
  "Completed in R6" below, each item with the capture that shows it; work that only tests show is listed apart from it.
- **Captures** are named `<owner>/<file>`: the R6 owners' and the lead's captures of this candidate (the lead's over the
  review demo's records; the owners' over their own test projects, where a FAKE model or server says FAKE on screen), and
  `r5/<file>` for the R5 review package's captures where R6 changed nothing. They are not in this repository; the R6 review package's
  rehearsal captures replace them.

## Palette (DESIGN.md §10 B10)

Every reference uses the same four categories, and so does every surface: canvas and wells `#000000` / `#070707`;
structure and secondary controls `#333333` / `#444444` with text `#F2EFE9` / `#8E8E93`; amber `#FFB000` (with silver
`#E8E4D9`) for focus, the active tab, the one primary next step, `.intent` and `.predict`, and target geometry; green
`#28FE14` / `#00D700` only for an observed live connection, a passed check or a verified sealed receipt. Imported images,
video, reference artwork and measured data keep their own colors.

## The table

Status of the frozen R6 candidate `4a2e4b2` (2026-10-16), as the two R6 independent reviews of its package judged it.
The visual review: 0 matched, 18 partly, 0 not yet. The interaction review: 17 partly, and 15 not met (it counts 15's
layout, with no 3D, SAM 3, Depth Anything 3, FiftyOne or timeline, as not met; the visual review counts it as partly).
The Status column follows the visual review. At R5 (`a77d80d`), the independent visual review judged 0 matched, 14
partly and 4 not yet (04, 08, 15 and 17); those four moved to partly because the companion now draws what their
references centre on.

| Ref | What it shows | Tab | Terminal route | Browser route | Source | Status | Capture | Still differs |
|---|---|---|---|---|---|---|---|---|
| 01 | Opening hub (modern): tabs, the next-step strip, connection cards, a live preview, the session log | 1 Home | `timmy workbench`, key 1; `timmy workspace` | companion `/`, Home | src/workbench/*, src/companion/client/companion.js, src/ops/workspace-frame.ts | partly | `lead/lead-01-home`, `h140/companion-ollama-fake-after-stop-home`, `h140/companion-live-after-kill` | The Workbench's Home preview is words; it names where the companion draws the images (Workbench). No free-only cloud model lock (outside R6). "last:" can name an older event than the log under it (shared frame; not changed in R6) |
| 02 | Main chat (modern): the chat stream with model chips beside the event log | 2 Chat | Workbench key 2; `timmy` (the REPL) | companion Chat | src/workbench/*, src/repl/main.ts, src/companion/chat-route.ts | partly | `r5/chat-160x45-07-workbench-long-answered`, `h140/companion-ollama-fake-after-stop-home`, `h140/receipts-stop-words` | No model chips and no preview panes (outside R6). The companion shows each turn as its receipt, not its words, and has no pipeline row (companion) |
| 03 | OpenHands and Playwright sandbox | 3 Workflows | Workbench key 3; `/run <doc> <block>`, `/op <id>` | companion Workflows and `/run/<op>` | src/ops/run-detail.ts, src/companion/client/panel-run.js, src/workbench/workflows-tab.ts, src/repl/workflow-blocks.ts | partly | `lead/lead-03-run-oc081ee74`, `h144/companion-run-detail-1376x768-source-diff-receipts`, `h144/workbench-tab3-160x45-tmux-source-changes-receipts` | No live browser or sandbox preview: a workflow runs by upmd on this computer, and the run says "sandbox: none recorded" (no container, no Playwright). The code is the source as it ran and its diffs, not an editor. One frame at a run's start says running and "no job has run" at once (Workbench; not re-checked in R6) |
| 04 | Rerun 0.37.1 VoxVision inspector | 5 VoxVision | Workbench key 5; `/observe`, `/measure`, `/vox` | companion tab 5 (`?tab=voxvision&vox=<id>`) | src/vox/*, src/companion/panels/vox.ts, src/companion/client/panel-vox.js, src/workbench/voxvision-tab.ts | partly | `lead/lead-05-voxvision`, `h143/h143-1-panel-image-overlays`, `h143/h143-3-timeline-frame`, `h143/h143-4-mesh-projection` | No 3D viewport you can turn (Rerun's own viewer opens a record where Rerun is installed: `/vox view <id>`). No depth, voxels, SAM or FiftyOne panes: the panel names each as not installed or not used |
| 05 | VoxVision with Roboflow | 5 VoxVision | Workbench key 5; `/tools` | companion tab 5 | src/vision/platform.ts, src/vox/*, src/companion/client/panel-vox.js | partly | `lead/lead-05-voxvision`, `h143/h143-4-mesh-projection` | No depth, voxel or embedding panes. No Roboflow inference here: it needs a key and says "needs setup" |
| 06 | Rive, Theatre, Hyperframes and Rerun studio | 4 Studio, 6 3D & Motion | Workbench keys 4 and 6; `/studio`, `/blender`, `/ae` | Studio (`timmy studio`); companion tabs 4 and 6 | companion/studio-canvas/*, src/studio/* (boards.ts), lanes/engines/engines.json | partly | `h139/h139-02-studio-switching-to-blank-blocked`, `h139/h139-04-studio-back-on-tray-with-its-draft`, `h145/step1/01-tray-vox-artifact-card`, `h145/step2/05-tray-reference-image`, `h145/step3/08-companion-tab4-tray-board`, `h145/step4a/11-tray-nodes-added`, `h145/step4c/15-node-connections`, `lead/lead-04-studio` | No hero stage, state machine or timeline: Rive, Theatre and HyperFrames are not in Timmy (outside R6). The nodes are the project's own cards and their links; there are no new node types and no graph that runs (Studio). Tab 6 has no primary (Workbench). The companion's tab 4 lists the board, not its arrows; its tab 6 is actions (companion) |
| 07 | tmux panes with live previews | 7 Control Room | Workbench key 7; `timmy cockpit` | companion Control Room | src/workbench/control-tab.ts, src/agent/lanes.ts | partly | `r5/stop-160x45-04-click-control-room-tab`, `r5/stop-160x45-05-after-x` | The panes follow runs, not harnesses; no carbonyl panes and no tmux status bar (outside R6). The Control Room's sentence on stopping a turn names only Esc and Ctrl+C, though each turn's own row says where it stops and that `x` here asks it to (Workbench). The companion has no pane grid (outside R6) |
| 08 | Wireforge MCP inspector | 9 Tools & MCP | Workbench key 9; `/mcp tools`, `/mcp call --route sdk` and `--route mcporter` | companion tab 9 (`?tab=tools`) | src/mcp/inspector.ts, src/mcp/wire-tap.ts, src/companion/panels/tools.ts, src/companion/client/panel-tools.js, src/workbench/tools-tab.ts, lanes/schema/lane.mjs | partly | `lead/lead-09-tools`, `h142/h142-03-request-form-and-json-rpc`, `h142/h142-04-call-sdk-result-and-receipt`, `h142/h142-05-call-mcporter-result-and-receipt`, `h146/mcp-routes-installed` | No generated CLI program: Timmy shows the command lines that make a call (the REPL's, MCPorter's, the MCP SDK's). No live preview pane and no bind-and-seal step |
| 09 | Cloudflare and Clef preview | 8 Fleet & Clef | Workbench key 8; `timmy fleet …`, `timmy decide …` | companion Fleet | src/fleet/*, src/decision/*, lanes/cf/pane.mjs | partly | `r5/w1-160x45-08-tab8-fleet-clef`, `r5/pages-companion-1376x768-tab8` | Two columns, no preview column (stated). No probability bars, even empty; no primary (Workbench). The services' remedies are cut at 160x45 and dropped at 120x40 (Workbench). No decisions section on the companion (outside R6) |
| 10 | Durable logs and the Rerun verifier | 0 Logs & Receipts | Workbench key 0; `/receipts`, `timmy events --follow --human` | companion Logs | src/utils/receipts.ts, src/ops/run-detail.ts | partly | `r5/w2-160x45-06-logs-receipts`, `h140/receipts-stop-words` | No "verify the chain" primary (Workbench). The companion's Logs tab checks no chain: a run's, a record's and a call's receipts are verified on their own pages (companion). No durable-spine table and no replay (outside R6) |
| 11 | Main chat (classic) | 2 Chat | as 02 | as 02 | as 02 | partly | `h140/receipts-stop-words`, `h141/repl-stream-160x45-2`, `h141/holds-1-workbench-after-x` | As 02. The REPL follows a stopped answer with its stop line, but does not mark the answer as partial (REPL) |
| 12 | OpenHands SDK: intent, predict, receipt (classic) | 3 Workflows | as 03; `timmy act` seals | as 03 | as 03 | partly | `lead/lead-03-run-oc081ee74`, `h144/companion-run-detail-1376x768-source-diff-receipts` | No agent canvas or CAD cross-section. The code is the source as it ran and its diffs (companion) |
| 13 | Opening hub with the session log (classic) | 1 Home | as 01 | as 01 | as 01 | partly | `lead/lead-01-home`, `r5/together-160x45-01-workbench-tray` | Four actions and no free-only lock, where the reference has five and a lock (outside R6). The Workbench log shows 4 lines until `a` (Workbench) |
| 14 | tmux multi-agent harness control room (classic) | 7 Control Room | as 07 | as 07 | as 07 | partly | `r5/stop-160x45-04-click-control-room-tab`, `r5/chat-160x45-09-control-room-all-turns` | No add or remove of harnesses and panes, and no broadcast; the screen says "not in Timmy yet" (outside R6). The panes follow runs (Workbench) |
| 15 | VoxVision: 3D, SAM 3, Depth Anything 3 (classic) | 5 VoxVision | as 04 | as 04 | as 04 | partly | `h143/h143-4-mesh-projection`, `h143/h143-3-timeline-frame`, `lead/lead-05-voxvision` | No 3D viewport, depth or masks drawn; SAM 3 and Depth Anything 3 are named as not installed. No pin tray (outside R6) |
| 16 | VoxVision with Roboflow options (classic) | 5 VoxVision | as 05 | as 05 | as 05 | partly | `lead/lead-05-voxvision`, `h143/h143-1-panel-image-overlays` | No Roboflow inference here (it needs a key); no depth or grid |
| 17 | Wireforge: mcporter, clyanything, apisnip (classic) | 9 Tools & MCP | as 08 | as 08 | as 08 | partly | `lead/lead-09-tools`, `h142/h142-03-request-form-and-json-rpc` | apisnip and clyanything are named as not in Timmy. No generated CLI program (command lines only) |
| 18 | Cloudflare, Clef and services (classic) | 8 Fleet & Clef | as 09 | as 09 | as 09 | partly | `r5/w1-160x45-08-tab8-fleet-clef`, `r5/w1-120x40-22-tab8-fleet-clef` | No probability distribution (no decision is recorded). No service cards (Cloudflare is not set up). Service remedies cut (Workbench). Not changed in R6 |

## Completed in R6 (each shown by a capture)

| Requirement | Refs | Owner and commits | Capture |
|---|---|---|---|
| Home leads its Preview with the project's newest images (the newest run's first image, the newest VoxVision record's image), each shown at size, with the action that opens it | 01, 13 | lead 819cb63 | `lead/lead-01-home` |
| A connection is live only while a current answer is seen; the companion's card leaves green at once when its server is gone | 01 | H140 37837dd | `h140/companion-live-before-kill`, `h140/companion-live-after-kill` |
| After a stopped turn, no false "waiting on you" and no "Ollama needs setup" while Ollama answers; Ollama's setup follows its HTTP route | 01, 02 | H140 5d04c56, fbdff80 | `h140/companion-ollama-fake-after-stop-home`, `h140/tools-ollama-fake` |
| One set of stop words: a chat turn "stopped" with who asked, a job "cancelled", on every surface and in `timmy receipts` | 02, 07, 11 | H140 9146ccf, 95fdcfb | `h140/receipts-stop-words`, `h140/board-room-job-cancelled` |
| `timmy workspace check` prints the chat turns in words | 02, 11 | H140 9146ccf | `h140/workspace-check-turns`, `h146/check-words` |
| The REPL's answer keeps streaming, wrapped, at any width | 11 | H141 9217622 | `h141/repl-stream-160x45-2`, `h141/repl-stream-80x45-2` |
| The Workbench's `x` and run line see another process's chat turn at once | 02, 11 | H141 0ae387f, ae8b81c | `h141/holds-1-workbench-running`, `h141/holds-1-workbench-after-x` |
| The `?` Keys list scrolls from the keys it lists | all | H141 a688b2f | `h141/keys-160x45-end`, `h141/keys-100x30-end` |
| A run inspected: its source as it ran, its changes with line diffs, its outputs and log, its receipts verified now (the companion's run detail and the Workbench's tab 3) | 03, 12 | H144 c2fea07, 4cee0a5, 40019ed | `h144/companion-run-detail-1376x768-source-diff-receipts`, `h144/companion-run-detail-1376x768-image-output`, `h144/workbench-tab3-160x45-tmux-source-changes-receipts`, `lead/lead-03-run-oc081ee74` |
| VoxVision tab 5: the observed image with what was measured over it (labelled provenance and evidence), the entity tree, a video's frames, a mesh's views, the pipeline, the receipt verified now; the Workbench's tab 5 in words | 04, 05, 15, 16 | H143 dcce794, 334c965, 7f35f77, f29bdac; lead 819cb63 (labels legible at size) | `h143/h143-1-panel-image-overlays`, `h143/h143-2-entity-highlighted`, `h143/h143-3-timeline-frame`, `h143/h143-4-mesh-projection`, `h143/h143-5-workbench-tab5-text`, `lead/lead-05-voxvision` |
| Tools & MCP tab 9: servers, tools and schemas; a request checked against its schema; the JSON-RPC request and the command lines; calls through both MCP-to-CLI routes with their measured wire, record and receipt; NEEDS YOU for any typed command; the Workbench's tab 9 lists the calls | 08, 17 | H142 f7b825e, ba411a0, 195595c, bb0b1d1, 4793ded, e43e754 | `h142/h142-01-tab9-open` … `h142/h142-08-http-server-before-listing`, `h142/h142-09-workbench-tab9-calls`, `lead/lead-09-tools` |
| Both MCP-to-CLI routes list and call the FAKE fixture from the packed install | 08 | H142's code, run by H146 through the review launcher | `h146/mcp-routes-installed` |
| Studio: each project has its own board, drafts and canvas jobs; a switch covers the board and blocks editing, Accept and Discard until the new board is loaded; each project's draft comes back with it | 06 | H139 4584d36, 783ac7a, 072feb6, 56465ae | `h139/h139-01-studio-on-tray-with-its-pending-draft` … `h139/h139-06-studio-blank-reopened-its-board-and-draft` |
| Studio's side panel puts the shown project's artifacts (VoxVision records, runs, receipts) on the board as cards that show them and open their previews, and the project's own images as reference images copied into the board; each shows only on its own project's board | 06 | H145 7a2c40c, cc448b3 (merged in f035d28) | `h145/step1/01-tray-vox-artifact-card` … `h145/step1/04-blank-after-switch`, `h145/step2/05-tray-reference-image` … `h145/step2/07-tray-reference-draft` |
| The review demo puts records in tray for the previews: a VoxVision observation of the example image, a report run writing four files | 03, 04 | lead 0cb7a9e | `h146/demo`, `lead/lead-05-voxvision`, `lead/lead-03-run-oc081ee74` |
| The companion's tab 4 lists what the shown project's board holds, as Studio saved it: artifact cards, reference images, cards and words, each with its page and FAKE or draft mark, each image shown at size, each item opening its record (tab 5), run (Workflows) or receipt; another project's card on the board is named "kept apart" and not read; a reading held across a switch is dropped | 06 | H145 041d605, cd61dc9 (merged in 6dfdb19) | `h145/step3/08-companion-tab4-tray-board`, `h145/step3/09-companion-tab4-blank-board`, `h145/step3/10` (a thumbnail at size) |
| Studio's custom nodes: a Nodes palette of the shown project's own cards (parameter, workflow, result; an operation's cards in run order, linked by bound arrows), each added bound to that project; refused in words while Studio switches; a reading held across a switch places nothing | 06 | H145 b48fe2d (merged in 557d3b1) | `h145/step4a/11-tray-nodes-added`, `h145/step4a/12-blank-own-palette` |
| A parameter node's values saved through the live board's existing save path (the rules, the previous version kept, an edit receipt naming Timmy Canvas, the REPL's own line), and refused in the REPL's words while a flow holds the project, nothing written | 06 | H145 2883d61, 6c84f9f (tests; no product change was needed) | `h145/step4b/13-parameter-node-saved`, `h145/step4b/14-parameter-node-refused-while-a-flow-runs` |
| Node connections: Connect draws an arrow from the first selected node to the second; data flows only along an operation's own links (solid, the operation's record relinked); any other arrow, drawn there or by hand, is labelled "link only · no data flows" on the board and says why in the panel; a person's own words on an arrow are kept; one undo; refused while switching or during a call | 06 | H145 03f0f84 (in 546720b) | `h145/step4c/15-node-connections` |
| The image shown at size opens in the middle of the window | 01, 03 | lead f448f4a | `lead/v4/j02-home-image-at-size` |
| Home's newest image → the image at size → its VoxVision record or its run → the run's source, changes, outputs and receipt, with Review, Restore and Run again offered (a scripted journey, 15 checks) | 01, 03, 04 | lead (the journey over the review demo) | `lead/v4/j01-home-newest-images` … `lead/v4/j05-run-output-at-size` |

## Built in R6, shown by tests but not yet by a capture

- One waiting count for every surface and process, Studio's waiting drafts counted once (H140 06b2b21, d1732ab; the
  lead's integration in 7b69cb7): refs 01, 06, 07.
- A rule a job printed is said as its output, not drawn as a border (H141 efece1c): refs 03, 07.
- The Control Room's REPL row says "no turn now · last turn …", and Home's board cards follow LAST RUN (H141 ae9e069):
  refs 01, 14.
- The Workbench quits with exit 0 when it stopped nothing, 130 when it stopped its own job or chat turn (H141 4bbc27f).
- `c` opens the companion on the tab shown, and from tab 5 on the record selected (H141 5c825ba).
- Studio's next step reads "Open the canvas for Timmy (then ask it to draw)" (lead ef05a95): ref 06.
- Each MCP-to-CLI route card says what the project's newest call through it did, not "? unknown" after calls were made
  (lead 99056d1): ref 08.
- The Workbench's Home and tab 6 say where the companion draws images, and its live legend names each connection's bound
  (the companion and Studio 60 s) (lead 90e4820): refs 01, 06.

## Asked in R6 and not built yet

None of the order's named items is left unbuilt in this revision. What each built item still lacks against its reference
is in the table's "Still differs" column; H145's own limits of the nodes: an arrow that carries a person's own words says
"no data flows" only in the panel, not on the board; data or link is decided by the two cards an arrow joins, not by who
drew it (the panel says who drew it); Studio's labels are written outside tldraw's undo, so a redo brings a hand-drawn
arrow back unlabelled until Studio labels it again; the companion's tab 4 does not list arrows.

## What a terminal can and cannot show

A terminal draws text cells. It cannot render a browser page, a WebGL or Rerun viewport, a tldraw canvas or a video, so
the terminal never pretends to: where a reference shows a live 3D, image or canvas preview, the Workbench draws a
terminal representation (what is on the canvas or in the scene, its files, its last run and its state) and offers
Companion · Show (`c`, on the tab shown) or Studio · Show (`s`) to see it drawn. The companion draws images (Home's
newest images, a run's images and diffs, VoxVision's observed images with what was measured over them, a mesh's views);
no surface draws a 3D scene you can turn, depth or voxels, or replays a run. Timmy has Kitty, iTerm2 and Sixel image
pipelines with an ANSI fallback (src/graphics, chosen by what the terminal answers it supports), used by the older
full-screen app (src/tui); the Workbench does not draw images, so it shows the text representation. The REPL and the
monitor draw box-drawing lines, the amber focus and the green live, passed and sealed states in the 16 terminal colors
the Timmy themes set (slot 3 amber, slot 2 green, slot 7 silver, slot 8 secondary text). The Workbench writes B10's own
colors instead: exactly in a terminal that says it draws 24-bit color (`COLORTERM=truecolor`), otherwise the nearest
of 256 (white text, as the R6 visual review measured). A terminal with another palette still shows each state's word
and glyph.
