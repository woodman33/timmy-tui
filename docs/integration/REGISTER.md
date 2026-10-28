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

## The operator's 05:03 PT order (2026-10-27): the Rive UI, tldraw workspaces and the mini-app experience

Checklist section G. The test record of 4d59da6e and fd866755 stands as written above.

| Revision | What | Checks |
|---|---|---|
| bb2b9583 | Control Room one outcome; phone Chat one setup action; Files results by name, Sent to Card Lab and Open inspection; quieter records; the app bar | targeted files and `tests/timmy-app-g-browser.test.ts` (FAKE Ollama, act, Card Lab) |
| 8113d1a8 | a phone's Canvas (Overview first, buttons, a focused card); Rive faces drawn for their zoom | the same; **the Mac**, a fresh install of its package (sha256 `9555983d…7e9c`): launch 7/7, isolation 23/23, two users 12/12, journeys 25/27, Rive and tldraw 7/7, commands 10/10 |
| b38e6896 | `timmy app` survives a second stop signal during shutdown (the Mac printed no "Timmy app stopped.") | `tests/timmy-app.test.ts`, `review-launcher-node`; the Mac below |
| 0bde3030 | a stopped run says "Stopped from the Control Room" (the Mac: "Stopped by the Control Room's Stop") | **the Mac**, a fresh install of its package (sha256 `7599a3ed…f2c8`): the launch check, the stop line, the journeys 26/27 |

- **8113d1a8 journeys, the two not passed:**
  - G1: the stopped run's words; fixed in 0bde3030.
  - A7-live: Card Lab held its inspection after its 90 s timeout.
- **0bde3030 journeys:** the one not passed is A7-live. Card Lab held its inspection again, this time refused with "no
  successful observed cite call" (checklist D3 and G8).
- **0bde3030 checks:**
  - the launch check passed, and the app printed "Timmy app stopped.";
  - the census was clean after the app stopped and at the end;
  - the home folder's store was unchanged (53 lines, `4410dc0ae942ca6c`).
- **Not run on 0bde3030** (unchanged code since 8113d1a8, where they passed): isolation, two users, Rive and tldraw, and
  the commands.
- **No full suite** has run on any of these revisions.
- **Owners:** not reachable from the lead's session. The relay messages (Card Lab: cite first, the schema second, and a
  bounded timeout; Animate: the Stream Studio milestone; Model Studio: an embedded layout; all: the theme parameter) were
  handed to the operator for the Codex coordination chat.

## The shared-integrator order (2026-10-27, 06:11 PT): Treg, Tools & integrations

Checklist section H.

| Revision | What | Checks |
|---|---|---|
| 37fa0cba | the host side of the theme contract v1; no empty panes panel under a finished run | targeted files |
| 92d2368c | Treg adopted: Timmy's bridge, the host's connector operations (discover, free calls, a paid call only from an approved proposal, Stop, Recover, a connector.call receipt); Tools & integrations' Treg and tldraw cards; review.sh's TREG_CONFIG | `tests/treg-bridge.test.ts` 7/7 (a FAKE remote), `tests/connector-ops.test.ts` 5/5 and `tests/timmy-app-integrations-browser.test.ts` 2/2 (a FAKE Treg server), with nine neighbouring files: 12 files, 102 tests. **The Mac**, a fresh install of its package (sha256 `6caea05d…c36f`), with Card Lab 342c0f72 and Film Room 8c3cd19f |

- **92d2368c on the Mac:**
  - the launch check passed; the app printed "Timmy app stopped."; the census was clean;
  - the journeys: 28 of 32 checks passed. Two of the four failures came from the driver (its theme step waited for a page that a same-address
    navigation never loaded). The theme check, run again alone with the corrected step, passed for both apps;
  - A7 and A7-live are not passed as written: they ask for a named identity. Card Lab ended the inspection ready, with one
    observed cite call (`call_kw72tmma`) of its run's handle and source revision, and answered "unknown": the image handed
    to it was an Animate export, not a card. Its raw requests, responses and the cite record are kept in its run folder;
  - Tools & integrations: Treg's bridge and both routes installed, not signed in (the review names no Treg sign-in),
    Discover refused before anything was sent;
  - the home folder's store was unchanged (53 lines, `4410dc0ae942ca6c`), before and after both passes.
