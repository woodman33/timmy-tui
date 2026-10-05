# Benchmarks Timmy is judged against

Timmy is a multi-agent harness with a receipt and verification layer, not a model. So the
benchmarks that matter are the ones that score *harnesses* (how well a controller drives
models and tools through long, tool-heavy tasks) and the ones that score the *spatial work*
Timmy does with those models (3D generation, multi-view geometry, spatial reasoning). This
page is the map: what each benchmark measures, whether Timmy can run it today, and what is
still missing. Status words follow AGENTS.md §8 — proposed, installed, reachable,
exercised, qualified — and nothing here is a score until a receipt says so.

Numbers from our own bench are repeated here only with their receipt chain and date; the
live tables stay on the Lab50 dashboard.

## 1. Harness benchmarks (the controller is the product)

| Benchmark | What it scores | Why it fits Timmy | Status | What Timmy still needs |
|---|---|---|---|---|
| **Terminal-Bench 4.0** | Long terminal tasks in sandboxed containers, pass/fail per task | Timmy's lanes are terminal-first; the receipt chain is a natural trace format | proposed | A Harbor-compatible agent adapter around `timmy` (one container, one task, one receipt chain per run) |
| **Harbor-Index 1.0** | Aggregate over Harbor-hosted task suites, harness-level leaderboard | Same adapter as above; one place to publish a harness score | proposed | Harbor adapter + a public results page that links each score to its chain |
| **τ³-bench** | Tool-agent-user conversations with policy compliance, pass^k reliability | Timmy's AgentPass passports and ALWAYS_REVIEW gates are policy compliance made explicit | proposed | A user-simulator loop in the service shelf (OpenRouter Agent SDK tool that plays the user) |
| **SWE-bench-Live** | Fresh, uncontaminated software-engineering issues, resolved-PR rate | Replaces SWE-bench Verified, which OpenAI dropped for contamination | proposed | The `jcode`/`opencode`/`pi` executor lanes already exist; needs the dataset runner and a resolve/receipt reporter |
| **CooperBench** | Multi-agent cooperation on shared codebases | Timmy's "controller of controllers" is exactly the thing under test | proposed | Two Timmy hands on one worktree with the escrow-class merge rules from AGENTS.md §7 |
| **Toolathlon-Verified / MCP-Universe** | Real MCP tool use across many servers, verified end states | Timmy ships ≥2 MCP↔CLI routes and a service shelf of MCP lanes | installed (routes) | The task runner; the MCP servers in the suite must be reachable from the lane sandbox |
| **Gaia2** | Agentic assistant tasks with time, budget and noise | Budgets and time caps are first-class in every lane (`limits`, `max_minutes`, `cost_usd`) | proposed | A Gaia2 task loader and the receipt-to-score mapping |

Known trap: **SWE-bench Verified** is contaminated and no longer reported by the model labs;
do not spend a run on it.

## 2. 3D generation (the house bench, voxel by voxel)

No public generator reports a voxel IoU; the Lab50 bench is the only place these five
models are scored against exact CAD truth at 5 cm. Public comparability comes from running
the same scorer on public sets.

