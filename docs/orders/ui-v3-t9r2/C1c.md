# ORDER ui-v3-t9r2 · C1c — the ten label/row pairs, by weight and dimness · HOLD

## The rule applied

The law admits three greys and says hierarchy comes from case, weight and spacing. Under it `textSecondary` and `textMuted` are one grey (grey-3), so ten label/row pairs that the old palette told apart by two greys had collapsed into one. C1c restores each pair with the terminal's own two dials — **weight** (SGR 1, bold) and **dimness** (SGR 2, dim) — and never a fourth grey, never a new colour. The colour set of every captured frame is unchanged from C1b-2; only bold and dim escapes were added (0 → 99 dim escapes across the forty frames; the bold count is unchanged at 202 because the two headers were already bold).

## The pairs (eleven — C1a named eleven sites; the count in the order's wording was ten)

| # | site | the pair | now |
|---|---|---|---|
| 1 | `src/tui/ui/Card.tsx` | purpose line vs overflow line | overflow dim |
| 2 | `src/tui/ui/KeyHint.tsx` | `[key]` vs label | key bold white, label grey-3 |
| 3 | ShellV2 CHAIN row | hash + subject vs env-lock cell | env-lock dim, except on the selected row and on a refused row; the inline overflow line dims like Card's |
| 4 | ShellV2 HOME ACTIVITY | sealed rows vs unsealed rows | unsealed text dim (the mark stays) |
| 5 | ShellV2 HOME journey done row | hash vs fact | fact dim |
| 6 | `src/tui/panels/LogRain.tsx` (v1) | fresh rows vs aged rows | rows past 9 dim |
| 7 | `src/tui/panels/DispatchRail.tsx` | label/value rows vs status message | the idle hint dim; a rejected/denied/refused message REFUSE red and plain (never decorative, never receding) |
| 8 | `src/tui/Onboarding.tsx` | the five-step wordmark ramp | bold · bold · plain · plain · dim over white, white, white, grey-3, grey-3 |
| 9 | ShellV2 MODELS role header | header vs rows | bold (C1b-1); the uppercase variant was tried and reverted — spec §06 pins `role:` (tests/library-pane.test.tsx) |
| 10 | ShellV2 HANDS column header | header vs rows | bold (C1b-1) |
| 11 | ShellV2 LOG RAIN (v2, CHAT tab) | fresh rows (0–2) vs aged rows | rows from 3 dim on the text (refused rows never); the mark span dims past 8 as before |

**What the frames evidence.** The forty captured frames show pairs 1, 3, 5 and 9 (Card and ChainPane overflow lines, the CHAIN env-lock cells, the journey facts, the bold `role:` headers) and the dim count moves 0 → 99 with no new colour. Pairs 2, 4, 6, 7, 8, 10 and 11 rest on code reading, the type check and the unit tests, not on frames: KeyHint has no v2 consumer (FilesPanel, v1); no unsealed ACTIVITY row occurs in either capture set; LogRain.tsx and DispatchRail are v1 panels; Onboarding is mounted by app.tsx, not by the capture harness; the HANDS board is absent in both sets; LOG RAIN needs more than the one bus event the fresh set produces. The report says so rather than implying forty frames prove eleven pairs.

**Dim is the terminal's dial.** SGR 2 on grey-3 over black lands near 2.2–3.1:1 depending on the emulator, and a terminal that ignores SGR 2 for 24-bit colour collapses the pair again; bold is the safer dial and is used for the header and key pairs. The trailing-span pairs (fact, env-lock, overflow, aged rows) also keep their two-column gutters, so the hierarchy survives a terminal without dim.

**The rule, narrowed.** C1b-2 sealed *dim ⇔ the law's opacity < 1* for the evidence looks; C1c states it precisely in `src/tui/evidence.ts`: a MARK cell is dim only when stale; dim on a trailing span that carries no evidence — the fact after a hash, an env-lock citation, an overflow line, an aged log row — is hierarchy, never a state. No ✓, ●, ○, ◉ or × mark is dimmed by C1c.

Uppercase category labels: the Card titles are already uppercase (`◇ RUNS`); the role header stays lowercase by spec; no other label was cheap to change without touching a pinned string, so none were.

**Deferred to C2 with a reason:** the law's 8-column grid (`grid.columns 8`, gutter 2, margin 1). The v2 shell's row plans (`src/tui/utils/rows.ts`, the C5 row solver) size panes by character budget per tab; mapping them to an 8-column grid is a layout change to every pane, not a token change, and it belongs with C2 SHELL+NAV where the pane geometry is decided. The tokens carry the grid; nothing renders against it yet, and this doc says so.

