"""timmy_unreal: Timmy's harness for Unreal Engine's own Python, headless (round R4, helper H63; spawn and paths, H72).

Written against the Unreal Editor Python API as Epic documents it (unreal.get_editor_subsystem; LevelEditorSubsystem
.new_level, load_level, save_current_level; EditorActorSubsystem.spawn_actor_from_class, get_all_level_actors,
destroy_actor; StaticMeshComponent.set_static_mesh; UnrealEditorSubsystem.get_editor_world; EditorAssetLibrary
.does_asset_exist; unreal.load_asset; Actor.get_name, get_class, get_actor_label, set_actor_label, get_actor_location,
get_actor_rotation, get_actor_scale3d, set_actor_scale3d, get_actor_bounds, get_editor_property; unreal.Vector;
unreal.Rotator(roll, pitch, yaw); SystemLibrary.get_engine_version), and tested with python3 against a stand-in `unreal`
module (tests/fixtures/unreal-stub; tests/native-unreal.test.ts). Exercised on Unreal Engine 5.8.2 (5.8.2-56702186) on the
operator's Mac by helper H72, through a driver with Timmy's exact command line and environment, not through Timmy: the
starter (templates/unreal-starter/scene.py) built /Game/Timmy/TimmyGrid with its 9 cubes in 15 s and saved it, and a
second process read the level back with the same 9 actors and bounds (Timmy's comparison: agrees). The run r21 (H63's
version) had failed: EditorActorSubsystem.spawn_actor_from_object gave no actor in the commandlet; spawn_mesh now spawns
by class (see it). Where a level's file is comes from TIMMY_UNREAL_CONTENT (Timmy's own reading of the .uproject's
folder), not from Unreal's Paths.

How Timmy runs it (src/native/unreal.ts, unrealJob; unrealArgs and unrealPlace build the command line in one place):
    UnrealEditor-Cmd <project.uproject> -run=pythonscript -script=<this file> -unattended -nullrhi -nosplash -nopause
                     -stdout -FullStdOutLogOutput -DDC=InstalledNoZenLocalFallback -LocalDataCachePath=<project>/Saved/
                     DerivedDataCache -abslog=<project>/Saved/Logs/Timmy-<run>.log
with HOME and CFFIXED_USER_HOME set to Timmy's native home when it has one (TIMMY_NATIVE_HOME).
Unreal's pythonscript commandlet runs this file as a script (its __name__ is "__main__"). The harness then:
  1. imports this file again as the module timmy_unreal (from TIMMY_UNREAL_LIB, else this file's folder), so that a
     script's `import timmy_unreal` gets this same run;
  2. lists the watched folders (TIMMY_UNREAL_WATCH: the project's Content folder and out/), file by file, by size and
     modification time;
  3. reads the script Timmy kept at submission (TIMMY_SCRIPT: a read-only copy in the run's own folder), hashes the bytes
     it read (script_sha256_read) and runs those very bytes as the module "__timmy_script__" (so code under
     `if __name__ == "__main__":` does not run), then calls the script's main(run) when it defines one;
  4. lists the watched folders again: every file created, or changed in size or time, is named under "files" with its
     sha256; a file there before and gone after is named under "deleted";
  5. writes the result file (TIMMY_RESULT; to a temporary name, then renamed over it), and never lets an exception out.
The result file, not Unreal's exit status, is the run's outcome. Timmy checks each file named against its own inventory
taken before the job started (only a file this run created or changed counts as made by it), and the first pass alone is
never trusted: a second, separate Unreal process opens each saved level and lists its actors (unreal_readback.py).

Environment (set by Timmy's job; run by hand, the defaults in brackets):
  TIMMY_RESULT          where to write the result file [<root>/out/timmy-result.json]
  TIMMY_RUN             this run's token, written back so a result from another run is never taken for this one
  TIMMY_SCRIPT          the script to run: the read-only copy kept at submission
  TIMMY_SCRIPT_SHA256   the script's sha256 when it was submitted, written back as script_sha256
  TIMMY_SCRIPT_ORIGINAL, TIMMY_SCRIPT_DIR   the file and folder it was submitted from (run.read_json reads beside it)
  TIMMY_SCRIPT_ARGS     the script's own arguments, a JSON list of strings (run.args) [[]]
  TIMMY_ROOT            the project folder; every file name in the result is relative to it [the current folder]
  TIMMY_OUT             the folder for other outputs [<root>/out]
  TIMMY_UNREAL_PROJECT  the .uproject Unreal opened
  TIMMY_UNREAL_CONTENT  its Content folder: where a level under /Game/ is saved [beside the .uproject]
  TIMMY_UNREAL_WATCH    the folders listed before and after the script, a JSON list relative to the root [Content, out]
  TIMMY_UNREAL_LIB      the folder holding this file

The result file:
  {
    "ok": true | false,
    "run": "<TIMMY_RUN>", "script_sha256": "<TIMMY_SCRIPT_SHA256>", "script_sha256_read": "<sha256 of the bytes run>",
    "script_ran": "<the copy that ran, relative to the root>",
    "harness": {"name": "timmy_unreal", "version": "0.1.0", "sha256": "<this file's sha256 as it ran>"},
    "unreal_version": "<SystemLibrary.get_engine_version()>",
    "project": "<the .uproject>", "content": "<its Content folder>",
    "levels": [{"asset": "/Game/...", "file": "Content/....umap", "sha256": "...", "saved_at": "...Z",
                "actors": [<actor>...], "actors_total": 9}],            (each level as it was at its last save)
    "actors_made": [{"level": "/Game/...", "name": "StaticMeshActor_0", "label": "..."}],   (what the script made)
    "removed": [{"level": ..., "name": ..., "label": ...}],          (what the script removed through run.remove_actor)
    "files": {"Content/Timmy/TimmyGrid.umap": "<sha256>"},           (every file created or changed in the watched folders)
    "deleted": ["..."],                                              (files there before the script and gone after it)
    "watched": ["Content", "out"],
    "inputs": {"scene.params.json": "<sha256>"},                     (files read through run.read_json)
    "returned": {...},                                               (what main returned, made JSON-safe)
    "units": {...}, "bounds_method": "...", "timing": {...}, "notes": [...],
    "error": "<Type: message>", "traceback": "..."                   (when ok is false; the root written ".", home "~")
  }
An actor: {"name", "label", "class" (its class's path), "class_name", "mesh" (a static mesh's path, when it has one),
"location": [x, y, z], "rotation": [pitch, yaw, roll], "scale": [x, y, z],
"bounds": {"origin", "extent", "min", "max", "size"}}: Unreal units (centimetres) and degrees, rounded to 1e-6. Bounds are
Actor.get_actor_bounds(False): the box around every component of the actor, in world space, as Unreal reports it.

Use (templates/unreal-starter/scene.py):
    import timmy_unreal

    def main(run):
        params = run.read_json("scene.params.json")             # beside the script; its sha256 recorded
        run.new_level("/Game/Timmy/TimmyGrid")                  # a new blank level, not World Partition
        cube = run.load_mesh("/Engine/BasicShapes/Cube.Cube")
        run.spawn_mesh(cube, (0, 0, 50), label="TimmyCube_0_0")  # reported as made by the script
        run.save_level()                                         # the level and its actors as saved
        return {"cubes": 1}
Code at a script's top level runs too (before main); timmy_unreal.current() is the run then.
"""
import datetime
import hashlib
import json
import os
import stat
import sys
import time
import traceback

