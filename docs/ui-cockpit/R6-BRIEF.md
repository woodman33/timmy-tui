# Round R6: the connected review candidate (shared brief)

Written 2026-10-16 by the lead for the operator's order of 09:20 PT the same day. The lead keeps this file current; owners
add dated lines to the shared handoff and say what they finished in their report.

## The order, in short

R5 (`a77d80d`, draft PR #97) is an interim review build, not the finished UI; it and its evidence stay exactly as they are.
R6 continues on a new review candidate that carries the follow-up fixes of #98 (`r5/lead-followups` at `9e3bfd3`):

1. **Studio project isolation first.** Project identity, board, drafts, jobs, artifact links and save/action targets
   change together; edits are blocked while a switch is under way. Tested with two distinct disposable projects, pending
   drafts, delayed responses and save/reopen, proving neither project's content is written into the other.
2. **The remaining shared-state and interaction defects:** false live indicators, the false "Ollama needs setup" and
   NEEDS YOU, early cross-process Stop detection, the REPL's streaming at the terminal's width, and keyboard access to the
   whole `?` list. Chat cancellation and workflow-job cancellation stay truthfully distinct.
3. **The missing connected visual UI**, reusing the project's existing artifacts, adapters and viewers: VoxVision image
   and observation previews with spatial and recording inspection; a workflow's source, changes, outputs and receipts;
   Studio's reference images, custom nodes and project-linked artifacts; Tools & MCP request, schema and result
   inspection with usable actions through both MCP-to-CLI routes. A command list or a "not available" sentence does not
   complete a requested preview. An external engine that is not installed stays named as such; an existing capability is
   wired in instead of leaving its data absent from the companion. The 18 references and the black / amber / green system
   (DESIGN.md §10 B10) stay as they are.

Then: README claims the independent reviews contradicted are corrected; acceptance checks inspect actual board contents,
mutation targets and every displayed state; the integrated revision is packaged and verified with new checksums and new
independent reviews; completed reference requirements are reported apart from the remaining gaps. No technology research,
monetization work or redesign exploration in this round.

## Holds

Merge, npm publish, tags and deployment stay on HOLD. No paid model call, no external spend, no new account, no credential
copying, no large model download. The operator's own checkout, global `timmy`, Terminal windows and profiles and evidence
folders are never touched. OpenRig stays excluded.

## Who owns what

Every owner branches from `r6/review-build` at the commit that added this file, works in a worktree of their own, and
commits only the files of their area. The lead merges each owner's branch into `r6/review-build`; owners do not push and do
not open pull requests. A file outside your area: ask in the handoff first, or, for a one-line wording change, make it and
say so there.

| Owner | Area (priority) | Branch | Files |
|---|---|---|---|
| H139 | Studio project isolation (1); then Studio's waiting count, the first draw after an Accept, a pasted link in a not-loaded tab, "Canvas jobs" while a draft waits, "live" before anyone opened Studio | `r6/h139-studio-isolation` | `src/studio/**`, `companion/studio-canvas/src/**`, the REPL's canvas code (`src/repl/canvas-*.ts`, `src/repl/board-canvas.ts`), their tests |
| H140 | Shared-state truth (2): live indicators that follow what answered, one waiting count everywhere, Ollama's setup from its HTTP route, one set of stop words per kind (a chat turn's, a job's), the launcher's check in words | `r6/h140-frame-truth` | `src/ops/**` (the frame, `timmy op`), `src/capabilities/**`, `src/contracts/**`, `src/utils/receipts.ts`, the companion's connection cards, their tests |
| H141 | Terminal interaction (2): `x` and the run line see another process's turn at once, the REPL's answer keeps streaming at any width, the whole `?` list scrolls from the keyboard | `r6/h141-terminal` | `src/workbench/**` (but the three tab files below), `src/repl/` main, turn, transcript, input and editor files, the PTY tests |
| H142 | Tools & MCP inspector (3): servers, tools and their schemas; a request checked against its schema; calls through both MCP-to-CLI routes with request, response, result and receipt; the Workbench's tab 9 the same | `r6/h142-mcp-inspector` | `src/companion/panels/tools.ts`, `src/companion/client/panel-tools.js`, the Tools section of the page, `src/mcp/**`, the REPL's `/mcp` code it reuses, `src/workbench/tools-tab.ts` |
| H143 | VoxVision preview (3): observations with their images and overlays, spatial inspection, recordings; the Workbench's tab 5 the same | `r6/h143-vox-preview` | `src/companion/panels/vox.ts`, `src/companion/client/panel-vox.js`, the VoxVision section of the page, `src/vox/**`, `src/workbench/voxvision-tab.ts` |
| H144 | Workflow inspection (3): a run's source, changes, outputs and receipts in the run detail; the Workbench's tab 3 the same | `r6/h144-workflow-inspect` | `src/companion/run-detail.ts`, `src/ops/run-detail.ts`, the page's run detail, `src/workbench/workflows-tab.ts` |
| H145 | Studio artifacts (3), after H139: reference images, custom nodes, project-linked artifacts | `r6/h145-studio-artifacts` | as H139's, once H139's branch is merged |
| H146 | README and docs (after the fixes): every claim checked against the package | `r6/h146-docs` | `README.md`, `docs/**` but this brief and the reference matrix |
| Lead | Integration, the companion's panel extension point, the rehearsal and its acceptance checks, packaging, the gate, captures, the reference checklist, the independent reviews | `r6/review-build` | everything else, and merges |

## The companion's panel extension point (lead, in this commit)

A tab panel is a tab's own records drawn on the page. The page side registers in `src/companion/client/panels.js`
(`TimmyPanels.register(tab, { draw(host, frame, ctx) })`); `companion.js` draws the panel of the tab on screen, into the
element marked `data-panel-host="<tab>"`, when the tab is shown and when the frame changes. The server side mounts its routes
in `src/companion/panels.ts` under `/api/panel/<tab>/…`, token-checked, for the project the page shows. `panel-vox.js`,
`panel-tools.js` and `src/companion/panels/{vox,tools}.ts` are placeholders for their owners;
`tests/companion-panels-browser.test.ts` shows the contract.

## How to work

1. Read `AGENTS.md`, `DESIGN.md` §10 (B9, B10) and this brief. Run `git status --short` before editing and before each
   commit.
2. Node 24. Tests first: a failing test for the defect, then the fix. Run only the suites you touch, one run at a time.
3. Stage by name, never `git add -A` or `git add .`; never `--no-verify`; the privacy hook must pass. No personal
   information, keys, hostnames or home paths in anything committed.
4. Words follow what Timmy observed: installed is not working; a FAKE fixture is named FAKE; a check that did not run is
   not a pass. Every new screen state has a test that reads what it shows, not only its heading.
5. Report: commits, tests run with their counts and exit codes, captures, and what remains.
