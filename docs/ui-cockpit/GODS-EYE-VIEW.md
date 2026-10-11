# God's Eye View: the project overview

Round R4, helper H78, branch `r4/gods-eye`. **Status of this slice: implemented and tested** in the development
container (Linux, Node 24, a real headless Chromium), with the existing readers and real record writers in temporary
projects. **It has not run on the operator's Mac, so nothing of it is demonstrated.** The words below keep four states
apart: *planned* (written down, no code), *implemented* (code exists), *tested* (a test exercised it here and passed),
*demonstrated* (it ran for real on the Mac and a row of [CHECKPOINTS.md](CHECKPOINTS.md) records it).

## The owner's definition

> God's Eye View should provide a unified overview of the active project:
> - Agents, their assignments, models/harnesses, progress and handoffs.
> - Workflows, dependencies, running jobs, blockers and decisions needing me.
> - Connected applications, editable artifacts, previews and results.
> - Relevant spatial/voxel views and useful metrics from Timmy VoxVision.
> - Recorded history, costs and receipts, with drill-down to their source.
>
> Connect it to the same project and operation records used by Control Room, Studio/tldraw, the terminal and browser
> companion. Keep the overview understandable, with advanced details available when needed. Distinguish actual spatial
> geometry from an abstract layout of agents or workflows; show unknown and stale information honestly. God's Eye View is
> the overview; Control Room provides operational detail; VoxVision provides spatial inspection and analysis. Reuse their
> shared state and controls rather than building disconnected dashboards. Record what already exists, what is partial
> and what remains.

Here the browser companion is the board (`/board`, `/board live`), and Studio/tldraw is Timmy Canvas.

## What existed before this slice

**Nothing under the name.** Searched before building: the repository's files, the commit messages of every branch, and
the round notes. No specification, code or ledger row named God's Eye View.

**Earlier material, read and kept as it is:**

- **The Mission Map** ([MISSION-MAP-INTERFACE.md](../MISSION-MAP-INTERFACE.md), `timmy map`). `timmy map` starts the vision
  server on port 4336 (`src/cli.ts` `map` → `src/vision/cli.ts`), which serves `studio/tldraw-mission-map` and its
  `/dispatch` plan list (`src/vision/server.ts`). It is an authoring canvas that compiles Task Capsules into DispatchPlans
  for the dispatch controller. It is not an overview of a project's records: its routes serve vision events and
  dispatch plans, not the operation, job, flow or VoxVision records the overview reads. The overview neither uses nor
  changes it.
- **The Command Center plan** ([COMMAND-CENTER-PLAN.md](COMMAND-CENTER-PLAN.md), a proposal). Its F-4 asks that the canvas
  "controls and shows the same jobs as the terminal: cards, dependencies, progress, outputs and receipts share one job
  identity", and its item 8 that the monitor read the same jobs and active project. The overview follows that rule: one
  set of records, several surfaces.
- **The B9 monitor proposal** ([B9-MONITOR-PROPOSAL.md](B9-MONITOR-PROPOSAL.md), a proposal) is about the `timmy watch`
  monitor's focus colour. The overview takes nothing from it; it uses the board's Timmy Homebrew tokens.
- **The optional UI references** ([OPTIONAL-UI-REFERENCES.md](OPTIONAL-UI-REFERENCES.md)). Eight concept sheets, none named
  an overview; the Terminal sheet pairs the REPL with "a fullscreen watch and monitoring view". Kept from them: charcoal
  and off-white, Homebrew green for interaction and never as proof, progressive disclosure.
- **Older dashboards**, unchanged: the "Dashboard" chat mode (`src/modes/index.ts`, `src/modes/dashboard/mode.ts`:
  "Multi-panel overview: agents, models, resources", with no tools); the older full-screen TUI's `DashboardPanel`
  (`src/tui/panels/DashboardPanel.tsx`, a capability list); and `src/utils/dash.ts`, which serves
  `studio/dashboard.html` on port 4273, a page this repository does not contain. None of them reads the R4 records.
