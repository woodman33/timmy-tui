# Round R10: one polished, connected journey, UI first (shared brief)

Written 2026-10-22 by the lead after the operator's UI feedback (04:09 PT). The lead keeps this file current; owners add
dated lines to the shared handoff and say what they finished in their report.

## Where it starts

- `r10/review-build` is #104's actual tip, `0f1153d` (`r9/lead-followups`, read from GitHub on 2026-10-22), plus this
  file. That tip is R9's frozen `1fa4020` plus its seven follow-ups: item B's fix, the review's findings worded truthfully,
  F10, M′'s test fix and the matrix's R9 status. All of them are kept.
- R9's completed work stays as it is and is not reassigned, H162's billing fix included.

## What the operator found

- The screen he reviewed was his protected global install, an older release candidate, whose start opens the old
  full-screen shell (HOME RUN CHAIN LIBRARY CHAT COMMAND). It is not acceptable as Timmy's product UI.
- Timmy has three terminal entry points: the inline REPL (`timmy`, `timmy repl`), the old monitor (`timmy watch`) and the
  Workbench (`timmy workbench`). R9's package notes named two of them. The candidate gets one launch command.

## The order, UI first

1. **One unmistakable launch command** for the candidate, verified to open the interface the captures show, with the
   candidate's revision in About/Diagnostics. The operator's global install stays unchanged until its replacement is
   explicitly authorized.
2. **A dedicated UI implementation pass** against `CODEX_UI_SPEC.md` and reference images 01 to 18 (the operator's
   reference pack; not in this repository). One polished, connected journey:
   1. Open Timmy and immediately understand the active project and the next action.
   2. Enter an intent or continue the project's chat, with the actual model route clearly shown.
   3. Open a project artifact in the appropriate companion or Studio preview.
   4. Inspect its workflow progress, result and receipt without losing project context.
3. **The first user-facing checkpoint shows:**
   - the Workbench's Home/Chat at 122×37: the active project, the actual model route, an obvious composer or next action,
     and useful recent work;
   - the companion: a prominent artifact preview with readable contextual controls;
   - Studio: clear files, custom nodes, draft review and save state.
4. **Rules for these screens:**
   - existing working backend operations only;
   - technical diagnostics (hashes, bus details, raw commands, ports, paths, ids) in a secondary inspector or details
     control; essential status and permissions stay visible;
   - one clear primary action per screen, a readable hierarchy, useful empty states, deliberate spacing and visible
     keyboard focus;
   - B10's black, amber and green semantics (DESIGN.md §10).
5. **Early running captures**, labelled INTERIM until qualified, at the operator's 122×37 and the supported browser sizes.
   The operator sees the running journey before this treatment spreads to the remaining screens.
6. **Startup and cleanup defects** are finished alongside. Optional feature expansion that does not support the journey
   is deferred.
7. **Three measures, reported apart:**
   - functional correctness: tests, the gate and the rehearsal;
   - visual fidelity: running captures against the references, judged by an independent reviewer;
   - ease of use: the journey's steps, keys and time to understand.

   Passing tests, added dependencies and honest "unfinished" labels do not make a UI complete.
8. **The full 18-reference requirements stay visible** (`REFERENCE-MATRIX.md`). This checkpoint does not replace them.

## Deferred

The interactive Control Room, Rerun's web viewer and `viewer-mcp`, the on-screen routing switch and a fleet route's bars,
paid model comparisons, three-model ensembles, new hosting integrations and the signed stall-receipt subsystem. Their
research is kept.

## Holds

Merge, npm publish, tags and deployment stay on HOLD. No paid model call, no external spend, no new account, no credential
copying, no large model download, no new installation outside a package's own sandbox. The operator's own checkout,
global `timmy`, Terminal windows and profiles, and evidence folders are never touched.

## Who owns what

Every owner branches from `r10/review-build` at the commit that added this file, works in a worktree of their own, and
commits only the files of their area. The lead merges each owner's branch. Owners do not push and do not open pull
requests. For a file outside your area, ask in the handoff first. A one-line hook or a wording change you may make
yourself; say so there.

