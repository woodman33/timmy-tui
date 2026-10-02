# timmy-new-1 — spacelang-v7k2

## Progress

- [x] R0.1 READ FIRST: all three operator-provided SHA-256 values matched.
- [x] Captured private Git baseline, branches, tags and C6 candidate preimages.
- [x] Created `order/spacelang-v7k2-build` from the C6 baseline at
  `76d3e23fac9e82032535194e5739189cae4734ba`; retained all candidate bytes.
- [x] Wrote the public scope stub and private fleet configuration.
- [x] Completed the local inventory and reuse/reference map.
- [x] Froze and ran the 38 local artifact checks once; all passed.
- [x] Privacy tree: zero medium-or-above findings; defective fixture: 17 blocking findings.
- [x] Finalized the three R0.1 documents for the authorized local commit.
- [ ] Remote publication and PR: held with fetch and node discovery.
- [ ] Fetch, node discovery and push: stopped pending network-mode clarification.

## Surprises & Discoveries

- C6 remains uncommitted and `fixes_required / HOLD`; its 80 focused tests and
  typecheck passed, while independent review retained seven integration findings.
  Fast-save reload is recoverable from the explicit checkpoint; it is not yet
  durable automatic reopening. Prior outcomes are preserved.
- The baseline has a local `v1.1.0` tag. ORDER §11's fallback release target is
  therefore `v1.2.0-rc.1`, subject to later fresh remote inventory and release approval.
- This session disables approval requests and rejects per-command sandbox
  escalation. Network work is stopped pending clarification of that mode;
  no sandbox or node setting has been changed.

### Baseline and local inventory

The cached baseline is `76d3e23fac9e82032535194e5739189cae4734ba` on
`codex/workspace-ux-20260930`. The build branch began at that exact revision.
All 30 existing candidate files have independently retained preimages; the 13
files from the earlier independent C6 review also match that retained manifest.
C6 is uncommitted, unstaged and still on HOLD. Full status, branches, tags and
worktree records are private. Remote freshness is unknown because fetch is held.

The private Mac inventory records 22 toolchain probes, 22 Python environments,
50 target package records, six Hugging Face cache repositories and 28 Ollama
model manifests. These are local inventory observations, not working integrations.
OpenCV package metadata is present. Record3D and Open3D were not observed within
the bounded scan; their presence elsewhere remains unknown. No SDK import,
model inference, download, installation or camera capture was run.

The five private fleet entries use only node ids in public reporting:
`spark1`, `spark2`, `spark3`, `nas1`, `nas2`. Reachability is **not-run**, rather
than UP or unreachable: no ping or SSH was attempted while execution-mode
clarification is pending. NAS storage is disabled; no NAS login is configured
or attempted. The private SSH overlay leaves the user's SSH configuration intact.

### DOCTRINE numbering map

| Binding AGENTS reference | Observed public DOCTRINE mapping |
| --- | --- |
| §15, generated CAD sentence | Sentence absent from public DOCTRINE; AGENTS §4 and ORDER §7.4 remain binding. |
| §16, geometry provenance and evidence states | §15, **GEOMETRY IS A LEDGER**. |
| §17, checkpoint delivery size | §16, **DELIVERY SIZE**. |

The local `docs/doctrine-13-15-16-r2` branch is absent. Its cached remote ref is
`b1ecefada43992498564068b3e268f5e977acb3d`; its DOCTRINE is byte-identical to
the working copy. Fresh remote state is untested. Cite section titles until the
operator resolves numbering; no governance file was changed in R0.1.

### ORDER §5 reuse inventory

These paths were inspected locally. Presence is not qualification, a new license
ruling, or authority to modify them in R0.1. Existing code and templates remain.

| Reuse path | Local state |
| --- | --- |
| `src/vision/spatial/volume.ts` | Present |
| `docs/SPATIAL-VOLUME-CONTRACT.md` | Present |
| `src/vision/spatial/model-context.ts` | Present |
| `src/vision/spatial/gaussian-ply-context.ts` | Present |
| `src/evidence/admission.ts` | Present |
| `src/utils/receipts.ts` | Present |
| `src/cli.ts` | Present |
| `lanes/anchor/anchor-edge-head.mjs` | Present |
| `workers/ai-proxy/src/chain.ts` | Present |
| `workers/ai-proxy/src/head.ts` | Present |
| `lanes/recipes/jobs.ts` | Present |
| `src/vision/server.ts` | Present |
| `studio/tldraw-mission-map/index.html` | Present |
| `src/vision/proof-ladder.ts` | Present |
| `src/vision/mcp.ts` | Present |
| `src/vision/integrations/registry.ts` | Present |
| `src/vision/integrations/runner.ts` | Present |
| `src/vision/integrations/cli.ts` | Present |
| `tools/spatial-fit-20260915/adapter.py` | Present |
| `tools/platform-vision-20260910/telemetry/adapter.py` | Present |
| `tools/platform-vision-20260910/analytics/adapter.py` | Absent; gap retained |
| `tools/platform-vision-20260910/openhands/adapter.py` | Absent; gap retained |
| `tools/platform-vision-20260910/cosmos/adapter.py` | Absent; gap retained |
| `lanes/wire/README.md` | Present |
| `lanes/wire/bridges.json` | Present |
| `lanes/wire/exec.mjs` | Present |
| `lanes/wire/wire.mjs` | Present |
| `lanes/wire/snip-pty.py` | Present |
| `config/mcporter.json` | Present |
| `src/mcp/cmcp-bridge.ts` | Present |
| `src/harness/policy.ts` | Present |
| `src/harness/adapters/opencode.ts` | Present |
| `src/harness/adapters/hermes.ts` | Present |
| `src/harness/adapters/jcode.ts` | Present |
| `src/harness/adapters/pi.ts` | Present |
| `src/harness/adapters/minds.ts` | Present |
| `lanes/abilities/harnesses.json` | Present |
| `lanes/abilities/probe.mjs` | Present |
| `workers/ai-proxy/src/commander.ts` | Present |
| `workers/ai-proxy/src/timmy.ts` | Present |
| `workers/ai-proxy/src/room.ts` | Present |
| `src/jbone/resolver.ts` | Present |
| `src/jbone/templates/refactor.cue` | Present |
| `src/jbone/templates/ship.cue` | Present |
| `src/jbone/templates/test.cue` | Present |
| `src/tui/components/VisualToolsPanel.tsx` | Present |
| `src/utils/visual-tools.ts` | Present |
| `src/utils/terminal-image.ts` | Present |
| `src/graphics/kitty-pipeline.ts` | Present |
| `src/graphics/sixel-pipeline.ts` | Present |
| `src/graphics/iterm2-pipeline.ts` | Present |
| `src/vision/cli.ts` | Present |
| `lanes/visual/tokens.json` | Present |
| `src/tui/theme.ts` | Present |
| `lanes/privacy` | Present |
| `fleet/nodes.example.json` | Present |
| `.github/workflows/release.yml` | Present |
| `scripts/release-preflight.mjs` | Present |
| `tests/vision-templates.test.ts` | Present |

