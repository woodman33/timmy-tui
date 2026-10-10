"""timmy_blender: the result file a Blender scene script writes when Timmy runs it with Blender's own Python.

NOT YET EXERCISED on a real Blender: written against the documented `bpy` API (bpy.ops.wm.save_as_mainfile,
bpy.ops.render.render, bpy.app.version_string) and checked here only with Python 3 against a stand-in `bpy`
module (tests/native-blender.test.ts). The first real run is the operator's, on the Mac.

Timmy's Blender job (src/native: blenderJob) runs, headless:
    blender -b --factory-startup --python-exit-code 1 --python <script.py> -- <args>
and sets, in the script's environment:
  TIMMY_RESULT         where to write the result file: the run's own, <root>/.timmy/native/<run>/result.json
                       (without it, <root>/out/timmy-result.json, as a run by hand writes)
  TIMMY_RUN            this run's token, written back so a result from an earlier run is never taken for this one
  TIMMY_SCRIPT_SHA256  the script's sha256 when the job was submitted, written back as script_sha256
  TIMMY_SCRIPT         the file Blender runs: a read-only copy of the script kept in the run's folder at
                       submission (<root>/.timmy/native/<run>/source/), so what runs is what was submitted. Its
                       sha256 as this run reads it goes in as script_sha256_read
  TIMMY_SCRIPT_ORIGINAL, TIMMY_SCRIPT_DIR   the script and folder it was submitted from: __file__ is the copy,
                       so files and modules beside the script are found through TIMMY_SCRIPT_DIR
  TIMMY_ROOT           the project folder; file names in the result are relative to it
  TIMMY_OUT            the folder for outputs (default <root>/out). Timmy inventories it before the run: a file
                       named in the result counts as this run's only if the run created it or changed its bytes
  TIMMY_BLENDER_LIB    the folder holding this file (workers/blender). Blender's Python ignores PYTHONPATH
                       unless Blender is started with --python-use-system-env, so a scene script puts this
                       folder on sys.path itself (templates/blender-starter/scene.py does).

The result file is what Timmy judges a run by, not Blender's exit status:
  {
    "ok": true | false,
    "run": "<TIMMY_RUN>",
    "script_sha256": "<TIMMY_SCRIPT_SHA256>",
    "script_sha256_read": "<sha256 of TIMMY_SCRIPT as read>",   (when TIMMY_SCRIPT names a file)
    "error": "<type: message>"            (when ok is false; the project folder written as ".", home as "~")
    "files": {"out/scene.blend": "<sha256>", "out/render.png": "<sha256>"},
    "blender_version": "4.2.3",           (bpy.app.version_string, or null outside Blender)
    "timing": {"started": "...Z", "ended": "...Z", "seconds": 1.23},
    "bounds": {...},                       (round R4: the scene's object sizes after main returned; see below)
    ...                                    (whatever the script's main returns, as extra fields)
  }

Round R4 (/iterate blender, helper H37): when main returns, run_script also reports the scene as the script left it,
under "bounds" (Timmy's own field, like "files": a "bounds" the script's main returns is replaced, and a note says
so). For each object of bpy.context.scene that has a bounding box (a mesh, a curve, a text, anything Blender gives
one; an empty, a camera or a light has none): its world-space axis-aligned bounding box, min, max and size, and its
location (the world matrix's translation). Taken as obj.bound_box's 8 corners through obj.matrix_world, of the
evaluated object (obj.evaluated_get(bpy.context.evaluated_depsgraph_get()), so modifiers and constraints count), in
Blender units rounded to 1e-6, with the scene's unit settings (unit_settings.system, scale_length, length_unit)
recorded once, so a reader knows what a unit is:
    "bounds": {"method": "...", "evaluated": true, "units": {"system": "METRIC", "scale_length": 1.0, ...},
               "rounding": 1e-06, "objects": [{"name": "Cube", "type": "MESH", "min": [..], "max": [..],
               "size": [2.0, 2.0, 2.0], "location": [..]}], "objects_total": 4, "without_bounds": 3}
workers/readback/blend_readback.py reports the saved .blend the same way, so /iterate blender compares the two.
Without bpy (outside Blender) there is no "bounds"; when the report itself fails, "bounds" is {"error": "..."} and
the run's outcome is still what main decided. Run here only against the stand-in bpy (tests/fixtures/blender-stub);
NOT YET EXERCISED on a real Blender.

Use:
    import timmy_blender
    def main(run):
        ...build the scene with bpy...
        run.save_blend(run.out_path("scene.blend"))   # bpy.ops.wm.save_as_mainfile; its sha256 recorded
        run.render_still(run.out_path("render.png"))   # bpy.ops.render.render(write_still=True); recorded
        return {"objects": 6}                          # extra fields for the result
    timmy_blender.run_script(main)
"""
import datetime
import hashlib
import json
import os
import sys
import traceback

__all__ = ["Run", "run_script", "blender_version", "script_args", "scene_bounds"]

