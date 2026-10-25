# Tokens — the B11 registry (ACCEPTED, `src/theme/tokens.ts`, emitted by `themeCss()` as `--timmy-ui-*`)

Two namespaces live in `/timmy-theme.css`:

- `--timmy-*` (B10, the legacy web names) — **ACCEPTED (D12, 2026-10-24):** each is an ALIAS of its B11 role, written by
  `themeCss()` as `--timmy-ground: var(--timmy-ui-canvas)` and so on (`LEGACY_WEB_ALIAS` in tokens.ts): one palette on every
  page, the family reaching the legacy sheets too. New work reads the `--timmy-ui-*` names only. The alias table is below.
- `--timmy-ui-*` (B11) — the one semantic set below; Amber (default) and Glacier families on it under `html[data-theme]`.

The terminal keeps B10 byte-for-byte (`HOMEBREW`, `HOMEBREW_TERMINAL`; pinned by `tests/theme-tokens.test.ts`).

## Shared roles (both families)

| Variable | Value | Role | Measured (WCAG) |
|---|---|---|---|
| `--timmy-ui-canvas` | `#080B0F` | the page ground | text 17.3 · secondary 11.9 · muted 8.7 |
| `--timmy-ui-surface` | `#111A23` | a panel, a well | text 15.4 · secondary 10.6 · muted 7.8 |
| `--timmy-ui-raised` | `#1C2936` | a raised card, an input, a menu | text 13.0 · secondary 8.9 · muted 6.55 |
| `--timmy-ui-paper` | `#E8EFF5` | the ONE light focal object of a task; never a page background | ink 11.7 · ink-soft 7.1 |
| `--timmy-ui-border` | `#44586B` | a control's / card's border (structure; a control also has its words or fill) | 2.7 on canvas |
| `--timmy-ui-border-quiet` | `#1E2A36` | hairlines that only separate | — |
| `--timmy-ui-text` | `#ECF1F5` | primary text | ≥ 13 on every dark surface |
| `--timmy-ui-text-secondary` | `#BDCADA` | secondary text, labels | ≥ 8.9 |
| `--timmy-ui-text-muted` | `#9AAFC3` | hints, fine print | ≥ 6.55 (the 6:1 neutral floor) |
| `--timmy-ui-ink` | `#1C3043` | text on paper and on the accent's light end | 11.7 on paper |
| `--timmy-ui-ink-soft` | `#3B5168` | secondary text on paper | 7.1 on paper |
| `--timmy-ui-focus` | `#FFB000` | the focus ring, the primary's edge, intent / predict, what waits on you, a failure with ✕ | 10.8 on canvas |
| `--timmy-ui-focus-halo` | `#080B0F` | the 2 px gap under the ring: how the ring is seen on paper (focus on paper alone = 1.58) | 17.0 on paper |
| `--timmy-ui-verified` | `#28FE14` | an OBSERVED live / passed / sealed state only | 14.3 on canvas; 1.2 on paper → never a colour alone on paper |
| `--timmy-ui-verified-dim` | `#00D700` | the same meaning, smaller marks | — |
| `--timmy-ui-diff-add` / `-diff-remove` | `#28FE14` / `#FF5F56` | diff markers only (B5) | — |

## The families (`:root, :root[data-theme="amber"]` and `:root[data-theme="glacier"]`)

| Variable | Amber | Glacier | Role |
|---|---|---|---|
| `--timmy-ui-accent` | `#D6AA64` | `#8ABBE3` | the family's key: the primary's dark end, the active rail cue, the kicker's number |
| `--timmy-ui-accent-soft` | `#EAD0A3` | `#BED9ED` | the light half: active words on dark, the active tool |
| `--timmy-ui-accent-ink` | `#402E14` | `#1D3848` | the primary's label (6.05 / 6.02 on the accent; the study's #5B421D / #244761 measured 4.37 / 4.79) |
| `--timmy-ui-accent-start` | `#F0E5D4` | `#E1EEF7` | the primary gradient's light start |
| `--timmy-ui-accent-wash` / `-glow` | accent at .08 / .18 | accent at .08 / .18 | the canvas wash, the primary's halo |
| `--timmy-ui-swatch-amber` / `-glacier` | `#D6AA64` | `#8ABBE3` | both keys, for the theme switch |

A status's meaning never moves with the family. The viewer's choice is `localStorage` `timmy.theme`; `TimmyShell.theme(name)` sets
`html[data-theme]` and emits `theme { name }` (the native artboards follow it).

## Type (D2: one system across HTML and the native artboards)

