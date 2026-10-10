"""unreal_readback: Timmy's second pass over an Unreal run (round R4, helper H63).

A separate UnrealEditor-Cmd process, started after the first pass was judged ok, opens each level the first pass saved
and lists its actors as they load from the file. Timmy compares that list with what the first pass reported when it
saved the level (src/native/unreal-readback.ts): the second pass is the check; the first pass alone is never trusted.

How Timmy runs it (src/native/unreal-readback.ts, unrealReadbackJob):
    UnrealEditor-Cmd <project.uproject> -run=pythonscript -script=<this file> -unattended -nullrhi -nosplash -nopause
                     -stdout -FullStdOutLogOutput
with, in its environment:
  TIMMY_READBACK_RESULT  where to write what it read (a JSON file in the first run's own folder)
  TIMMY_READBACK_TOKEN   this readback's token, written back so an older readback's file is never taken for this one
  TIMMY_RUN              the first pass's run token, written back
  TIMMY_UNREAL_LEVELS    the levels to open: a JSON list of {"asset": "/Game/...", "file": "<the level file>"}
  TIMMY_ROOT             the project folder; file names in what it writes are relative to it

For each level: the file's sha256 before it is opened, LevelEditorSubsystem.load_level(asset), every actor of the level
(EditorActorSubsystem.get_all_level_actors), described exactly as the harness describes them (timmy_unreal.py, the same
words in BOUNDS_METHOD), and the file's sha256 again after. It saves nothing and changes nothing; it does not import the
harness, so nothing of the first pass's code or state is used here.

What this is, exactly: the same engine reading its own file in a separate process. It is a second pass, not an
independent implementation: a fault in how Unreal writes or reads its levels could be in both passes.

NOT YET EXERCISED on a real Unreal Engine: run here only with python3 against the stand-in `unreal` module
(tests/fixtures/unreal-stub), whose level files are JSON. The first real run is the operator's, on the Mac.
"""
import datetime
import hashlib
import json
import os
import time
import traceback

WORKER = {"name": "unreal_readback", "version": "0.1.0"}
# The same words, word for word, as workers/unreal/timmy_unreal.py's BOUNDS_METHOD.
BOUNDS_METHOD = ("Actor.get_actor_bounds(only_colliding_components=False): the axis-aligned box around every component "
                 "of the actor, in world space, as origin and half-size extent; min = origin - extent, max = origin + "
                 "extent, size = 2 x extent; Unreal units (centimetres), rounded to 1e-6")
UNITS = {"length": "Unreal units (centimetres)", "rotation": "degrees, as [pitch, yaw, roll]", "scale": "a factor per axis"}
SCOPE = ("A second UnrealEditor-Cmd process opened each saved level and listed its actors as they loaded from the file: "
         "the same engine reading its own file, a second pass, not an independent implementation. Unreal units "
         "(centimetres) of a generated scene, never of a physical object.")
MAX_ACTORS = 2000


