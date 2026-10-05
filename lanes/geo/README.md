# geo lane — metric scale from self-consistency

`scale_solver.py` turns a set of per-view depth clouds with **known camera poses in metres** into
a single metric cloud by solving one depth scale per view from nothing but cross-view agreement.
It exists because every multi-view depth model we measured (VGGT, MapAnything, Depth Anything 3)
gets each view's depth *shape* right to 0.7–3 % but its *scale* wrong by anywhere from 0.17× to 24×
(Lab50 arms D–F, chain `lab50-ext`, Oct 4 2026). With the poses pinned by a rig, a robot, or SfM
plus one measured baseline, the scales are observable: scale every view's cloud about its own
camera until it lands on the other views' clouds. The known baseline makes the result absolute.

```
python3 lanes/geo/scale_solver.py --selftest                       # synthetic box, 6 corrupted views → scales within 2 %
python3 lanes/geo/scale_solver.py --views views.json --out out.json # {"views": [{"ply"|"points_cam", "R", "t"}, …]}, OpenCV cameras
```

What it reports, and what each number means:

| field | meaning |
|---|---|
| `global_scale` | one scale for all views, found first over a wide log grid (0.02–60) so no view is solved against unscaled neighbours |
| `scales[k]` | the per-view scales after coordinate descent (median nearest-neighbour distance of view k to the other views) |
| `consistency_median_nn[k]` | after solving, how far view k's points sit from the others — the agreement the metric claim rests on |
| `at_grid_edge` | a scale on, at or pinned to either bound of the search grid means the answer is not trusted (exit 2); refinement never leaves `[lo, hi]`, so a scale outside the grid pins to the bound instead of walking off it |

PLY input reads only the vertex element (x y z by name, any column order, ascii or either byte order); faces, normals and colours from a mesh exporter are stepped over. Pure numpy + scipy; no model, no truth, no network. Without them the lane prints `{status: not_configured}` and exits 3 (`--help` always works). Measured: solved scales within 1.5 % of exact
Blender Z-pass scales for VGGT on six views of a house; the self-test recovers scales of 0.5–1.5
within 0.1 %. A claim made with this tool is "metric, self-consistent to N cm", never "measured":
per DOCTRINE §15, computed geometry does not establish a physical object's dimensions without an
identified observation and calibration — the camera poses are that observation, and their error
budget is the claim's error budget.

## Routes

Every geo tool has three routes to the same code: the lane script (`python3 lanes/geo/<tool>.py …`), the Timmy CLI
(`timmy geo score|bench|scale --key value …`, receipted through `src/geo/mcp.ts`), and the MCP tools `timmy_geo_score`,
`timmy_geo_bench`, `timmy_geo_scale` on the Timmy server — a score from the terminal and a score from an agent seal the
same receipt. Exit codes are shared: 0 ok · 2 computed but not trusted / partial · 3 not_configured · 64 bad request.

## `voxel_score.py` — truth vs prediction, down to the voxel

The bench scorer behind the Lab50 numbers, as a lane anyone can run: a truth shape and a predicted shape
in the **same metric frame**, scored three ways in one receipt.

```
python3 lanes/geo/voxel_score.py --selftest                                   # controls: in place ≈1, +0.5 m and ×0.85 drop clearly
python3 lanes/geo/voxel_score.py --truth house.obj --pred recon.ply --voxel 0.25 --tau 0.10 --out score.json
python3 lanes/geo/voxel_score.py --truth t.ply --pred p.ply --normalize --voxel 0.02 --tau 0.05   # unit-cube protocol of the papers
```

