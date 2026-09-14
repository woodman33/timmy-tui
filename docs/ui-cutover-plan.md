# UI CUTOVER PLAN — v2 shell becomes default (ui.cutover-plan)

Status: **WRITTEN, NOT EXECUTED.** Execution is gated on: (a) spec §09 steps 1–8
all sealed, (b) the director's explicit word. Until then `TIMMY_SHELL=v2`
remains an opt-in flag and legacy stays the default. Sealed as `ui.cutover-plan`.

## 0. Why a plan, not a flip

Two key owners are mounted simultaneously under `TIMMY_SHELL=v2` today:

- **Root dispatcher** — `useKeyDispatcher` (src/tui/hooks/useKeyDispatcher.ts),
  mounted unconditionally in app.tsx. Nav-level globals: digits `1`–`9` →
  `gotoView(n-1)` (legacy 9 views), `l` jump telemetry, `q` quit, `?` legacy
  help, `^K` palette, `Tab` legacy pane cycle, `Enter`@view0 claim
  input:command.
- **Shell v2 machine** — `shellOnKey` (src/tui/shell-mode.ts) inside ShellV2.
  NORMAL: `1`–`4` tabs, `i`/`:` INSERT, `c` CHAT, `?` which-key, `j/k` move,
  `Tab` pane, `/` filter, `Enter` single action. INSERT/CHAT: digits are TEXT.

Consequences while both live (the shadowing flagged at step 1):

1. Digits double-fire: the root mutates the legacy `view` state (invisible,
   ViewStage returns ShellV2 regardless) AND the shell switches tabs — two
   truths for one keypress.
2. `?` at shell NORMAL claims `modal:help` on the root focus stack; the legacy
   help overlay is gated off under v2, so the stack top swallows every
   subsequent key until Esc — a trap with no visible cause.
3. `q` quits and `l` jumps telemetry from inside the shell's NORMAL mode,
   contradicting the shell keymap printed in its own footer.
4. `Enter` at shell HOME claims `input:command` (legacy chat) instead of the
   shell's CHAT mode.

None of these are fixable by patching either owner: the defect is that nav-level
routing exists in two places. Hence the cutover moves the root dispatcher's
nav level INTO the shell, leaving one reducer.

## 1. Cutover sequence (executed after step 8, in one release commit)

**C1 — default flip.** `ViewStage` (src/tui/views.tsx) inverts the gate:
render `<ShellV2>` unless `TIMMY_SHELL === 'v1'`. The env var keeps its current
name and gains its legacy value; no new flags.

**C2 — legacy preserved, one release.** With `TIMMY_SHELL=v1`: legacy 9-view
`ViewStage` branches, legacy help overlay (app.tsx gate inverted to render only
under v1), root dispatcher nav globals, and `KEYMAP` legacy table all remain
byte-identical. README + CHANGELOG carry: "legacy shell available via
TIMMY_SHELL=v1 through release N; removed in N+1." Nothing under v1 may be
"fixed" during the legacy window — it is frozen evidence.

**C3 — dispatcher moves into the shell.** The root dispatcher loses its nav
level under the default path:
- `useKeyDispatcher` keeps ONLY stack mechanics: Esc pop-before-owner, modal
  routing (palette/help/receipt), `input:*` residue delivery, `^C` quit. Its
  nav globals (digits, `l`, `q`, `?`, `Tab`, `Enter`@home) are deleted from the
  hook and re-expressed as entries in `KEYMAP_SHELL` / `shellOnKey`:
  - digits `1`–`4` → tabs (already there); digits `5`–`9` become shell actions
    that map onto the legacy surfaces now living in LIBRARY/RUN tabs (step 7),
    or are dropped where the surface was retired — decided per-key at cutover
    time against the step-7 LIBRARY inventory, listed in the cutover commit
    message.
  - `q` → shell NORMAL quit action (footer hint), `?` → which-key (already),
    `^K` retired per director reconciliation (a), palette reachable via which-key
    action row; `Tab` → shell pane cycle (already); `Enter` → shell per-tab
    single action (already), CHAT claim lives in CHAT mode.
- Under `TIMMY_SHELL=v1` the root dispatcher is constructed with its current
  nav globals intact (a `legacyNav: boolean` dep), so v1 behavior is unchanged.
- Result: exactly one reducer maps a digit in each mode; INSERT/CHAT digits are
  text by construction because the shell machine owns them and the root no
  longer sees nav keys.

**C4 — focus-stack alignment.** Shell overlays (which-key, receipt detail,
  filters) claim/release on the SAME focus stack the root mechanics use, so Esc
  ordering stays structural. The `modal:help` claim path is removed with the
  legacy overlay; which-key is a shell overlay, not a modal claim.

**C5 — gates that must pass before the flip commit lands.**
- Full suite green parallel 3× in a row (corr-1 bar), with the keyboard suite
  run twice: default (v2) and `TIMMY_SHELL=v1`, both green.
- Color-contract gate green on captures of all four v2 tabs AND the nine v1
  views.
- Before/after tmux captures (120×32 and 80×24) for v2 default and v1 legacy,
  diffed against the step-3 capture set; facts win over captures on conflict.
- `timmy seal ui.cutover` citing this plan's hash, the suite runs, and the
  capture set.

**C6 — rollback.** Any regression inside the legacy window: user sets
`TIMMY_SHELL=v1`; no data migration exists or is needed (the shell reads the
same chain/bus/store). Agent-side rollback = revert the cutover commit; the
chain is untouched by UI code either way.

## 2. Removal (release N+1, separate order, not this plan)

Delete: legacy `ViewStage` branches, legacy `KEYMAP` table + help overlay,
`legacyNav` dep, panels not carried into LIBRARY/RUN (moved to src/tui/attic/
with their tests, per the attic convention). `TIMMY_SHELL` env var is retired
entirely at that point (unknown values warn once, never crash).

## 3. Explicit non-goals

- No receipt-schema, bus, store, or CLI-surface change at cutover.
- No key is silently repurposed: every nav global either lands in KEYMAP_SHELL
  with a footer/which-key hint or is listed as retired in the cutover commit.
- Onboarding (modal:onboarding) stays sovereign through the cutover.

## 4. Do-not list until execution

- Do not flip the default, do not delete nav globals, do not touch v1 paths.
- Steps 4–8 continue to build inside ShellV2 behind the flag.
