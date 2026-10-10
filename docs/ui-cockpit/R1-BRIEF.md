# Round R1: shared brief for the lead and the two workers

Updated 2026-10-10 by helper H43 for the lead (Opus), after round R4 (ledger rows 145 to 152; row 153, r17, not yet run). The Haiku worker's thread stalled before its first hand-off, so the lead keeps this file current; anyone may add a line under "For the lead".

## Where the work is

- Repository: `woodman33/timmy-tui` (public: never commit personal information, keys, hostnames or home paths; the privacy hook in `.githooks` runs on every commit).
- Integration branch: `feat/ui-workflow-r1` (only the lead pushes here). Draft PR #94, based on `feat/ui-cockpit`.
- `feat/ui-cockpit` / PR #93 is the qualified rc.2 candidate (C-19). It and `docs/ui-cockpit/c15/` to `c19/` stay exactly as they are.
- HOLD: no merge, no npm publish, no tag, no deploy. Development only: nothing in R1 is called qualified or launch-ready (AGENTS.md §5, §10).
- The ledger is `docs/ui-cockpit/CHECKPOINTS.md`. Only the lead writes it; rows 112 onward are R1.

## Objective

A functional, organized Timmy whose capabilities are easy to find and use: the REPL, the monitor, Timmy Canvas, the tools and the backends in one workflow that says where you are working, which tool or agent handles the task, what is happening, and where to inspect the editable result, preview and receipt. Then the Homebrew-inspired default look (DESIGN.md §10 B9).

## Done (on `feat/ui-workflow-r1`)

| Commit | What |
|---|---|
| `216392d` | Tools say when their service is missing or failed, with the setup step; nothing is invented; failed steps show and seal as `failed`. Each turn names its folder and model and ends with where to inspect the canvas job and the receipt page. `/tools` and `timmy tools` (the ladder: reachable, installed, needs setup, not built). `/canvas`, `GET /api/canvas/health`, one canvas address. |
| `f8f3564` | Timmy Homebrew, the default look, from `src/theme/tokens.ts`: terminal palette, theme files, a macOS Terminal profile with Monaspace Argon, `timmy theme install` defaults, the canvas panel and receipt page. |
| `66b6e7c` | No invented AgentPass passport, "VERIFIED" visa, storage or proof in lane panes; no random credentials or seeded "verified" log lines. |
| `13ac799` | An independent review's findings (ledger row 118): `get_env` checks names and values; the workspace command and `get_env` ask every time; "Outcome unknown" when a request may have run remotely; failed steps read "Run failed:" or "Not run:"; API lanes need their key in `timmy tools`; "used" dates count only turns sealed with `outcome_rule: 2`; no invented lane figures. |

| `458a015` | From the live run on the Mac: a canvas call that fails keeps nothing (undone to a history mark), and a call that crashed tldraw's page restarts it from the canvas as it was before the call; answers say `rolledBack`, `restarted`, `changed`; jobs are marked by their last call with failed calls counted. |
| `af536cb` | `canvas_exec` carries a drawing that works in this tldraw (tested in a real browser); a turn that ends at its step or spend limit with a call open says so; `~/…` for a home reached through a link. |

