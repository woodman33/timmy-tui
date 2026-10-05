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
  card     --bench BENCH [--model NAME]                    one self-contained HTML Bench Card (and its hashed card.json) from the summary and
                                                           the sealed prediction → scores/card.html; with several runs, scores/index.html too

predict, score and card take --run NAME to keep each model's results in scores/<NAME>/ (without it: scores/, as before).

Nothing here fits anything: `score --fit` passes the flag through to voxel_score.py, whose output then says metric:false.
A generation model's output has an arbitrary scale and pose, so scoring it needs --fit (a shape score); a geometry
pipeline with known poses is scored metric without it. The summary records which it was.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
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


RUN_RE = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def scores_dir(bench: Path, run: str | None) -> Path:
    """scores/ for the default run, scores/<run>/ for a named one; a run name is a plain slug, never a path."""
    if run is None:
        return bench / "scores"
    if not RUN_RE.match(run) or run in (".", ".."):
        print(json.dumps({"ok": False, "status": "refused", "note": f"--run must match {RUN_RE.pattern}"}))
        sys.exit(2)
    return bench / "scores" / run


# ---------------------------------------------------------------- fetch

def fetch(a) -> int:
    import urllib.request
    s = SETS[a.set]
    repo = s["smoke_repo"] if a.smoke else s["repo"]
    rel = s["shard"].format(n=a.shard)
    base = os.environ.get("TIMMY_BENCH_BASE_URL") or f"https://huggingface.co/datasets/{repo}/resolve/main/"
    url = base.rstrip("/") + "/" + rel
    out = Path(a.out) / "shards"; out.mkdir(parents=True, exist_ok=True)
    dst = out / Path(rel).name; part = dst.with_suffix(dst.suffix + ".part"); side = out / (dst.name + ".json")
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        size = int(r.headers.get("Content-Length") or 0)
    if dst.exists() and not a.force:
        # present is only "present" when the bytes on disk are the bytes the server advertises (a dropped connection used to pass here)
        have = dst.stat().st_size
        if size and have != size:
            print(json.dumps({"ok": False, "status": "incomplete", "path": str(dst), "bytes": have, "expected_bytes": size, "note": "file on disk is not the advertised size; rerun with --force"}))
            return 5
        rec_prev = json.loads(side.read_text()) if side.exists() else {}
        print(json.dumps({"ok": True, "status": "present", "path": str(dst), "bytes": have, "expected_bytes": size or None, "sha256": rec_prev.get("sha256") or sha256_file(dst), "note": "already downloaded and size-verified; --force to refetch"}))
        return 0
    if size > a.max_gb * (1 << 30) and not a.yes_big:
        print(json.dumps({"ok": False, "status": "refused", "note": f"{rel} is {size / (1 << 30):.2f} GB > --max-gb {a.max_gb}; pass --yes-big with an explicit order line"}))
        return 2
    h = hashlib.sha256(); n = 0; err = None
    try:
        with urllib.request.urlopen(url, timeout=120) as r, part.open("wb") as f:
            size = int(r.headers.get("Content-Length") or size or 0)
            for chunk in iter(lambda: r.read(1 << 20), b""):
                f.write(chunk); h.update(chunk); n += len(chunk)
    except Exception as e:                                   # a connection that drops mid-body: whatever landed is not a shard
        err = f"{type(e).__name__}: {e}"[:200]
    if err or (size and n != size):
        part.unlink(missing_ok=True)
        print(json.dumps({"ok": False, "status": "incomplete", "shard": rel, "bytes": n, "expected_bytes": size or None, "note": err or "short read; partial file removed, nothing recorded"}))
        return 5
    part.replace(dst)
    rec = {"ok": True, "status": "fetched", "set": a.set, "repo": repo, "shard": rel, "url": url, "path": str(dst), "bytes": n, "expected_bytes": size or None, "sha256": h.hexdigest(), "license": s["license"]}
    side.write_text(json.dumps(rec, indent=1) + "\n")
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
    source = {"tar": tar_path.name, "tar_sha256": tar_sha, "tar_bytes": tar_path.stat().st_size, **{k: SETS[a.set][k] for k in ("repo", "license", "attribution")}}
    # shards accumulate: an existing manifest for the same set keeps its objects from other tars; objects with the same id are replaced
    mp = bench / "manifest.json"
    prev = json.loads(mp.read_text()) if mp.exists() else None
    if prev and (prev.get("set") != a.set or prev.get("samples_per_object") != a.samples or prev.get("seed") != a.seed):
        print(json.dumps({"ok": False, "status": "refused", "note": f"{mp} is for set={prev.get('set')} samples={prev.get('samples_per_object')} seed={prev.get('seed')}; use the same settings or another --out"})); return 2
    kept = [o for o in (prev or {}).get("objects", []) if o.get("shard") != tar_path.name]
    shards = [sh for sh in (prev or {}).get("shards", []) if sh.get("tar") != tar_path.name]
    manifest = {"kind": "geo.bench-manifest", "set": a.set, "source": source, "shards": shards, "samples_per_object": a.samples, "seed": a.seed, "objects": kept, "skipped": [x for x in (prev or {}).get("skipped", []) if x.get("shard") != tar_path.name]}
    with tarfile.open(tar_path) as tar:
        groups = group_members(tar)
        for oid in sorted(groups):
            g = groups[oid]
            if "json" not in g or ("obj" not in g and "glb" not in g):
                manifest["skipped"].append({"id": oid, "why": "no metadata or no mesh", "shard": tar_path.name}); continue
            meta = json.loads(tar.extractfile(g["json"]).read().decode("utf8"))
            od = objdir / oid; od.mkdir(exist_ok=True)
            entry = {"id": oid, "name": meta.get("name"), "category": meta.get("category"), "license_id": meta.get("license_id"), "shard": tar_path.name, "frames": {}}
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
            manifest["objects"] = [o for o in manifest["objects"] if o["id"] != oid] + [entry]
    new_ids = sorted(o["id"] for o in manifest["objects"] if o["shard"] == tar_path.name)
    manifest["shards"].append({**source, "objects": len(new_ids)})
    manifest["objects"].sort(key=lambda o: o["id"])
    manifest["count"] = len(manifest["objects"])
    if not manifest["skipped"]:
        del manifest["skipped"]
    mp.write_text(json.dumps(manifest, indent=1) + "\n")
    print(json.dumps({"ok": True, "status": "extracted", "objects_in_shard": len(new_ids), "objects": manifest["count"], "shards": len(manifest["shards"]), "skipped": len(manifest.get("skipped", [])), "manifest": str(mp), "tar_sha256": tar_sha}))
    return 0


