# Timmy's native Rive UI (RIVE CONTRACT v2 — the source; the compiled asset's version is named in CONTRACT.json)

`timmy-ui.riv` is the compiled, self-contained Rive runtime asset the product serves at `/assets/rive/timmy-ui/timmy-ui.riv`
(both the companion and the Studio; the listing `GET /api/rive/assets` names it with its sha256). It is built by the Rive CLI
on the operator's machine from the editable source beside it — nothing compiles in this repo's build — and committed with
its records (`BUILD.txt`, `rive-build-log.txt`, `rive-build-problems.txt`, `INSPECT-summary.txt`) and its sha256 in `CONTRACT.json`. The repo's `.gitignore` keeps `*.riv` out except
under `src/companion/assets/rive/` (`!src/companion/assets/rive/**/*.riv`). The round-5 asset (the operator's own build,
contract v1, sha256 `9fd9ae7c…`, 405,278 bytes) was the served file until the v2 build landed (the build of 4e8d4905's
source, sha256 `e97d28dc…`, 93,211 bytes); `CONTRACT.json` `asset` says which build is served and what the source has changed since.

## The source (R11 round 7, H174: the operator's order "Make the native UI coherent")

| File | What |
|---|---|
| `create-controls.py` | the generator (Python 3.12+): writes `scene.rml` and `rive.yaml`; the artboards, their text runs, the state machine, the materials |
| `scene.rml` | the Rive markup the CLI compiles (`rive . --verify`, `rive . --once`) |
| `rive.yaml` | the CLI's four lines (name + logs: its yaml parser takes nothing else); the listing's facts are `CONTRACT.json`'s `meta` block, which the generator writes |
| `Outfit.ttf` + `Outfit-OFL.txt` | the embedded font: Outfit (variable, wght 100–900; SIL OFL 1.1, no Reserved Font Name declared), made by `make-font.py` from `@fontsource-variable/outfit`'s latin WOFF2 — the same font this product serves for its HTML (DESIGN.md B11 D2: one UI face across HTML and the native faces). Montserrat (v1) is dropped. |
| `make-font.py` | the reproducible font step (fontTools; Brotli through Node's zlib when the module is absent); prints the TTF's sha256 |
| `Montserrat.ttf` + `OFL.txt` | v1's font, kept only while `scripts/copy-runtime-assets.mjs` (the packaging allowlist, not this folder's) names them — the v2 source does not use them; they go when that list names the v2 files |
| `CONTRACT.json` | the contract: version, the served asset's identity and build, artboards, runs, inputs, materials, the consumers' API; its `meta` block (generator-written) is what the listing reads |
| `BUILD.txt`, `rive-build-log.txt`, `rive-build-problems.txt`, `INSPECT-summary.txt` | the build's records (the Rive CLI on the operator's machine) |

## What changed from v1 to v2 (the order's "Make the native UI coherent")

- **The ProviderCard's subtitle runs named apart.** v1 baked `OpenRouter · Ollama · Cloudflare` five times under one name
  (one per state group) — the runtime could address one. v2 has ONE `ProviderName` run outside the state groups (the page
  sets the card's own provider), `ProviderState` (the state word) and `ProviderDetail` (one line); the per-state headlines
  are `HeadlineIdle` … `HeadlineFailed`.
- **The ActionButton's native caption.** One `Caption` run = the button's own label (a mount's `label`, a Canvas
  welcome's label); v1's per-state baked labels ("Connect provider →", "Checking…", …) are gone. The right-hand mark is a
  vector (chevron, dots, diamond, square, ×): no glyph fonts.
- **Preview separated at source.** The production artboards (`AgentConsole`, `ProviderCard`, `ActionButton`,
  `ActionButtonGlacier`) bake NO "PREVIEW / NOT A LIVE JOB" caption, NO "Inspect interaction" pill and NO state-changing
  listener. The Inspect view's variants (`AgentConsolePreview`, `ProviderCardPreview`, `ActionButtonPreview`) bake the
  caption, the pill and the `Inspect click` listener (State → 1). v1's runtime workarounds (the caption overwrite, the
  scaled pill) apply to a v1 file only and retire with the v2 build.
- **Reduced motion settles.** `ReducedMotion` still makes every transition instant AND the Working pose takes the
  `WorkingStill` state (the ring at rest) — nothing keeps moving; the words carry the state.
- **Materials.** The Card Lab direction: a raised → surface gradient panel with a 1-px top light and the border; text /
  secondary / muted; the focus amber for the Working ring, Approval and Failed; a quiet grey for Stopped; the primary
  action's light gradient (amber start → accent with the ink H175 measured for the HTML's primary button, #402E14; `ActionButtonGlacier` the Glacier pair, ink #1D3848). Never `#28FE14` on
  a native face: no observed-live claim is drawn.
- **Sizes unchanged** (640 × 380 · 400 × 260 · 240 × 72): the consumers' aspect rules stand.

## The state machine and the page's vocabularies (`src/companion/client/rive-bindings.js`, `TIMMY_UI`)

`TimmyUI` on every artboard: `State` Number (0 Idle · 1 Working/Checking · 2 Approval/NEEDS-YOU · 3 Stopped · 4 Failed; no
success value), `Hover`, `Pressed`, `ReducedMotion` Bool.

| Component | Artboard | This page's word → native input |
|---|---|---|
| Agent / tool activity (the chat turn's SSE, fed by chat-shell.js) | `AgentConsole` | idle → State 0 · working → 1 · awaiting (approval) → 2 · **stopping → 1** (STOP REQUESTED: the turn still runs until the backend says `cancelled`, which makes 3) · stopped → 3 · failed → 4 |
| Provider connection (GET /api/connections) | `ProviderCard` | disconnected → State 0 · checking → 1 · **connected → 0** (no success pose is authored: the card stays Idle and `ProviderState` / the HTML label say "connected") · failed → 4 |
| An action (the person's click, Enter or Space) | `ActionButton` / `ActionButtonGlacier` | the press → Pressed true, released on the next frame; the pointer over it → Hover |
| Canvas selection (tldraw) | any | selected → Hover · expanded → no native input (HTML only) |
| prefers-reduced-motion | any | ReducedMotion → true on load (verified: no continuous movement under it) |

Every binding event records the word AND the native input it set; the Inspect view lists them with the backend source
that set each state, the identity the feed named (project / session / turn), and the receipt a `done` event attached.

## The feed's identity (round 7)

A `turn` event names the console's current turn (`data.id`); a `needs-you` or `done` whose `data.turn` is another turn's
is ignored as stale (recorded, never applied); `done.receipt` is attached to the handle (the Chat shows the link); a new
`turn` event starts the new turn; `TimmyRive.reconcile(word, { turn, source })` applies a re-read state after a reconnect.
A reopened Canvas shape says AS SAVED / NOT A LIVE JOB until a feed event reaches it on its page.