- **No live Treg call** was made by the lead in any check. The operator's one TikTok call and the checkpoint's catalog
  call (operation o46e6011a, receipt 5550b296) stay the only live Treg records; they are in the private checkpoint, not here.
- **Not run on 92d2368c:** isolation, two users, Rive and tldraw, the commands (unchanged since 8113d1a8, where they passed).

## The completion pass (2026-10-27, 07:37 PT): one Mac review candidate

Checklist section I (gaps I1–I11). Owner revisions adopted, each checked against its own id before use:

| Owner | Adopted | How its bytes were identified |
|---|---|---|
| Card Lab | runtime 6f166d2d, HEAD 16a6ac71 (documentation only) | git bundle of `codex/card-lab-checkpoint`; 10 uncommitted owner changes not imported |
| Film Room | adfb7a74 | git bundle of `codex/film-room-checkpoint` |
| Model Studio | 8266c20a (operator-approved; embedded layout 39633703/ba96a0a8 under it) | git bundle of `codex/model-studio` |
| Stream Studio | content sha256 2be70c25… (no commit) | 64 files, each matching the owner's `source-revision.json` |
| Animate | v8 by the owner's manifest: content revision 6e2151ab…, 262 files (the v7 archive plus the 11 v8 files `preservation.json` names) | not the enclosing repository's HEAD |
| OpenHands | b56c36f0 (base 08006fb9) | its patch, applied with three conflicts resolved (38177536) |
| Control Room | 2a798e1f handoff (review material) | read only; its connector-call card built on the host's records |

| Revision | What | Checks |
|---|---|---|
| 38177536 | OpenHands attempts reconciled into dispatch/MCP | 32 files / 273 tests (OpenHands, dispatch, MCP), with the owner's 8 Python tests |
| 22bd1f62 | Animate v7 catalog enums (by hand) | `tests/miniapps-commands.test.ts` 6/6 |
| 28f1e920 | registry and package at the owners' checkpoints; Stream Studio hosted; server-derived theme origins | `tests/miniapps-*` 29/29 |
| 790bfe07 | the rail as the operator set it (07:57); OpenHands sandbox, MCP → CLI and Timmy MCP pages | the app's browser tests |
| f88990ce | Control Room connector-call cards | FAKE Treg browser test 2/2 |
| 7345e9e8 | Control Room runs aimed at an app or one of its outputs (08:10) | `tests/control-runs.test.ts` 6/6 (FAKE act); browser |
| 58e4b6ed | the Workspace canvas imports any app's results | browser (asset read through the companion, kept by path) |
| 1495752c | Card Lab's neutral shell, measured; Glacier the default family | the app's browser tests |
| e930d78c | every other adapter in the five words | browser |
| 1c5da0a4 | checklist I | **full suite: 795 files passed, 16 skipped; 6,499 tests passed, 136 skipped, 0 failed (exit 0, 2,805 s)**. The app's built page was rebuilt with c6acfead's Files change while the suite ran, so its browser files may have read that build |
| c6acfead | Files: all app results one press away (a Mac finding) | the Mac pass below |

