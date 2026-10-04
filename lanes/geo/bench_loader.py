#!/usr/bin/env python3
"""Bench loader (Timmy geo lane): public 3D sets → truth the voxel scorer can take, with a manifest that makes the run checkable.

First set: Google Scanned Objects (CC-BY-4.0), as the WebDataset packaging on the Hugging Face Hub
(suvadityamuk/google-scanned-objects, 1 030 objects in 44 shards; …-smoketest = 5 objects, 1 shard, 90 MB).
Each object carries the ORIGINAL scan in metres (model.obj — a Jenga box is 0.079 × 0.084 × 0.292 m), a GLB
normalised to unit max extent with the applied scale recorded, five rendered thumbnails, and licence metadata.
That gives two truth frames per object: metric (from the OBJ) and unit-cube (the GLB, the papers' frame).

  fetch    --set gso --shard 0 [--smoke] --out BENCH      download one shard (size and sha256 recorded; >2 GB needs --yes-big)
  extract  --tar BENCH/shards/x.tar --out BENCH            objects/<id>/{truth_metric.ply, truth_unit.glb, view_0.jpg, meta.json} + manifest.json
  predict  --bench BENCH --model NAME --expect-f1 F [--expect-fscore F] [--tolerance-f1 0.08] [--frame …]
                                                           seal what the model is expected to score BEFORE scoring → scores/prediction.json
  score    --bench BENCH --pred-dir PRED [--frame metric|unit] [--fit] [--voxel V] [--tau T]
                                                           PRED/<id>.(ply|glb|obj|json) scored against the truth → scores/<id>.json + summary.json;
                                                           with a prediction on file the summary says as_predicted / falsified

Nothing here fits anything: `score --fit` passes the flag through to voxel_score.py, whose output then says metric:false.
A generation model's output has an arbitrary scale and pose, so scoring it needs --fit (a shape score); a geometry
pipeline with known poses is scored metric without it. The summary records which it was.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

SETS = {
    "gso": {"repo": "suvadityamuk/google-scanned-objects", "smoke_repo": "suvadityamuk/google-scanned-objects-smoketest",
            "shard": "data/gso-train-{n:05d}.tar", "license": "cc-by-4.0", "shards": 44, "objects": 1030,
            "attribution": "Google Scanned Objects, © 2020 Google LLC, CC-BY-4.0 (via the WebDataset packaging on the Hugging Face Hub)"},
}


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- fetch

def fetch(a) -> int:
    import urllib.request
    s = SETS[a.set]
    repo = s["smoke_repo"] if a.smoke else s["repo"]
    rel = s["shard"].format(n=a.shard)
    url = f"https://huggingface.co/datasets/{repo}/resolve/main/{rel}"
    out = Path(a.out) / "shards"; out.mkdir(parents=True, exist_ok=True)
    dst = out / Path(rel).name
    if dst.exists() and not a.force:
        print(json.dumps({"ok": True, "status": "present", "path": str(dst), "bytes": dst.stat().st_size, "sha256": sha256_file(dst), "note": "already downloaded; --force to refetch"}))
        return 0
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        size = int(r.headers.get("Content-Length") or 0)
    if size > a.max_gb * (1 << 30) and not a.yes_big:
        print(json.dumps({"ok": False, "status": "refused", "note": f"{rel} is {size / (1 << 30):.2f} GB > --max-gb {a.max_gb}; pass --yes-big with an explicit order line"}))
        return 2
    h = hashlib.sha256(); n = 0
    with urllib.request.urlopen(url, timeout=120) as r, dst.open("wb") as f:
        for chunk in iter(lambda: r.read(1 << 20), b""):
            f.write(chunk); h.update(chunk); n += len(chunk)
    rec = {"ok": True, "status": "fetched", "set": a.set, "repo": repo, "shard": rel, "url": url, "path": str(dst), "bytes": n, "sha256": h.hexdigest(), "license": s["license"]}
    (out / (dst.name + ".json")).write_text(json.dumps(rec, indent=1) + "\n")
    print(json.dumps(rec)); return 0


# ---------------------------------------------------------------- extract

def group_members(tar: tarfile.TarFile) -> dict[str, dict[str, tarfile.TarInfo]]:
    """WebDataset keys: <id>.<ext> with multi-dot exts (thumbnail_0.jpg, texture.png)."""
    groups: dict[str, dict[str, tarfile.TarInfo]] = {}
    for m in tar.getmembers():
        if not m.isfile():
            continue
        name = Path(m.name).name
        for ext in ("texture.png", "thumbnail_0.jpg", "thumbnail_1.jpg", "thumbnail_2.jpg", "thumbnail_3.jpg", "thumbnail_4.jpg", "glb", "obj", "mtl", "json"):
            if name.endswith("." + ext):
                groups.setdefault(name[: -len(ext) - 1], {})[ext] = m
                break
    return groups


def sample_mesh(mesh_bytes: bytes, ext: str, n: int, seed: int, workdir: Path, extra: dict[str, bytes] | None = None):
    import numpy as np
    import trimesh
    p = workdir / f"mesh.{ext}"
    p.write_bytes(mesh_bytes)
    for name, data in (extra or {}).items():
        (workdir / name).write_bytes(data)
    m = trimesh.load(p, force="mesh")
    pts, _ = trimesh.sample.sample_surface(m, n, seed=seed)
    return np.asarray(pts, dtype=np.float64), m


def write_ply(path: Path, pts) -> None:
    import numpy as np
    p = np.asarray(pts, dtype=np.float32)
    path.write_bytes((f"ply\nformat binary_little_endian 1.0\ncomment timmy bench truth\nelement vertex {len(p)}\nproperty float x\nproperty float y\nproperty float z\nend_header\n").encode() + p.tobytes())


def extract(a) -> int:
    try:
        import numpy as np  # noqa: F401
        import trimesh  # noqa: F401
    except ImportError:
        print(json.dumps({"ok": False, "status": "not_configured", "note": "extract needs numpy + trimesh: pip install numpy trimesh"})); return 3
    tar_path = Path(a.tar); bench = Path(a.out); objdir = bench / "objects"; objdir.mkdir(parents=True, exist_ok=True)
    tar_sha = sha256_file(tar_path)
    manifest = {"kind": "geo.bench-manifest", "set": a.set, "source": {"tar": tar_path.name, "tar_sha256": tar_sha, "tar_bytes": tar_path.stat().st_size, **{k: SETS[a.set][k] for k in ("repo", "license", "attribution")}},
                "samples_per_object": a.samples, "seed": a.seed, "objects": []}
    with tarfile.open(tar_path) as tar:
        groups = group_members(tar)
        for oid in sorted(groups):
            g = groups[oid]
            if "json" not in g or ("obj" not in g and "glb" not in g):
                manifest.setdefault("skipped", []).append({"id": oid, "why": "no metadata or no mesh"}); continue
            meta = json.loads(tar.extractfile(g["json"]).read().decode("utf8"))
            od = objdir / oid; od.mkdir(exist_ok=True)
            entry = {"id": oid, "name": meta.get("name"), "category": meta.get("category"), "license_id": meta.get("license_id"), "frames": {}}
            with tempfile.TemporaryDirectory() as td:
                tdp = Path(td)
                if "obj" in g:                                                 # metric truth: the original scan in metres
                    extra = {}
                    if "mtl" in g: extra["mesh.mtl"] = tar.extractfile(g["mtl"]).read()
                    obj_bytes = tar.extractfile(g["obj"]).read()
                    pts, m = sample_mesh(obj_bytes, "obj", a.samples, a.seed, tdp, extra)
                    write_ply(od / "truth_metric.ply", pts)
                    entry["frames"]["metric"] = {"file": "truth_metric.ply", "unit": "m", "from": "model.obj", "obj_sha256": hashlib.sha256(obj_bytes).hexdigest(),
                                                 "extents_m": [round(float(x), 5) for x in m.extents], "bbox_min_m": [round(float(x), 5) for x in m.bounds[0]],
                                                 "surface_area_m2": round(float(m.area), 6), "vertices": int(len(m.vertices)), "faces": int(len(m.faces)), "points": int(len(pts))}
                if "glb" in g:                                                 # unit-cube truth: the packaging's normalised GLB, as shipped
                    glb_bytes = tar.extractfile(g["glb"]).read()
                    (od / "truth_unit.glb").write_bytes(glb_bytes)
                    gp = meta.get("glb_processing", {})
                    entry["frames"]["unit"] = {"file": "truth_unit.glb", "unit": "max-extent-1", "glb_sha256": hashlib.sha256(glb_bytes).hexdigest(),
                                               "normalization": gp.get("normalization"), "applied_scale": gp.get("applied_scale"), "applied_translation": gp.get("applied_translation"), "final_extents": gp.get("final_extents")}
            for k in range(5):
                key = f"thumbnail_{k}.jpg"
                if key in g:
                    (od / f"view_{k}.jpg").write_bytes(tar.extractfile(g[key]).read())
            entry["views"] = sorted(p.name for p in od.glob("view_*.jpg"))
            (od / "meta.json").write_text(json.dumps(meta, indent=1) + "\n")
            manifest["objects"].append(entry)
    manifest["count"] = len(manifest["objects"])
    (bench / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(json.dumps({"ok": True, "status": "extracted", "objects": manifest["count"], "skipped": len(manifest.get("skipped", [])), "manifest": str(bench / "manifest.json"), "tar_sha256": tar_sha}))
    return 0


# ---------------------------------------------------------------- score

def predict(a) -> int:
    """The Timmy formula: say what will happen before it happens. The prediction is written (hashed) before any score
    exists; `score` then grades it. A falsifier is part of the prediction: median voxel F1 more than --tolerance-f1 below
    --expect-f1 means the model profile that produced the expectation is wrong, not the bench."""
    bench = Path(a.bench); sdir = bench / "scores"; sdir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((bench / "manifest.json").read_text())
    pred = {"kind": "geo.bench-prediction", "set": manifest["set"], "model": a.model, "frame": a.frame, "objects": manifest["count"],
            "expected": {"median_voxel_f1": a.expect_f1, "median_fscore": a.expect_fscore}, "tolerance_f1": a.tolerance_f1,
            "falsifier": f"median voxel F1 more than {a.tolerance_f1} below {a.expect_f1}", "basis": a.basis, "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="seconds"),
            "manifest_sha256": hashlib.sha256((bench / "manifest.json").read_bytes()).hexdigest()}
    body = json.dumps(pred, sort_keys=True, separators=(",", ":"))
    pred["prediction_sha256"] = hashlib.sha256(body.encode()).hexdigest()
    (sdir / "prediction.json").write_text(json.dumps(pred, indent=1) + "\n")
    print(json.dumps({"ok": True, "status": "predicted", "model": a.model, "expected": pred["expected"], "prediction_sha256": pred["prediction_sha256"]}))
    return 0


def grade_prediction(sdir: Path, summary: dict) -> dict | None:
    pp = sdir / "prediction.json"
    if not pp.exists():
        return None
    pred = json.loads(pp.read_text())
    exp = pred["expected"]; obs = summary["median"]
    if obs["voxel_f1"] is None:
        return {"model": pred.get("model"), "prediction_sha256": pred.get("prediction_sha256"), "graded": False, "why": "nothing scored"}
    gap = round(obs["voxel_f1"] - exp["median_voxel_f1"], 4)
    falsified = gap < -pred["tolerance_f1"]
    out = {"model": pred.get("model"), "prediction_sha256": pred.get("prediction_sha256"), "graded": True, "expected_median_voxel_f1": exp["median_voxel_f1"],
           "observed_median_voxel_f1": obs["voxel_f1"], "gap": gap, "tolerance_f1": pred["tolerance_f1"], "as_predicted": abs(gap) <= pred["tolerance_f1"], "falsified": falsified,
           "frame_matches": pred.get("frame") == summary["frame"]}
    if exp.get("median_fscore") is not None and obs.get("fscore") is not None:
        out["expected_median_fscore"] = exp["median_fscore"]; out["observed_median_fscore"] = obs["fscore"]; out["fscore_gap"] = round(obs["fscore"] - exp["median_fscore"], 4)
    return out


def score(a) -> int:
    try:
        import numpy as np
        from voxel_score import load_points, score as vscore
    except ImportError:
        print(json.dumps({"ok": False, "status": "not_configured", "note": "score needs numpy + scipy (+ trimesh for meshes)"})); return 3
    bench = Path(a.bench); manifest = json.loads((bench / "manifest.json").read_text())
    pred_dir = Path(a.pred_dir); sdir = bench / "scores"; sdir.mkdir(exist_ok=True)
    rows = []; missing = []
    for e in manifest["objects"]:
        fr = e["frames"].get(a.frame)
        if not fr:
            missing.append({"id": e["id"], "why": f"no {a.frame} truth"}); continue
        pred = next((p for ext in ("ply", "glb", "obj", "json") for p in [pred_dir / f"{e['id']}.{ext}"] if p.exists()), None)
        if pred is None:
            missing.append({"id": e["id"], "why": "no prediction"}); continue
        truth_pts, how_t = load_points(bench / "objects" / e["id"] / fr["file"], a.samples, a.seed)
        pred_pts, how_p = load_points(pred, a.samples, a.seed)
        if a.normalize_each:                                                   # a generator's output has its own scale: unit-cube both before comparing
            for arr in (truth_pts, pred_pts):
                lo, hi = arr.min(0), arr.max(0); arr -= (lo + hi) / 2; arr /= float((hi - lo).max())
        res = vscore(truth_pts, pred_pts, a.voxel, a.tau, fit=a.fit, tol=a.tolerance)
        res["inputs"] = {"truth": fr["file"], "truth_from": how_t, "pred": pred.name, "pred_from": how_p, "frame": a.frame, "normalize_each": a.normalize_each}
        (sdir / f"{e['id']}.json").write_text(json.dumps(res, indent=1) + "\n")
        rows.append({"id": e["id"], "voxel_f1": res["voxel"]["f1"], "fscore": res["surface"]["fscore"]["f"], "chamfer_mean_dist": res["surface"]["chamfer_mean_dist"], "grid_unstable": res["voxel"]["grid_unstable"]})
    med = lambda k: round(float(np.median([r[k] for r in rows])), 4) if rows else None      # noqa: E731
    summary = {"kind": "geo.bench-summary", "set": manifest["set"], "frame": a.frame, "unit": "m" if a.frame == "metric" and not a.normalize_each else "unit-cube", "metric": not a.fit and not a.normalize_each,
               "voxel": a.voxel, "tau": a.tau, "tolerance": a.tolerance, "fit": a.fit, "normalize_each": a.normalize_each, "scored": len(rows), "missing": missing,
               "median": {"voxel_f1": med("voxel_f1"), "fscore": med("fscore"), "chamfer_mean_dist": med("chamfer_mean_dist")}, "rows": rows,
               "source": manifest["source"], "note": "metric:true only when nothing was fitted or rescaled; a generation model's output needs --fit or --normalize-each and is a shape score"}
    summary["prediction"] = grade_prediction(sdir, summary)
    (sdir / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps({k: summary[k] for k in ("kind", "set", "frame", "metric", "scored", "median")} | {"missing": len(missing), "prediction": summary["prediction"]}))
    return 0 if rows and not missing else (2 if rows else 1)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch"); f.add_argument("--set", default="gso", choices=sorted(SETS)); f.add_argument("--shard", type=int, default=0); f.add_argument("--smoke", action="store_true")
    f.add_argument("--out", required=True); f.add_argument("--max-gb", type=float, default=2.0); f.add_argument("--yes-big", action="store_true"); f.add_argument("--force", action="store_true"); f.set_defaults(fn=fetch)
    e = sub.add_parser("extract"); e.add_argument("--set", default="gso", choices=sorted(SETS)); e.add_argument("--tar", required=True); e.add_argument("--out", required=True)
    e.add_argument("--samples", type=int, default=200000); e.add_argument("--seed", type=int, default=7); e.set_defaults(fn=extract)
    pr = sub.add_parser("predict"); pr.add_argument("--bench", required=True); pr.add_argument("--model", required=True); pr.add_argument("--expect-f1", type=float, required=True)
    pr.add_argument("--expect-fscore", type=float); pr.add_argument("--tolerance-f1", type=float, default=0.08); pr.add_argument("--frame", default="metric", choices=["metric", "unit"])
    pr.add_argument("--basis", default="", help="where the expectation comes from (receipt hash, profile, prior run)"); pr.set_defaults(fn=predict)
    s = sub.add_parser("score"); s.add_argument("--bench", required=True); s.add_argument("--pred-dir", required=True); s.add_argument("--frame", default="metric", choices=["metric", "unit"])
    s.add_argument("--voxel", type=float, default=0.01); s.add_argument("--tau", type=float, default=0.005); s.add_argument("--tolerance", type=float, default=0.05); s.add_argument("--samples", type=int, default=200000)
    s.add_argument("--seed", type=int, default=7); s.add_argument("--fit", action="store_true"); s.add_argument("--normalize-each", action="store_true"); s.set_defaults(fn=score)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
