# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Complete visual rebuild — Cyber-Command Post design system (v1.0.4, refs
  tui3/tui6/tui7): alternate-screen boot with cleared scrollback and a
  strict full-screen bounding box; 5-col icon rail (`>_ ⊞ ≡ 🛡 ⚙`, active
  glows `#7dcfff`); 1-row header `[TIMMY TRUST OS v…]` + MODEL/SESSION +
  right-aligned `● DOCKER / ● COMFY / COST` pills; 1-row footer with
  keymap pills; View [1] is a 60/40 split — round conversation card
  (`#2ac3de` focused / `#292e42` inactive, no nested borders) beside the
  LIVE INVERTED LOG RELAY & PASSPORT (green timestamps, `[WORKER] /
  [ESCROW] / [SEAL]` channel badges, `[SHA-256 SEALED]` emerald badge).
- `^K` palette is now a SOLID full-card overlay (opaque `#16161e` field,
  `#bb9af7` border, numbered rows) — no transparent floats; help overlay
  likewise.
- Neon Tokyo Night tokens added to the single-source theme (`bgDeep`,
  `neonCyan`, `cardFocus`, `emerald`, `neonEmerald`); adaptive footer
  keymap + input placeholder keep 80×24 chrome wrap-free.
- Yoga layout fix: relay title/seal wrapped in shrink-0 boxes so an
  over-tall event list can never collapse panel headers.

### Changed
- Radical View [1] de-clutter (v1.0.2): new `CommandView` — ONLY the
  conversation plus one clean bordered prompt box (`▶ [Type command or
  prompt...]`). The OPENROUTER MODELS sidebar is gone (model switching +
  health live strictly in the `^K` palette); J-BANG action cards evicted
  to View [2] (Mission); internal system chatter (`[Saved to Cloudflare…]`,
  state-sync, run.created noise) filtered out of the scrollback; minimal
  markdown rendering (user prompt one clean line, agent indented below),
  no nested box borders, no scroll-thumb artifacts.
- Chrome consolidated to strict single lines: header
  `TIMMY v1.0.2 · VIEW · model · badges`, footer
  `[Tab] Focus  [1-4] Views  [^K] Models/Palette  [?] Help  [q] Quit`;
  layout budget is now header 1 + footer 1 + main rows−2.

### Removed
- `StatusTicker` ambient line (live surface stays in TELEMETRY).

### Changed
- Full TUI ergonomic overhaul (v1.0.1): the cramped 8-mode monolith is
  replaced by four top-level views — [1] COMMAND (clean chat + concise
  J-BANG action cards), [2] MISSION (DAG + capsules), [3] TELEMETRY
  (log inspector + full LogRain), [4] ESCROW (live ledger + receipt chain
  with verify) — switched by [1-4], pane focus by Tab.
- Strict viewport budgeting: header 2 rows (status bar + `[● LIVE]`
  ticker), footer 2 rows (keymap + view hints), main = rows − 4; all
  dynamic text clamps (`wrap="truncate"`, column clamping); resize
  rerenders debounced (120ms) through a single ViewportContext.
- Active Pane Invariant: focused pane renders bold bright `#7dcfff` border
  + `◆` title glyph; inactive panes drop to muted `#292e42`
  (`PaneFocusContext` + `chromeFor`).
- Ambient noise collapsed: the continuous reverse LogRain no longer rides
  in the chat pane; a single-line ticker (`[● LIVE] Last event: … ·
  [L] telemetry`) is the only ambient live surface outside TELEMETRY.

### Fixed
- Duplicate React key warnings (content-keyed lists in ClipPanel).
- First-run gate re-showing on every launch (`onboarded` now passes through
  cli.tsx into the app shell).

## [1.0.0] - 2026-08-20

TIMMY the Agent Trust OS reaches general availability. All four north-star
targets are graduated with on-disk cryptographic receipts — V-01 Context
Cone (0.7.7), V-02 USD spine (0.8.0), V-03 AgentPass escrow (0.8.0),
V-04 media fabric (0.7.5) — the Command Post ships zero-config (bare
`timmy` boots the Tokyo Night UI), and `timmy doctor preflight` gates every
containerized arm on a verified environment without burning operator
authority. The sovereign golden run (slate → cone → armed dispatch →
USD/ComfyUI generation → escrow settlement) is a first-class test.

