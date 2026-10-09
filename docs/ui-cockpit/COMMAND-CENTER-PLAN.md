# Command Center plan: the features on the cockpit

Status: proposal for the operator's approval (2026-10-07), revised the same morning after a second
reviewer's notes. Nothing here is built yet.
Prerequisite: the cockpit's core (C-0 to C-10, the review fix pass, then C-11 to C-15) is the
surface every feature plugs into. Each feature lands three ways from one registry: a slash
command in the REPL, a pane in the cockpit, and a CLI verb (plus an MCP tool where it fits).

## What the operator asked for

- The OpenRouter agent SDK stays the main chat agent and the orchestrator.
- Multi-agent harness operation in the command center: jcode, pi, Hermes, OpenCode, Qwen Code,
  Kimi Code, and the ones added on review: Minds CLI, DeepSeek Harness, OpenHands (CLI and SDK),
  Claude Code, Codex.
- upmd (executable Markdown) featured heavily.
- The tldraw SDK, under the operator's license, with Timmy's canvases and templates, and full
  Editor API access to build anything from scratch.
- Vision and 3D: Roboflow, Rerun, Viser, FiftyOne, Depth Anything, SAM 3.1, and the CAD lane.
- MCP, connectors, and the MCP-to-CLI and async tools: mcporter, apisnip, mcp-probe, mcp-snoop,
  cmcp, bindpuppet, CLI-Anything.

## Rules every feature follows

1. One status ladder per tool, shown as it is: proposed, installed, reachable, exercised,
   qualified (AGENTS.md §8). A package on disk or a configured URL is never shown as working.
2. Harness and actual model are always shown separately.
3. Secrets come from the environment through the private overlay, never the repo. The tldraw
   license key is `TLDRAW_LICENSE_KEY`; it is read at build or run time and never printed.
4. Inventory before adoption (AGENTS.md §8): version, license, update behavior, network
   boundary, control surface. Pending third-party additions stay in the private overlay until
   the operator clears them for the public repo.
5. Every run that changes something ends in a receipt; generated geometry keeps its provenance
   tag (DOCTRINE §16) and is never shown as measured.

## Where each tool stands today (inventory, 2026-10-07)

| Tool | In the repo today | Shown in a UI today | Gap to close |
|---|---|---|---|
| jcode, pi, Hermes, OpenCode, Minds | adapters in `src/harness/adapters`, lane runners | ShellV2 war room, harness picker | the chosen model is recorded but never applied (see F-1) |
| Qwen Code, Codex, Claude Code | cockpit hand types (`timmy cockpit up`) | HANDS tab (needs a private board) | no adapter, no model control |
| Kimi Code | runtime profile only | `timmy runtimes` | no adapter |
| DeepSeek Harness | not found | no | adapter from scratch |
| OpenHands CLI and SDK | MCP `timmy_openhands_run`, sandbox lane, SDK bridge script | panels in the old shell | not in the REPL or cockpit |
| mcporter | npm `mcporter` ^0.12.3, MCP calls | `/porter` (attic panel) | no cockpit pane |
| apisnip, mcp-probe, mcp-snoop | wrappers: `timmy mcp`, `timmy wire` | CLI only | no pane |
| cmcp | npm `@mcpc-tech/cmcp`, client-exec bridge | no | forge slot reports unbound |
| bindpuppet | `bindPuppet` is a function inside `@mcpc-tech/cmcp` (already a dependency); no separate install | no | use it from the cmcp route: binding records a grant, closing the transport records the revocation |
| CLI-Anything | not in this clone; an earlier installation record exists on the operator's machine | no | inventory first (F-0), then evaluate its CLI generation |
| Roboflow | MCP tools, vision CLI, MCP server; its Python environment exists on the operator's machine | `/roboflow`, `/vision` | no pane |
| Rerun | library module, tests only | no | viewer pane, live logging |
| Viser | vision integration registry | status row | viewer pane |
| FiftyOne | geo scoreboard script | no | scoreboard pane |
| Depth Anything | comment only | no | lane |
| SAM 3.1 | not found | no | lane |
| CadQuery, OpenSCAD | recipe executor, compiler backend | CLI only | `/recipe` |
| build123d, FreeCAD | not found | no | recipes |
| tldraw | Mission Map on tldraw@3.15.0 from a CDN, slate compiler, `.tldr` boards | `timmy map`, Slate panel | SDK not a dependency; no Editor API bridge |
| upmd | not in this clone; it exists on the operator's machine, with an existing order that sets its contract and an unapplied candidate (doctor, five tests passed) | no | apply under that order's contract (F-3) |
| Blender | engine lane `lanes/engines/blender` (env lock, a render-still script); the Blender connector on the operator's Mac runs its Python API | no | the next milestone's CAD/Blender worker |
| Houdini, Unreal, USD | engine lanes `lanes/engines/houdini`, `unreal`, `usd` | named in ShellV2 | the next milestone's versioned USD stage |
| Reallusion (Character Creator, iClone) | engine lane `lanes/engines/reallusion` (a CC5 avatar export template) | no | after the next milestone |
| c4dpy (Cinema 4D) | not found | no | adapter from scratch, after the next milestone |
| D5 Render | not found | no | adapter from scratch, after the next milestone |

