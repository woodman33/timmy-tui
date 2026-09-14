# Houdini · procedural-asset. Runs headless: hython script.py <drop file> <out dir> <stem>
#
# Builds a small SOP network from a dropped .obj (the base mesh) or a params .json
# (a primitive base, optionally pointing at a source mesh beside it): facet-extrude
# the base, scatter studs on its surface, union them with a Boolean, and save the
# result as <stem>.bgeo.sc plus the scene (.hipnc under Apprentice, .hiplc under
# Indie, .hip on a commercial licence) and an <stem>.asset.json report.
import json
import os
import sys
import time

import hou

T0 = time.time()
src, out_dir, stem = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out_dir, exist_ok=True)
ext = os.path.splitext(src)[1].lower()

DEFAULTS = {
    "base": "box",       # box | sphere | torus | grid — used when no source mesh is given
    "size": 2.0,         # base primitive size (world units)
    "seed": 1,           # scatter seed
    "scatter": 48,       # number of studs scattered on the surface
    "stud": 0.12,        # stud radius
    "extrude": 0.08,     # facet extrude distance
    "inset": 0.15,       # facet inset
    "boolean": True,     # union the studs into the base (falls back to a merge on failure)
    "subdivide": 0,      # subdivision iterations applied last (0 = none)
    "source": None,      # a mesh file beside the .json (or absolute); .obj input sets this itself
}
params = dict(DEFAULTS)
notes = []
if ext == ".json":
    with open(src) as f:
        spec = json.load(f)
    params.update({k: v for k, v in spec.items() if k in DEFAULTS})
    if params["source"]:
        cand = params["source"] if os.path.isabs(params["source"]) else os.path.join(os.path.dirname(src), params["source"])
        if os.path.exists(cand):
            params["source"] = cand
        else:
            notes.append(f"source {params['source']} not found beside the spec; using the {params['base']} base instead")
            params["source"] = None
else:
    params["source"] = src

obj = hou.node("/obj")
geo = obj.createNode("geo", "asset")
nodes = []


def add(type_name, name, *inputs):
    n = geo.createNode(type_name, name)
    for i, up in enumerate(inputs):
        n.setInput(i, up)
    nodes.append(n)
    return n


def set_parm(node, name, value):
    p = node.parm(name)
    if p is None:
        return False
    p.set(value)
    return True


size = float(params["size"])
if params["source"]:
    base = add("file", "source")
    set_parm(base, "file", params["source"])
    base_kind = "file:" + os.path.basename(params["source"])
else:
    kind = params["base"] if params["base"] in ("box", "sphere", "torus", "grid") else "box"
    base = add(kind, "base")
    if kind == "box":
        base.parmTuple("size").set((size, size, size))
    elif kind == "sphere":
        set_parm(base, "type", "polymesh")
        base.parmTuple("rad").set((size / 2, size / 2, size / 2))
        set_parm(base, "rows", 12)
        set_parm(base, "cols", 18)
    elif kind == "torus":
        set_parm(base, "type", "polymesh")
        base.parmTuple("rad").set((size / 2, size / 5))
        set_parm(base, "rows", 12)
        set_parm(base, "cols", 24)
    elif kind == "grid":
        base.parmTuple("size").set((size, size))
        set_parm(base, "rows", 8)
        set_parm(base, "cols", 8)
    base_kind = "primitive:" + kind

polys = add("convert", "to_polygons", base)
facets = add("polyextrude", "facets", polys)
set_parm(facets, "dist", float(params["extrude"]))
set_parm(facets, "inset", float(params["inset"]))
scatter = add("scatter", "scatter", facets)
set_parm(scatter, "npts", int(params["scatter"]))
set_parm(scatter, "seed", int(params["seed"]))
stud = add("sphere", "stud")
set_parm(stud, "type", "poly")
stud.parmTuple("rad").set((float(params["stud"]),) * 3)
set_parm(stud, "freq", 2)
studs = add("copytopoints", "studs", stud, scatter)

result = None
boolean_applied = False
if params["boolean"]:
    union = add("boolean", "union", facets, studs)
    set_parm(union, "booleanop", "union")
    try:
        union.cook(force=True)
        if union.geometry().intrinsicValue("primitivecount") > 0 and not union.errors():
            result = union
            boolean_applied = True
        else:
            notes.append("boolean produced no primitives; merged instead")
    except hou.OperationFailed as e:
        notes.append(f"boolean failed ({e}); merged instead")
if result is None:
    result = add("merge", "merge", facets, studs)

if int(params["subdivide"]) > 0:
    sub = add("subdivide", "subdivide", result)
    set_parm(sub, "iterations", int(params["subdivide"]))
    result = sub

normals = add("normal", "normals", result)
set_parm(normals, "type", 1)  # vertex normals keep hard edges
out = add("null", "OUT", normals)
out.setDisplayFlag(True)
out.setRenderFlag(True)
out.cook(force=True)
if out.errors():
    raise SystemExit("cook errors: " + "; ".join(out.errors()))
g = out.geometry()
points = g.intrinsicValue("pointcount")
prims = g.intrinsicValue("primitivecount")
if prims == 0:
    raise SystemExit("the network produced no primitives")
bb = g.boundingBox()

bgeo_path = os.path.join(out_dir, f"{stem}.bgeo.sc")
g.saveToFile(bgeo_path)

license_name = hou.licenseCategory().name()
hip_ext = {"Apprentice": ".hipnc", "ApprenticeHD": ".hipnc", "Education": ".hipnc", "Indie": ".hiplc"}.get(license_name, ".hip")
hip_path = os.path.join(out_dir, f"{stem}{hip_ext}")
hou.hipFile.save(hip_path)

report = {
    "kind": "houdini.procedural-asset",
    "input": os.path.basename(src),
    "input_kind": ext.lstrip("."),
    "base": base_kind,
    "params": params,
    "points": points,
    "prims": prims,
    "vertices": g.intrinsicValue("vertexcount"),
    "bbox": [list(bb.minvec()), list(bb.maxvec())],
    "boolean_applied": boolean_applied,
    "nodes": [f"{n.name()}:{n.type().name()}" for n in nodes],
    "houdini": hou.applicationVersionString(),
    "license": license_name,
    "hip_format": hip_ext.lstrip("."),
    "notes": notes,
    "outputs": [os.path.basename(bgeo_path), os.path.basename(hip_path)],
    "ms": int((time.time() - T0) * 1000),
}
with open(os.path.join(out_dir, f"{stem}.asset.json"), "w") as f:
    json.dump(report, f, indent=1)
print(json.dumps(report))