- **The board's sections**, which the overview summarises and links to: the Control Room (`src/room`,
  `src/repl/board-room.ts`), Waiting on you (`src/room/decisions.ts`), operations and their cards (`src/ops`), Results
  and review (`src/review`), Workflows (`src/workflows`, `src/repl/board-workflows.ts`), Jobs (`src/jobs`), Flows
  (`src/repl/board-flows.ts`), VoxVision (`src/vox`, `src/repl/board-vox.ts`), Memory (`src/memory`), and the Timmy
  Canvas project cards (`src/studio/project-cards.ts`).

## Three roles, one set of records

| Role | Where | What it is for |
|---|---|---|
| God's Eye View, the overview | `/overview`; the board's first section; the live board's `GET /overview` | the project at a glance, what needs you first; every item links to the section or command that shows it in full; it acts on nothing |
| Control Room, operational detail | `/room`, `/decisions`, `/op`, `/ops`, `/jobs`, `/stop`, `/recover`; the board's Control Room | runs, stops, handoffs, costs, tools, what waits on you |
| VoxVision, spatial inspection and analysis | `/inspect`, `/measure`, `/detect`, `/compare`, `/vox view`; the board's VoxVision | measured values with their status words, highlights, the Rerun viewer |

The overview has no reader of its own: each part comes through the reader the other surfaces use
(`src/overview/sources.ts`). In the REPL it is built from what the board has just read, so the board's Overview, the
Control Room beside it and `/overview` show the same records at the same moment.

| Record | Where it lives | Its reader | Read by |
|---|---|---|---|
| Operations | `.timmy/operations/<id>.json` (`timmy.operation/1`) | `buildIndex`, `recentOperations`, `operationCard` (`src/ops/card.ts`) | Control Room, `/op`, overview (agents, history) |
| Jobs | `<TIMMY_HOME>/jobs` | `readProjectJobs` (`src/studio/project-cards.ts`), the REPL's job manager | `/jobs`, board Jobs, Control Room, Canvas cards, overview (workflows) |
| Flows | `results/flows/<id>.json`; running ones `.timmy/flows/<id>/state.json` | `readBoardFlows` (`src/repl/board-flows.ts`) | board Flows, Control Room, overview (agents, apps, map) |
| Agent runs | `.timmy/agents/<id>/` | `listAgentRuns` (`src/code-agents`) | `/agent`, Control Room, overview (agents) |
| Workflow documents and runs | the project's upmd documents; their runs in job records | `findWorkflowDocs`, `connectWorkflow`, `runBlocks` (`src/workflows/run-blocks.ts`) | `/workflows`, board Workflows, overview (workflows) |
| What waits on you | the records above, the REPL's open prompt and refused saves | `gatherDecisions`, `markWaiting` (`src/room/decisions.ts`) | Waiting on you, `/decisions`, overview (needs) |
| VoxVision records | `results/vox/<id>.json`, highlights in `results/vox/<id>/` | `readBoardVox` (`src/repl/board-vox.ts`) | VoxVision, overview (spatial) |
| Changes to review | operations and their kept copies | `reviewView` (`src/review/changes.ts`) | `/review`, Results and review, overview (apps) |
| Lessons | Timmy Memory's records | `readBoardMemory` (`src/memory/board.ts`) | Memory, overview (needs, history) |
| Receipts | the runs chain of the receipts store | `readRunsChain` (`src/studio/project-cards.ts`), `verifyReceiptIn` (`src/utils/receipts.ts`) | `timmy verify`, every card's check, overview (history) |
| Process proofs | the live process table | `writerState` (`src/ops/process-proof.ts`), `starterGone` (`src/room/left-runs.ts`) | recovery, Waiting on you, Control Room, overview (every "running") |

## What this slice adds (implemented and tested)