- **1c5da0a on the Mac** (package sha256 `a6400848…2f0b`, a fresh folder, the reviewer's entry point):
  - the launch check passed at 1440 × 900 and 390 × 844: the Canvas is the licensed tldraw SDK (its LicenseManager says
    licensed; no watermark). Its line "Stream Studio says it is not built (no owner)" is out of date: it now matched the
    new lead "Broadcast is not built", and does not count;
  - "Timmy app stopped."; the census clean after the app and at the end; the home store unchanged (53 lines,
    `4410dc0ae942ca6c`) before and after;
  - hosting and project switching (mac-q): 23/23; two users: 12/12; Rive: 7/7; the commands: 10/10;
  - the journeys: 33 of 41 checks passed. Not passed:
    - T and T2 (four apps' theme checks): the driver's same-address navigation did not reload the page (as at
      92d2368c), so they never reached the apps. Corrected in the driver and run again below;
    - WS: the driver read the import menu before it listed anything (the capture shows it listed). Corrected below;
    - W9: a real finding: with five apps delivering, the handed-off image fell off the eight results shown, so a reopened
      Files did not name the handoff. Fixed in c6acfead;
    - A7 and A7-live: as at 92d2368c, Card Lab ended its inspection of an Animate image (not a card) ready, with one
      observed cite call, and answered "unknown". Not a pass as written; not a regression;
  - passed and new in this pass: the rail (R), Stream Studio composed, animated and exported as an SVG frame and an HTML
    player with each export's receipt and files by hash and Broadcast reported not built (A12), an agent aimed at Model
    Studio's outputs with the proposal bound to that target (K), the OpenHands page naming both images (OH), every other
    adapter in five words with none qualified (I8), and captures in both themes at both sizes (TH, 20);
  - the Stream journey and the Animate export were driven through each app's own HTTP API inside Timmy's frame, not by
    clicking the app's editor; the recording shows Timmy's pages and the frames, not an edit inside the apps' editors.
- **Blockers kept, not passes:** the OpenHands runner image `timmy-oh-runner:1.21.0-attempts-1` is not built on the Mac
  (and no new paid run is authorized); Stream Studio's theme trust (query or referrer, any loopback origin) is asked of
  its owner and not claimed at parity; Card Lab's identity on a real card (A7) needs a card image.

- **c6acfea on the Mac** (package sha256 `5be30d87…9763`; the driver's navigation and import-menu waits corrected):
  launch passed; hosting and project switching 23/23; two users 12/12; Rive 7/7; commands 10/10; home store unchanged.
  The journeys: 39 of 41. The theme into all four apps passed in Timmy's frame, both ways, without a reload (Card Lab and
  Film Room Amber → Glacier → Amber; Model Studio and Stream Studio Glacier → Amber → Glacier; Stream not claimed at
  parity); the reopened Files named the handoff (W9). Not passed: R (the rail was right; an earlier theme check had left
  the person's choice on Amber, so its "Glacier first" part read Amber — split into its own check on a fresh profile), and
  A7-live (Card Lab held: its provider call timed out at 90 s on the local model).
  Its captures showed what the checks did not: an imported SVG drew as a broken image, a video could not be imported,
  and an import on a full desk landed on a card. Fixed in 43ff2da (GET /api/files/media: from-apps/ only, images, SVG
  with a sandboxing CSP, video).
- **43ff2da on the Mac** (sha256 `e18ef003…e099`): the same stages all passed; the journeys 42 of 43. A fresh profile
  opens in Glacier (RT); an imported SVG drew (960 px wide) and a Film Room clip played (WS2). Not passed: A7-live, as
  above. Its capture showed the video placed to the right of the desk, out of the desk camera's reach: fixed in 790477f
  (the Notes section when nothing on the desk is clear).
- **The Mac restarted on its own at 10:29 PDT** (a kernel panic, during the first run of 790477f; the operator chose a
  lighter re-run). The restart cleared the temporary folder that held that first run's results, so none of them are
  claimed. The re-run kept its results in a folder under the operator's home that a restart does not clear, ran one stage
  at a time with the local models unloaded between stages, and was meant to run no Blender job.
- **790477f on the Mac, the lighter re-run** (package `timmy-review-790477f.tar.gz`, sha256
  `738c2179c3af7f5b2c4711157a1969ec9d0da8113a2b8a9b829b0aa093b258f6`): launch passed ("Timmy app stopped."; the census
  clean after the app and at the end); hosting and project switching 23/23; two users 12/12; Rive 7/7; commands 10/10;
  the journeys 41 of 43; the home store 53 lines, `4410dc0ae942ca6c`, before and after. A fresh profile opens in Glacier
  (RT); the Workspace imported a Film Room clip that plays and an SVG that draws, both inside the desk (WS). Not passed:
  A7 and A7-live (Card Lab ended its inspection of an Animate image ready and answered "unknown": the image is not a
  card). **Correction to the plan:** Blender did run. The run pointed `ANIMATE_BLENDER` and `STUDIO_BLENDER` at a missing
  path, yet Animate's export (A10: `scene.blend`, `scene.usda`, `native-readback.json`) and Model Studio's create
  (`r1-model.blend`) succeeded, so the apps found the installed Blender by their own defaults. The Mac stayed up.
  The short recording (`journey-short.mp4`) is the journeys' 189 s at 2.5× and carries no labels (the Mac's ffmpeg has no
  text filter).
- **Full suite on bd3f3595** (code identical to 790477f8; only this register differs): 795 files, 6,499 tests passed,
  0 failed, exit 0, 2,731 s.

## The unified Workspace order (2026-10-27, 16:56 PT): one installed candidate

Checklist section J. Code in this pass:

| Revision | What | Checks |
|---|---|---|
| 8239291f, dafd8922, cc059b21 | U1: the approved app names; one integration catalog for the node picker, inspectors and Control Room | browser |
| 05181392 | U2: several saved boards per project, one accessible dropdown | browser |
| 351e5d08 | U3: display nodes (one header, view, action menu, inspector, primary action) | browser |
| c31a51c6, 12173405 | U4: operation nodes; validated runs dispatched to the apps' own durable jobs; native Rive face | `tests/workflow-ops.test.ts`, browser (FAKE Stream Studio) |
| a683764c | U5: the canvas agent (Plan / Run / Autopilot) and the Control Room's three targets | `tests/canvas-agent.test.ts`, browser (FAKE Ollama, FAKE apps) |
| c58f6ad9, 84049327, 0038c387 | a refused plan asked again with every reason; a bounded context (8192); a thinking model asked not to think | unit |
| c0c91611, ea4fba02, d9aafbc0, abd426b7, 3b4fb885 | the Mac findings below, each fixed | unit and browser |

Full suite on a683764c (before the Mac findings): 798 of 820 files and 6,523 tests passed; 7 tests in 6 files failed,
each passing alone at 0038c387 (74 tests). They ran while files were being edited and the tree was dirty; not claimed as
a clean pass. The full suite on 3b4fb885: 804 of 821 files passed, 16 skipped; 6,533 tests passed, 136 skipped, **1 failed** (exit 1,
2,187 s): `g-browser` G6, panning to the last import (the shape was culled, its box null). That file then passed 5/5 alone,
twice. Recorded as run: not a clean suite pass.

The Mac runs (each a fresh folder from the package, the reviewer's entry point `./timmy-app`, the launch check, the
review's own Ollama route, then the driver; this computer's Ollama models unloaded between stages; results kept under
the operator's home folder, which a restart does not clear; one Blender job, Animate's image):

| Candidate | Package sha256 | Result | Found, then fixed |
|---|---|---|---|
| 0038c38 | `5cbb911d…` | the agent refused twice; three driver errors | (driver only) |
| c0c9161 | `307449e9…` | the agent's plan applied in 4.8 s, readback 7/7, its face went running → completed | a duration typed as text through a generic set step (typed parameters on add); a new board drew the desk's sections; the stage scrolled sideways |
| ea4fba0 | `e3513e5f…` | the agent refused twice (model variance) | the phone drawer under the Canvas layers (a flex item's z-index applies while static); a run left "collecting" after the companion stopped mid-collection |
| d9aafbc | `fe3a764c…` | 16 of 17; U5 not exercised | an agent's later round took the default budget |
| abd426b | `b05b8eb8…ca5ed` | 13 of 17: the agent's Run plan added and connected a node but had no run step, so nothing ran (U4 ×3, U7, U8 followed from it) | fixed in 3b4fb885: Run and Autopilot plans that run nothing are refused with that reason (never topped up) |
| **3b4fb88** | `2047158135aadecabb82c53edfc53a758644db6f01a7de34b190c7393dc1947f` | **17 of 18 passed; U5 not exercised** | — |

- **3b4fb88 on the Mac** (build info: revision 3b4fb885, branch r13/integration, not dirty):
  - the launch check 7/7 (the Canvas is the licensed tldraw SDK, no watermark; phone nothing wider than the screen);
    "Timmy app stopped."; the census clean at the end; the home store 53 lines, `4410dc0ae942ca6c`, before and after;
  - U1 a new blank board in the project; U2 Animate's own job (Blender), **scripted through its API**, delivered an
    image; U3 imported as a display node;
  - U4 **live**: gemma4:12b-it-qat in this computer's Ollama (no charge), asked once (5.2 s, 156 tokens). Its plan: add
    "Animate an image" (Motion pulse, Export html), connect preview.png, run it. Applied through the board's own
    functions; the node is marked AGENT; Stream Studio's own job completed; receipt sealed; every delivered file read
    back: 7 of 7 matched. The node's native Rive face went idle → running (bar) → completed;
  - U5 **not exercised live**: Motion changed through the node's dropdown and Run again completed, but the app's job had
    completed before Cancel reached it. Cancel is exercised against the FAKE app in `tests/workflow-ops` and the browser
    tests; that is not a live pass;
  - U6 a run left by a stopped companion said Recover; pressed, the app's own record decided (completed, collected);
  - U7 the HTML player in an isolated preview (sandbox `allow-scripts` only) with its receipt and hash; Reopen opened its
    editable source in Stream Studio, inside Timmy;
  - U8 saved and reopened in a fresh browser (13 nodes); another project ("blank") has none of it;
  - U9 **the unavailable integration**: OpenHands' setup refusal said with the exact build command (Timmy never builds
    it). A correctly handled refusal; **not counted as a live harness run**. The catalog says "installed, not callable"
    where that is true;
  - U10 captures in Glacier and Amber at 1440 × 900 and 390 × 844 (canvas, agent, Control Room): nothing wider than the
    screen; a recording `uw-demo.mp4` (344 frames, pauses over 3 s cut to 3 s).
- **Live vs FAKE:** live on the Mac: the local model, Animate's and Stream Studio's own jobs, tldraw's licence, Rive.
  FAKE (tests only): Ollama for unit and browser tests, Stream Studio for Cancel, Treg, OpenHands' runner.
- **Blockers kept, not passes:** the OpenHands image is not built on the Mac (no build, no new paid run); Cancel on a
  live job not exercised; Stream Studio's theme trust stays with its owner; Card Lab's identity on a real card (A7);
  `g-browser` G6 (panning) flaky, 2 failures across several runs, 3/3 alone.
- **Decision for the operator:** Glacier keeps amber focus and selection (`#FFB000`) as DESIGN.md's contract says.

## The spatial tools order (2026-10-27, 23:40 PT): Brush, KIRI and gsplat in the unified Workspace

Checklist section K. Owners: the host integration (catalog, jobs, canvas, Model Studio's splat menu) is this pass's, on
r13/integration; the spatial tools package (2026-10-27) is its owner's and was only read (its scripts, manifests and
fixture hashed `4589aafc37201604` before and after every Mac run); 3D Model Studio stays its owner's at 8266c20a (no
splat renderer there, so none was reused); Brush 0.3.0, KIRI 5.1.0, gsplat 1.5.3, Blender 5.2.3 LTS and Spark 2.3.1 are
upstream. Reconciled from 3b4fb885 (nothing newer on the branch from other owners).

| Revision | What | Checks |
|---|---|---|
| fa8e0283 | the three tools in the shared catalog; `SpatialExecutor` on the existing job manager (own process group per job, SIGTERM then SIGKILL, stage words as progress, one canonical receipt, recovery from the record); three Workspace operations; import from this computer; the splat display node (Spark in the existing Three.js viewport); Model Studio's splat menu | `tests/spatial-jobs.test.ts`, `tests/timmy-app-splat-browser.test.ts` (FAKE Brush, FAKE Blender) |
| 9c5c7ffd | KIRI completes only when its export matches the original file's kept rows (an independent compare, no Blender) | unit |
| 79f8a896 | Spark as a devDependency, bundled into the app (no 17 MB runtime install); `app.js` 3.1 → 5.8 MB | build |
| 4b5c80d2 | the renderer gets the Gaussian columns only: KIRI's export drew 4 Gaussians as 5 pixels | browser lit-pixel check; negative control: the old code fails it (0 lit) |

Policy note: AGENTS.md §9 says new spatial work begins through `docs/WORKFLOW-BENCHMARK.md`, which is not in this
checkout. This order is tool integration (catalog, jobs, display), not spatial benchmark or model work, and the operator's
explicit order takes precedence (AGENTS.md §3); no benchmark, corpus or model claim is made.

**Blender, diagnosed apart from KIRI (native, fixture only).** The package's fixture run exited -11 in 0.68 s; Blender's
crash log faults in `MTLBackend::metal_is_supported` → `supports_barycentric_whitelist` → `strstr`, before any Python:
a process that sees no Metal device. From the user session Blender 5.2.3 starts. Then the retained check, on the
package's 8-Gaussian SYNTHETIC FIXTURE (keep `x ≤ 0`):
- the package's own worker: failed with a TypeError (a name collision in its `stage()`); kept raw, the package not edited;
- Timmy's worker (`workers/spatial/kiri_worker.py`, the fix): import 8 → crop 4 → native `.blend` saved and reopened →
  raw Gaussian PLY exported and reimported; every field compared at each step, max difference 0; the independent
  compare against the original file: coordinates exact, scale within 5.6e-8. Native artifacts kept on the Mac:
  `edited.blend`, `edited.ply`, `result.json`, `independent-compare.json`, stdout and stderr. The export adds
  red/green/blue/alpha and Col_* columns and drops the fixture's comment (Timmy keeps "fixture" in its receipt).

The Mac runs (each a fresh folder from the package; launch check; then the spatial journey `sp-demo` in the candidate's
sandbox home; one Blender job at a time; no training, no model, no spend):

| Candidate | Package sha256 | Result | Found |
|---|---|---|---|
| 79f8a89 | `4558d0b6…ab03b1` | 14 of 14 checks passed | the edited splat's count was checked but not its picture; the capture showed it near-empty → 4b5c80d2 |
| **4b5c80d** | `8c8e62362881f2fe19a3217139838701bc456e1db0ebc00a9aa8d05a2fc61322` | **14 of 14 checks passed** | — |

- **4b5c80d on the Mac** (revision 4b5c80d2, branch r13/integration, not dirty):
  - launch check exit 0, "Timmy app stopped."; the census clean; Blender processes left 0; the home store 53 lines,
    `4410dc0ae942ca6c`, before and after; the spatial tools folder `4589aafc37201604` before and after;
  - S1 the catalog: Brush and KIRI installed and callable, gsplat not installed and not callable; `verified` empty
    before any run (a present executable is not a qualification);
  - S2 3D Model Studio's "Gaussian splats" menu: KIRI and Brush offered, gsplat disabled with its reason;
  - S3 the package's SYNTHETIC FIXTURE imported from this computer (import receipt `bc1bd540`), drawn by Spark (5,576
    lit pixels), its facts from the file: 8 Gaussians, centres −0.4 to 0.4, opacity 0.880797;
  - S4 **live**: "Crop with KIRI…" placed the operation beside the splat, input connected, keep `x ≤ 0`; Run: Blender
    5.2.3 + KIRI 5.1.0 as a Timmy job `w29d5351ebec3` (not run → queued → running → completed): "Blender exit 0; KIRI
    worker: success, 3/3 value checks; the export matches the original file's kept rows (4)"; six delivered files
    (`edited.blend`, `edited.ply`, `result.json`, `job.log`, `request.json`, `independent-check.json`) read back 6/6;
    one spatial receipt `dab665ce`; the edited splat drawn (4 Gaussians, 17,265 lit pixels);
  - S5 **live Cancel**: a second KIRI job `w6304cb99553a` cancelled: "cancelled (signal SIGTERM; process group gone)";
  - S6 saved and reopened in a fresh browser (2 splats, the node and its results); another project has none of it;
  - S7 gsplat refused before anything started: 409, `setup`, "awaiting a powered NVIDIA worker"; **not a run**;
  - S8 Glacier and Amber at 1440 × 900 and 390 × 844 (canvas, Model Studio): nothing wider than the screen; a
    recording `sp-demo.mp4` (674 frames, pauses over 3 s cut to 3 s).