__all__ = ["Run", "current", "describe_actor", "harness_main", "HARNESS", "BOUNDS_METHOD"]

HARNESS = {"name": "timmy_unreal", "version": "0.2.0"}
#: How each actor's bounds are taken. The same words, word for word, as unreal_readback.py.
BOUNDS_METHOD = ("Actor.get_actor_bounds(only_colliding_components=False): the axis-aligned box around every component "
                 "of the actor, in world space, as origin and half-size extent; min = origin - extent, max = origin + "
                 "extent, size = 2 x extent; Unreal units (centimetres), rounded to 1e-6")
UNITS = {"length": "Unreal units (centimetres)", "rotation": "degrees, as [pitch, yaw, roll]", "scale": "a factor per axis"}
ROUNDING = 1e-6
#: the most actors described per level (actors_total counts them all)
MAX_ACTORS = 2000
#: the levels a script may save, by their package path: the project's own content
GAME_ROOT = "/Game/"

_CURRENT = None


def current():
    """The run in progress (None outside one): what a script uses at its top level."""
    return _CURRENT


def _iso(t):
    return datetime.datetime.fromtimestamp(t, tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _num(v):
    """A float rounded to 1e-6, without a negative zero."""
    x = round(float(v), 6)
    return 0.0 if x == 0 else x


def _vec(v):
    return [_num(v.x), _num(v.y), _num(v.z)]


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _unreal():
    """The unreal module, or None outside Unreal (and outside the stand-in)."""
    try:
        import unreal  # noqa: F401 (only inside Unreal Engine)
        return unreal
    except Exception:
        return None


def unreal_version():
    """SystemLibrary.get_engine_version() inside Unreal; None anywhere else."""
    unreal = _unreal()
    if unreal is None:
        return None
    try:
        return str(unreal.SystemLibrary.get_engine_version())
    except Exception:
        return None


def _subsystem(name):
    unreal = _unreal()
    if unreal is None:
        raise RuntimeError("there is no unreal module: this runs inside Unreal Engine's own Python")
    found = unreal.get_editor_subsystem(getattr(unreal, name))
    if found is None:
        raise RuntimeError("unreal.get_editor_subsystem(%s) gave nothing: this needs the Unreal Editor (UnrealEditor-Cmd)" % name)
    return found


def _mesh_of(actor):
    """The static mesh an actor shows, by its path, when it has one (a StaticMeshActor); None otherwise."""
    try:
        component = actor.get_editor_property("static_mesh_component")
        mesh = component.get_editor_property("static_mesh") if component is not None else None
        return str(mesh.get_path_name()) if mesh is not None else None
    except Exception:
        return None


def describe_actor(actor):
    """One actor as the result reports it (see the module's notes): Unreal's own numbers, rounded to 1e-6."""
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


def _listing(folders):
    """Every regular file under the folders, by its path: (size, modification time in ns). Links are not followed."""
    out = {}
    for folder in folders:
        if not os.path.isdir(folder) or os.path.islink(folder):
            continue
        for dirpath, dirnames, filenames in os.walk(folder):
            dirnames.sort()
            for fn in sorted(filenames):
                path = os.path.join(dirpath, fn)
                try:
                    st = os.lstat(path)
                except OSError:
                    continue
                if stat.S_ISREG(st.st_mode):
                    out[path] = (st.st_size, st.st_mtime_ns)
    return out


def _jsonable(value):
    """A value as JSON can carry it: anything JSON cannot is written as its repr, never dropped silently."""
    try:
        return json.loads(json.dumps(value, default=repr))
    except Exception:
        return repr(value)


class Run(object):
    """One script run inside Unreal: what it read, the levels it saved, the actors it made, and its result file."""

    def __init__(self, environ=None):
        env = os.environ if environ is None else environ
        self.started = time.time()
        self.root = os.path.abspath(env.get("TIMMY_ROOT") or os.getcwd())
        self.out = os.path.abspath(env.get("TIMMY_OUT") or os.path.join(self.root, "out"))
        self.result_path = os.path.abspath(env.get("TIMMY_RESULT") or os.path.join(self.out, "timmy-result.json"))
        self.run = env.get("TIMMY_RUN")
        self.script_sha256 = env.get("TIMMY_SCRIPT_SHA256")
        self.script = env.get("TIMMY_SCRIPT")
        self.script_dir = env.get("TIMMY_SCRIPT_DIR") or (os.path.dirname(self.script) if self.script else self.root)
        self.project_file = env.get("TIMMY_UNREAL_PROJECT")
        content = env.get("TIMMY_UNREAL_CONTENT")
        if not content and self.project_file:
            content = os.path.join(os.path.dirname(self.project_file), "Content")
        self.content = os.path.abspath(content) if content else None
        try:
            args = json.loads(env.get("TIMMY_SCRIPT_ARGS") or "[]")
        except ValueError:
            args = []
        self.args = [str(a) for a in args] if isinstance(args, list) else []
        try:
            watch = json.loads(env.get("TIMMY_UNREAL_WATCH") or "null")
        except ValueError:
            watch = None
        if not isinstance(watch, list):
            watch = [p for p in (self.content, self.out) if p]
        self.watch = [os.path.abspath(os.path.join(self.root, str(w))) for w in watch]
        self.files = {}
        self.deleted = []
        self.inputs = {}
        self.levels = {}
        self.made = []
        self.removed = []
        self.notes = []
        self.level = None
        self.script_sha256_read = None
        self.script_ran = None

    # ── names and words ──────────────────────────────────────────────────────

    def name(self, path):
        """A path as the result names it: relative to the project folder when inside it, never a full path outside."""
        path = os.path.abspath(path)
        rel = os.path.relpath(path, self.root)
        if rel == os.pardir or rel.startswith(os.pardir + os.sep):
            return "(outside the project) " + os.path.basename(path)
        return rel.replace(os.sep, "/")

    def scrub(self, text):
        """Free text with the project folder written as "." and the home folder as "~"."""
        out = str(text)
        for folder in sorted({self.root, os.path.realpath(self.root)}, key=len, reverse=True):
            if len(folder) > 1:
                out = out.replace(folder, ".")
        home = os.path.expanduser("~")
        if len(home) > 1:
            out = out.replace(home, "~")
        return out

    def note(self, text):
        """A sentence for the result's notes (what was not established, a fallback taken)."""
        self.notes.append(self.scrub(text)[:500])

    # ── what a script uses ───────────────────────────────────────────────────

    def read_json(self, name):
        """A JSON file beside the script as submitted (TIMMY_SCRIPT_DIR), parsed; its sha256 is recorded under inputs."""
        path = name if os.path.isabs(name) else os.path.join(self.script_dir, name)
        with open(path, "rb") as f:
            data = f.read()
        self.inputs[self.name(path)] = hashlib.sha256(data).hexdigest()
        return json.loads(data.decode("utf-8"))

    def level_exists(self, asset):
        """Whether a level (any asset) is at this package path (EditorAssetLibrary.does_asset_exist)."""
        return bool(_unreal().EditorAssetLibrary.does_asset_exist(asset))

    def new_level(self, asset):
        """A new blank level saved at `asset` (/Game/...), not a World Partition world (LevelEditorSubsystem.new_level)."""
        self._check_asset(asset)
        if not _subsystem("LevelEditorSubsystem").new_level(asset, False):
            raise RuntimeError("LevelEditorSubsystem.new_level returned False for %s (an asset may already be there: "
                               "run.level_exists, then run.load_level)" % asset)
        self.level = asset
        return asset

    def load_level(self, asset):
        """Open an existing level (LevelEditorSubsystem.load_level); the level open before is closed without saving."""
        self._check_asset(asset)
        if not _subsystem("LevelEditorSubsystem").load_level(asset):
            raise RuntimeError("LevelEditorSubsystem.load_level returned False for %s" % asset)
        self.level = asset
        return asset

    def load_mesh(self, path):
        """A static mesh by its object path, e.g. /Engine/BasicShapes/Cube.Cube (unreal.load_asset)."""
        mesh = _unreal().load_asset(path)
        if mesh is None:
            raise RuntimeError("unreal.load_asset found nothing at %s" % path)
        return mesh

    def spawn_mesh(self, mesh, location, rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), label=None):
        """A StaticMeshActor showing `mesh`, in the open level, reported as made. location and scale are (x, y, z);
        rotation is (pitch, yaw, roll) in degrees, Unreal's own order.

        It is spawned by class (EditorActorSubsystem.spawn_actor_from_class(unreal.StaticMeshActor, ...)) and then given
        its mesh (its static_mesh_component's set_static_mesh), not by EditorActorSubsystem.spawn_actor_from_object(mesh):
        in the pythonscript commandlet of Unreal Engine 5.8.2 that call gave no actor ("LogUtils: Warning:
        SpawnActorFromObject. No actor was spawned.", the Mac run r21, and again in H72's first Mac run), while this route
        gave a StaticMeshActor with the mesh and its bounds, which saved and loaded back (H72's Mac runs)."""
        unreal = _unreal()
        pitch, yaw, roll = (float(v) for v in rotation)
        actors = _subsystem("EditorActorSubsystem")
        actor = actors.spawn_actor_from_class(
            unreal.StaticMeshActor, unreal.Vector(float(location[0]), float(location[1]), float(location[2])),
            unreal.Rotator(roll=roll, pitch=pitch, yaw=yaw))
        if actor is None:
            raise RuntimeError("spawn_actor_from_class(StaticMeshActor) gave no actor for %s" % mesh.get_path_name())
        component = actor.get_editor_property("static_mesh_component")
        if component is None or not component.set_static_mesh(mesh):
            # the half-made actor (no mesh) is removed, so the level never keeps it
            actors.destroy_actor(actor)
            raise RuntimeError("set_static_mesh did not give the spawned StaticMeshActor the mesh %s" % mesh.get_path_name())
        if label:
            actor.set_actor_label(str(label))
        if tuple(float(s) for s in scale) != (1.0, 1.0, 1.0):
            actor.set_actor_scale3d(unreal.Vector(float(scale[0]), float(scale[1]), float(scale[2])))
        return self.report_actor(actor)

    def report_actor(self, actor):
        """Report an actor the script made some other way, so the result names it as made."""
        self.made.append({"level": self._current_level(), "name": str(actor.get_name()), "label": str(actor.get_actor_label())})
        return actor

    def actors(self):
        """Every actor of the open level, by name (EditorActorSubsystem.get_all_level_actors)."""
        return sorted(_subsystem("EditorActorSubsystem").get_all_level_actors(), key=lambda a: str(a.get_name()))

    def remove_actor(self, actor):
        """Remove an actor from the open level (EditorActorSubsystem.destroy_actor); the result names it as removed."""
        entry = {"level": self._current_level(), "name": str(actor.get_name()), "label": str(actor.get_actor_label())}
        if not _subsystem("EditorActorSubsystem").destroy_actor(actor):
            raise RuntimeError("destroy_actor returned False for %s" % entry["name"])
        self.removed.append(entry)

    def save_level(self):
        """Save the open level (LevelEditorSubsystem.save_current_level) and report it as saved: its file with its
        sha256, and every actor in it as it is now. Saving the same level again replaces that report."""
        asset = self._current_level()
        if not asset:
            raise RuntimeError("no level is open to save: run.new_level or run.load_level first")
        if not _subsystem("LevelEditorSubsystem").save_current_level():
            raise RuntimeError("LevelEditorSubsystem.save_current_level returned False for %s" % asset)
        path = self._level_file(asset)
        if path is None:
            raise RuntimeError("%s is not under %s: only the project's own levels are saved and reported" % (asset, GAME_ROOT))
        if not os.path.isfile(path):
            raise IOError("save_current_level returned True, but %s is not there" % self.name(path))
        actors = self.actors()
        entry = {
            "asset": asset, "file": self.name(path), "sha256": _sha256(path), "saved_at": _iso(time.time()),
            "actors": [describe_actor(a) for a in actors[:MAX_ACTORS]], "actors_total": len(actors),
        }
        self.levels.pop(asset, None)
        self.levels[asset] = entry
        return entry

    # ── inside ───────────────────────────────────────────────────────────────

    def _check_asset(self, asset):
        if not isinstance(asset, str) or not asset.startswith(GAME_ROOT) or "." in asset.rsplit("/", 1)[-1]:
            raise ValueError("%r is not a level's package path under %s (e.g. /Game/Maps/MyLevel)" % (asset, GAME_ROOT))

    def _current_level(self):
        """The level open in the editor: its world's package path; the level this run opened last when the world says none."""
        try:
            world = _subsystem("UnrealEditorSubsystem").get_editor_world()
            package = str(world.get_path_name()).split(".", 1)[0] if world is not None else ""
        except Exception as e:  # noqa: BLE001 (said in the notes; the run's own record stands)
            self.note("the editor world could not be read (%s: %s); the level this run opened last is taken" % (type(e).__name__, e))
            package = ""
        if package.startswith(GAME_ROOT):
            if self.level and package != self.level:
                self.note("the editor's world is %s, not %s, the level this run opened last" % (package, self.level))
            return package
        return self.level

    def _level_file(self, asset):
        """A level's file: <Content>/<the path after /Game/>.umap; None for a level outside the project's content."""
        if not asset.startswith(GAME_ROOT) or not self.content:
            return None
        return os.path.join(self.content, *asset[len(GAME_ROOT):].split("/")) + ".umap"

    def write(self, ok, error=None, tb=None, returned=None):
        """Write the result file: to a temporary name, then renamed over the result, so it is never half there."""
        ended = time.time()
        harness_sha = None
        try:
            harness_sha = _sha256(os.path.abspath(__file__))
        except Exception:  # noqa: BLE001 (said: the result does not say which harness ran)
            self.note("the harness could not hash its own file")
        body = {
            "ok": bool(ok), "run": self.run, "script_sha256": self.script_sha256,
            "harness": dict(HARNESS, **({"sha256": harness_sha} if harness_sha else {})),
            "unreal_version": unreal_version(),
            "levels": list(self.levels.values()), "actors_made": list(self.made), "removed": list(self.removed),
            "files": dict(self.files), "deleted": list(self.deleted), "watched": [self.name(w) for w in self.watch],
            "inputs": dict(self.inputs), "units": dict(UNITS), "bounds_method": BOUNDS_METHOD,
            "timing": {"started": _iso(self.started), "ended": _iso(ended), "seconds": round(ended - self.started, 3)},
        }
        if self.project_file:
            body["project"] = self.name(self.project_file)
        if self.content:
            body["content"] = self.name(self.content)
        if self.script_sha256_read is not None:
            body["script_sha256_read"] = self.script_sha256_read
        if self.script_ran is not None:
            body["script_ran"] = self.script_ran
        if returned is not None:
            body["returned"] = _jsonable(returned)
        if self.notes:
            body["notes"] = list(self.notes)
        if error is not None:
            body["error"] = self.scrub(error)[:2000]
        if tb:
            body["traceback"] = self.scrub(tb)[-4000:]
        folder = os.path.dirname(self.result_path)
        if not os.path.isdir(folder):
            os.makedirs(folder)
        temp = "%s.%d.tmp" % (self.result_path, os.getpid())
        with open(temp, "w") as f:
            json.dump(body, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(temp, self.result_path)
        return body


def _changes(run, before, after):
    """The files created or changed between two listings, named with their sha256; and those gone."""
    for path in sorted(after):
        if before.get(path) != after[path]:
            try:
                run.files[run.name(path)] = _sha256(path)
            except (IOError, OSError) as e:
                run.note("%s changed during the run but could not be read (%s)" % (run.name(path), e))
    run.deleted.extend(run.name(p) for p in sorted(before) if p not in after)


def harness_main(environ=None):
    """Run the script Timmy kept (TIMMY_SCRIPT) inside this Unreal, and write the result file. Returns the result written."""
    global _CURRENT
    run = Run(environ)
    _CURRENT = run
    before = _listing(run.watch)
    error, tb, returned = None, None, None
    try:
        if not run.script:
            raise RuntimeError("TIMMY_SCRIPT names no script to run")
        with open(run.script, "rb") as f:
            code = f.read()
        run.script_sha256_read = hashlib.sha256(code).hexdigest()
        run.script_ran = run.name(run.script)
        print("timmy_unreal %s: running %s (run %s)" % (HARNESS["version"], run.script_ran, (run.run or "by hand")[:8]))
        if run.script_dir and run.script_dir not in sys.path:
            sys.path.insert(0, run.script_dir)
        namespace = {"__name__": "__timmy_script__", "__file__": run.script, "__builtins__": __builtins__}
        exec(compile(code, run.script, "exec"), namespace)
        main = namespace.get("main")
        if callable(main):
            returned = main(run)
    except (Exception, SystemExit) as e:  # noqa: BLE001 (every failure is written down, never lost)
        error = "%s: %s" % (type(e).__name__, e)
        tb = traceback.format_exc()
    try:
        _changes(run, before, _listing(run.watch))
    except Exception as e:  # noqa: BLE001
        if error is None:
            error = "the watched folders could not be listed after the script: %s: %s" % (type(e).__name__, e)
    body = run.write(error is None, error=error, tb=tb, returned=returned)
    print("timmy_unreal: %s; result %s" % ("ok" if body["ok"] else "ok: false", run.name(run.result_path)))
    return body


def _bare_result(error):
    """A result that says why the harness itself could not start (written without the module's own run)."""
    root = os.environ.get("TIMMY_ROOT") or os.getcwd()
    path = os.environ.get("TIMMY_RESULT") or os.path.join(os.environ.get("TIMMY_OUT") or os.path.join(root, "out"), "timmy-result.json")
    folder = os.path.dirname(path)
    if not os.path.isdir(folder):
        os.makedirs(folder)
    with open(path, "w") as f:
        json.dump({"ok": False, "run": os.environ.get("TIMMY_RUN"), "script_sha256": os.environ.get("TIMMY_SCRIPT_SHA256"),
                   "files": {}, "harness": dict(HARNESS), "error": error}, f, indent=2, sort_keys=True)


if __name__ == "__main__":
    # Unreal runs this file as a script: it is imported again as the module timmy_unreal, so that the run lives in one
    # module and a script's `import timmy_unreal` gets it. TIMMY_UNREAL_LIB comes first on sys.path, then this file's folder.
    # No bytecode is written: importing itself made Unreal's Python write __pycache__/timmy_unreal.cpython-311.pyc beside
    # this file (H72's second Mac run), which in an installed Timmy is Timmy's own folder, outside the project.
    sys.dont_write_bytecode = True
    try:
        _here = os.path.dirname(os.path.abspath(__file__))
    except NameError:  # a host that runs the file without __file__
        _here = None
    for _folder in reversed([os.environ.get("TIMMY_UNREAL_LIB"), _here]):
        if _folder and _folder not in sys.path:
            sys.path.insert(0, _folder)
    try:
        import timmy_unreal as _module
    except Exception as _missing:  # noqa: BLE001 (the run still leaves a result that says what went wrong)
        _bare_result("ImportError: the harness could not import itself as timmy_unreal (%s): set TIMMY_UNREAL_LIB to the "
                     "folder holding timmy_unreal.py" % _missing)
    else:
        _module.harness_main()