| Benchmark | What it scores | Status | What Timmy still needs |
|---|---|---|---|
| **Toys4K** | 4,000 toy-scale meshes; the comparability set most papers quote | source pinned | Hub mirror `Yang2001/toys4k_meshes` (3 854 `<category>/<id>/mesh.ply`, Blender units → unit-cube frame only). The mirror's MIT tag does not speak for the upstream per-object artist licences: numbers only until each object's licence is checked; no renders ship |
| **GSO (Google Scanned Objects)** | 1,030 scanned household objects, CC-BY | **loader shipped** (`lanes/geo/bench_loader.py`, Oct 4) | Truth in two frames per object — metric from the original OBJ, unit-cube from the GLB — plus the five shipped renders as inputs; smoke shard (5 objects) extracted and frame-verified; the 44-shard pull (~8 GB) waits for an explicit order line; **first generator round scored on the smoke set, Oct 5** (table below) |
| **HY3D-Bench (test split)** | Tencent's cleaned watertight meshes with multi-view renders and sampled points (252 K full objects; paper 2602.03907) | source pinned | `tencent/HY3D-Bench` on the Hub, dataset licence **CC-BY-4.0** (the Hunyuan3D 2.1 *model* stays test-only for us — different licence). Test split = 2 chunks × {images 6.3 GB, sample_points 0.96 GB, water_tight_meshes 1.26 GB}; the sample_points chunks are the truth the scorer needs (~1.9 GB, under the 10 GB line but not pulled yet) |
| **SA-3DAO** | The only set with a published vIoU protocol | no Hub mirror | Not on the Hugging Face Hub (searched Oct 4); distributed with Meta's SAM 3D release — fetch by hand, then match their voxel size and tolerance (`voxel_score.py --voxel … --tolerance …`) before comparing a number |
| **3D Arena / top3d.ai** | Human preference rankings | n/a | Preference is not geometry; cite for context only |

Lab50 result to beat (Oct 3, 2026, chain `lab50`): Pixal3D 0.80 voxel F1, Hunyuan3D 2.1
0.77, TRELLIS.2 0.60, TripoSplat 0.59, Depth Anything 3 single view 0.10 (5 cm voxels,
1-voxel tolerance, upright fit, one house family).

The scorer now ships in the repo as `lanes/geo/voxel_score.py` (Oct 4): voxel F1/IoU on a
truth-anchored grid (`--voxel`, `--tolerance 1.0` for the bench's one-voxel tolerance, `--fit`
for the upright fit — which marks the result `metric:false`), plus the two numbers the papers
quote, Chamfer distance and F-score@τ, with `--normalize` for the unit-cube frame. The Toys4K,
GSO and HY3D-Bench rows above are filled by pointing it at a loader's truth mesh and the model's
output; a number is comparable to a paper's only when τ, point count and alignment match, and
the receipt records all three so the comparison can be checked rather than believed. Each scored run renders as a **Bench Card**
(`bench_loader.py card`): one self-contained page with the sealed prediction and its verdict, the voxel F1 band, F-score@τ,
Chamfer and the hashes that tie it to its summary and source data — the public, shareable form of every number in this file.
Generator outputs are scored with `--fit-global` (a 384-pose rotation search before the scaled fit, since a generator's up
axis and yaw are its own) and a 3D Gaussian splat is read as the centres of its opaque Gaussians; both are shape scores and
the card says how each prediction was read.

**First generator round, GSO smoke set (5 objects), Oct 5, 2026, spark2 (NVIDIA GB10).** Unit frame, voxel 1/64, τ 0.02,
sub-voxel tolerance 0.05, `--fit-global`; every model got the same BiRefNet cut-out of `view_0` (identical input hashes),
seed 42 and its own default settings. All three predictions were sealed at 21:35Z, before any generator ran; re-scoring
reproduces a summary byte for byte.

| Model (licence) | Median voxel F1 [8-phase band] | F-score @ τ 0.02 | Chamfer | Sealed prediction → verdict | Per object | Per object on spark2 |
|---|---|---|---|---|---|---|
| Hunyuan3D-2.1, shape only (Tencent community licence: test only) | **0.616** [0.611–0.616] | 0.887 | 0.0098 | 0.55 → as predicted | best on 4 of 5 | 86 s · 8.2 GB |
| TripoSplat (MIT), read as opaque Gaussian centres | 0.583 [0.575–0.586] | 0.842 | 0.0118 | 0.40 → outside tolerance, above | best on the shoe | 28 s · 5.0 GB |
| TripoSG (MIT) | 0.518 [0.514–0.532] | 0.816 | 0.0121 | 0.50 → as predicted | 0.283 on the construction kit: it rebuilt the assembly, not the loose pieces | 33 s · 6.1 GB |

