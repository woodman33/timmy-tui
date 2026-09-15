# ORDER ui-v3-t9r2 · C1a — tokens.json is law · HOLD

C1 was split at C0 (§16). C1a binds the theme to the law and turns the colour gate into a real gate, with its §12 admission. C1b puts the five evidence states on every element that carries evidence and re-points the call sites whose meaning the law changes; C1c does uppercase category labels and the 8-column grid, and restores the text hierarchy this checkpoint flattens.

## What landed

- **Source material taken first** (per the amendment): PR #64's two commits, cherry-picked with `-x`: 66cacee (HANDS board, `timmy cockpit board import`) → dd2cb62; e564e56 (C5 bounded rows, capture-frames, test fixes) → c7f08a3. Both applied clean.
- **`src/tui/theme.ts` reads `lanes/visual/tokens.json`** (a JSON import with an import attribute; tsc emits the file into dist; verified under tsx, plain node, the tsc dist and the esbuild bundle by the review). Every value the TUI paints comes through ONE exported binding table, `BINDINGS` (21 tokens). The names the ~1,100 call sites already use are kept and bound to law values:

| token | was (Clearinghouse) | now (law) | note |
|---|---|---|---|
| ground · surface · void | navy #070C14 / #0B1322 | black #000000 | the void |
| surfaceRaised · grey1 | #111C30 | grey-1 #1A1A1A | raised surface |
| line · grey2 | #20304C | grey-2 #3A3A3A | structure lines |
| lineFocus · accent · structure | cyan #37D2FF | white #FFFFFF | the thing you are looking at: interaction is white, not a fifth hue |
| textPrimary | #D9E4F5 | white | reads |
| textSecondary · textMuted · grey3 | #8CA0BE / #46587A | grey-3 #8A8A8A | one grey for labels, hints, chrome, off-states — see the C1c debt below |
| seal · sealDim | #3BE08C | SEAL #33FF66 · #1F9E44 | receipts, verified, gate pass |
| danger · refuse | #FF5D75 | REFUSE #FF3B3B | refusal, gate fail |
| warn · predict | #F0B454 | PREDICT #FFB020 | **value binding only**: no `warn` site is a prediction; C1b re-points all of them |
| generated | — | GENERATED #8B5CF6 | model-made |
| ident | #B49AF5 | removed | zero consumers |

- **The gate** (`tests/design-contract.test.ts`, checkers in `src/tui/color-contract.ts`):
  - the law on disk equals the imported law; the binding table is total (every token bound, every binding present, every value a law colour; an extra token, a missing token or a binding to a colour the law lacks all fail);
  - no colour is chosen anywhere under src/tui (attic excluded, theme.ts included): raw hex in 3/4/6/8 digits, an Ink colour prop in any value shape (quoted, braced, ternary, spaced, multi-line, `rgb(`/`ansi256(`), an object-literal colour, a chalk colour member in any chain shape (`chalk.red.bold(`, `chalk.bold.red`, `chalk['red']`, tagged template, uncalled reference, `chalk.hex(x).bgRed(`), chalk bound under another name or destructured, another colour library, a raw colour SGR escape, a variable initialised from a colour name; comments are blanked first; screen/cursor escapes and Ink's dimColor/inverse/bold are admitted as non-colours;
  - panels never touch chalk at all (the older rule, kept verbatim); a walk-coverage control pins that the walk reaches the tree it claims;
  - **§12:** every rule runs over a committed known-defective artifact, `tests/fixtures/law-control.defective.tsx`, which must fail all eight source rules and does (32 violations), plus per-rule theme controls (the old green, danger bound to amber, a fifth hue, ten structural tokens painted in an accent, unbound/missing/ghost bindings) and the reviewers' 27 evasions; the admission is sealed as `gate.control` (below);
  - **scope, stated:** the gate covers src/tui. Surfaces outside it still choose colours today — `src/tui-opentui/spike.ts` (an orange the law does not have), `scripts/timmy-ui-smoke.tsx`, `cli.tsx`, `headless.ts`, `src/utils/{markdown,humanlog,logserver,dash}.ts`, `src/utils/chatpage.html` (the whole old palette), `src/forge/ForgePanel.tsx` — they are C1b's item, not this gate's claim. The three DESIGN.md §9.3 structural rules are kept and marked PROVISIONAL (admitted before §12, no FAIL demonstrated).