def _iso(t):
    return datetime.datetime.fromtimestamp(t, tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _num(v):
    x = round(float(v), 6)
    return 0.0 if x == 0 else x


def _vec(v):
    return [_num(v.x), _num(v.y), _num(v.z)]


def _sha256(path):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except (IOError, OSError):
        return None


def _mesh_of(actor):
    try:
        component = actor.get_editor_property("static_mesh_component")
        mesh = component.get_editor_property("static_mesh") if component is not None else None
        return str(mesh.get_path_name()) if mesh is not None else None
    except Exception:
        return None


def describe_actor(actor):
    """One actor, described as timmy_unreal.describe_actor describes it (Unreal's own numbers, rounded to 1e-6)."""
    cls = actor.get_class()
    origin, extent = actor.get_actor_bounds(False)
    lo = [_num(origin.x - extent.x), _num(origin.y - extent.y), _num(origin.z - extent.z)]
    hi = [_num(origin.x + extent.x), _num(origin.y + extent.y), _num(origin.z + extent.z)]
    rot = actor.get_actor_rotation()
    entry = {
        "name": str(actor.get_name()), "label": str(actor.get_actor_label()),
        "class": str(cls.get_path_name()), "class_name": str(cls.get_name()),
        "location": _vec(actor.get_actor_location()),
        "rotation": [_num(rot.pitch), _num(rot.yaw), _num(rot.roll)],
        "scale": _vec(actor.get_actor_scale3d()),
        "bounds": {"origin": _vec(origin), "extent": _vec(extent), "min": lo, "max": hi,
                   "size": [_num(2 * extent.x), _num(2 * extent.y), _num(2 * extent.z)]},
    }
    mesh = _mesh_of(actor)
    if mesh:
        entry["mesh"] = mesh
    return entry


def _name(root, path):
    rel = os.path.relpath(os.path.abspath(path), root)
    if rel == os.pardir or rel.startswith(os.pardir + os.sep):
        return "(outside the project) " + os.path.basename(path)
    return rel.replace(os.sep, "/")


def _scrub(root, text):
    out = str(text)
    for folder in sorted({root, os.path.realpath(root)}, key=len, reverse=True):
        if len(folder) > 1:
            out = out.replace(folder, ".")
    home = os.path.expanduser("~")
    if len(home) > 1:
        out = out.replace(home, "~")
    return out


def read_levels(unreal, levels, root):
    """Each level opened in turn, its actors listed; nothing is saved."""
    les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    ues = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
    out = []
    for level in levels:
        asset = str(level.get("asset", ""))
        path = str(level.get("file", ""))
        entry = {"asset": asset, "file": _name(root, path), "sha256_before": _sha256(path)}
        loaded = bool(les.load_level(asset))
        entry["loaded"] = loaded
        if loaded:
            world = ues.get_editor_world()
            entry["world"] = str(world.get_path_name()) if world is not None else None
            actors = sorted(eas.get_all_level_actors(), key=lambda a: str(a.get_name()))
            entry["actors"] = [describe_actor(a) for a in actors[:MAX_ACTORS]]
            entry["actors_total"] = len(actors)
        entry["sha256_after"] = _sha256(path)
        out.append(entry)
    return out


def main():
    started = time.time()
    root = os.path.abspath(os.environ.get("TIMMY_ROOT") or os.getcwd())
    result_path = os.environ.get("TIMMY_READBACK_RESULT") or os.path.join(root, "out", "unreal-readback.json")
    body = {
        "readback": "timmy-unreal-readback/1", "token": os.environ.get("TIMMY_READBACK_TOKEN"), "run": os.environ.get("TIMMY_RUN"),
        "worker": dict(WORKER), "units": dict(UNITS), "bounds_method": BOUNDS_METHOD, "scope": SCOPE, "levels": [],
    }
    try:
        levels = json.loads(os.environ.get("TIMMY_UNREAL_LEVELS") or "[]")
        if not isinstance(levels, list) or not levels:
            raise ValueError("TIMMY_UNREAL_LEVELS names no level to open")
        import unreal  # only inside Unreal Engine (or the stand-in)
        try:
            body["unreal_version"] = str(unreal.SystemLibrary.get_engine_version())
        except Exception:  # noqa: BLE001
            body["unreal_version"] = None
        body["levels"] = read_levels(unreal, levels, root)
        body["ok"] = all(level.get("loaded") for level in body["levels"])
        if not body["ok"]:
            body["error"] = "LevelEditorSubsystem.load_level returned False for %s" % ", ".join(
                level["asset"] for level in body["levels"] if not level.get("loaded"))
    except Exception as e:  # noqa: BLE001 (every failure is written down, never lost)
        body["ok"] = False
        body["error"] = _scrub(root, "%s: %s" % (type(e).__name__, e))[:2000]
        body["traceback"] = _scrub(root, traceback.format_exc())[-4000:]
    ended = time.time()
    body["timing"] = {"started": _iso(started), "ended": _iso(ended), "seconds": round(ended - started, 3)}
    folder = os.path.dirname(os.path.abspath(result_path))
    if not os.path.isdir(folder):
        os.makedirs(folder)
    temp = "%s.%d.tmp" % (result_path, os.getpid())
    with open(temp, "w") as f:
        json.dump(body, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(temp, result_path)
    print("unreal_readback %s: %s; %s" % (WORKER["version"], "read" if body["ok"] else "ok: false", _name(root, result_path)))


if __name__ == "__main__":
    main()
