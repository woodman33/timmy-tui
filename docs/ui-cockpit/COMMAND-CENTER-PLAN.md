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
