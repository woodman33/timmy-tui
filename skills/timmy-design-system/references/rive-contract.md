# Rive contract — what is ACCEPTED (RIVE CONTRACT v2, `src/companion/assets/rive/timmy-ui/CONTRACT.json`) and what stays a rule

## The asset (v2, served)

`timmy-ui.riv` (built with the Rive CLI from `scene.rml`, which `create-controls.py` writes; `rive.yaml`; the font `Outfit.ttf`
made by `make-font.py` from the product's own @fontsource-variable/outfit, OFL): the artboards `AgentConsole`, `ProviderCard`,
`ActionButton` in their Amber and Glacier variants, the preview variant apart from the production artboards at source; the
state machine `TimmyUI` with the inputs `State` (Number: 0 Idle · 1 Working / Checking · 2 Approval / NEEDS-YOU · 3 Stopped ·
4 Failed — no success value), `Hover` (Bool), `Pressed` (Bool), `ReducedMotion` (Bool: zero-duration transitions and the
Working pose without its ring). Served at `/assets/rive/timmy-ui/timmy-ui.riv`, listed by `GET /api/rive/assets`, drawn by
`/vendor/rive/rive.js + rive.wasm` (@rive-app/canvas from this product's own node_modules). The mount API is
`TimmyRive.mountConsole / mountProviderCard / mountActionButton`; the Studio's `timmy-rive` shape carries the same.

Known differences between the served build and the source are recorded in CONTRACT.json (the inks of the primary action; the
artboards' stage positions) — the next build closes them. Read CONTRACT.json before claiming a run, an input or a size.

## Rules (unchanged)

- Bind the displayed activity through **authenticated event → project/session/turn or durable job → final receipt**. Working
  follows current events; do not wait for a sealed receipt to show it. Stop stays "requested" until the backend confirms
  stopped. An answered or ended NEEDS-YOU unmounts its controls. A disconnected feed says last known / unknown, never LIVE.
- Hover / Pressed acknowledge interaction and never manufacture working, approval, connected or success.
- A reopened board is AS SAVED / NOT A LIVE JOB until a current authenticated source is attached; a historical receipt link
  stays historical; the preview variant is PREVIEW and mutates nothing.
- One runtime instance per mount; coalesced redraws; no remount per text chunk, camera move or unrelated React redraw;
  listeners and instances disposed on unmount. Keyboard operation and the load-failure fallback keep the HTML words.
- Reduced motion changes movement, not truth or operability; the words carry the state.
- The type system is the registry's (tokens.md): Outfit for words in the artboards, as on the page.
