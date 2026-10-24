# UI ownership — R11 round 7, "finish the product experience" (2026-10-24)

One writer per file, per shared contract and per native artboard. Independent reviewers do not edit. The integration
branch is `r11/r4-integration` (pushed as `r11/review-build`, draft PR #106); the base revision of this round is `73c2291e`.
Each owner works on `r11/<owner>-r7` from that base in its own worktree and delivers commits the lead merges; the lead
freezes, installs, captures on the Mac and writes the deliverable. Merge, npm publish, tags, deployment, the global
install and paid model/compute spend stay on HOLD; no history is rewritten.

The design direction is the operator's order of 2026-10-24 13:40 PT with its handoff (START-HERE, the three Card Lab
references, the rendered Amber/Glacier studies, REUSE-MAP, the draft design-system skill). The handoff is reference
material: its study CSS/JS and the Card Lab source are adapted, never copied wholesale into this repo.

## The hierarchy every page embeds

Timmy → project → current task → primary next action → work area → contextual tools/details → progress and evidence.
Regions: a permanent grouped left rail; a page title/description above the work; the work in the centre; models or the
selected item's context on the right; task-specific tools beneath the work; a quiet, expandable records area. On a phone
the regions become accessible sheets/navigation without trapping focus or hiding the composer.

## Lanes and writers

| Lane | Writer | Writable files (exactly) | Consumes | Reviewed by |
|---|---|---|---|---|
| Design tokens + shared shell | **H175** | `src/theme/tokens.ts` (the HOMEBREW/terminal values unchanged; the web theme families, type scale, spacing, radii, elevation, motion added), `src/companion/client/companion.css`, `src/companion/client/index.html`, `src/companion/client/shell.js`, `skills/timmy-design-system/**` (the skill updated from the implemented tokens at the end), `tests/theme-tokens*.test.ts`, `tests/companion-shell-*.test.ts`, the font assertions of `tests/companion-page-browser.test.ts` (this round; the policy and vendor-path rules of that file stay) | — (posts the SHELL CONTRACT first) | H168 |
| Chat and its tools | **H171** | `src/companion/client/chat-shell.js`, `chat-shell.css`, `tests/companion-chat-shell-*.test.ts` | H175 shell contract; H169 catalog metadata; H174 mount API | H168, H172 |
| Routes, Workflows, Runs & receipts, Control Room | **H169** | `src/companion/chat-run.ts`, `chat-view.ts`, `run-detail.ts`, `panels.ts`, `src/companion/panels/control.ts`, `src/companion/client/panel-run.js`, `panel-control.js`, `panels.js`, new `panel-run.css`, `panel-control.css`, their tests | H175 shell contract | H168, H172 |
| Models & accounts (Connections), VoxVision, Tools & integrations | **H170** | `src/companion/connections.ts`, `src/companion/client/screen-connections.js`, `screen-connections.css`, `panel-vox.js`, `panel-tools.js`, new `panel-vox.css`, `panel-tools.css`, `src/companion/panels/vox.ts`, `tools.ts`, `tools-inventory.ts`, their tests | H175 shell contract; H174 ProviderCard mount | H168, H172 |
| Identity, account, Files, settings | **H173** | `src/companion/identity/**`, `src/companion/client/account.js`, `account.css`, `account-callback.js`, `src/companion/workspace.ts`, new `panel-files.js`, `panel-files.css`, `panel-settings.js`, `panel-settings.css`, their tests | H175 shell contract | H168, H172 |
| Rive assets and runtime | **H174** | `src/companion/assets/rive/timmy-ui/**` (the editable source, the compiled `.riv`, fonts/licences, `CONTRACT.json`, README), `src/companion/rive-assets.ts`, `src/companion/client/rive-bindings.js`, `rive-components.css`, `screen-inspect-animation.js`, `companion/studio-canvas/src/rive-shape.js`, `license-state.js`, their tests | H175 tokens (the native artboards match the web type system) | H168, H172 |
| Canvas / Houdini, Motion & 3D | **H176** | `companion/studio-canvas/src/**` except `rive-shape.js`, `license-state.js` and the licence lines of `canvas.js`; `companion/studio-canvas/index.html`; `src/studio/templates.ts`, `boards.ts`, `board-items.ts`, `references.ts`, `document.ts` (board/template routes only; identity and project isolation untouched); new `src/studio/templates/*.json` (the guided blank public starters); `src/companion/panels/studio.ts`, `create.ts`; `src/companion/client/panel-studio.js`, `panel-create.js`, new `panel-studio.css`, `panel-create.css`; their tests | H175 shell contract; H174 shape contract | H168, H172 |
| Terminal Workbench | **H177** | `src/workbench/**` (the palette values unchanged), `tests/workbench-*.test.ts` | H175 tokens (semantic names only) | H168 |
| Journeys, captures, recordings, the installed-package mode | **H172** | `tests/journey-*.test.ts`, `tests/user-isolation.test.ts` (unchanged unless told), the capture journeys and sidecars | every lane | H168 |
| Independent visual/interaction review | **H168** | nothing (read-only; findings go to the writers) | every lane | — |
| Integration, merges, gates, freeze, Mac, the deliverable | **lead** | `UI-OWNERSHIP.md`, `DESIGN.md`, `scripts/review/**`, the licence lines of `companion/studio-canvas/src/canvas.js`, merges | — | H168 |

A file not listed is not written this round without the lead naming its writer here first.

## Shared contracts (versioned; the writer posts, the consumers adapt)

- **SHELL CONTRACT v1 (H175):** token names (`--timmy-*`), the page scaffold (one `section.page` per destination with
  head / work / context / dock / records containers), how a page registers its title, description and primary next
  action, the theme attribute (`data-theme="amber" | "glacier"`, per viewer), the mobile sheets, Help & find.
- **RIVE CONTRACT v2 (H174):** `timmy-ui.riv` artboards and sizes, the `TimmyUI` state machine and inputs, the named
  text runs (each ProviderCard subtitle run named apart; the ActionButton's caption run), the preview variant separated
  from the production artboards at source, the mount API (`TimmyRive.mountConsole / mountProviderCard /
  mountActionButton`), the `timmy-rive` shape's props.
- **CATALOG METADATA (H169):** the models route's per-model description, provider, capabilities, price and "newest"
  ordering when the provider supplies them; absent metadata is `unknown`, never invented.
- **TEMPLATE SCHEMA (H176):** the guided blank starters' shape `meta` (workbench version, page, role, lane, data) and
  the parameter / native-operation bindings on the installed tldraw.

## Status

Posted and kept in the round's handoff by the lead; this file records who writes what, not what is done.