- `src/tui/components/ProgressBar.tsx`: the one off-token colour (`chalk.gray`) takes the muted token.
- `src/tui/components/ShellV2.tsx`, four one-liners from the review: the HANDS cursor cell gets `inverse` beside bold (with accent white it had gone blind against has-prompt cells on the same row — verified by an ANSI capture); the CHAT-mode DIM palette now dims accent, lineFocus and the new tokens (it never remapped accent, so the dimmed underlay would have kept full-white cells brighter than the overlay); the MODELS role header and the HANDS column header are bold; the BOARDS PROJECTS row is bounded like the other board rows (two names + a count) because from a worktree beside twenty other order worktrees it overflowed into an ellipsis that failed the warroom2 LIBRARY-at-120 gate — an environment-dependent test that was green only where C0 happened to run.

## Review (three lenses, adversarial) and what changed because of it

The first cut of the gate bound 9 of 22 tokens and its source checker was evaded by 44 of 53 colour-choosing forms the reviewers tried; both are closed above, each closure carrying its own control. The claim in this report's draft that "nothing went blind" was wrong for the HANDS cursor and is retracted. Two doctrine findings were accepted as written: `warn`→PREDICT and `ident`→GENERATED are not semantic bindings (`ident` is gone; `warn` is a transitional value binding and the `statusColor` doctrine header in color-contract.ts now says so). Findings deferred with their site lists:

- **C1b — re-point meaning.** 35 `warn` paint sites (running / queued / pending approval / needs-you / blocked / not-installed / cost / mode badge) that are not predictions; the SEAL green used decoratively at ShellV2 740 (active tab), 743, 891, 906, 966 (flash), 1015-1016 (fleet/bus), 1045, 1326, 1394, 1490, HOLD at 1558; ShellChrome 14 (NORMAL badge), 34 (chain segment regardless of chain state), 53 (key names); StatusGlyph completed; PanelFrame; ChatSurface PROOF label. HANDS HOLD in seal green beside a grey seal hash is the one actively misleading row. DispatchRail 128-129 values that were "live" cyan. Surfaces outside src/tui listed above. Stale doctrine comments (StatusGlyph "Tokyo Night", Pill "warn = queued/pending/cost", ShellChrome "human present = orange").
- **C1c — restore hierarchy.** textSecondary == textMuted collapses ten adjacent pairs into one grey: ShellV2 1256/1283 (role header vs model rows — bolded now), 1592/1597 (HANDS header vs rows — bolded now), 1064-1065 (hash/subject vs env-lock), 855 (sealed vs unsealed activity), 1001-1003 (hash vs fact), 1377 (aged log rows), ui/Card.tsx 52/55 (purpose vs overflow), ui/KeyHint.tsx 10-11 (key vs label), panels/LogRain.tsx 97, panels/DispatchRail.tsx 132, Onboarding.tsx 29. The law's answer is case, weight and spacing; C1c owns it.

## Gates

| gate | result |
|---|---|
| tsc · tsgo | exit 0 |
| design-contract (the law gate) | 19/19: 4 law, 3 coverage/source, 9 §12 controls, 3 provisional |
| full vitest | 93 files / 518 tests passed, 5 files / 15 tests skipped (13 new cases over C0's 505) |
| keyboard-contract | unchanged from C0: no live gate (FAIL row on the roster) |
| captures 120/80 | marker c1a-c7f08a3: 40 frames, fresh + operator (a scratch copy of the chain; the pinned store did not grow from any C1a render), 0/40 exceed their grid, privacy 0 |
| privacy on the changed files | 0 findings at any severity |

## §16

Started 06:41:11Z, code and gates green 06:47Z, review returned 06:54Z, review fixes and re-verification done 07:03Z: 22 minutes against 15. The overrun is the review round; recorded in checkpoints/C1a.json. C1b is split before it starts: C1b-1 the meaning re-pointing (the list above), C1b-2 the evidence-state model on carriers.

## Report

| check | result | seal id |
|---|---|---|
| theme derived from the law through one total binding table | 21 tokens, 0 violations | ui.v3.c1a |
| colour gate reads the law; every rule has a FAIL demonstration | 19/19 incl. 9 §12 controls | gate.control (admission) · ui.v3.c1a |
| no colour chosen outside theme.ts | 0 hits over 72 files | ui.v3.c1a |
| #64 taken as source | dd2cb62, c7f08a3 (from 66cacee, e564e56) | — |
| review must-fix items | 8 applied, 0 open; deferred items listed with sites | — |
| captures 120/80 | 40 frames · 0 over grid · privacy 0 | manifest cbe798f1f481 |
| tsc + vitest | 0 · 518/518 | — |

arsenal debt: n/a (unchanged: no roster row for the TUI; the verb is SHIP's).

**HOLD.**
