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
- [x] Pushed the build branch and opened draft PR #82; publication record below.
- [x] A2 verified and copied verbatim; direct network execution authorized.
- [x] Fetched origin and pinged each of the five nodes exactly once.

## Surprises & Discoveries

- C6 remains uncommitted and `fixes_required / HOLD`; its 80 focused tests and
  typecheck passed, while independent review retained seven integration findings.
  Fast-save reload is recoverable from the explicit checkpoint; it is not yet
  durable automatic reopening. Prior outcomes are preserved.
- The baseline has a local `v1.1.0` tag. ORDER §11's fallback release target is
  therefore `v1.2.0-rc.1`, subject to later fresh remote inventory and release approval.
- The initial round stopped network work because this session rejects per-command
  escalation. Operator A2 now authorizes direct execution of already-granted
  network actions. No sandbox or node setting was changed.

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

- 2026-10-02: Operator A2 authorizes the existing worktree and direct execution
  of already-granted network commands. Source: `~/timmy/orders/spacelang-v7k2/A2.md`;
  SHA-256: `ba0a764973fdab205fe99c63bf382b72a770f7d2ebe7e09fadb6a08e8c2356d1`.
  The operator explicitly requests R0.1 completion. Future builder checkpoints
  wait for their independent frozen acceptance on origin.

<!-- BEGIN A2 VERBATIM -->
OPERATOR AMENDMENT A2 · worktrees, execution mode, sequencing, spark3
(Level 1. Amends ORDER §2 and §4 as written below. This is an amendment, not a conflict: apply it and copy it verbatim into your Decision Log, with this file's path and sha256.)
1. Worktrees. The ordinary git worktree each thread is using now (same .git, same origin, its own branch) satisfies ORDER §2's worktree override, whether or not the Codex app registers it as managed. Each thread commits and pushes only its own branch from its own worktree, and never touches another worktree or the main checkout.
2. Execution mode. A session that cannot request per-command sandbox escalation may run the network actions ORDER §2 GRANTS directly: git fetch, push and pull requests for its own branch; ping and SSH to the MACHINES nodes; the listed package registries. List every network command in the report. Everything on §2's APPROVAL and ESCROW lists still needs my APPROVE line.
3. Sequencing. A builder checkpoint starts only after timmy-new-2's frozen acceptance for it is on origin, and the builder's report cites that commit. If it is not there yet, report WAITING and HOLD without building.
4. spark3 answers ping, but its SSH server is off (port 22 refuses). Report it as "UP, SSH unavailable" until I write "spark3 SSH ready". Never try to enable it. Work that needs spark3 waits; everything else proceeds.
<!-- END A2 VERBATIM -->

## Outcomes

### Initial round, before A2

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

### R0.1 completion under A2

A2 SHA-256 matches the operator's value; both amendment blocks remain verbatim.
`git fetch origin` exited 0. `origin/main` remains
`76d3e23fac9e82032535194e5739189cae4734ba`; no rebase was needed.
The doctrine branch ref remains `b1ecefada43992498564068b3e268f5e977acb3d`
after fetch. Local inventory limitations and the initial round's results remain
historical; no capability rung or UI readiness claim is raised.

| Node | One LAN ping exit | Observed reachability |
| --- | --- | --- |
| `spark1` | 0 | UP |
| `spark2` | 0 | UP |
| `spark3` | 0 | UP, SSH unavailable |
| `nas1` | 0 | UP |
| `nas2` | 2 | unreachable |

Pings ran at 01:29:47–01:29:49 Pacific on 2026-10-02. Each node received one
request. spark3's SSH unavailability comes from A2; SSH was not probed or enabled.
NAS discovery used ping only; no login was attempted and NAS storage stays false.
The unreachable nas2 is a retained discovery result, not a failed local gate.

Network commands executed so far (private addresses appear only in raw private logs):

- `git fetch origin`
- `/sbin/ping -n -c 1 -W 1000 -t 3 <spark1:private-address>`
- `/sbin/ping -n -c 1 -W 1000 -t 3 <spark2:private-address>`
- `/sbin/ping -n -c 1 -W 1000 -t 3 <spark3:private-address>`
- `/sbin/ping -n -c 1 -W 1000 -t 3 <nas1:private-address>`
- `/sbin/ping -n -c 1 -W 1000 -t 3 <nas2:private-address>`

Planned publication commands, not yet executed at this documentation freeze:
`git push -u origin order/spacelang-v7k2-build`, then
`gh pr create --repo woodman33/timmy-tui --base main --head order/spacelang-v7k2-build --draft --title "docs: record Timmy Space baseline and amendments" --body-file <private-pr-body>`.
Final publication outcomes will be appended after observation.

The A2 completion freeze passed all 35 local checks once. The privacy scan
reported 0 medium-or-above findings (368 review-level findings); the defective
fixture still tripped 17 blocking findings. The license gate remains not-run
because it is not yet implemented. No runtime or integration was qualified.

### Publication observed under A2

The build branch was pushed successfully. Draft PR: [#82](https://github.com/woodman33/timmy-tui/pull/82).
The initial publication head is `a22e8754ef282fea99197b18ec00c3f313daf8a4`; the final documentation head is
reported after its push. The PR is a draft for independent review, not a CLEAR
or merge authority. R0.1's requested artifacts are complete; CI and independent
review remain separate. The initial INCOMPLETE round above is retained unchanged.

A second `git fetch origin` observed the verifier's frozen acceptance commit
`628f308d9631ef56e636f080c2dd96371917cdd7` on `origin/order/spacelang-v7k2-verify`, with C6.1, C6.2
and F1 acceptance files. No builder checkpoint began. The next named builder
round must cite that exact commit. The benchmark remains unapproved.

Additional executed network commands:

- `git push -u origin order/spacelang-v7k2-build` — exit 0.
- `gh pr create --repo woodman33/timmy-tui --base main --head order/spacelang-v7k2-build --draft --title "docs: record Timmy Space baseline and amendments" --body-file <private-pr-body>` — exit 0.
- `git fetch origin` — second fetch, exit 0; observes the verifier's publication.

This final reporting update will be followed by one `git push origin
order/spacelang-v7k2-build` and one `gh pr view 82 --repo woodman33/timmy-tui
--json url,isDraft,headRefOid,statusCheckRollup`; their exact outcomes are retained
in the private publication log and final report. The app's attach_artifact action
attached PR #82 to this task; its coordination message informs timmy-new-2.

No source files, external applications, node settings or shared receipts were
changed. The build branch carries R0.1 documentation only; all C6 candidate
files remain unstaged and byte-preserved. No runtime or UI readiness is claimed.

## Next

R0.1 is complete after observed publication; report and HOLD.
Under A2, C6.1 starts only after the operator names that round and the verifier's
frozen acceptance is on origin; the builder must cite that exact commit. Native ownership remains with
new-3 unless the operator explicitly says that thread is not open.
