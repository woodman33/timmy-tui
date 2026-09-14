# Blender · usd-export. blender -b --factory-startup --python script.py -- <drop file> <out dir> <stem>
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

out = os.path.join(out_dir, f"{stem}.usdc")
bpy.ops.wm.usd_export(filepath=out, export_materials=True, export_uvmaps=True, export_normals=True)

with open(out, "rb") as f:
    magic = f.read(8)
report = {
    "input": src,
    "objects": len(meshes),
    "prims": [f"/root/{o.name}" for o in meshes],
    "usd": out,
    "usd_bytes": os.path.getsize(out),
    "magic_ok": magic.startswith(b"PXR-USDC"),
    "blender": bpy.app.version_string,
}
with open(os.path.join(out_dir, f"{stem}.usd.json"), "w") as f:
    json.dump(report, f, indent=1)
if not report["magic_ok"]:
    raise SystemExit("exported file is not a USD crate")
print(json.dumps(report))
