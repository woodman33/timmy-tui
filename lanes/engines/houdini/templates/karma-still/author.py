# Houdini · karma-still, step 1. Runs headless: hython author.py <drop file> <out dir> <stem>
#
# Authors <stem>.karma.usdc: the dropped mesh (obj/ply/geo/bgeo via a File SOP), a
# dropped USD layer (flattened in), or a primitive from a .json spec, plus a rig
# under /shelf_rig — a camera framed on the bounding sphere, a dome light and a
# distant key light — and a RenderSettings prim. Step 2 (husk) renders one frame
# from /shelf_rig/cam; step 3 (report.mjs) verifies the PNG and finishes the report.
import json
import math
import os
import sys
import time

import hou
from pxr import Gf, Sdf, Usd, UsdGeom, UsdLux, UsdRender, Vt

T0 = time.time()
src, out_dir, stem = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out_dir, exist_ok=True)
ext = os.path.splitext(src)[1].lower()
RES = (512, 384)
SAMPLES = 16
CAMERA = "/shelf_rig/cam"

DEFAULTS = {"base": "sphere", "size": 2.0, "color": [0.8, 0.5, 0.2], "dome": 0.5, "key": 3.0, "source": None}
spec = dict(DEFAULTS)
notes = []
if ext == ".json":
    with open(src) as f:
        loaded = json.load(f)
    spec.update({k: v for k, v in loaded.items() if k in DEFAULTS})
    if spec["source"]:
        cand = spec["source"] if os.path.isabs(spec["source"]) else os.path.join(os.path.dirname(src), spec["source"])
        if os.path.exists(cand):
            spec["source"] = cand
        else:
            notes.append(f"source {spec['source']} not found beside the spec; using the {spec['base']} base instead")
            spec["source"] = None

scene_path = os.path.join(out_dir, f"{stem}.karma.usdc")
stats = {"points": None, "faces": None}

if ext in (".usd", ".usda", ".usdc"):
    source_kind = "usd"
    src_stage = Usd.Stage.Open(src)
    if src_stage is None:
        raise SystemExit(f"could not open {src}")
    stage = Usd.Stage.Open(src_stage.Flatten())  # self-contained: nothing references the drop file afterwards
    meshes = [p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh)]
    stats["faces"] = sum(len(UsdGeom.Mesh(p).GetFaceVertexCountsAttr().Get() or []) for p in meshes)
    stats["points"] = sum(len(UsdGeom.Mesh(p).GetPointsAttr().Get() or []) for p in meshes)
    stats["meshes"] = len(meshes)
    if not meshes:
        raise SystemExit("the dropped layer has no UsdGeom.Mesh prims")
    cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_, UsdGeom.Tokens.render])
    rng = cache.ComputeWorldBound(stage.GetPseudoRoot()).ComputeAlignedRange()
    lo, hi = Gf.Vec3d(rng.GetMin()), Gf.Vec3d(rng.GetMax())