This table records what is in this clone. F-0 records three things separately for each tool: installed, tested before, and integrated into the cockpit.

Dependency notes from the same sweep: `@mcpc/core` is declared `^0.3.52` but 0.3.48 is
installed; `@modelcontextprotocol/sdk` is imported but only arrives transitively.

## The orders, in order

**F-0 The tool ladder.** `/tools` and `timmy tools`: one table of every tool above with its
live ladder state (binary on PATH, version, MCP reachable, last exercised run, qualification
receipt). It reuses the abilities probe, the vision integrations registry and the wire
bridges. This is the Command Center's index, and the first thing a new user sees.

**F-1 The harness fleet.** First fix the bug: per-harness model choice is written to the policy
but the spawn path never reads it, so a harness runs whatever its own config says. Then:
adapters for Qwen Code, Kimi Code, Codex, Claude Code, DeepSeek Harness and the OpenHands CLI;
`/harness` lists each harness with its model and where that model came from; `/hand <name>
<task>` dispatches from the REPL into its own pane, and the result comes back into the
transcript as a step with a receipt. The OpenRouter agent decides which hand runs a task;
the operator can override. Acceptance is the effective model: which harness and which model
actually answered, taken from what the harness itself reports, never the selected label alone
(harnesses control models in different ways). One verified harness first, then the others.

**F-2 OpenHands SDK runner.** The SDK bridge and the sandbox lane become `/sandbox`: an
isolated runner with its own qualification boundary, for work that must not touch the host.

**F-3 upmd.** Keep the existing upmd contract from its order: `timmy md`, selected blocks and
their dependencies, predictions before execution, one receipt per block, and a final grouped
result. The REPL and cockpit surface it (`/md`), each risky block goes through NEEDS YOU, and the
unapplied candidate (its doctor separates the required upmd and Python from optional repair
tools) is reused, not rewritten. Its parent-process cancellation is not enough to supervise
general Markdown jobs: each block runs in its own process group so Ctrl+C stops all of it. A
upmd file is the readable form of an `.intent` workflow. Needs from the operator: access to the
order and the candidate on the operator's machine.

**F-4 Timmy Studio on the tldraw SDK.** A local web app (127.0.0.1 only, through the C-13 web
views, with a text fallback) built on a pinned `tldraw` package and the operator's license.
It loads the Mission Map, `templates/boards` and the `.tldr` boards. The Editor API is open to
the agent through tools: create shapes, bind arrows, read the page. Custom shapes come first
for receipts, lanes, upmd blocks and harness panes. The Mission Map moves off the CDN copy.
The canvas controls and shows the same jobs as the terminal: cards, dependencies, progress,
outputs and receipts share one job identity and source revision; native artifacts stay
editable; public templates stay blank. Acceptance is more than a view that opens: the page's
own DOM is checked for readability and for status faults, and the recovery snapshot and error
handling from the earlier canvas hand-off are kept.
Proposed home: `companion/studio-canvas/`, because `studio/` is another hand's lab.

