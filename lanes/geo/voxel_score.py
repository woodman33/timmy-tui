#!/usr/bin/env python3
"""Voxel bench scorer (Timmy geo lane): truth vs prediction, down to the voxel, with no fitting by default.

Scores a reconstructed or generated shape against a truth shape in the SAME metric frame:
  voxel occupancy  precision / recall / F1 / IoU on a grid anchored to the truth (voxel size in metres)
  surface          Chamfer distance (mean nearest-neighbour distance both ways, and the squared-L2 form papers call CD)
                   and F-score@τ (Tatarchenko et al. 2019): precision = predicted points within τ of truth,
                   recall = truth points within τ of the prediction, F = harmonic mean

Doctrine (DOCTRINE §15): the score is metric only if nothing was fitted. `--fit` applies a similarity (Umeyama)
from prediction to truth for diagnosis; the output then says metric:false and the process exits 2 so a fitted number
can never pass a gate that expects a metric one. `--normalize` rescales both shapes so the truth's longest bounding
box side is 1 (the unit-cube protocol used by most 3D-generation papers); τ is then unitless and the receipt says so.

Inputs: point PLY (ascii/binary, any vertex layout), JSON {"points": [[x,y,z],…]}, or a mesh (OBJ/GLB/STL/PLY with
faces) sampled uniformly on its surface when trimesh is installed. Controls (`--selftest`): a synthetic house scored
against itself in place (≈1), shifted +0.5 m, and scaled ×0.85 about its centroid — the shifted and scaled copies
must score clearly lower, which is what makes the scorer a scorer.

  python3 voxel_score.py --truth truth.ply --pred pred.ply [--voxel 0.25] [--tau 0.10] [--samples 200000] [--out s.json]
  python3 voxel_score.py --selftest
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import numpy as np
    from scipy.spatial import cKDTree
except ImportError:                      # --help must work on a bare interpreter; scoring needs both (see require_numeric)
    np = None
    cKDTree = None

HERE = Path(__file__).resolve().parent


def require_numeric() -> None:
    """Honesty clause: without numpy + scipy the lane reports not_configured (exit 3) instead of a traceback."""
    if np is None or cKDTree is None:
        print(json.dumps({"ok": False, "status": "not_configured", "note": "voxel_score needs numpy and scipy: pip install numpy scipy"}))
        sys.exit(3)


# ---------------------------------------------------------------- loading

def load_points(path: Path, samples: int, seed: int) -> tuple[np.ndarray, str]:
    """Points from a PLY / JSON / mesh file; returns (N,3) float64 and how they were obtained."""
    suf = path.suffix.lower()
    if suf == ".json":
        j = json.loads(path.read_text())
        pts = np.asarray(j["points"] if isinstance(j, dict) else j, dtype=np.float64).reshape(-1, 3)
        return pts, "json"
    if suf == ".ply":
        head = path.read_bytes()[:4096].decode("ascii", "replace")
        if "element face" not in head or " 0\n" in head.split("element face")[1][:4]:
            sys.path.insert(0, str(HERE))
            from scale_solver import read_ply_xyz   # noqa: E402  (sibling lane module; vertex-only reader)
            return read_ply_xyz(path), "ply-vertices"
    try:
        import trimesh  # optional: meshes are sampled on their surface
    except ImportError:
        raise SystemExit(json.dumps({"ok": False, "status": "not_configured", "note": f"{path.name} is a mesh; pip install trimesh to sample it"}))
    m = trimesh.load(path, force="mesh")
    if getattr(m, "faces", None) is None or len(m.faces) == 0:
        return np.asarray(m.vertices, dtype=np.float64), "mesh-vertices"
    pts, _ = trimesh.sample.sample_surface(m, samples, seed=seed)
    return np.asarray(pts, dtype=np.float64), f"mesh-surface-{samples}"


# ---------------------------------------------------------------- metrics

def _keys(pts: np.ndarray, origin: np.ndarray, voxel: float, eps: float) -> np.ndarray:
    """Sorted unique integer voxel keys for pts; with eps > 0 a point within eps of a grid plane also keys the voxel on the
    other side (27 offsets), so a millimetre of jitter across a plane cannot drop a match."""
    rel = (pts - origin) / voxel
    offs = np.array([0.0]) if eps <= 0 else np.array([-eps, 0.0, eps]) / voxel
    g = np.stack(np.meshgrid(offs, offs, offs, indexing="ij"), -1).reshape(-1, 3)      # 1 or 27 offsets in voxel units
    idx = np.floor(rel[:, None, :] + g[None, :, :]).astype(np.int64).reshape(-1, 3) + (1 << 19)   # non-negative
    return np.unique(idx[:, 0] * (1 << 40) + idx[:, 1] * (1 << 20) + idx[:, 2])


def _prf(T: np.ndarray, P: np.ndarray, T_tol: np.ndarray, P_tol: np.ndarray) -> dict:
    hit_p = np.isin(P, T_tol).sum(); hit_t = np.isin(T, P_tol).sum()
    prec = hit_p / len(P) if len(P) else 0.0; rec = hit_t / len(T) if len(T) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"precision": round(float(prec), 4), "recall": round(float(rec), 4), "f1": round(float(f1), 4)}


def voxel_occupancy(truth: np.ndarray, pred: np.ndarray, voxel: float, tol: float = 0.05, phases: int = 8) -> dict:
    """Occupied-voxel sets on a grid anchored half a voxel off the truth's floored bounding-box minimum, so truth surfaces
    on round coordinates (CAD walls, synthetic boxes) sit at voxel CENTRES rather than on grid planes. Voxel occupancy is
    discontinuous at grid planes: a surface lying on one flips to the neighbouring row under a millimetre of motion
    (measured here: F1 0.97 → 0.68 for |t| = 2 mm on the synthetic house). The headline precision/recall/F1 therefore
    carry a sub-voxel tolerance of tol × voxel (5 %: 12.5 mm at 0.25 m) — a point within that of a plane counts for both
    sides; the strict ε = 0 numbers are kept alongside. The same tolerant F1 is then scored on the shifted grids — all 8
    phases (0 / ½ voxel on each axis) by default, or the 2 diagonal ones — and the spread across phases is f1_band and
    grid_sensitivity (flagged over 0.1): a pair whose score depends on where the grid lines fall is not one to rank on,
    and two models whose bands overlap are a tie. F-score@τ has no such edge."""
    from itertools import product
    base = np.floor(truth.min(0) / voxel) * voxel - voxel / 2
    eps = tol * voxel
    offsets = [np.zeros(3), np.full(3, 0.5)] if phases == 2 else [np.array(o) for o in product((0.0, 0.5), repeat=3)]
    out = []
    for ph in offsets:
        origin = base + ph * voxel
        T, P = _keys(truth, origin, voxel, 0.0), _keys(pred, origin, voxel, 0.0)
        strict = _prf(T, P, T, P)
        tolerant = _prf(T, P, _keys(truth, origin, voxel, eps), _keys(pred, origin, voxel, eps))
        both = len(np.intersect1d(T, P, assume_unique=True))
        iou = both / len(np.union1d(T, P)) if len(T) or len(P) else 0.0
        out.append({**tolerant, "iou": round(float(iou), 4), "strict": strict, "n_truth_vox": int(len(T)), "n_pred_vox": int(len(P)), "n_both": int(both), "phase": [float(x) for x in ph]})
    main = out[0]                                                            # phase (0,0,0): truth surfaces at voxel centres
    f1s = [o["f1"] for o in out]
    band = [round(min(f1s), 4), round(max(f1s), 4)]
    sens = round(band[1] - band[0], 4)
    return {"voxel_m": voxel, "tolerance_m": round(eps, 5), **{k: main[k] for k in ("precision", "recall", "f1", "iou", "strict", "n_truth_vox", "n_pred_vox", "n_both")},
            "phases": len(out), "f1_phases": f1s, "f1_band": band, "phase_half": {k: out[-1][k] for k in ("precision", "recall", "f1", "iou")},
            "grid_sensitivity": sens, "grid_unstable": sens > 0.1, "origin": [round(float(x), 4) for x in base]}


def surface_metrics(truth: np.ndarray, pred: np.ndarray, tau: float) -> dict:
    d_pt = cKDTree(truth).query(pred, k=1)[0]      # each predicted point → nearest truth point
    d_tp = cKDTree(pred).query(truth, k=1)[0]      # each truth point → nearest predicted point
    prec = float(np.mean(d_pt <= tau)); rec = float(np.mean(d_tp <= tau))
    f = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"chamfer_mean_dist": round(float(0.5 * (d_pt.mean() + d_tp.mean())), 6),          # metres (or unit-cube units)
            "chamfer_l2_sq": round(float((d_pt ** 2).mean() + (d_tp ** 2).mean()), 8),          # the "CD" of most 3D-gen papers
            "pred_to_truth_p95": round(float(np.percentile(d_pt, 95)), 5), "truth_to_pred_p95": round(float(np.percentile(d_tp, 95)), 5),
            "fscore": {"tau": tau, "precision": round(prec, 4), "recall": round(rec, 4), "f": round(f, 4)}}


def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Similarity s, R, t with dst ≈ s R src + t (least squares; Umeyama 1991). Diagnostic only — breaks the metric claim."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    S, D = src - mu_s, dst - mu_d
    U, sig, Vt = np.linalg.svd(D.T @ S / len(src))
    d = np.ones(3); d[-1] = np.sign(np.linalg.det(U @ Vt)) or 1.0
    R = U @ np.diag(d) @ Vt
    s = float((sig * d).sum() / (S ** 2).sum() * len(src))
    return s, R, mu_d - s * R @ mu_s


def fit_pred_to_truth(truth: np.ndarray, pred: np.ndarray, iters: int = 10) -> tuple[np.ndarray, dict]:
    """Centroid alignment, then nearest-neighbour correspondences + Umeyama, iterated (a small ICP with scale)."""
    cur = pred - pred.mean(0) + truth.mean(0); total_s = 1.0; done = 0
    tree = cKDTree(truth)
    for done in range(1, iters + 1):
        idx = tree.query(cur, k=1)[1]
        s, R, t = umeyama(cur, truth[idx])
        cur = (s * (R @ cur.T)).T + t
        total_s *= s
        if abs(s - 1) < 1e-4 and np.linalg.norm(t) < 1e-3 and abs(np.trace(R) - 3) < 1e-6:
            break
    return cur, {"applied": True, "iterations": done, "scale_applied": round(total_s, 5), "centroid_shift": round(float(np.linalg.norm(cur.mean(0) - pred.mean(0))), 5)}


def score(truth: np.ndarray, pred: np.ndarray, voxel: float, tau: float, fit: bool = False, normalize: bool = False, tol: float = 0.05, phases: int = 8) -> dict:
    note = []
    unit = "m"
    if normalize:
        lo, hi = truth.min(0), truth.max(0)
        c, side = (lo + hi) / 2, float((hi - lo).max())
        truth = (truth - c) / side; pred = (pred - c) / side
        unit = "unit-cube"; note.append("both shapes scaled by the truth's longest bounding-box side; voxel and tau are unit-cube fractions")
    fitinfo = {"applied": False}
    if fit:
        pred, fitinfo = fit_pred_to_truth(truth, pred)
        note.append("prediction fitted to truth (similarity); the result is a shape score, not a metric one")
    return {"kind": "geo.voxel-score", "metric": not fit, "unit": unit, "fit": fitinfo, "voxel": voxel_occupancy(truth, pred, voxel, tol, phases),
            "surface": surface_metrics(truth, pred, tau), "points": {"truth": int(len(truth)), "pred": int(len(pred))}, "note": note}


# ---------------------------------------------------------------- controls

def synthetic_house(n: int = 60000, seed: int = 7) -> np.ndarray:
    """Surface points of a 6 × 7 m house: 4.5 m walls plus a gabled roof 2 m high, no floor (like a scan)."""
    rng = np.random.default_rng(seed)
    L, W, H, G = 6.0, 7.0, 4.5, 2.0
    out = []
    per = n // 7
    for _ in range(1):
        u = rng.uniform(0, 1, (per, 2))
        out.append(np.c_[u[:, 0] * L, np.zeros(per), u[:, 1] * H]); out.append(np.c_[u[:, 0] * L, np.full(per, W), u[:, 1] * H])
        out.append(np.c_[np.zeros(per), u[:, 0] * W, u[:, 1] * H]); out.append(np.c_[np.full(per, L), u[:, 0] * W, u[:, 1] * H])
        x = u[:, 0] * L; y = u[:, 1] * W
        z = H + G * (1 - np.abs(2 * x / L - 1))                 # ridge along y at x = L/2
        out.append(np.c_[x, y, z])
        g = rng.uniform(0, 1, (per, 2)); gx = g[:, 0] * L; gz = H + g[:, 1] * G * (1 - np.abs(2 * gx / L - 1))   # gable triangles
        out.append(np.c_[gx, np.zeros(per), gz]); out.append(np.c_[gx, np.full(per, W), gz])
    return np.concatenate(out)


def selftest(voxel: float, tau: float) -> tuple[dict, bool]:
    truth = synthetic_house(seed=7); pred = synthetic_house(seed=11)        # same surface, independent samples
    c = truth.mean(0)
    runs = {"in_place": pred, "shift_0p5m": pred + np.array([0.5, 0.0, 0.0]), "scale_0p85": (pred - c) * 0.85 + c}
    res = {k: score(truth, v, voxel, tau) for k, v in runs.items()}
    f1 = {k: r["voxel"]["f1"] for k, r in res.items()}; fs = {k: r["surface"]["fscore"]["f"] for k, r in res.items()}
    fitted = score(truth, runs["shift_0p5m"], voxel, tau, fit=True)
    # the controls: the same surface in place scores ≈1; moved half a metre or shrunk 15 % it must drop clearly; the diagnostic
    # fit must undo the pure shift (and must say metric:false for having done so)
    ok = (f1["in_place"] >= 0.97 and fs["in_place"] >= 0.99 and f1["shift_0p5m"] < 0.6 and fs["shift_0p5m"] < 0.7 and f1["scale_0p85"] < 0.6
          and fitted["voxel"]["f1"] >= 0.95 and fitted["metric"] is False)
    return {"selftest": "ok" if ok else "failed", "voxel_m": voxel, "tau": tau, "voxel_f1": f1, "fscore": fs,
            "voxel_f1_band": {k: r["voxel"]["f1_band"] for k, r in res.items()}, "grid_sensitivity": {k: r["voxel"]["grid_sensitivity"] for k, r in res.items()},
            "chamfer_mean_dist": {k: r["surface"]["chamfer_mean_dist"] for k, r in res.items()},
            "sampling_floor_chamfer": res["in_place"]["surface"]["chamfer_mean_dist"],      # resampling the same surface is never 0: that is the floor
            "fit_recovers_shift": {"voxel_f1": fitted["voxel"]["f1"], "metric": fitted["metric"], "scale_applied": fitted["fit"]["scale_applied"]}}, ok


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--truth", type=Path); ap.add_argument("--pred", type=Path)
    ap.add_argument("--voxel", type=float, default=0.25, help="voxel edge in metres (unit-cube fraction with --normalize)")
    ap.add_argument("--tau", type=float, default=0.10, help="F-score distance threshold, same unit as --voxel")
    ap.add_argument("--tolerance", type=float, default=0.05, help="sub-voxel tolerance as a fraction of a voxel (0 strict; 1.0 = the Lab50 generation bench's one-voxel tolerance)")
    ap.add_argument("--phases", type=int, default=8, choices=[2, 8], help="grid phases scored for the F1 band: 8 (0/½ voxel on each axis) or the 2 diagonal ones")
    ap.add_argument("--samples", type=int, default=200000, help="surface samples per mesh input")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--fit", action="store_true", help="similarity-fit the prediction first (diagnostic; metric:false, exit 2)")
    ap.add_argument("--normalize", action="store_true", help="unit-cube protocol: scale both by the truth's longest side")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    require_numeric()
    if a.selftest:
        rep, ok = selftest(a.voxel, a.tau)
        print(json.dumps(rep)); return 0 if ok else 1
    if not (a.truth and a.pred):
        ap.error("--truth and --pred, or --selftest")
    truth, how_t = load_points(a.truth, a.samples, a.seed); pred, how_p = load_points(a.pred, a.samples, a.seed)
    out = {**score(truth, pred, a.voxel, a.tau, fit=a.fit, normalize=a.normalize, tol=a.tolerance, phases=a.phases), "inputs": {"truth": a.truth.name, "truth_from": how_t, "pred": a.pred.name, "pred_from": how_p}}
    if a.out:
        a.out.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out))
    return 2 if a.fit else 0


if __name__ == "__main__":
    sys.exit(main())
