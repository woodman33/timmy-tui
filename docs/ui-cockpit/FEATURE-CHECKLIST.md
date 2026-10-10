# Timmy feature checklist

Date: 2026-10-09. Drafted at `bbe4930` (ledger rows 1 to 131); updated by the lead after the round R3 merges
(`ad80912`) and the Mac demonstrations in ledger rows 132 to 138. A row changed in that update cites R3 rows.

One row per user-facing feature or integration. **Planned**: a plan or backlog document in this repository
describes it (cited; – means none was found). **Implemented**: code for it exists at `bbe4930` (file cited).
**Tested**: automated tests exercise it (test file cited); "fakes" names the stand-ins those tests use, such as
the stand-in `bpy`, the fake Blender, `c4dpy` or `aerender`, the offline fake executor, the test-double upmd or
Python, or a mock model client. **Demonstrated**: shown running for real on the operator's Mac, or in CI with
the real dependency, as recorded in a ledger row, cited with the revision that row names; scripted steps are
labelled scripted. **Blocker / user action**: what a person must do before it can run (credentials, a
licence, a file). Marks: ✓ yes, – no, partial, unknown (no file, test or ledger row settles it), . The four
features built in parallel in round R3 (`/recipe`, `/board live`, `/agent`, `/observe --qualify`) are at `ad80912`.

An installed executable, fixture demonstration or green CI run alone does not prove a complete integration.

Merge, npm publish, tags and deployment are on HOLD. Shorthand: "row N" is a row of `CHECKPOINTS.md`;
"CCP" is `docs/ui-cockpit/COMMAND-CENTER-PLAN.md` (F-0 to F-8 are its orders, "R1 n" an item of its R1
"Still to connect" list, "R2 area n" a row of its R2 table, "milestone" its next product milestone).

