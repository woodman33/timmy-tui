# The integrated review candidate: the fixed completion checklist

The operator's order of 2026-10-27 (01:46 PT) asks for ONE runnable, qualified, integrated Mac review candidate. This list
is fixed at the start of that pass. Items are only closed, re-scoped with the reason given, or marked blocked with the
blocker named. New features found along the way go to the backlog at the end, unless an acceptance criterion needs them.

- **Reconciled against:** HEAD 54ab99ce on `r13/integration`; the R13 report (`REGISTER.md`, v3); the owners' working
  copies on the Mac, read only.
- **The owners' working copies:** no commits since their checkpoints (Card Lab 7176ad97, Film Room f9db9fe0, Model Studio
  a5264eb5; Timmy Animate is an archive with no commit).
- **Open failures at HEAD:** none. The last full suite (94b89793) exited 0, and the Mac passed 59/59 on its package.

**Owners:**

| Owner | Code |
|---|---|
| **Lead** (Timmy, the integrator) | everything under `src/`, `companion/`, `scripts/review/` and `tests/` in this repository |
| **Card Lab**, **Film Room**, **Model Studio**, **Animate** | their apps' own code, never edited here; a change to it goes to that owner as a request |

**Status words:** `done` (observed, the check named) · `open` · `in progress` · `blocked: <the dependency>` ·
`owner request` (needs the owner's change; Timmy's part is done).

## A. One app, entered from Timmy (the order's item 2)

