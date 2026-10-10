"""timmy-blend-readback: a second pass over a saved .blend, inside Blender, as one line of JSON on stdout.

Usage (Blender opens the file, then runs this script):
    blender -b <file.blend> --factory-startup --python-exit-code 1 --python blend_readback.py -- [--as <name>]

Round R4 (/iterate blender, helper H26): after Blender has run a scene script as a judged Timmy job and saved
its .blend, Timmy starts Blender again, in a separate process, to open that file and say what it holds: each
object of the scene (name, type, dimensions, location and the materials in its slots), the materials in the
file and those the scene's objects use, the cameras and the active camera, the scenes, the frame range and the
render resolution. Timmy hashes the file itself, before and after this read, and compares what is read here
with what the run's own result file reported.

What this is, exactly: the same application reading its own file in a separate process. It is a second pass,
not an independent implementation: a fault in how Blender writes or reads its files could be in both passes.

--factory-startup: no user preferences or add-ons, and Python kept inside the .blend is not run (auto-run is
off by default). The script writes nothing: it reads, and prints its line.

NOT YET EXERCISED on a real Blender: written against the documented bpy API (bpy.data.filepath, bpy.data.scenes,
bpy.data.materials, bpy.context.scene, Object.type, Object.dimensions, Object.location, Object.material_slots,
Scene.camera, Scene.frame_start, Scene.frame_end, RenderSettings.resolution_x and resolution_y) and run here
only with Python 3 against the stand-in bpy (tests/fixtures/blender-stub), whose .blend is JSON. The first real
run is the operator's, on the Mac.

Values are as Blender reports them: lengths in Blender units (the scene's unit settings are reported, never
applied), rounded to 1e-6. They describe the generated scene, never a physical object.

The line stays under 60,000 characters (Timmy's job log keeps lines up to 64 KiB): past that, fewer objects are
listed in detail and objects_total says how many the scene has.

Exit 0 with {"ok": true, ...}; 2 with {"ok": false, "error": {...}} when there is no file, scene or bpy, or the
read fails; 64 on a usage error. Python 3.7 or later (Blender's own Python).
"""
import json
import os
import platform
import sys

WORKER = {"name": "timmy-blend-readback", "version": "0.1.0"}
TIER = "native readback: a second pass by the same application"
SCOPE = ("Blender opened the saved .blend in a separate process and read it back: the same application reading "
         "its own file, a second pass, not an independent implementation. Lengths in Blender units, of the "
         "generated scene, never of a physical object.")
MAX_LINE = 60000
MAX_DETAILED = 2000


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), sort_keys=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(code, kind, message, extra=None):
    out = {"ok": False, "worker": WORKER, "python": platform.python_version(), "error": {"code": kind, "message": message}}
    if extra:
        out.update(extra)
    emit(out, code)


def script_args(argv):
    """What follows `--` on Blender's command line: [--as <name>]."""
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    name = None
    i = 0
    while i < len(rest):
        if rest[i] == "--as" and i + 1 < len(rest):
            name = rest[i + 1]
            i += 2
            continue
        fail(64, "usage", "usage: blender -b <file.blend> --factory-startup --python blend_readback.py -- [--as <name>]")
    return name


def num(v):
    """A float rounded to 1e-6, without a negative zero."""
    x = round(float(v), 6)
    return 0.0 if x == 0 else x


def vec(v):
    try:
        return [num(x) for x in v]
    except Exception:
        return None


def name_of(thing):
    return thing.name if thing is not None else None


def opened_name(filepath):
    """The open file relative to the working folder (the project, as Timmy runs this), never an absolute path."""
    try:
        return os.path.relpath(filepath, os.getcwd()).replace(os.sep, "/")
    except Exception:
        return os.path.basename(filepath)


def object_entry(o):
    slots = []
    for s in getattr(o, "material_slots", []):
        m = getattr(s, "material", None)
        if m is not None:
            slots.append(m.name)
    return {"name": o.name, "type": str(o.type), "dimensions": vec(o.dimensions), "location": vec(o.location), "materials": slots}


def scene_entry(s):
    r = s.render
    return {
        "name": s.name, "objects": len(s.objects), "camera": name_of(s.camera),
        "frame_start": int(s.frame_start), "frame_end": int(s.frame_end),
        "resolution": [int(r.resolution_x), int(r.resolution_y)], "resolution_percentage": int(r.resolution_percentage),
        "engine": str(r.engine),
    }


def units_of(scene):
    u = getattr(scene, "unit_settings", None)
    if u is None:
        return None
    out = {}
    for key in ("system", "scale_length", "length_unit"):
        value = getattr(u, key, None)
        if value is not None:
            out[key] = num(value) if isinstance(value, float) else str(value)
    return out or None


def fit(body):
    """The line within MAX_LINE: fewer objects in detail (objects_total keeps the count) until it fits."""
    text = json.dumps(body, separators=(",", ":"))
    while len(text) > MAX_LINE and body["objects"]:
        body["objects"] = body["objects"][: len(body["objects"]) // 2]
        text = json.dumps(body, separators=(",", ":"))
    if len(text) > MAX_LINE:
        fail(2, "too-large", "the readback does not fit in one line of %d characters even without its objects" % MAX_LINE)
    return body


def main():
    name = script_args(sys.argv)
    try:
        import bpy
    except Exception as e:
        fail(2, "no-bpy", "bpy is not importable (%s): this runs inside Blender, as blender -b <file.blend> --python blend_readback.py" % type(e).__name__)
    try:
        filepath = bpy.data.filepath
        if not filepath:
            fail(2, "no-file", "Blender has no .blend open: it could not read the file it was given, or it was given none")
        scene = bpy.context.scene
        if scene is None:
            fail(2, "no-scene", "the open .blend has no active scene")
        objects = sorted(scene.objects, key=lambda o: o.name)
        used = set()
        for o in objects:
            for s in getattr(o, "material_slots", []):
                m = getattr(s, "material", None)
                if m is not None:
                    used.add(m.name)
        materials = []
        for m in sorted(bpy.data.materials, key=lambda m: m.name):
            users = getattr(m, "users", None)
            materials.append({"name": m.name, "users": int(users) if users is not None else None, "fake_user": bool(getattr(m, "use_fake_user", False))})
        cameras = []
        for o in objects:
            if str(o.type) == "CAMERA":
                cameras.append({"name": o.name, "data": name_of(o.data), "lens": num(o.data.lens) if o.data is not None and hasattr(o.data, "lens") else None})
        r = scene.render
        body = {
            "ok": True,
            "worker": WORKER,
            "blender_version": str(bpy.app.version_string),
            "python": platform.python_version(),
            "file": {"name": name or os.path.basename(filepath), "opened": opened_name(filepath)},
            "scene": scene.name,
            "objects": [object_entry(o) for o in objects[:MAX_DETAILED]],
            "objects_total": len(objects),
            "materials": materials,
            "materials_used": sorted(used),
            "cameras": cameras,
            "active_camera": name_of(scene.camera),
            "scenes": [scene_entry(s) for s in sorted(bpy.data.scenes, key=lambda s: s.name)],
            "frame_range": [int(scene.frame_start), int(scene.frame_end)],
            "render_resolution": [int(r.resolution_x), int(r.resolution_y)],
            "resolution_percentage": int(r.resolution_percentage),
            "units": units_of(scene),
            "tier": TIER,
            "scope": SCOPE,
        }
    except SystemExit:
        raise
    except Exception as e:
        fail(2, "read-failed", "reading the open .blend failed (%s: %s)" % (type(e).__name__, str(e)[:300]))
    emit(fit(body))


if __name__ == "__main__":
    main()
