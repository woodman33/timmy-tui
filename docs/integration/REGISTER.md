# Timmy mini-app integration register

Version 3, 2026-10-26 (the operator's 15:31 PT acceptance order; version 2 the same day with the owners' checkpoints, version 1
before them). One writer: the Timmy lead (the designated
integrator). Owners keep their apps' code; a change to an owner's file goes to that owner as a request. Facts here are what
was observed on the date given, with the check that observed it; "not observed" means not known.

## Integration base

- **Branch:** `r13/integration`, from `r12/rive-tldraw-app` at **a753bed9** (draft PR #108's head, its privacy check green).
- **Destination:** draft PR #109 from `r13/integration` into `r12/rive-tldraw-app`. Merge, publish, tags, deploy and the
  global install are on HOLD.
- **Other checkouts (not the base, left as they are):**
  - the operator's own checkout at 08006fb9: an ancestor of a753bed9; never touched;
  - a second local checkout of `main` at c3b4b208 (2026-09-18): about 50 commits never pushed, 37 modified and 281 untracked
    files, including the then-untracked Timmy Animate folder. Not on GitHub, so not mergeable as a base.
- **The Mac review installs** (:4443, package 66fc3e4) are review packages, not sources.

## Owner checkpoints (2026-10-26)

A Codex chat contacted the three app owners and returned their checkpoints in one packet (`r13-owner-checkpoints`, 22 files,
every SHA256SUMS line verified by the lead). Version 1's "awaiting owner checkpoint" rows were the lead's view before that
packet; the owners were contacted, by that chat, not by the lead.

| App | Owner | Checkpoint the lead holds | How the lead verified it | The owner's own qualification (as reported) |
|---|---|---|---|---|
| Model Studio | Codex `timmy-new-1` | `codex/model-studio` **a5264eb5** (one commit over aabe7c1a: clean-clone build without `public/`, and the cancellation escalation fix) | bundle fetched, `git bundle verify`; built from a clean archive | Mac: 51/51 tests, 0 skipped; fresh `npm ci` clone build exit 0 |
| Card Lab | Codex "Timmy Card Lab" | `codex/card-lab-checkpoint` **7176ad97** (6431f8fb + its working tree), imported here as 6f780771 (tree 39b1019b) from the owner's patch | `git am` on 6431f8fb; all 161 source-manifest hashes match; built | 45 proxy/auth checks passed; its app suite timed out twice (120 s, 90 s): **unresolved** |
| Film Room | Codex "Analyze NFL footage with AI" | `codex/film-room-checkpoint` **f9db9fe0** (parent ecca8f44), from the owner's bundle | `git bundle verify`; built | 131 app tests and its build passed |
| Timmy Animate | Codex "Assess a 2D animator mini app" | v6 source archive, payload manifest **68c2f853** (no commit claimed) | archive hash matches the packet; built (npm install, no lockfile of its own) | 59 fresh tests passed |
| Stream Studio | **none assigned** | — | — | not built, not qualified |

## Apps

| App | Source hosted | Status | Receipts | Next action (owner unless marked lead) |
|---|---|---|---|---|
| Model Studio | a5264eb5, `git archive` in the review package (`apps/model-studio`) | **hosted** (C1) | its `/api/state` jobs | — |
| Card Lab | 7176ad97 (as 6f780771), `git archive` | **hosted** (C1, local mode); live inference **not established** (below) | each ended launch of a run (`run.json` events) | its vision stage's evidence protocol with local models (below); drop the personal license path in local mode; shared assets and provider approval (lead) |
| Film Room | f9db9fe0, `git archive` | **hosted** (C1); `timmy video` | its `jobs/<id>.json` | Airtable and Roboflow sign-ins here; `mcporter` in its package.json |
| Timmy Animate | v6 archive 68c2f853 | **hosted** (C1); `timmy animate`, 12 agent and MCP tools | its `<id>/job.json` exports | commit it to its own repository; port 4318 vs 4327; scene persistence beyond browser storage |
| Stream Studio | — | **no owner; not built** (its page and the rail say so) | — | the operator assigns one owner (below) |
| Control Room | the lead | inventory done | — | one harness id, distinct states, the scoped packet relay (lead) |

The owners' copies and the packet are the lead's private working material: never committed to this public repository.

## How an app is hosted (C1)

- A hosted app runs as a durable **server job** of the principal's Timmy home (`src/jobs`, `envExact`: only the variables its
  registry entry allows; never a provider key, a token or a paid-call switch), its data in
  `<home>/apps/<app>/<project id>`: separate per principal and per project.
