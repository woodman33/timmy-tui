#!/usr/bin/env python3
"""FiftyOne scoreboard for a bench (Timmy geo lane): every scored run's compared points as 3D samples.

`bench_loader.py score --save-compared N` keeps, per object, the truth and the prediction exactly as they were scored
(after any fit). This turns them into a FiftyOne dataset: one sample per (object, run), each a .fo3d scene holding the
truth (grey) and that run's prediction (its own colour) in the same frame — nothing re-centred — with the run's numbers
as fields (voxel_f1, fscore, chamfer, pred_from, verdict). Sort by voxel_f1 in the app and open a sample to see what
the number saw.

  fo_scoreboard.py --bench BENCH [--runs a,b] [--name DATASET] [--overwrite] [--launch]

Every run counts: the named ones (scores/<run>/compared/) and the default one — `score` without --run keeps its files in
scores/ itself, so its clouds are in scores/compared/; in --runs it is written `.`. A prediction that came back empty
(a splat with no Gaussian over the opacity bar) is still a sample — the truth alone, with its F1 of 0.

Needs fiftyone (pip install fiftyone); without it the lane reports not_configured (exit 3). The point clouds are
written as .pcd next to the scenes under BENCH/scoreboard/. Exit 0 ok · 2 refused · 3 not_configured.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
COLORS = ["#3ddc84", "#4aa8ff", "#ffb020", "#ff5a52", "#c58cff", "#2ee6d6"]
DEFAULT_RUN = "."            # --runs token for the default run (score without --run): its files live in scores/ itself


def write_pcd(points, path: Path) -> int:
    """Binary PCD v0.7 with x y z float32 — the format FiftyOne's PointCloud reads."""
    import numpy as np
    p = np.ascontiguousarray(np.asarray(points, dtype=np.float32).reshape(-1, 3))
    head = ("# .PCD v0.7 - Point Cloud Data file format\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n"
            f"WIDTH {len(p)}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {len(p)}\nDATA binary\n")
    path.write_bytes(head.encode("ascii") + p.tobytes())
    return len(p)


def collect(bench: Path, runs: list[str] | None) -> list[dict]:
    """(object, run) entries that have both compared clouds, with the run's numbers; no fiftyone needed. The default run
    (scores/compared/) is found like the named ones (scores/<run>/compared/) — the Bench Card index already treats it as
    a run — and is labelled "default run"; its files are stemmed "_default", which no run name can be."""
    sys.path.insert(0, str(HERE))
    from bench_loader import run_name_ok, scores_dir   # noqa: E402  (sibling lane module: one rule for where a run's files live)
    scores = bench / "scores"
    if runs is None:                                                   # found on disk: a folder no run could have made is skipped, not fatal
        runs = ([DEFAULT_RUN] if (scores / "compared").is_dir() else []) + sorted(p.parent.name for p in scores.glob("*/compared") if run_name_ok(p.parent.name))
    out = []
    for i, run in enumerate(runs):
        is_default = run == DEFAULT_RUN
        sdir = scores_dir(bench, None if is_default else run)     # a named run is a plain slug, never a path (refused otherwise)
        if not (sdir / "summary.json").exists():
            continue
        label = "default run" if is_default else run
        sm = json.loads((sdir / "summary.json").read_text())
        cj = json.loads((sdir / "card.json").read_text()) if (sdir / "card.json").exists() else {}
        for r in sm.get("rows", []):
            t, p = sdir / "compared" / f"{r['id']}.truth.ply", sdir / "compared" / f"{r['id']}.pred.ply"
            if t.exists() and p.exists():
                out.append({"run": label, "stem": "_default" if is_default else run, "model": cj.get("model") or label, "color": COLORS[i % len(COLORS)],
                            "id": r["id"], "truth": t, "pred": p, "voxel_f1": r.get("voxel_f1"), "fscore": r.get("fscore"), "chamfer": r.get("chamfer_mean_dist"),
                            "pred_from": r.get("pred_from"), "empty_prediction": bool(r.get("empty_prediction")), "verdict": cj.get("verdict"), "metric": sm.get("metric")})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--bench", required=True, type=Path)
    ap.add_argument("--runs", help="comma-separated run names, '.' for the default run (default: every run with compared points)")
    ap.add_argument("--name", help="dataset name (default: timmy-bench-<bench folder>)")
    ap.add_argument("--overwrite", action="store_true", help="replace an existing dataset of that name")
    ap.add_argument("--launch", action="store_true", help="open the FiftyOne app on the dataset and wait")
    a = ap.parse_args(argv)
    entries = collect(a.bench, [r.strip() for r in a.runs.split(",") if r.strip()] if a.runs else None)
    if not entries:
        print(json.dumps({"ok": False, "status": "refused", "note": "no compared points under scores/compared or scores/*/compared; run bench_loader.py score --save-compared N first"}))
        return 2
    try:
        import fiftyone as fo
    except ImportError:
        print(json.dumps({"ok": False, "status": "not_configured", "note": "the scoreboard needs fiftyone: pip install fiftyone", "entries": len(entries)}))
        return 3
    sys.path.insert(0, str(HERE))
    from scale_solver import read_ply_xyz   # noqa: E402  (sibling lane module)
    name = a.name or f"timmy-bench-{a.bench.resolve().name}"
    if fo.dataset_exists(name):
        if not a.overwrite:
            print(json.dumps({"ok": False, "status": "refused", "note": f"dataset {name} exists; pass --overwrite to replace it"}))
            return 2
        fo.delete_dataset(name)
    board = a.bench / "scoreboard"; board.mkdir(exist_ok=True)
    samples = []
    for e in entries:
        stem = f"{e['stem']}__{e['id']}"
        # each run's own truth as it compared it: runs in different frames (metric / unit) or rescaled each have different
        # truths, so one shared truth cloud per object would sit wrong under every run but the first
        t_pcd, p_pcd = board / f"{stem}.truth.pcd", board / f"{stem}.pred.pcd"
        write_pcd(read_ply_xyz(e["truth"]), t_pcd)
        n_pred = write_pcd(read_ply_xyz(e["pred"]), p_pcd)
        scene = fo.Scene()
        scene.add(fo.PointCloud("truth", str(t_pcd.resolve()), material=fo.PointCloudMaterial(shading_mode="custom", custom_color="#9a9a9a", point_size=2)))
        if n_pred:                                                             # an empty prediction: the truth alone shows what was missed
            scene.add(fo.PointCloud(e["model"], str(p_pcd.resolve()), material=fo.PointCloudMaterial(shading_mode="custom", custom_color=e["color"], point_size=2)))
        fo3d = board / f"{stem}.fo3d"
        scene.write(str(fo3d.resolve()))
        samples.append(fo.Sample(filepath=str(fo3d.resolve()), object_id=e["id"], run=e["run"], model=e["model"], voxel_f1=e["voxel_f1"],
                                 fscore=e["fscore"], chamfer=e["chamfer"], pred_from=e["pred_from"], empty_prediction=e["empty_prediction"],
                                 verdict=e["verdict"], metric=e["metric"]))
    ds = fo.Dataset(name)
    ds.persistent = True
    ds.add_samples(samples)
    print(json.dumps({"ok": True, "status": "built", "dataset": name, "samples": len(samples), "runs": sorted({e["run"] for e in entries}),
                      "open": f"fiftyone app launch {name}"}))
    if a.launch:
        fo.launch_app(ds).wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