| `8db45cd` | Merged PR #95 (Sonnet): the demo label, zellij Timmy Homebrew, the Canvas and Receipt words on the panel and receipt page, Monaspace Argon review pictures, and the B9 monitor proposal (ledger row 120). |
| `1bd8f6b` | The monitor only reads when it opens (no `model.policy` seal, no policy write) and its header names the model the REPL last ran; `listLanes()` needs an API lane's key and hyperframes' own command; CI runs its full gate on pull requests into `feat/**` (ledger row 121). |
| `0c58025`, `c00374b` | Setup steps checked against each tool's own docs and corrected; `docs/TOOLS-SETUP.md` (ledger row 122). |
| `4a012c1` to `b5f5f05` | One connected workspace in the REPL: `/project`, `/files`, `/open`, `/edit`, `/workflows` and `/run` (upmd, as background jobs with a sealed prediction), `/preview`, `/jobs`, `/stop`, `/results`; jobs in their own process groups; receipts name the project and the files a turn wrote (ledger row 123). |
| `c747545` | A turn that throws says why; each project keeps its own conversation (a defect the Mac demo found, row 124). |
| `108f7b6` | The workspace command runs with a time limit in its own process group; the remaining workspace connections recorded in COMMAND-CENTER-PLAN (row 124). |
| `50b9ca8` | What an independent check of `b1ede23` found: private names compared without case (a real leak on macOS), only regular files served by the preview, no absolute paths in job receipts, errors instead of throws, and "its process group" where a stop covered no more (row 126). |
| `b1ede23` | The six findings of the independent review at `c7475458`: links to private files, redirected writes, jobs that outlive their first process, `/stop`'s ownership and wording, the preview server's read errors, Results by project identity (row 125). |
| `12eb92f` … `989d7d5` | Round R2 (the owner's 00:43 standing order; rows 127 and 128): a command's output bounded with the full output in a run log, `docs/FRESH-MAC.md` and the `tsx` launcher (H1); two MCP-to-CLI routes and `/mcp` (H2); `c4dpy` and `aerender` jobs (H3); `/add`, the OpenCV Look worker and `/observe` (H4); `/board` (H5); the lead's integration (`8f4c2f8`) and the Mac's findings fixed (`b28901e`, `7a81b30`, `c70e3e9`, `0ca1b06`); project starters (`4d9cf52`); an independent review's findings fixed (`2225869`). |
| `858bd1a` … `ad80912` | Round R3 (the owner's 13:26 order; rows 132 to 138): the 7 findings of the independent review of `40022d9` fixed (stops escalate to SIGKILL; the interpretation inside the observation job with its cost kept; the board's provenance check; native results bound to their run; exercise per app; the package carries the starters and workers), `/blender`, `/mcp servers`, then `/recipe` (CadQuery as a durable job), `/board live`, `/agent` and `/observe --qualify` by helpers H11 to H14, and `docs/ui-cockpit/FEATURE-CHECKLIST.md` (H15). |
| `cbb09ca` | Review M7 (row 144): the qualified answer's heading names the cited values as measured, never the answer: "model answer (a claim), citing measured values: …". |
| `622fdd7` | The tray recipe's parameter file, `recipes/tray.params.json`: `/recipe tray` takes it as its defaults (words typed after it still win), names it in the sealed prediction, and refuses to start on a file the recipe would refuse; each write replaces it whole and keeps the previous copy under `.timmy/params-history/`. |
| `aa2a9fe` … `5a4c092` | Round R4, batch 1 (helpers H16 to H24; row 145). The independent review of `07f37ec`, checked against the source, fixed: a stop waits until every process in the group is gone (H16); every way of stopping reaches a running recipe, and its delivery reads one verified snapshot (H17); native runs run a read-only copy of the script and count only files they made (H18); a paid answer and its cost survive an observation file that cannot be written (H20); the live board's token stays off command lines (H21). New: `timmy drop` through the drop processor (H19); the packed-install check (H21); the board's parameter, workflow and result cards, with node editing and Rebuild (H22); After Effects authoring with `/ae author`, `edit` and `inspect` (H23); `/iterate tray` (H24). |
| `3942c31` | The npm package carries the After Effects starter and the STEP readback worker; the parameter file's kept history is never written through a symbolic link. |
| `9868c63` … `bd3c253` | Round R4, batch 2 (H25 to H32; row 147): Codex with a local model (H25); `/iterate blender` (H26); OpenSCAD (`/scad`, H27) and FreeCAD (`/freecad`, H28) as judged native routes, each with a starter; reliability fixes (H29); board cards for observation records kept when their file could not be written (H30); vitest's worker RPC timeouts gone (H31); recovery after a restart (H32). |
| `32c6d7c` | The npm package carries the OpenSCAD and FreeCAD starters and workers and the `.blend` readback worker. |
| `a2016f0` | The `/tools` rows test expects six native rows, now that OpenSCAD and FreeCAD are both merged (row 147). |
| `9b52c75` … `b8f9407` | Round R4, batch 3 (H33, H34, H37; row 150): `/iterate scad` and `/iterate freecad`, and `--agent codex` for every target (H33); MCP calls kept as records with receipts, readable answers, the server's own error text, JSON arguments as typed and safe URLs (H34); Blender object sizes in both passes, and Codex's local sandbox kept to the project with no network (H37). H35 reviewed `07f37ec..a2016f0` read-only: eight findings, R4-1 to R4-8. |
| `9f11f2c` … `2f72e0b` | Round R4, batch 4 (H39 to H41; row 152). The review's findings fixed: H39 judges an agent's changes across the whole project, `.timmy` and `dist` included (R4-2), refuses a board parameter save while a flow runs (R4-3), allows one flow start at a time per project (R4-5), places records on disks without hard links (R4-7), never leaves a recipe copy half-written (R4-8), and tests Blender's interrupted flows in recovery (R4-1, fixed in batch 3); H40 keeps one malformed flow record from breaking the board or `/iterate` (R4-4), gives `/mcp` its line exactly as typed, names its tools' receipts in a turn's receipt and `iterate_native` in approvals and `/tools`, and has the packed-install check ask for this round's starters and workers. H41 adds `/iterate ae`, judges the file aerender wrote when its output module picks another container (`--om` passes a template), and has After Effects report keyframes and solid colours; the lead's `62de508` names `.mp4` in `/ae author`'s next step. |
| `10faca5` | CHANGELOG entries for the later R4 batches and the fixes from the review of `a2016f0` (the first batch's entries came in `54ccadd`). |

Checks at `2f72e0b` (row 152): locally the full suite, 334 files passed and 7 skipped (3,277 tests passed, 60 skipped), 0 failed, vitest exit 0; `tsc` exit 0. GitHub's CI had not run on this head when this was written (the lead pushes later).

Checks at `b8f9407` (row 150): locally the full suite, 321 files passed and 7 skipped (3,175 tests passed, 60 skipped), 0 failed, vitest exit 0; GitHub's CI and the privacy gate passed at `b8f9407`. On the operator's Mac (row 151) the packed-install check passed 13 of 13 at this revision (Node 24.14.1), with npm's EBADENGINE warning for `@opentui/core`.

Checks at `a2016f0` (row 147): locally the full suite, 318 files passed and 7 skipped (3,103 tests passed, 60 skipped), 0 failed, vitest exit 0, with no worker RPC errors any more; GitHub's CI and the privacy gate passed at `a2016f0`.

Checks at `71fec51` (rows 141 and 143): locally the full suite (with `NODE_PATH` unset), 293 files passed and 7 skipped (2,747 tests passed, 58 skipped), vitest exit 1 from 2 worker errors with no test failed; `tsc` exit 0; GitHub's CI and privacy gate passed at `71fec51`.

Checks at `e005fe5` (after an independent review's fixes, row 141): locally the full suite (with `NODE_PATH` unset), 293 files passed and 7 skipped (2,743 tests passed, 58 skipped), vitest exit 1 from 3 worker errors with no test failed; `tsc` exit 0; GitHub's CI and privacy gate passed at `ee70b9e`. Continuation queue: ledger row 142.

Checks at `ad80912`: locally the full suite (with `NODE_PATH` unset), 293 files passed and 7 skipped (2,739 tests passed, 58 skipped), vitest exit 1 from 3 worker errors ("Timeout calling onTaskUpdate") with no test failed; `tsc` exit 0; the privacy gate passed on every commit. GitHub's checks for this head were not read before this note.

Checks at `2225869` (and `0deb7b4`, docs only): GitHub's CI gate and the privacy gate passed at `0deb7b4`; locally the full suite, 279 files passed and 7 skipped (2,527 tests passed, 57 skipped), with 3 vitest worker notices and no failure; `tsc` clean. The starter path ran again on the Mac (row 131).

Checks at `4d9cf52`: GitHub's CI gate and the privacy gate passed; locally the full suite, 279 files passed and 7 skipped (2,524 tests passed, 57 skipped), with 3 vitest worker notices that are not test failures; `tsc` and `tsgo` clean. Demonstrated on the operator's Mac (rows 129 and 130).

Checks at `989d7d5`: GitHub's CI gate and the privacy gate passed; locally the full suite, 278 files passed and 7 skipped (2,517 tests passed, 57 skipped), with 4 vitest worker notices that are not test failures; `tsc` and `tsgo` clean. Demonstrated on the operator's Mac in a sandbox (row 128).

Checks at `50b9ca8`: GitHub's CI and both privacy gates passed; locally the full suite, 268 files passed and 7 skipped (2,392 tests), with the same 3 vitest worker RPC timeouts as before the fixes; `tsc` and `tsgo` clean (row 126).

Checks at `b1ede23`: GitHub's CI and both privacy gates passed; locally the full suite three times, 268 files passed and 7 skipped (2,388 tests), each run with 3 vitest worker RPC timeouts that are not test failures (row 125); `tsc` and `tsgo` clean. The workspace ran end to end on the operator's Mac at `b1ede23` (row 125).

Checks at `1bd8f6b`: GitHub's full CI gate passed on PR #94 (the first full run for R1: `tsc`, `tsgo`, vitest except the named known-WIP, `workers/ai-proxy`, the PTY keyboard test); locally, shell suites 111 tests and lane suites 52 tests passed.

Checks at `8db45cd`: full suite 261 files passed, 7 skipped, 0 failed (2,322 tests, with `NODE_PATH` unset); `tsc` and `tsgo` clean. The real workflow ran on the operator's Mac three times (ledger row 119): the last run drew the task in one call for $0.012.

## Who owns what

Work on your own branch from `origin/feat/ui-workflow-r1`. Commit only the files you own; ask under "For the lead" before touching anything else.

| Owner | Branch | Files |
|---|---|---|
| Lead (Opus) | `feat/ui-workflow-r1` | `src/agent/**`, `src/repl/` (main, turn, transcript, agent-bridge, approvals, seal, commands, canvas-view, web), `src/capabilities/**`, `src/studio/` (server, health, config, bridge, document), `src/term/theme.ts`, `src/utils/receipts.ts`, `package.json` and the lock, `DESIGN.md`, `CHANGELOG.md`, `docs/ui-cockpit/CHECKPOINTS.md` |
| Sonnet 5.5 | `r1/ui-sonnet` | `src/theme/**`, `src/term/palettes.ts`, `src/term/theme-files.ts`, `src/term/theme-install.ts`, `assets/themes/**`, `src/repl/demo.ts`, `src/repl/input-view.ts`, `src/repl/center.ts`, `companion/studio-canvas/**` (except the bridge in `src/canvas.js`: `attachEditor`, `restore`, `connectBridge`, `mount`, which the lead keeps since `458a015`), `src/studio/receipt-page.ts`, `scripts/ui/render.ts`, `scripts/ui/themes.ts`, the README section "Timmy Homebrew and the font", and their tests |
| Haiku 5.5 | `r1/tools-haiku` | `docs/ui-cockpit/R1-BRIEF.md` (this file), `docs/TOOLS-SETUP.md` (new), `src/utils/dispatch.ts`, `tests/dispatch-lanes.test.ts` |

Never touch: `studio/` (another hand's lab), `lanes/visual/tokens.json` (the visual law), `docs/ui-cockpit/c15/` to `c19/`, `c18-development/`, `PRIVATE-EVIDENCE.md`, `C16-ACCEPTED.sha256`, `main`, `feat/ui-cockpit`; on the operator's Mac: the global `timmy`, the operator's own checkout and Terminal windows and profiles, and `~/timmy/evidence`.

## Assignments

**Sonnet 5.5: organized UI and the theme** (round 1 done: PR #95, merged as `8db45cd`; branch again from `origin/feat/ui-workflow-r1` for anything next)
1. `timmy repl --demo` says on screen that it is a scripted demonstration: no model, no tool ran.
2. A zellij Timmy Homebrew theme whose selected tab is Homebrew green and passes `tests/ui-zellij-theme.test.ts` (text 7:1, frames 3:1, selected tab 2.5:1 from the others); `timmy center` picks it under `TIMMY_PALETTE=homebrew`.
3. Timmy Canvas's panel and the receipt page use the REPL's words for where to inspect (Canvas, Receipt): each job's revision, receipt and time; readable at phone width; `tests/studio-canvas-browser.test.ts` stays green, and tldraw's chrome, fonts and the drawing's colors stay untouched.
4. `scripts/ui/render.ts` draws review pictures in Monaspace Argon on Timmy Homebrew, so pictures match the terminal profile.
5. Proposal only, no change to the law: what moving the monitor's focus to green would take (`docs/ui-cockpit/B9-MONITOR-PROPOSAL.md`).

**Haiku 5.5: inventory, setup documentation, checks, this brief**
1. Check every setup step `timmy tools` prints (`src/capabilities/index.ts`) against each tool's own documentation: agent-browser, oha, Ollama, Claude Code, Codex, Qwen Code, Trigger.dev, Composio, carbonyl, zellij, the Monaspace cask, and AgentPass and TaskForge's variables. List corrections under "For the lead"; the lead applies them.
2. Lanes honesty: `listLanes()` calls an API lane ready when only `curl` exists, and hyperframes when only `npx` does. Write the failing tests, then fix: a lane that needs a key needs its key set. Never print a key. (`timmy tools` already reads each lane's key from `LANE_RUNNERS` since `13ac799`; when `listLanes()` returns `key`, `src/capabilities/live.ts` uses it, so `/lanes` and `/tools` agree.)
3. `docs/TOOLS-SETUP.md`: each `timmy tools` row, what it needs, the exact setup step, and how to check it. Add the MCP servers in `config/mcporter.json` as a table, with no secrets and no hostnames.
4. Run the named suites, `tsc` and the privacy gate on the workers' branch heads, and record the results here.
5. Keep this file current: branch heads, PR states, CI, what merged, and open items.

**Lead (Opus): core behavior, outcomes and receipts, integration**
- Done: the invented AgentPass signals (`66b6e7c`) and the independent review's findings (`13ac799`).
- Apply Haiku's setup corrections. Review and merge the worker PRs into `feat/ui-workflow-r1`. Keep the ledger.
- Run the real workflow on the Mac (REPL, a canvas job, the receipt, `/tools`, the monitor), with captures, spending at most $0.50 of LIVE-01's remaining authorization.

## How to work

1. `git clone https://github.com/woodman33/timmy-tui && cd timmy-tui && git switch -c <your branch> origin/feat/ui-workflow-r1`
2. Use Node 24 or later. Run `npm ci`, then `git config core.hooksPath .githooks`.
3. Read `AGENTS.md`, `DESIGN.md` §10 (B1 to B9) and this brief.
4. Write tests first. Before each commit, run `npx vitest run <your suites>` and `npx tsc --noEmit -p tsconfig.json`. Stage files by name, never with `-A`.
5. Push your branch and open a draft PR with base `feat/ui-workflow-r1`. Through the REST API: `gh api repos/woodman33/timmy-tui/pulls -f head=<branch> -f base=feat/ui-workflow-r1 -f title=... -f body=... -F draft=true`. Never merge.
6. No paid model calls, no external spend, no new accounts, and nothing installed outside your own clone.
7. Labels stay honest: a key or a program on disk is "installed", never "working". A scripted demonstration says that it is scripted.

## Decisions so far

- Green is interaction (prompt, selection, primary action), not proof. Every outcome keeps its words (B9).
- The font is `@fontsource/monaspace-argon` 5.3.0 (OFL-1.1, with the Reserved Font Name "Monaspace"). Timmy serves it unmodified from 127.0.0.1, and it is never copied into the repository. Terminals get the font through a profile or printed lines, because a terminal draws in its own font.
- The monitor keeps the visual law's bindings this round. It picks up Timmy Homebrew's colors through the palette.
- The workspace command still runs on this machine when no Daytona key is set, and asks every time (its box has no "allow for session"; nor does `get_env`'s). When Daytona fails, nothing runs locally; when the connection broke after sending, the outcome is unknown and the tool says so.

## Open items and blockers

- Blocked on the operator after round R4, each with the exact action:
  - Cinema 4D: in Terminal, run `"/Applications/Maxon Cinema 4D 2026/c4dpy.app/Contents/MacOS/c4dpy"` once and answer "Enter the license method" with your licence's method (details below, row 137).
  - Houdini: a licence from the Houdini Launcher (`hython`: "No licenses could be found"; row 139).
  - Spline: the MCP route works (rows 149 and 151); open a document in the Spline editor and enable its AI bridge.
  - CadQuery on the Windows PCs: every Windows node on the operator's network is offline; wake the 4090 desktop and the 5090 laptop and say which node is which; then the plan's step 1 (route, hardware, Python) can run read-only.
  - Roboflow: `ROBOFLOW_API_KEY`. TaskForge: `TASKFORGE_API_URL`. AgentPass: `AGENTPASS_REPO_PATH`.
  - `@opentui/core`: 0.5.17 declares node >= 26.4, so npm warns EBADENGINE on Node 24 (row 151; `package.json` asks `^0.5.10`, and the lockfile has 0.5.10): pin it, or change the engines field.
- Open after round R4:
  - The drop processor starts no tool yet: `timmy drop` files each file in its lane and says what its tool needs (row 151); starting a tool needs the operator's decision on approvals.
  - The recipe's formal qualification (`lanes/recipes/qualify.ts`, under AGENTS.md §5) stays a separately authorized gate; R4's recipe runs (rows 146, 148 and 151) are development, not qualification.
  - r17 (row 153) has not run: a Mac run of `/iterate ae` and the batch-4 checks. Until then these stay undemonstrated: `/iterate ae`; aerender's "instead" rule; the After Effects harness's new fields; flow cards for malformed records; `/mcp`'s raw line; the packed-install probe for this round's starters and workers.
  - Found while updating the checklist (reading the code at `10faca5`; nothing run): `/iterate ae` judges its agent by `/agent`'s own snapshot (`src/repl/iterate-ae.ts` starts the agent without `judge`), so R4-2's whole-project check does not cover it; and recovery does not yet look at the job of its render step (a TODO in `src/repl/recover.ts`).
- Done: the Mac run and captures (ledger row 119); the monitor's `model.policy` seal on open and its header model (fixed in `1bd8f6b`).
- Haiku's assignments, finished by the lead: item 2 (lanes) is in `1bd8f6b`; item 4's CI is green. Item 1 was checked by an internal helper against each tool's own docs from a clean clone at `4a1aec8`: the steps for agent-browser, Ollama, Claude Code, Codex and Qwen Code need correcting and carbonyl has none. Done: those corrections and item 3 (`docs/TOOLS-SETUP.md`) came in `0c58025` and `c00374b` (row 122).
- Composio: the tool calls a Composio API version that Composio has removed, so a set key shows "installed" while every call fails. A defect, open; its fix is a separate decision.
- `timmy tools` does not load the working folder's `.env`, while the REPL's `/tools` does, so a key kept only in `.env` reads differently in the two (found by reading the imports, not yet run).
- Signatures: GitHub reports `unknown_key` for `8db45cd`, `4a1aec8` and `1bd8f6b` (ledger row 121). The commits stay as pushed, by the owner's instruction.
- The jobs ledger records a call only once the canvas has been saved, so a call that fails before the first save is not counted in a job's failed calls.
- AgentPass and TaskForge: their services live outside this repository, and `timmy tools` shows them as needs setup. The spatial roadmap stays in its own records (COMMAND-CENTER-PLAN's next milestone and the private register). Neither is part of R1.
- Workspace (R1, 2026-10-08): what is connected and what is not, with the next bounded pass, is in COMMAND-CENTER-PLAN's "Workspace connections" section. Receipts sealed before `project_id` existed are not shown in `/results`.
- In a workspace with `NODE_PATH` set, `tests/recipe-package` and `tests/inspect-package` resolve `tsx` globally and fail. Run the suite with `env -u NODE_PATH`.
- Workspace (R2, 2026-10-09): each area's state (demonstrated, implemented, configured, planned) and the next bounded stage are in COMMAND-CENTER-PLAN's "Workspace connections (R2)" section.
- Done in R3 (`1c4c7cd`, `ea5ef4d`): the npm package's `files` list carries the starters and the Look, Cinema 4D and Blender workers, and an installed Timmy finds them from its own package root (row 132). Done in R4: the After Effects, OpenSCAD and FreeCAD starters and workers and the readback workers are in `files` too (`3942c31`, `32c6d7c`, `0bb1e1b`); the packed-install check passed 13 of 13 at `b8f9407` (row 151), and 20 of 20 at `10faca5` (row 153), whose probe since `8cd487d` also finds this round's starters and workers inside the installed package (not yet `workers/readback/video_readback.py`). Publishing stays on HOLD.
- Waiting on the operator: `c4dpy` asks its own question, "Enter the license method: 1) Maxon App 2) Maxon Account 3) Maxon License Server 4) RLM Q) Quit", also while the Cinema 4D app is open (row 137). Run `c4dpy` once in Terminal as your user and answer it with the method your licence uses; Timmy will not answer it. A real `/c4d` run, and the starter's first real scene, wait on that.
- On the Mac, idle Timmy processes from C-17 and C-18 (`studio`, `watch`, `receipts --follow`, a headless Chrome; started 2026-10-07 and 08) still run under those checkpoints' temp folders. R2 did not start them and left them alone; stopping them is the operator's call.
- Blocked on a licence (row 139): Houdini 22.0.429's `hython` says "No licenses could be found to run this application"; a Houdini route needs a licence from the Houdini Launcher first.
- Found in R3 on the Mac (row 137), open: Qwen Code's installed package is 0.22.2, and `qwen --version` prints 0.25.0 only with the operator's own HOME (a newer copy kept there), so an agent run with its own HOME (`TIMMY_AGENT_HOME`) runs 0.22.2 (Timmy reports that number; R4's runs used it again, row 146); in `--bare` mode Qwen Code has no write_file tool and declines shell commands, so a local model creates files with `edit` (2 denied calls in that run). The `/tools` row of the CadQuery recipe reads `.timmy/recipe-jobs` of the active project only, so its "used" date shows in the project that ran it.
- Done, from the independent review of `ee70b9e` (row 141): the "(measured)" wording in the qualified heading (`cbb09ca`, row 144); in R4's first batch (row 145), the live-board token kept off a carbonyl process's arguments (`c1fad4f`, M4), responses without ids counted once (`79c3193`, M8), and recipe result files no longer read again after their verification (`d56e139`, M3).
- An interpretation sealed before `c70e3e9` shows $0.0000 on the board and in Results, which means unknown, not free. (The board drew a model's Markdown marks as text until the commit after `4d9cf52`.)

## For the lead

(Workers: add a dated line here, or in your PR description.)
