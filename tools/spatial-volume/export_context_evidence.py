#!/usr/bin/env python3
"""Export source-bound geometry, context and ablation data to actual Rerun/Viser files.

No inference, seals, browser clients or native geometry writes. An ephemeral
loopback Viser server is stopped before this finite command returns.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

import numpy as np


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_bytes(path: Path, limit: int) -> bytes:
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    if not data or len(data) > limit:
        raise ValueError("Empty or oversized source")
    return data


def parse(data: bytes):
    def reject_constant(_):
        raise ValueError("Nonfinite JSON value")
    return json.loads(data, parse_constant=reject_constant)


def vector(value):
    if not isinstance(value, list) or len(value) != 3 or any(type(n) not in (int, float) or not math.isfinite(n) for n in value):
        raise ValueError("Expected three finite numbers")
    return np.asarray(value, dtype=np.float64)


def text(value, limit=2000):
    if not isinstance(value, str) or not value or len(value) > limit or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        raise ValueError("Invalid bounded text")
    return value


def load_inputs(manifest_path: Path, context_path: Path, ablation_path: Path):
    """Admit the bounded analytic fixture; hashes establish bytes, not physics."""
    manifest_path = manifest_path.resolve()
    manifest_bytes = read_bytes(manifest_path, 1024 * 1024)
    manifest = parse(manifest_bytes)
    if manifest.get("schema") != "timmy.spatial-volume/1":
        raise ValueError("Unsupported volume manifest")
    source_hash = sha(manifest_bytes)
    context_bytes = read_bytes(context_path, 128 * 1024)
    context = parse(context_bytes)
    if context.get("schema") != "timmy.spatial-model-context/1" or context.get("source", {}).get("kind") != "volume" or context["source"].get("sha256") != source_hash:
        raise ValueError("Context is not bound to the manifest bytes")
    if not isinstance(context.get("facts"), list) or not 1 <= len(context["facts"]) <= 64 or not isinstance(context.get("entities"), list) or not 1 <= len(context["entities"]) <= 16:
        raise ValueError("Unbounded context")
    facts = {f["id"]: f for f in context["facts"]}
    entities = {e["id"]: e for e in context["entities"]}
    if len(facts) != len(context["facts"]) or len(entities) != len(context["entities"]) or any(f.get("source", {}).get("sha256") != source_hash or f.get("entityId") not in entities for f in facts.values()):
        raise ValueError("Conflicting context identities or fact bindings")
    verified = {}
    loaded = {}
    for name, descriptor in manifest["artifacts"].items():
        relative = Path(descriptor["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Artifact path escapes package")
        path = (manifest_path.parent / relative).resolve()
        if not path.is_relative_to(manifest_path.parent):
            raise ValueError("Artifact symlink escapes package")
        data = read_bytes(path, 64 * 1024 * 1024)
        if len(data) != descriptor["bytes"] or sha(data) != descriptor["sha256"]:
            raise ValueError("Artifact hash or size mismatch")
        verified[name] = {"path": str(relative), "sha256": sha(data), "bytes": len(data)}
        if name in ("cells", "mesh"):
            loaded[name] = parse(data)
    if not {"cells", "mesh"}.issubset(loaded):
        raise ValueError("Verified cell and mesh artifacts are required")
    grid = manifest["grid"]
    expected_frame = {"id": grid["frameId"], **{k: grid[k] for k in ("units", "origin", "basis", "dimensions", "cellSize")}}
    if grid["units"] != "mm" or context.get("frame") != expected_frame:
        raise ValueError("Fixture requires matching explicit millimetre frames")
    dims, origin, size = vector(grid["dimensions"]), vector(grid["origin"]), vector(grid["cellSize"])
    if np.any(dims < 1) or np.any(dims != np.floor(dims)) or math.prod(dims) > 100_000 or np.any(size <= 0):
        raise ValueError("Invalid bounded grid dimensions or cell size")
    basis = np.stack([vector(column) for column in grid["basis"]], axis=1)
    if basis.shape != (3, 3) or not np.allclose(basis.T @ basis, np.eye(3), atol=1e-9, rtol=0) or not np.isclose(np.linalg.det(basis), 1, atol=1e-9, rtol=0):
        raise ValueError("Invalid right-handed grid basis")
    shape = tuple(int(n) for n in dims)
    selected_ijk = vector(entities["cell-center"]["ijk"])
    if np.any(selected_ijk < 0) or np.any(selected_ijk >= dims) or np.any(selected_ijk != np.floor(selected_ijk)):
        raise ValueError("Selected cell is outside grid")
    selected_center = origin + basis @ ((selected_ijk + .5) * size)
    if not np.array_equal(selected_center, vector(facts["cell-center.location"]["value"])):
        raise ValueError("Context center differs from source geometry")
    cells, mesh = loaded["cells"], loaded["mesh"]
    values = cells.get("fractions")
    if cells.get("schema") != "timmy.spatial-volume.cells/1" or cells.get("order") != "x-fastest" or not isinstance(values, list) or len(values) != math.prod(shape):
        raise ValueError("Incomplete cell inventory")
    if any(n is not None and (type(n) not in (int, float) or not math.isfinite(n) or not 0 <= n <= 1) for n in values):
        raise ValueError("Invalid occupancy fraction")
    i, j, k = (int(n) for n in selected_ijk)
    selected_fill = values[i + shape[0] * (j + shape[1] * k)]
    if facts["cell-center.fill"]["value"] != selected_fill:
        raise ValueError("Context selected fill differs from cell artifact")
    fill_counts = {"unknown": sum(n is None for n in values), "sampled": 0, "declared": 0, "empty": sum(n == 0 for n in values), "partial": sum(n is not None and 0 < n < 1 for n in values), "full": sum(n == 1 for n in values)}
    status = manifest.get("fill", {}).get("status")
    if status not in ("sampled", "declared"):
        raise ValueError("Unsupported fixture fill status")
    fill_counts[status] = len(values) - fill_counts["unknown"]
    if facts["volume.fill-coverage"]["value"] != fill_counts or facts["volume.total-cells"]["value"] != len(values) or facts["volume.location-count"]["value"] != len(values):
        raise ValueError("Context counts differ from complete source inventory")
    for property_name in ("material", "density"):
        if manifest.get(property_name) != {"status": "unknown"} or any(o.get(property_name, {"status": "unknown"}) != {"status": "unknown"} for o in cells.get("overrides", [])):
            raise ValueError("This fixture requires explicitly unknown material and density")
        for entity in ("volume", "cell-center"):
            f = facts[f"{entity}.{property_name}"]
            if f.get("epistemic") != "unknown" or f.get("value") is not None:
                raise ValueError("Context contradicts unknown source properties")
    if mesh.get("schema") != "timmy.spatial-volume.mesh/1" or mesh.get("units") != "mm" or len(mesh["positions"]) > 3_000_000 or len(mesh["triangles"]) > 6_000_000:
        raise ValueError("Unsupported or oversized source mesh")
    vertices = np.asarray(mesh["positions"], dtype=np.float64).reshape(-1, 3)
    triangles = np.asarray(mesh["triangles"], dtype=np.float64).reshape(-1, 3)
    if not len(vertices) or not len(triangles) or not np.all(np.isfinite(vertices)) or not np.all(np.isfinite(triangles)) or np.any(triangles != np.floor(triangles)) or np.any(triangles < 0) or np.any(triangles >= len(vertices)):
        raise ValueError("Invalid mesh coordinates or indices")
    indices = np.asarray([(i, j, k) for k in range(shape[2]) for j in range(shape[1]) for i in range(shape[0])], dtype=np.float64)
    centers = origin + ((indices + .5) * size) @ basis.T
    float32_max = np.finfo(np.float32).max
    if not np.all(np.isfinite(centers)) or np.any(np.abs(centers) > float32_max) or np.any(np.abs(vertices) > float32_max):
        raise ValueError("Geometry exceeds display precision")
    colors = np.asarray([(110, 110, 110) if n is None else (75, 90, 110) if n == 0 else (235, 179, 75) if n < 1 else (90, 180, 165) for n in values], dtype=np.uint8)
    ablation_bytes = read_bytes(ablation_path, 2 * 1024 * 1024)
    ablation = parse(ablation_bytes)
    context_hash = sha(context_bytes)
    if ablation.get("contextSha256") != context_hash or ablation.get("sourceSha256") != source_hash:
        raise ValueError("Ablation is not bound to this exact context and source")
    rows = ablation.get("rows")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 128 or any(not isinstance(row, dict) for row in rows):
        raise ValueError("Expected one to 128 retained ablation rows")
    row_texts = [text(json.dumps(row, ensure_ascii=False, indent=2, allow_nan=False), 32_000) for row in rows]
    return {"sourceHash": source_hash, "contextHash": context_hash, "ablationHash": sha(ablation_bytes), "context": context, "ablation": ablation, "rows": row_texts, "verified": verified, "vertices": vertices, "triangles": triangles.astype(np.uint32), "centers": centers, "colors": colors, "center": selected_center, "fill": selected_fill, "cellSize": size, "dimensions": shape, "counts": fill_counts, "inputs": {"manifest": manifest_bytes, "context": context_bytes, "ablation": ablation_bytes}}


def description(bundle):
    return ("Timmy: retained analytic geometry and context ablation\n"
            "Units: mm. Color classifies fill; it does not identify physical material.\n"
            "Material, intrinsic density and physical mass: unknown. No model edits executed.\n"
            "Benchmark answers and scores are retained data, not independently validated semantics.\n"
            f"Source SHA-256: {bundle['sourceHash']}\n"
            f"Context SHA-256: {bundle['contextHash']}\n"
            f"Ablation SHA-256: {bundle['ablationHash']}\n"
            f"Grid: {bundle['dimensions']}; known positions: {len(bundle['centers'])}\n"
            f"Selected center: {bundle['center'].tolist()}; fill fraction: {bundle['fill']}")


def export_rerun(bundle, path: Path):
    import rerun as rr
    import rerun.blueprint as rrb
    recording = rr.RecordingStream("timmy-context-evidence", recording_id="ctx-" + bundle["ablationHash"][:24])
    try:
        recording.save(path, default_blueprint=rrb.Blueprint(rrb.Horizontal(rrb.Spatial3DView(origin="/fixture", name="Retained geometry / mm"), rrb.TextDocumentView(origin="/evidence", name="Facts and retained model answers"))))
        recording.log("/fixture", rr.ViewCoordinates.RIGHT_HAND_Z_UP, static=True, strict=True)
        recording.log("/fixture/surface", rr.Mesh3D(vertex_positions=bundle["vertices"].astype(np.float32), triangle_indices=bundle["triangles"], albedo_factor=[105, 150, 170, 210]), static=True, strict=True)
        recording.log("/fixture/cells", rr.Points3D(bundle["centers"].astype(np.float32), colors=bundle["colors"], radii=float(np.min(bundle["cellSize"])) * .08), static=True, strict=True)
        recording.log("/fixture/cell-center", rr.Points3D([bundle["center"]], radii=2, colors=[235, 179, 75], labels=["Selected cell: known position, material unknown"], show_labels=True), static=True, strict=True)
        recording.log("/evidence/source", rr.TextDocument(description(bundle) + "\n\n" + json.dumps(bundle["context"], indent=2), media_type="text/plain"), static=True, strict=True)
        for index, row in enumerate(bundle["rows"]):
            recording.set_time("ablation_row", sequence=index)
            recording.log("/evidence/model-answer", rr.TextDocument("RETAINED MODEL / BENCHMARK DATA; NO NATIVE EDITS\n" + row, media_type="text/plain"), strict=True)
        recording.flush()
    finally:
        recording.disconnect()
    executable = Path(sys.executable).with_name("rerun")
    verified = subprocess.run([str(executable), "rrd", "verify", str(path)], text=True, capture_output=True, timeout=60, check=False)
    if verified.returncode:
        raise ValueError("Rerun could not verify the exported recording: " + (verified.stderr or verified.stdout)[-1000:])
    return {"verification": "rerun rrd verify", "exitCode": verified.returncode, "rows": len(bundle["rows"])}


def decode_viser(data: bytes):
    """Read the installed Viser 1.1 format back, including aligned array buffers."""
    import msgspec
    import zstandard
    if len(data) < 16:
        raise ValueError("Truncated Viser file")
    expected = int.from_bytes(data[:8], "little")
    if not 1 <= expected <= 128 * 1024 * 1024:
        raise ValueError("Unbounded Viser decoded size")
    inner = zstandard.ZstdDecompressor().decompress(data[8:], max_output_size=expected)
    if len(inner) != expected:
        raise ValueError("Viser decoded length mismatch")
    length = int.from_bytes(inner[:8], "little")
    if length < 1 or 8 + length > len(inner):
        raise ValueError("Invalid Viser metadata size")
    metadata = msgspec.msgpack.decode(inner[8:8 + length])
    offset, buffers = 8 + length, []
    for size in metadata["binaryBufferLengths"]:
        offset += (-offset) % 8
        if type(size) is not int or size < 0 or offset + size > len(inner):
            raise ValueError("Invalid Viser binary buffer")
        buffers.append(inner[offset:offset + size])
        offset += size
    if offset != len(inner):
        raise ValueError("Trailing or missing Viser array bytes")
    return metadata, buffers


def export_viser(bundle, path: Path):
    import viser
    if os.environ.get("_VISER_PORT_OVERRIDE") is not None:
        raise ValueError("Refusing Viser port override; exporter owns an ephemeral port only")
    client = Path(viser.__file__).resolve().parent / "client/build/index.html"
    if not client.is_file():
        raise ValueError("Installed Viser client is absent; no automatic build permitted")
    server = viser.ViserServer(host="127.0.0.1", port=0, label="Timmy context evidence export", verbose=False)
    try:
        server.scene.set_up_direction("+z")
        server.scene.add_mesh_simple("/fixture/surface", vertices=bundle["vertices"].astype(np.float32), faces=bundle["triangles"], color=(105, 150, 170), side="double")
        server.scene.add_point_cloud("/fixture/cells", points=bundle["centers"].astype(np.float32), colors=bundle["colors"], point_size=float(np.min(bundle["cellSize"])) * .15, precision="float32")
        server.scene.add_point_cloud("/fixture/cell-center", points=np.asarray([bundle["center"]], dtype=np.float32), colors=(235, 179, 75), point_size=4, precision="float32")
        bounds_max = np.max(bundle["vertices"], axis=0)
        bounds_min = np.min(bundle["vertices"], axis=0)
        span = max(float(np.max(bounds_max - bounds_min)), 1.)
        # GUI messages are excluded from .viser files. Plain scene labels persist.
        server.scene.add_label("/evidence/source", description(bundle), position=tuple(bounds_max + [span * .25, 0, 0]))
        server.scene.add_label("/evidence/context", "SOURCE CONTEXT\n" + json.dumps(bundle["context"], indent=2), position=tuple(bounds_max + [span * 1.5, 0, 0]), visible=False)
        for index, row in enumerate(bundle["rows"]):
            server.scene.add_label(f"/evidence/row-{index:03d}", "RETAINED MODEL / BENCHMARK DATA; NO NATIVE EDITS\n" + row, position=tuple(bounds_max + [span * 1.5, -index * span, 0]), visible=False)
        data = server.get_scene_serializer().serialize()
        path.write_bytes(data)
    finally:
        server.stop()
    metadata, buffers = decode_viser(read_bytes(path, 128 * 1024 * 1024))
    messages = [m for _, m in metadata["messages"]]
    paths = sorted({m["name"] for m in messages if isinstance(m.get("name"), str)})
    for required in ["/fixture/surface", "/fixture/cells", "/fixture/cell-center", "/evidence/source", "/evidence/context", *[f"/evidence/row-{i:03d}" for i in range(len(bundle["rows"]))]]:
        if required not in paths:
            raise ValueError("Exported Viser scene is missing " + required)
    # Verify actual serialized geometry bytes, not only script or metadata hashes.
    if bundle["vertices"].astype(np.float32).tobytes() not in buffers or bundle["triangles"].tobytes() not in buffers or bundle["centers"].astype(np.float32).tobytes() not in buffers:
        raise ValueError("Viser geometry arrays do not match admitted source")
    return {"verification": "decoded scene messages and exact geometry buffers", "viserVersion": metadata["viserVersion"], "messageCount": len(messages), "binaryBufferCount": len(buffers), "entityPaths": paths, "annotationRows": len(bundle["rows"]), "annotationsInitiallyHidden": True, "temporaryServerStopped": True}


def export(manifest: Path, context: Path, ablation: Path, output: Path):
    bundle = load_inputs(manifest, context, ablation)
    output.mkdir(parents=True, exist_ok=False)
    for name, data in bundle["inputs"].items():
        (output / f"input-{name}.json").write_bytes(data)
    rerun_result = export_rerun(bundle, output / "context.rrd")
    viser_result = export_viser(bundle, output / "context.viser")
    files = {}
    for path in sorted(output.iterdir()):
        data = read_bytes(path, 128 * 1024 * 1024)
        files[path.name] = {"bytes": len(data), "sha256": sha(data)}
    report = {"schema": "timmy.spatial-context-export/1", "sourceSha256": bundle["sourceHash"], "contextSha256": bundle["contextHash"], "ablationSha256": bundle["ablationHash"], "geometry": {"units": "mm", "vertices": len(bundle["vertices"]), "triangles": len(bundle["triangles"]), "gridLocations": len(bundle["centers"]), "fillCounts": bundle["counts"], "maxDisplayCoordinateErrorMm": float(max(np.max(np.abs(bundle["vertices"] - bundle["vertices"].astype(np.float32).astype(np.float64))), np.max(np.abs(bundle["centers"] - bundle["centers"].astype(np.float32).astype(np.float64)))))}, "sourceArtifacts": bundle["verified"], "files": files, "rerun": rerun_result, "viser": viser_result, "versions": {"rerun": importlib.metadata.version("rerun-sdk"), "viser": importlib.metadata.version("viser")}, "scope": {"geometrySource": "retained analytic fixture", "semanticCorrectnessChecked": False, "nativeEditsExecuted": False, "physicalValidation": False, "renderingProved": False, "claim": "actual serialized geometry and retained context/ablation data; source hashes and format readback checked"}}
    (output / "export-manifest.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--context", required=True, type=Path)
    parser.add_argument("--ablation", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    report = export(args.manifest, args.context, args.ablation, args.out)
    print(json.dumps({"ok": True, "manifest": str(args.out / "export-manifest.json"), "sha256": sha((args.out / "export-manifest.json").read_bytes()), "files": report["files"]}))


if __name__ == "__main__":
    main()
