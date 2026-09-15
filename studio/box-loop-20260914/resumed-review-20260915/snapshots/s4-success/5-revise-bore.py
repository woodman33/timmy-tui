#!/usr/bin/env python3
"""Edit a copied native bore, or read it back in a separate Blender process.

Blender --background --factory-startup --python revise-bore.py -- edit|readback
  --source original.blend --out revision.blend --job-id UUID
  --source-sha256 SHA256 --diameter 32 --report new-report.json

Coordinates are numerical millimeters, as in the retained S2 document. The host
owns job admission and the durable idempotency ledger; properties alone do not
prove exactly-once execution. Readback never saves or edits the loaded document.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import uuid

import bpy
from mathutils import Vector


OBJECT_ID = "box-bore"
TOLERANCE_MM = 0.05


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, allow_nan=False, separators=(",", ":"))
        stream.write("\n")


def evaluated_geometry(body):
    bpy.context.view_layer.update()
    evaluated = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        vertices = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
        triangles = [tuple(int(index) for index in triangle.vertices)
                     for triangle in mesh.loop_triangles]
    finally:
        evaluated.to_mesh_clear()
    if not vertices or not triangles:
        raise ValueError("Native evaluated object has no triangle mesh")
    if any(not math.isfinite(component) for vertex in vertices for component in vertex):
        raise ValueError("Native evaluated mesh contains nonfinite coordinates")
    return vertices, triangles


def topology(vertices, triangles):
    edges = Counter()
    adjacency = [set() for _ in vertices]
    for triangle in triangles:
        for first, second in zip(triangle, triangle[1:] + triangle[:1]):
            edge = tuple(sorted((first, second)))
            edges[edge] += 1
            adjacency[first].add(second)
            adjacency[second].add(first)
    remaining = set(range(len(vertices)))
    components = 0
    while remaining:
        components += 1
        stack = [remaining.pop()]
        while stack:
            for neighbour in adjacency[stack.pop()]:
                if neighbour in remaining:
                    remaining.remove(neighbour)
                    stack.append(neighbour)
    return {"connectedComponents": components,
            "boundaryEdges": sum(count == 1 for count in edges.values()),
            "nonManifoldEdges": sum(count != 2 for count in edges.values()),
            "edges": len(edges)}


def triangle_ray_distance(direction, vertices, triangles):
    """Independent Moller-Trumbore calculation, not Blender's ray_cast API."""
    nearest = None
    for indices in triangles:
        a, b, c = (vertices[index] for index in indices)
        edge1, edge2 = b - a, c - a
        cross = direction.cross(edge2)
        determinant = edge1.dot(cross)
        if abs(determinant) < 1e-10:
            continue
        inverse = 1.0 / determinant
        offset = -a  # Ray origin is (0, 0, 0), inside the through-bore.
        u = offset.dot(cross) * inverse
        if u < -1e-7 or u > 1.0 + 1e-7:
            continue
        q = offset.cross(edge1)
        v = direction.dot(q) * inverse
        if v < -1e-7 or u + v > 1.0 + 1e-7:
            continue
        distance = edge2.dot(q) * inverse
        if distance > 1e-6 and (nearest is None or distance < nearest):
            nearest = float(distance)
    return nearest


