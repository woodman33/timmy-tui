# Houdini · usd-export. Runs headless: hython script.py <drop file> <out dir> <stem>
#
# Loads the dropped mesh through a File SOP (so anything Houdini reads works: obj,
# ply, geo, bgeo), converts to polygons, adds vertex normals, and writes one
# UsdGeom.Mesh to <stem>.usdc through pxr directly. The LOP USD ROP is avoided on
# purpose: under an Apprentice licence it silently renames its output to .usdnc.
import json
import os
import sys
import time

import hou
from pxr import Gf, Sdf, Usd, UsdGeom, Vt

T0 = time.time()
src, out_dir, stem = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out_dir, exist_ok=True)

geo_node = hou.node("/obj").createNode("geo", "export")
file_sop = geo_node.createNode("file", "source")
file_sop.parm("file").set(src)
polys = geo_node.createNode("convert", "to_polygons")
polys.setInput(0, file_sop)
normals = geo_node.createNode("normal", "normals")
normals.setInput(0, polys)
normals.parm("type").set(1)  # vertex normals keep hard edges
out_sop = geo_node.createNode("null", "OUT")
out_sop.setInput(0, normals)
out_sop.cook(force=True)
if out_sop.errors():
    raise SystemExit("cook errors: " + "; ".join(out_sop.errors()))
geo = out_sop.geometry()
if geo.intrinsicValue("primitivecount") == 0:
    raise SystemExit(f"no primitives loaded from {src}")

# ---- hou.Geometry → UsdGeom.Mesh
prim_name = "".join(c if c.isalnum() or c == "_" else "_" for c in stem)
if not prim_name or prim_name[0].isdigit():
    prim_name = "mesh_" + prim_name
usd_path = os.path.join(out_dir, f"{stem}.usdc")
stage = Usd.Stage.CreateNew(usd_path)
UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
UsdGeom.SetStageMetersPerUnit(stage, 1.0)
root = UsdGeom.Xform.Define(stage, f"/{prim_name}")
stage.SetDefaultPrim(root.GetPrim())
Usd.ModelAPI(root.GetPrim()).SetKind("component")

points = [(p[0], p[1], p[2]) for p in (pt.position() for pt in geo.points())]
has_n = geo.findVertexAttrib("N") is not None
has_uv = geo.findVertexAttrib("uv") is not None or geo.findPointAttrib("uv") is not None
uv_on_vertex = geo.findVertexAttrib("uv") is not None
has_cd = geo.findPointAttrib("Cd") is not None
counts, indices, nrm, uvs = [], [], [], []
skipped = 0
for prim in geo.prims():
    if prim.type() != hou.primType.Polygon:
        skipped += 1
        continue
    verts = list(prim.vertices())
    if len(verts) < 3:
        skipped += 1
        continue
    verts.reverse()  # Houdini winds polygons the opposite way to USD's default rightHanded orientation
    counts.append(len(verts))
    for v in verts:
        indices.append(v.point().number())
        if has_n:
            nrm.append(tuple(v.attribValue("N")))
        if has_uv:
            uv = v.attribValue("uv") if uv_on_vertex else v.point().attribValue("uv")
            uvs.append((uv[0], uv[1]))

mesh = UsdGeom.Mesh.Define(stage, f"/{prim_name}/mesh")
mesh.CreatePointsAttr(Vt.Vec3fArray(points))
mesh.CreateFaceVertexCountsAttr(Vt.IntArray(counts))
mesh.CreateFaceVertexIndicesAttr(Vt.IntArray(indices))
mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
bb = geo.boundingBox()
mesh.CreateExtentAttr(Vt.Vec3fArray([Gf.Vec3f(*bb.minvec()), Gf.Vec3f(*bb.maxvec())]))
if nrm:
    mesh.CreateNormalsAttr(Vt.Vec3fArray(nrm))
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.faceVarying)
pv = UsdGeom.PrimvarsAPI(mesh.GetPrim())
if uvs:
    st = pv.CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.faceVarying)
    st.Set(Vt.Vec2fArray(uvs))
if has_cd:
    cd = [tuple(pt.attribValue("Cd")) for pt in geo.points()]
    mesh.CreateDisplayColorPrimvar(UsdGeom.Tokens.vertex).Set(Vt.Vec3fArray(cd))
else:
    mesh.CreateDisplayColorPrimvar(UsdGeom.Tokens.constant).Set(Vt.Vec3fArray([Gf.Vec3f(0.75, 0.75, 0.75)]))
stage.GetRootLayer().Save()

# ---- integrity: does the authored winding agree with the authored normals?
agree = 0
checked = 0
if nrm:
    k = 0
    for c in counts:
        face = indices[k:k + c]
        n = Gf.Vec3f(0, 0, 0)
        for i in range(c):  # Newell normal of the face in USD order (right-hand rule)
            a = Gf.Vec3f(*points[face[i]])
            b = Gf.Vec3f(*points[face[(i + 1) % c]])
            n += Gf.Vec3f((a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1]))
        avg = Gf.Vec3f(0, 0, 0)
        for j in range(c):
            avg += Gf.Vec3f(*nrm[k + j])
        if n.GetLength() > 0 and avg.GetLength() > 0:
            checked += 1
            if Gf.Dot(n, avg) > 0:
                agree += 1
        k += c

# ---- reopen the file we wrote, as an independent check
re = Usd.Stage.Open(usd_path)
re_mesh = UsdGeom.Mesh(re.GetPrimAtPath(f"/{prim_name}/mesh"))
re_faces = len(re_mesh.GetFaceVertexCountsAttr().Get())

report = {
    "kind": "houdini.usd-export",
    "input": os.path.basename(src),
    "points": len(points),
    "faces": len(counts),
    "face_vertices": len(indices),
    "skipped_prims": skipped,
    "normals": bool(nrm),
    "uv": bool(uvs),
    "color": has_cd,
    "winding_agreement": round(agree / checked, 4) if checked else None,
    "default_prim": f"/{prim_name}",
    "mesh_prim": f"/{prim_name}/mesh",
    "up_axis": "Y",
    "meters_per_unit": 1.0,
    "bbox": [list(bb.minvec()), list(bb.maxvec())],
    "reopened_faces": re_faces,
    "bytes": os.path.getsize(usd_path),
    "usd_format": "usdc via pxr (LOP USD ROP avoided: Apprentice forces .usdnc)",
    "usd": ".".join(str(v) for v in Usd.GetVersion()),
    "houdini": hou.applicationVersionString(),
    "license": hou.licenseCategory().name(),
    "outputs": [os.path.basename(usd_path)],
    "ms": int((time.time() - T0) * 1000),
}
with open(os.path.join(out_dir, f"{stem}.usd.json"), "w") as f:
    json.dump(report, f, indent=1)
print(json.dumps(report))
if re_faces != len(counts):
    raise SystemExit(f"reopened stage has {re_faces} faces, expected {len(counts)}")
