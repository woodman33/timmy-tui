# Round R1: shared brief for the lead and the two workers

Updated 2026-10-08 20:10 PT by the lead (Opus). The Haiku worker's thread stalled before its first hand-off, so the lead keeps this file current; anyone may add a line under "For the lead".

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

| `458a015` | From the live run on the Mac: a canvas call that fails keeps nothing (undone to a history mark), and a call that crashed tldraw's page restarts it from the canvas as it was before the call; answers say `rolledBack`, `restarted`, `changed`; jobs are marked by their last call with failed calls counted. |
| `af536cb` | `canvas_exec` carries a drawing that works in this tldraw (tested in a real browser); a turn that ends at its step or spend limit with a call open says so; `~/…` for a home reached through a link. |

| `8db45cd` | Merged PR #95 (Sonnet): the demo label, zellij Timmy Homebrew, the Canvas and Receipt words on the panel and receipt page, Monaspace Argon review pictures, and the B9 monitor proposal (ledger row 120). |
| `1bd8f6b` | The monitor only reads when it opens (no `model.policy` seal, no policy write) and its header names the model the REPL last ran; `listLanes()` needs an API lane's key and hyperframes' own command; CI runs its full gate on pull requests into `feat/**` (ledger row 121). |

Checks at `1bd8f6b`: GitHub's full CI gate passed on PR #94 (the first full run for R1: `tsc`, `tsgo`, vitest except the named known-WIP, `workers/ai-proxy`, the PTY keyboard test); locally, shell suites 111 tests and lane suites 52 tests passed.

Checks at `8db45cd`: full suite 261 files passed, 7 skipped, 0 failed (2,322 tests, with `NODE_PATH` unset); `tsc` and `tsgo` clean. The real workflow ran on the operator's Mac three times (ledger row 119): the last run drew the task in one call for $0.012.

## Who owns what

Work on your own branch from `origin/feat/ui-workflow-r1`. Commit only the files you own; ask under "For the lead" before touching anything else.

| Owner | Branch | Files |
|---|---|---|
| Lead (Opus) | `feat/ui-workflow-r1` | `src/agent/**`, `src/repl/` (main, turn, transcript, agent-bridge, approvals, seal, commands, canvas-view, web), `src/capabilities/**`, `src/studio/` (server, health, config, bridge, document), `src/term/theme.ts`, `src/utils/receipts.ts`, `package.json` and the lock, `DESIGN.md`, `CHANGELOG.md`, `docs/ui-cockpit/CHECKPOINTS.md` |
| Sonnet 5.5 | `r1/ui-sonnet` | `src/theme/**`, `src/term/palettes.ts`, `src/term/theme-files.ts`, `src/term/theme-install.ts`, `assets/themes/**`, `src/repl/demo.ts`, `src/repl/input-view.ts`, `src/repl/center.ts`, `companion/studio-canvas/**` (except the bridge in `src/canvas.js`: `attachEditor`, `restore`, `connectBridge`, `mount`, which the lead keeps since `458a015`), `src/studio/receipt-page.ts`, `scripts/ui/render.ts`, `scripts/ui/themes.ts`, the README section "Timmy Homebrew and the font", and their tests |
| Haiku 5.5 | `r1/tools-haiku` | `docs/ui-cockpit/R1-BRIEF.md` (this file), `docs/TOOLS-SETUP.md` (new), `src/utils/dispatch.ts`, `tests/dispatch-lanes.test.ts` |

Never touch: `studio/` (another hand's lab), `lanes/visual/tokens.json` (the visual law), `docs/ui-cockpit/c15/` to `c19/`, `c18-development/`, `PRIVATE-EVIDENCE.md`, `C16-ACCEPTED.sha256`, `main`, `feat/ui-cockpit`; on the operator's Mac: the global `timmy`, the operator's own checkout and Terminal windows and profiles, and `~/timmy/evidence`.

## Assignments

**Sonnet 5.5: organized UI and the theme** (round 1 done: PR #95, merged as `8db45cd`; branch again from `origin/feat/ui-workflow-r1` for anything next)
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

- Done: the Mac run and captures (ledger row 119); the monitor's `model.policy` seal on open and its header model (fixed in `1bd8f6b`).
- Haiku's assignments, finished by the lead: item 2 (lanes) is in `1bd8f6b`; item 4's CI is green. Item 1 was checked by an internal helper against each tool's own docs from a clean clone at `4a1aec8`: the steps for agent-browser, Ollama, Claude Code, Codex and Qwen Code need correcting and carbonyl has none. Those corrections and item 3 (`docs/TOOLS-SETUP.md`, drafted) are the next increment.
- Composio: the tool calls a Composio API version that Composio has removed, so a set key shows "installed" while every call fails. A defect, open; its fix is a separate decision.
- `timmy tools` does not load the working folder's `.env`, while the REPL's `/tools` does, so a key kept only in `.env` reads differently in the two (found by reading the imports, not yet run).
- Signatures: GitHub reports `unknown_key` for `8db45cd`, `4a1aec8` and `1bd8f6b` (ledger row 121). The commits stay as pushed, by the owner's instruction.
- The jobs ledger records a call only once the canvas has been saved, so a call that fails before the first save is not counted in a job's failed calls.
- AgentPass and TaskForge: their services live outside this repository, and `timmy tools` shows them as needs setup. The spatial roadmap stays in its own records (COMMAND-CENTER-PLAN's next milestone and the private register). Neither is part of R1.
- In a workspace with `NODE_PATH` set, `tests/recipe-package` and `tests/inspect-package` resolve `tsx` globally and fail. Run the suite with `env -u NODE_PATH`.

## For the lead

(Workers: add a dated line here, or in your PR description.)
