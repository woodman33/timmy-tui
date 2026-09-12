# Blender · glb-export. blender -b --factory-startup --python script.py -- <drop file> <out dir> <stem>
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
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    elif ext in (".gltf", ".glb"):
        bpy.ops.import_scene.gltf(filepath=src)
    else:
        raise SystemExit(f"unsupported input {ext}")

meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes:
    raise SystemExit("no mesh objects to export")
for o in bpy.context.scene.objects:
    o.select_set(o.type == "MESH")

out = os.path.join(out_dir, f"{stem}.glb")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True)

with open(out, "rb") as f:
    magic = f.read(4)
report = {
    "input": src,
    "objects": len(meshes),
    "vertices": sum(len(o.data.vertices) for o in meshes),
    "glb": out,
    "glb_bytes": os.path.getsize(out),
    "magic_ok": magic == b"glTF",
    "blender": bpy.app.version_string,
}
with open(os.path.join(out_dir, f"{stem}.glb.json"), "w") as f:
    json.dump(report, f, indent=1)
if not report["magic_ok"]:
    raise SystemExit("exported file is not a glTF binary")
print(json.dumps(report))
