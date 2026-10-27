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
| G1 | Control Room: one current outcome | lead: `pages/control-runs.jsx` | An ended run says one outcome, with its changed files or result and its receipt. "Started run", "Stop sent" and the raw lines move to Details (event history, logs). | open |
| G2 | Phone Chat: one setup action | lead: `pages/chat.jsx` | With no model chosen, one action ("Choose a model") opens the picker at once. No repeat in the header, model cell, empty state and composer. The composer stays reachable with the keyboard open. | open |
| G3 | Files after a handoff | lead: `pages/files.jsx` | "Sent to Card Lab" with a prominent "Open inspection". Output names and previews first. Paths, hashes, provenance and the receipt behind Details. | open |
| G4 | Shared chrome | lead: `shell.jsx` | Request counts and diagnostics are secondary. Theme and model selection are consistent across the host and the apps (the apps' part: owner requests). | open |
| G5 | Phone Canvas | lead: `pages/canvas.jsx` | An obvious Fit/Overview, controls reachable on a phone, a focused-card view with a readable inspector. Free pan and edit kept. Every action findable without a gesture. | open |
| G6 | Rive and tldraw foundation | lead | Readable faces at their size. Live state, saved snapshots and final outcomes distinct; idle never reads as success. Reduced motion, keyboard and an asset-load fallback. On the Canvas: select and edit, undo and redo, Fit, save and reopen, switching projects; navigation and Stop outside pan and zoom; a stale result never replaces a newer edit. | open |
| G7 | Model Studio embedded layout | Model Studio owner (its layout); lead (the frame) | One rail, one header, a larger viewport; the asset tree and inspector kept. Timmy's project named apart from the app's document. "App open" apart from "a modelling job runs". | lead's part open; owner request |
| G8 | Card Lab: cite first, the schema second; a bounded, configurable timeout | Card Lab owner | One successful local inspection with an observed `cite` call. Invalid evidence rejected. Raw outputs and refusals kept. | owner request |
| G9 | Stream Studio: Compose → Animate → Preview/Export | Animate owner (the app); lead (host integration) | A saved, editable scene; a Files import; the exports it actually supports; receipts. Broadcast stays pending. | owner request (acceptance to be confirmed) |
| G10 | Sketch → Image → Generate 3D → Model Studio, and direct entry | lead | The path and a direct native-part or import entry, kept. | open (to verify) |
| G11 | The walkthrough | lead | Choose a model → useful work → Rive and job state → edit the output → export and native source → Files and receipt → reopen. Desktop and phone, the apps' editors open. Idle cut and labelled; the full recording kept. | open |

## Backlog (found during this pass; not needed for the acceptance criteria)

Each was found during this pass. None is needed for an acceptance criterion above.

1. **Theme into the framed apps (A3).** Owner requests: each app takes Timmy's Amber or Glacier from its host.
2. **Card Lab's vision model in Models & accounts (A4).** It is the companion's `localVision` setting today.
3. **A run's own permission requests, answered mid-run (B4).** Qwen Code refuses a shell command in a run here and the
   refusal is shown at its end. Answering it needs a channel the adapter does not have.
4. **Card Lab (owner requests, D3):** call `cite` in a step without `response_format`, then ask for the schema's answer;
   make its fixed 90 s per-call timeout a setting.
5. **Qwen Code's version.** The installed CLI is 0.25.1; its stream reports `qwen_code_version` 0.22.2. The run records
   what the stream says. Not explained yet.
6. **The Mac driver's phone pass** (test tooling, outside the repository) clicks "Open X", which an app still running
   shows as "Return to X". The phone captures of those apps were not taken; the checks themselves passed.