else:
    source_kind = "spec" if ext == ".json" else "mesh"
    geo_node = hou.node("/obj").createNode("geo", "subject")
    mesh_src = spec["source"] if ext == ".json" else src
    if mesh_src:
        base = geo_node.createNode("file", "source")
        base.parm("file").set(mesh_src)
        stats["source"] = os.path.basename(mesh_src)
    else:
        kind = spec["base"] if spec["base"] in ("box", "sphere", "torus", "grid") else "sphere"
        size = float(spec["size"])
        base = geo_node.createNode(kind, "base")
        if kind == "box":
            base.parmTuple("size").set((size, size, size))
        elif kind == "sphere":
            base.parm("type").set("polymesh")
            base.parmTuple("rad").set((size / 2,) * 3)
            base.parm("rows").set(24)
            base.parm("cols").set(36)
        elif kind == "torus":
            base.parm("type").set("polymesh")
            base.parmTuple("rad").set((size / 2, size / 5))
            base.parm("rows").set(24)
            base.parm("cols").set(48)
        elif kind == "grid":
            base.parmTuple("size").set((size, size))
        stats["source"] = "primitive:" + kind
    polys = geo_node.createNode("convert", "to_polygons")
    polys.setInput(0, base)
    normals = geo_node.createNode("normal", "normals")
    normals.setInput(0, polys)
    normals.parm("type").set(1)
    out_sop = geo_node.createNode("null", "OUT")
    out_sop.setInput(0, normals)
    out_sop.cook(force=True)
    if out_sop.errors():
        raise SystemExit("cook errors: " + "; ".join(out_sop.errors()))
    geo = out_sop.geometry()
    if geo.intrinsicValue("primitivecount") == 0:
        raise SystemExit("no primitives to render")

    stage = Usd.Stage.CreateNew(scene_path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    world = UsdGeom.Xform.Define(stage, "/World")
    stage.SetDefaultPrim(world.GetPrim())
    points = [(p[0], p[1], p[2]) for p in (pt.position() for pt in geo.points())]
    has_n = geo.findVertexAttrib("N") is not None
    has_cd = geo.findPointAttrib("Cd") is not None
    counts, indices, nrm = [], [], []
    for prim in geo.prims():
        if prim.type() != hou.primType.Polygon:
            continue
        verts = list(prim.vertices())
        if len(verts) < 3:
            continue
        verts.reverse()  # Houdini winds the opposite way to USD's rightHanded default
        counts.append(len(verts))
        for v in verts:
            indices.append(v.point().number())
            if has_n:
                nrm.append(tuple(v.attribValue("N")))
    mesh = UsdGeom.Mesh.Define(stage, "/World/subject")
    mesh.CreatePointsAttr(Vt.Vec3fArray(points))
    mesh.CreateFaceVertexCountsAttr(Vt.IntArray(counts))
    mesh.CreateFaceVertexIndicesAttr(Vt.IntArray(indices))
    mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    bb = geo.boundingBox()
    lo, hi = Gf.Vec3d(*bb.minvec()), Gf.Vec3d(*bb.maxvec())
    mesh.CreateExtentAttr(Vt.Vec3fArray([Gf.Vec3f(lo), Gf.Vec3f(hi)]))
    if nrm:
        mesh.CreateNormalsAttr(Vt.Vec3fArray(nrm))
        mesh.SetNormalsInterpolation(UsdGeom.Tokens.faceVarying)
    if has_cd:
        mesh.CreateDisplayColorPrimvar(UsdGeom.Tokens.vertex).Set(Vt.Vec3fArray([tuple(pt.attribValue("Cd")) for pt in geo.points()]))
    else:
        mesh.CreateDisplayColorPrimvar(UsdGeom.Tokens.constant).Set(Vt.Vec3fArray([Gf.Vec3f(*[float(c) for c in spec["color"]])]))
    stats.update({"points": len(points), "faces": len(counts), "meshes": 1})

# ---- rig: camera on the bounding sphere, dome + key light, render settings
center = (lo + hi) / 2
radius = max((hi - lo).GetLength() / 2, 1e-3)
focal, h_ap = 35.0, 36.0
v_ap = h_ap * RES[1] / RES[0]
vfov = 2 * math.atan(v_ap / 2 / focal)
dist = radius / math.sin(vfov / 2) * 1.15
direction = Gf.Vec3d(1.0, 0.75, 1.25).GetNormalized()
eye = center + direction * dist
rig = UsdGeom.Xform.Define(stage, "/shelf_rig")
cam = UsdGeom.Camera.Define(stage, CAMERA)
cam.CreateFocalLengthAttr(focal)
cam.CreateHorizontalApertureAttr(h_ap)
cam.CreateVerticalApertureAttr(v_ap)
cam.CreateClippingRangeAttr(Gf.Vec2f(max(0.01, dist * 0.01), dist * 10))
UsdGeom.Xformable(cam).AddTransformOp().Set(Gf.Matrix4d().SetLookAt(eye, center, Gf.Vec3d(0, 1, 0)).GetInverse())
dome = UsdLux.DomeLight.Define(stage, "/shelf_rig/lights/dome")
dome.CreateIntensityAttr(float(spec["dome"]))
key = UsdLux.DistantLight.Define(stage, "/shelf_rig/lights/key")
key.CreateIntensityAttr(float(spec["key"]))
key.CreateAngleAttr(2.0)
UsdGeom.Xformable(key).AddRotateXYZOp().Set(Gf.Vec3f(-40.0, 30.0, 0.0))
settings = UsdRender.Settings.Define(stage, "/Render/settings")
settings.CreateResolutionAttr(Gf.Vec2i(*RES))
settings.CreateCameraRel().SetTargets([Sdf.Path(CAMERA)])
stage.SetMetadata("renderSettingsPrimPath", "/Render/settings")
stage.GetRootLayer().Export(scene_path) if stage.GetRootLayer().anonymous else stage.GetRootLayer().Save()

license_name = hou.licenseCategory().name()
report = {
    "kind": "houdini.karma-still",
    "input": os.path.basename(src),
    "source_kind": source_kind,
    "spec": spec if ext == ".json" else None,
    "scene": os.path.basename(scene_path),
    "scene_bytes": os.path.getsize(scene_path),
    "camera": CAMERA,
    "camera_eye": [round(v, 4) for v in eye],
    "bbox": [[round(v, 4) for v in lo], [round(v, 4) for v in hi]],
    "lights": ["/shelf_rig/lights/dome", "/shelf_rig/lights/key"],
    "resolution": list(RES),
    "samples": SAMPLES,
    "renderer": "BRAY_HdKarma (Karma CPU)",
    "watermark": license_name in ("Apprentice", "ApprenticeHD", "Education"),
    "usd": ".".join(str(v) for v in Usd.GetVersion()),
    "houdini": hou.applicationVersionString(),
    "license": license_name,
    "notes": notes,
    "author_ms": int((time.time() - T0) * 1000),
    **stats,
}
with open(os.path.join(out_dir, f"{stem}.karma.json"), "w") as f:
    json.dump(report, f, indent=1)
print(json.dumps(report))