| # | Item | Owner and files | Observable acceptance criterion | Status |
|---|---|---|---|---|
| A1 | Shared navigation in and out of every app | lead: `companion/timmy-app/src/pages/miniapp.jsx`, `shell.jsx` | Each app opens from the rail inside Timmy's frame, in the active project. One "← Timmy" control and the rail stay visible. Leaving lands on the page the person came from. Same words in all four apps. | done: every framed app's bar has ← (the page the person came from; the app keeps running), Results in Files and Stop; the Mac, the candidate 4d59da6e: Back from Model Studio landed on Runs & receipts |
| A2 | Project context | lead: `src/companion/miniapps/*` | The app works in the project the rail shows; switching project switches the app's data (C1, R13). The frame names the project. | done (R13, 23/23 on the Mac); the frame's bar names the project ("in tray") |
| A3 | Theme | lead: `companion/timmy-app` + gateway | Timmy's Amber or Glacier reaches the framed app. Where an app has no theme switch, that is said once. | re-scoped: Timmy's theme reaches its own pages and the frame's bar; each app keeps its owner's look (no app takes a theme from its host). Passing it in is an owner request: backlog |
| A4 | Provider and model selection, one place | lead: Models & accounts; `registry.ts` env | An app's model need (Card Lab's vision model) shows in Models & accounts with its limitation. No app asks for a key Timmy does not pass. | partial: the Control Room lists this computer's local models and starts only local ones; Card Lab's vision model is the companion's setting (localVision), not yet shown in Models & accounts: backlog |
| A5 | Permissions | lead: `approvals.ts`, miniapp page | A native or paid action started from Timmy asks first (Animate's export tool does). The app page says what the app may do on this computer. | done (words): an app's page says it keeps its work in this project's folder, per person, with paid calls held; a run's proposal lists what it may do |
| A6 | App results come back to Timmy | lead: `src/companion/miniapps/receipts.ts`, Files, Runs pages | After a job ends, the project's Files shows its output files, under `from-apps/<app>/<job>/` with the bytes Timmy hashed, and Runs & receipts shows its receipt. Each file links to the receipt. | done (the Mac, the candidate 4d59da6e): Animate's export, Model Studio's .scad, .glb and recipe, Film Room's clips and manifest under from-apps/, each with the bytes its receipt hashed; Files names the receipt |
| A7 | Card Lab journey: import an image → inspect → retain the result and evidence | Card Lab owner (app); lead (frame, receipt, Files) | A TEST card imported in the frame; its inspection run; the result and its evidence (image hashes, cited fields or the held reason) retained in Card Lab and in Timmy's Files and receipts. | done for the journey (the Mac, the candidate 4d59da6e: the handed image imported with its hash, an inspection on gemma4:12b-it-qat, held, retained, receipt failed). A successful live inspection: **blocked** (D3, and the app's fixed 90 s per call timed out) |
| A8 | Film Room journey: ingest → annotate or analyse → export | Film Room owner (app); lead | A video ingested; an annotation saved in a Film Room project; clips rendered from it. The clips and the receipt in Timmy's Files and Runs. | done (the Mac, the candidate 4d59da6e): a 3 s test pattern ingested, a project saved with two clips and a note, the clips and a reel rendered with the note as its sidecar |
| A9 | Model Studio journey: create a native part → edit → inspect → export source and preview | Model Studio owner (app); lead | An OpenSCAD part made; a parameter changed and rebuilt; its view inspected; the `.scad` source and a preview PNG exported to Timmy's Files with the receipt. | done (the Mac, the candidate 4d59da6e): an OpenSCAD box, its width 40 → 60 rebuilt, inspected; three receipts ok |
| A10 | Animate journey: create or open → edit → export | Animate owner (app); lead | A composition from a template; an edit (a recipe or a path preset); a Blender export. The `.blend`, `.usda` and previews in Timmy's Files with the receipt. | done (the Mac, the candidate 4d59da6e): the weather template, the settle recipe and the arc path, a Blender export |
| A11 | One cross-app asset handoff | lead: Files "Send to"; the apps' own import routes | An Animate preview PNG, from Timmy's Files, opens as a new Card Lab run (Card Lab's own `POST /api/runs`). Card Lab shows it; Timmy seals a handoff receipt naming the source job, the sha256 and the target run. | done (the Mac, the candidate 4d59da6e): Animate's preview.png from Files → a new Card Lab run with its exact bytes; one handoff receipt names the source receipt and the run |
| A12 | Blank public starters and private projects kept apart | lead: the demo seed, `scripts/review` | The package's demo projects are blank or scripted-and-labelled. No private project or path is in the package. The review home's apps data stays under the sandbox. | done: the package carries the blank and demo projects only; the owners' private projects stay outside it; the review home's app data under the sandbox |

## B. Control Room (the order's item 3)

| # | Item | Owner and files | Observable acceptance criterion | Status |
|---|---|---|---|---|
| B1 | Launch from the Control Room | lead: `src/companion/panels/control.ts`, a launch route; `companion/timmy-app/src/pages/control.jsx` | The page proposes a run (harness, model, endpoint, workspace, time limit); Approve starts it as a durable job through the existing adapter (`timmy act "/agent <name> …"`, the same `/agent` path the REPL uses). | done (the Mac, the candidate 4d59da6e): Review the run → Approve and start, through `timmy act "/agent qwen …"` on a copy |
| B2 | Two harnesses: OpenHands and Qwen Code, local models only | lead (adapters exist: `src/code-agents/openhands*.ts`, `index.ts`) | Each run has its own job id, operation id and agent run id, and an isolated workspace (OpenHands its container's copy; Qwen a workspace copy made for the run). | Qwen Code: done (gemma4:12b-it-qat; its own job, operation and agent run each time). OpenHands: **blocked: the image timmy-openhands:1.21.0 is not built** (its preflight says so; building it downloads python:3.12-slim and the OpenHands SDK — the operator's decision) |
| B3 | Observe progress and logs | lead | The run's pane shows its progress lines and log tail while it runs, from the job's own record. | done: the run's log lines on the page while it runs, and its Rive face bound to that run alone (working while it ran) |
| B4 | Approval when needed | lead | The launch is approved on the page before anything starts. Any NEEDS YOU of the run shows in the room's "waits on you". | done for the launch: nothing starts until Approve and start (the proposal used once, by the same person, for the same project). A run's own permission requests (a shell command) are refused by Qwen Code itself in a run here and shown at its end; answering them mid-run needs a channel the adapter does not have: backlog |
| B5 | Stop | lead | Stop on the page ends the job through its normal stop path (the act process's SIGTERM, which stops the agent's job and, for OpenHands, its container first). The record says stopped or interrupted, never succeeded. | done (the Mac, the candidate 4d59da6e): Stop → act exited 3, the run stopped, no process of it left, its receipt cancelled |
| B6 | Inspect outputs, diff and receipt | lead | After the end: changed files with the diff against the snapshot before, the final message, the exit and the receipt id, verified. | done (the Mac, the candidate 4d59da6e): HELLO.md added in its copy, its diff, its final words, its receipt |
| B7 | Identity consistent across surfaces | lead | The same project, harness, model, operation id and result in the Control Room, Runs & receipts and `timmy act`'s JSON. | done (the Mac, the candidate 4d59da6e): one operation id on the page, in the project's receipt and in act's JSON; the harness, model and project in each |
| B8 | Truthful interrupted and recovery states | lead (`/recover` exists) | A run whose launcher is killed shows interrupted; `/recover` settles it. | done (the Mac, the candidate 4d59da6e): act killed outright → interrupted; Recover stopped the agent it left (recovery proved its REPL gone) and the receipt says failed |

## C. Rive and tldraw (the order's item 4)

| # | Item | Owner and files | Observable acceptance criterion | Status |
|---|---|---|---|---|
| C1 | Real Rive state machines bound to turn and job events | lead | Running, completion, stopped, failed and approval recorded at the runtime. | done: chat turns (R13 7/7) and each Control Room run's own face (fed by its record: working, stopping, stopped, failed, idle) |
| C2 | Saved snapshots visibly distinct from live status | lead | A face showing a saved or recorded state says so in its caption ("AS SAVED", "recorded"). A live one is fed by events. | done: a run face says LIVE while its job runs and ENDED after; saved faces keep AS SAVED / AS RECORDED |
| C3 | The SDK's licence verdict with the operator's key | lead | "licensed", read from `LicenseManager.state`. | done (licensed, read from LicenseManager on the Mac, launch check 7/7) |
| C4 | Mobile model chooser, with words fit for the layout | lead: `pages/chat.jsx`, `models.jsx` | At 390 px: the empty Chat names Models & accounts (no "column on the right", which a phone does not have); choosing a model from the phone works end to end. | done: the empty Chat says where the chooser is for the layout (on the right, or below the chat); its one action brings the chooser into view; a model chosen at 390 px makes Send ready (container browser) |
| C5 | Concise empty states; the composer reachable at once | lead: `chat.jsx` and the pages | At 390×844 the composer is in view without scrolling. The empty states are two lines and one action. | done (the Mac, the candidate 4d59da6e, 390 × 844): the composer on the first screen, nothing wider than the screen |
| C6 | Status and action consolidated | lead | Each page says its state once, with one primary action, not a panel, a button and an empty state saying the same thing. | done: the Chat's state once (no model: one action, "Choose a model"; no repeated route line) |
| C7 | Endpoint details behind Details | lead | No `GET /api/...` or `POST /api/...` line on a page's face (the canvas cards, the Control Room, the records bar). They sit under a Details disclosure. | done: no `GET /api/…` or `POST /api/…` on a page's face (the canvas cards, Runs, the Control Room, the records bar); they are in Details and the opened records (the Mac, the candidate 4d59da6e: 0 on the phone's Chat) |
| C8 | Consistent navigation into and out of every app | lead | = A1, checked at desktop and phone widths. | = A1: done |

## D. Correctness and isolation (the order's item 5)

| # | Item | Owner and files | Observable acceptance criterion | Status |
|---|---|---|---|---|
| D1 | The PTY failure | lead | Classified, fixed, original kept. | done (9bc2c3e3) |
| D2 | Direct worker-endpoint bypass and isolation across principals | lead | All of the R13 list. | done (050d5407; Mac 12/12 and 23/23 on 94b8979) |
| D3 | The observed-handle and `cite` evidence policy, enforced | Card Lab owner; lead (no bypass) | Timmy never relaxes it: a held answer stays held and its receipt says failed. Live success needs a model and provider that call `cite` while a strict schema is asked. On Ollama's OpenAI-compatible route, none did (R13: three models). | done for enforcement. A successful live inspection: **blocked**, cause now observed (2026-10-27, the Mac, gemma4:12b-it-qat on Ollama's `/v1/chat/completions`): the same request with the `cite` tool alone gives `tool_calls: cite(h_front_1)`; with Card Lab's strict `response_format` added, the model reasons that it must cite, then emits only the schema's JSON (`finish_reason: stop`, no tool call). Owner request: call `cite` in a step without `response_format`, then ask for the schema-constrained answer. Hosted models are paid: held. |
| D4 | Durable operation ids, process outcomes, source revisions, canonical receipts | lead | Every journey's receipt carries the app's revision and the app's own end word, and is sealed once. | done: the apps' receipts (R13) and each Control Room run's receipt, sealed once, with act's operation id |
| D5 | The video and animate commands and the agent and MCP adapters the journeys need | lead | `timmy video` and `timmy animate`; the 12 Animate tools. | done (R13, Mac 10/10) |

## E. Qualify and deliver (the order's item 6)

| # | Item | Acceptance | Status |
|---|---|---|---|
| E1 | One candidate revision, built from a clean source state | `scripts/review/build-review.sh` refuses a dirty tree; the package's checksum. | done: 4d59da6e, built from a clean tree (exit 0); `timmy-review-4d59da6.tar.gz`, sha256 `4e00d337a451966cffaf437d7d3f24d69450b129171e0bdc451fe529d6c27a4a` |
| E2 | The required checks on that revision | The full suite under the heavy lock, exit code kept; runner errors kept. A fix after it means a new revision and the checks that fix needs. | done, with one test defect fixed: the full suite on 4d59da6e (frozen, clean, under the heavy lock, 03:14–04:05 PT) **exit 1**: 784 files passed, 1 failed, 16 skipped; 6451 tests passed, 2 failed. Both failures in `tests/miniapps-handoff.test.ts`: its fake Card Lab's built page was ignored by `.gitignore` (`dist/`), so a clean checkout had none (409). Fixed in fd866755 (test only; no product byte changed); the four affected files on a clean checkout of fd866755: 23/23, exit 0 |
| E3 | The Mac sandbox install and the journeys | A fresh folder through `./timmy-app`; A7–A11 and B1–B8 exercised; C4–C8 seen at desktop and phone widths. | done (the Mac, a fresh folder, 2026-10-27 03:14–03:26 PT): launch 7/7, isolation 23/23, two users 12/12, journeys 19 of 20 (A7-live blocked, as A7), Rive and tldraw 7/7, commands 10/10; the census clean after the app stopped and at the end; the home folder's store unchanged (53 lines, the same sha256) |
| E4 | Deliverables | The package and its checksum; launch and stop; desktop and phone captures. A short recording: real Rive transitions, an app result coming back into Timmy, a Control Room launch and Stop. The results tied to the candidate; the remaining blockers. | done: the package and checksum, launch and stop (below and in `REGISTER.md`), desktop and phone captures, a 75 s recording sped up 3.2× from the 237 s journey recording, Rive's own transition recording; the blockers in A7, B2, D3 and F |

## F. Stream Studio (required for the four-app launch; not for this candidate)

- **Owner:** none exists (checked: the register, branches, PRs, the owners' packet, the Mac's working copies).
- **The bounded assignment, for the owner the operator names** (the lead's proposal: the Animate owner, whose engine it
  reuses): Compose → Animate → Preview/Export, from existing components only:
  1. **Compose:** a scene of HTML overlay layers on a tldraw page (text, image, a Rive face).
  2. **Animate:** Timmy Animate's engine (scene JSON, its recipes and state preview).
  3. **Preview:** in the frame.
  4. **Export:** the HTML page and a Lottie or MP4.
  5. **Hosting:** under C1, a receipt per export. No streaming service, no paid call.
- **The four-app launch is not complete without it.** This candidate does not claim it.

## G. The operator's 05:03 PT order (2026-10-27): the Rive UI, tldraw workspaces and the mini-app experience

**The test record, as it stands:**
- **4d59da6e:** the full suite failed (exit 1).
- **fd866755:** only the four affected files passed on a clean checkout (23/23). No full suite has run on it, and none is
  claimed.
- **Mac results:** the 4d59da6e results stand for the product bytes; fd866755 changes a test fixture only.

| # | Item | Owner and files | Observable acceptance criterion | Status |
|---|---|---|---|---|
| G1 | Control Room: one current outcome | lead: `pages/control-runs.jsx` | An ended run says one outcome, with its changed files or result and its receipt. "Started run", "Stop sent" and the raw lines move to Details (event history, logs). | done: 0bde3030, the Mac (a succeeded run and a stopped one: one outcome each, "Stopped from the Control Room at …") |
| G2 | Phone Chat: one setup action | lead: `pages/chat.jsx` | With no model chosen, one action ("Choose a model") opens the picker at once. No repeat in the header, model cell, empty state and composer. The composer stays reachable with the keyboard open. | done: bb2b9583, the Mac at 390 × 844 (one setup action; the picker as a sheet). The keyboard-open composer: container test only |
| G3 | Files after a handoff | lead: `pages/files.jsx` | "Sent to Card Lab" with a prominent "Open inspection". Output names and previews first. Paths, hashes, provenance and the receipt behind Details. | done: bb2b9583, the Mac (results by name; Sent to Card Lab; Open inspection landed on `/?run=<id>`; reopened in a fresh browser, still listed). Some app file names are the app's own (`r2-inspect-job_<id>.json`): friendlier labels next |
| G4 | Shared chrome | lead: `shell.jsx` | Request counts and diagnostics are secondary. Theme and model selection are consistent across the host and the apps (the apps' part: owner requests). | done: the host side 37fa0cba, the apps' side by their owners (Card Lab 342c0f72, Film Room 8c3cd19f); the Mac, 92d2368c |
| G5 | Phone Canvas | lead: `pages/canvas.jsx` | An obvious Fit/Overview, controls reachable on a phone, a focused-card view with a readable inspector. Free pan and edit kept. Every action findable without a gesture. | done: 8113d1a8, the Mac at 390 × 844 (9 shapes, none outside the stage; a card focused with the inspector open) |
| G6 | Rive and tldraw foundation | lead | Readable faces at their size. Live state, saved snapshots and final outcomes distinct; idle never reads as success. Reduced motion, keyboard and an asset-load fallback. On the Canvas: select and edit, undo and redo, Fit, save and reopen, switching projects; navigation and Stop outside pan and zoom; a stale result never replaces a newer edit. | partly done: a run's end is a still outcome (never idle as success); Rive faces drawn for their zoom (8113d1a8). Kept from earlier rounds and not re-checked here: reduced motion, the keyboard, the asset-load fallback, save and reopen, project switching, the stale-desk refusal |
| G7 | Model Studio embedded layout | Model Studio owner (its layout); lead (the frame) | One rail, one header, a larger viewport; the asset tree and inspector kept. Timmy's project named apart from the app's document. "App open" apart from "a modelling job runs". | lead's part done (the bar: "app open", "Timmy project: tray"; the app's own document is "Untitled spatial project"). The embedded layout: owner request (relay message 3) |
| G8 | Card Lab: cite first, the schema second; a bounded, configurable timeout | Card Lab owner | One successful local inspection with an observed `cite` call. Invalid evidence rejected. Raw outputs and refusals kept. | owner request (relay message 1). On 0bde3030 the Mac's inspection was held twice over: 8113d1a8 timed out at 90 s; 0bde3030 answered without a cite call and was refused ("no successful observed cite call") |
| G9 | Stream Studio: Compose → Animate → Preview/Export | Animate owner (the app); lead (host integration) | A saved, editable scene; a Files import; the exports it actually supports; receipts. Broadcast stays pending. | owner request (relay message 2); acceptance not yet confirmed |
| G10 | Sketch → Image → Generate 3D → Model Studio, and direct entry | lead | The path and a direct native-part or import entry, kept. | kept: Model Studio a5264eb5 shows Sketch, Image, Generate 3D (paid generation held) and Studio, with Create part and Import (the Mac capture) |
| G11 | The walkthrough | lead | Choose a model → useful work → Rive and job state → edit the output → export and native source → Files and receipt → reopen. Desktop and phone, the apps' editors open. Idle cut and labelled; the full recording kept. | done: 0bde3030 on the Mac. A 75 s cut, sped up 2.9× and labelled in the picture, from the full 217 s recording: Chat (a model chosen, a turn working, then answered and sealed), Files (Sent to Card Lab, Open inspection), the Control Room (a launch, Stop). The apps' editing and export are in still captures; the cut does not show them |

## H. The shared-integrator order (2026-10-27, 06:11 PT): Treg, Tools & integrations, and the original product

The lead owns the host, the registry, the frame, Files, the receipts and Tools & integrations; each owner owns its app.

| # | Item | Owner and files | Observable acceptance criterion | Status |
|---|---|---|---|---|
| H1 | The Treg checkpoint, adopted | lead: `src/connectors/treg-bridge.ts`, `src/connectors/treg.ts` | Timmy's own bridge on its own SDK dependency, with no machine paths. Its sign-in is the file TREG_CONFIG names, else the home's `.treg/config.json`. MCPorter and the SDK route stay independent clients. No token in a page, record, receipt or log | done: 92d2368c. `tests/treg-bridge.test.ts` (a FAKE remote) |
| H2 | Treg through the host's job model | lead: `src/companion/connector-ops.ts` | Durable operations. Discover and free calls. A paid call only from a proposal made from a fresh price preview, used once, one at a time. Stop says a sent request is not withdrawn. Recover reads the project's records; a paid call with no record is "unknown". A connector.call receipt with the quote and the charge Treg's answer states. Operator only | done: 92d2368c. `tests/connector-ops.test.ts` (a FAKE Treg server; real act, routes, records). No live Treg call made |
| H3 | Tools & integrations | lead: `pages/integrations.jsx`, `pages/tools.jsx` | Installed, signed in, discovered, ran here and qualified kept apart, each naming its record. Plain next actions; the visible cost; Stop and Recover | done: 92d2368c. `tests/timmy-app-integrations-browser.test.ts` (FAKE Treg). The Mac, the installed package: the five words shown; Treg not signed in there (the review names no sign-in) and Discover refused before anything was sent; the phone fits |
| H4 | The tldraw card | lead: `pages/integrations.jsx`, `pages/canvas.jsx` | Puts a finished host operation's result on the Canvas desk as a note. It is the same result; nothing is called again | done: 92d2368c (the browser test above) |
| H5 | Theme into the owners' apps across their loopback origins | lead (the host side, 37fa0cba); the owners (the app side: Card Lab 342c0f72, Film Room 8c3cd19f) | Amber and Glacier follow Timmy's switch inside Timmy's frame, without a reload | done: 92d2368c on the Mac, both apps (Amber, Glacier, Amber again; the same document) |
| H6 | Real Card Lab inspection, cite first | Card Lab owner | One local inspection with an observed `cite` call; invalid evidence rejected | partly: on the Mac (Card Lab 342c0f72, gemma4:12b-it-qat) the inspection ended ready with one observed cite call of the run's own handle and revision; its answer was "unknown" (the image handed was an Animate export, not a card). The invalid-evidence rejection was not exercised live: the owner's tests only |
| H7 | Model Studio embedded layout; Stream Studio's export milestone; Film Room's workflows kept | the owners | as in G7, G9 and A8 | owner work; the lead does not duplicate it |

## I. The completion pass (2026-10-27, 07:37 PT): one Mac review candidate — the fixed list of remaining gaps

Reconciled once from the operator's checkpoint map, against ad47f831 (92d2368c plus the docs commit). Each owner artifact
below was read on the Mac without changing anything there, and its bytes were checked against its own id before use.

| Owner | Checkpoint adopted | Its bytes, as checked |
|---|---|---|
| Card Lab | 6f166d2d (runtime), 16a6ac71 (a documentation-only reuse map on top) | git bundle of `codex/card-lab-checkpoint`; tip 16a6ac71. The owner's working tree has 10 uncommitted changes, left as they are and not imported |
| Film Room | adfb7a74 | git bundle of `codex/film-room-checkpoint`; clean tree |
| Model Studio | 8266c20a (operator-approved), with the embedded layout 39633703/ba96a0a8 under it | git bundle of `codex/model-studio`; clean tree |
| Stream Studio | content revision 2be70c25… (not a commit) | the owner's source archive: 64 files, each matching `source-revision.json`; the canonical map's sha256 recomputed equal |
| Animate | v7 source archive (app-source-delta.json); v8 is a mutable working tree with no content manifest of its own | v7 archive and the owner's v8 preservation and patches, copied as they are |
| OpenHands attempts | b56c36f0 (on 08006fb9, an ancestor of this branch) | the commit's patch and its ten files from the operator's checkout (read only) |
| Control Room behaviour | 2a798e1f on `codex/control-room-handoff-2026-10-27` | the branch's handoff documents (review material, no production code) |

| # | Gap | Owner | Closes when | Status |
|---|---|---|---|---|
| I1 | The registry and the package carry the adopted owner checkpoints | lead | each app's page and its `.timmy-source.json` name the revision above; the package builds them | registry in 28f1e920 (Card 6f166d2d/16a6ac71, Film adfb7a74, Model 8266c20a, Stream 2be70c25, Animate v8 by manifest 6e2151ab); the package `timmy-review-790477f` builds them all (sha256 `738c2179…58f6`) — **closed** |
| I2 | Theme parent origins | lead (host); owners (apps) | Card Lab gets `CARDLAB_TIMMY_PARENT_ORIGIN`, Model Studio `STUDIO_THEME_PARENT_ORIGIN` and `theme: {ready: true}`, Film Room keeps its mapping; Stream Studio's query/referrer trust is relayed to its owner and not claimed at parity | host side in 28f1e920 (tests: miniapps-theme, timmy-app-g-browser with the FAKE Card Lab reading its env). Stream: **asked of its owner** (an exact, server-configured parent origin); not at parity. Live: all four apps took both themes in Timmy's frame on the Mac at c6acfea — **closed** for the host; Stream's trust stays with its owner |
| I3 | Stream Studio hosted | lead (host); Animate/Stream owner (app) | entered from Timmy; its SVG and HTML exports come back to Files with Timmy's receipts; Broadcast stays visibly not built | host side in 28f1e920; on the Mac (A12, c6acfea through 790477f) composed, animated, exported an SVG frame and an HTML player with receipts and files by hash, Broadcast reported not built — **closed** (driven through the app's HTTP API inside the frame, not editor clicks) |
| I4 | Animate's v7 host catalog patch | lead | the shared agent/MCP schemas list v7's paths and templates; their tests pass | **closed** in 22bd1f62 (applied by hand: the owner's patch did not apply to the adapted file) |
| I5 | OpenHands attempts adopted | lead (shared dispatch/MCP); timmy-new-1 (its code) | b56c36f0 applied onto this branch, its own tests and the neighbouring dispatch/MCP tests pass | **closed** in 38177536: 32 files / 273 tests (OpenHands, dispatch, MCP) and the owner's 8 Python tests. Blocker kept: the runner image `timmy-oh-runner:1.21.0-attempts-1` is not built on the Mac (not a pass) |
| I6 | The Control Room's connector-call card | lead | the existing room shows Treg operations as records: quote, charge as stated or unknown, call ids, operation, receipt, Stop and Recover | **closed** in f88990ce (FAKE Treg, browser) |
| I7 | The main UI on Card Lab's foundation | lead | Timmy's Glacier uses Card Lab's silver/black/blue tokens and is the default; Amber kept; Animate keeps its own identity | in 1495752c (Card Lab's neutral shell, measured; Glacier default); a fresh profile opens in Glacier on the Mac (RT, 43ff2da and 790477f); captures in both themes at both sizes — **closed** |
| I8 | Other integrations through their real state | lead | Roboflow, UPMD, Cloudflare and the other inventory rows read as the same five words, from their records | **closed** in e930d78c (qualified never claimed; discovered not checked on that page) |
| I9 | Qualify one candidate | lead | the full suite on the candidate; on the Mac: launch, journeys over the five apps, a handoff, the Control Room, project switching, two users, the tldraw licence through the SDK, both themes at 1440 × 900 and 390 × 844, a recording | **closed with blockers** on candidate 790477f (head bd3f3595): full suite 6,499 passed / 0 failed; Mac 23/23, 12/12, 7/7, 10/10, journeys 41/43; home store unchanged. Blockers: A7 (Card Lab's identity needs a real card image), the OpenHands runner image not built on the Mac, Stream Studio's theme trust with its owner |
| I10 | The rail as the operator set it (07:57) | lead | Chat; APPS image/video/3D/2D animation; AGENTS Control Room and OpenHands sandbox; TOOLS MCP → CLI, Timmy MCP, Files, Workspace, Integrations; the rest behind WORKSPACES | **closed** in 790bfe07 and 58e4b6ed (browser) |
| I11 | Agents aimed at any app; one Workspace canvas importing every app's results (08:10) | lead | a Control Room run's target (project, an app's outputs, one file), from every app's bar and from Files; the Workspace imports images and video as tldraw assets read from the project, anything else as a note with its receipt | **closed** in 7345e9e8 and 58e4b6ed (FAKE act, browser). Harnesses stay OpenHands and Qwen Code |

Full suite on 92d2368c (before this pass's code): 6,472 passed, 3 failed, 136 skipped; the 3 (studio-cards-browser,
studio-isolation-browser: 5 s waits) timed out while the OpenHands tests ran beside it, and passed 12/12 alone.

Out of this pass: new frameworks, CAD rewrites, research lanes, private creative projects, live provider spend.

## J. The unified Workspace order (2026-10-27, 16:56 PT)

One licensed tldraw canvas with native Rive, several boards per project, display and operation nodes, an agent panel on
the same validated operations, one integration catalog, and the Control Room's three targets.

| # | Item | Closes when | Status |
|---|---|---|---|
| J1 | One integration catalog | the node picker, the inspectors and the Control Room read the same catalog rows | **closed** in 8239291f, dafd8922, cc059b21 (browser); on the Mac: 16 rows, "installed, not callable" stated (U9) |
| J2 | Several boards per project | a new board is blank and saved in the project; another project has none of it | **closed** in 05181392 and c0c91611 (a new board draws no desk sections); Mac U1, U8 |
| J3 | Display nodes | image, video, 3D, isolated HTML or Rive, native files, each with one header, view, actions and inspector | **closed** in 351e5d08; Mac U3, U7 (HTML preview sandboxed `allow-scripts` only, its receipt and hash in the inspector) |
| J4 | Operation nodes with typed ports, run as the apps' durable jobs | validated before start; progress, cancellation, recovery and current-result fencing; outputs placed beside the node; every delivered file read back against its receipt | **closed** in c31a51c6, 12173405, d9aafbc0 (a run cut short in its collection is recovered), abd426b7 (outputs stack in columns). Mac U4 readback 7/7, U6 Recover. **Cancel not exercised live** (the real Stream Studio job completed before Cancel reached it); exercised against the FAKE app |
| J5 | The agent panel: Plan / Run / Autopilot | the agent's steps go through the same functions as a person's edits; every name an enum of the board as saved at a source revision; a refused answer kept and never repaired | **closed** in a683764c, c58f6ad9, 84049327, 0038c387, c0c91611, d9aafbc0, 3b4fb885. Mac U4 at 3b4fb88: gemma4:12b-it-qat on this computer's Ollama, plan applied in 5.2 s, its run completed, readback 7/7 |
| J6 | The Control Room's three targets | delivered files; an app's operation through its adapter with read-back; the canvas selection | **closed** in a683764c (browser, FAKE apps); captures U10 control in both themes at both sizes |
| J7 | Glacier tokens (Card Lab blue/silver/white on black) | the default family; Amber kept | in 1495752c (earlier pass). **Decision for the operator:** focus and selection stay amber `#FFB000` in Glacier, as DESIGN.md's contract says; not changed |
| J8 | Evidence policy | handles as enums for the run and source revision; empty means unknown or a refusal; Agent Archive disabled | the plan's names are enums of the board as saved (sha256 source revision); resolving a cited handle is the observation (the model's endpoint has no tools, so there is no cite tool call); an empty plan is the model's own "nothing to do". Agent Archive stays disabled |
| J9 | One identified installed candidate | the demonstration on the Mac, captures at 1440 × 900 and 390 × 844 in both themes, a recording, the full suite | **candidate 3b4fb88** (see the register): 17 of 18 checks passed, U5 Cancel not exercised live; launch 7/7; home store unchanged; full suite 6,533 passed, 1 failed (G6 panning, flaky; 5/5 alone twice) — **closed with blockers** |

## K. The spatial tools order (2026-10-27, 23:40 PT): Brush, KIRI and gsplat in the unified Workspace

The prepared spatial tools package (another owner's, read and never written) brought into the existing catalog, durable
jobs, operation nodes, 3D Model Studio and the licensed tldraw canvas. No new scheduler, receipt store, login or MCP server.

| # | Item | Closes when | Status |
|---|---|---|---|
| K1 | The three tools in the shared catalog | operations, executable paths, readiness and precise blockers; a present file is never "qualified" | **closed** in fa8e0283: Brush 0.3.0 and KIRI 5.1.0 "installed, callable here"; gsplat 1.5.3 not installed, not callable ("awaiting a powered NVIDIA worker"). `verified` comes only from this project's spatial receipts and says "synthetic fixture only" when that is all there is. Mac S1 |
| K2 | Timmy's own jobs and operation bridge | job identity, progress, cancellation to the native process group, output collection, recovery, one canonical receipt, current-result fencing; Brush's terminal output, KIRI's execution report and gsplat's NDJSON adapted, never fed to the vision parser | **closed** in fa8e0283 and 9c5c7ffd: KIRI completes only on Blender exit 0, the worker's success, its 3 value checks, a Gaussian export, a native .blend **and** an independent compare against the original file; Brush only when its export parses as Gaussian; gsplat refused 409 before anything starts. `tests/spatial-jobs.test.ts` (FAKE tools). Mac S4, S5 (live Cancel: SIGTERM, process group gone), S7 |
| K3 | Blender's startup failure, diagnosed apart from KIRI | the bounded fixture check: import → crop → native .blend save/reopen → Gaussian PLY export/reimport, values and coordinates compared | **closed for the fixture**: the crash is Metal device discovery (`MTLBackend::metal_is_supported`) in a process with no Metal device; Blender 5.2.3 starts from the user session. KIRI fixture run: 8 → 4 kept, max difference 0 on every field at each step; independent compare ok. The package's own worker failed (TypeError, kept raw); Timmy's worker carries the fix. **Fixture only** |
| K4 | Splats in 3D Model Studio and on the canvas | the supported operations in Model Studio's menu and the canvas; Spark inside the existing Three.js viewport; original Gaussian data kept; appearance, not measured geometry | **closed** in fa8e0283, 79f8a896, 4b5c80d2: Spark 2.3.1 (MIT, exact pin) draws the splat; its facts come from the file; "centres (exact)" view. 4b5c80d2 fixes a picture the 79f8a89 run counted but did not check: KIRI's extra red/green/blue/alpha columns drew 4 Gaussians as 5 pixels (now ~14,500; negative control fails the old code). Mac S2, S3, S8 |
| K5 | One bounded Mac journey | import a synthetic splat, show it, crop/export with KIRI, save/reopen, the job, outputs and receipt; gsplat visibly awaiting an NVIDIA worker | **candidate 4b5c80d: 14 of 14 checks passed** (see the register), on the synthetic fixture only; the full suite on 4b5c80d2: 807 of 823 files passed, 16 skipped; 6,545 tests passed, 137 skipped, 0 failed (exit 0, 3,332 s) — **closed** |

Follow-up candidates, not in this checkpoint: CloudCompare, napari, Polyscope.

## L. The canvas correction (2026-10-28, 16:16 PT): Image Analysis's work fills the window

The operator's screenshot: Research at 32% under stacked headers, a guidance column and a two-row footer. Owners: the host
frame is this pass's; Card Lab's source is its owner's (Codex). The owner was not reachable here, so the change is on a
separate Card Lab branch `claude/canvas-correction` (from the hosted 16a6ac71), delivered to the owner as a bundle and
patches; their branch is not touched. Embedded mode only (framed, or `?embedded=1`): standalone Card Lab is unchanged.

| # | Item | Closes when | Status |
|---|---|---|---|
| L1 | The canvas fills the working area | the frame and the tldraw viewport take the space the chrome gave up | **closed**: host add59bf1 (40px bar, no padding, no 480px minimum, footer folded); Card Lab 1ae8aa28: viewport 1208×645 at 1440×900 (was 892×289), 1048×545 at 1280×800 (was 735×258) |
| L2 | Duplicate branding, dossier and copy collapse | one compact header; the dossier one line with its review one press away; help in Task | **closed** (Card Lab 887518d5) |
| L3 | One 44–48px toolbar; secondary controls in menus; phone targets ≥ 44px | measured | **closed**: header 44px, toolbar 46px, records 36px on desktop; phone header two rows, toolbar 56px, smallest target 44px |
| L4 | Readable framing from width and height; Fit kept explicit; cameras not reset | measured zoom on each page | **closed** (887518d5, 1ae8aa28): Research 100% / 96%, Inspect 85% / 71% (the whole tall panel), Decide 100% / 83%; Fit workspace 92% / 77% / 31%; a readable saved camera is kept, a moved camera is never reset |
| L5 | Native Rive interaction visible and tied to real status | a recording of a real run's state change | **closed with a FAKE model**: RiveStatus reuses the scanner's CardScanner state machine (isScanning bound to the run); a Card Lab run against a labelled FAKE loopback vision endpoint went idle → active ("Working · predict") → held ("Needs attention") after its refusal; recorded |
| L6 | Glacier consistency, accessible tables | host theme; table roles | **closed**: the host's Glacier reaches the frame (theme bridge unchanged); the pricing table has table/row/cell roles |
| L7 | Hosted captures at desktop and phone sizes | 1440×900, 1280×800, 390×844 | **in this container** (Linux Chromium, tldraw unlicensed here: the key is on the Mac only). The licensed Mac run waits for the Mac folder link |
| L8 | The R18 review's three corrections | phone dossier in More; live status text; chosen and saved cameras kept | **closed** in Card Lab 96a66114, f13930e9; `embedded-check.mjs` 16 of 16. Package b074e91 (sha256 `6f1fa2f7…d0b9`) on the Mac, verified, not yet run |

## M. The scanner order (2026-10-29, 15:23 PT): full screen, and the frame directs the photo

"Make sure the scanner page where you scan cards is full screen, especially on mobile, and has perfect framing … photos of
cards should be directed by the framing itself and then lead the user and guide them to take perfect photos." Card Lab's
scanner, on the same separate branch `claude/canvas-correction` (Card Lab 09dc202e); the host's frame contract is this pass's.

| # | Item | Closes when | Status |
|---|---|---|---|
| M1 | Full screen, especially on phones | the camera surface is the whole first screen at 390×844, 844×390 and desktop; in Timmy too | **closed**: surface 390×844 on the phone; in Timmy the frame grows from 390×694 to 390×844 while the scanner is open (`timmy:immersive` v1) and is handed back on Close |
| M2 | A true card frame, fitted from width and height | a 63 × 88 mm frame clear of every control band; the native Rive corners on it | **closed**: phone frame 327×457 before the camera starts and 356×497 live (it then holds still: the coach keeps one height); short landscape 217×303; desktop 472×659 (was a 357×500 stage); the Rive guide is mapped onto the frame (Fit.Fill) |
| M3 | The photo is what the frame shows | the saved image is the frame plus a 4% margin | **closed**: measured on the captured JPEG's aspect |
| M4 | The frame leads the person to a clear photo | measured light, glare, focus, steadiness and edges; one directive; steps front → back → detail → foil | **closed on synthetic feeds**: aligned → "Ready", small → "Move closer", off-centre → "move it left", glare → named, blur → focus fails; auto capture opt-in; the still is checked before use |
| M5 | Camera inside Timmy's frame | the frame allows the camera to Card Lab only | **closed**: `allow="camera"` from the registry's `frame`; the live checks ran inside Timmy (container, synthetic feed) |
| M6 | A physical phone camera, Safari | a real card on a real phone | **open**: not run here (no device; WebKit is not installed in this container). Thresholds are fixed guides, not calibrated on real cards |

## Backlog (found during this pass; not needed for the acceptance criteria)

Each was found during this pass. None is needed for an acceptance criterion above.

1. **Theme into the framed apps (A3).** Done for Card Lab and Film Room (92d2368c on the Mac). Model Studio and Animate: not adopted by their owners yet.
2. **Card Lab's vision model in Models & accounts (A4).** It is the companion's `localVision` setting today.
3. **A run's own permission requests, answered mid-run (B4).** Qwen Code refuses a shell command in a run here and the
   refusal is shown at its end. Answering it needs a channel the adapter does not have.
4. **Card Lab (D3):** cite first and a configurable timeout, landed by its owner in 342c0f72; one live cited inspection on
   the Mac (H6). The invalid-evidence rejection is not yet exercised live.
5. **Qwen Code's version.** The installed CLI is 0.25.1; its stream reports `qwen_code_version` 0.22.2. The run records
   what the stream says. Not explained yet.
6. **The Mac driver's phone pass** (test tooling, outside the repository) clicks "Open X", which an app still running
   shows as "Return to X". The phone captures of those apps were not taken; the checks themselves passed. (Fixed in the
   driver for 8113d1a8.)
7. **Friendlier names for app files in Files** (G3): show `r2-inspect-job_<id>.json` as "inspection · rev 2", keeping
   the path under Details.
8. **The walkthrough cut** shows Chat, Files and the Control Room. Recording the apps' own editors while they edit and
   export needs the driver to record inside their frames.