**F-5 MCP and CLI routes.** `/mcp` and a cockpit pane. mcporter calls any MCP server from the
command line. cmcp runs it the other way. apisnip, mcp-probe and mcp-snoop inspect traffic.
bindpuppet and CLI-Anything are installed and adapted. AGENTS.md §8 asks for two independent
MCP-to-CLI routes; the pane shows which two are qualified. `/connect` lists the MCP servers in
`config/mcporter.json` with their reachability.

**F-6 The vision observatory.** Three viewers as cockpit panes or browser views: FiftyOne as
the scoreboard, Rerun for timelines and stats, Viser as the 3D view. Roboflow runs through its
MCP tools. The approved vision architecture stands: one ComfyUI adapter on the Spark for GPU
workflows, Roboflow for RF-DETR, and the separate Mac Depth Anything, SAM and DINO wrappers stay
paused. `/vision` shows the ladder and opens the viewers. Provenance, calibration and uncertainty
travel with every result; computed CAD dimensions and physical measurements are separate claims,
and every estimate is labeled as generated until something checks it.

**F-7 The 3D workflows.** `/recipe` surfaces the CadQuery, build123d, OpenSCAD and FreeCAD
recipes, with DOCTRINE §15's measured-CAD sentence wherever measured work is offered.

**F-8 Dependency hygiene.** Fix the `@mcpc/core` range and declare `@modelcontextprotocol/sdk`.

## Decisions for the operator

1. The verb. `timmy cockpit` already names the HANDS tmux session. Proposal: the new layout is
   `timmy center`, and the HANDS panes become its fleet tab.
2. upmd: where its source and package live.
3. tldraw: confirm the license covers the SDK version to pin, and put the key in the private
   overlay as `TLDRAW_LICENSE_KEY`.
4. Order (revised): cockpit acceptance and packaging first, with F-8's dependency fixes; then
   F-0, F-1 (one verified harness), F-2 (scheduled right after F-1), F-3 (one executable
   Markdown workflow), F-4, then F-5 to F-7. Usability comes before a longer roster: readable
   compact layouts, clear focus, discoverable actions, tested mouse and keyboard, and one
   successful real task.

## How each order is checked

The same as the cockpit: a test that fails first, real terminal captures through the contrast
gate, the privacy gate before any push, and nothing committed without the operator's OK. A
feature is called working only at the rung of the ladder it has actually reached.

## The next proof (cockpit acceptance)

One real request, end to end, on the operator's machine with a real key: the REPL takes the
request, one safe native tool job runs with visible progress, the result is editable, and a
verified receipt closes it, with the same job identity in the REPL, the Events tab and the
browser view. This is also what B1 waits for: a successful chat, a tool action, a cancel, and a
usable prompt after it.

## The next product milestone (after this UI milestone)

tldraw, then an existing CAD/Blender worker, then a versioned USD stage, then an editable result
and its receipt: a board sketched on Timmy Canvas becomes a job for a worker that already exists
(Blender through its Python API, or a CadQuery or OpenSCAD recipe), whose output lands as a new
version of a USD stage, opens as an editable file, and closes with a verified receipt. build123d,
CadQuery, FreeCAD, OpenSCAD, c4dpy, Houdini, Reallusion, D5, Unreal, Rerun and Viser stay in the
inventory above. No tool joins the roster, and no monetization work starts, until the cockpit
milestone is finished (third order, 2026-10-07).

## Workspace connections (R1, 2026-10-08)

The owner's direction of 2026-10-08: one connected creative and coding workspace, with the REPL as
its main surface, Timmy names in front (Files, Browser, Canvas, Workflows, Tools, Results) and the
stack's names in setup and details. Rungs follow AGENTS.md §8; ledger rows 122 to 124 hold the checks.

