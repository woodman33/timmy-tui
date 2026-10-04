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
| `at_grid_edge` | a scale on the edge of the search grid means the answer is not trusted (exit 2) |

Pure numpy + scipy; no model, no truth, no network. Without them the lane prints `{status: not_configured}` and exits 3 (`--help` always works). Measured: solved scales within 1.5 % of exact
Blender Z-pass scales for VGGT on six views of a house; the self-test recovers scales of 0.5–1.5
within 0.1 %. A claim made with this tool is "metric, self-consistent to N cm", never "measured":
per DOCTRINE §15, computed geometry does not establish a physical object's dimensions without an
identified observation and calibration — the camera poses are that observation, and their error
budget is the claim's error budget.
