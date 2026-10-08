# Round R1: shared brief for the lead and the two workers

Updated 2026-10-08 16:00 PT by the lead (Opus). After the first hand-off, the Haiku worker keeps this file current; anyone may add a line under "For the lead".

## Where the work is

- Repository: `woodman33/timmy-tui` (public: never commit personal information, keys, hostnames or home paths; the privacy hook in `.githooks` runs on every commit).
- Integration branch: `feat/ui-workflow-r1` (only the lead pushes here). Draft PR #94, based on `feat/ui-cockpit`.
- `feat/ui-cockpit` / PR #93 is the qualified rc.2 candidate (C-19). It and `docs/ui-cockpit/c15/` to `c19/` stay exactly as they are.
- HOLD: no merge, no npm publish, no tag, no deploy. Development only: nothing in R1 is called qualified or launch-ready (AGENTS.md §5, §10).
- The ledger is `docs/ui-cockpit/CHECKPOINTS.md`. Only the lead writes it; rows 112 onward are R1.

## Objective

A functional, organized Timmy whose capabilities are easy to find and use: the REPL, the monitor, Timmy Canvas, the tools and the backends in one workflow that says where you are working, which tool or agent handles the task, what is happening, and where to inspect the editable result, preview and receipt. Then the Homebrew-inspired default look (DESIGN.md §10 B9).

## Done (on `feat/ui-workflow-r1`)

| Commit | What |
|---|---|
| `216392d` | Tools say when their service is missing or failed, with the setup step; nothing is invented; failed steps show and seal as `failed`. Each turn names its folder and model and ends with where to inspect the canvas job and the receipt page. `/tools` and `timmy tools` (the ladder: reachable, installed, needs setup, not built). `/canvas`, `GET /api/canvas/health`, one canvas address. |
| `f8f3564` | Timmy Homebrew, the default look, from `src/theme/tokens.ts`: terminal palette, theme files, a macOS Terminal profile with Monaspace Argon, `timmy theme install` defaults, the canvas panel and receipt page. |
| `66b6e7c` | No invented AgentPass passport, "VERIFIED" visa, storage or proof in lane panes; no random credentials or seeded "verified" log lines. |
| `13ac799` | An independent review's findings (ledger row 118): `get_env` checks names and values; the workspace command and `get_env` ask every time; "Outcome unknown" when a request may have run remotely; failed steps read "Run failed:" or "Not run:"; API lanes need their key in `timmy tools`; "used" dates count only turns sealed with `outcome_rule: 2`; no invented lane figures. |

Checks at `13ac799`: full suite 258 files passed, 7 skipped, 0 failed (2,276 tests, with `NODE_PATH` unset); `tsc` and `tsgo` clean.

## Who owns what

Work on your own branch from `origin/feat/ui-workflow-r1`. Commit only the files you own; ask under "For the lead" before touching anything else.

| Owner | Branch | Files |
|---|---|---|
| Lead (Opus) | `feat/ui-workflow-r1` | `src/agent/**`, `src/repl/` (main, turn, transcript, agent-bridge, approvals, seal, commands, canvas-view, web), `src/capabilities/**`, `src/studio/` (server, health, config, bridge, document), `src/term/theme.ts`, `src/utils/receipts.ts`, `package.json` and the lock, `DESIGN.md`, `CHANGELOG.md`, `docs/ui-cockpit/CHECKPOINTS.md` |
| Sonnet 5.5 | `r1/ui-sonnet` | `src/theme/**`, `src/term/palettes.ts`, `src/term/theme-files.ts`, `src/term/theme-install.ts`, `assets/themes/**`, `src/repl/demo.ts`, `src/repl/input-view.ts`, `src/repl/center.ts`, `companion/studio-canvas/**`, `src/studio/receipt-page.ts`, `scripts/ui/render.ts`, `scripts/ui/themes.ts`, the README section "Timmy Homebrew and the font", and their tests |
| Haiku 5.5 | `r1/tools-haiku` | `docs/ui-cockpit/R1-BRIEF.md` (this file), `docs/TOOLS-SETUP.md` (new), `src/utils/dispatch.ts`, `tests/dispatch-lanes.test.ts` |

