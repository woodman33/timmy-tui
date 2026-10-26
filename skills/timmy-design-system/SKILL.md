---
name: timmy-design-system
description: Design and refine Timmy's browser surfaces (the companion, the Studio), its terminal views and its native Rive components with the accepted token registry, the one shell and page scaffold, and the truth rules for states. Use for Timmy UI work, not for unrelated sites or marketing pages.
---

# Timmy design system

Rewritten 2026-10-24 (R11 round 7, H175) from the IMPLEMENTED tokens, shell and native contract — not from the study. What
is marked **ACCEPTED** is in the repo and exercised by a test; what is marked **PROPOSED** is written down and not yet built
or not yet ruled. The handoff's draft (tokens.json v0.1, Montserrat, the study's CSS) is superseded by this.

Updated 2026-10-25 (R12, the lead) from the implemented Timmy app (`companion/timmy-app/`, served at `/app`, opened by
`timmy app`): the same registry and hierarchy in React on the licensed tldraw SDK — see "The Timmy app" below.

Sources of truth, in this order: DESIGN.md §10 (B10 the terminal; B11 the browser surfaces), `src/theme/tokens.ts` (the
registry), `companion/timmy-app/src/{shell.jsx,nav.js,app.css}` (the app's shell: APP SHELL CONTRACT v1 in
`UI-OWNERSHIP.md`), `src/companion/client/{shell.js,companion.css,index.html}` (the companion page's shell; the SHELL CONTRACT v1 it implements is
restated in [product-patterns.md](references/product-patterns.md)), `src/companion/assets/rive/timmy-ui/CONTRACT.json` (RIVE
CONTRACT v2), and the tests that exercise them (`tests/theme-tokens.test.ts`, `tests/companion-shell-r7-browser.test.ts`).

## Choose the relevant reference

- Colours, type, spacing, radii, elevation, motion, focus — [tokens.md](references/tokens.md).
- The rail, the topbar, the page scaffold, states, the phone's sheets, Help & find, the registration API — [product-patterns.md](references/product-patterns.md).
- Before wiring or rebuilding a Rive component — [rive-contract.md](references/rive-contract.md).
- A page of the Timmy app (`companion/timmy-app/src/pages/*`) — "The Timmy app" below, then product-patterns.md for states.

## Work from the actual surface

1. Inspect the requested page, its owner's file and the running companion before changing anything. The three Card Lab
   screenshots are the visual reference (disciplined spacing, one light focal object, a guided workflow, restrained Amber /
   Glacier materials); borrow composition, not data.
2. Keep the hierarchy every page embeds: **Timmy → project → current task → primary next action → work area → contextual
   tools / details → progress and evidence.** A page registers its head and primary with `TimmyShell.page()`; it writes into
   `.page-work`, `.page-context`, `.page-dock`, `.page-records` and nowhere else. One primary next action per page.
3. Read colours by role from the `--timmy-ui-*` registry; never a literal colour, gradient or alpha in a page's sheet (the page
   policy test refuses them in companion.css; the same discipline for every owner's sheet). The B10 web names (`--timmy-*`) are
   aliases of their B11 role since D12 — a sheet that still reads them draws the one palette, but new work reads `--timmy-ui-*`,
   and a focus ring is `--timmy-ui-focus`, never `--timmy-accent` (the family's). The terminal reads `HOMEBREW` only.
4. Render it: a real capture of the running companion at 1440×900 and 390×844 (1280×720 checked), both themes, reduced motion;
   measure contrast on the capture (floors: 4.5:1 text, 6:1 neutral text, 3:1 focus and outlines). A token value is not a
   contrast result.
5. Say what is proposed, installed, exercised: a preview is a preview; FAKE fixtures say FAKE on the page.

## The Timmy app (R12, ACCEPTED: built, and exercised by tests/timmy-app-browser.test.ts)

- **The shell:** the permanent left rail (`nav.js`: Chat; WORK Files, Workflows, Runs & receipts, Canvas; CREATE VoxVision,
  Motion & 3D; CONNECT Models & accounts, Tools & integrations, Control Room; Help & find and Settings at the foot; the
  project switcher under the mark), the top bar (where you are · Amber | Glacier), the page (`<Page>`: kicker · title · lead
  · ONE primary; a band of 2–4 real facts; the work area and its context column; the tools row), the quiet records dock
  (this page's own requests, Local; Cloudflare says not connected) and the status footer (the workspace, the canvas
  licence as the SDK read it, Export / Import). On a phone the rail is a drawer and a working page (Chat, Canvas) keeps a
  one-row head so the work has the height; the composer stays above the software keyboard (`visualViewport` → `--ta-kb`).
- **Materials:** the Card Lab's — graded dark surfaces with a thin lit edge (`--timmy-ui-elev-surface`, `-raised`, `-rail`,
  `-top`), pale paper for a key output (`--timmy-ui-elev-paper` + `-shadow-paper`, ink text), the primary as the accent's
  gradient (`--timmy-ui-elev-primary` + `-shadow-primary`). The app's own `--ta-*` materials are colour-mixes of registry
  roles only; a hex in a sheet is only a `var()` fallback.
- **Canvas:** a bounded desk (tldraw's camera constraints: contain, Fit at most 100 %, the wheel pans), the desk's edge,
  caption and corners drawn on the canvas, the desk's toolbar on the page's tools row (Arrange · Hand · Nodes · Draw ·
  Connect · Text · Undo · Redo · zoom · Fit workspace), the selection's parameters in the context column, the SDK's own
  licence readout (never hide its notice or watermark). Rive components are the versioned `timmy-rive` shape; a saved one
  says "as saved" until an event of this page moves it; a Timmy card says when it was read, or "not live".
- **Faces said once:** a provider card's name and state are its heading (the face's words spoken, the chip hidden once the
  face is drawn); an ActionButton draws its label (its HTML label spoken unless it is unavailable).

## Truth and scope (unchanged rules)

Green (`--timmy-ui-verified`) only for an OBSERVED live connection, a passed check or a verified sealed receipt, always with its
word and glyph; selection, recommendation, a running process and a delivered result are never green. Focus is exact amber
`#FFB000` in both families. A failure is amber with ✕ and its word. Evidence and content keep their own colours.

Every model-authored evidence field selects from the handles actually observed in the current run and source revision, each
with a successful observed `cite(handle_id)`; none → unknown or refusal; raw output and refusals are kept. A valid receipt
proves integrity and authorship under its rules, not that a conclusion is correct.

Private projects, rejected takes and sources stay intact; public starters begin blank with guidance. This skill grants no
paid-service, deployment or release permission.
