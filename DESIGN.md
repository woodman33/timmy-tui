# DESIGN.md — TIMMY Trust OS visual system ("Clearinghouse")

> Governing document for every pixel the TUI renders. Supersedes
> `docs/UI-VISION.md` and every prior theme note. If a component and this
> document disagree, the component is wrong.
>
> Visual references: `design/refs/tui1.jpg … tui7.jpg`. These are **mood and
> discipline references, not layouts to copy** — our information architecture
> is our own (9 views, dispatcher, escrow spine). What we take from them is:
> a cool navy-black ground, cyan as the single interactive accent, green
> reserved for cryptographic truth, hard panel discipline (every box has a
> title row, a status pill, one job), and instrument-grade restraint.

## 0. Why the last five "change the theme" prompts failed

1. p05/p09/p10 all carried an explicit "no visual redesign" constraint — the
   agents obeyed it. That constraint is now **revoked**; this document is the
   new constraint.
2. `theme.ts` holds two palettes (Tokyo Night purple/orange + v1.0.4 neon
   cyan/emerald). Components pick whichever was nearest when written, so the
   app has no single voice. This document resolves to ONE palette and deletes
   the other.
3. There was no layout law — only tokens. Tokens without layout law produce
   recolored clutter. Sections 3–5 are the law.

---

## 1. The one-sentence identity

**TIMMY is a clearinghouse instrument: a quiet, dark, precise console where
agents do work and cryptographic receipts prove it — and the only thing that
ever glows green is proof.**

Every design decision serves that sentence. Not a hacker toy, not a neon
demo — an instrument you'd trust with money.

---

## 2. Tokens — the single palette (`src/tui/theme.ts` is rewritten to exactly this)

No raw hex anywhere outside `theme.ts`. Grep-enforced (see §9 gates).

### 2.1 Ground & surfaces (cool navy family — same hue family as the accent, per anti-slop law)

| Token | Hex | Use |
|---|---|---|
| `ground` | `#070C14` | terminal field / deepest background |
| `surface` | `#0B1322` | card interior fill (when bg is drawn) |
| `surfaceRaised` | `#111C30` | overlays: palette, modals, pills |
| `line` | `#20304C` | ALL default borders — hairline, barely-there |
| `lineFocus` | = `accent` | focused card border only |

### 2.2 Text (three steps, no more)

| Token | Hex | Use |
|---|---|---|
| `textPrimary` | `#D9E4F5` | values, content, anything the user reads |
| `textSecondary` | `#8CA0BE` | labels, subtitles, key hints |
| `textMuted` | `#46587A` | chrome, timestamps, disabled, empty-state prose |

### 2.3 Semantic accents — each has ONE meaning. Meanings never overlap.

| Token | Hex | Meaning (exhaustive) |
|---|---|---|
| `accent` | `#37D2FF` | **interaction**: focused border/title, active tab, selected row, live cursor, links |
| `seal` | `#3BE08C` | **cryptographic truth ONLY**: sealed receipts, verified chains, settled escrow, passed QA. Never decorates anything else. |
| `warn` | `#F0B454` | warning · queued · pending approval · cost figures |
| `danger` | `#FF5D75` | fail · denied · slashed · destructive confirm |
| `ident` | `#B49AF5` | **View 2 DAG identity nodes only.** Appears nowhere else in the app. |

Deleted outright: `brand`/`brandDim` purple chrome, orange `accent`,
`userColor` orange, `neonCyan`/`cardFocus`/`emerald`/`neonEmerald` duplicates,
`info` blue. One cyan, one green, one amber, one red, one caged violet.

### 2.4 Terminal "typography" (no fonts in a TTY — hierarchy is weight + color + case)

| Register | Recipe | Use |
|---|---|---|
| Display | **bold + accent/`textPrimary` + UPPERCASE** | card titles, view names |
| Label | `textSecondary`, lowercase | field labels, subtitles, hints |
| Value | `textPrimary`, normal | the data itself |
| Meta | `textMuted` | timestamps, ids, chrome |
| Proof | **bold + `seal`** | hashes, SEALED/VERIFIED — the only bold green |

