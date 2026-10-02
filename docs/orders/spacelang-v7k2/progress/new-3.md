# timmy-new-3 — spacelang-v7k2

## Progress

- R0.3: hashes verified; read-only fleet and wheel inventory collected. Data frozen for one acceptance execution; result recorded below after execution. Integration only by PR; no merge until timmy-new-2 CLEARED and applicable checks are green.
- Baseline source: `76d3e23fac9e82032535194e5739189cae4734ba` on `order/spacelang-v7k2-native`; isolated worktree initially clean. Fetch and rebase exited 0.
- Allowed writes: `.timmy/private/space/**`, `.timmy/private/fleet/nodes.json`, `.timmy/private/fleet/ssh_config`, this file and `docs/orders/spacelang-v7k2/handoff/R0.3-new-3.md`. All native implementation, workflows, governance, primary checkout changes and shared receipt chains are protected.
- Start: 2026-10-02T08:04:18.040580+00:00; monotonic 900-second budget, deadline 2026-10-02T08:19:18.040580+00:00, 180 seconds reserved.
- Harness: Codex. Model requested by operator: GPT-6.1 Sol. Effort requested: Extra High. Runtime setting cannot be confirmed or changed through the available chat tools.

## Surprises & Discoveries

- The configured checkout path no longer exists. Resolved the same Git common directory through a retained checkout, verified origin and created the isolated branch from fetched origin/main; no primary-checkout changes were incorporated.
- Codex create-worktree returned “Not a git repository” for the stale chat path. The shell-created Git worktree exists; attach-worktree rejected it as unmanaged. App registration remains unresolved before future native implementation.
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


## Outcomes

Inventory acceptance PASS: 13/13 checks, one execution, exit 0. Raw acceptance sha256 `040ba88c07c23b8586bf8b3634b15b6623b2098724a2fdaaddfebc4e8e6c6d4d`. These are detached diagnostic artifacts, not signed receipts. Delivery privacy check and PR head are reported separately. No installs, pulls, benchmarks, measurements, source builds, model access requests, system changes, deployments, merges or shared-chain seals. NAS storage remains disabled. Private output paths: `.timmy/private/space/runs-where-r0.3.{md,json}`, `.timmy/private/fleet/nodes.json`, `.timmy/private/fleet/ssh_config`, and checkpoint-local diagnostics/journal under `.timmy/private/space/r0.3/`.

## Next

HOLD after R0.3. F1 begins only when the operator names it and verifier acceptance exists. Resolve managed worktree attachment before implementation. spark3 requires operator-side restoration of SSH; no node service changes are authorized.