- The page reaches it only through a loopback gateway that answers the browser holding the gateway's cookie, given for a
  one-time launch key (60 s) from `/api/apps/:id/open` (launch token and session checked). Grants last 15 minutes unless the
  page renews them (every 5 minutes, which needs a valid session), at most 16 per app; opening the app in another project
  ends the principal's grants in the first; `/api/apps/revoke` (before sign-out) ends all of the principal's grants.
- The app's own Host and Origin checks still pass; its `frame-ancestors` names Timmy's origin (and `X-Frame-Options` is
  dropped); no cookie or referer is forwarded.
- **The worker port (R13, 050d5407):** each app runs under `node --require <home>/apps/.timmy-worker-guard.cjs` with a fresh
  `TIMMY_WORKER_SECRET`; every request and upgrade to any server in that process without the `x-timmy-worker` header answers
  403 ("This app answers only through Timmy."); the gateway adds the header, the secret is removed from the app's env and from
  the request. No owner change was needed. Checked on the four real apps (container and Mac) and for two signed-in users.
- **Not isolation:** a filtered environment and data folder are not a filesystem boundary.
- Spending hold: no paid switch reaches an app. Model Studio's Tripo and OpenRouter routes answer "held"; Card Lab's vision
  stage is held without a key ("No model has run").

## Reconciling the owners' host patches with C1

The packet carried two reference host patches written against a753bed9. C1 is the one host; nothing from them was applied
wholesale. Each part, with what was done:

| Owner patch | Its part | Decision |
|---|---|---|
| Film Room `host-integration-reference.patch` | `src/miniapps/video-analysis.ts` (launch at `/api/miniapps/video-analysis/launch`, a sub-path, a context id) | **superseded** by C1's gateway at the app's root; the app's `public/host-bridge.js` stays a no-op there |
| | launch-grant exhaustion, sign-out revocation, project switch | **covered** in C1: grant cap 16, 15-minute grants renewed by the page, `revokePrincipal`, `revokeOthers` (`tests/miniapps-host.test.ts` isolation) |
| | `src/companion/server.ts` mount and shutdown, `src/companion/timmy-app.ts` frame policy | **covered**: `mountMiniApps` and `stopAll`; `frame-src` loopback |
| | Apps UI (`api.js`, `nav.js`, `pages/apps.jsx`, `apps.css`) | **covered** by the APPS rail and `pages/miniapp.jsx` |
| | `src/cli.ts` `timmy video` | **imported through C1** (c296e14e): `src/miniapps/app-commands.ts`, `src/companion/miniapps/session.ts` |
| | packaging (`package.json`, lock, `scripts/miniapps/build-video-analysis.mjs`) | **superseded**: the review package builds each app from its own source (`scripts/review/review.sh` `mini_apps`) |
| Film Room `shared-react-dedupe.patch` | `scripts/canvas/build.mjs` React alias | **not applied**: C1 does not bundle any app into Timmy's canvas bundle, so there is no second React to dedupe |
| Animate `animate-host.patch` (13 files) | `src/companion/server.ts`, `src/companion/client/index.html` | **superseded** by C1 (the app is framed, not mounted in the companion DOM) |
| | `src/animate/launcher.ts`, `src/animate/companion.ts` (own server on 4327) | **superseded** by the host's server job |
| | `src/cli.ts`, `timmy.ts`, `src/utils/slash-commands.ts` (`timmy animate`), `src/agent/tools.ts`, `src/agent/animate-tools.ts`, `src/mcp/server.ts` (agent tools, MCP) | **imported through C1** (c296e14e): `timmy animate`; the owner's 11 authoring tools (read-only) and `timmy_animate_export` (a receipted Blender job, asks first) for the agent and MCP; the slash command not imported |
| | `tests/animate-entry.test.ts`, `tests/animate-tools.test.ts`, `package.json` | follow the parts above |

