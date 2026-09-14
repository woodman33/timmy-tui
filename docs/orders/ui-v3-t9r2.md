# ORDER ui-v3-t9r2 — the Timmy TUI, redone

Owner window: **UI-V3** (Claude Code, worktree `.claude/worktrees/order-ui-v3-t9r2`, branch `order/ui-v3-t9r2` from `origin/main` 01cd3a7).
Doctrine: §§11–16. Checkpoints ≤ 15 min, report, HOLD after each. Seals via the canonical CLI. `studio/**` read-only. Privacy scan before every commit. Captures at 120 and 80 columns at every checkpoint.

## The order (verbatim)

> ORDER ui-v3-t9r2 — the Timmy TUI, redone as the app people will actually use and the film will actually show. Branch from main AFTER #47 and the cockpit view land; do not rewrite from scratch — ShellV2, bounded rows, the wizard, DEMOS and CHAIN views are keep-and-improve. §§11–16; captures 120/80 at every checkpoint; privacy 0; tsc + vitest + keyboard-contract green; report + HOLD.
>
> C0 AUDIT: every screen, every key, every data source; a table of what exists / what's broken / what's missing vs the eight demo routes (ask the scene, predict-build-judge, render a world, refuse, eight hands, materialize, blank slate, factory day). No code.
> C1 VISUAL LANGUAGE: lanes/visual/tokens.json is law — black, white, Avenir/Helvetica, uppercase category labels, 8-col grid, accents only with meaning (SEAL green, REFUSE red, PREDICT amber, GENERATED violet), the five evidence states on every element that carries evidence. One theme module; no inline colors.
> C2 SHELL + NAV: tabs HOME · CHAT · RUN · COMMAND · CHAIN · HANDS · ENGINE ROOM · LIBRARY; one keyboard contract (number keys = tabs, j/k lists, Enter opens, s sends, r replays, ? key sheet floating at shell width); status line = run id · cost · arsenal debt · last seal. 80×24 and 120×40 both first-class.
> C3 RUN + COMMAND + CHAIN: the run id on every row and carried across all three; CHAIN typed views for every receipt kind in use (list them from the chain, not by hand); prediction beside evidence with the difference; REFUSE rows red with the reason.
> C4 DEMOS: `timmy demo run/list`; DEMOS rows fill ONLY from demo.<name> seals (cast hash + receipts); replay not byte-identical → STALE; [r] replays in-pane.
> C5 HANDS: rows from .timmy/private/cockpit/hands.json, cols = rounds, cell states idle|running|HOLD|STOP|needs-approval, [s] sends via `timmy cockpit send`; renders only when board.json exists; a fresh install never shows it.
> C6 ENGINE ROOM + LIBRARY: rows for Unreal, Houdini, Spline, Hana, Omma, Ollama (local/cloud FIT + schema), Sparks; LIBRARY families with evidence states; FLEET/SKILLS scroll.
> C7 FIRST RUN: `timmy init` wizard (operator, seed, providers, first project) writing only to .timmy/private and ~/timmy; HOME empty; release check green on a fresh container.
> C8 FILM FRAMES: the five moments captured with one run marker and a signed manifest sealed as ui.captures; reduced-motion variants; a 20-second cast of a real demo route.
> Acceptance: 28/28 screens fit; all eight routes reachable from the keyboard; demo replays byte-identical; arsenal debt visible; no personal data on any first screen. PR. HOLD each.

## Amendment (operator, 2026-09-14, during C0)

> Precondition amended: do NOT wait for #47 or #64. Branch from origin/main now. Treat #47 and the cockpit view as SOURCE MATERIAL: cherry-pick or re-implement per feature (ShellV2, bounded rows, DEMOS, wizard, HANDS view) onto your branch, with the commit ids you took from noted in the PR body. SHIP will close #47/#64 as superseded when your PR lands. tokens.json: create lanes/visual/tokens.json on your branch from the spec (black/white/Avenir/8-col/four accents/five evidence states); it's law from here. Finish C0, deliver the audit table, HOLD.

Source material and the commits taken from them are listed in the PR body as they are taken:
- PR #64 `order/ui-cockpit-k7m3` @ e564e56 — HANDS board (C1), bounded rows + capture-frames + test fixes (C5).
- PR #47 `order/ui-next-2` @ a92c949 (stacked on PR #46 `order/ui-next`) — DEMOS card, `timmy init` wizard, ENGINE ROOM unreal/houdini rows, OLLAMA card, SIGNAL panel, studio.preserve view.
- PR #59 `order/ui-cockpit-k7m3-c6` @ 386f99d — `timmy cockpit shot` (eight hands film shot).
- commit 6a5c9aa on `order/ui-cockpit-k7m3` — C4 INGEST (pane logs → cell states), dropped from #64.

## Checkpoint files

- `docs/orders/ui-v3-t9r2/C0-audit.md` — the audit (this checkpoint's deliverable); `docs/orders/ui-v3-t9r2/checkpoints/C0.json` — the §16 record (clock, overrun, split).
- Captures live in `.timmy/captures/` (gitignored); each checkpoint's manifest hash is cited in its seal.

## Report format per checkpoint

Table: check | result | seal id. Then "arsenal debt: <n>" for the surface touched. Then HOLD.
