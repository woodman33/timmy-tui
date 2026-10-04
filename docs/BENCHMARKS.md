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
| **Toys4K** | 4,000 toy-scale meshes; the comparability set most papers quote | proposed | A loader that turns each mesh into the lab's IR truth (parts optional) and renders one view; the scorer already takes any mesh as truth |
| **GSO (Google Scanned Objects)** | 1,030 scanned household objects, CC-BY | proposed | Same loader; GSO is the set to publish on because the licence allows the renders to ship |
| **HY3D-Bench (test split)** | Watertight 512³ truth, the Hunyuan3D house set | proposed | Voxel-grid truth is a direct fit for the scorer; licence is test-only, numbers only |
| **SA-3DAO** | The only set with a published vIoU protocol | proposed | Match their voxel size and tolerance before comparing a number |
| **3D Arena / top3d.ai** | Human preference rankings | n/a | Preference is not geometry; cite for context only |

Lab50 result to beat (Oct 3, 2026, chain `lab50`): Pixal3D 0.80 voxel F1, Hunyuan3D 2.1
0.77, TRELLIS.2 0.60, TripoSplat 0.59, Depth Anything 3 single view 0.10 (5 cm voxels,
1-voxel tolerance, upright fit, one house family).

## 3. Multi-view and metric geometry (the part that can be *measured*)

| Claim | How it is tested | Receipted so far (chain `lab50-ext`, Oct 4, 2026) |
|---|---|---|
| Six views + exact poses → metric cloud, **no fit** | scorer v3.1 `--no-fit`; control: exact truth 0.998 in place, +50 cm 0.48, ×0.85 0.34 | VGGT 0.66 (floating), 0.35 (ground + sky); Apache MapAnything 0.39 (ground + sky); second house gable-standard-fence 0.68 / 0.52 / 0.37 |
| Per-view depth scale vs exact Z pass | median predicted/true depth per view, spread across views | VGGT agrees to 1 % floating, 5–10 % with a ground in frame; MapAnything's metres are 0.17×–1.2× |
| Pose heads vs depth heads | camera-centre RMS after a similarity fit to the known centres | 0.4–1.7 m on a 17 m orbit, 11 m for VGGT with a ground: poses must come from outside the model |
| Model lens profile | effective focal of the model's rays vs the intrinsics it was handed | MapAnything rays 0.79–1.07× of K per view — only its z-depth is trusted |

Next steps on this axis: SfM (pycolmap 4.2, CUDA) poses instead of exact poses, one measured
baseline for scale, then real photographs.

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