def inspect_mesh(body, diameter):
    vertices, triangles = evaluated_geometry(body)
    minimum = [min(vertex[axis] for vertex in vertices) for axis in range(3)]
    maximum = [max(vertex[axis] for vertex in vertices) for axis in range(3)]
    dimensions = [high - low for high, low in zip(maximum, minimum)]
    topology_result = topology(vertices, triangles)
    # Four axes plus eight diagonal directions, with every ray's opposite present.
    angles = [0.0, 90.0, 180.0, 270.0] + [22.5 + 45.0 * index for index in range(8)]
    rays = []
    radius_by_angle = {}
    for angle in angles:
        radians = math.radians(angle)
        direction = Vector((math.cos(radians), math.sin(radians), 0.0))
        radius = triangle_ray_distance(direction, vertices, triangles)
        radius_by_angle[angle] = radius
        rays.append({"angleDegrees": angle, "originMm": [0.0, 0.0, 0.0],
                     "direction": list(direction), "radiusMm": radius,
                     "hitPointMm": list(direction * radius) if radius is not None else None})
    paired = [{"angleDegrees": angle,
               "diameterMm": radius_by_angle[angle] + radius_by_angle[angle + 180.0]
               if radius_by_angle[angle] is not None and radius_by_angle[angle + 180.0] is not None else None}
              for angle in angles if angle < 180.0]
    geometry_bytes = json.dumps({"vertices": [list(vertex) for vertex in vertices],
                                 "triangles": triangles}, allow_nan=False,
                                separators=(",", ":")).encode("utf-8")
    passed = (all(radius is not None and abs(radius - diameter / 2.0) <= TOLERANCE_MM
                  for radius in radius_by_angle.values())
              and all(abs(size - 80.0) <= TOLERANCE_MM for size in dimensions)
              and all(abs(value + 40.0) <= TOLERANCE_MM for value in minimum)
              and all(abs(value - 40.0) <= TOLERANCE_MM for value in maximum)
              and topology_result["connectedComponents"] == 1
              and topology_result["nonManifoldEdges"] == 0)
    return {"passed": passed, "vertices": len(vertices), "triangles": len(triangles),
            "evaluatedWorldMeshSha256": hashlib.sha256(geometry_bytes).hexdigest(),
            "boundsMm": {"minimum": minimum, "maximum": maximum, "dimensions": dimensions},
            "topology": topology_result, "toleranceMm": TOLERANCE_MM,
            "rayMethod": "Independent Moller-Trumbore over native evaluated world-space triangles",
            "rays": rays, "diameters": paired,
            "axisDiametersMm": {"x": paired[0]["diameterMm"], "y": paired[1]["diameterMm"]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("edit", "readback"))
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--diameter", type=float, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--hold-seconds", type=int, choices=(0,30), default=0)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    job_match = re.fullmatch(r"bore-(success|recovery)-([a-f0-9-]{36})", args.job_id)
    if not job_match or str(uuid.UUID(job_match.group(2))) != job_match.group(2):
        raise ValueError("job-id must be bore-success-UUID or bore-recovery-UUID")
    if not re.fullmatch(r"[a-f0-9]{64}", args.source_sha256):
        raise ValueError("source-sha256 must be a lowercase SHA256 digest")
    if args.diameter != 32.0:
        raise ValueError("This admitted edit is limited to a 32 mm bore")
    source, output, report_path = args.source.resolve(strict=True), args.out.resolve(), args.report.resolve()
    if output == source or report_path in (source, output):
        raise ValueError("Source, output, and report must be distinct")
    if report_path.exists() or args.report.is_symlink():
        raise ValueError("Report must be new")
    if not output.parent.is_dir() or not report_path.parent.is_dir():
        raise ValueError("Host must create the output and report directories")
    report = {"schema": "timmy.native-bore-revision/1", "mode": args.mode,
              "status": "failed", "jobId": args.job_id, "pid": os.getpid(),
              "blenderVersion": bpy.app.version_string, "source": str(source),
              "output": str(output), "sourceSha256": args.source_sha256,
              "targetDiameterMm": args.diameter, "units": "mm",
              "exactlyOnceBasis": "Host job ledger plus reopened native properties; properties alone are insufficient"}
    try:
        if digest(source) != args.source_sha256:
            raise ValueError("Source document digest does not match admission")
        if args.mode == "edit" and (output.exists() or args.out.is_symlink()):
            raise ValueError("Revision document already exists; edit refused")
        document = source if args.mode == "edit" else output.resolve(strict=True)
        revision_before = digest(document)
        bpy.ops.wm.open_mainfile(filepath=str(document), load_ui=False, use_scripts=False)
        scene = bpy.context.scene
        if scene.unit_settings.system != "METRIC" or abs(scene.unit_settings.scale_length - 0.001) > 1e-9:
            raise ValueError("Expected retained S2 numerical millimeter units")
        body = bpy.data.objects.get(OBJECT_ID)
        if body is None or body.type != "MESH" or body.name not in scene.objects:
            raise ValueError("Native box-bore mesh is absent")
        report["sourceMeshSha256"] = body.get("source_mesh_sha256")
        report["sourceRevision"] = body.get("source_revision")
        if args.mode == "edit":
            if int(body.get("edit_count", 0)) != 0 or body.get("timmy_job_id") is not None:
                raise ValueError("Source already has a native job/edit marker")
            bpy.ops.object.select_all(action="DESELECT")
            bpy.ops.mesh.primitive_cylinder_add(vertices=256, radius=16.0, depth=120.0,
                                                end_fill_type="NGON", location=(0.0, 0.0, 0.0))
            cutter = bpy.context.object
            cutter.name = "timmy-owned-bore-cutter-" + args.job_id
            modifier = body.modifiers.new(name="timmy-bore-32mm", type="BOOLEAN")
            modifier.operation = "DIFFERENCE"
            modifier.solver = "EXACT"
            modifier.object = cutter
            bpy.ops.object.select_all(action="DESELECT")
            body.select_set(True)
            bpy.context.view_layer.objects.active = body
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            cutter_mesh = cutter.data
            bpy.data.objects.remove(cutter, do_unlink=True)
            if cutter_mesh.users == 0:
                bpy.data.meshes.remove(cutter_mesh)
            body["timmy_job_id"] = args.job_id
            body["source_sha256"] = args.source_sha256
            body["edit_count"] = 1
            body["target_diameter_mm"] = args.diameter
            report["geometry"] = inspect_mesh(body, args.diameter)
            if not report["geometry"]["passed"]:
                raise ValueError("Edited native mesh failed bore/bounds/topology checks")
            if digest(source) != args.source_sha256:
                raise ValueError("Source changed before revision save")
            save_json(output.parent / 'native-edit-started.json', {
                'job_id': args.job_id, 'pid': os.getpid(), 'parentPid': os.getppid(),
                'phase': 'geometry-edited-before-publication', 'at': time.time(),
                'holdSeconds': args.hold_seconds})
            if args.hold_seconds:
                time.sleep(args.hold_seconds)
            # Save natively in an owned temporary directory, then publish with an
            # exclusive hard link: an existing destination is never overwritten.
            with tempfile.TemporaryDirectory(prefix=".timmy-bore-", dir=output.parent) as staging:
                staged = Path(staging) / output.name
                bpy.ops.wm.save_as_mainfile(filepath=str(staged), check_existing=False)
                os.link(staged, output)
            report["editApplied"] = True
            report["solver"] = "EXACT"
            report["cutterVertices"] = 256
            report["cutterDepthMm"] = 120.0
        else:
            report["geometry"] = inspect_mesh(body, args.diameter)
            report["revisionUnchanged"] = digest(output) == revision_before
            report["editApplied"] = False
            if not report["geometry"]["passed"] or not report["revisionUnchanged"]:
                raise ValueError("Reopened native mesh or unchanged-document check failed")
        properties = {name: body.get(name) for name in
                      ("timmy_job_id", "source_sha256", "edit_count", "target_diameter_mm")}
        report["objectProperties"] = properties
        if properties != {"timmy_job_id": args.job_id, "source_sha256": args.source_sha256,
                          "edit_count": 1, "target_diameter_mm": args.diameter}:
            raise ValueError("Native job/source/edit-count properties do not match admission")
        report["sourceUnchanged"] = digest(source) == args.source_sha256
        if not report["sourceUnchanged"]:
            raise ValueError("Original native source changed")
        report["outputSha256"] = digest(output)
        report["status"] = "ok"
    except Exception as error:
        report["error"] = str(error)
        report["sourceUnchanged"] = source.is_file() and digest(source) == args.source_sha256
    report["passed"] = report["status"] == "ok" and report.get("geometry", {}).get("passed") is True
    save_json(report_path, report)
    print(json.dumps({"status": report["status"], "mode": args.mode,
                      "jobId": args.job_id, "report": str(report_path)}))
    return 0 if report["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
