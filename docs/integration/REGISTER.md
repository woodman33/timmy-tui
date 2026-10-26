# Timmy mini-app integration register

Version 2, 2026-10-26 (version 1 the same day, before the owners' checkpoints). One writer: the Timmy lead (the designated
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
| Card Lab | 7176ad97 (as 6f780771), `git archive` | **hosted** (C1, local mode) | each ended launch of a run (`run.json` events) | resolve its app-suite timeout; drop the personal license path in local mode; shared assets and provider approval (lead) |
| Film Room | f9db9fe0, `git archive` | **hosted** (C1) | its `jobs/<id>.json` | Airtable and Roboflow sign-ins here; `mcporter` in its package.json |
| Timmy Animate | v6 archive 68c2f853 | **hosted** (C1) | its `<id>/job.json` exports | commit it to its own repository; port 4318 vs 4327; scene persistence beyond browser storage |
| Stream Studio | — | no owner | — | the operator assigns one owner (the lead's proposal: the Animate owner) |
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
- **Not isolation:** the worker's own port still answers any loopback client (its owner's change: a shared secret from
  Timmy), and a filtered environment and data folder are not a filesystem boundary.
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
| | `src/cli.ts` `timmy video` | **not imported** (no `timmy video` command yet); next, through the same host |
| | packaging (`package.json`, lock, `scripts/miniapps/build-video-analysis.mjs`) | **superseded**: the review package builds each app from its own source (`scripts/review/review.sh` `mini_apps`) |
| Film Room `shared-react-dedupe.patch` | `scripts/canvas/build.mjs` React alias | **not applied**: C1 does not bundle any app into Timmy's canvas bundle, so there is no second React to dedupe |
| Animate `animate-host.patch` (13 files) | `src/companion/server.ts`, `src/companion/client/index.html` | **superseded** by C1 (the app is framed, not mounted in the companion DOM) |
| | `src/animate/launcher.ts`, `src/animate/companion.ts` (own server on 4327) | **superseded** by the host's server job |
| | `src/cli.ts`, `timmy.ts`, `src/utils/slash-commands.ts` (`timmy animate`), `src/agent/tools.ts`, `src/agent/animate-tools.ts`, `src/mcp/server.ts` (agent tools, MCP) | **not imported**; next, as tools that call the hosted app through C1 |
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
  in local mode; single-owner auth only; no Airtable; its app suite times out.
- **Film Room:** its bridge expects the superseded sub-path contract (above); `mcporter` is used but not in its package.json.
- **Animate:** default port 4318 in `server.mjs` against 4327 in its README and CLI; macOS paths in `server.mjs` and
  `integrations/`; scene persistence in browser storage only; no lockfile.

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