Five objects make a smoke test: the order is a first read, not a result, and the band is the grid-phase spread, not
sampling error. The a-priori ranking (Hunyuan3D > TripoSG > TripoSplat) got the leader right and the other two the wrong
way round. Next on this axis: TRELLIS.2 and Pixal3D (already on spark2 as int8 ComfyUI builds, so their numbers will be
for those builds), then the 1,030-object set.

## 3. Multi-view and metric geometry (the part that can be *measured*)

| Claim | How it is tested | Receipted so far (chain `lab50-ext`, Oct 4, 2026) |
|---|---|---|
| Six views + exact poses → metric cloud, **no fit** | scorer v3.1 `--no-fit`; control: exact truth 0.998 in place, +50 cm 0.48, ×0.85 0.34 | VGGT 0.66 (floating), 0.35 (ground + sky); Apache MapAnything 0.39 (ground + sky); second house gable-standard-fence 0.68 / 0.52 / 0.37 |
| Per-view depth scale vs exact Z pass | median predicted/true depth per view, spread across views | VGGT agrees to 1 % floating, 5–10 % with a ground in frame; MapAnything's metres are 0.17×–1.2× |
| Pose heads vs depth heads | camera-centre RMS after a similarity fit to the known centres | 0.4–1.7 m on a 17 m orbit, 11 m for VGGT with a ground: poses must come from outside the model |
| Model lens profile | effective focal of the model's rays vs the intrinsics it was handed | MapAnything rays 0.79–1.07× of K per view — only its z-depth is trusted (0.87–0.95 on the 24-view shed) |
| **SfM poses instead of exact poses** (Arm G, tests 117–120) | pycolmap 4.2 on 24 textured views, scale from one measured baseline, per-view depth scales from self-consistency, scored no-fit; prediction receipt 80 named the falsifier (SfM F1 more than 0.08 below exact-pose F1) | **Held.** VGGT 0.412 exact vs 0.412 SfM; MapAnything 0.474 exact vs 0.477 SfM; consistency 3–4 cm per view; solved global scales 24.8× (VGGT) and 2.44× (MapAnything). Measured Oct 4 on spark2; result sealed as `lab50-ext` seq 85 (`sha256_81081412…`): all five predicted intervals held, falsifier not triggered |

Next steps on this axis: real photographs through the same SfM path (the camera poses are now the
only observation the metric claim rests on), and a model lens profile per model (`fx_eff_ratio`,
depth-scale bias) that the scale solver can take as a prior.

## 4. Spatial reasoning (VQA) — offline-clean sets only

| Benchmark | What it scores | Status | What Timmy still needs |
|---|---|---|---|
| **VSI-Bench** | Visual-spatial intelligence from video (counting, distance, order) | proposed | A local VLM lane with receipts per answer; answers compared offline, nothing uploaded |
| **MMSI-Bench** | Multi-image spatial reasoning | proposed | Same lane, multi-image prompts |
| **CV-Bench** | 2D/3D vision primitives (count, depth order, relative distance) | proposed | Cheapest to start with: one image per question |
| **SITE** | Spatial intelligence across modalities | proposed | Same lane |
| **3DSRBench** | 3D spatial reasoning on real photos with occlusion | proposed | Same lane; the one to report once the metric arm works on real photos |

Rule from AGENTS.md §9: validation/test geometry and answers are never used to generate or
repair training scenes, and episode processes never read verifier answers.

## 5. What "working towards" means here

1. **One adapter, many suites.** Terminal-Bench, Harbor and SWE-bench-Live all take a
   container-shaped agent; one `timmy bench <suite> <task>` lane that seals a chain per task
   covers three leaderboards.
2. **Publish scores with chains, not screenshots.** A score without its receipt chain is a
   claim; the dashboard already links each number to a hash.
3. **Metric before pretty.** The multi-view axis is the only one where a number can be
   *measured* rather than *fitted*; it is the axis to lead with in launch content.
4. **Keep the controls.** Every arm seals its prediction first, keeps a negative control, and
   reports the falsifier; a benchmark run without those is a demo.