| block | what it measures | notes |
|---|---|---|
| `voxel.f1 / precision / recall / iou` | occupied voxels of truth vs prediction on one grid (edge `--voxel`, metres) | grid anchored half a voxel off the truth's bounding-box minimum so CAD-round surfaces sit at voxel centres; headline numbers carry a 5 % sub-voxel tolerance, `voxel.strict` is ε = 0 |
| `voxel.f1_band` / `grid_sensitivity` | F1 over all 8 grid phases (0/½ voxel per axis; `--phases 2` for the diagonal pair) as `[min, max]`, and the band width | voxel occupancy is discontinuous at grid planes — a surface on one flips rows under a millimetre of motion (measured: 0.97 → 0.68 for 2 mm). The band turns that knife edge into visible uncertainty: publish F1 as a band, call overlapping bands a tie; width over 0.1 → `grid_unstable`, do not rank on that pair |
| `surface.fscore` | F-score@τ (Tatarchenko et al. 2019): precision = predicted points within τ of truth, recall = truth points within τ of prediction | continuous, no grid edge; the number most 3D-generation papers report |
| `surface.chamfer_mean_dist` | mean nearest-neighbour distance both ways, averaged (metres) | its floor is the sampling density: resampling the same surface gives ≈ 2.6 cm at 60 k points on a house — the self-test reports it as `sampling_floor_chamfer` |
| `surface.chamfer_l2_sq` | sum of the two mean squared distances — the "CD" of the 3D-gen literature | compare only when sampling count and normalisation match |
| `metric` | `true` only when nothing was fitted | `--fit` is diagnostic: centroid alignment, then Open3D point-to-point ICP **with scaling, coarse to fine** (thresholds 50 % → 20 % → 5 % of the truth's longest side; a single tight threshold found no correspondences on a 15 % shrink) when Open3D is installed, else the numpy Umeyama loop; the receipt names the engine. Output says `metric:false` and the process exits 2 so a fitted number can never pass a metric gate |

Inputs: point PLY (any vertex layout), JSON `{"points": […]}`, or a mesh (OBJ/GLB/STL/PLY with faces) sampled on
its surface with trimesh when it is installed (`--samples`, seeded). Exit 0 scored · 2 fitted · 3 not_configured.

How this relates to the published protocols (docs/BENCHMARKS.md §3D): Toys4K / GSO-style evaluations normalise the
object to a unit cube, sample a fixed number of surface points and report Chamfer + F-score at a fixed τ; papers differ
on τ, point count and whether the prediction is aligned first. `--normalize` reproduces the frame, the receipt records
τ, point counts and `fit.applied`, so a Timmy number is comparable to a paper's only when those three match — and says so.

## `bench_loader.py` — public sets as truth, with a manifest

Fills the Toys4K / GSO rows of docs/BENCHMARKS.md. First set: **Google Scanned Objects** (CC-BY-4.0, 1 030 scans) via
its WebDataset packaging on the Hugging Face Hub (`suvadityamuk/google-scanned-objects`; `--smoke` = 5 objects, 90 MB).
Each object ships the original scan **in metres** (`model.obj`) and a GLB normalised to unit max extent with the applied
scale recorded, so every object has two truth frames: `metric` (the scorer's metric claim on real objects, not only CAD
houses) and `unit` (the papers' frame). Five rendered thumbnails per object are the single-view inputs for image-to-3D.

```
python3 lanes/geo/bench_loader.py fetch   --set gso --smoke --out bench/gso          # one shard to a .part file, size-verified against Content-Length, then sha256; > 2 GB needs --yes-big
python3 lanes/geo/bench_loader.py extract --tar bench/gso/shards/gso-train-00000.tar --out bench/gso
python3 lanes/geo/bench_loader.py predict --bench bench/gso --model trellis2 --expect-f1 0.60 --frame unit --basis "lab50 chain, house bench"
python3 lanes/geo/bench_loader.py score   --bench bench/gso --pred-dir out/trellis2 --frame unit --normalize-each --fit --voxel 0.02 --tau 0.01
```

`predict` seals the expected median voxel F1 / F-score for a model *before* anything is scored (`scores/prediction.json`,
hashed, with the falsifier spelled out: median F1 more than `--tolerance-f1` below the expectation means the model profile
is wrong, not the bench); `score` then grades it into the summary (`as_predicted`, `falsified`, `gap`). That is the Timmy
formula applied to a benchmark run: the claim exists before the evidence, and the evidence grades the claim.

### Bench Cards

`card` turns a scored run into one self-contained HTML page (`scores/<run>/card.html`) plus the data it shows
(`card.json`): the model, the sealed prediction and its verdict (AS PREDICTED / FALSIFIED / NOT GRADED / NO PREDICTION),
median voxel F1 with its 8-phase band, F-score@τ and Chamfer, every object's numbers, the settings, the dataset
attribution, and three hashes — the card's own data, the summary it was built from, and the source tar. Nothing on the
page loads from anywhere, every string is escaped, and anyone can recompute the card hash from `card.json`. With two or
more runs on one bench, `scores/index.html` lists them by median voxel F1 (overlapping bands are a tie). Give each model
its own `--run NAME` on `predict`, `score` and `card` so results never overwrite each other. A run name is a plain slug
(letters, digits, `.`, `-`, `_`) that never ends in `.json` or `.html`, so it cannot collide with the files the default run
(no `--run`) keeps in `scores/` itself; the index lists that default run too.

```
python3 lanes/geo/bench_loader.py predict --bench bench/gso --run trellis2 --model "TRELLIS.2" --expect-f1 0.60 --frame unit
python3 lanes/geo/bench_loader.py score   --bench bench/gso --run trellis2 --pred-dir out/trellis2 --frame unit --fit-global
python3 lanes/geo/bench_loader.py card    --bench bench/gso --run trellis2
```

### Scoring generator outputs

An image-to-3D generator hands back a shape in its own frame: its own up axis, its own yaw relative to the photo, its own
scale. The plain `--fit` starts its scaled ICP from the identity, so a quarter turn defeats it (measured on a turned,
rescaled L shape: voxel F1 below 0.5 with `--fit`, 1.0 with `--fit-global`). `--fit-global` first centres the prediction,
matches its RMS radius to the truth's, scores 384 start rotations (the 24 axis-aligned ones, each followed by turns of
15°–75° about each truth axis) by symmetric Chamfer on 2 000-point subsets, refines the four best distinct starts with
the same scaled ICP and keeps the lowest final Chamfer. When two poses more than 30° apart end within 5 % of each other the
shape is near-symmetric and the record says `rotation_ambiguous` — the score is still the best pose's. Both fits mark the
result `metric: false`: a shape score.

A **3D Gaussian splat** (a `.ply` whose vertices carry `opacity` and `scale_*`, the 3DGS / SuperSplat layout with opacity
as a logit) has no surface to sample: it is read as the centres of the Gaussians at least `--splat-min-opacity` opaque
(default 0.1), so near-transparent floaters do not count as surface. Every record says how its prediction was read
(`splat-centers opacity>=0.1 (kept of total)`, `mesh-surface-N`, `ply-vertices`), the summary lists the kinds, and the
Bench Card prints them next to the fit mode.

`extract` writes `objects/<id>/{truth_metric.ply, truth_unit.glb, view_0..4.jpg, meta.json}` and merges into `manifest.json` — shards accumulate under one `--out` (same set, sample count and seed, else refused), re-extracting a shard replaces its objects — the manifest
(licence, attribution, tar sha256, per-object extents in metres, mesh hashes, sample count and seed). `score` takes
`PRED/<id>.(ply|glb|obj|json)`, runs `voxel_score.py` per object and writes `scores/summary.json` with medians and the
list of objects that had no prediction — missing is reported, never dropped. A generation model's output has its own
scale and pose, so it is scored with `--normalize-each --fit` and both the summary and every per-object record say `metric:false`; a geometry pipeline
with known poses is scored in the metric frame with neither, and keeps `metric:true`.

Measured on the smoke shard (Oct 4 2026): the recorded `applied_translation`/`applied_scale` map the metric OBJ sample
onto the shipped GLB exactly (Chamfer 0.000, F1 1.0 on all five), and scoring each object against its neighbour gives
voxel F1 0.03–0.20 — the loader's frames are consistent and the scorer separates right object from wrong object on real
scans. Loader attribution for anything published: *Google Scanned Objects, © 2020 Google LLC, CC-BY-4.0*.
