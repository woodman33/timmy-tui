# B9 monitor proposal: moving the monitor's focus to green

Round R1, Sonnet 5.5 worker. **Proposal only.** Nothing here is built, `lanes/visual/tokens.json` is
not edited, and no test was changed for it. It answers one question: what would it take for the
monitor (`timmy watch`) to show focus and selection in Homebrew green, as the REPL, the zellij theme
and the browser pages now do?

Status of each claim below: **read** means I read it in the repository this round; **measured** means I
computed it from the repository's own colors with `contrastRatio`; **estimate** means a judgment I did
not exercise.

## Where things stand

- DESIGN.md §10 B9 already says it: the monitor "keeps the law's bindings (`lanes/visual/tokens.json`);
  it takes Timmy Homebrew's colors through the palette, and its focus moves to green only with a law
  amendment, not made in this round." (read)
- The law says the opposite for interaction: `white` is "structure · ring, rails, labels … THE THING
  YOU ARE LOOKING AT (focus, active tab, selected row): interaction is white, not a hue", and it admits
  four semantic hues only (seal green `#33FF66`, refuse red, predict amber, generated violet). (read:
  `lanes/visual/tokens.json` `note` and `color`; `src/tui/theme.ts` header)
- In code, focus is two bindings in `src/tui/theme.ts`: `lineFocus: 'white'` and `accent: 'white'`
  (`warn` and `structure` are white too). The focus looks come from `lineFocus` in three places
  (`src/tui/ui/Card.tsx`, `src/tui/components/PanelFrame.tsx`, `src/tui/utils/ergonomics.ts`), `accent`
  at about 320 call sites (374 for `accent`, `warn` and `structure` together), and inverse video for the selected row in 4 files (11 uses). (read, counted
  with `grep`)
- The monitor reaches the terminal as the palette's 16 colors (`src/term/law-palette.ts`): each law
  color is rewritten into one terminal slot by `LAW_ROLES`. White is the terminal's own text color;
  `seal` is the `verified` role, which is slot 2 (green) when that slot reads well. So on Timmy
  Homebrew the monitor already shows Homebrew green (`#28FE14`) for exactly one thing: the seal. (read)

## What "focus is green" would mean

Two different greens would share one terminal slot, and that is the real problem, more than the hex.

1. **The collision.** B9 says "green is interaction now, not proof, and every outcome keeps its word".
   The monitor's law says green is proof and nothing else (`colors.seal` is "the only bold green";
   `src/tui/color-contract.ts`: phosphor only on chain-confirmed statuses). If focus becomes green,
   a focused card border and a sealed receipt are the same color on screen. The monitor would have to
   say the difference some other way (a word, a glyph, or bold) or the law's best rule stops being
   true there.
2. **The slot.** `lawPalette` can only send a law color to one of the palette's roles. A new focus
   color needs a role that maps to slot 2 or 10 on Homebrew but is not the `verified` role, or it
   becomes indistinguishable from `seal` after the rewrite.
3. **Light grounds.** On Timmy Day (a light ground) a green that is bright enough for black does not
   read on white. Measured: `#28FE14` on `#FFFFFF` is about 1.4:1 (1.37), far below the 3:1 a frame needs
   and the 7:1 the monitor test requires of `accent` text. Day's own green slot is a darker green (`#0B7A3B`, 5.44:1 on white), so
   the rewrite would pick that; the pick must be tested, not assumed. (measured; the pick is an estimate)
4. **Terminals that were not measured.** The monitor drops a slot that misses 4.5:1 (macOS Terminal
   Basic already loses seal and predict that way; `tests/ui-monitor-theme.test.ts`). Focus must keep a
   non-color mark there (the `◆` and inverse video already carry it).

## What it would take

A law amendment, then four small changes, then the gate. In order:

