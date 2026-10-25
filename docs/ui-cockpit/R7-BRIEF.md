# Round R7: one shared workspace, then the unfinished tabs (shared brief)

Written 2026-10-16 by the lead for the operator's order of 22:08 PT the same day. The lead keeps this file current; owners
add dated lines to the shared handoff and say what they finished in their report.

## The order, in short

The frozen R6 candidate (`4a2e4b2`, draft PR #99) and its evidence stay exactly as they are. R7 starts from
`r6/lead-followups` (PR #100: the streaming test's stale-receipt race fixed by receipt identity, and CI's test step at 25
minutes), and:

1. **Closes the shared-workspace defects before the technology stack grows:**
   - the REPL follows the selected project as the Workbench, the companion and Studio do; an operation already running
     stays attached to the project it started in;
   - after tray → blank → tray, the same REPL keeps the canvas: no second `/canvas open`;
   - Enter on the Workbench's Chat tab never stops another surface's turn, and no screen says a turn is being answered
     while it also says nothing runs;
   - while a draft waits, Studio's one primary next step is the draft's Accept or Discard.
2. **Finishes the existing UI requirements with the current adapters and components:** readable text (11 px or more),
   usable preview space, Studio cards that do not cover each other, panels that fit small windows, and the agreed
   black / amber / green meanings (DESIGN.md §10 B10). Editable content colours (a board's shape colours, images, video,
   measured data) keep their own colours where they are content.
3. **Keeps 3D & Motion, Control Room, Fleet & Clef and Logs & Receipts visibly unfinished** until their intended
   interactions work: each says, on every surface, what works on it now and what does not yet
   (`src/contracts/workspace.ts`, `TabDef.unfinished`; the frame carries it on `tabs[]`).
4. **Starts the next 3D slice from inputs Timmy already reads** (its own STL reader, a STEP's tessellated mesh where one
   exists, recordings it can read): a basic working preview needs no segmentation or depth model.

Then one integrated revision is frozen and qualified under the test lock with no concurrent heavy work or edits; the
earlier failures are kept; the corrected rehearsal assertions are run again, not assumed; the isolated review package is
rebuilt with new checksums, launch instructions, actual captures and a short list the operator can test. Linux and Mac
qualification are reported separately.

## Holds

Merge, npm publish, tags and deployment stay on HOLD. No paid model call, no external spend, no new account, no credential
copying, no large model download. The operator's own checkout, global `timmy`, Terminal windows and profiles and evidence
folders are never touched. OpenRig stays excluded.

## Who owns what

Every owner branches from `r7/review-build` at the commit that added this file, works in a worktree of their own, and
commits only the files of their area. The lead merges each owner's branch into `r7/review-build`; owners do not push and do
not open pull requests. A file outside your area: ask in the handoff first, or, for a one-line hook or wording change, make
it and say so there.

| Owner | Area | Branch | Files |
|---|---|---|---|
| H149 | The REPL follows the selected project (a running operation, job or chat turn keeps its own); the canvas holder survives tray → blank → tray; Studio's server follows a switch sooner and says a switch is pending at once | `r7/h149-repl-follows` | `src/repl/workspace.ts` (its `/project` part), a new `src/repl/project-follow.ts`, `src/repl/main.ts` (wiring), `src/repl/canvas-project.ts`, `src/repl/canvas-view.ts`, `src/studio/active-follow.ts`, `src/studio/project-link.ts`, `src/studio/canvas-auth.ts`, `src/studio/card-relay.ts`, their tests |
| H150 | The Workbench: Enter on tab 2 never stops another surface's turn; one source for "a turn is being answered" and RUNNING NOW; colours without truecolor (the 16 slots under a known profile, the nearest 256 colours otherwise); amber only for focus, the active tab and the one primary; the unfinished tabs; its job/turn words | `r7/h150-workbench` | `src/workbench/**` (but `create-tab.ts`), `src/agent/chat-turn.ts`, the Workbench's colour path, their tests |
| H151 | Studio: the draft's Accept as the one primary while a draft waits; placed cards never cover shapes; tabs and panels that leave the board usable at 800×600; waiting and Activity that follow an Accept or a stop at once; the page blocks edits as soon as a switch is pending; the unfinished tabs | `r7/h151-studio` | `companion/studio-canvas/**`, `src/studio/**` but H149's four files, their tests |
| H152 | The companion: text of 11 px or more everywhere; VoxVision's preview space and labels at 1376×768; Home's newest images; `/run/<op>` typed by hand; the unfinished tabs; its job/turn words | `r7/h152-companion` | `src/companion/**` but H153's tab 6 files, their tests |
| H153 | The 3D slice: tab 6 shows the project's meshes from Timmy's own readers (a view you can turn, the measurements read from the file) and the recordings it can read, with no new dependency and no model; the Workbench's tab 6 lists the same | `r7/h153-3d-slice` | new `src/companion/panels/create.ts`, `src/companion/client/panel-create.js`, the page's 3D & Motion section, new `src/vox/meshes.ts`, new `src/workbench/create-tab.ts`, a demo mesh under `examples/visual-tools/`, their tests |
| Lead | Integration; the frame's actions (Studio's primary with a draft waiting, the chat tab's stop action), Ollama with no usable model, `timmy op`'s job words; the review launcher; the rehearsal driver and its corrected assertions; docs; the frozen revision, its qualification and package | `r7/review-build` | everything else, and merges |

## How to work

1. Read `AGENTS.md`, `DESIGN.md` §10 (B9, B10) and this brief. Run `git status --short` before editing and before each
   commit.
2. Node 24. Tests first: a failing test for the defect, then the fix. Run only the suites you touch, one run at a time,
   under the shared test lock.
3. Stage by name, never `git add -A` or `git add .`; never `--no-verify`; the privacy hook must pass. No personal
   information, keys, hostnames or home paths in anything committed.
4. Words follow what Timmy observed: installed is not working; a FAKE fixture is named FAKE; a check that did not run is
   not a pass. Every new screen state has a test that reads what it shows, not only its heading.
5. Report: commits, tests run with their counts and exit codes, captures, and what remains.