- **One model**, `buildOverview(projectRoot, opts)` (`src/overview/build.ts:40`), typed in `src/overview/model.ts`
  (`timmy.overview/1`): sections `needs`, `agents`, `workflows`, `apps`, `spatial`, `history`, `project`, and `map`. Each
  section has `as_of`, `state` (read, partial or unknown, with `why`), counts that say what they count, its most urgent
  item, and the records of its kind that could not be read. Each item has a `source`: its record (relative to the
  project, or null) and the command that opens it (`/op <id>`, `/jobs <id>`, `/room <id>`, `/decisions`, `/workflows <doc>`,
  `/review <op>`, `/open <record>`, `/lesson check <id>`, `timmy verify`), and the board section that shows it.
  - In the REPL (`src/repl/workspace.ts`, `overviewOf`) it is given what the board read; nothing is read twice.
  - Anywhere else it names the project folder, the jobs folder and the receipts store, and reads through the same readers.
    A standalone read says what it cannot see: the REPL's own NEEDS YOU box, a save the board refused and the flows a REPL
    runs are held by that REPL.
- **The terminal**: `/overview` (`src/repl/overview.ts`, registered in `src/repl/commands.ts`). The first screen is one
  line per section with its counts and most urgent item, Needs you first, within 80 columns and about 25 lines.
  `/overview <section>` (or `map`) shows one in full, `--all` every one, `--json` the model (pretty-printed; through
  `timmy act '/overview --json' --json` the model is the act answer's `lines`, joined).
- **The board**: the Overview is its first section, first in the contents (`src/repl/board-overview.ts`, hooked in
  `renderBoardBody`, `src/repl/board.ts`). One card per section with its items; each item links to the board section that
  shows it (Control Room, Waiting on you, Workflows, Jobs, Flows, VoxVision, Results and review, Memory, and the line about
  Timmy Canvas when the REPL has checked the canvas) and carries its command as a copy button. Its links stay within the
  page; on the snapshot board a thumbnail also links to its image file, on the live board nothing links to a file.
- **The abstract map**: agents → workflows → artifacts as a small SVG, captioned and labelled **"layout, not geometry"**.
  Its nodes are the items above and its lines only the links the records name (a flow's agent run; the files a flow or app
  run made).
- **Spatial thumbnails**: only a VoxVision record's highlight that its card shows (its bytes are the ones its record and
  receipt name), captioned **"geometry from results/vox/<id>.json"** (or "image from …" for a picture). On the live board
  the image is fetched with the token through the board's `/file`, as VoxVision's own are.
- **The live board's `GET /overview`** (`src/repl/board-live.ts`): the model as JSON, with the board's token, GET only
  (405 otherwise), as `/state`. It is the route Timmy Canvas can use later. The live page does not redraw for the
  overview's own times (`overviewShape` leaves `as_of` out of the page's shape).

## How it stays honest, and where

- **Running is proven, never read off a record.** A job is `running` only when its process runs and the Timmy that
  started it runs; `left` when it runs and its starter has ended (`/recover` settles it); `stale` when its own process is
  gone; `unknown` when it cannot be proven (`src/overview/proof.ts`, by `starterGone` and `writerState`). An operation is
  `left` when the process that writes its record has ended. A flow's state file proves nothing by itself: running only
  when this REPL runs it or its step's job is proven running; stale after recovery's own quiet time; else unknown.
- **Unknown is said, with why.** A section whose source cannot be read is `unknown` with the reader's error; a record that
  cannot be read is listed with its reason (not JSON; the wrong schema); a receipts store that cannot be read makes the
  receipts "not known", never "no receipts yet".
- **Costs.** A reported amount is summed; a run whose request went out and whose cost did not come back is `unknown` (null),
  counted apart and never summed as 0; a run on a local endpoint is free; a run that sent no request has no cost at all.
  The totals are the Control Room's own (`gatherRoom`, `costsLine`). A run whose record holds no cost field at all is
  shown as the Control Room shows it, "no cost recorded" with its reason, and is not counted, as the Control Room's line
  says; a chat turn whose receipt records no cost is such a run (see Open).
