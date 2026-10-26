# Timmy mini-app integration register

Version 1, 2026-10-26. One writer: the Timmy lead (the designated integrator). Owners keep their apps' code; a change to an
owner's file goes to that owner as a request. Facts here are what was observed on the date given, with the check that
observed it; "not observed" means not known.

## Integration base

- **Branch:** `r13/integration`, from `r12/rive-tldraw-app` at **a753bed9** (draft PR #108's head, its privacy check green).
- **Destination:** a draft PR from `r13/integration` into `r12/rive-tldraw-app`. Merge, publish, tags and deploy are on HOLD.
- **Other checkouts (not the base, left as they are):**
  - the operator's own checkout at 08006fb9: an ancestor of a753bed9; never touched;
  - a second local checkout of `main` at c3b4b208 (2026-09-18): about 50 commits never pushed, 37 modified and 281 untracked
    files, including the untracked Timmy Animate folder. Not on GitHub, so not mergeable as a base; only `companion/animate`
    is taken from it, as its owner commits it.
- **The Mac review install** (:4443, package 1620c22) is a review package, not a source.

## Apps

| App | Owner | Source and state (observed 2026-10-26) | Snapshot the lead holds | Destination | Owned files (owner) | Status | Next action |
|---|---|---|---|---|---|---|---|
| Model Studio (3D / VoxVision) | Codex `timmy-new-1` | `codex/model-studio` **aabe7c1a**, clean | git bundle of aabe7c1a | hosted unchanged: the review package carries `git archive` of the commit under `apps/model-studio/` | every file of its repository (its AGENTS.md assigns root, native, UI and Tripo owners) | **hosted** (C1) | jobs, receipts and assets adapters (below) |
| Card Lab (image) | Codex "Timmy Card Lab — private standalone release" | `main` **6431f8fb** (v0.2.1) + 20 modified, 12 untracked (v0.2.2: session recovery, shared sign-in) | git bundle + working-tree copy, fingerprint `684af73cb1087d2c` | hosted unchanged, as Model Studio | its repository | awaiting owner checkpoint | owner commits the working tree (six modified UI files import the untracked `session-client.js`, so the modified files alone do not build) |
| Film Room (video) | Codex "Analyze NFL footage with AI" | `main` **ecca8f44** + 21 modified, 107 untracked | git bundle + working-tree copy, fingerprint `baf17641999ec3e8` | hosted; see the contract note | its repository | awaiting owner checkpoint | owner commits the working tree; the owner's private project stays outside the repository |
| Timmy Animate (motion) | Codex "Assess a 2D animator mini app" | never committed (893 files) | full copy, fingerprint `b1f56f477cab028c` | hosted unchanged (its own server) | its folder | awaiting owner commit | owner commits it (its own repository or branch) without the `._*` files and home paths in `verification/` and `integrations/` |
| Stream Studio (general editor) | **none assigned** | not built; Card Lab has broadcast controls for one reviewed card; Animate has the motion engine | — | — | — | no owner | the operator assigns one owner (the lead's proposal: the Animate owner) |
| Control Room (harness wall) | the lead, through bounded helpers | Timmy's lanes, `/agent` jobs, dispatch and receipts | — | `r13/integration` | `src/companion/panels/control.ts`, `companion/timmy-app/src/pages/control.jsx`, a new `src/agent/relay.ts` | inventory done | one harness id, distinct states, the scoped packet relay |
| Shared adapters | the lead | — | — | `r13/integration` | `src/companion/miniapps/**`, shared contracts | C1 in | jobs → receipts → assets → persistence |

Fingerprints: sha256 of the commit id, `git diff HEAD --binary` and the sorted sha256 list of untracked files (Animate:
of every file but `node_modules`), first 16 hex digits. The copies are the lead's private working material: never committed
to this public repository.

## How an app is hosted (C1, commit 64c42160)

- A hosted app runs as a durable **server job** of the principal's Timmy home (`src/jobs`, `envExact`: only the variables its
  registry entry allows; never a provider key, a token or a paid-call switch), its data in
  `<home>/apps/<app>/<project id>`: separate per principal and per project.
- The page reaches it only through a loopback gateway that answers the browser holding the gateway's cookie, given for a
  one-time launch key (60 s) from `/api/apps/:id/open` (launch token and session checked). The app's own Host and Origin
  checks still pass; its `frame-ancestors` names Timmy's origin; no cookie or referer is forwarded.
- Spending hold: no paid switch reaches an app. Model Studio's Tripo and OpenRouter routes therefore answer "held".

## Findings for owners (requests, not changes made)

- **Model Studio:** a clean clone does not build: `build.mjs` copies `public/`, an empty folder git does not keep (the
  review package makes it before building). In the lead's Linux container its `npm test` was 47/48: "cancellation terminates
  actual child process group" found the grandchild still alive 100 ms after the kill (container, not the Mac; the owner's Mac
  record is 48 passed). Its own port answers any loopback client that names its host: a shared-secret check from Timmy is the
  owner's change to make.
