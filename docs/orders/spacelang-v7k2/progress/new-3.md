# timmy-new-3 — spacelang-v7k2

## Progress

- A2 applied: the existing ordinary Git worktree satisfies ORDER; direct granted network actions are permitted in this session. Current spark3 status: **UP, SSH unavailable** (operator declaration; no new probe). No SSH retry or enablement until the operator writes "spark3 SSH ready".
- Next builder checkpoint: **WAITING**. F1 has not been named for execution, and `origin/order/spacelang-v7k2-verify` is absent after fetch; no verifier freeze commit can currently be cited. No implementation started.
- A2 update write budget: this progress file and checkpoint-local private preimages/journal only; five-minute monotonic deadline, ending in HOLD. Network commands: `git fetch origin`; `git push origin order/spacelang-v7k2-native`. No node or registry network commands run for this update.

- R0.3 COMPLETE / HOLD: all hashes verified, private fleet/wheel matrix written, one acceptance passed 13/13, and privacy scan passed. Draft PR #80 is open; no merge performed. Integration only by PR; no merge until timmy-new-2 CLEARED and applicable checks are green.
- Baseline source: `76d3e23fac9e82032535194e5739189cae4734ba` on `order/spacelang-v7k2-native`; isolated worktree initially clean. Fetch and rebase exited 0.
- Allowed writes: `.timmy/private/space/**`, `.timmy/private/fleet/nodes.json`, `.timmy/private/fleet/ssh_config`, this file and `docs/orders/spacelang-v7k2/handoff/R0.3-new-3.md`. All native implementation, workflows, governance, primary checkout changes and shared receipt chains are protected.
- Start: 2026-10-02T08:04:18.040580+00:00; monotonic 900-second budget, deadline 2026-10-02T08:19:18.040580+00:00, 180 seconds reserved.
- Harness: Codex. Model requested by operator: GPT-6.1 Sol. Effort requested: Extra High. Runtime setting cannot be confirmed or changed through the available chat tools.

## Surprises & Discoveries

- The configured checkout path no longer exists. Resolved the same Git common directory through a retained checkout, verified origin and created the isolated branch from fetched origin/main; no primary-checkout changes were incorporated.
- Codex create-worktree returned “Not a git repository” for the stale chat path. The shell-created Git worktree exists; attach-worktree rejected it as unmanaged. The app registration failures remain historical observations; A2 confirms the ordinary Git worktree is sufficient, so registration is no longer a prerequisite.
- spark1 and spark2 UP by ping and SSH; spark3 UP by ping, SSH connection refused, inventory unknown. nas1 UP by ping, ports and export discovery recorded; nas2 unreachable by ping, TCP ports and export discovery. Exact methods/times stay private. 4090: not provided.
- Raw inventories and all 13 wheel rows are in `.timmy/private/space/`; real connection values are only in `.timmy/private/fleet/`. Wheel identity, arch, Python ABI and CUDA support remain separate from installation and operation.
- No current-run evidence handles or observed cite calls are available. Admitted model evidence is unknown; diagnostic hashes are not shared-chain receipts or capability qualification.

## Decision Log

- Scope follows ORDER §§2–4, 7.7, 8–10 and 14; preserve DESIGN and decisions.md, including CUE validation under D3 and the forge boundary under D5. R0.3 changes no interface or source behavior.
- DOCTRINE map: committed main and `origin/docs/doctrine-13-15-16-r2` use “GEOMETRY IS A LEDGER” §15 and “DELIVERY SIZE” §16; AGENTS references §16 and §17. The primary checkout has a pre-existing uncommitted “MEASUREMENT SCOPE AND THE SHARED 3D PROOF” §15, “GEOMETRY IS A LEDGER” §16 and “DELIVERY SIZE” §17. Cite titles until operator resolves numbering; preserve every version. No governance edit or merge is performed.
- ORDER file: `~/timmy/orders/spacelang-v7k2/ORDER.md`, sha256 `b810840d0236d4a8f67a75ccd29b2f2d79a0e3695ab230c9c4240d673968ab7d`.
- A1 canonical source: `~/timmy/orders/spacelang-v7k2/A1.md`, sha256 `fd37d86224661fe5d2d69bc2b4fb1234a6cf91e9846bfe2711dc0d577e67452a`. The exact source bytes follow verbatim; apply as level-1 amendment without editing ORDER.

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


- A2 canonical source: `~/timmy/orders/spacelang-v7k2/A2.md`, sha256 `ba0a764973fdab205fe99c63bf382b72a770f7d2ebe7e09fadb6a08e8c2356d1`. Level 1; its exact source bytes follow verbatim. The canonical file and ORDER remain unchanged.

OPERATOR AMENDMENT A2 · worktrees, execution mode, sequencing, spark3
(Level 1. Amends ORDER §2 and §4 as written below. This is an amendment, not a conflict: apply it and copy it verbatim into your Decision Log, with this file's path and sha256.)
1. Worktrees. The ordinary git worktree each thread is using now (same .git, same origin, its own branch) satisfies ORDER §2's worktree override, whether or not the Codex app registers it as managed. Each thread commits and pushes only its own branch from its own worktree, and never touches another worktree or the main checkout.
2. Execution mode. A session that cannot request per-command sandbox escalation may run the network actions ORDER §2 GRANTS directly: git fetch, push and pull requests for its own branch; ping and SSH to the MACHINES nodes; the listed package registries. List every network command in the report. Everything on §2's APPROVAL and ESCROW lists still needs my APPROVE line.
3. Sequencing. A builder checkpoint starts only after timmy-new-2's frozen acceptance for it is on origin, and the builder's report cites that commit. If it is not there yet, report WAITING and HOLD without building.
4. spark3 answers ping, but its SSH server is off (port 22 refuses). Report it as "UP, SSH unavailable" until I write "spark3 SSH ready". Never try to enable it. Work that needs spark3 waits; everything else proceeds.

- Application of A2: stay in this worktree and push only this branch; execute only ORDER-granted network actions directly; require a verifier acceptance freeze on origin and cite its exact commit before each builder checkpoint; keep spark3-dependent work waiting until the operator states SSH is ready. All APPROVAL, ESCROW, merge-clearance and single-writer sealing boundaries remain in force.


## Outcomes

Inventory acceptance PASS: 13/13 checks, one execution, exit 0. Raw acceptance sha256 `040ba88c07c23b8586bf8b3634b15b6623b2098724a2fdaaddfebc4e8e6c6d4d`. These are detached diagnostic artifacts, not signed receipts. Staged privacy scan exit 0, no findings; commit and push exited 0. Draft PR: https://github.com/woodman33/timmy-tui/pull/80. The final delivery SHA is the PR head; no CI wait or merge in this checkpoint. No installs, pulls, benchmarks, measurements, source builds, model access requests, system changes, deployments, merges or shared-chain seals. NAS storage remains disabled. Private output paths: `.timmy/private/space/runs-where-r0.3.{md,json}`, `.timmy/private/fleet/nodes.json`, `.timmy/private/fleet/ssh_config`, and checkpoint-local diagnostics/journal under `.timmy/private/space/r0.3/`.

## Next

HOLD after this A2 progress update. F1 is WAITING until the operator names it and timmy-new-2's frozen acceptance is on origin; the builder report must cite that commit. The existing Git worktree is sufficient under A2. spark3 is "UP, SSH unavailable" until the operator writes "spark3 SSH ready"; work requiring its SSH waits, with no attempt to enable its server.