- **Counts say what they count** ("receipts of this project", "receipts in the store (every project)", "with a run
  running now (proven)"), and every list stops at 8 items with the rest counted ("and N more").
- **Geometry and layout are never mixed.** The map is labelled a layout; only a VoxVision record's own highlight is shown
  as geometry, labelled with its record.
- **It acts on nothing.** It runs, stops, writes and seals nothing, and starts no process or watcher; its commands are
  for a person to type, and the board's controls stay in the sections that own them.

## Each part of the definition: what exists, what is partial, what remains

"Exists" names code, its tests and the Mac run that demonstrated it (a CHECKPOINTS row). Everything this slice added is
implemented and tested only: its Mac run remains for every row.

| Part of the definition | Exists | Partial | Remains |
|---|---|---|---|
| Agents, their assignments, models/harnesses, progress and handoffs | The Control Room's runs with route, crew role, state, Stop, handoff and cost (code and tests; demonstrated rows 157 B, 158 A3, 162 G). Overview `agents`: assignment in the run's own words with where they come from, route, proven life, step and elapsed, handoffs (to a step's owner, to you, to the review), cost (tested) | Progress is the record's state, step and elapsed time; no percent or ETA is invented. A run that recorded no model shows none | Mac run of the overview |
| Workflows, dependencies, running jobs, blockers and decisions needing me | Workflow cards with graph, needs and live block states (demonstrated rows 157 A, 158 A2, 162 A); Waiting on you and `/decisions` (built; on the Mac shown only empty, row 162 C). Overview `workflows` (blocks with their needs, the newest run's blocks in run order by `runBlocks`, proven running jobs, blockers: a failed block, a run left, a decision waiting on that run) and `needs` (the same list as Waiting on you) (tested) | Dependencies are the `needs` written in one document; nothing links one workflow to another, as no record does. A block cannot itself wait for a decision (upmd's NEEDS YOU before a block is planned in COMMAND-CENTER-PLAN.md, item 5, not built) | A Mac run with an item waiting on you; the overview's Mac run |
| Connected applications, editable artifacts, previews and results | Native app runs with verdicts and readbacks (demonstrated rows 148, 151, 153, 163 I); Results and review with `/restore` (row 163 R). Overview `apps`: native, recipe, MCP and viewer runs with verdicts; the files they made as editable (with the application whose file it is), export or preview; the changes to review (tested) | "Connected" means the applications Timmy ran here; installed tools are in `/tools`, and the setup a run needs is in Needs you. Opening an artifact in its application is a command, not an overview action | Mac run |
| Relevant spatial/voxel views and useful metrics from VoxVision | VoxVision records, cards and highlights (demonstrated rows 157 C, 158 B, 162 D). Overview `spatial`: each record's values with their status words exactly as the record and its check label them (the record's own word kept when the check differs), highlights as thumbnails "geometry from <record>" (tested, in a real headless Chromium) | "Relevant" is the newest records first; there is no relevance ranking. The 3D view is `/vox view <id>` (Rerun, which a person starts; there is no `/vox show`) | Mac run |
| Recorded history, costs and receipts, with drill-down to their source | The receipts chain and `timmy verify` (row 158 A4: the chain verified; row 163 R); the Control Room's costs (row 157 B: free, local). Overview `history`: the project's newest receipts, the chain head checked by `verifyReceiptIn`, costs reported, unknown and free, operations recorded, running and left, lessons by status, each with its command (tested) | The head check covers its epoch's links up to the head; the whole chain is `timmy verify`'s, which the overview names and does not run. The Mac runs recorded since the Control Room was built used local models (rows 158, 162 and 163 record no paid call), so a reported cost has not been shown there | Mac run |
| The same records as the Control Room, Studio/tldraw, the terminal and the browser companion | Terminal (`/overview`) and the board (both tested); the Control Room's readers are the overview's | Timmy Canvas: the model is reachable through the live board's `GET /overview` (with the token); the canvas does not show it yet | The Canvas view (below) |
| Understandable, with advanced details when needed | First screen within 80 columns and about 25 lines; a section in full; `--all`; `--json`; the board's cards (tested) | Not yet read by the owner | The owner's read on the Mac |
| Geometry apart from an abstract layout | Map labelled "layout, not geometry"; thumbnails only from VoxVision records, labelled with the record (tested) | | Mac run |
| Unknown and stale shown honestly | left, stale and unknown by process proofs; unreadable records with their reasons; unknown costs never summed (tested with real child processes, signals, records and receipt chains) | | Mac run |
| Reuse shared state and controls, no disconnected dashboard | The overview reads through the existing readers and has no controls of its own: it links to the sections and commands that act | | |
| Record what exists, is partial and remains | This document | | Keep it current with each Mac run |

## What Timmy Canvas still needs

The canvas (`companion/studio-canvas`, `src/studio`) is not changed by this slice. To show the overview there, one of:

1. **A route on the canvas server** that calls `buildOverview(projectRoot, { jobsDir, store, name })` with the same
   project, jobs folder and receipts store its project cards read (`src/studio/project-cards.ts` reads jobs and the runs
   chain the same way), behind the canvas's own token as `GET /api/project` is, and a view in its Project panel that draws
   the model (each item linking to the board's section, as the canvas's Open on the board does). Read this way it says what
   a REPL holds and it cannot see.
2. **Or the live board's `GET /overview`**, which needs the board's token on the canvas page. Handing the board's token to
   the canvas is a decision (row 156: the same-origin handoff "is a decision"; the handoff built since is between board
   tabs, row 162 C).

## What a Mac run should check

In a fresh sandbox user with the installed package, as rows 158, 162 and 163; no paid call; scripted steps labelled.

1. `/project new <name> --from tray-workflow`, then `/overview`: the first screen fits the terminal at 80 columns, Needs
   you first, every section with counts, the map line saying "layout, not geometry"; the commands green.
2. Run the workflow (Run up to here on `lesson`, as rows 158 and 162): while the agent works, `/overview` and the board's
   Overview say the workflow run, its flow and the flow's agent run are running (proven), with the assignment in the
   request's words and the route (Qwen Code with the local model); once it ends, its cost is free.
3. Type `/iterate tray "make the tray 165 mm wide"` and kill that REPL with SIGKILL during the agent step (as row 157 D);
   in a new REPL, before `/recover`: the overview says the agent's job and the operation are **left** (never running),
   with `/recover` named, as Waiting on you does; after `/recover`, the job cancelled and the flow interrupted.
4. After the run: `apps` lists the parameter file as editable with its application, the STEP or STL as an export, a
   preview where one was made, and the change to review; `spatial` lists the VoxVision record with its values labelled
   as its card labels them and, on the live board, its thumbnail captioned "geometry from results/vox/<id>.json".
5. `history`: the project's receipts, the head verified (compare with `timmy verify`), costs: free runs counted, nothing
   reported, unknown 0.
6. A draft lesson (the tray workflow's lesson block) appears in Needs you with `/lesson check <id>`, as Waiting on you and
   `/decisions` show it; after the check it is gone from both.
7. On `/board live` in a fresh browser profile: the Overview is the first section and first in the contents; a "Control
   Room" link moves to the Control Room; a command copies itself; the page is not redrawn every poll when nothing changes;
   `GET /overview` answers 401 without the token and the model with it.
8. Make a record unreadable (a copy of an operation record with a wrong schema): the overview names it with its reason.
9. `timmy act '/overview --json' --json`: exit 0, the model in its `lines`; no absolute path or home folder in it.

## Open

- Not demonstrated: nothing of this slice has run on the Mac.
- The tools part of Needs you (setup a run needs) is checked once per REPL session, as `/decisions` checks it.
- `timmy act '/overview' --json` carries the first screen's text lines; the model comes only with `/overview --json`.
- The canvas view (above) is not built.
- A chat turn whose receipt records no cost field asked a model, so its cost is not known; the Control Room files it under
  "runs that record no cost are not counted" (`src/room/index.ts`, `chatRuns` and `receiptCosts`), not under unknown, and
  the overview follows the Control Room so that both count alike. Counting it as unknown is a change to the Control Room's
  rule, for its owner to decide.