- **Card Lab:** absolute asset and API paths and `X-Frame-Options: SAMEORIGIN` (the gateway must also drop that header to
  frame it); single-owner auth only; home paths and deployment details in committed docs; no Airtable.
- **Film Room:** its uncommitted `tools/filmroom-timmy.mjs` and `public/host-bridge.js` expect a different host contract
  (`/api/miniapps/video-analysis/launch`, a sub-path and a context id). Timmy's contract is the gateway above; the owner adapts
  the bridge, or the lead adds a sub-path adapter, decided when its checkpoint lands. Its committed HEAD is only a static
  prototype: the backend exists only in the working tree. `mcporter` is used but not in its package.json.
- **Animate:** default port 4318 in `server.mjs` against 4327 in its README and CLI; macOS paths in `server.mjs` and
  `integrations/`; scene persistence in browser storage only; no Timmy receipts (sha256 manifests, unsigned).

## Control Room inventory (2026-10-26, read from a753bed9)

- Three state vocabularies (runtime profiles, the capability inventory, the capability ladder); **no "authenticated" state**:
  keys are checked for presence only. "Exercised" = a signed receipt on the runs chain.
- Harnesses: OpenHands, Qwen Code, OpenCode, Claude, Codex run as `/agent` jobs with receipts; jcode, Minds and Pi run as
  tmux lanes with a launch receipt only; Hermes' receipts are written off the chain; Kimi Code and Cline are profiles only;
  Gemini CLI and Kura have no adapter. `src/pi-durable/*` is imported only by tests.
- Nearest relay seam: `src/utils/dispatch.ts` (plan → arm, approval bound to the plan hash → dispatch → cancel → collect),
  with `context-cone.ts` budgets; no relay, packet type, dedupe or hop limit exists yet.

## Qualification state

- C1 (64c42160): `miniapps-host` 4/4 (FAKE app); `timmy-app-browser` 10/10; the timmy-app, jobs and canvas-bundle suites
  green. One intermittent seen once: `timmy-app-browser` "configure" failed in a combined 7-file run and passed alone and in
  the file's full run.
- REAL Model Studio aabe7c1a (built in the container, no native engines there) opened framed through Timmy in Chromium at
  1440 × 900 and 390 × 844 and stopped through its job.
- **Full suite on dd2c1350** (frozen worktree, 2 workers, under the heavy lock, 11:41–12:43 PT): **exit 0**, 779 files passed /
  16 skipped, 6416 tests passed / 136 skipped, 0 failed, no runner errors, 3731 s. One lock-free 3 s run of
  `miniapps-host` overlapped it at 11:47.
- **Mac, installed package 66fc3e4** (fresh home): Model Studio opened from the rail inside Timmy's frame; its 5 engines
  available (Blender, OpenSCAD, FreeCAD, build123d, CadQuery; C4D and Houdini not); a real OpenSCAD parametric box
  40 × 30 × 10 mm succeeded in 2 s and stays parametric; phone layout; stopped through its job.
- Receipts adapter (07d2c599): `miniapps-host` 5/5 (FAKE app); not yet in a full suite or on the Mac.
- Not yet: Card Lab, Film Room and Animate (owner checkpoints), Stream Studio (no owner), the Control Room relay.