The seven optional guides listed in ORDER §2 and `docs/WORKFLOW-BENCHMARK.md`
are absent. The entry-gate override covers this inventory/documentation round;
no spatial benchmark or physical accuracy claim is made. Historical house-study
runtimes and adapter sources remain separate; metadata reads did not alter them.
The `@mcpc-tech/cmcp` bridge is the current client-exec slot; it is not the
historical similarly named client. No MCP route was exercised this round.

No root receipt-store pin was observed. Both receipt journals have independently
retained precondition bytes; no chain append or seal was attempted. Future seals
remain stopped until the shared store is explicitly resolved and pinned.

## Decision Log

- 2026-10-02: R0.1 is inventory/documentation only. No install, model run,
  geometry benchmark, capture, runtime default, deployment or release tag.
- 2026-10-02: Preserve the C6 candidate in place; stage none of its paths.
  Its original branch reference and 30 independently retained file preimages
  remain intact while the new build branch carries documentation commits only.
- 2026-10-02: NAS storage remains disabled until operator-configured access exists.
- 2026-10-02: Apply the following Level1 A1 amendment verbatim. Source:
  `~/timmy/orders/spacelang-v7k2/A1.md`; SHA-256:
  `fd37d86224661fe5d2d69bc2b4fb1234a6cf91e9846bfe2711dc0d577e67452a`.

<!-- BEGIN A1 VERBATIM -->
OPERATOR AMENDMENT A1 · measurement physics + probe roster
(Level 1. Amends ORDER §7.2, §7.4, §7.6, §9 and §10 as written below. This is an amendment, not a conflict: apply it and copy it verbatim into your Decision Log.)
Why: published evaluations put phone LiDAR at about ±1 cm absolute on objects over 10 cm, with a detection limit near 5 cm (576 laser points). A trading card is about 0.3 mm thick. A 1 mm TSDF voxel is ledger resolution, never accuracy; no surface may present it as accuracy.
1. Two instruments, reported separately; M3b runs both and reports each.
   PLANAR + MULTI-VIEW (new-3, new checkpoint M1b right after M1): full-resolution RGB stills + ChArUco calibration + board pose. Card edges via the homography in the board plane; cube edges and height via multi-view triangulation of its corners. Evidence kind: calibrated_observation.
   SPACE (LiDAR TSDF, unchanged): occupancy, free and unknown space, and a cm-class cross-check of the cube.
2. Every dimension carries ± uncertainty with its budget (fiducial scale, calibration reprojection residual, edge localization, sensor floor). measured:true requires |error| within the frozen threshold AND the caliper value inside the ± interval.
3. new-2 derives each threshold from that instrument's published floor plus one fixture run, writes the derivation into WORKFLOW-BENCHMARK.md, and freezes the M3b thresholds only after verifying M1b and M3a.
4. The M3b cube is 100 mm or larger per side, within the caliper's range.
5. Before F2a's golden vectors freeze, timmy.space.voxel/1 gains an optional channel sigma u16 (1σ in micrometres; absent = not recorded). Producers send raw per-voxel σ; Rust quantizes it like every other channel.
6. new-1 F6b: add Timmy's own agent loop (the OpenRouter Agents SDK layer) and OpenRouter's Ori harness, if installed, to the spatial_language probe, negative control included. A harness that can't register MCP is recorded null with the reason.
<!-- END A1 VERBATIM -->

## Outcomes

R0.1 remains **INCOMPLETE / HOLD**. Local R0.1 artifacts are prepared. Canonical ORDER and A1 verified; the verifier
prompt was hashed only and its instructions were not read or acted upon. Raw
inventories and machine values remain private. No capability rung was raised,
no receipt was sealed, and UI readiness is not claimed. Network-dependent
completion remains held; the final observed acceptance/publication result is
recorded in the checkpoint handoff. The 38 local artifact checks passed; the
privacy scan reported 0 gated findings (368 review-level findings), and its
negative fixture reported 17 gated findings as expected. These checks qualify
only the documentation/inventory constraints, not any application integration.
The license gate is not-run because it has not been implemented. No network
command or publication ran before this reporting update.

## Next

Finish R0.1's frozen acceptance and allowed publication, report and HOLD.
C6.1 begins only in a separately named round. Native ownership remains with
new-3 unless the operator explicitly says that thread is not open.
