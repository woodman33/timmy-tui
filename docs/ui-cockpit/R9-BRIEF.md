# Round R9: decision pricing and identity, recordings through the Rerun CLI, tab 6's items, dispatch cleanup (shared brief)

Written 2026-10-20 by the lead after the operator's "R9 go" (2026-10-19, 20:48 PT). The lead keeps this file current;
owners add dated lines to the shared handoff and say what they finished in their report.

## Where it starts

R8 is qualified on Linux at `c0debd8` (`r8/review-build`, draft PR #102): CI, the short gate, the full suite and the
scripted rehearsal of its package passed, and the same package ran on the Mac, reported apart. That revision and its
evidence stay exactly as they are; nothing finished in R8 is restarted. R9 starts from `r9/review-build`, which is
`c0debd8` plus this file.

## What R9 does, in the operator's order

0. **First, before any hosted decision-model use: the SystemOne pricing defect.**
   - The packaged provider marks every SystemOne endpoint `paid: false`, so the service skips the budget check and "free
     only" lets it through.
   - Reproduce it with FAKE servers first.
   - After the fix, a free-only request and a request over its budget are refused before anything is sent.
   - Nothing is free because of the transport's name, a remote or self-hosted label, or a localhost address, which can
     proxy paid inference. Unknown pricing never becomes zero.
   - Inference that is explicitly configured as local still works.
   - Model identity is exact: the requested model, the returned model and version, and the local digest where one is
     available. Clef-flash, Jev and d1-ultra are never called Clef-Omni.
   - A recommendation stays apart from chat and from the deterministic admission and permission checks.
1. **H159:** a recording's entities and time range read through the installed Rerun CLI, bounded, with an explicit unknown
   when it cannot.
2. **H160:** tab 6's meshes as selectable items, in view when the tab opens at every supported terminal size.
3. **H161:** dispatch-owned temporary copies removed after the session ends and the required outputs are kept (R8's K).
   The missing running-block refusal (R8's M) is investigated and fixed, with a test that reproduces it.
4. **UI completion stays central.** Each result is connected to the active project, the preview, its actions, the logs
   and the receipts. The completion ledger keeps the unfinished parts visible: motion, Fleet and Clef, replay, and the
   interactive Control Room.
5. **The Mac checks R8 did not cover (lead):** Studio's draft overlap and Move it to free space; stopping a Workflows run;
   the fonts that actually render.
6. **Then:**
   - integrate serially, freeze one revision and qualify it under the lock;
   - run an independent interaction and visual review of the changed screens;
   - deliver the runnable package, the actual captures, and the 18 references marked complete, partial or absent.

## Deferred by the order

Paid model comparisons, three-model ensembles, new hosting integrations and the proposed signed stall-receipt subsystem.
The research is kept for later. **No new installations and no paid calls.**

## Holds

Merge, npm publish, tags and deployment stay on HOLD. No paid model call, no external spend, no new account, no credential
copying, no large model download. The operator's own checkout, global `timmy`, Terminal windows and profiles, and evidence
folders are never touched. OpenRig stays excluded.

## Who owns what

Every owner branches from `r9/review-build` at the commit that added this file, works in a worktree of their own, and
commits only the files of their area. The lead merges each owner's branch, H162's first. Owners do not push and do not
open pull requests. For a file outside your area, ask in the handoff first. A one-line hook or a wording change you may
make yourself; say so there.

| Owner | Area | Branch | Files |
|---|---|---|---|
| H162 | Decision pricing declared, never inferred; refusals before anything is sent; exact model identity | `r9/h162-decide` | `src/decision/**`, `tests/decision-*.test.ts`, the decision lines of `src/workbench/fleet-tab.ts`, the decision section of `docs/ui-cockpit/FLEET-AND-DECISIONS.md` |
| H159 | Recordings: entities, frames and time range through the installed Rerun CLI, bounded, cached, logged; companion tab 6 | `r9/h159-rrd` | `src/vox/recording.ts`, a new `src/vox/rrd-cli.ts`, the recordings part of `src/vox/meshes.ts`, `src/companion/panels/create.ts`, `src/companion/client/panel-create.js`, their tests and fixtures |
| H160 | The Workbench's tab 6: meshes and recordings as items, in view at every supported size, with their actions | `r9/h160-items` | `src/workbench/create-tab.ts`, tab 6's part of `src/workbench/views.ts`, their tests |
| H161 | Dispatch cleanup (K); the running-block refusal (M) | `r9/h161-dispatch` | `src/utils/dispatch.ts`, `tests/dispatch-*.test.ts`, the block-run refusal paths of `src/workbench/controller.ts`, their tests |
| Lead | Integration; the connections across areas; the completion ledger; the 18-reference status; the Mac checks; the rehearsal driver; the freeze, gate, package and report | `r9/review-build` | everything else |

## How to work

1. Read `AGENTS.md`, `DESIGN.md` §10 (B9, B10) and this brief. Run `git status --short` before editing and before each
   commit.
2. Put Node 24 first on PATH. Work tests first: a failing test for the defect or the missing behaviour, seen failing, then
   the change.
   - Run only the suites you touch, one run at a time, under the shared lock (`flock <lock> npx vitest run <files>`).
   - Use a short TMPDIR, because one test depends on its length.
   - Your prompt gives the paths.
3. Stage by name, never `git add -A` or `git add .`; never `--no-verify`; the privacy hook must pass. Nothing committed
   holds personal information, keys, hostnames or home paths.
4. Words follow what Timmy observed. Installed is not working; a FAKE fixture is named FAKE; a check that did not run is
   not a pass. Every new screen state has a test that reads what it shows, not only its heading.
5. Work in small steps. Commit each working step and add a line to the shared handoff (`HH:MM PT · Hxxx · …`) at each
   commit, and at least every 15 minutes of work.
6. Report: commits, tests run with their counts and exit codes, captures, and what remains.
