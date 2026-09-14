#!/usr/bin/env python3
"""Construct and qualify a dimensioned tray using explicit native CAD operations.

Run with the existing CadQuery runtime. No prompts, generated meshes, network
calls, or external project mutations are involved. Dimensions are millimeters.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys

import cadquery as cq
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib


ROOT = Path(__file__).resolve().parent
DEPTH, HEIGHT, WALL = 80.0, 30.0, 3.0
BOSS_RADIUS, BOSS_HEIGHT, BORE_RADIUS = 6.0, 8.0, 1.5
BOUND_TOLERANCE = 1e-6
VOLUME_RELATIVE_TOLERANCE = 1e-8


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def measurements(shape):
    # Explicitly ignore cached tessellation. CadQuery's default bounds method
    # can use it after STL export, slightly enlarging otherwise exact bounds.
    native_box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, native_box, False, False)
    bounds = cq.BoundBox(native_box)
    return {
        "bounds": [bounds.xlen, bounds.ylen, bounds.zlen],
        "extentMin": [bounds.xmin, bounds.ymin, bounds.zmin],
        "extentMax": [bounds.xmax, bounds.ymax, bounds.zmax],
        "volume": shape.Volume(),
        "valid": shape.isValid(),
        "solids": len(shape.Solids()),
        "boundsMethod": "OpenCascade AddOptimal; useTriangulation=false; useShapeTolerance=false",
    }


def within_volume(actual, expected):
    return abs(actual - expected) <= max(1e-5, expected * VOLUME_RELATIVE_TOLERANCE)


def native_checks(measured, expected, prefix="Native"):
    return [
        {
            "label": f"{prefix} bounds",
            "passed": all(abs(a-b) <= BOUND_TOLERANCE for a, b in zip(measured["bounds"], expected["bounds"])),
            "detail": {"expected": expected["bounds"], "actual": measured["bounds"], "toleranceMm": BOUND_TOLERANCE},
        },
        {
            "label": f"{prefix} analytic volume",
            "passed": within_volume(measured["volume"], expected["volume"]),
            "detail": {"expectedMm3": expected["volume"], "actualMm3": measured["volume"], "relativeTolerance": VOLUME_RELATIVE_TOLERANCE},
        },
        {"label": f"{prefix} valid single solid", "passed": measured["valid"] and measured["solids"] == 1, "detail": {"valid": measured["valid"], "solids": measured["solids"]}},
    ]


def mesh_check(path, expected):
    try:
        import open3d as o3d
    except ImportError:
        return {"status": "unavailable", "scope": "Open3D is not installed; full gate cannot pass."}, []
    mesh = o3d.io.read_triangle_mesh(str(path))
    # STL commonly repeats vertex coordinates per triangle. Weld identical
    # coordinates only, preserving the exported shape and triangle positions.
    before = len(mesh.vertices)
    mesh.remove_duplicated_vertices()
    mesh.remove_duplicated_triangles()
    mesh.remove_unreferenced_vertices()
    watertight = mesh.is_watertight()
    manifold = mesh.is_edge_manifold(allow_boundary_edges=False)
    vertex_manifold = mesh.is_vertex_manifold()
    orientable = mesh.is_orientable()
    self_intersecting = mesh.is_self_intersecting()
    _, counts, _ = mesh.cluster_connected_triangles()
    volume = abs(mesh.get_volume()) if watertight and orientable else None
    bounds = list(mesh.get_axis_aligned_bounding_box().get_extent())
    result = {
        "status": "measured", "engine": f"Open3D {o3d.__version__}",
        "preprocessing": "Merged only identical vertex coordinates; removed duplicate triangles and unreferenced vertices.",
        "verticesBeforeWeld": before, "vertices": len(mesh.vertices), "triangles": len(mesh.triangles),
        "watertight": watertight, "edgeManifold": manifold, "vertexManifold": vertex_manifold,
        "orientable": orientable, "selfIntersecting": self_intersecting,
        "components": len(counts), "volume": volume, "bounds": bounds,
        "volumeRelativeTolerance": 0.001,
    }
    checks = [
        {"label": "STL closed, manifold, orientable", "passed": watertight and manifold and vertex_manifold and orientable, "detail": "Open3D checks after identical-vertex welding."},
        {"label": "STL one component, no self intersections", "passed": len(counts) == 1 and not self_intersecting, "detail": {"components": len(counts), "selfIntersecting": self_intersecting}},
        {"label": "STL volume agrees within 0.1%", "passed": volume is not None and abs(volume-expected["volume"])/expected["volume"] <= 0.001, "detail": {"analyticMm3": expected["volume"], "tessellatedMm3": volume}},
    ]
    return result, checks


def build_variant(width):
    variant_id = f"w{width:g}"
    directory = ROOT / variant_id
    directory.mkdir(parents=True, exist_ok=True)
    points = [(sx*(width/2-OFFSET), sy*(DEPTH/2-OFFSET)) for sx in (-1, 1) for sy in (-1, 1)]
    outer = cq.Workplane("XY").box(width, DEPTH, HEIGHT, centered=(True, True, False))
    pocket = cq.Workplane("XY", origin=(0, 0, WALL)).box(width-2*WALL, DEPTH-2*WALL, HEIGHT-WALL, centered=(True, True, False))
    cavity = outer.cut(pocket)
    cylinders = cq.Workplane("XY", origin=(0, 0, WALL)).pushPoints(points).circle(BOSS_RADIUS).extrude(BOSS_HEIGHT, combine=False)
    bosses = cavity
    for cylinder in cylinders.vals():
        bosses = bosses.union(cylinder)
    holes = cq.Workplane("XY").pushPoints(points).circle(BORE_RADIUS).extrude(WALL+BOSS_HEIGHT, combine=False)
    bores = bosses
    for hole in holes.vals():
        bores = bores.cut(hole)

    outer_volume = width*DEPTH*HEIGHT
    cavity_volume = outer_volume-(width-2*WALL)*(DEPTH-2*WALL)*(HEIGHT-WALL)
    boss_volume = cavity_volume+4*math.pi*BOSS_RADIUS**2*BOSS_HEIGHT
    final_volume = boss_volume-4*math.pi*BORE_RADIUS**2*(WALL+BOSS_HEIGHT)
    stages = []
    all_stage_checks = []
    stage_inputs = [
        ("outer", "Outer block", outer, outer_volume, f"box({width}, 80, 30)"),
        ("cavity", "Open cavity", cavity, cavity_volume, f"subtract box({width-2*WALL}, {80-2*WALL}, {30-WALL}) at z = {WALL}"),
        ("bosses", "Four screw bosses", bosses, boss_volume, f"union 4 cylinders: radius 6, z = {WALL}…{WALL+8}"),
        ("bores", "Four through bores", bores, final_volume, f"subtract 4 cylinders: radius {BORE_RADIUS}, z = 0…{WALL+8}"),
    ]
    for stage_id, label, workplane, expected_volume, operation in stage_inputs:
        shape = workplane.val()
        path = directory / f"{stage_id}.stl"
        cq.exporters.export(shape, str(path), tolerance=0.02, angularTolerance=0.04)
        measured = measurements(shape)
        expected = {"bounds": [width, DEPTH, HEIGHT], "volume": expected_volume}
        checks = native_checks(measured, expected, label)
        all_stage_checks.extend(checks)
        stages.append({"id": stage_id, "label": label, "file": str(path.relative_to(ROOT)), "sha256": sha256(path), "operation": operation, "expected": expected, "measured": measured, "checks": checks})

    final = bores.val()
    step_path = directory / "console-tray.step"
    stl_path = directory / "bores.stl"
    cq.exporters.export(final, str(step_path))
    roundtrip = cq.importers.importStep(str(step_path)).val()
    expected = {"bounds": [width, DEPTH, HEIGHT], "volume": final_volume}
    measured = measurements(final)
    reimported = measurements(roundtrip)
    mesh, mesh_checks = mesh_check(stl_path, expected)
    checks = native_checks(measured, expected) + native_checks(reimported, expected, "STEP reimport") + mesh_checks
    checks.append({"label": "Every construction stage validated", "passed": all(c["passed"] for c in all_stage_checks), "detail": f"{len(all_stage_checks)} bounds, analytic volume, and solid checks across four native stages."})
    checks = all_stage_checks + checks
    features = []
    for stage_id, label, wp, volume, operation in stage_inputs:
        axes = []
        radius = BOSS_RADIUS if stage_id == "bosses" else BORE_RADIUS
        if stage_id in ("bosses", "bores"):
            for face in wp.val().Faces():
                if face.geomType() == "CYLINDER":
                    cylinder = face._geomAdaptor().Cylinder()
                    if abs(cylinder.Radius()-radius) < 1e-6:
                        loc = cylinder.Location()
                        pair = [round(loc.X(), 8), round(loc.Y(), 8)]
                        if pair not in axes: axes.append(pair)
            axes.sort()
            for i, point in enumerate(sorted(points)):
                checks.append({"label": f"{stage_id} axis {i+1}", "passed": len(axes)==4 and all(abs(axes[i][j]-point[j])<1e-6 for j in range(2)), "detail": {"expected": point, "actual": axes[i] if i < len(axes) else None}})
        features.append({"id": "tray."+stage_id, "operation": {"outer":"box", "cavity":"subtract", "bosses":"union", "bores":"subtract"}[stage_id], "dependsOn": [] if stage_id=="outer" else ["tray."+stage_inputs[[s[0] for s in stage_inputs].index(stage_id)-1][0]], "bounds": measurements(wp.val()), "cylinderAxesXY": axes})
    for i, check in enumerate(checks): check["id"] = f"geometry.{i+1:02d}"
    if len(checks) != 30: raise RuntimeError("All 30 geometry checks require Open3D")
    return {
        "features": features,
        "id": variant_id, "width": width, "depth": DEPTH, "height": HEIGHT, "wall": WALL,
        "bossRadius": BOSS_RADIUS, "bossHeight": BOSS_HEIGHT, "boreDiameter": 2*BORE_RADIUS,
        "bossCenters": [[x, y, WALL] for x, y in points],
        "stages": stages,
        "files": {"step": {"file": str(step_path.relative_to(ROOT)), "sha256": sha256(step_path)}, "stl": {"file": str(stl_path.relative_to(ROOT)), "sha256": sha256(stl_path)}},
        "expected": expected, "measured": measured, "stepReimport": reimported, "mesh": mesh, "checks": checks,
    }


def main():
    global ROOT, WALL, OFFSET, BORE_RADIUS
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text())
    p = request["parameters"]
    width, WALL, OFFSET, bore = (p[k] for k in ("width", "wall", "supportOffset", "bore"))
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (width,WALL,OFFSET,bore)): raise ValueError("finite numeric dimensions required")
    if not (40 <= width <= 1000 and 0 < WALL <= 10 and 0 < bore < 12 and WALL+6 < OFFSET < min(width,80)/2-6 and WALL+8 < 30): raise ValueError("conflicting tray dimensions")
    BORE_RADIUS = bore/2
    ROOT = Path(args.output).resolve()
    ROOT.mkdir(parents=True, exist_ok=False)
    variant = build_variant(width)
    result = {"schema":"timmy.tray-build/1", "engine":f"CadQuery {cq.__version__}", "units":"mm", "parameters":p, "variant":variant, "passed":all(c["passed"] for c in variant["checks"]), "checksTotal":len(variant["checks"])}
    (ROOT/"result.json").write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps({"passed":result["passed"],"checks":len(variant["checks"])}))
    return 0 if result["passed"] else 1

if __name__ == "__main__":
    sys.exit(main())