# R4 (H37): the object sizes report. The same method, word for word, as workers/readback/blend_readback.py.
BOUNDS_METHOD = ("world-space axis-aligned bounding box: the 8 corners of obj.bound_box through obj.matrix_world, of "
                 "the evaluated object (through the depsgraph); location is matrix_world's translation; Blender units, "
                 "rounded to 1e-6")
#: the same, when the depsgraph could not be had (the report then says why, in not_evaluated)
BOUNDS_METHOD_UNEVALUATED = BOUNDS_METHOD.replace("of the evaluated object (through the depsgraph)", "of the object as it is (no depsgraph)")
BOUNDS_ROUNDING = 1e-6
#: the most objects listed with their bounds (objects_total counts them all)
MAX_BOUNDS = 2000
#: object types that carry no geometry of their own (Blender gives them no bounding box)
NO_GEOMETRY = frozenset(["EMPTY", "CAMERA", "LIGHT", "LIGHT_PROBE", "LIGHTPROBE", "SPEAKER"])


def _iso(t):
    return datetime.datetime.fromtimestamp(t, tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _num(v):
    """A float rounded to 1e-6, without a negative zero."""
    x = round(float(v), 6)
    return 0.0 if x == 0 else x


def _units(scene):
    """The scene's unit settings (system, scale_length, length_unit), or None when it has none."""
    u = getattr(scene, "unit_settings", None)
    if u is None:
        return None
    out = {}
    for key in ("system", "scale_length", "length_unit"):
        value = getattr(u, key, None)
        if value is not None:
            out[key] = _num(value) if isinstance(value, float) else str(value)
    return out or None


def _object_bounds(obj, depsgraph):
    """One object's world-space axis-aligned bounding box, or None when it has no bounding box."""
    if str(obj.type) in NO_GEOMETRY:
        return None
    ob = obj.evaluated_get(depsgraph) if depsgraph is not None else obj
    corners = [tuple(float(x) for x in c) for c in ob.bound_box]
    # Blender gives every corner as -1.0 when an object has no bounding box
    if len(corners) != 8 or all(x == -1.0 for c in corners for x in c):
        return None
    m = ob.matrix_world
    world = [[m[i][0] * c[0] + m[i][1] * c[1] + m[i][2] * c[2] + m[i][3] for i in range(3)] for c in corners]
    lo = [min(w[i] for w in world) for i in range(3)]
    hi = [max(w[i] for w in world) for i in range(3)]
    return {
        "name": obj.name, "type": str(obj.type),
        "min": [_num(x) for x in lo], "max": [_num(x) for x in hi], "size": [_num(hi[i] - lo[i]) for i in range(3)],
        "location": [_num(m[i][3]) for i in range(3)],
    }


def scene_bounds(scene=None):
    """The scene's object sizes as the result reports them under "bounds" (see the module's notes); None outside
    Blender. Objects are sorted by name; at most MAX_BOUNDS are listed, objects_total counts every one with a
    bounding box, without_bounds those without."""
    try:
        import bpy
    except Exception:
        return None
    scene = scene or bpy.context.scene
    if scene is None:
        return {"error": "there is no active scene to report"}
    depsgraph, evaluated, why = None, False, None
    try:
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated = True
    except Exception as e:  # noqa: BLE001 (said in the report: the objects as they are, not evaluated)
        why = "%s: %s" % (type(e).__name__, e)
    listed, total, without = [], 0, 0
    for obj in sorted(scene.objects, key=lambda o: o.name):
        entry = _object_bounds(obj, depsgraph)
        if entry is None:
            without += 1
            continue
        total += 1
        if len(listed) < MAX_BOUNDS:
            listed.append(entry)
    out = {
        "method": BOUNDS_METHOD if evaluated else BOUNDS_METHOD_UNEVALUATED, "evaluated": evaluated, "units": _units(scene),
        "rounding": BOUNDS_ROUNDING, "objects": listed, "objects_total": total, "without_bounds": without,
    }
    if why:
        out["not_evaluated"] = why[:300]
    return out


def blender_version():
    """bpy.app.version_string inside Blender (e.g. '4.2.3 LTS'); None anywhere else."""
    try:
        import bpy  # noqa: F401 (only present inside Blender)
        return str(bpy.app.version_string)
    except Exception:
        return None


def script_args(argv=None):
    """The script's own arguments: what follows `--` on Blender's command line ([] when there is no `--`)."""
    argv = list(sys.argv if argv is None else argv)
    return argv[argv.index("--") + 1:] if "--" in argv else []


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class Run(object):
    """One script run: where to write, the files it made, and its result file."""

    def __init__(self, root=None, result=None, out=None):
        import time
        self.started = time.time()
        self.root = os.path.abspath(root or os.environ.get("TIMMY_ROOT") or os.getcwd())
        self.out = os.path.abspath(out or os.environ.get("TIMMY_OUT") or os.path.join(self.root, "out"))
        self.result_path = os.path.abspath(result or os.environ.get("TIMMY_RESULT") or os.path.join(self.out, "timmy-result.json"))
        self.run = os.environ.get("TIMMY_RUN")
        self.script_sha256 = os.environ.get("TIMMY_SCRIPT_SHA256")
        script = os.environ.get("TIMMY_SCRIPT")
        self.script_sha256_read = _sha256(script) if script and os.path.isfile(script) else None
        self.files = {}
        self.notes = []
        # R4 (H37): the scene's object sizes when main returned (scene_bounds), written as "bounds"
        self.bounds = None

    def out_path(self, *parts):
        """A path in the out folder, its folder made."""
        path = os.path.join(self.out, *parts)
        folder = os.path.dirname(path)
        if not os.path.isdir(folder):
            os.makedirs(folder)
        return path

    def name(self, path):
        """The path as the result names it: relative to the project folder when inside it."""
        path = os.path.abspath(path)
        rel = os.path.relpath(path, self.root)
        if rel == os.pardir or rel.startswith(os.pardir + os.sep):
            return path
        return rel.replace(os.sep, "/")

    def add_file(self, path):
        """Record a file this run made, by its sha256. A missing file raises: the run did not make it."""
        if not os.path.isfile(path):
            raise IOError("%s was not written" % self.name(path))
        self.files[self.name(path)] = _sha256(path)
        return path

    def save_blend(self, path):
        """Save the open scene as an editable .blend with bpy.ops.wm.save_as_mainfile, and record it."""
        import bpy
        path = os.path.abspath(path)
        done = bpy.ops.wm.save_as_mainfile(filepath=path)
        if "FINISHED" not in done:
            raise RuntimeError("save_as_mainfile returned %s for %s" % (sorted(done), self.name(path)))
        return self.add_file(path)

    def render_still(self, path, scene=None):
        """Render the scene's camera to `path` with bpy.ops.render.render(write_still=True), and record it."""
        import bpy
        scene = scene or bpy.context.scene
        if scene.camera is None:
            raise RuntimeError("the scene has no camera to render from")
        path = os.path.abspath(path)
        scene.render.filepath = path
        done = bpy.ops.render.render(write_still=True)
        if "FINISHED" not in done:
            raise RuntimeError("render.render returned %s" % sorted(done))
        return self.add_file(path)

    def note(self, text):
        """A sentence for the result's notes (what was not established, a fallback taken)."""
        self.notes.append(self.scrub(str(text)))

    def scrub(self, text):
        """Free text with the project folder written as "." and the home folder as "~"."""
        out = text
        for folder in sorted({self.root, os.path.realpath(self.root)}, key=len, reverse=True):
            if len(folder) > 1:
                out = out.replace(folder, ".")
        home = os.path.expanduser("~")
        if len(home) > 1:
            out = out.replace(home, "~")
        return out

    def write(self, ok, error=None, extra=None):
        """Write the result file: to a temporary name, then renamed over the result, so it is never half there."""
        import time
        ended = time.time()
        body = {}
        if isinstance(extra, dict):
            body.update(extra)
            if self.bounds is not None and "bounds" in extra:
                self.note("the script's own \"bounds\" was replaced by Timmy's report of the scene's object sizes")
        if self.bounds is not None:
            body["bounds"] = self.bounds
        body.update({
            "ok": bool(ok),
            "run": self.run,
            "script_sha256": self.script_sha256,
            "files": dict(self.files),
            "blender_version": blender_version(),
            "timing": {"started": _iso(self.started), "ended": _iso(ended), "seconds": round(ended - self.started, 3)},
        })
        if self.script_sha256_read is not None:
            body["script_sha256_read"] = self.script_sha256_read
        if self.notes:
            body["notes"] = list(self.notes)
        if error is not None:
            body["error"] = self.scrub(str(error))
        folder = os.path.dirname(self.result_path)
        if not os.path.isdir(folder):
            os.makedirs(folder)
        temp = "%s.%d.tmp" % (self.result_path, os.getpid())
        with open(temp, "w") as f:
            json.dump(body, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(temp, self.result_path)
        return body


def run_script(main, root=None, result=None):
    """Run main(run) and write the result file: ok when main returns, ok: false with the error when it raises.

    Returns the result written. It does not exit the process: the result file, not Blender's exit status,
    is the run's outcome.
    """
    run = Run(root=root, result=result)
    try:
        extra = main(run)
    except Exception as e:  # noqa: BLE001 (every failure is written down, never lost)
        tb = traceback.format_exc()
        return run.write(False, error="%s: %s" % (type(e).__name__, e), extra={"traceback": run.scrub(tb)[-4000:]})
    # R4 (H37): the scene as the script left it. A report that fails is said in "bounds"; main's outcome stands.
    try:
        run.bounds = scene_bounds()
    except Exception as e:  # noqa: BLE001
        run.bounds = {"error": run.scrub("%s: %s" % (type(e).__name__, e))[:300]}
    return run.write(True, extra=extra if isinstance(extra, dict) else None)
