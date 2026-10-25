# Round R8: the next 3D slice, the Control Room on the companion, and the open items (shared brief)

Written 2026-10-18 by the lead after the operator's "continue developing timmy-tui" (01:07 PT) and his answers at 01:15 PT.
The lead keeps this file current; owners add dated lines to the shared handoff and say what they finished in their
report.

## Where it starts

R7 is qualified on Linux at `a2e641c` (`r7/review-build`, draft PR #101): CI, the short gate, the full suite and the
scripted rehearsal of its package all passed. That revision and its evidence stay exactly as they are. R8 starts from
`r8/review-build`, which is `a2e641c` plus this file.

The operator's answers (01:15 PT):
- **Open item J (Studio):** when a model's draft lands on shapes already on the board, Studio **says so and offers to
  move it**. Nothing moves by itself.
- **The Mac:** qualify on macOS headlessly in the sandbox (`/private/tmp/tc-home/r1` only), by the lead.
- **Disk:** the finished leftovers were deleted to make room.

## What R8 does

1. **The next 3D slice, from inputs Timmy can read itself** (no new dependency, no model, no download): tab 6 lists and
   measures OBJ and PLY meshes as it does STL, and the companion draws them in the same view. A Rerun recording
   (`.rrd`) lists its entity paths and time range only through a Rerun SDK that is already installed; otherwise it says
   it is not installed. Tab 6 stays marked unfinished.
2. **The Control Room on the companion:** tab 7 shows each run's pane as the Workbench's tab 7 does (read-only, from the
   frame and the runs' own logs), with the same stop words. Tab 7 stays marked unfinished.
3. **The open items** of REMAINING-DEFECTS (R7 package): A, B, C, H, I (tests), E and G (the Workbench), J (Studio).

Then the lead integrates, freezes one revision, and qualifies it under the test lock as in R7 (CI, the short gate, the
full suite, the package, the rehearsal with its driver hashed at the freeze). Linux and Mac are reported separately.

## Holds

Merge, npm publish, tags and deployment stay on HOLD. No paid model call, no external spend, no new account, no credential
copying, no large model download. The operator's own checkout, global `timmy`, Terminal windows and profiles and evidence
folders are never touched. OpenRig stays excluded.

## Who owns what

Every owner branches from `r8/review-build` at the commit that added this file, works in a worktree of their own, and
commits only the files of their area. The lead merges each owner's branch; owners do not push and do not open pull
requests. A file outside your area: ask in the handoff first, or, for a one-line hook or wording change, make it and say
so there.

| Owner | Area | Branch | Files |
|---|---|---|---|
| H154 | Tab 6, 3D slice 2: OBJ and PLY meshes listed, measured and drawn like STL; `.rrd` entities and time range through an installed Rerun SDK only | `r8/h154-meshes` | `src/vox/meshes.ts`, `src/vox/recording.ts`, `src/native/` (new readers), `src/companion/panels/create.ts`, `src/companion/client/panel-create.js`, `src/workbench/create-tab.ts`, their tests, `scripts/demo-mesh.mjs` |
| H155 | The companion's tab 7: a read-only grid of the runs' panes (running first, then the newest ended), each with its log's last lines and its exit and receipt, the stop words as on the Workbench | `r8/h155-control` | a new `src/companion/panels/control.ts`, `src/companion/client/` (a new panel file, its CSS), `src/companion/panels.ts`, their tests |
| H156 | Test hygiene: A, B, C, H, I | `r8/h156-tests` | the tests named in each item, `src/utils/dispatch.ts` only if a test's leftover is the product's |
| H157 | The Workbench: E (the key row at 100×30, tab 8's cut lines) and G (a full unfinished page's first item below the window) | `r8/h157-workbench` | `src/workbench/` (not `create-tab.ts` or `control-tab.ts`), their tests |
| H158 | Studio: J (a draft that lands on shapes already there is named, with one button that moves it to free space) | `r8/h158-studio` | `companion/studio-canvas/` (its `src/`, `index.html`), Studio's tests |
| Lead | Integration; the Mac qualification of `a2e641c`; the rehearsal driver's new checks; the freeze, gate, package and report | `r8/review-build` | everything else |

## How to work

1. Read `AGENTS.md`, `DESIGN.md` §10 (B9, B10) and this brief. Run `git status --short` before editing and before each
   commit.
2. Node 24 first on PATH. Tests first: a failing test for the defect or the missing behaviour, seen failing, then the
   change. Run only the suites you touch, one run at a time, under the shared heavy-run lock (`flock <lock> npx vitest run
   <files>`), with a short TMPDIR (one test depends on its length). Your prompt gives the paths.
3. Stage by name, never `git add -A` or `git add .`; never `--no-verify`; the privacy hook must pass. No personal
   information, keys, hostnames or home paths in anything committed.
4. Words follow what Timmy observed: installed is not working; a FAKE fixture is named FAKE; a check that did not run is
   not a pass. Every new screen state has a test that reads what it shows, not only its heading.
5. Small steps: commit each working step and add a line to the shared handoff (`HH:MM PT · Hxxx · …`; your prompt gives
   its path) at each commit, at least every 15 minutes of work.
6. Report: commits, tests run with their counts and exit codes, captures, and what remains.
