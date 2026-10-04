#!/usr/bin/env python3
"""Metric scale from self-consistency (Timmy geo lane).

Multi-view depth models (VGGT, MapAnything, Depth Anything 3) give each view a good depth *shape* but an unknown or
wrong depth *scale*. When the camera poses are known in metres (a rig, a robot, SfM pinned by one measured baseline),
the six scales are the only unknowns, and they are observable from nothing but the geometry agreeing with itself:
scale every view's cloud about its own camera so that it lands on the other views' clouds. No model is trusted, no
truth is consulted, and the known baseline makes the answer absolute, not relative.

Input (JSON): {"views": [{"points_cam": [[x,y,z],…] | "ply": path, "R": 3x3, "t": [3]} …]} with OpenCV cameras
(X_cam = R X_world + t, +z forward). Output: per-view scales, the global scale found first, the per-view median
nearest-neighbour distance to the other views after solving (the consistency the claim rests on), and whether any
scale sat on the search-grid edge (which means: do not trust it).

  python3 scale_solver.py --views views.json --out out.json [--rounds 3] [--sub 8000] [--lo 0.02] [--hi 60]
  python3 scale_solver.py --selftest            # synthetic scene, corrupted scales, must recover them within 2%

Pure numpy + scipy. Measured in the Lab50 bench (chain lab50-ext, Oct 4 2026): solved scales within 1.5% of the
exact Blender Z-pass scales for VGGT on six views, which is where this file comes from.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree


def to_world(pts_cam: np.ndarray, R: np.ndarray, t: np.ndarray, s: float = 1.0) -> np.ndarray:
    """OpenCV camera-frame points scaled by s about the camera centre, placed by the known pose: X_w = R^T (s p - t)."""
    return (s * pts_cam.reshape(-1, 3) - t) @ R


def solve_view_scales(view_pts: list[np.ndarray], Rs: list[np.ndarray], ts: list[np.ndarray], rounds: int = 3, sub: int = 8000,
                      seed: int = 7, lo: float = 0.02, hi: float = 60.0) -> dict:
    rng = np.random.default_rng(seed)
    pts = [np.asarray(p, dtype=np.float64).reshape(-1, 3) for p in view_pts]
    pts = [p[rng.choice(len(p), min(sub, len(p)), replace=False)] if len(p) > sub else p for p in pts]
    n = len(pts)
    if n < 2 or any(len(p) < 50 for p in pts):
        raise ValueError("need at least two views with 50+ points each")
    history = []
    coarse = np.exp(np.linspace(np.log(lo), np.log(hi), 121))
    small = [p[: min(len(p), 2500)] for p in pts]                     # stage 0 runs on a thinner sample: it only has to find the basin

    def world(k, s, src=pts):
        return to_world(src[k], Rs[k], ts[k], s)

    # stage 0: one global scale for all views, so no view is ever solved against unscaled neighbours (a local minimum)
    def global_cost(sv):
        w = [world(k, sv, small) for k in range(n)]
        tot = []
        for k in range(n):
            tree = cKDTree(np.concatenate([w[j] for j in range(n) if j != k]))
            tot.append(float(np.median(tree.query(w[k], k=1)[0])))
        return float(np.mean(tot))
    gcost = [global_cost(sv) for sv in coarse]
    s0 = float(coarse[int(np.argmin(gcost))])
    fine0 = s0 * np.exp(np.linspace(-0.04, 0.04, 41))
    g2 = [global_cost(sv) for sv in fine0]
    s0 = float(fine0[int(np.argmin(g2))])
    scales = np.full(n, s0)
    history.append({"round": -1, "view": "all", "scale": round(s0, 5), "median_nn": round(min(g2), 5)})
    # stages 1..rounds: per-view refinement, coordinate descent, median nearest-neighbour distance to the other views
    for r in range(rounds):
        for k in range(n):
            tree = cKDTree(np.concatenate([world(j, scales[j]) for j in range(n) if j != k]))

            def cost(sv):
                return float(np.median(tree.query(world(k, sv), k=1)[0]))
            grid = scales[k] * np.exp(np.linspace(-0.4, 0.4, 121)) if r == 0 else scales[k] * np.exp(np.linspace(-0.25, 0.25, 101))
            c = [cost(sv) for sv in grid]
            scales[k] = float(grid[int(np.argmin(c))])
            fine = scales[k] * np.exp(np.linspace(-0.03, 0.03, 31))
            c2 = [cost(sv) for sv in fine]
            scales[k] = float(fine[int(np.argmin(c2))])
            history.append({"round": r, "view": k, "scale": round(scales[k], 5), "median_nn": round(min(c2), 5)})
    allw = [world(k, scales[k]) for k in range(n)]
    resid = []
    for k in range(n):
        tree = cKDTree(np.concatenate([allw[j] for j in range(n) if j != k]))
        resid.append(float(np.median(tree.query(allw[k], k=1)[0])))
    edge = bool(any(abs(np.log(x / lo)) < 0.02 or abs(np.log(x / hi)) < 0.02 for x in scales))
    return {"scales": [round(float(x), 5) for x in scales], "global_scale": round(s0, 5), "consistency_median_nn": [round(x, 5) for x in resid],
            "rounds": rounds, "grid": [lo, hi], "at_grid_edge": edge, "views": n, "points_used": [int(len(p)) for p in pts], "history": history}


def read_ply_xyz(path: Path) -> np.ndarray:
    """Minimal binary/ascii PLY reader for x y z (the lab's own writer and most exporters)."""
    data = path.read_bytes()
    head_end = data.index(b"end_header\n") + len(b"end_header\n")
    header = data[:head_end].decode("ascii", "replace").split("\n")
    n = int(next(l for l in header if l.startswith("element vertex")).split()[-1])
    fmt = next(l for l in header if l.startswith("format")).split()[1]
    props = [l.split()[1:] for l in header if l.startswith("property ")]
    if fmt == "ascii":
        rows = np.loadtxt(path.open("rb"), skiprows=len(header) - 1, max_rows=n)
        return rows[:, :3].astype(np.float64)
    typemap = {"float": "f4", "float32": "f4", "double": "f8", "float64": "f8", "uchar": "u1", "uint8": "u1", "int": "i4", "int32": "i4", "uint": "u4", "ushort": "u2", "short": "i2", "char": "i1"}
    order = "<" if fmt == "binary_little_endian" else ">"
    dt = np.dtype([(name, order + typemap[t]) for t, name in props])
    arr = np.frombuffer(data, dtype=dt, count=n, offset=head_end)
    return np.stack([arr["x"], arr["y"], arr["z"]], 1).astype(np.float64)


def load_views(spec: dict, base: Path) -> tuple[list[np.ndarray], list[np.ndarray], list[np.ndarray]]:
    pts, Rs, ts = [], [], []
    for v in spec["views"]:
        if "points_cam" in v:
            p = np.asarray(v["points_cam"], dtype=np.float64)
        elif "ply" in v:
            p = read_ply_xyz((base / v["ply"]) if not Path(v["ply"]).is_absolute() else Path(v["ply"]))
        else:
            raise ValueError("each view needs points_cam or ply")
        pts.append(p); Rs.append(np.asarray(v["R"], dtype=np.float64)); ts.append(np.asarray(v["t"], dtype=np.float64))
    return pts, Rs, ts


def synthetic(seed: int = 3, n_views: int = 6, noise: float = 0.01):
    """A 6 x 7 x 4.5 m box surface seen from n cameras on a 17 m orbit, each view's depth corrupted by its own scale."""
    rng = np.random.default_rng(seed)
    # surface samples of a box (walls + roof), world frame, z up
    L, W, H = 6.0, 7.0, 4.5
    faces = []
    for _ in range(4000): faces.append([rng.uniform(0, L), 0, rng.uniform(0, H)]); faces.append([rng.uniform(0, L), W, rng.uniform(0, H)])
    for _ in range(4000): faces.append([0, rng.uniform(0, W), rng.uniform(0, H)]); faces.append([L, rng.uniform(0, W), rng.uniform(0, H)])
    for _ in range(6000): faces.append([rng.uniform(0, L), rng.uniform(0, W), H])
    X = np.array(faces)
    centre = np.array([L / 2, W / 2, H / 2]); d, elev = 17.0, np.radians(30)
    views, truth = [], []
    for k in range(n_views):
        az = 2 * np.pi * k / n_views
        E = centre + d * np.array([np.cos(elev) * np.cos(az), np.cos(elev) * np.sin(az), np.sin(elev)])
        f = (centre - E); f /= np.linalg.norm(f); r = np.cross(f, [0, 0, 1]); r /= np.linalg.norm(r); u = np.cross(r, f)
        R = np.stack([r, -u, f]); t = -R @ E                                 # OpenCV: x right, y down, z forward
        cam = (R @ X.T).T + t
        # visibility: keep points whose outward face normal faces the camera (crude: nearest half of the box by depth per face)
        vis = cam[:, 2] < np.median(cam[:, 2]) + 1.0
        s_true = float(np.exp(rng.uniform(-0.9, 0.9)))                       # the model's unknown per-view scale
        p = cam[vis] / s_true + rng.normal(0, noise, (int(vis.sum()), 3))     # model output: shape right, scale wrong
        views.append((p, R, t)); truth.append(s_true)
    return views, truth


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--views", type=Path, help="JSON: {views: [{points_cam | ply, R, t}, …]}")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--sub", type=int, default=8000)
    ap.add_argument("--lo", type=float, default=0.02)
    ap.add_argument("--hi", type=float, default=60.0)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        views, truth = synthetic()
        res = solve_view_scales([v[0] for v in views], [v[1] for v in views], [v[2] for v in views], rounds=a.rounds, sub=a.sub, lo=a.lo, hi=a.hi)
        err = [abs(s / t - 1) * 100 for s, t in zip(res["scales"], truth)]
        ok = max(err) < 2.0 and not res["at_grid_edge"]
        print(json.dumps({"selftest": "ok" if ok else "failed", "true_scales": [round(t, 4) for t in truth], "solved": res["scales"], "err_pct": [round(e, 3) for e in err], "consistency": res["consistency_median_nn"], "at_grid_edge": res["at_grid_edge"]}))
        return 0 if ok else 1
    if not a.views:
        ap.error("--views or --selftest")
    spec = json.loads(a.views.read_text())
    pts, Rs, ts = load_views(spec, a.views.parent)
    res = solve_view_scales(pts, Rs, ts, rounds=a.rounds, sub=a.sub, lo=a.lo, hi=a.hi)
    out = {"kind": "geo.scale-solve", "input": str(a.views.name), **res}
    if a.out:
        a.out.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: v for k, v in out.items() if k != "history"}))
    return 2 if res["at_grid_edge"] else 0


if __name__ == "__main__":
    sys.exit(main())