Rules: bold is rationed to Display + Proof, plus the key of a key/label pair
and a category header (C1c: under lanes/visual/tokens.json the two greys are
one, so weight and dimness carry the hierarchy; §2.2's hexes are superseded). Italic only for reasoning text.
Never uppercase body content. Hashes render truncated `abc123f8…` +
full-on-focus.

---

## 3. Layout law (this is what kills the clutter)

1. **Chrome budget:** header = 1 row, footer = 1 row, forever (already law).
2. **Card anatomy — every bordered box follows exactly this:**

```
╭─ ◆ ESCROW LEDGER ────────────────────── [35 LIVE] ─╮
│ locks · draws · refunds · slashes                  │   ← purpose line, textSecondary, ONE line
│                                                    │   ← mandatory blank row
│  (content)                                         │   ← 1-col left/right padding
│                                                    │
│  …and 12 more · [↓] scroll                         │   ← overflow line, never silent clipping
╰────────────────────────────────────────────────────╯
```
   - Title row: focus glyph (◆ focused / ◇ not) + BOLD UPPER title, status
     pill right-aligned. Pills: `[RUNNING]` warn, `[SEALED]` seal,
     `[FAIL]` danger, `[n LIVE]` accent, `[IDLE]` muted.
   - **One card = one job.** A card may not contain two unrelated regions.
3. **Two-pane grammar, app-wide:** left pane = *act* (select, type, launch);
   right pane = *evidence* (what happened: logs, receipts, output). Same
   grammar in every 2-pane view so the user's eyes learn once.
4. **Density budget:** a card shows at most **7 list items** or **12 content
   rows** before the overflow line. No wall-of-text panes. Log-type panes
   render at most `paneHeight − 6` rows and always tail.
5. **Border discipline:** max nesting depth 2 (view card → inner region uses
   a `─` section rule, NOT another border). Never border a single line of
   text. Never draw a border to fill space.
6. **Whitespace is a token:** one blank row between regions, one col padding
   inside every border. Crowding = defect.
7. **Empty states are designed, not blank:** every pane defines one — muted
   one-liner stating what will appear here + the key that causes it. e.g.
   `no lanes running · [n] spawn one`.

---

## 4. Signature moments (exactly one per view — everything else stays quiet)

| View | Signature |
|---|---|
| 1 HOME | the **next-action cards** (three suggested moves, first one pre-focused) |
| 2 MISSION | the DAG — the only place `ident` violet exists |
| 3 TELEMETRY | the event rain, capped + dimmed, the app's ONE ambient motion |
| 4 ESCROW | the **SEAL**: bold green `[✓ CHAIN VERIFIED · 424]` chip + hash — the emotional payoff of the whole product |
| 5 LANES | live lane status dots (● pulse only while a lane is actually running) |
| 6 LIBRARY | in-pane carbonyl browser frame |
| 7 PROJECTS | project tree with inline gen counts |
| 8 SYSTEM | the auth & authority card (passport/visa/stamps) |
| 9 REVIEW | coverage/verdict meters |

Motion law (Ink constraints): transform tricks don't exist in a TTY, so
motion = state change. One braille spinner max per view, only while a real
operation runs. The LIVE dot pulse + View 3 rain are the only ambient
elements in the entire app. Nothing else animates at rest.

---

## 5. The user journey

### 5.1 First run (once, ~60 seconds, skippable with `s`)
1. **Identity** — one card: TIMMY wordmark, "your instance key" fingerprint,
   `[Enter] continue`.
2. **The grammar** — one card teaching the three keys that run everything:
   `1-9 views · Tab card · ^K anything`. Interactive gate: press each once.
3. **First proof** — fire a zero-cost local receipt seal live, show the green
   SEALED chip appear. "Everything TIMMY does ends in one of these."
   Then land on HOME.

### 5.2 View 1 = HOME (renamed from COMMAND), the guided flow
Today view 1 is a raw chat log next to a firehose relay — that's a debug
surface, not a home. New layout:

```
╭─ ◆ TIMMY ── good morning ───────────── [READY] ─╮ ╭─ ◇ LATEST PROOF ──╮
│ 3 lanes idle · 35 escrows locked · 424 receipts │ │ [✓ SEALED] rc_…9q │
│                                                 │ │ 04:38:27 · runs   │
│  ▸ 1 resume mission "blocking"    [Enter]       │ ╰───────────────────╯
│  ▸ 2 spawn a lane                 [5 then n]    │ ╭─ ◇ ACTIVITY ──────╮
│  ▸ 3 verify receipt chain         [4]           │ │ last 5 events,    │
│                                                 │ │ human sentences   │
╰─────────────────────────────────────────────────╯ ╰───────────────────╯
│ ▸ type a command or mission prompt…                                    │
```
Next-actions are computed from real state (unfinished mission, idle lanes,
unverified chain). Chat stays sovereign below. The raw log relay moves to
View 3 where it belongs — HOME's right column is *summarized* activity in
human sentences, 5 rows max.

### 5.3 Everywhere else
- Every view's header tab shows `n LABEL`; the focused card's purpose line
  says what it's for and its two most useful keys.
- `^K` palette is the universal escape hatch and lists every view + feature
  by name (already true — keep).
- Footer contract (p09) unchanged: MODE + keymap, 1 row.

### 5.4 Copy voice
Plain verbs, lowercase labels, sentence case content, zero emoji in chrome
(glyphs ◆◇▸●✓× only). Buttons/keys say what happens: `[g] approve`, not
`[g] go`. Errors state cause + recovery: `lane died: pi extension conflict ·
[r] restart without extensions`. Never apologize, never decorate.

---

## 6. Component kit (`src/tui/ui/` — new, replaces ad-hoc borders everywhere)

| Component | Contract |
|---|---|
| `<Card title glyph pill focused>` | the §3.2 anatomy; ONLY way to draw a border |
| `<Pill kind>` | status pill, kind ∈ seal/warn/danger/accent/muted |
| `<KeyHint keys label>` | `[g] approve` pair: the key bold white, the label grey-3 (C1c) |
| `<SectionRule label>` | `── label ──` inner divider (replaces nested borders) |
| `<Metric label value unit>` | label muted, value primary, tabular alignment |
| `<HashChip hash sealed>` | truncated hash, bold seal green when sealed |
| `<EmptyState line action>` | §3.7 |
| `<BudgetList items max render>` | list + `…and N more` overflow line |

Panels compose these; panels do not draw borders, pick colors, or bold
anything directly. That is how the theme stops drifting: there is nothing to
drift — panels have no visual vocabulary of their own.

---

## 7. Per-view relayout notes (beyond HOME)

- **4 ESCROW:** left ledger becomes `<BudgetList>` of `<Metric>` rows (7 max
  + overflow); right chain shows the last 8 receipts + the big VERIFIED seal
  chip pinned top. This is the demo view — it gets polish priority #2 after
  HOME.
- **3 TELEMETRY:** the audit file-switcher card shrinks to one row of tabs
  (`1-6` inline, no bordered button grid); log body uses Ink `<Static>` for
  scrollback (render law: never re-render history).
- **5 LANES:** lane list left (7 max), selected lane's live output right;
  the onboarding "this is your crew" banner collapses after first dismissal
  (persisted) instead of occupying 5 rows forever.
- **8 SYSTEM:** settings list unchanged structurally; Auth & Authority card
  adopts `<Metric>` + seal pills. Delete the giant blank middle — card height
  fits content.
- **2/6/7/9:** adopt Card/kit + density budget; no structural change this pass.

## 8. What is explicitly banned (anti-slop tells, terminal edition)

- Two palettes, or any hex outside `theme.ts`
- Borders as decoration; double borders; borders around one line
- Uppercase walls; bold body text; more than one bold color (seal)
- Green for anything that isn't cryptographic proof
- Spinners at rest; more than one ambient element; scrolling marquees
- Raw JSON dumps in a content pane (JSON belongs in View 3 raw mode)
- Silent truncation (`…` with no count/key)
- Emoji as icons in chrome

## 9. Acceptance gates (a redesign PR that skips these is rejected)

1. `rg -n '#[0-9a-fA-F]{6}' src/tui --glob '!theme.ts'` returns **zero** rows.
2. Existing suite green incl. `keyboard-contract.pty.test.ts` — the redesign
   may not touch the dispatcher.
3. New `tests/design-contract.test.ts`: theme exports exactly the §2 tokens;
   every panel imports from `src/tui/ui/`; density budget respected (BudgetList
   used for every list > 7).
4. PTY captures of all 9 views (extend `scripts/qa-keyboard-60s.ts`) pasted in
   the report — before/after per view. Terminal truth is the gate, per
   anti-slop law 6.
5. Every view walk shows: correct card anatomy, one signature, empty states
   where data is absent, no clipped content without an overflow line.