## 1. Workspace and projects

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| `/project` (switch, `list`, `new`) | ✓ CCP R1 | ✓ | ✓ | ✓ rows 124 (`c747545`), 125 (`b1ede23`) | – | `src/project/index.ts`, `src/repl/workspace.ts`; `tests/repl-workspace.test.ts` |
| Starter `web-starter` (`/project new <name> --from web-starter`) | ✓ CCP R2 area 1 | ✓ | ✓ | ✓ rows 130 (`4d9cf52`), 131 (`0deb7b4`) | – | `src/project/starters.ts`, `templates/web-starter/`; `tests/project-starters.test.ts` |
| Starter `c4d-starter` | ✓ CCP R2 area 6 | ✓ | ✓ fakes (stand-in `c4d` module) | – (rows 128 and 137: both runs stopped at `c4dpy`'s licence question) | the Cinema 4D licence (section 5) | `templates/c4d-starter/`; `tests/native-python.test.ts` (`tests/fixtures/c4d-stub`) |
| Starter `blender-starter` | ✓ CCP milestone | ✓ | ✓ fakes (stand-in `bpy`, fake Blender) | ✓ row 133 (`ea5ef4d`, Blender 5.2.2 LTS; an independent readback of the `.blend`); the object-list fix (row 134) ran only on the stand-in | Blender installed, or `TIMMY_BLENDER` set | `templates/blender-starter/`; `tests/native-blender.test.ts`, `tests/fixtures/blender-stub/` |
| Starter `ae-starter` (`author.jsx`: a 1920x1080 30 fps comp, a solid, a text layer, a layer with two Position keyframes; `edit.jsx`: changes the text, adds a layer) | – (round R4 order H23) | ✓ (`64a25ed`) | ✓ fakes (both scripts run on the fake After Effects' stand-in objects) | – (no After Effects run) | After Effects (section 5); not yet listed in `package.json` "files", so an installed Timmy does not carry it | `templates/ae-starter/`, `src/project/starters.ts`; `tests/native-ae-author.test.ts`, `tests/project-starters.test.ts` |
| `/files` by role | ✓ CCP R1 | ✓ | ✓ | ✓ rows 124, 125, 130 | – | `src/project/index.ts`; `tests/project-files.test.ts`, `tests/repl-workspace.test.ts` |
| `/open <file>` (private files refused, by name and by link target) | ✓ CCP R1 | ✓ | ✓ | ✓ rows 124, 125 (a link to `.env` refused), 129, 130 | – | `src/project/index.ts`, `src/repl/workspace.ts`; `tests/project-files.test.ts`, `tests/repl-workspace.test.ts` |
| `/edit <file>` (your editor; sealed with hashes before and after) | ✓ CCP R1 | ✓ | ✓ | – (no ledger row runs `/edit`) | – | `src/repl/workspace.ts`; `tests/repl-workspace.test.ts` |
| `/add <file…>` into `refs/` | ✓ CCP R1 2 | ✓ | ✓ | ✓ row 128 (an image) | – | `src/project/intake.ts`; `tests/intake.test.ts`, `tests/repl-workspace-look.test.ts` |
| File kinds by bytes or name (images, documents, video, 3D; `.blend`, `.c4d`, `.hip`, `.step`, `.3mf` since `bbe4930`) | ✓ CCP R2 area 4 | ✓ | ✓ | – (CCP R2 area 4: implemented, not demonstrated) | – | `src/project/intake.ts`; `tests/intake.test.ts` |
| Agent project tools (`list_project_files`, `read_project_file`, `write_project_file` asks first) | ✓ CCP R1 | ✓ | ✓ | ✓ rows 124, 125 (one paid turn each; starting files by a labelled setup script) | a model key | `src/agent/project-tools.ts`; `tests/project-tools.test.ts` |
| `timmy drop` (files and folders; `--lane`, `--list [project]`, `--json`) | ✓ CCP R1 2 | ✓ `944dfa9` (R4 H19; before it, the wrong argument and no processor call, rows 122 and CCP R2 area 4): each file copied into its lane's folder, never moved, and handed to the processor the watched drop folder also uses (drop.intake, the rule, a board, drop.result), with a per-file result; missing, unreadable, unknown, two-lane (until `--lane`), link-outside-the-project, private and hidden files refused with nothing sealed. No rule starts its tool, so no job is started and each result says what the tool needs; nothing starts the folder watcher | ✓ the real CLI spawned in a temporary project, HOME and store (the unreadable file under `setpriv` when run as root); the watched folder with a real two-part write | – | – | `src/drop/cli.ts`, `src/drop/index.ts`, `src/cli.ts`; `tests/drop-cli.test.ts`, `tests/drop.test.ts` |

## 2. Jobs and lifecycle

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| `/jobs`, `/jobs <id>` | ✓ CCP R1 | ✓ | ✓ | ✓ rows 124, 125, 129 | – | `src/jobs/index.ts`, `src/repl/workspace.ts`; `tests/jobs.test.ts`, `tests/repl-workspace.test.ts` |
| `/stop <id>`, `/stop all` (this REPL's jobs, each with its process group) | ✓ CCP R1 | ✓ | ✓ | ✓ rows 124 (`c747545`), 125 (`b1ede23`), 129 (`0ca1b06`), 130 (`4d9cf52`) | – | same files; a process that detaches itself (setsid) leaves the group and is not tracked (row 126) |
| Stop escalation SIGTERM → SIGKILL | – | ✓ jobs since `92d07ba` (R1); spawn runtime and agent-run cancel since `7116a9b` (R3) | ✓ real processes that ignore SIGTERM | – (no ledger row) | – | `src/jobs/index.ts`, `src/runtime/spawn-runtime.ts`; `tests/jobs.test.ts`, `tests/spawn-escalation.test.ts`, `tests/command-output-limit.test.ts` |
| Time limits (job `timeoutMs`; server ready wait, 30 s for `/preview`; workspace command 120 s; MCP calls; native jobs) | – | ✓ | ✓ | – (CCP R2 area 1: the workspace command's limit is not demonstrated) | – | `src/jobs/index.ts`, `src/agent/command-output.ts`, `src/connectors/mcp-cli.ts`, `src/native/index.ts`; `tests/jobs.test.ts`, `tests/command-output-limit.test.ts`, `tests/mcp-cli.test.ts`, `tests/native.test.ts` |
| A job stops when its program waits for a person (`stopWhen`) | – | ✓ (`b28901e`) | ✓ | ✓ row 128 (`c4dpy`'s licence question ended the job at once) | – | `src/jobs/index.ts`, `src/native/index.ts`; `tests/native.test.ts` |
| Recovery after a restart | ✓ AGENTS.md §8 (durable jobs) | partial: a later session lists persisted job records and marks dead ones stale, with no re-attach or resume; recipe jobs have `recover()` | ✓ (recipe: fakes, offline fake executor) | – | – | `src/jobs/index.ts`, `lanes/recipes/jobs.ts`; `tests/jobs.test.ts`, `tests/recipe-jobs.test.ts` |
| Job receipts (one seal per job; `project_id`, no paths) | ✓ CCP R1 | ✓ | ✓ | ✓ rows 124, 125 (four receipts, one `project_id`, no path), 129, 130 | – | `src/jobs/index.ts`, `src/utils/receipts.ts`; `tests/jobs.test.ts`, `tests/repl-workspace.test.ts` |
| `/results` (jobs, outputs and changed files, linked to receipts) | ✓ CCP R1 | ✓ | ✓ | ✓ rows 124, 125 | – | `src/repl/workspace.ts`; `tests/repl-workspace.test.ts` |
| Command output limit (first 4 KB and last 12 KB; the rest in `.timmy/runs/`) | – | ✓ (`12eb92f`) | ✓ | ✓ row 128 (a 1,988,895-byte output) | – | `src/agent/command-output.ts`; `tests/command-output-limit.test.ts` |

## 3. Workflows

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| `/workflows` (upmd documents and their blocks) | ✓ CCP F-3 | ✓ | ✓ fakes (test-double upmd) | unknown (CCP R1 says exercised at `c747545`; rows 124 and 125 name only `/run`) | install upmd: `brew install rezigned/tap/upmd` | `src/workflows/upmd.ts`; `tests/workflows-upmd.test.ts`, `tests/fixtures/fake-upmd.mjs` |
| `/run <file> <block>` through upmd (prediction sealed first, outcome after) | ✓ CCP F-3 | ✓ | ✓ fakes (test-double upmd) | ✓ rows 124 (`c747545`), 125 (`b1ede23`), 130 (`4d9cf52`), 131 (`0deb7b4`) | upmd installed | same; `tests/repl-workspace.test.ts` |
| One receipt per block, NEEDS YOU before a risky block, `timmy md` | ✓ CCP F-3, R1 5 | – | – | – | – | CCP R1 item 5 |

## 4. Previews and web views

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| `/preview` of a built folder (`dist/`, `build/`, `out/`) | ✓ CCP R1 | ✓ | ✓ | ✓ rows 124, 125, 130 | – | `src/preview/static-server.ts`, `src/repl/workspace.ts`; `tests/preview-static-server.test.ts`, `tests/repl-workspace.test.ts` |
| `/preview` of a dev script (`dev`, `start` or `preview`, with `PORT`) | ✓ CCP R2 area 1 | ✓ (`0ca1b06`) | ✓ | ✓ rows 129 (`0ca1b06`), 130 (`4d9cf52`), 131 (`0deb7b4`) | – | same; `templates/web-starter/server.mjs` |
| A Vite dev script (`--port`, `--host 127.0.0.1`, `--strictPort`) | – | ✓ (`2225869`) | ✓ the repository's own Vite (row 131) | – (rows 129 to 131 ran Node servers, not Vite) | – | `src/repl/workspace.ts`; `tests/repl-workspace.test.ts` |
| `/preview <command> --url` | ✓ CCP R2 area 1 | ✓ | partial: a failure path | – (CCP R2 area 1) | – | `src/repl/workspace.ts`; `tests/repl-workspace.test.ts` |
| `/web` (`map`, `studio`, a receipt, a local URL; `--allow-remote`) | ✓ CCP F-4 (the C-13 web views) | ✓ | ✓ | partial: a local page on the Mac (row 56, `edf2d32`); no Mac row for `map`, `studio` or a receipt | – | `src/repl/web.ts`; `tests/repl-web.test.ts` |
| `/browser` (runs `/web`) | – | ✓ | – (no test names `/browser`) | – | – | `src/repl/commands.ts` |
| carbonyl in a zellij floating pane or a tmux popup | ✓ CCP R1 7 | ✓ | ✓ | ✓ row 56 (tmux 3.6b popup and zellij 0.44.3 pane, `edf2d32`); links only from a REPL started with a cleared environment (row 128) | install carbonyl; run Timmy inside zellij or tmux | `src/repl/web.ts`; `tests/repl-web.test.ts` |
| Timmy Canvas (`/canvas`, `/canvas open`, its health route) | ✓ CCP F-4 | ✓ | ✓ incl. a real-browser test | ✓ row 119 (`5c2fc32`, `458a015`, `af536cb`; the page in a headless Chrome on the Mac) | `npm run build:canvas` when the page is not built | `src/repl/canvas-view.ts`, `src/studio/`, `companion/studio-canvas/`; `tests/repl-canvas-view.test.ts`, `tests/studio-health.test.ts`, `tests/studio-canvas-browser.test.ts` |

## 5. Native apps

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| Cinema 4D: `/c4d <script.py>` through `c4dpy`, judged by its result file, run token and sha256s | ✓ CCP R2 area 6 | ✓ | ✓ fakes (fake `c4dpy`, stand-in `c4d`) | partial: rows 128 and 137 show only the stop at `c4dpy`'s licence question (row 137 with the Cinema 4D app open); no real scene run | **blocked:** in Terminal, run `c4dpy` once as your user (`"/Applications/Maxon Cinema 4D 2026/c4dpy.app/Contents/MacOS/c4dpy"`) and answer its question "Enter the license method" (1 Maxon App, 2 Maxon Account, 3 Maxon License Server, 4 RLM) with the method your licence uses; opening the Cinema 4D app does not answer it | `src/native/index.ts`, `workers/c4d/timmy_c4d.py`; `tests/native.test.ts`, `tests/native-provenance.test.ts`, `tests/fixtures/fake-c4dpy.mjs` |
| After Effects: `/ae <aep> <comp> <out>` through `aerender` | ✓ CCP R2 area 6 | ✓ | ✓ fakes (fake `aerender`) | – (row 128: no `.aep`) | provide an After Effects project (`.aep`), or make one with `/ae author` (next row) | `src/native/index.ts`; `tests/native.test.ts`, `tests/native-provenance.test.ts`, `tests/fixtures/fake-aerender.mjs` |
| After Effects authoring and editing: `/ae author <script.jsx> [--name <project>]`, `/ae edit <aep> <script.jsx>`, run inside the application (`osascript` `DoScriptFile` on macOS, `AfterFX -r` elsewhere; its window opens) through a per-run harness (read-only, sha256 recorded); judged by the harness's result file, the new version `out/ae/<name>-v<N>.aep` created by the run (its sha256 computed by Timmy), the harness unchanged and the project given to `edit` byte for byte unchanged; a project open with unsaved changes stops the run; the write setting named exactly when After Effects reports it off | – (round R4 order H23; no plan document in this repository names it) | ✓ (`64a25ed`) | ✓ fakes (fake After Effects: the generated harness and the starter scripts run on a stand-in of its scripting objects; FAKE projects) | – (no After Effects run) | After Effects installed, or `TIMMY_AFTERFX` set to its `.app` or `AfterFX.exe`; its "Allow Scripts to Write Files and Access Network" setting on (Settings > Scripting & Expressions; Timmy never changes it); on macOS, allow the terminal to control After Effects (Automation); save or close any project open with unsaved changes. Windows `-r` route not exercised | `src/native/ae-author.ts`, `src/native/index.ts`, `src/repl/workspace.ts`; `tests/native-ae-author.test.ts`, `tests/fixtures/fake-afterfx.mjs` |
| `/ae inspect <aep>`: After Effects reads a project back into the run's result (comps, layers, keyframe counts, text), closing it unsaved; the same application reading its own file, not an independent reader | – (round R4 order H23) | ✓ (`64a25ed`) | ✓ fakes (fake After Effects) | – | as the row above | `src/native/ae-author.ts`; `tests/native-ae-author.test.ts` |
| Blender: `/blender <script.py>`, Blender's own Python, headless | ✓ CCP milestone | ✓ (`3565d96`, `ea5ef4d`) | ✓ fakes (fake Blender, stand-in `bpy`) | ✓ row 133 (`ea5ef4d`) | Blender installed, or `TIMMY_BLENDER` set to its program | `src/native/index.ts`, `src/repl/workspace.ts`, `workers/blender/timmy_blender.py`; `tests/native-blender.test.ts`, `tests/fixtures/fake-blender.mjs` |
| `run_native` agent tool (asks each time); app `afterfx` with `mode` author, edit or inspect since `64a25ed` | ✓ CCP R2 area 6 | ✓ | ✓ fakes | – | a model key, and the app | `src/agent/native-tools.ts`; `tests/native.test.ts`, `tests/native-blender.test.ts`, `tests/native-ae-author.test.ts` |
| Native runs recorded per app; `/tools` "exercised" from each app's own judged runs (After Effects scripting, `afterfx`, is its own row: "implemented; not run" until a sealed run of its own) | – | ✓ (`ea5ef4d`; `afterfx` `64a25ed`) | ✓ | – | – | `src/native/index.ts`, `src/capabilities/index.ts`; `tests/native-provenance.test.ts`, `tests/capabilities.test.ts`, `tests/native-ae-author.test.ts` |
| CadQuery recipe `enclosure.tray/1`: CLI `timmy recipe` (`list`, `plan`, `build`, `jobs`) | ✓ CCP F-7 | ✓ | ✓ fakes (offline fake executor); admission and package checks | partial: its job system ran for real through `/recipe` (rows 136, 138); the CLI itself was not run | set `TIMMY_CADQUERY_PYTHON` to a Python with CadQuery and Open3D (nothing is installed for you) | `lanes/recipes/cli.ts`, `lanes/recipes/tray.ts`, `lanes/recipes/jobs.ts` (route in `src/cli.ts`); `tests/tray-recipe.test.ts`, `tests/recipe-jobs.test.ts`, `tests/recipe-package.test.ts` |
| `/recipe` in the REPL as a durable job (prediction sealed first, watcher job, `/stop` and `/recipe cancel` through the recipe's cancel, verified exports copied, `run_recipe`, `/tools` row) | ✓ CCP F-7 | ✓ (`720cc37`) | ✓ fakes (offline fake executor) | ✓ rows 136 (a real CadQuery and Open3D build, 30 of 30 checks, an independent readback of the STEP and STLs), 138 (cancelled from the live board) | set `TIMMY_CADQUERY_PYTHON` to a Python with CadQuery and Open3D | `src/recipes/`, `src/repl/recipe.ts`, `src/agent/recipe-tools.ts`; `tests/recipe-repl.test.ts` |
| `/iterate tray "<instruction>"` (round R4): a local code agent changes only `recipes/tray.params.json` (Qwen Code on a local endpoint; `--paid` and paid agents refused), the recipe rebuilds as a durable job, a separate worker (`workers/readback/step_readback.py`, OCP's STEP reader in its own process) reads the delivered STEP back and compares it with the sealed prediction; a flow record (`results/flows/`) and a `flow` receipt; `/stop <flow-id>`; the board's Flows cards; `iterate_recipe` (asks each time) | – (the round R4 order; no plan document in this repository) | ✓ (`d3b1af2`, `dc71f4d`, `d8fba24`) | ✓ fakes (a fake agent, the offline fake executor, a fake readback worker); the real readback worker's failure paths run with `python3`; its real measurement only with a CadQuery Python (skipped where there is none) | – | `TIMMY_AGENT_MODEL` (a model the local endpoint serves, or `--model`) and `TIMMY_CADQUERY_PYTHON` (a Python with CadQuery and Open3D); the npm package does not list the readback worker yet (`package.json` `files`) | `src/flows/iterate.ts`, `src/repl/iterate.ts`, `src/repl/board-flows.ts`, `src/agent/iterate-tools.ts`, `workers/readback/step_readback.py`; `tests/iterate.test.ts` |

## 6. Vision

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| Look worker: OpenCV measurements labelled deterministic computation (`/observe <image>`, `observe_image`) | ✓ CCP R1 3 | ✓ | ✓ mostly fakes (test-double Python); one test runs the real worker only where `python3` is present | ✓ row 128 (QR text, ArUco marker 7, 600 × 400) | Python with OpenCV; `TIMMY_NATIVE_HOME` in a sandbox | `workers/look/look.py`, `src/vision/look.ts`; `tests/look.test.ts`, `tests/repl-workspace-look.test.ts` |
| A model's interpretation as a separate, labelled claim (`/observe <image> <question>`, `describe_image`) | ✓ CCP R1 3 | ✓ | ✓ fakes (mocked fetch) | ✓ row 128 (`anthropic/claude-haiku-4.5`; its claim kept beside the measurements) | a model key; an image-capable model | `src/vision/route.ts`, `src/agent/vision-tools.ts`; `tests/vision-route.test.ts` |
| A text-only model refused, with image-capable alternatives | ✓ CCP R1 3 | ✓ | ✓ fakes (mocked fetch) | – (CCP R2 area 5) | – | `src/vision/route.ts`; `tests/vision-route.test.ts` |
| Cost accounting (the provider's charge on a provider key; unknown when missing; a cancelled paid interpretation keeps its cost) | ✓ CCP R2 area 5 | ✓ (`c70e3e9`, `7116a9b`) | ✓ fakes (mocked fetch) | partial: row 128 found the $0 defect; no row shows the fixed accounting | – | `src/vision/route.ts`; `tests/vision-route.test.ts`, `tests/repl-workspace-look.test.ts` |
| Evidence protocol: observed handles, `cite(handle_id)`, admission | ✓ AGENTS.md §4 | ✓ called by `/observe --qualify` (`ad80912`) | ✓ fakes (mock model client; the SDK's own loop against a local fake server) | – | – | `src/vision/evidence.ts`, `src/evidence/admission.ts`; `tests/vision-evidence.test.ts`, `tests/evidence-admission.test.ts` |
| Observation check: only sealed, unchanged deterministic values shown as measured | ✓ AGENTS.md §4 | ✓ (`afc3141`) | ✓ | – | – | `src/evidence/observation-check.ts`, `src/repl/board.ts`; `tests/observation-check.test.ts`, `tests/board.test.ts` |
| `/observe <image> --qualify [question]`: an answer admitted only when it cites this run's measurements | ✓ AGENTS.md §4 | ✓ (`ad80912`) | ✓ fakes (fake model clients; the SDK against a local fake server) | ✓ row 139 (one real call: `anthropic/claude-haiku-4.5` answered citing `qr_codes_decoded` and `aruco_markers`, admitted, $0.007897 as reported) | a model key; each call is paid | `src/vision/qualify-route.ts`, `src/repl/workspace.ts`, `src/evidence/observation-check.ts`; `tests/observe-qualify.test.ts`, `tests/observe-qualify-sdk.test.ts` |

## 7. Board and Canvas cards

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| `/board` snapshot: a read-only HTML board of references, workflow blocks, jobs, outputs and observations | ✓ CCP R2 area 2 | ✓ | ✓ (one real-Look test runs only where Python is present) | ✓ rows 128, 130 (`4d9cf52`), 131 (`0deb7b4`) | – | `src/repl/board.ts`; `tests/board.test.ts` |
| `/board live`: the board on 127.0.0.1 with Stop, Run and Observe (`/board off`) | ✓ CCP R1 4, R2 area 2 | ✓ (`6b370f4`) | ✓ (19 tests on 127.0.0.1; 3 in a real headless Chromium) | ✓ rows 137 (the page drawn, no console messages, the port closed after `/board off`), 138 (Stop pressed on a running recipe job), 141 (Observe pressed) | – | `src/repl/board-live.ts`; `tests/board-live.test.ts`, `tests/board-live-browser.test.ts` |
| Board parameter card: the tray recipe's `recipes/tray.params.json` (or the recipe's defaults) with units, meanings and ranges, read-only on the snapshot; on `/board live` a form saved through the edit `set-params` (checked by `writeParams`, a stale file refused, the previous file kept, an edit receipt) and Rebuild (the typed `/recipe tray`, from the saved file) | ✓ CCP R1 4 | ✓ (`52e63d6`, branch `r4/board-nodes`) | ✓ (HTTP to the live board on 127.0.0.1 and a real headless Chromium; the Rebuild round trip with a FAKE recipe executor) | – | – | `src/repl/board-cards.ts`, `src/repl/board-edits.ts`, `src/repl/board-live.ts`; `tests/board-cards.test.ts`, `tests/board-edits.test.ts`, `tests/board-nodes-browser.test.ts` |
| Workflow cards as node graphs (named blocks as nodes, needs as edges; read-only on the snapshot) and node editing on `/board live`: add, remove, rename, reorder, a command, a language, a need; the edit `save-workflow` checks the document's place (on the board, inside the project, no link), its sha256, names, needs and loops; prose kept; the previous version kept in `.timmy/workflow-history/`; an edit receipt | ✓ CCP R1 4, R2 area 2 ("a workflow node view"), R3 Board ("a workflow node editor") | ✓ (`52e63d6`, branch `r4/board-nodes`) | ✓ (the rewrite read back with `parseWorkflow`; each refusal over HTTP; a real headless Chromium; Run uses the test-double upmd) | – | – | `src/repl/board-nodes.ts`, `src/repl/board-edits.ts`; `tests/board-nodes.test.ts`, `tests/board-edits.test.ts`, `tests/board-nodes-browser.test.ts` |
| Result cards: one shape for recipe jobs, observations, native runs, code-agent runs and finished jobs (status in words, files, receipts; a recipe's values shown as measured on the generated CAD only when its signed result and every copied export verify now, with DOCTRINE §15); `renderResultCards` takes cards built elsewhere (the `/iterate` flows) | ✓ CCP R1 4 | ✓ (`52e63d6`, branch `r4/board-nodes`) | ✓ fakes (hand-written native and agent run records; a FAKE recipe executor) | – | – | `src/repl/board-cards.ts`; `tests/board-cards.test.ts`, `tests/board-edits.test.ts` |
| Canvas workflow, parameter and result cards (on Timmy Canvas, tldraw) | ✓ CCP R1 4 | – (the cards above are on the board, not on the Canvas) | – | – | – | CCP R1 item 4 |

## 8. MCP

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| Two MCP-to-CLI routes: MCPorter's CLI and Timmy's own CLI on the MCP SDK | ✓ CCP F-5 | ✓ | ✓ against a fixture server | ✓ row 128 (echo through MCPorter, `add` 2 + 3 = 5 through the SDK CLI; the test server only) | – | `src/connectors/mcp-cli.ts`, `src/connectors/mcp-sdk-cli.ts`; `tests/mcp-cli.test.ts`, `tests/fixtures/mcp-echo-server.mjs`. Both routes share the SDK library underneath; cmcp is not a route (row 127) |
| `/mcp servers`: the configured servers by name (MCPorter's config and editor imports; no OAuth; `TIMMY_MCP_HOME` for a sandboxed Timmy) | ✓ CCP R2 area 3 | ✓ (`fbec649`, `4234832`) | ✓ fakes (stand-in configs and servers) | ✓ row 140 (the operator's 46 configured servers listed by name, none contacted) | – | `src/connectors/mcp-cli.ts`; `tests/mcp-servers.test.ts` |
| `/mcp servers --check` (contacts each server once; never signs in) | ✓ CCP F-5 | ✓ | ✓ fakes (local stand-in servers) | – | a server that answers "needs authorization" must be signed in outside Timmy | `src/connectors/mcp-cli.ts`; `tests/mcp-servers.test.ts` |
| `/mcp tools`, `/mcp call` | ✓ CCP F-5 | ✓ | ✓ against a fixture server | partial: row 128 (`/mcp call`, the test server only) | – | `src/connectors/mcp-cli.ts`; `tests/mcp-cli.test.ts` |
| Agent MCP tools (`list_mcp_tools`; `list_mcp_command_tools` and `call_mcp_tool` ask each time) | ✓ CCP R2 area 3 | ✓ | ✓ | – (CCP R2 area 3) | a model key | `src/agent/mcp-tools.ts`; `tests/mcp-cli.test.ts`, `tests/mcp-servers.test.ts` |

## 9. Code agents

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| Harness rows in `/tools` (Claude Code, Codex, Qwen Code, OpenCode: installed or needs setup; exercised only by that agent's own completed run) | ✓ CCP F-1 | ✓ | ✓ | ✓ row 137 (Qwen Code "used 2026-10-09" after its run; the others never launched) | install each one (`/tools` prints the step) | `src/capabilities/index.ts`; `tests/capabilities.test.ts` |
| Launch a code agent from the REPL (`/agent`): Qwen Code on a local endpoint free; Claude Code, Codex, OpenCode only with `--paid` | ✓ CCP F-1, R1 6 | ✓ (`3413cd6`) | ✓ fakes (a fake agent); one test ran the real Qwen Code 0.25.0 against a local fake model server | partial: row 137 (Qwen Code with a local Ollama model made two files; the paid agents refused without `--paid`); Claude Code, Codex and OpenCode not run (they cost money) | `TIMMY_AGENT_MODEL` (a model the local endpoint serves); `--paid` and your own account for the others | `src/code-agents/index.ts`; `tests/code-agent.test.ts` |

## 10. Capabilities (`/tools`)

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| `/tools` and `timmy tools`: one row per surface, model, agent tool, other agent and adapter, from free live checks, with the setup step | ✓ CCP F-0 | ✓ | ✓ | ✓ rows 119 (`5c2fc32`), 128 | – | `src/capabilities/index.ts`, `src/capabilities/live.ts`, `src/capabilities/render.ts`, `src/capabilities/cli.ts`; `tests/capabilities.test.ts` |
| The rungs as built: `reachable`, `installed`, `needs setup`, `not built`; "used <date>" (exercised) beside the rung, never raising it | ✓ CCP F-0 | ✓ | ✓ | ✓ row 128 (`c4dpy` and `aerender` found; AgentPass and TaskForge `needs setup`) | – | `src/capabilities/index.ts`; `tests/capabilities.test.ts` |
| The plan's ladder: proposed, installed, reachable, exercised, qualified | ✓ CCP rule 1 | partial: proposed reads `not built`; exercised is a note, not a rung; no rung or field for qualified | partial: no qualified rung to test | – | – | CCP "Rules every feature follows" 1; `src/capabilities/index.ts` |

## 11. Packaging

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| Starters and the Look, Cinema 4D and Blender workers in the npm package | ✓ R1-BRIEF open items (row 131) | ✓ (`1c4c7cd`, `ea5ef4d`) | ✓ | – (rows 83 and 84 packed the rc.2 candidate, before these files shipped) | – | `package.json` (`files`); `tests/asset-package.test.ts` |
| Runtime asset lookup (checkout, TypeScript build, bundled CLI; never a link or a path outside the package) | ✓ R1-BRIEF open items | ✓ (`1c4c7cd`) | ✓ (a simulated file system and packed layouts) | – | – | `src/utils/asset-dirs.ts`; `tests/asset-dirs.test.ts`, `tests/asset-package.test.ts` |
| The recipe runtime in the package | – | ✓ | ✓ (fails closed without `TIMMY_CADQUERY_PYTHON`) | – | as for `timmy recipe` | `lanes/recipes/README.md`; `tests/recipe-package.test.ts` |
| A clean packed install on Node 24 | – | ✓ | ✓ | partial: rows 83 (Linux) and 84 (the Mac) at the rc.2 candidate (`3a833fb`, `79529e5`), not at `bbe4930` | – | `package.json` (`prepack`); `tests/package-installable.test.ts`, `tests/runtime-package.test.ts` |
| npm publish | – | ✓ release workflow (row 89) | ✓ the tarball check and preflight | – (`2.0.0-rc.1` went to npm from `main` on 2026-10-06, row 90; nothing from this branch) | HOLD: the operator lifts it | `.github/workflows/release.yml`; `tests/release-validate-tarball.test.ts`, `tests/release-preflight.test.ts` |

## 12. Theme

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| Timmy Homebrew, the default look: palette, theme files (Ghostty, kitty, Alacritty, WezTerm, iTerm2), a macOS Terminal profile, `timmy theme install`, the Canvas panel and receipt page | ✓ DESIGN.md §10 B9 | ✓ | ✓ | partial: row 119 painted one Terminal window through OSC 4/10/11 (no profile changed); no row installs the profile on the Mac | `timmy theme install`, or `TIMMY_PALETTE=homebrew` | `src/theme/tokens.ts`, `src/term/theme-install.ts`, `src/term/bplist.ts`, `assets/themes/`; `tests/theme-tokens.test.ts`, `tests/term-terminal-profile.test.ts`, `tests/studio-theme.test.ts`, `tests/theme-package.test.ts` |
| zellij Timmy Homebrew (a green selected tab) | ✓ R1-BRIEF (Sonnet item 2) | ✓ (`8db45cd`) | ✓ | – | `timmy center` under `TIMMY_PALETTE=homebrew` | `tests/ui-zellij-theme.test.ts` |
| Monaspace Argon (terminal profile at 14 pt; served to the browser pages from `@fontsource/monaspace-argon` 5.3.0) | ✓ DESIGN.md §10 B9 | ✓ | ✓ | unknown | install the font: `brew install --cask font-monaspace` (a terminal draws in its own font) | `src/theme/tokens.ts`, `src/studio/server.ts`; `tests/term-terminal-profile.test.ts`, `tests/studio-theme.test.ts` |
| The monitor's focus in green | ✓ `docs/ui-cockpit/B9-MONITOR-PROPOSAL.md` (a proposal) | – (needs a change to the visual law) | – | – | the operator's decision | `docs/ui-cockpit/B9-MONITOR-PROPOSAL.md` |

## 13. Integrations not built yet

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| Houdini | ✓ CCP R2 area 6, milestone | partial: an engine-shelf lane (environment lock, templates); no workspace command | unknown | – | **blocked:** Houdini 22.0.429's `hython` says "No licenses could be found to run this application" (row 139); a licence from the Houdini Launcher first | `lanes/engines/houdini/` |
| Unreal | ✓ CCP R2 area 6, milestone | partial: an engine-shelf lane (environment lock, templates); no workspace command | unknown | – | – | `lanes/engines/unreal/` |
| Spline, driven parametrically | ✓ AGENTS.md §8, CCP R2 area 6 | – in the workspace (not started); a factory lane outside it calls a Spline bridge | unknown | – | – | `lanes/factory/finish.mjs` |
| TaskForge API | ✓ CCP R1 1, R2 area 3 | partial: a `/tools` row with a live health check; a `timmy engine` lane; no REPL tool | ✓ the row | – (row 128: `needs setup`) | set `TASKFORGE_API_URL` to its API | `src/capabilities/index.ts`, `lanes/engines/taskforge/`; `tests/capabilities.test.ts` |
| AgentPass | ✓ CCP R1 1, R2 area 3 | partial: a `/tools` row; a `timmy engine` lane; no REPL tool | ✓ the row; lane panes say it is not connected | – (row 128: `needs setup`) | set `AGENTPASS_REPO_PATH` to its checkout (the service lives outside this repository) | `src/capabilities/index.ts`, `lanes/engines/agentpass/`; `tests/capabilities.test.ts`, `tests/agent-lanes-honest.test.ts` |
| Roboflow | ✓ CCP F-6, R1 3 | partial: an adapter outside the workspace; not routed from `/observe` | partial: the no-key paths only | – | needs a key: `ROBOFLOW_API_KEY` | `src/utils/roboflow-adapter.ts`; `tests/roboflow.test.ts`, `tests/roboflow-adapter.test.ts` |
| Rerun viewer | ✓ CCP F-6 | partial: a module in the forge pipeline; no viewer pane | ✓ the module | – | – | `src/forge/observe/rerun.ts`; `tests/forge-rerun.test.ts` |
| Vision adapters (Viser, FiftyOne, Depth Anything, SAM) | ✓ CCP F-6 | partial: `/tools` counts the adapters found; "a probe run qualifies one" | ✓ the registry (adapter presence is not qualification) | – | – | `src/capabilities/index.ts` (`timmy vision integrations list`); `tests/vision-integrations.test.ts` |
| Images in the REPL (Kitty, iTerm2, Ghostty); term.everything | ✓ CCP R1 7 | – in the REPL (the v1 shell only) | – | – | – | CCP R1 item 7 |

## 14. On the operator's tool list, not yet rows above

Named in the operator's own tool register (kept private), or stated by the operator, and not yet planned in this repository: nothing is
implemented, tested or demonstrated for any of them here. Each needs an AI-operable route (API, MCP, CLI,
scripting or computer use) before it can move up.

| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |
|---|---|---|---|---|---|---|
| Code CAD besides CadQuery: OpenSCAD, FreeCAD, build123d | partial: the operator's register | – | – | – | – | – |
| Plasticity (direct-modeling CAD; STEP round trip) | partial: the operator's register | – | – | – | no public API: a computer-use or STEP route | – |
| Unity, Godot, USD stages | partial: the operator's register | – | – | – | – | – |
| Spline V2, Hana, Omma (design and first-draft 3D) | partial: the operator's register | – | – | – | – | – |
| Video: Remotion, HyperFrames, Rive | partial: the operator's register | – | – | – | – | – |
| NVIDIA Cosmos, Tripo | partial: the operator's register | – | – | – | – | – |
| OpenHands SDK, JBang | partial: the operator's register | – | – | – | – | – |
| Writing: Neovim, LaTeX, Fountain/FDX, Instatic | partial: the register (Neovim, Instatic); stated by the operator (LaTeX, Fountain/FDX) | – | – | – | – | – |

## Unknowns to resolve

- **Blender**: settled by row 133 (`ea5ef4d`); the object-list fix in `bbe4930` (row 134) has run only against the
  stand-in `bpy`.
- **Cinema 4D, a real scene run.** Row 128 shows only the stop at the licence question. `templates/c4d-starter/BUILD.md`
  mentions "a retained real run" (`ok: true` while `c4dpy` exited 1) and also says the starter is "not yet
  exercised"; no ledger row records a real run.
- **CadQuery recipe**: its job system ran for real through `/recipe` (rows 136 and 138); `lanes/recipes/README.md`
  still keeps the recipe's native qualification (`qualify.ts`, both widths and the negative controls) as a separate
  gate, not run in R3.
- **Monaspace Argon, Demonstrated.** No ledger row shows the font rendered in the operator's terminal.
- **`/workflows`, Demonstrated.** CCP's R1 section records `/workflows` as exercised on the Mac at `c747545`, but
  ledger rows 124 and 125 name only `/run`.
- **Houdini, Unreal and Spline, Tested.** Their engine-shelf and factory lanes were not traced to tests for this
  checklist (`tests/drop.test.ts` checks a Houdini drop rule, not the engine lane).