1. **Amend the law (the operator's decision, not mine).** Add a fifth law color for interaction, for
   example `focus`, to `lanes/visual/tokens.json`, with a role line such as "FOCUS · the selected row,
   the focused card, the active tab, the prompt; interaction, never proof". Edit its `note` ("Four
   semantic accents only") and bump `version` and `order`; the file's `supersedes` block records the
   previous version's hash and would be refreshed by whoever amends it. Value: Homebrew green
   `#28FE14` (the shared `HOMEBREW_GREEN`), or a derived value if the operator wants the monitor's
   focus apart from the seal `#33FF66` (they are close, and a viewer will not tell them apart by hue).
2. **Bind it.** In `src/tui/theme.ts` add one `BINDINGS` entry and a role, and point `lineFocus` (and,
   if wanted, `accent`) at it. The binding table is checked as total, so the entry and the token set
   must land together. Leaving `warn` and `structure` white keeps their call sites unchanged.
3. **Map it.** In `src/term/law-palette.ts` add `focus` to `LAW_ROLES` with its own role (a new `Role`
   in the semantic map in `src/term/theme.ts`), so Timmy Homebrew gives it slot 10 (bright green) and
   Night, Day and measured terminals give it a slot that reads, or the terminal's own text color.
4. **Separate it from proof.** Decide how a sealed receipt differs from a focused card once both are
   green: the lowest-cost answer is that `seal` stays bold and always carries its word (`signed and
   verified`), and focus is never bold and never carries a status word. This is a rule to put in the
   law's `note`, and it needs a test (below).
5. **Update the tests that hold the law.** These fail on purpose when the law changes, and each needs a
   reviewed edit rather than a patch:
   - `tests/design-contract.test.ts`: "the four accents and the ground are exactly the law; interaction
     is white, not a fifth hue", the binding-total check, the "a fifth hue fails" negative control, and
     the structural-token control that lists `line` and `structure` as never painted in an accent.
   - `tests/ui-monitor-theme.test.ts`: add `focus` to the text-token floors (7:1 on Homebrew, Night,
     Day and the audited terminal) and a new case that a focused border is not the seal's color on any
     measured palette.
   - `tests/term-law-palette.test.ts`: the role for the new color.
   - A new check that no frame shows a green that is neither seal-with-its-word nor focus.
6. **Capture and look.** Run the monitor under Homebrew, Night, Day and the audited terminal with the
   existing capture scripts (`scripts/ui/capture.sh`, `scripts/ui/gate.ts`) and draw the pictures with
   `scripts/ui/render.ts`, so the operator judges real frames: a focused card next to a sealed
   receipt is the frame that matters.

## What it would not touch

`seal`, `refuse`, `predict` and `generated` keep their meanings and values. The REPL, zellij, the
browser pages and the canvas are unchanged by it: they already follow B9. The other `accent`,
`warn` and `structure` sites stay white unless the operator asks for them to move too.

## Risks and my recommendation

- **Highest risk: green that means two things.** It is the one change that weakens the law's most
  valuable rule. If the operator wants focus to be green, I recommend making `seal` stay the only
  *bold* green and requiring its word, as in step 4, and adding the test that enforces it. If they
  would rather not weaken it, the smaller change is to keep the monitor's focus white and let green
  appear only where B9 puts it outside the monitor (the prompt, the zellij tab).
- **Size.** Estimate: roughly 6 source lines in `theme.ts` and `law-palette.ts`, one new role in
  `src/term/theme.ts`, and edits to about 4 test files. It is small in code and large in review,
  because the law's tests are the review.
- **Not exercised.** I have not tried any of this. The measured 1.4:1 and the slot mapping above
  come from reading the code and computing contrast; no monitor frame was captured or changed.

## Decision needed from the operator

1. Should the monitor's focus move to green at all, or stay white and keep green for proof?
2. If it moves: the same `#28FE14` as the REPL, or a derived value that sits apart from `seal`?
3. If it moves: may the law file be amended (this document asked for no edit to it)?