## Receipts

`src/companion/miniapps/app-jobs.ts` reads each app's own record of its jobs; `receipts.ts` seals one receipt per ended job
into the project's `runs` chain (`appendReceipt`: hash-chained, signed where the store signs), kind `miniapp`, with the
app's own word for the state, Timmy's outcome from it (only the app's success is `ok`; failed, held and interrupted are
`failed`; cancelled is `cancelled`), the job's files hashed by Timmy from the bytes the app serves (a file it does not serve is
named under `outputs_unhashed`), the sha256 of the app's record, the app's revision, the principal and the project. Each job is
sealed once: the ids file beside the data folder, and the chain itself (a restart without the file seals nothing again).
`started_by` stays "not observed by Timmy". Tests: `tests/miniapps-jobs.test.ts` (each app's format), `tests/miniapps-host.test.ts`.

- REAL apps in the container, through the gateway, no key, no paid call: Card Lab's predict launch ended `held` → receipt
  `failed` with the app's message; Film Room ingested a FAKE 1-second test pattern → receipt `ok`, its file hashed by Timmy
  (matching the file's own sha256); the chain verified, both signed. Model Studio and Animate jobs need their native engines
  (Mac).

## Findings for owners (requests, not changes made)

- **Model Studio:** its own port answers any loopback client that names its host (a shared secret from Timmy is the owner's
  change). The Linux cancellation record (aabe7c1a, 47/48) is classified below.
- **Card Lab:** home paths and deployment details in committed docs and production files; a personal tldraw license path
  in local mode; single-owner auth only; no Airtable. Its app suite's timeout is **not reproduced**: 151/151 on Node
  22.22.0 (the closest here to the owner's 22.22.2; `npm test` and the direct `node --test`, 20 to 24 s, under load),
  24.21.0, 24.14.1 and 26.6.0. Its vision stage (live inference, below): one fixed 90 s limit per provider call
  (`backend/providers.mjs`), not configurable; it asks for the `cite` tool and a strict JSON schema, and no local model
  here called the tool.
- **Film Room:** its bridge expects the superseded sub-path contract (above); `mcporter` is used but not in its package.json.
- **Animate:** default port 4318 in `server.mjs` against 4327 in its README and CLI; macOS paths in `server.mjs` and
  `integrations/`; scene persistence in browser storage only; no lockfile. A cancelled export's `job.json` says cancelled
  only once Blender has exited, after its API does (Timmy now waits for the record: c4ef681d).
- **Film Room:** a render manifest must name its asset (`validateManifest`); `timmy video render` names the chosen one in a
  manifest that names none, and says so.

## Model Studio's Linux cancellation record, classified (lead, container, 2026-10-26)

| Test | Code | Result |
|---|---|---|
| old test | old (aabe7c1a) | fails 3/3: the owner's real bug (escalation cleared when the leader exited first) |
| old test | fixed (a5264eb5) | 2/3: its 100 ms ESRCH check also sees an unreaped zombie here (PID 1 is not an init that reaps) |
| new cancellation tests | fixed | 5/5 in each of 5 runs; full suite 51/51 |

## Control Room inventory (2026-10-26, read from a753bed9)

- Three state vocabularies (runtime profiles, the capability inventory, the capability ladder); **no "authenticated" state**:
  keys are checked for presence only. "Exercised" = a signed receipt on the runs chain.
- Harnesses: OpenHands, Qwen Code, OpenCode, Claude, Codex run as `/agent` jobs with receipts; jcode, Minds and Pi run as
  tmux lanes with a launch receipt only; Hermes' receipts are written off the chain; Kimi Code and Cline are profiles only;
  Gemini CLI and Kura have no adapter. `src/pi-durable/*` is imported only by tests.
- Nearest relay seam: `src/utils/dispatch.ts` (plan → arm, approval bound to the plan hash → dispatch → cancel → collect),
  with `context-cone.ts` budgets; no relay, packet type, dedupe or hop limit exists yet.

## Review package (reproducible)

`scripts/review/build-review.sh` packs Timmy, resolves an install lock at build (`install-lock/package.json`,
`package-lock.json`, `resolved-with.json`: Node v24.21.0, npm 11.19.0, 434 packages for b40df81) and carries each owner's
app at its exact source with `.timmy-source.json`; `review.sh` installs with `npm ci` from that lock and records
`sandbox/installed-with.json`. `./timmy-app` opens the app; a bare `timmy` opens the terminal REPL.

## Qualification state

- **dd2c1350, kept as run** (frozen worktree, 2 workers, under the heavy lock, 11:41–12:43 PT): **exit 0**, 779 files passed /
  16 skipped, 6416 tests passed / 136 skipped, 0 failed, 3731 s. One lock-free 3 s run of `miniapps-host` overlapped it.
- **Mac, installed package 66fc3e4** (fresh home): Model Studio opened from the rail inside Timmy's frame; 5 engines
  available (Blender, OpenSCAD, FreeCAD, build123d, CadQuery; C4D and Houdini not); a real OpenSCAD parametric box
  40 × 30 × 10 mm succeeded in 2 s; phone layout; stopped through its job. The Rive status face's motion was not checked.
- Containers, REAL owners' apps: all four opened framed through C1 in Chromium with no page error.
### Candidate 030d0942 (2026-10-26): FAILED / HOLD on one test, kept as run

- **Full suite** (frozen worktree, clean, 2 workers, under the heavy lock, 13:38–14:39 PT): **exit 1**: 779 files passed,
  1 failed, 16 skipped; 6423 tests passed, 1 failed, 136 skipped; 3649 s. The failure:
  `tests/chat-one-conversation-pty.test.ts` (the REPL in the project's one conversation) timed out after 50 s waiting for
  "RECEIPT … signed and verified" on the terminal screen; on dd2c1350 it passed in 6.7 s. The source changes since dd2c1350
  are the mini-app modules and one type-only field in `src/utils/receipts.ts`; the REPL imports neither module. The run's
  load was about 4 on 2 cores, and the lead ran a low-priority `tsc` and one 2 s test file in another worktree at 13:51
  (during it). **Unclassified:** not repaired, not rerun; a single-test rerun to classify it is a separate step. An earlier
  start at 13:36 was stopped by the lead after about a minute, before any file result, and kept as a separate log.
- **Mac, the installed package 030d094** (fresh `npm ci` from its lock: Node 26.6.0, npm 11.18.0 on the Mac; the lock was
  resolved with Node 24.21.0, npm 11.19.0; 392 packages added against the lock's 434 entries, the difference not examined);
  the package's demo home (principal `operator`, projects tray and blank); real apps and engines, no key, no paid call:
  **22 of 23 checks passed.**
  - Model Studio: OpenSCAD box `succeeded` (receipt `ok`, 2 files hashed); a Blender create cancelled while running
    (`cancelled`). Engines seen: Blender, OpenSCAD, FreeCAD available; build123d, CadQuery, C4D, Houdini not.
  - Timmy Animate: a Blender export of its example scene `succeeded` (8 artifacts hashed); a second export cancelled.
  - Film Room: a FAKE 1-second test pattern made with ffmpeg on the Mac ingested (`complete`, its media hashed).
  - Card Lab: its predict stage `held` without a key (receipt `failed`; "No model has run").
  - Every receipt signed, principal operator, project tray; the chain verified (before and after the steps below).
  - Isolation, one principal and two projects: a launch key works once (302, then 403); no grant, no answer (401); an
    artifact downloads with the grant and not without; blank has its own worker and data and none of tray's jobs; opening
    in blank ends the grant in tray; tray's cookie is no grant at blank's gateway; renewal; sign-out revocation ends the
    grant; reopening and a companion restart sealed nothing twice; after the restart the old gateway refuses connections,
    an old cookie is no grant, and the saved jobs are there; no answer names a worker port.
  - **Failed check:** "each app names its installed source": Animate's package record has no commit, so the listing showed
    none. Fixed after the run in cae6a6b7 (the archive's label is named); not part of this candidate.
  - **Not established:** the Rive status face's motion (the screencast's changed regions were the 3D viewport); the tldraw
    licence verdict (no watermark element and no licence console line on 127.0.0.1, where tldraw shows neither anyway);
    two principals on the Mac (no sign-in is configured there; two-principal isolation is covered by FAKE-principal tests
    only); the worker port's own loopback exposure (unchanged; the owner's change).
  - An earlier attempt the same hour stopped at the isolation step on a driver error (it named projects by name, which the
    companion does not resolve); kept as run, labelled incomplete.

## The operator's 15:31 PT acceptance order (2026-10-26), item by item

1. **The PTY receipt timeout (030d0942): a real defect, classified and fixed** (9bc2c3e3). The original failure stays in its
   kept log. The Enter of a message typed before the REPL's first prompt took raw mode went through the cooked terminal
   (ICRNL) and was read as Ctrl+J. A new PTY test reproduces it deterministically, with the same screen as the suite failure.
   Two more lost-keys defects were found while classifying: the colour probe dropped typed bytes, and the turn's Ctrl+C
   watcher dropped keys typed during a turn. A passing rerun was not taken as the classification.
2. **Rive and tldraw, installed (Mac, the candidate below):** the SDK's own licence state (its `LicenseManager.state` atom,
   read through the app's readout) is **licensed**, with no watermark drawn, using the operator's key from the licence file
   (handed to the companion only; never printed or written). The AgentConsole's state machine (TimmyUI) was recorded at the
   runtime through four real turns from the page, on a local Ollama model (no spend):
   - completion: Working → Idle (SSE `turn` … `done` ok, the receipt verified);
   - approval: Working → Approval (SSE `needs-you`), answered on the native ActionButton, → Working → Idle;
   - cancellation: Working → (stopping, State held at 1) → Stopped (SSE `done` cancelled);
   - failure: Working → Failed (SSE `done` failed). **Induced:** a loopback relay answered Ollama's HTTP 500 for that turn.
   Every sample's word matched the runtime's own `State` input (0 Idle, 1 Working, 2 Approval, 3 Stopped, 4 Failed). The
   runtime's `onStateChange` reported the states Working, Idle, Approval, Stopped and Failed. Kept: the screencast as a short
   recording (`rive-transitions.mp4`) and the timeline.
3. **The direct worker-port bypass: closed** (050d5407; above). Checked against the real companion and Film Room with two
   distinct signed-in users (the companion's own Clerk-format verifier, a test instance made for the check), each with their
   own two projects: cached app state, events, artifacts, job cancellation, project switching, sign-out, revoked grants
   and reconnect, through the gateway and **directly at each worker port** (every direct request 403, cancel included):
   12/12 in the container and 12/12 on the Mac, on the installed package.
4. **The C1 adapters** (c296e14e, d1228eed, c4ef681d): `timmy video` (status, assets, import, render, jobs, job,
   `--cancel-after`), `timmy animate` (doctor, render, job, and the owner's authoring CLI), and Animate's agent and MCP tools,
   all through the one host. Each prints the app's own end state and the receipt Timmy sealed for that job. On the Mac
   (installed package): an ingest ended complete (receipt ok); a two-clip render ended complete (ok); a render cancelled
   (cancelled); a Blender export succeeded (ok) and one was cancelled (cancelled); the installed `timmy mcp serve` lists the
   12 Timmy Animate tools, and its `timmy_animate_export` ran Blender to succeeded and returned its receipt. The chain
   verified. The owners keep their code.
5. **Card Lab:** the hosted UI works (opened in Timmy's frame on the Mac; its job receipted). Live inference is **not
   established**: on the Mac, its vision stage was pointed at models already on this computer (loopback only, no key, no
   cloud tag, no spend; `localVision`, 35711cf7):
   - gemma4:12b-it-qat, cold: held at Card Lab's own fixed 90 s limit, twice. Warm: it answered in 70 s, reading the TEST
     card correctly ("SAMPLE SPARKMOUSE", 058/102), but its JSON ended with a stray template token (`<|tool_response>`), so
     Card Lab held it as non-JSON ("retained without repair"). The same model answered a plain request in 32 s.
   - gemma4:26b (68 s) and qwen3.8:27b-mlx (81 s) returned schema-shaped answers with **no `cite` tool call**, so Card Lab's
     evidence validation held both ("no successful observed cite call").
   The remaining blocker is not a credential: it is Card Lab's protocol (the cite tool alongside a strict JSON schema, and a
   fixed 90 s per call) with these local models. A hosted model is a paid call and stays held. The app-suite timeout is not
   reproduced (above).
6. **The entry point:** the README opens with Timmy App.command and `./timmy-app`; the terminal is kept and named after it.
   Found while qualifying: the launcher set `TIMMY_LOGS_OPEN=0` for every command, so `./timmy-app` opened nothing and still
   said "Opened in your browser." Fixed in 7bf70af0: only the app case opens a browser, and the words say what happened. On
   the Mac, `./timmy-app` handed the browser opener Timmy's private launch page (a stand-in `open` recorded it, so no window
   opened there). That page took a headless Chrome into the app with its token, at desktop and phone widths. **Stop:** q,
   Ctrl+C or SIGTERM says "Timmy app stopped."; `./review.sh census` then counted no process in the sandbox.

**Stream Studio:** no owner exists (the register, PRs, branches and the owners' packet name none), and nothing was built
for it here. Its page says so. The bounded task, for the owner the operator assigns (the lead's proposal: the Animate
owner, whose motion engine and exports it builds on), stays **unbuilt** until then:
- a hosted app under C1 with an HTML overlay or page composer;
- an OBS or MediaMTX output;
- receipts for each published scene;
- no paid service.

## A home folder's receipts store took the review demos' receipts (found 2026-10-26, fixed in d1228eed)

The legacy store lookup (`rootStoreDir`, Pass 2: the nearest `package.json`) skipped no folder. On the Mac, a
`package.json` in the home folder made every Timmy project below it with no store pin seal into the home folder's own
`.timmy/receipts/runs.jsonl`. That included the review packages' demo projects, whose sandbox HOME is below the real one.

- The operator's store holds 53 lines. The first 6 (2026-09-01 to 2026-10-22) are the operator's. The other 47 come from
  review packages' demo seeding and the lead's Mac checks of 2026-10-26 (local time): intake, vox, predict and workflow
  receipts of five demo projects, and 22 mini-app receipts.
- **They were not removed:** the operator's store is not rewritten without the operator's word.
- From d1228eed on, neither HOME's folder nor the account's own is a store root through a `package.json`. The Mac run of
  c4ef681d left that file unchanged (53 lines, the same sha256 before and after).

## Candidates since 030d0942, kept as run

- **35711cf7:** its full suite was stopped by the lead after 12 minutes (172 files passed, none failed), when the
  entry-point defect above was found. Its README change had not updated `tests/review-one-command.test.ts`; that would have
  failed.
- **7bf70af0:** full suite stopped at 76 files passed, none failed. Its Mac run found the home-store lookup; also a FAKE app
  that accepted any render manifest (the real Film Room refused one with no asset, 409).
- **d1228eed:** full suite stopped at 76 files passed, none failed. Its Mac run (launch 7/7, isolation 23/23, two users
  12/12, Rive 7/7, commands 9/10) found that `timmy animate render --cancel-after 1` printed no receipt; the receipt was
  sealed, cancelled, at the next open.

- **c4ef681d:** Mac 59/59 (the same five runs as below). Its full suite was cut off when the container restarted mid-run
  (no exit line; kept as run). Before the restart it had failed two tests in `tests/capabilities.test.ts`: c296e14e gave
  the 12 Animate tools no capability-ladder row. Fixed in f2e8fbc8.
- **f2e8fbc8:** Mac 59/59. Its full suite: **exit 1**, 782 files passed, 1 failed, 16 skipped; 6444 tests passed, 1 failed.
  The failure: `tests/timmy-app-browser.test.ts` "configure" read the focus right after the aid landed, but the aid moves
  the focus 420 ms later (its smooth scroll; deliberate). It failed every time on the idle machine and passed whenever the
  read came later. A test defect, fixed in 94b89793 (test only).
  - **Disk:** the container's disk allowance was nearly spent: 32 MB free, from about 37,000 old test temporary folders in
    `/tmp`. With the browser starved, the same file then failed 9 of 10 (`net::ERR_INSUFFICIENT_RESOURCES`). The lead freed
    its own copies; sweeping `/tmp` was refused, as shared scratch.
- **94b89793, first run:** with the suite's TMPDIR moved into a folder of the lead's (to spare the disk): exit 1, 4 files
  failed, kept as run (`full-94b89793.tmpdir-run.log`).
  - Three failures were caused by that long path, as each file showed when rerun: a banner wider than 60 columns, a tmux
    socket path too long for its server ("server exited unexpectedly"), and an excerpt cut before `./notes`.
  - The fourth (`recover-agent-record`) passed alone with both TMPDIRs. That one is not explained beyond this.
  - The run below uses the default TMPDIR.

### The qualified candidate: 94b89793 (2026-10-26)

Code as f2e8fbc8, plus the one test fix. Every check below ran on these exact bytes.

- **Full suite** (frozen worktree, clean, 2 workers, under the heavy lock, the default TMPDIR, 21:04–21:47 PT): **exit 0**.
  783 files passed, 0 failed, 16 skipped; 6445 tests passed, 0 failed, 136 skipped; 2581 s. 708 MB free at the end. The
  log's sha256 is `d60b0c26b12a99b43d8065ff6cea7895e70e8134ed89cb979192327d56c97614`.
- **The review package** `timmy-review-94b8979.tar.gz`, sha256
  `4555a1942533c2dc5aa3d127eadb73041f7a53f92213a14ba802f0d837b9c28a`. It carries Model Studio a5264eb5, Card Lab 7176ad97,
  Film Room f9db9fe0 and Timmy Animate (v6 archive 68c2f853).
- **Mac, that package, fresh folder:**
  - `./timmy-app`'s first run checked SHA256SUMS, did `npm ci` from the lock (Node 26.6.0, npm 11.18.0; resolved with Node
    24.21.0, npm 11.19.0) and built the four owners' apps inside the package.
  - Everything ran on real apps and engines, with a local model only, no key and no paid call.

  | Run | Checks |
  |---|---|
  | Entry point, desktop and phone (launch page → app with its token; Chat; licensed Canvas; Card Lab framed; Stream Studio says not built) | **7/7** |
  | Isolation and receipts, one principal, two projects, a restart | **23/23** |
  | Two signed-in users, the worker port tested directly | **12/12** |
  | Rive and tldraw (four real turns; the failure induced at a relay) | **7/7** |
  | `timmy video`, `timmy animate`, the installed `timmy mcp serve` | **10/10** |

  - `timmy receipts` verified.
  - The census after the app stopped, and again at the end, counted no process in the sandbox.
  - The home folder's store was unchanged: 53 lines, the same sha256 before and after.

**Launch:** unpack, then double-click `Timmy App.command`, or `./timmy-app`. **Stop:** q or Ctrl+C in its Terminal window
("Timmy app stopped."). Then `./review.sh census` should count no process. The terminal: `./timmy-review`.

## The integrated review candidate: 4d59da6e (2026-10-27, the operator's 01:46 PT order)

The fixed checklist for this order is `CHECKLIST.md` (A1–A12, B1–B8, C1–C8, D1–D5, E1–E4, F and a backlog), each item
with its owner, its criterion and its status.

**Development runs on the Mac before it, kept as run:**

- **79050917:** most journeys passed. Found: an interrupted run left its agent running (the act was spawned through the
  `dist/timmy.js` wrapper, whose CLI child survived the kill); Model Studio's `.scad` was not among the files hashed; the
  A7 check could not fail. Fixed in 5e89c798 (spawn `dist/src/cli.js`; the files listed; A7 tightened and A7-live added).
- **5e89c798, 87730cf8:** Qwen Code on gemma4 and qwen3.8 created no file: `--bare` has no `write_file`, and
  `--core-tools` is ignored in bare mode. 87730cf8 passes `--core-tools read_file write_file edit glob grep_search
  list_directory` instead and gives a qwen run its own agent home. On 87730cf8 every check passed but A9's `.scad`
  (Model Studio lists it under `artifacts`, not `files`; fixed in 4d59da6e) and A7-live (blocked, D3).

### The candidate 4d59da6e

- **The review package** `timmy-review-4d59da6.tar.gz`, built from a clean tree (exit 0), sha256
  `4e00d337a451966cffaf437d7d3f24d69450b129171e0bdc451fe529d6c27a4a`. It carries the same owners' apps as 94b8979.
- **Full suite** (frozen worktree, clean, 2 workers, under the heavy lock, 03:14–04:05 PT, 3076 s): **exit 1**, kept as
  run. 784 files passed, 1 failed, 16 skipped; 6451 tests passed, 2 failed, 136 skipped. Log sha256 in
  `full-4d59da6e.log.sha256`.
  - Both failures were in `tests/miniapps-handoff.test.ts`: the fake Card Lab's `frontend/dist/index.html` was ignored
    by `.gitignore` (`dist/`). The working tree had it untracked; a clean checkout did not, so the host said the app was
    not built (409). A test defect.
  - **fd866755** tracks that file (test only; `src/`, `companion/` and `scripts/` are byte-identical to 4d59da6e). The
    checks it needs, on a clean checkout of fd866755 under the lock: `miniapps-handoff`, `miniapps-jobs`, `miniapps-host`
    and `control-runs`, 23/23, exit 0. The Mac results below stand for the product bytes.
- **Mac, that package, a fresh folder (03:14–03:26 PT):** `npm ci` from the lock, real apps and engines, a local model
  (gemma4:12b-it-qat on Ollama) only, no key, no paid call.

  | Run | Checks |
  |---|---|
  | Entry point, desktop and phone | **7/7** |
  | Isolation and receipts, one principal, two projects, a restart | **23/23** |
  | Two signed-in users, the worker port tested directly | **12/12** |
  | The journeys (A6–A11, C5, C8, B1–B8) through the app's own pages, recorded | **19/20**: A7-live blocked (Card Lab held its answer; its 90 s per-call timeout; D3) |
  | Rive and tldraw (four real turns; the failure induced at a relay) | **7/7** |
  | `timmy video`, `timmy animate`, the installed `timmy mcp serve` | **10/10** |

  - The census after the app stopped, and again at the end, counted no process in the sandbox.
  - The home folder's store was unchanged: 53 lines, the same sha256 before and after.
  - The driver's phone pass clicked "Open X" where a running app shows "Return to X", so phone captures of those apps
    were not taken (backlog 6); the checks passed.

**Remaining blockers:** OpenHands (the image timmy-openhands:1.21.0 is not built; building it downloads python:3.12-slim
and the OpenHands SDK: the operator's decision); a successful live Card Lab inspection (D3 and its 90 s timeout: owner
requests); Stream Studio has no owner (F).