- **Live vs FAKE:** live on the Mac: Blender 5.2.3, KIRI 5.1.0, Spark, tldraw's licence, the job manager and receipts.
  FAKE (tests only, labelled): Brush and Blender in `tests/fixtures/fake-spatial-tools.ts`.
- **Fixture, not real data:** every splat here is the package's 8-Gaussian synthetic fixture. A splat is an appearance
  reconstruction: not measured geometry, a watertight mesh or verified CAD.
- **Blockers kept, not passes:** Brush: reconstruction, the GPU, mid-training Cancel and resume not exercised (no posed
  dataset; no training started); gsplat: not installed on an NVIDIA worker (the Sparks are unplugged; not probed);
  KIRI: only the bounded raw-PLY route (no KIRI render, relighting or its own export presets); Blender crashes where no
  Metal device is visible (a sandboxed process), so KIRI jobs run from the user session; the export drops the fixture
  comment; `app.js` grows by 2.7 MB with Spark. Earlier blockers unchanged (OpenHands image, Stream Studio theme trust,
  A7, G6).
- **Follow-up candidates (not in this checkpoint):** CloudCompare, napari, Polyscope.
- **Full suite on 4b5c80d2:** running when this entry was written; its result is recorded in the next commit. The
  79f8a896 run was stopped part-way (the worktree changed under it), so no result is claimed for it.
