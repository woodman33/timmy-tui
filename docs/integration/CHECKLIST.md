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
| A1 | Shared navigation in and out of every app | lead: `companion/timmy-app/src/pages/miniapp.jsx`, `shell.jsx` | Each app opens from the rail inside Timmy's frame, in the active project. One "← Timmy" control and the rail stay visible. Leaving lands on the page the person came from. Same words in all four apps. | open |
| A2 | Project context | lead: `src/companion/miniapps/*` | The app works in the project the rail shows; switching project switches the app's data (C1, R13). The frame names the project. | done (R13, 23/23 on the Mac); the frame's label is open |
| A3 | Theme | lead: `companion/timmy-app` + gateway | Timmy's Amber or Glacier reaches the framed app. Where an app has no theme switch, that is said once. | open |
| A4 | Provider and model selection, one place | lead: Models & accounts; `registry.ts` env | An app's model need (Card Lab's vision model) shows in Models & accounts with its limitation. No app asks for a key Timmy does not pass. | open |
| A5 | Permissions | lead: `approvals.ts`, miniapp page | A native or paid action started from Timmy asks first (Animate's export tool does). The app page says what the app may do on this computer. | open (words) |
| A6 | App results come back to Timmy | lead: `src/companion/miniapps/receipts.ts`, Files, Runs pages | After a job ends, the project's Files shows its output files, under `from-apps/<app>/<job>/` with the bytes Timmy hashed, and Runs & receipts shows its receipt. Each file links to the receipt. | open |
| A7 | Card Lab journey: import an image → inspect → retain the result and evidence | Card Lab owner (app); lead (frame, receipt, Files) | A TEST card imported in the frame; its inspection run; the result and its evidence (image hashes, cited fields or the held reason) retained in Card Lab and in Timmy's Files and receipts. | **blocked for a successful live inspection** (D3). The import, retention and held-receipt path is open. |
| A8 | Film Room journey: ingest → annotate or analyse → export | Film Room owner (app); lead | A video ingested; an annotation saved in a Film Room project; clips rendered from it. The clips and the receipt in Timmy's Files and Runs. | open (the app supports it without a key; Roboflow analysis is not in scope: paid) |
| A9 | Model Studio journey: create a native part → edit → inspect → export source and preview | Model Studio owner (app); lead | An OpenSCAD part made; a parameter changed and rebuilt; its view inspected; the `.scad` source and a preview PNG exported to Timmy's Files with the receipt. | open (create, R13: done) |
| A10 | Animate journey: create or open → edit → export | Animate owner (app); lead | A composition from a template; an edit (a recipe or a path preset); a Blender export. The `.blend`, `.usda` and previews in Timmy's Files with the receipt. | open (export, R13: done) |
| A11 | One cross-app asset handoff | lead: Files "Send to"; the apps' own import routes | An Animate preview PNG, from Timmy's Files, opens as a new Card Lab run (Card Lab's own `POST /api/runs`). Card Lab shows it; Timmy seals a handoff receipt naming the source job, the sha256 and the target run. | open |
| A12 | Blank public starters and private projects kept apart | lead: the demo seed, `scripts/review` | The package's demo projects are blank or scripted-and-labelled. No private project or path is in the package. The review home's apps data stays under the sandbox. | done for the package (privacy hook, R13); recheck at qualification |

## B. Control Room (the order's item 3)

| # | Item | Owner and files | Observable acceptance criterion | Status |
|---|---|---|---|---|
| B1 | Launch from the Control Room | lead: `src/companion/panels/control.ts`, a launch route; `companion/timmy-app/src/pages/control.jsx` | The page proposes a run (harness, model, endpoint, workspace, time limit); Approve starts it as a durable job through the existing adapter (`timmy act "/agent <name> …"`, the same `/agent` path the REPL uses). | open |
| B2 | Two harnesses: OpenHands and Qwen Code, local models only | lead (adapters exist: `src/code-agents/openhands*.ts`, `index.ts`) | Each run has its own job id, operation id and agent run id, and an isolated workspace (OpenHands its container's copy; Qwen a workspace copy made for the run). | open. Mac inventory: Docker 29.8.2 (daemon answering), OpenHands CLI 1.16.0, qwen 0.25.1, Ollama 0.40.11. |
| B3 | Observe progress and logs | lead | The run's pane shows its progress lines and log tail while it runs, from the job's own record. | open (panes exist; launch-linked view open) |
| B4 | Approval when needed | lead | The launch is approved on the page before anything starts. Any NEEDS YOU of the run shows in the room's "waits on you". | open |
| B5 | Stop | lead | Stop on the page ends the job through its normal stop path (the act process's SIGTERM, which stops the agent's job and, for OpenHands, its container first). The record says stopped or interrupted, never succeeded. | open |
| B6 | Inspect outputs, diff and receipt | lead | After the end: changed files with the diff against the snapshot before, the final message, the exit and the receipt id, verified. | open |
| B7 | Identity consistent across surfaces | lead | The same project, harness, model, operation id and result in the Control Room, Runs & receipts and `timmy act`'s JSON. | open |
| B8 | Truthful interrupted and recovery states | lead (`/recover` exists) | A run whose launcher is killed shows interrupted; `/recover` settles it. | open |

## C. Rive and tldraw (the order's item 4)

| # | Item | Owner and files | Observable acceptance criterion | Status |
|---|---|---|---|---|
| C1 | Real Rive state machines bound to turn and job events | lead | Running, completion, stopped, failed and approval recorded at the runtime. | done for chat turns (R13 Mac 7/7). Job-bound face (B3) open. |
| C2 | Saved snapshots visibly distinct from live status | lead | A face showing a saved or recorded state says so in its caption ("AS SAVED", "recorded"). A live one is fed by events. | done for the provider and canvas faces (R12/R13); recheck on the Control Room's job face |
| C3 | The SDK's licence verdict with the operator's key | lead | "licensed", read from `LicenseManager.state`. | done (R13, Mac) |
| C4 | Mobile model chooser, with words fit for the layout | lead: `pages/chat.jsx`, `models.jsx` | At 390 px: the empty Chat names Models & accounts (no "column on the right", which a phone does not have); choosing a model from the phone works end to end. | open (the phone says "the column on the right") |
| C5 | Concise empty states; the composer reachable at once | lead: `chat.jsx` and the pages | At 390×844 the composer is in view without scrolling. The empty states are two lines and one action. | open |
| C6 | Status and action consolidated | lead | Each page says its state once, with one primary action, not a panel, a button and an empty state saying the same thing. | open |
| C7 | Endpoint details behind Details | lead | No `GET /api/...` or `POST /api/...` line on a page's face (the canvas cards, the Control Room, the records bar). They sit under a Details disclosure. | open |
| C8 | Consistent navigation into and out of every app | lead | = A1, checked at desktop and phone widths. | open |

## D. Correctness and isolation (the order's item 5)

| # | Item | Owner and files | Observable acceptance criterion | Status |
|---|---|---|---|---|
| D1 | The PTY failure | lead | Classified, fixed, original kept. | done (9bc2c3e3) |
| D2 | Direct worker-endpoint bypass and isolation across principals | lead | All of the R13 list. | done (050d5407; Mac 12/12 and 23/23 on 94b8979) |
| D3 | The observed-handle and `cite` evidence policy, enforced | Card Lab owner; lead (no bypass) | Timmy never relaxes it: a held answer stays held and its receipt says failed. Live success needs a model and provider that call `cite` while a strict schema is asked. On Ollama's OpenAI-compatible route, none did (R13: three models). | done for enforcement. A successful live inspection: **blocked**. Owner request: let the cite step run before the schema-constrained step, or name a supported local route. Hosted models are paid: held. |
| D4 | Durable operation ids, process outcomes, source revisions, canonical receipts | lead | Every journey's receipt carries the app's revision and the app's own end word, and is sealed once. | done for the apps (R13); recheck for Control Room runs (B7) |
| D5 | The video and animate commands and the agent and MCP adapters the journeys need | lead | `timmy video` and `timmy animate`; the 12 Animate tools. | done (R13, Mac 10/10) |

## E. Qualify and deliver (the order's item 6)

| # | Item | Acceptance |
|---|---|---|
| E1 | One candidate revision, built from a clean source state | `scripts/review/build-review.sh` refuses a dirty tree; the package's checksum. |
| E2 | The required checks on that revision | The full suite under the heavy lock, exit code kept; runner errors kept. A fix after it means a new revision and the checks that fix needs. |
| E3 | The Mac sandbox install and the journeys | A fresh folder through `./timmy-app`; A7–A11 and B1–B8 exercised; C4–C8 seen at desktop and phone widths. |
| E4 | Deliverables | The package and its checksum; launch and stop; desktop and phone captures. A short recording: real Rive transitions, an app result coming back into Timmy, a Control Room launch and Stop. The results tied to the candidate; the remaining blockers. |

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

## Backlog (found during this pass; not needed for the acceptance criteria)

(empty at the start)