| Owner | Area | Branch | Files |
|---|---|---|---|
| H167 | **UI owner:** the terminal Workbench, the browser companion and Studio as one project workspace; the layout and interaction of the journey | `r10/h167-ui` | the Workbench's rendering and keys (`src/workbench/**` except the data modules H164 adds), `src/companion/client/**`, Studio's UI (`companion/studio-canvas/src/**`), their tests |
| H163 | **Launch and lifecycle:** the one launch command, the build's revision (`timmy --version` and About/Diagnostics data), startup and cleanup defects | `r10/h163-launch` | `scripts/review/**`, `scripts/generate-version.ts`, a new `src/build-info.ts`, `timmy.ts`'s version line, the cleanup paths of `src/utils/dispatch.ts` and `tests/helpers/dispatch-tmux.ts`, their tests |
| H164 | **Journey data:** one source each for the actual model route, recent work, where an artifact opens, and a run's progress, result and receipt in project context | `r10/h164-journey` | a new `src/journey/**`, new read-only routes in `src/companion/server.ts`, `src/companion/run-detail.ts`, the route words of `src/agent/chat-route.ts`, their tests |
| H168 | **Independent reviewer** (after the interim build): running captures against the references | none | none |
| Lead | Integration, interim packages, the launch check on the Mac, the gate, the report | `r10/review-build` | everything else |

### The data H164 gives H167 (`src/journey/index.ts`)

- `routeNow(ctx)`: the route the next chat turn would take, from the same function the turn uses. Provider (`openrouter`,
  `ollama`, `fake` or `none`), model, where it runs, price as declared (or `unknown`), whether it is FAKE, whether it is
  ready, and why not with the setup step.
- `recentWork(ctx, limit)`: the active project's newest chat turns, runs, artifacts, drafts and receipts, newest first:
  kind, id, title, time, state, and where it opens.
- `openTarget(item)` and `openUrl(target, base)`: where an item opens (a companion tab with its parameters, or Studio),
  one function for the Workbench, the companion and Studio.
- `runSummary(ctx, runId)`: a run's progress (steps done of total, state), its result and its receipt (id, verified), with
  the project it belongs to.

H167 may draw from the existing data until these land. The lead merges H164's branch first when both are ready.

## How to work

1. Read `AGENTS.md`, `DESIGN.md` §10 (B9, B10) and this brief. Run `git status --short` before editing and before each
   commit.
2. Put Node 24 first on PATH. Work tests first where there is behaviour: a failing test, seen failing, then the change.
   Every new screen state has a test that reads what it shows, not only its heading. Run only the suites you touch, one
   run at a time, under the shared lock. Use the short TMPDIR your prompt gives.
3. Stage by name, never `git add -A` or `git add .`; never `--no-verify`; the privacy hook must pass. Nothing committed
   holds personal information, keys, hostnames or home paths. The reference pack and its spec stay out of the repository.
4. Words follow what Timmy observed. Installed is not working; a FAKE fixture is named FAKE; a check that did not run is
   not a pass.
5. Work in small steps. Commit each working step and add a line to the shared handoff (`HH:MM PT · Hxxx · …`) at each
   milestone. H167 writes INTERIM captures of each journey step as it lands, so the lead can show them early.

## The checkpoint's acceptance

- **Functional:** each journey step runs against real backend operations (FAKE models labelled), with tests; the short
  gate passes on the frozen revision.
- **Visual:** an independent reviewer compares the running captures with references 01, 02, 11 and 13 (Home/Chat),
  the preview panes of 01, 02, 05 and 09 (the companion), 12 (a run, its result and its receipt) and 06 (Studio), at
  122×37 and at 1376×768, 1280×720, 1600×900 and 390×844.
- **Ease of use:**
  - from the launch command, the active project and the next action are readable on the first screen without scrolling;
  - the composer takes one key;
  - an artifact opens in two keys from recent work;
  - no hash, port, path or raw command shows on the journey's screens outside the inspector.