# ---------------------------------------------------------------- score

def predict(a) -> int:
    """The Timmy formula: say what will happen before it happens. The prediction is written (hashed) before any score
    exists; `score` then grades it. A falsifier is part of the prediction: median voxel F1 more than --tolerance-f1 below
    --expect-f1 means the model profile that produced the expectation is wrong, not the bench."""
    bench = Path(a.bench); sdir = scores_dir(bench, a.run); sdir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((bench / "manifest.json").read_text())
    pred = {"kind": "geo.bench-prediction", "set": manifest["set"], "model": a.model, "run": a.run, "frame": a.frame, "objects": manifest["count"],
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
    pred_dir = Path(a.pred_dir); sdir = scores_dir(bench, a.run); sdir.mkdir(parents=True, exist_ok=True)
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
        if a.normalize_each:                                                   # rescaled shapes: the per-object record says shape score too, not only the summary
            res["metric"] = False; res["unit"] = "unit-cube"
            res["note"].append("each shape rescaled to its own unit cube (normalize_each): relative scale discarded, shape score, not metric")
        res["inputs"] = {"truth": fr["file"], "truth_from": how_t, "pred": pred.name, "pred_from": how_p, "frame": a.frame, "normalize_each": a.normalize_each}
        (sdir / f"{e['id']}.json").write_text(json.dumps(res, indent=1) + "\n")
        rows.append({"id": e["id"], "voxel_f1": res["voxel"]["f1"], "voxel_f1_band": res["voxel"].get("f1_band"), "fscore": res["surface"]["fscore"]["f"],
                     "chamfer_mean_dist": res["surface"]["chamfer_mean_dist"], "grid_unstable": res["voxel"]["grid_unstable"]})
    med = lambda k: round(float(np.median([r[k] for r in rows])), 4) if rows else None      # noqa: E731
    summary = {"kind": "geo.bench-summary", "set": manifest["set"], "frame": a.frame, "unit": "m" if a.frame == "metric" and not a.normalize_each else "unit-cube", "metric": not a.fit and not a.normalize_each,
               "voxel": a.voxel, "tau": a.tau, "tolerance": a.tolerance, "fit": a.fit, "normalize_each": a.normalize_each, "scored": len(rows), "missing": missing,
               "median": {"voxel_f1": med("voxel_f1"), "fscore": med("fscore"), "chamfer_mean_dist": med("chamfer_mean_dist"),
                          "voxel_f1_band": ([round(float(np.median([r["voxel_f1_band"][0] for r in rows])), 4), round(float(np.median([r["voxel_f1_band"][1] for r in rows])), 4)]
                                            if rows and all(r.get("voxel_f1_band") for r in rows) else None)}, "rows": rows, "run": a.run,
               "source": manifest["source"], "shards": len(manifest.get("shards", [])) or 1, "note": "metric:true only when nothing was fitted or rescaled; a generation model's output needs --fit or --normalize-each and is a shape score"}
    summary["prediction"] = grade_prediction(sdir, summary)
    (sdir / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps({k: summary[k] for k in ("kind", "set", "frame", "metric", "scored", "median")} | {"missing": len(missing), "prediction": summary["prediction"]}))
    return 0 if rows and not missing else (2 if rows else 1)


# ---------------------------------------------------------------- card

def _canon(o) -> str:
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def card_data(sdir: Path, bench: Path, model: str | None) -> dict:
    summary = json.loads((sdir / "summary.json").read_text())
    pp = sdir / "prediction.json"
    prediction = json.loads(pp.read_text()) if pp.exists() else None
    graded = summary.get("prediction")
    verdict = ("NO PREDICTION" if prediction is None else "NOT GRADED" if not (graded and graded.get("graded"))
               else "FALSIFIED" if graded.get("falsified") else "AS PREDICTED" if graded.get("as_predicted") else "OUTSIDE TOLERANCE")
    data = {"kind": "geo.bench-card", "model": model or (prediction or {}).get("model") or summary.get("run") or "unnamed", "run": summary.get("run"),
            "set": summary.get("set"), "frame": summary.get("frame"), "unit": summary.get("unit"), "metric": summary.get("metric"),
            "median": summary.get("median"), "scored": summary.get("scored"), "missing": summary.get("missing", []), "rows": summary.get("rows", []),
            "settings": {k: summary.get(k) for k in ("voxel", "tau", "tolerance", "fit", "normalize_each", "shards")},
            "verdict": verdict, "graded": graded,
            "prediction": None if prediction is None else {k: prediction.get(k) for k in ("expected", "tolerance_f1", "falsifier", "basis", "at", "prediction_sha256")},
            "attribution": (summary.get("source") or {}).get("attribution"), "license": (summary.get("source") or {}).get("license"),
            "source_tar_sha256": (summary.get("source") or {}).get("tar_sha256"),
            "summary_sha256": hashlib.sha256((sdir / "summary.json").read_bytes()).hexdigest()}
    data["card_sha256"] = hashlib.sha256(_canon(data).encode()).hexdigest()
    return data


VERDICT_COLOR = {"AS PREDICTED": "#3ddc84", "FALSIFIED": "#ff5a52", "OUTSIDE TOLERANCE": "#ffb020", "NOT GRADED": "#ffb020", "NO PREDICTION": "#ffb020"}
CARD_CSS = """
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#000;color:#fff;font-family:"Avenir Next","Helvetica Neue",Helvetica,Arial,sans-serif;line-height:1.45}
main{max-width:920px;margin:0 auto;padding:40px 16px 56px}
.label{font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:600}
h1{font-size:44px;line-height:1.1;margin:6px 0 4px;font-weight:700}
.sub{font-size:17px;margin:0 0 28px}
.verdict{display:inline-block;margin:0 0 28px;padding:8px 14px;border:2px solid var(--v);color:var(--v);font-weight:700;letter-spacing:.1em}
.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:0 0 32px}
.num{border:1px solid #333;padding:18px}
.num b{display:block;font-size:52px;line-height:1.05;margin:8px 0 6px;font-variant-numeric:tabular-nums}
.num span{font-size:15px}
section{margin:0 0 32px}
table{width:100%;border-collapse:collapse;font-size:15px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #333;vertical-align:top}
th{font-size:12px;letter-spacing:.12em;text-transform:uppercase}
.hash{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all}
.flag{color:#ffb020;font-weight:700}
footer{border-top:1px solid #333;padding-top:16px;font-size:14px}
a{color:#fff}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.sym{text-transform:none}
html,body{overflow-x:hidden}
@media (max-width:560px){h1{font-size:32px}.num b{font-size:40px}}
"""


def render_card(d: dict) -> str:
    from html import escape as E
    f = lambda v, n=3: "&mdash;" if v is None else E(f"{v:.{n}f}") if isinstance(v, (int, float)) else E(str(v))      # noqa: E731
    med = d.get("median") or {}
    band = med.get("voxel_f1_band")
    color = VERDICT_COLOR.get(d["verdict"], "#ffb020")
    kind = "METRIC" if d.get("metric") else "SHAPE SCORE (fitted or rescaled)"
    any_flag = any(r.get("grid_unstable") for r in d.get("rows", []))
    rows = "".join(
        f"<tr><td>{E(str(r.get('id')))}</td><td>{f(r.get('voxel_f1'))}"
        + (f" <small>[{f(r['voxel_f1_band'][0])}, {f(r['voxel_f1_band'][1])}]</small>" if r.get("voxel_f1_band") else "")
        + f"</td><td>{f(r.get('fscore'))}</td><td>{f(r.get('chamfer_mean_dist'), 4)}</td>"
        + (f"<td>{'<span class=flag>grid-sensitive</span>' if r.get('grid_unstable') else ''}</td>" if any_flag else "") + "</tr>"
        for r in d.get("rows", []))
    missing = "".join(f"<li>{E(str(m.get('id')))} &mdash; {E(str(m.get('why')))}</li>" for m in d.get("missing", []))
    g = d.get("graded") or {}; p = d.get("prediction") or {}
    pred_rows = ("<p>No prediction was sealed before this run, so nothing here was predicted.</p>" if not d.get("prediction") else
        "<div class=tw><table><tr><th>expected median voxel F1</th><th>observed</th><th>gap</th><th>allowed</th></tr>"
        f"<tr><td>{f((p.get('expected') or {}).get('median_voxel_f1'))}</td><td>{f(g.get('observed_median_voxel_f1'))}</td><td>{f(g.get('gap'))}</td><td>&plusmn;{f(p.get('tolerance_f1'), 2)}</td></tr></table></div>"
        f"<p>Falsifier, written before the run: {E(str(p.get('falsifier') or ''))}. Basis: {E(str(p.get('basis') or 'not given'))}. Sealed {E(str(p.get('at') or ''))}.</p>"
        f"<p class=hash>prediction sha256 {E(str(p.get('prediction_sha256') or ''))}</p>")
    s = d.get("settings") or {}
    unit = "m" if d.get("unit") == "m" else "unit-cube"
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bench Card · {E(str(d['model']))}</title><style>{CARD_CSS}</style></head><body><main>
<div class="label">Bench Card · {E(str(d.get('set') or '').upper())} · {E(str(d.get('frame') or ''))} frame</div>
<h1>{E(str(d['model']))}</h1>
<p class="sub">{E(str(d.get('scored')))} objects scored, {len(d.get('missing', []))} missing · {E(kind)}</p>
<div class="verdict" style="--v:{color}">{E(d['verdict'])}</div>
<div class="nums">
<div class="num"><div class="label">median voxel F1</div><b>{f(med.get('voxel_f1'))}</b><span>{'band ' + f(band[0]) + ' – ' + f(band[1]) + ' over 8 grid phases' if band else 'no band recorded'}</span></div>
<div class="num"><div class="label">median F-score @ <span class="sym">τ</span> {f(s.get('tau'), 3)} {unit}</div><b>{f(med.get('fscore'))}</b><span>no grid edge; the number papers quote</span></div>
<div class="num"><div class="label">median Chamfer ({unit})</div><b>{f(med.get('chamfer_mean_dist'), 4)}</b><span>mean nearest-neighbour distance, both ways</span></div>
</div>
<section><div class="label">The prediction, sealed before the run</div>{pred_rows}</section>
<section><div class="label">Per object</div><div class="tw"><table><tr><th>object</th><th>voxel F1 [band]</th><th>F-score</th><th>Chamfer</th>{'<th></th>' if any_flag else ''}</tr>{rows}</table></div>
{('<p class="label" style="margin-top:16px">Missing predictions</p><ul>' + missing + '</ul>') if missing else ''}</section>
<section><div class="label">Settings</div><p>voxel {f(s.get('voxel'), 3)} {unit} · τ {f(s.get('tau'), 3)} · sub-voxel tolerance {f(s.get('tolerance'), 2)} · fit {E(str(bool(s.get('fit'))).lower())} · rescaled each {E(str(bool(s.get('normalize_each'))).lower())} · shards {E(str(s.get('shards')))}</p></section>
<footer><p>{E(str(d.get('attribution') or 'source attribution not recorded'))}{'' if (d.get('license') or '').lower() in (d.get('attribution') or '').lower() else ' (' + E(str(d.get('license') or 'licence not recorded')) + ')'}.</p>
<p class="hash">card sha256 {E(d['card_sha256'])}<br>summary sha256 {E(d['summary_sha256'])}<br>source tar sha256 {E(str(d.get('source_tar_sha256') or ''))}</p>
<p>Generated by <span class="hash">timmy geo bench card</span>. Every number on this card is in the summary it hashes; change one and the hash no longer matches.</p></footer>
</main></body></html>
"""


def card(a) -> int:
    bench = Path(a.bench); sdir = scores_dir(bench, a.run)
    if not (sdir / "summary.json").exists():
        print(json.dumps({"ok": False, "status": "refused", "note": f"no summary.json in {sdir.name}/; run score first"})); return 2
    d = card_data(sdir, bench, a.model)
    (sdir / "card.json").write_text(json.dumps(d, indent=1) + "\n")
    (sdir / "card.html").write_text(render_card(d))
    runs = sorted(p.parent for p in (bench / "scores").glob("*/summary.json"))
    if len(runs) > 1:                                                          # several models on one bench: an index of their cards
        from html import escape as E
        items = []
        for rd in runs:
            sm = json.loads((rd / "summary.json").read_text()); med = sm.get("median") or {}
            cj = json.loads((rd / "card.json").read_text()) if (rd / "card.json").exists() else None
            name = (cj or {}).get("model") or rd.name
            items.append((med.get("voxel_f1") if med.get("voxel_f1") is not None else -1, f"<tr><td>{'<a href=\"' + E(rd.name) + '/card.html\">' + E(name) + '</a>' if cj else E(name)}</td>"
                          f"<td>{'' if med.get('voxel_f1') is None else f'{med["voxel_f1"]:.3f}'}</td><td>{'' if not med.get('voxel_f1_band') else f'{med["voxel_f1_band"][0]:.3f} – {med["voxel_f1_band"][1]:.3f}'}</td>"
                          f"<td>{'' if med.get('fscore') is None else f'{med["fscore"]:.3f}'}</td><td>{E((cj or {}).get('verdict', 'no card yet'))}</td><td>{'metric' if sm.get('metric') else 'shape'}</td></tr>"))
        body = "".join(r for _, r in sorted(items, key=lambda t: -t[0]))
        (bench / "scores" / "index.html").write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bench Cards</title><style>{CARD_CSS}</style></head>
<body><main><div class="label">Bench Cards</div><h1>{len(runs)} runs</h1><p class="sub">Sorted by median voxel F1. Overlapping bands are a tie.</p>
<div class="tw"><table><tr><th>model</th><th>voxel F1</th><th>band</th><th>F-score</th><th>prediction</th><th>kind</th></tr>{body}</table></div></main></body></html>
""")
    print(json.dumps({"ok": True, "status": "carded", "model": d["model"], "verdict": d["verdict"], "card": str(sdir / "card.html"), "card_sha256": d["card_sha256"], "runs_on_bench": len(runs)}))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch"); f.add_argument("--set", default="gso", choices=sorted(SETS)); f.add_argument("--shard", type=int, default=0); f.add_argument("--smoke", action="store_true")
    f.add_argument("--out", required=True); f.add_argument("--max-gb", type=float, default=2.0); f.add_argument("--yes-big", action="store_true"); f.add_argument("--force", action="store_true"); f.set_defaults(fn=fetch)
    e = sub.add_parser("extract"); e.add_argument("--set", default="gso", choices=sorted(SETS)); e.add_argument("--tar", required=True); e.add_argument("--out", required=True)
    e.add_argument("--samples", type=int, default=200000); e.add_argument("--seed", type=int, default=7); e.set_defaults(fn=extract)
    pr = sub.add_parser("predict"); pr.add_argument("--bench", required=True); pr.add_argument("--model", required=True); pr.add_argument("--expect-f1", type=float, required=True)
    pr.add_argument("--expect-fscore", type=float); pr.add_argument("--tolerance-f1", type=float, default=0.08); pr.add_argument("--frame", default="metric", choices=["metric", "unit"])
    pr.add_argument("--basis", default="", help="where the expectation comes from (receipt hash, profile, prior run)"); pr.add_argument("--run"); pr.set_defaults(fn=predict)
    s = sub.add_parser("score"); s.add_argument("--bench", required=True); s.add_argument("--pred-dir", required=True); s.add_argument("--frame", default="metric", choices=["metric", "unit"])
    s.add_argument("--voxel", type=float, default=0.01); s.add_argument("--tau", type=float, default=0.005); s.add_argument("--tolerance", type=float, default=0.05); s.add_argument("--samples", type=int, default=200000)
    s.add_argument("--seed", type=int, default=7); s.add_argument("--fit", action="store_true"); s.add_argument("--normalize-each", action="store_true"); s.add_argument("--run"); s.set_defaults(fn=score)
    c = sub.add_parser("card"); c.add_argument("--bench", required=True); c.add_argument("--run"); c.add_argument("--model"); c.set_defaults(fn=card)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