| Variable | Value |
|---|---|
| `--timmy-ui-font` | `"Outfit", "Outfit Variable", "Monaspace Argon", system-ui, sans-serif` — titles, labels, body, controls |
| `--timmy-ui-font-mono` | Monaspace Argon's stack — paths, hashes, commands, code, keys (`code, kbd, pre, samp, .cmd`) |
| `--timmy-ui-size-page / -section / -body / -label` | 30 / 18 / 14 / 13 px (13 px is the page's floor) |
| `--timmy-ui-weight-body / -medium / -strong / -heading` | 400 / 500 / 600 / 600 |
| `--timmy-ui-leading-tight / -body / -label` | 1.15 / 1.55 / 1.35 |
| `--timmy-ui-tracking-kicker / -title` | 0.14em (uppercase kickers) / -0.02em |

Outfit is served by the companion's own build at `/web/fonts/outfit-latin-wght-normal.woff2` (@fontsource-variable/outfit, OFL);
the face is `local()` first; the Studio's `/fonts/` gets the local sources only. The artboards embed `Outfit.ttf` (RIVE CONTRACT v2).

## Spacing, radii, elevation, motion

- `--timmy-ui-space-1 … -8` = 4 8 12 16 24 32 48 64 px.
- `--timmy-ui-radius-control / -panel / -workspace / -pill` = 10 / 16 / 22 / 999 px.
- `--timmy-ui-elev-canvas / -surface / -raised / -paper / -primary / -rail / -top` — the only gradients (surface, depth, the
  primary action); a page writes `background: var(--timmy-ui-elev-surface)`, never a gradient of its own.
- `--timmy-ui-shadow-panel / -raised / -paper / -primary`, `--timmy-ui-highlight`, `--timmy-ui-scrim`.
- `--timmy-ui-motion-feedback / -state / -panel` = 120 / 180 / 220 ms, `--timmy-ui-ease`; under `prefers-reduced-motion` the
  sheet sets the three to 0 ms (a page that uses the variables needs no media query of its own).

## Focus

`:focus-visible { outline: 2px solid var(--timmy-ui-focus); outline-offset: 2px; box-shadow: 0 0 0 2px var(--timmy-ui-focus-halo) }`
on the shell. The page title that takes the focus when a page opens (D11) carries the same token ring, offset 6 px (D17 / R90:
never a UA or dashed box). A focus ring is always `--timmy-ui-focus`, never `--timmy-accent` (that name is the family's now).

## The B10 web names as aliases (D12)

| B10 name | Is now | Note |
|---|---|---|
| `--timmy-ground` | `--timmy-ui-canvas` | |
| `--timmy-surface` / `--timmy-raised` | `--timmy-ui-surface` / `--timmy-ui-raised` | wells are no longer #070707: a panel is surface, an input or menu raised |
| `--timmy-line` / `--timmy-line-strong` | `--timmy-ui-border-quiet` / `--timmy-ui-border` | |
| `--timmy-text` | `--timmy-ui-text` | |
| `--timmy-text-secondary` | `--timmy-ui-text-muted` | #9AAFC3: 8.7 on canvas · 7.8 on surface · 6.55 on raised (measured) |
| `--timmy-accent` | `--timmy-ui-accent` | the FAMILY accent (the primary, an active cue) — a focus ring written with it moves to `--timmy-ui-focus` |
| `--timmy-accent-ink` | `--timmy-ui-accent-ink` | 6.05 / 6.02 on the accent; 9.4 / 8.9 on the verified green |
| `--timmy-accent-soft` | `--timmy-ui-accent-glow` | the selection's ground: an 18 % family tint (not the light fill `--timmy-ui-accent-soft`); a 1 px ring that read it wants `--timmy-ui-accent` |
| `--timmy-silver` / `--timmy-ai` | `--timmy-ui-text-secondary` | made by a model, commands, neutral highlights: a light neutral, 11.9 on canvas |
| `--timmy-link` | `--timmy-ui-accent-soft` | links take the family's light half (13.2 / 13.5 on canvas) |
| `--timmy-attention` / `--timmy-failure` | `--timmy-ui-focus` | what waits on you; failed with ✕ and its word — exact #FFB000 in both families |
| `--timmy-live` / `--timmy-live-dim` | `--timmy-ui-verified` / `--timmy-ui-verified-dim` | exact #28FE14 / #00D700 |
| `--timmy-diff-add` / `--timmy-diff-remove` | `--timmy-ui-diff-add` / `--timmy-ui-diff-remove` | |
| `--timmy-font-mono` | `--timmy-ui-font-mono` | the one stack |

The B10 type lines (`--timmy-size-*`, `--timmy-weight-*`, `--timmy-line-height`) keep their values: a legacy h1/h2 has no one
B11 size. **PROPOSED:** `--timmy-size-small` (12.5 px) → `--timmy-ui-size-label` (13 px, the page's floor) once the legacy
sheets' small text has been read on every page.
