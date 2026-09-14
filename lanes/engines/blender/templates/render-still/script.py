# Blender · render-still. Runs headless: blender -b --factory-startup --python script.py -- <drop file> <out dir> <stem>
import json
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src, out_dir, stem = argv[0], argv[1], argv[2]
os.makedirs(out_dir, exist_ok=True)
ext = os.path.splitext(src)[1].lower()

if ext == ".blend":
    bpy.ops.wm.open_mainfile(filepath=src)
else:
    # fresh scene: drop the default cube, keep the world
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=src)
    else:
        raise SystemExit(f"unsupported input {ext}")

scene = bpy.context.scene
meshes = [o for o in scene.objects if o.type == "MESH"]
if not meshes:
    raise SystemExit("no mesh objects after import")

# frame everything: bounding sphere of all mesh vertices in world space
import mathutils  # noqa: E402

pts = []
for o in meshes:
    for v in o.bound_box:
        pts.append(o.matrix_world @ mathutils.Vector(v))
lo = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
center = (lo + hi) / 2
radius = max((hi - lo).length / 2, 0.001)

cam = scene.camera
if cam is None:
    cam_data = bpy.data.cameras.new("ShelfCamera")
    cam = bpy.data.objects.new("ShelfCamera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
direction = mathutils.Vector((1.0, -1.2, 0.8)).normalized()
cam.location = center + direction * radius * 3.2
cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.data.clip_end = max(100.0, radius * 20)

if not any(o.type == "LIGHT" for o in scene.objects):
    light_data = bpy.data.lights.new("ShelfKey", type="SUN")
    light_data.energy = 3.0
    light = bpy.data.objects.new("ShelfKey", light_data)
    scene.collection.objects.link(light)
    light.rotation_euler = (0.9, 0.2, 0.6)

# Blender 5.x names the realtime engine BLENDER_EEVEE; fall back to Workbench when a build lacks it
for engine_name in ("BLENDER_EEVEE", "BLENDER_WORKBENCH"):
    try:
        scene.render.engine = engine_name
        break
    except TypeError:
        continue
scene.render.resolution_x = 1024
scene.render.resolution_y = 768
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(out_dir, f"{stem}.render.png")
bpy.ops.render.render(write_still=True)

blend_path = os.path.join(out_dir, f"{stem}.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend_path, copy=True)

report = {
    "input": src,
    "objects": len(meshes),
    "vertices": sum(len(o.data.vertices) for o in meshes),
    "camera": cam.name,
    "resolution": [scene.render.resolution_x, scene.render.resolution_y],
    "render_engine": scene.render.engine,
    "blender": bpy.app.version_string,
    "outputs": [scene.render.filepath, blend_path],
}
with open(os.path.join(out_dir, f"{stem}.render.json"), "w") as f:
    json.dump(report, f, indent=1)
print(json.dumps(report))
