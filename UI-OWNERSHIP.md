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
| Integration, merges, gates, freeze, Mac, the deliverable | **lead** | `UI-OWNERSHIP.md`, `DESIGN.md`, `scripts/review/**`, the licence lines of `companion/studio-canvas/src/canvas.js`, merges; this round also `src/companion/server.ts` CLIENT_FILES, `scripts/copy-runtime-assets.mjs`, the policy/tab parts of `tests/companion-page-browser.test.ts`, `tests/helpers/companion-page-kit.ts`, and the project-route mirror of `src/companion/client/companion.js` (`projectRoute` / `readProjectRoute` / `drawProjectRoute` only) | — | H168 |

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

## R12 (2026-10-25): the Timmy app — `companion/timmy-app/`

The operator's 03:04 order and the finish brief: Timmy's main UI as one React app on the licensed tldraw SDK with the native
Rive components, served by the companion at `/app` and opened by `timmy app`. One writer per file this round; the lead
integrated each lane's files one at a time and rebuilt and re-tested on the merged tree.

| Lane | Writer | Files | Reads (contract) |
|---|---|---|---|
| The app shell, the store, Chat, Models & accounts, Canvas, the tests | **lead** | `companion/timmy-app/{index.html,src/app.jsx,app.css,api.js,store.js,nav.js,shell.jsx,ui.jsx,rive.jsx,md.jsx,models-parts.jsx}`, `src/pages/{chat,models,canvas,pending,index}.{jsx,js}`, `scripts/canvas/build-app.mjs`, `src/companion/timmy-app.ts`, `src/app/launch.ts`, the local-catalog scope in `src/companion/chat-view.ts`, `tests/timmy-app*.test.ts`, `tests/companion-local-catalog-scope.test.ts` | RIVE CONTRACT v2 (the mounts, the `timmy-rive` shape reused as is); the `--timmy-ui-*` registry |
| Files, Workflows | **R12 lane A** (a lead's fork) | `src/pages/files.{jsx,css}`, `src/pages/workflows.{jsx,css}` | APP SHELL v1; `/api/files*`, `/api/panel/workflows/docs` |
| Runs & receipts, Control Room | **R12 lane B** | `src/pages/runs.{jsx,css}`, `src/pages/control.{jsx,css}` | APP SHELL v1; `/api/panel/runs/list`, `/api/panel/control/{room,panes}`, `POST /api/chat/stop` |
| VoxVision, Motion & 3D (with the Studio's starters) | **R12 lane C** | `src/pages/voxvision.{jsx,css}`, `src/pages/motion.{jsx,css}` | APP SHELL v1; `/api/panel/voxvision/*`, `/api/panel/create/*`, `/api/panel/studio/{board,open}` |
| Tools & integrations, Help & find, Settings | **R12 lane D** | `src/pages/tools.{jsx,css}`, `src/pages/help.{jsx,css}`, `src/pages/settings.{jsx,css}` | APP SHELL v1; `/api/panel/tools/*`, `/api/workspace`, `POST /api/workspace/prefs` |

Each lane wrote only its own files and its own line of `src/pages/index.js`; anything it needed elsewhere it reported to the
lead (the markdown fence hang, the tool label wrap, the plain word for "not set up": fixed by the lead).

- **APP SHELL CONTRACT v1 (lead):** `nav.js` is the rail's registry (group, glyph, kicker, title, lead, context heading per
  page); a page renders `<Page id actions band context tools fill>` from `shell.jsx` (the head with ONE primary next step,
  the band's `[label, value]` cells of real facts, the work area, the context column, the tools row) and builds its work
  from `<Panel>`, `<Tool>` (a tool without `onClick` is unavailable and says why) and `ui.jsx`'s words; it reads and acts
  only through `api.js` (`getJson`, `postJson`, `call` — the token in a header, never in a URL) and `store.js`; a page's own
  sheet is prefixed `tx-<page>-` and reads only the `--timmy-ui-*` registry and the shell's `--ta-*` materials (made of it).
- **The desk's layout (the operator's 19:03 order):** one sectioned rectangle of two long rows, RUN (01 Ask · 02 Agent ·
  03 Proof) over SETUP (04 Connection · 05 Model · 06 Notes) (`SECTIONS`, `DESK` in `pages/canvas.jsx`); Fit fits the rows'
  height at most 100 % (`fit-y-100`) and the camera pans along them, held inside the desk's bounds (DESK grown to hold every
  shape). A Rive shape on the desk is its title and its native face; the artboard choice and the state's source are in the
  context column, with what the shape does: an ActionButton's request (`meta.request`, sent as a real turn on a trusted
  press), a ProviderCard's Check, the AgentConsole's turn (NEEDS YOU answers, Stop, receipt).
- **Highlights (the operator's 19:04 order):** `--ta-hl-warm` (the family's accent: what you act on), `--ta-hl-cool` (the
  other family's swatch: structure, the agent's lane, depth washes), `--ta-hl-rim` (lit top edges); each a mix of registry
  colours, in about a 60-30-10 proportion. Meanings never move: green is earned, focus is exact `#FFB000`, every state keeps
  its word and glyph, content is never recoloured.
- **The desk:** the Canvas is kept in Timmy's project storage, never in the browser alone: `GET / POST /api/app/desk`
  (`src/companion/timmy-app.ts`, the principal's project under the principal's Timmy home:
  `canvas/projects/<project id>/app-desk/canvas.json`, Studio's revisioned `CanvasDocuments`); the page saves 700 ms after
  the person's last change at the next revision, a save over a newer desk is refused (409) and its version kept as a copy
  beside it, and tldraw's per-viewer `user` records are never saved. The board's React key stays
  `timmy-desk-<key(principal | project root)>`; its
  shapes are `timmy-rive` (RIVE CONTRACT v2, unchanged) and `timmy-card` (`{ w, h, kind: model | receipt | conversation }`,
  each saying when it was read on the page, or "not live"); Export / Import is a `{ format: "timmy-desk", version: 1,
  snapshot }` file.