## Review

One adversarial lens, read-only: escape-level regression by ANSI capture against C1b-2 plus the law, with the affected tests re-run. It confirmed the colour set of every frame is a subset of C1b-2's, every added escape is SGR 2 at a claimed site, and no real text changed; then it returned HOLD-not-sealable on three points, all applied before the seal: the dim on ✓ journey facts made C1b-2's sealed sentence *dim ⇔ stale* false as written (the rule is now stated precisely in `evidence.ts` — a mark cell is dim only when stale; dim on a trailing non-evidence span is hierarchy — and no mark is dimmed); C1a's debt list named eleven sites and the v2 LOG RAIN tier on the CHAT tab had been skipped for its v1 twin (treated: rows from 3 dim, refused rows never); and the report implied forty frames evidenced every pair when they evidence four (stated above). Minors applied: the env-lock dim no longer lands on the selected or a refused row; ChainPane's inline overflow line dims like Card's; DispatchRail's rejected/denied/refused messages stay REFUSE red and plain; DESIGN.md §2.4 and the §6 KeyHint row are amended to the law; the terminal dependence of SGR 2 is stated; the manifest's base-commit convention is supplemented by the worktree diff sha. Recorded, not fixed: dim on grey-3 reads at roughly 2.2–3.1:1 (accepted as the terminal's dial, with gutters as the fallback); DOCTRINE §13/§15/§16 are still not on this branch — a standing §14 gap since C0, resolved by the operator's decision that SHIP cherry-picks 7dddc65; until then the §16 clocks cite the doctrine.update seals rc_mu0jrdfz_5ngp, rc_mu0jre2f_zrce and rc_mu0jreog_ixfw, which exist in the pinned chain; the scope narrowing against C1a's wording (grid deferred, uppercase reverted) is declared above for the operator to accept at HOLD.

## Gates

| gate | result |
|---|---|
| tsc · tsgo | exit 0 |
| evidence · design-contract · chain-pane · run-pane · home-journey · cockpit-board · bounded-rows · cutover · library-pane · tui-ergonomics · tui-color-contract | 11 files / 72 tests green |
| full vitest | 94 files / 531 tests passed, 5 files / 15 tests skipped (unchanged from C1b-2: no test was added or altered) |
| captures 120/80 | marker c1c-d05b62a: 40 text + 40 escape-kept frames, 0/40 exceed their grid, privacy 0 over 81 files; the colour set of every frame ⊆ C1b-2's (eight sequences, none new); text identical to C1b-2 apart from receipt ids, hashes and stamps; the manifest names the base commit d05b62a, so the rendered tree is pinned by the sha256 of `git diff` at capture time, df383185dd96 |
| privacy on the changed files and these docs | 0 new (two pre-existing review-severity terms at DESIGN.md:43, not touched here) |

## Report

| check | result | seal id |
|---|---|---|
| the pairs restored by weight or dimness | 11/11 (C1a named eleven; two were already bold; one uppercase variant reverted by spec) | ui.v3.c1c |
| no fourth grey, no new colour | every frame's colour set ⊆ C1b-2's; +99 dim escapes, +0 colours | ui.v3.c1c |
| 8-col grid | deferred to C2 with the reason above | — |
| captures 120/80 | 40 text + 40 escape-kept · 0 over grid · privacy 0 · frames evidence pairs 1, 3, 5, 9 | manifest 1bd3081e3035 · worktree diff df383185dd96 |
| tsc · tsgo · vitest | 0 · 0 · 531/531 | — |

arsenal debt: n/a (unchanged).

## §16 clock

Started 10:03:59Z, code and types green 10:05Z, captured and full suite green 10:10Z, review returned 10:20Z with eleven findings, must-fix and minors applied, re-captured and the full suite green again 10:23Z, sealed 10:25Z: **21 minutes against 15.** The review round again; this one was worth its cost (a sealed sentence would otherwise have been left false). §16's text is not on this branch (a standing §14 gap since C0; SHIP cherry-picks 7dddc65 per the operator's decision), so this clock cites the doctrine.update seals rc_mu0jrdfz_5ngp, rc_mu0jre2f_zrce and rc_mu0jreog_ixfw in the pinned chain. Recorded in checkpoints/C1c.json. C1 is complete at HOLD; C2 SHELL+NAV follows on the operator's word.

**HOLD.**