Never touch: `studio/` (another hand's lab), `lanes/visual/tokens.json` (the visual law), `docs/ui-cockpit/c15/` to `c19/`, `c18-development/`, `PRIVATE-EVIDENCE.md`, `C16-ACCEPTED.sha256`, `main`, `feat/ui-cockpit`; on the operator's Mac: the global `timmy`, the operator's own checkout and Terminal windows and profiles, and `~/timmy/evidence`.

## Assignments

**Sonnet 5.5: organized UI and the theme**
1. `timmy repl --demo` says on screen that it is a scripted demonstration: no model, no tool ran.
2. A zellij Timmy Homebrew theme whose selected tab is Homebrew green and passes `tests/ui-zellij-theme.test.ts` (text 7:1, frames 3:1, selected tab 2.5:1 from the others); `timmy center` picks it under `TIMMY_PALETTE=homebrew`.
3. Timmy Canvas's panel and the receipt page use the REPL's words for where to inspect (Canvas, Receipt): each job's revision, receipt and time; readable at phone width; `tests/studio-canvas-browser.test.ts` stays green, and tldraw's chrome, fonts and the drawing's colors stay untouched.
4. `scripts/ui/render.ts` draws review pictures in Monaspace Argon on Timmy Homebrew, so pictures match the terminal profile.
5. Proposal only, no change to the law: what moving the monitor's focus to green would take (`docs/ui-cockpit/B9-MONITOR-PROPOSAL.md`).

**Haiku 5.5: inventory, setup documentation, checks, this brief**
1. Check every setup step `timmy tools` prints (`src/capabilities/index.ts`) against each tool's own documentation: agent-browser, oha, Ollama, Claude Code, Codex, Qwen Code, Trigger.dev, Composio, carbonyl, zellij, the Monaspace cask, and AgentPass and TaskForge's variables. List corrections under "For the lead"; the lead applies them.
2. Lanes honesty: `listLanes()` calls an API lane ready when only `curl` exists, and hyperframes when only `npx` does. Write the failing tests, then fix: a lane that needs a key needs its key set. Never print a key. (`timmy tools` already reads each lane's key from `LANE_RUNNERS` since `13ac799`; when `listLanes()` returns `key`, `src/capabilities/live.ts` uses it, so `/lanes` and `/tools` agree.)
3. `docs/TOOLS-SETUP.md`: each `timmy tools` row, what it needs, the exact setup step, and how to check it. Add the MCP servers in `config/mcporter.json` as a table, with no secrets and no hostnames.
4. Run the named suites, `tsc` and the privacy gate on the workers' branch heads, and record the results here.
5. Keep this file current: branch heads, PR states, CI, what merged, and open items.

**Lead (Opus): core behavior, outcomes and receipts, integration**
- Done: the invented AgentPass signals (`66b6e7c`) and the independent review's findings (`13ac799`).
- Apply Haiku's setup corrections. Review and merge the worker PRs into `feat/ui-workflow-r1`. Keep the ledger.
- Run the real workflow on the Mac (REPL, a canvas job, the receipt, `/tools`, the monitor), with captures, spending at most $0.50 of LIVE-01's remaining authorization.

## How to work

1. `git clone https://github.com/woodman33/timmy-tui && cd timmy-tui && git switch -c <your branch> origin/feat/ui-workflow-r1`
2. Use Node 24 or later. Run `npm ci`, then `git config core.hooksPath .githooks`.
3. Read `AGENTS.md`, `DESIGN.md` §10 (B1 to B9) and this brief.
4. Write tests first. Before each commit, run `npx vitest run <your suites>` and `npx tsc --noEmit -p tsconfig.json`. Stage files by name, never with `-A`.
5. Push your branch and open a draft PR with base `feat/ui-workflow-r1`. Through the REST API: `gh api repos/woodman33/timmy-tui/pulls -f head=<branch> -f base=feat/ui-workflow-r1 -f title=... -f body=... -F draft=true`. Never merge.
6. No paid model calls, no external spend, no new accounts, and nothing installed outside your own clone.
7. Labels stay honest: a key or a program on disk is "installed", never "working". A scripted demonstration says that it is scripted.

## Decisions so far

- Green is interaction (prompt, selection, primary action), not proof. Every outcome keeps its words (B9).
- The font is `@fontsource/monaspace-argon` 5.3.0 (OFL-1.1, with the Reserved Font Name "Monaspace"). Timmy serves it unmodified from 127.0.0.1, and it is never copied into the repository. Terminals get the font through a profile or printed lines, because a terminal draws in its own font.
- The monitor keeps the visual law's bindings this round. It picks up Timmy Homebrew's colors through the palette.
- The workspace command still runs on this machine when no Daytona key is set, and asks every time (its box has no "allow for session"; nor does `get_env`'s). When Daytona fails, nothing runs locally; when the connection broke after sending, the outcome is unknown and the tool says so.

## Open items and blockers

- The Mac run and captures (lead, in progress at `13ac799`).
- AgentPass and TaskForge: their services live outside this repository, and `timmy tools` shows them as needs setup. The spatial roadmap stays in its own records (COMMAND-CENTER-PLAN's next milestone and the private register). Neither is part of R1.
- In a workspace with `NODE_PATH` set, `tests/recipe-package` and `tests/inspect-package` resolve `tsx` globally and fail. Run the suite with `env -u NODE_PATH`.

## For the lead

(Workers: add a dated line here, or in your PR description.)