### Added
- `timmy doctor` preflight tier (v1.0.0-rc1, friction log #2):
  `src/utils/doctor.ts` audits docker daemon, comfy-cli + tool-venv
  (filelock/sqlalchemy — the 0.28 asset-scanner crash window), CUE CLI,
  OpenSCAD, tmux and ports 8188/4310; `timmy doctor preflight` exits
  non-zero when a required check is missing. Containerized plans cannot
  arm while docker is down — checked BEFORE consuming the one-shot token
  so a bad environment never burns operator authority.
- Zero-config CLI: bare `timmy` now boots the Tokyo Night Command Post
  (dist/cli.js when packaged, tsx cli.tsx from the repo); `--help` keeps
  the command surface.
- End-to-end sovereign golden run (`tests/e2e-sovereign.test.ts`): slate
  tldraw map → context-cone-indexed capsule → operator-armed containerized
  dispatch → content-hashed USD stage + live ComfyUI stem (honest
  not_configured skip when absent) → AgentPass-judged escrow settlement
  with the refund invariant and a clean chain walk.

## [0.9.0] - 2026-08-20

### Added
- Fleet distribution (v0.9.0 horizon 1): `src/utils/fleet-dispatch.ts` +
  `scripts/phaseH-fleet.ts` — one mission fans out a ComfyUI video stem
  (local golden lane) plus tri-modal USD stage renders in parallel against
  the same content-hashed stage; plans arm only via operator-minted tokens
  (`armToken` hook — authority stays external); a parent receipt links the
  fan-out; missing tooling seals honest `not_configured`/`missing_source`,
  never a fake stem.
- Real-time escrow dashboard (v0.9.0 horizon 2): the escrow engine emits
  `escrow.*` events on the bus; `GET /mission/escrows` lists live locks,
  draws, refunds and merkle prefixes; :4310/mission section 6 renders the
  ledger and refreshes on SSE escrow events.
- Version-sync hardening (friction log #1): `tests/globalsetup.ts` wired as
  vitest `globalSetup` regenerates `src/version.ts` even under raw
  `npx vitest`, so version bumps can't break stale assertions.

## [0.8.0] - 2026-08-20

### Added
- V-02 GRADUATION (tri-modal USD spine): `scripts/phaseF-usd-bench.ts`
  proves one stage sha256 (`eea40ee0…`) carried in three lane manifests
  (houdini-mcp, unreal-mcp, webcontainers), a write→read replay that
  byte-compares, and fresh-compile determinism; graduation receipt
  `sha256_0fd8a091…`. `docs/VISION-REGISTER.md` strikes V-02.
- V-03 GRADUATION (AgentPass escrow): `scripts/phaseG-escrow-bench.ts`
  proves settle and cancel both honor refund = ceiling − drawn
  (0.75 = 1.00 − 0.25; 1.50 = 2.00 − 0.50), `verifyChain` walks
  ceiling→draws→refund clean, and a tampered Merkle proof slashes with
  settle refused; graduation receipt `sha256_9a628849…`. The register
  strikes V-03.
- v0.8.0 SOVEREIGN BASELINE: all four north-star targets are now graduated
  (V-01 Context Cone, V-02 USD spine, V-03 AgentPass escrow, V-04 media
  fabric determinism); package version 0.6.0 → 0.8.0. Remaining scopes
  (cone cold base/redaction, real lane renders + EDL fragment addressing
  for USD, fleet bidding, federation routing) stay target-grade per the
  register's maintenance law.

## [0.7.9] - 2026-08-19

### Added
- Unified USD stage composition (V-02 rung 3): `composeUnifiedStage` binds
  OpenSCAD CSG primitives, UsdShade PBR materials (`#Material` →
  UsdPreviewSurface + `material:binding`) and the hero reference into ONE
  CUE-validated, content-hashed `.usda`; `stageHierarchy` exposes the prim
  tree (CSG children, material flags, hero) for inspection.
- Escrow settlement engine (V-03 rung 2): `src/utils/escrow-engine.ts` +
  `schemas/escrow.cue` — `armed → locked → judged → settled / slashed`
  state machine; judge gates strictly on a verified AgentPass Merkle proof
  AND Roboflow QA ≥ threshold (either failure slashes); draws accrue under
  the ceiling (overspend fails closed); settle/cancel refund
  ceiling − drawn; every transition CUE-validated + receipted;
  `verifyEscrow` re-walks legality + refund math.
- Mission Studio inspectors: `POST /mission/inspect` (localhost-gated)
  serves the Merkle proof tree (`merkleProofTree`, root-match flag) and the
  unified stage hierarchy + usda; section 5 of :4310/mission renders both.

## [0.7.8] - 2026-08-19

### Added
- Neural-mesh ingestion (V-02 rung 2): `src/utils/tripo-adapter.ts` +
  `schemas/mesh-asset.cue` — local-first hero-asset ingest (existence-
  checked, sha256-hashed, CUE-validated `.glb`/`.usd`/`.usda`) referenced
  into the compiled stage under `/World/HeroMesh`; USD-native formats get a
  real `prepend references` arc, glb rides provenance until a real
  converter exists; partner generation stays target-grade
  (`not_configured`, default-deny).
- AgentPass rung 1 (V-03): `src/utils/agent-pass.ts` +
  `schemas/agent-pass.cue` — packages parent/child receipt chains, Roboflow
  visual QA scores, and `.agentrun` bundle hashes under a SHA-256 Merkle
  root; `verifyAgentPass` recomputes the root and checks runs-chain
  membership; the pass seals as a verify receipt. Escrow settlement stays
  target-grade.
- V-01 graduation benchmark (`src/utils/cone-bench.ts` +
  `scripts/phaseE-cone-bench.ts`): cone-budgeted capsule vs unconstrained
  raw-repo dump plus mantle ablation; accuracy proxy is retrieval recall of
  per-tier mission facts, tokens a bytes/4 estimator; graduation seals an
  efficiency receipt carrying per-tier token counts and the delta. Ran for
  v0.7.7: **V-01 GRADUATED** — 19,525 → 5,515 tokens (72%) at equal 1.0
  recall, ablation delta 2/3, receipt `sha256_08d24235…`;
  `docs/VISION-REGISTER.md` strikes V-01.
- USD geometry spine (V-02 rung 1): `src/utils/usd-compiler.ts` +
  `schemas/usd.cue` — typed parametric scenes compile to deterministic,
  content-hashed `.usda` stages (native UsdGeom prims; CSG trees ride as
  provenance Scopes) plus an OpenSCAD CSG adapter (`openscadFromScene` /
  `renderCsg`, fail-closed `not_configured` without the binary).
- Mission telemetry hardening: the :4310/mission SSE log panel gains a
  bounded 200-line ring buffer, tail-pinned autoscroll, and connection-drop
  recovery (the /events replay refills a cleared buffer on reconnect).

## [0.7.6] - 2026-08-19

### Added
- Context Cone dispatch integration (V-01 rung 2): `createPlan` accepts a
  cone and derives the sha-pinned `context_manifest` from the budgeted
  L0/L1/L2 selection (`coneToContextManifest`); isolation seeds ONLY the
  selected slices — manifest entries outside the cone selection are refused
  as unconstrained blobs; provenance rides the plan as `context_cone`
  (CUE-validated in `schemas/dispatch.cue`).
- Mission Studio live launch: arming + launching a compiled
  `openhands`+`docker` plan routes through the containerized OpenHands
  engine (`dispatchContainerized`) with real-time telemetry
  (container_started/log/done) streamed over the event-bus SSE into
  :4310/mission; authority stays hash-bound — arm consumes the operator
  token and the adapter records the dispatch plan hash (`preApproved`)
  instead of re-minting.

## [0.7.5] - 2026-08-19

### Added
- V-04 GRADUATION (first ComfyUI federation rung): `scripts/phaseD-golden.ts`
  ran two FRESH headless 5s golden executions (server restarted between runs,
  seed pinned 1337, checkpoint discovered at runtime) producing byte-identical
  output `sha256:50aa3c52…30a69`; graduation receipt `sha256_253c4a08…` with
  the two run receipts as children. `docs/VISION-REGISTER.md` strikes V-04 and
  re-registers the remaining routing scope as V-05. Re-verified after the
  ComfyUI 0.28 tool-env fix: two further fresh runs
  (timmy-golden-5s_00006/00007) reproduce the identical sha — 4/4
  byte-identical across server restarts; receipt `sha256_363f1b8e…`.
- Context Cone (V-01 rung 1): `src/utils/context-cone.ts` +
  `schemas/context-cone.cue` — CUE-validated 3-tier indexing (L0 apex
  manifest / L1 skeleton / L2 diffs+traces) with strict token budgeting;
  selection fails closed when the apex alone exceeds budget; L2 forages
  recency-desc under the remaining budget.
- Companion arming gateway: `POST /mission/store` on :4310 stores a compiled
  plan and returns its id + immutable hash; the Mission Studio page then
  emits hash-bound arm+launch requests through the controller's existing
  `/dispatch/action` (operator token required — the companion never
  executes). Integration tests cover compile→store→arm-denied and the
  theatre-state escape check.

### Fixed
- `comfy-adapter`: binary resolution fallback for PATH-less background
  shells (UV_PY pattern) and `--json env` probe (`--json version` is a usage
  error in comfy-cli 1.16); golden proof restarts the server between runs so
  determinism is proven on fresh executions, not node-cache hits.
- Local ComfyUI 0.28 tool env aligned (sqlalchemy + full requirements.txt) —
  the asset scanner crash that killed the daemon mid-phase.

## [0.7.4] - 2026-08-19

### Added
- Vision Register (`docs/VISION-REGISTER.md`, spec §11): the four unverified
  north-star targets (Hierarchical Context Cone, Tri-modal 3D USD stack,
  AgentPass escrow clearinghouse, ComfyUI federation) codified with
  receipt-grade exit criteria. Targets are not receipts: nothing in the
  register gates runtime behavior; graduation is a CHANGELOG event.
- Mission Studio on the logs companion (`:4310/mission`): survey surface that
  consumes the compiler via `POST /mission/compile` (localhost-only), renders
  dependency-ordered CUE-valid plan cards, plays compiled mission stages
  frame-accurately (Bézier sampler mirroring `theatre-runtime`, 30fps
  timebase) plus W3C media-fragment video stems; `GET /mission/theatre`
  serves compiled-folder state with path-escape checks; the :4321 Mission
  Map links across. Compiles only — launching stays with the controller.
- Media Fabric local blueprint spike (V-04 first rung):
  `src/utils/comfy-adapter.ts` — deterministic comfy-cli execution adapter
  for local headless 5s golden runs: every seed pinned (`GOLDEN_SEED`),
  checkpoints discovered at runtime and injected at the `DISCOVER` sentinel
  (never hardcoded), fail-closed `not_configured` / `missing_source` /
  `server_not_running`, every outcome receipted. `scripts/comfy-golden-5s.json`
  is the pinned core-node spine.

## [0.7.3] - 2026-08-19

### Added
- MCP tool `timmy_mission_compile`: the Mission Map compiler exposed to any
  MCP-speaking agent and the :4321 companion — a tldraw mission doc in,
  typed CUE-validated DispatchPlans out; the map still never launches.
- Studio runtime (`src/utils/theatre-runtime.ts`): loads native Theatre.js
  on-disk state (definition `0.4.0`, sheets keyed by id — the exact shape
  `@theatre/core@0.7.2` validates) from compiled project folders, plays it
  back deterministically via cubic-Bézier sampling (`sampleTrack` /
  `sampleSequence`), and hands the identical state to the browser path
  (`getProject(id, {state})`, CJS-interop safe).
- End-to-end mission verification (`tests/mission-e2e.test.ts`): multi-stage
  Slate map → CUE DispatchPlans → controller store → sanitized multi-track
  OTIO → Theatre state round-trip + playback → signed parent/child receipt
  chain verifies clean.

## [0.7.2] - 2026-08-19

### Added
- Mission Map → DispatchPlan compiler (`src/utils/slate-compiler.ts`): the
  tldraw node vocabulary (capsule / harness-slide / gate / artifact / result
  + dependency edges) compiles into typed CUE DispatchPlans — emitted in
  dependency order with `cadence.depends_on` wiring, sha256-pinned
  `context_manifest` entries from artifact handoffs, and gate-driven
  approval/acceptance; every plan passes `validatePlanCue`; cycles, unknown
  harnesses and missing artifacts fail closed with explicit errors. The map
  still never spawns work — compiled plans go through the controller.
- OTIO media-spine hardening: explicit timebases on every RationalTime (EDL
  `timebase`, default 24), multi-track audio stems (one Audio track per
  music/vo/sfx kind with ducking metadata), and `sanitizeMediaUrl`
  bundle-relative exports — absolute/home paths never leave the machine
  unless the caller opts out.
- Theatre.js native motion state: keyframes carry cubic-Bézier handles and
  `theatreStateFromSequence` emits theatrejs-v1 sheet/sequence/track JSON
  the studio loads verbatim via `@theatre/core`; the EDL transform compile
  (compile-to-EDL law) is unchanged.

## [0.7.1] - 2026-08-19

### Added
- Phase C — true sandbox isolation for the OpenHands runner: `engine: docker`
  (default) executes the agent loop AND its tools inside an ephemeral
  `timmy-oh-runner` container (`--cap-drop=ALL`, `no-new-privileges`, pids/
  memory/cpu caps, single `/work` mount); daemon-down or image-build failure
  fails closed as `not_configured`/`blocked`, never host fallback.
- In-container patch lifecycle: the bridge generates the worktree patch,
  applies it to a pristine clone, and asserts acceptance there — the receipt
  only seals green when the patch ALONE turns red→green
  (`patch_not_portable` otherwise). Host-path canary inside the container
  trips `isolation_violation` on any leaked host mount.
- Demo C GREEN (owner-approved frontier escalation, `llm=auto` under a
  $0.50 hard cap, single-use approval bound to the plan hash): workdir and
  pristine acceptance both exit 0, canary clean; parent receipt
  `sha256_69073a15`. The containerized local-model attempts that stayed red
  remain sealed honestly in the chain (`sha256_a1b85fea` correct patch but
  npm missing in image; `sha256_05a077a7`, `sha256_8c2f8f19` view-only).
- `scripts/phaseC-demo.ts` + `scripts/oh-runner.Dockerfile` (pinned
  openhands-sdk/tools/workspace 1.21/1.21/1.11, uv resolver, Chromium for
  toolset parity, npm for acceptance).

### Changed
- `timmy_openhands_run` plan hash now binds `engine` default `docker`
  (immutability law: host engines are an explicit, approved deviation).
- Note: `.agentrun` portable bundles remain clip-spine artifacts (EDL/media/
  OTIO); Demo C's proof rides the parent/child signed receipt chain instead.

## [0.7.0] - 2026-08-19

### Changed
- UI remap against the MMGEN v2.4.1 reference: strict Tokyo Night palette
  tokens centralized in `src/tui/theme.ts` (zero raw hex outside that file,
  enforced across panels, drafts, companions, logserver and project sites);
  PanelFrame standardized (hairline border, stdout-derived responsive gutters,
  semantic status glyphs from the single StatusGlyph map); Dispatch rail shows
  an 8-char plan hash with `[y]` copy / `[x]` expand, a sandbox isolation badge
  and a budget thermometer, every line width-truncated so the reverse LogRain
  never clips; LogRain is burst-safe (tail-only reads, size-signature skip,
  memoized) so Cloudflare event storms never lag chat/J-BANG input.
- TrueColor fallback: Ink/chalk down-convert the hex tokens automatically when
  `COLORTERM!=truecolor` (bare SSH/CI); `colorLevel` in theme.ts exposes the
  live mode — no second palette to keep in sync.

### Removed
- Orphaned Cloudflare workers `r2-worker` and `openrouter-tui-agent`
  decommissioned per owner decision — eliminates the false Workers-Builds
  PR checks.

## [0.6.0] - 2026-08-19

### Added
- OpenHands A2 SDK engine: Conversation API + LocalWorkspace, tools execute
  in-process against a seeded disposable workspace; NeverConfirm headless
  policy; bounded nudge loop; non-streaming ollama (streaming mangles
  tool-call args). Demo C remains honestly RED (last-mile edit reliability
  unresolved; receipts record every attempt).
- `hyperframes` render lane; Demos A+B re-run through the Command Post
  (plan → J-BANG approval → dispatch → collect, receipted).
- `host-ephemeral` dispatch workspaces seed `context_manifest` files
  (sha256-verified, path-escape-checked) — the ephemeral temp copy the
  isolation law always promised; renders run from the seeded copy, never
  the live checkout.
- Receipt browser (:4310/browser), Mission Map (:4321), UI north-star
  reference + color-consistency law, public-repo organization pass.

### Changed
- Local default OpenHands model `ollama/qwen3.8:27b-mlx`; engine part of the
  plan hash (immutability).

### Honesty
- Demo C acceptance record: workspace seeding ✓, tool invocation ✓, patch
  red→green ✗ (sealed red, `sha256_cf72f858` preserved as the original
  failure record). No fabricated passes.

## [0.5.0] - 2026-08-16

### Added
- **One-command judge loop** (`timmy_judge_loop` MCP tool): phase 1 returns the resolved executor/judge plan + plan hash; phase 2 requires an operator-minted single-use 5-min token bound to that exact hash (`timmy approve <planHash>`). Executors run via `Promise.allSettled`; one configurable judge; child receipts per executor/judge plus a parent receipt linking children, plan hash, spend and tier.
- **AgentPass-named spend policy**: approved plans bind system/user prompts, executor order, judge, transport resolution, parameters, escalation policy and `max_spend`/`tier`/`policy`; paid routes default-deny at `max_spend: 0`; overspend aborts before the judge.
- **Receipt chain v0.5 integrity**: single-writer mkdir lock serializes read-tail → sign → append across processes; release epochs (`EPOCH.json`) let a clean signed epoch start after an incident while legacy broken streams stay queryable as incident evidence; verifier reports per-epoch segments.
- **Receipts v2 bindings**: prompt/response hashes (never raw content), requested vs resolved model, transport, latency, tokens, reported cost, status and error class; failed AND denied attempts seal signed receipts too.
- **Replay integrity enforcement**: replay refuses on active-OS/arch/executable-build-hash or sealed-source-hash mismatch with signed failure receipts; verify records bind EDL + manifest hash + sources + output hash.
- **Portable `.agentrun` acceptance artifact** (`timmy export agentrun <jobId>`): sanitized bundle (relative paths, no credential material) with EDL, media, hashes, env lock, signer key, original + replay receipts, verification report and the OTIO interchange; replays from a fresh workspace and byte-compares.
- **Apify + cult/pro lanes**: `timmy_apify_run` (mcporter http, logged + receipted), cult/pro shadcn registry wired via `config/mcporter.json` env-placeholder header for the UI remix.
- **Parallel-agent git rules** in AGENTS.md (no `git add -A`, stage-only-yours, no resets of foreign work).

### Changed
- Approval booleans removed everywhere; bare `approved: true` no longer approves anything.
- `timmy export` gains `agentrun`; `timmy.ts` delegates `mcp|logs|approve|events` to the modern CLI.

### Fixed
- CI/release pin OpenTimelineIO 0.18.1 (`otioconvert` present); `timmy help`/`version` tests spawn node directly with a real timeout instead of flaking under load.

## [0.4.0] - 2026-07-14

### Added
- **Consensus Fusion Workflow Receipts**: Integrated `/api/workflow/fusion` endpoint on the Cloudflare Durable Object companion server to generate multi-agent consensus and Rive state validation receipts.
- **MCPorter & Rive Companion**: Wired MCPorter integration and `@rive-app/canvas` in root, plus `@rive-app/react-canvas` in `my-react-app`.

### Changed
- **TypeScript 7 Upgrade**: Migrated root package and `my-react-app` workspace devDependencies to TypeScript `^7.0.2`.
- **Single-source Version Generator**: Configured automated version generation writing `src/version.ts` from root `package.json` dynamically before builds, tests, and packing.

## [0.3.0] - 2026-07-11

### Added
- **Break Mode `list_card` Tool**: Added integrated TUI tool in `src/agent/tools.ts` to fetch live card pricing and push Stripe checkout listings live on stream via the Break Mode API.
- **Hermes TUI Gateway**: Implemented Hermes TUI Gateway event mirror MVP for event mirroring, authorization, DMs, D1-backed session state, and sealed gateway receipts.
- **Setup Guidance**: Included git clone command in README and setup guide as the first installation step.
- **Code Reviews**: Configured main branch checks to require code owner reviews.

### Fixed
- **Fixed-Column Options Layout**: Fixed layout overlap issues on the options panel under specific terminal aspect ratios.
- **Repository Clean**: Cleaned up internal planning documents and absolute path file links for open-source publication.

## [0.2.0] - 2026-06-12

### Added
- **TUI Model Rail Readability**: Improved colors, rails layout, and model text truncation rules.
- **Hotfix Automator**: Added release upgrade checklists and hotfix shell automation.

### Fixed
- **TUI Layout regressions**: Resolved terminal panel regressions on Options, Workspace, and Teams layouts.
- **Deterministic Layouts**: Fixed panel flex dimensions to guarantee no overlaps on narrow screens.

## [0.1.0] - 2026-06-07

### Added
- **Deterministic Receipt Hashing**: Implemented key-sorting canonicalization and SHA-256 manifest hashing in `src/receipt/schema.ts`.
- **Command Line Interface**: Expanded `timmy` command with `demo`, `proof`, `version`, and `help` commands in `timmy.ts` and `src/cli.ts`.
- **Vitest Testing Framework**: Added unit and integration tests under `tests/receipt.test.ts` verifying receipt logic and CLI stdout/file behavior.
- **NPM Package Mappings**: Wired whitelist files and `bin` entries in `package.json` for global installs and `npx` executions.
- **GitHub Launch Files**: Added `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `ROADMAP.md`, and CI/Release GitHub Actions workflows.
- **Example Guides**: Added examples for basic demo setup and Cloudflare deployment validation receipts.