**Connected in R1, exercised on the operator's Mac at `c747545`** (one sandboxed project, one paid
turn of $0.016): one active project for every REPL surface (`/project`, `/files` by role, `/open`,
`/edit`); the agent's project file tools (`write_project_file` asks first); Workflows through the
installed upmd 0.2.7 (`/workflows`, `/run`, prediction sealed before the run, outcome after);
background jobs (`/jobs`, `/stop`, stopped with everything they started); `/preview` of a built
folder, ready when it answers and opened in the Browser as a link; `/results` linking jobs, outputs
and changed files to their receipts; each project keeps its own conversation. Built and tested but not
exercised on the Mac: `/preview` of a dev script (PORT) or a custom command (`--url`), the Browser's
carbonyl pane (corrected in R2: carbonyl is installed there; R1's sandbox did not run it), and the workspace command's time limit.

**Still to connect** (each its own bounded pass; none started in R1):

1. Tools: MCP servers as `/tools` rows and a REPL MCP client, labelled "MCP to CLI" with mcporter and
   cmcp (and the wire lab's routes) underneath; AgentPass and TaskForge as callable tools at their real
   integration state (today they are rows run through `timmy engine`).
2. Uploads and references: `timmy drop` reads the wrong argument and the drop processor is never
   called; an import path into the project's References for images, documents and 3D assets, each a
   visible file the conversation, the Canvas and the tools can name.
3. Vision and spatial routing: read `architecture.input_modalities` (the V flag reads the wrong field
   and never lights); send images only to models that take them, otherwise route through a capable
   worker (Roboflow, the vision adapters, local spatial review) and return attributed observations
   with their uncertainty. The point-cloud worker stays in its own phase and register.
4. Canvas: reference boards, parameter cards, and workflow and result cards that say plainly whether
   they are a diagram or executable; an executable card starts the same jobs as `/run` and `/preview`,
   and its output returns to the project and the board.
5. upmd beyond R1 (F-3): one receipt per block (today the prediction and one per run), NEEDS YOU before
   a risky block, the md ledger with declared input hashes (DESIGN §12), `timmy md` on the CLI, and the
   preserved U0 candidate (`timmy md doctor`) applied by its build owner.
6. Coding agents from the REPL (F-1): Claude Code, Codex and Qwen Code started in a pane on the same
   project and job identity; editor integration beyond `$EDITOR` (Neovim).
7. Terminal presentation: Kitty and iTerm2 image display in the REPL (today only in the v1 shell),
   Ghostty, carbonyl's install, term.everything where its host supports it, gotty.
8. The monitor reads the same jobs (`<TIMMY_HOME>/jobs`) and the active project
   (`<TIMMY_HOME>/state/active-project.json`).
9. Found along the way: the event bus writes beside the working folder while receipts follow the store
   pin; Composio calls a removed API version; `timmy tools` does not read a `.env` file that `/tools`
   reads.

The full catalog stays where it is, in the inventory above and the private register: c4dpy, aerender,
Houdini, Unreal, USD, Blender, build123d, CadQuery, FreeCAD, OpenSCAD, Rerun, Viser, FiftyOne and the
rest. None of it joins the roster in this pass.

**The next bounded pass, recommended: References in, observations out.** Import an image or a 3D
asset into the project's References, name it in the conversation, route it to a model that takes
images or to a worker that can (Roboflow first), and return the observation attributed to its source
and model, with its uncertainty, as a result file and a receipt. It joins items 2 and 3, reuses the
jobs and Results built in R1, and is the first step toward the spatial-vision phase.

## Workspace connections (R2, 2026-10-09)

The owner's standing order of 00:43 PT (three hours, to 03:43): finish the command output limit and the
fresh-Mac walkthrough, then the next connected workflows, in stages. Ledger rows 127 to 130 hold the
checks. Four words keep the states apart: **planned** (in a plan or the private register, no code),
**implemented** (code and tests on this branch), **configured** (the program or setting it needs was
found on the operator's Mac) and **demonstrated** (run end to end on the operator's Mac, in a sandbox,
with the REPL's own text kept). A configured app with no demonstrated run is not an integration.

| Area | Demonstrated on the Mac | Implemented, not demonstrated | Planned or not connected |
|---|---|---|---|
| 1. Projects, files, coding | R1's `/project`, `/files`, `/open`, `/run`, `/preview` of a built folder, `/results`, one conversation per project; R2's `/project new <name> --from web-starter`, then its dev server, its source reopened, `/run BUILD.md build` and the built `dist/` previewed; `/add` into `refs/`; an app's dev server through `/preview` (`npm run dev` with `PORT`), its source reopened and its process group stopped, after a fix the run found; a 1.99 MB command output bounded to its first 4 KB and last 12 KB, the rest in `.timmy/runs/` | `/preview <command> --url`; the workspace command's time limit | starters beyond the web page (a Vite or React app, a Python tool); coding agents (Claude Code, Codex, Qwen Code) on the project from the REPL (F-1); editor integration beyond `$EDITOR` |
| 2. Workflows and Canvas | upmd `/workflows` and `/run` (R1); `/board`, a read-only reference board whose cards link the project's files, jobs, outputs and observations and show the command that acts on each | | cards that start jobs (from the board or Canvas); a workflow node view; one receipt per upmd block, NEEDS YOU before a risky block, `timmy md` |
| 3. Tools, connectors, agents | two MCP-to-CLI routes, each run against the test server: MCPorter's CLI (`mcporter` 0.12.4) and Timmy's own CLI on `@modelcontextprotocol/sdk` 1.30.0; `/tools` rows for both | the agent's `list_mcp_tools`, `list_mcp_command_tools` and `call_mcp_tool` (the last two ask each time) | AgentPass and TaskForge through their real interfaces (rows only; `/tools` says `needs setup`); mcpc, ApiSnip, bindPuppet, CLI-Anything wired as routes; servers from the operator's own MCP configuration contacted. cmcp was checked and is not a route: it forwards calls to tools its clients register and has no command line |
| 4. Uploads, browser, terminal | an image through `/add`; the board's link fallback in the terminal | kind detection by bytes or name for images, documents (PDF, DOCX), video and 3D (glTF, PLY, FBX, USD, STL, OBJ) | `timmy drop` (reads the wrong argument); carbonyl's pane from a sandboxed REPL (carbonyl is installed on the Mac and `/tools` finds it; a REPL started with a cleared environment does not know it is inside tmux, so it prints links); Kitty, iTerm2 and Ghostty images in the REPL; term.everything |
| 5. Vision and spatial | the OpenCV Look worker as a job (`/observe` and the agent's `observe_image`), labelled deterministic computation; a model's interpretation as a separate tier, sent only to a model OpenRouter lists as taking images (Haiku 4.5); observations bound to the image's sha256 in Results and on the board, with receipts | refusal of a text-only model with alternatives; the provider's charge counted on a BYOK key | Roboflow, Rerun, Viser, FiftyOne and the reconstruction and mapping stack (register only); uncertainty beyond the two tier labels |
| 6. Native creative software | the stop when Cinema 4D waits for a person (its license question): the job fails at once with what to do | `c4dpy` and `aerender` as jobs judged by a result file, a run token and the files' sha256 (exit code recorded, not decisive); `run_native` (asks each time); `templates/c4d-starter` | a real Cinema 4D scene run (the operator chooses the license method first) and an After Effects render (needs an `.aep`); Houdini, Blender Python, Unreal, USD, Spline, Character Creator, iClone and D5 |

Configured on the Mac (found, not proof of a working integration): Cinema 4D 2026's `c4dpy`, After
Effects 2026's `aerender`, Python's OpenCV, upmd 0.2.7, `mcporter`, Claude Code, Codex and Qwen Code.

**The next bounded stage, recommended: one native round trip.** With the operator's license choice made,
run `templates/c4d-starter` through `/c4d` on the Mac: a native `.c4d` scene and a render written by
`c4dpy`, judged from its result file, both on the board, then `/observe` on the render so the image is
measured and linked back to the scene that made it. It reuses the job, Results, board and Look routes
built here, and it is the first creative-software integration that can be called demonstrated. After
it: cards that start jobs (area 2), and AgentPass and TaskForge through their own interfaces (area 3).


