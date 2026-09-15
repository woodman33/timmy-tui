#!/usr/bin/env python3
"""Export one source-bound Blender RGB view and native geometry ray samples.

Run only in a dedicated Blender process. Depth is native scene ray-cast camera-Z,
not a renderer depth buffer. All geometric coordinates remain numerical mm.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


WIDTH = HEIGHT = 128
FX = FY = 128.0
CX = CY = 63.5
CAMERA_ID = "box-bore-camera"
OBJECT_ID = "box-bore"
ORIGIN = Vector((0.0, 0.0, 200.0))
PROJECTION_TOLERANCE_PX = 0.001


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def save_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, allow_nan=False, separators=(",", ":"))
        stream.write("\n")


def vector_list(value):
    return [float(component) for component in value]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--out", type=Path, required=True)
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    args = parser.parse_args(arguments)
    if not re.fullmatch(r"[a-f0-9]{64}", args.source_revision):
        raise ValueError("source revision must be a lowercase SHA256 digest")
    source = args.source.resolve(strict=True)
    source_bytes = source.read_bytes()
    source_hash = sha256(source_bytes)
    payload = json.loads(source_bytes)
    if payload.get("schema") != "timmy.spatial-volume.mesh/1" or payload.get("units") != "mm":
        raise ValueError("expected the retained spatial-volume mesh in mm")
    positions, indices = payload.get("positions"), payload.get("triangles")
    if not isinstance(positions, list) or not positions or len(positions) % 3:
        raise ValueError("invalid flat vertex array")
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in positions):
        raise ValueError("nonfinite vertex coordinates")
    if not isinstance(indices, list) or not indices or len(indices) % 3:
        raise ValueError("invalid flat triangle array")
    vertex_count = len(positions) // 3
    if any(type(value) is not int or value < 0 or value >= vertex_count for value in indices):
        raise ValueError("invalid vertex index")
    vertices = [positions[index:index + 3] for index in range(0, len(positions), 3)]
    triangles = [indices[index:index + 3] for index in range(0, len(indices), 3)]
    output = args.out.absolute()
    output.mkdir(parents=True, exist_ok=False)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"
    mesh = bpy.data.meshes.new(OBJECT_ID + "-mesh")
    mesh.from_pydata(vertices, [], triangles)
    mesh.update()
    body = bpy.data.objects.new(OBJECT_ID, mesh)
    scene.collection.objects.link(body)
    body.color = (0.025, 0.48, 0.44, 1.0)
    body["source_revision"] = args.source_revision
    body["source_mesh_sha256"] = source_hash
    body["source_units"] = "mm"
    material = bpy.data.materials.new("display-teal")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = body.color
    emission.inputs["Strength"].default_value = 1.0
    material_output = nodes.new("ShaderNodeOutputMaterial")
    material.node_tree.links.new(emission.outputs["Emission"], material_output.inputs["Surface"])
    body.data.materials.append(material)
    for polygon in mesh.polygons:
        polygon.use_smooth = False

    camera_data = bpy.data.cameras.new(CAMERA_ID)
    camera_data.type = "PERSP"
    camera_data.lens = 32.0
    camera_data.sensor_width = 32.0
    camera_data.sensor_height = 32.0
    camera_data.sensor_fit = "HORIZONTAL"
    camera_data.shift_x = camera_data.shift_y = 0.0
    camera_data.clip_start = 0.1
    camera_data.clip_end = 1000.0
    camera_data.dof.use_dof = False
    camera = bpy.data.objects.new(CAMERA_ID, camera_data)
    scene.collection.objects.link(camera)
    camera.location = ORIGIN
    camera.rotation_euler = (0.0, 0.0, 0.0)
    scene.camera = camera
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 8
    scene.cycles.use_denoising = False
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 4
    scene.render.resolution_x = WIDTH
    scene.render.resolution_y = HEIGHT
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1.0
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.filepath = str(output / "rgb.png")
    scene.view_settings.view_transform = "Standard"
    bpy.context.view_layer.update()

    depsgraph = bpy.context.evaluated_depsgraph_get()
    depths, object_ids, hit_points = [], [], []
    maximum_projection_error = 0.0
    for y in range(HEIGHT):
        for x in range(WIDTH):
            direction = Vector(((x - CX) / FX, -(y - CY) / FY, -1.0)).normalized()
            hit, point, normal, face, hit_object, _matrix = scene.ray_cast(
                depsgraph, ORIGIN, direction, distance=camera_data.clip_end)
            associated = hit and hit_object is not None and hit_object.original == body
            if not associated:
                depths.append(None)
                object_ids.append(None)
                hit_points.append(None)
                continue
            z = float(ORIGIN.z - point.z)
            if not math.isfinite(z) or z <= 0:
                raise ValueError("invalid camera-Z at native hit")
            projected = world_to_camera_view(scene, camera, point)
            pixel = (projected.x * WIDTH - 0.5, (1.0 - projected.y) * HEIGHT - 0.5)
            error = max(abs(pixel[0] - x), abs(pixel[1] - y))
            maximum_projection_error = max(maximum_projection_error, error)
            if error > PROJECTION_TOLERANCE_PX:
                raise ValueError("native camera projection disagrees with pixel-center ray")
            depths.append(z)
            object_ids.append(0)
            hit_points.append({"pointWorldMm": vector_list(point), "normalWorld": vector_list(normal),
                               "objectId": OBJECT_ID, "polygonIndex": int(face),
                               "rayRangeMm": float((point - ORIGIN).length)})
    selected = [84, 64]
    if object_ids[selected[1] * WIDTH + selected[0]] != 0:
        raise ValueError("selected pixel did not hit the retained object")
    common = {"sourceRevision": args.source_revision, "cameraId": CAMERA_ID,
              "imageSize": [WIDTH, HEIGHT], "provenance": "generated",
              "alignment": "rectified-camera-grid"}
    grounding = {
        "schema": "timmy.voxel-image-grounding/1", "sourceRevision": args.source_revision,
        "expectedSourceRevision": args.source_revision, "sourceProvenance": "generated",
        "detection": {"pixel": selected, "imageSize": [WIDTH, HEIGHT]},
        "camera": {"id": CAMERA_ID, "frameId": "fixture", "sourceRevision": args.source_revision,
                   "provenance": "generated", "imageSize": [WIDTH, HEIGHT],
                   "pixelConvention": "integer-pixel-centers", "projection": "rectified-pinhole",
                   "axes": "x-right-y-down-z-forward", "units": "mm",
                   "intrinsics": {"fx": FX, "fy": FY, "cx": CX, "cy": CY},
                   "cameraToWorld": {"rotationRows": [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
                                     "translationMm": vector_list(ORIGIN)}},
        "depth": {**common, "quantity": "camera-z", "units": "mm", "metricScale": "known", "values": depths},
        "objectIds": {**common, "objects": [OBJECT_ID], "values": object_ids},
    }
    save_json(output / "grounding-input.json", grounding)
    save_json(output / "ray-hit-points.json", {
        "schema": "timmy.native-view.ray-hits/1", "sourceRevision": args.source_revision,
        "cameraId": CAMERA_ID, "imageSize": [WIDTH, HEIGHT], "units": "mm",
        "order": "row-major", "pixels": hit_points})
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"), check_existing=False)
    bpy.ops.render.render(write_still=True)
    rendered = bpy.data.images.load(str(output / "rgb.png"), check_existing=False)
    if tuple(rendered.size) != (WIDTH, HEIGHT):
        raise ValueError("saved RGB image dimensions changed")
    rgba = list(rendered.pixels[:])
    alpha = [float(rgba[((HEIGHT - 1 - y) * WIDTH + x) * 4 + 3])
             for y in range(HEIGHT) for x in range(WIDTH)]
    save_json(output / "rgb-alpha.json", {
        "schema": "timmy.native-view.alpha/1", "sourceRevision": args.source_revision,
        "cameraId": CAMERA_ID, "imageSize": [WIDTH, HEIGHT], "order": "row-major", "values": alpha})
    mask_disagreements = sum((value >= 0.5) != (object_id is not None)
                             for value, object_id in zip(alpha, object_ids))
    if source.read_bytes() != source_bytes:
        raise ValueError("source mesh changed during capture")
    artifact_names = ["rgb.png", "scene.blend", "grounding-input.json", "ray-hit-points.json", "rgb-alpha.json"]
    artifacts = {}
    for name in artifact_names:
        data = (output / name).read_bytes()
        if not data:
            raise ValueError("empty output artifact: " + name)
        artifacts[name] = {"sha256": sha256(data), "bytes": len(data)}
    save_json(output / "capture-metadata.json", {
        "schema": "timmy.native-view.capture/1", "status": "captured",
        "sourceRevision": args.source_revision, "source": str(source),
        "sourceSha256": source_hash, "sourceBytes": len(source_bytes), "sourceUnchanged": True,
        "sourceRevisionBasis": "caller-supplied retained package digest; distinct from source mesh byte digest",
        "blenderVersion": bpy.app.version_string, "engine": scene.render.engine,
        "imageSize": [WIDTH, HEIGHT], "cameraId": CAMERA_ID, "objectIds": [OBJECT_ID],
        "vertices": vertex_count, "triangles": len(triangles), "hitCount": sum(value is not None for value in depths),
        "depthMethod": "native evaluated Blender scene ray_cast, camera-Z in mm; not renderer depth buffer",
        "rgbMethod": "native Cycles CPU render, 8 samples, 4 threads, opaque teal emission, transparent background",
        "objectTransform": {"units": "mm", "matrixRows": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]},
        "alphaReadback": {"method": "saved PNG decoded by Blender image loader, converted to top-left row-major",
                          "threshold": 0.5, "maskDisagreements": mask_disagreements,
                          "pixelCount": WIDTH * HEIGHT, "independentlyVerified": False},
        "pixelConvention": "integer-pixel-centers; row-major; image origin top-left",
        "projectionCheck": {"method": "world_to_camera_view at every native hit",
                            "maximumErrorPixels": maximum_projection_error,
                            "tolerancePixels": PROJECTION_TOLERANCE_PX, "passed": True},
        "limitations": ["Generated analytic fixture reconstructed by OpenVDB; not a physical measurement.",
                        "RGB raster and geometric center rays require independent alignment verification.",
                        "No depth return or object association remains unknown, never empty.",
                        "Display color does not establish physical material or density."],
        "artifacts": artifacts})
    print(json.dumps({"status": "captured", "out": str(output), "sourceRevision": args.source_revision,
                      "sourceUnchanged": True, "hitCount": sum(value is not None for value in depths)}, allow_nan=False))


if __name__ == "__main__":
    main()
