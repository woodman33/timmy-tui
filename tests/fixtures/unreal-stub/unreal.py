"""A STAND-IN for Unreal Engine's `unreal` Python module, for tests/native-unreal.test.ts. It is not Unreal Engine: it has
no editor, no renderer and no real level files. It defines only the names Timmy's harness (workers/unreal/timmy_unreal.py),
its readback (workers/unreal/unreal_readback.py) and the starter (templates/unreal-starter/scene.py) use, with the
signatures Epic's Python API documents (Rotator takes roll, pitch, yaw in that order; Actor.get_actor_bounds returns
(origin, box_extent); LevelEditorSubsystem.new_level(asset_path, is_partitioned_world=False); load_level; save_current_level;
EditorActorSubsystem.spawn_actor_from_object(object_to_use, location, rotation, transient)). Any other name raises
AttributeError, so a name the harness or the starter gets wrong fails here. Passing against it says the harness, the
starter and Timmy's judgement hold together, not that Unreal accepts the calls.

The project is the .uproject UNREAL_STUB_PROJECT names (tests/fixtures/fake-unreal.mjs sets it from its command line); a
level under /Game/ is a file under the project's Content folder, <path after /Game/>.umap. The stand-in's level file is
JSON ({"stand_in": "unreal-stub-umap/1", "asset", "actors": [{name, label, class, mesh, location, rotation, scale}]}),
written by save_current_level (and by new_level, blank) and read by load_level. An actor's bounds are never stored: they
are computed from its mesh's own box (the basic cube spans -50..50 cm on each axis, centred on its pivot) through its
scale, rotation and location, as Unreal computes them from the mesh. Actors are named <Class>_<n>, n counting up from one
past the highest number in the level as it was opened, so a name is not reused within a session; a spawned actor's label
is its mesh's name until set_actor_label.

Knobs for the tests (each a FAKE fault, named so where a test sets it):
  UNREAL_STUB_VERSION        the engine version string
  UNREAL_STUB_LOAD_SHIFT_CM  load_level moves the first actor (by name) this many cm along x: a level that loads
                             otherwise than the first pass reported it
  UNREAL_STUB_LOAD_DROP      load_level leaves the last actor (by name) out
  UNREAL_STUB_SAVE_FAIL      save_current_level returns False
  UNREAL_STUB_COMMANDLET     set by the FAKE UnrealEditor-Cmd when it runs the pythonscript commandlet: then
                             spawn_actor_from_object gives no actor and logs Unreal's warning, as Unreal Engine 5.8.2's
                             commandlet did on the operator's Mac (the run r21 and H72's first Mac run), while
                             spawn_actor_from_class gives one (H72's first Mac run). Reproduced here, not explained.

R4 (H72): EditorActorSubsystem.spawn_actor_from_class(actor_class, location, rotation, transient) spawns a StaticMeshActor
with no mesh (its label the class's name, as Unreal labels a spawned actor), and its static_mesh_component's
set_static_mesh(new_mesh) gives it one (True; False for anything but a StaticMesh). An actor with no mesh has bounds of
zero extent at its location.
"""
import json
import math
import os

_VERSION = "5.8.2-0+++UE5+Release-5.8 (stand-in)"
_STAND_IN = "unreal-stub-umap/1"
#: the engine's basic shapes, by object path: each mesh's own box (min, max), in cm
_MESHES = {
    "/Engine/BasicShapes/Cube.Cube": ((-50.0, -50.0, -50.0), (50.0, 50.0, 50.0)),
    "/Engine/BasicShapes/Sphere.Sphere": ((-50.0, -50.0, -50.0), (50.0, 50.0, 50.0)),
    "/Engine/BasicShapes/Cylinder.Cylinder": ((-50.0, -50.0, -50.0), (50.0, 50.0, 50.0)),
}


def __getattr__(name):
    raise AttributeError("module 'unreal' has no attribute %r (stand-in unreal: only the names Timmy's harness, readback "
                         "and starter use are defined)" % name)


def _say(prefix, msg):
    print("%s: %s" % (prefix, msg))


def log(msg):
    _say("LogPython", msg)


def log_warning(msg):
    _say("LogPython: Warning", msg)


def log_error(msg):
    _say("LogPython: Error", msg)


class Vector(object):
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)

    def __repr__(self):
        return "<Struct 'Vector' (stand-in) {x: %f, y: %f, z: %f}>" % (self.x, self.y, self.z)


class Rotator(object):
    """As Epic documents it: Rotator(roll=0.0, pitch=0.0, yaw=0.0), in that order."""

    def __init__(self, roll=0.0, pitch=0.0, yaw=0.0):
        self.roll, self.pitch, self.yaw = float(roll), float(pitch), float(yaw)


class Class(object):
    def __init__(self, path):
        self._path = path

    def get_name(self):
        return self._path.rsplit(".", 1)[-1]

    def get_path_name(self):
        return self._path


class StaticMesh(object):
    def __init__(self, path, box):
        self._path, self._box = path, box

    def get_name(self):
        return self._path.rsplit(".", 1)[-1]

    def get_path_name(self):
        return self._path


class _Component(object):
    def __init__(self, actor):
        self._actor = actor

    def get_editor_property(self, name):
        if name == "static_mesh":
            return self._actor._mesh
        raise Exception("Failed to find property '%s' on 'StaticMeshComponent' (stand-in unreal)" % name)

    def set_static_mesh(self, new_mesh):
        """As Epic documents StaticMeshComponent.set_static_mesh: True when the mesh was set."""
        if not isinstance(new_mesh, StaticMesh):
            return False
        self._actor._mesh = new_mesh
        return True


def _rotation_rows(pitch, yaw, roll):
    """Unreal's rotation matrix for a rotator (FRotationMatrix): rows are the rotated X, Y and Z axes."""
    p, y, r = (math.radians(a) for a in (pitch, yaw, roll))
    sp, cp, sy, cy, sr, cr = math.sin(p), math.cos(p), math.sin(y), math.cos(y), math.sin(r), math.cos(r)
    return [
        [cp * cy, cp * sy, sp],
        [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp],
        [-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp],
    ]


class StaticMeshActor(object):
    _CLASS = Class("/Script/Engine.StaticMeshActor")

    def __init__(self, name, mesh, location, rotation, scale, label):
        self._name, self._mesh, self._label = name, mesh, label
        self._location = [float(v) for v in location]
        self._rotation = [float(v) for v in rotation]  # pitch, yaw, roll
        self._scale = [float(v) for v in scale]

    def get_name(self):
        return self._name

    def get_class(self):
        return self._CLASS

    def get_actor_label(self):
        return self._label

    def set_actor_label(self, new_actor_label, mark_dirty=True):
        self._label = str(new_actor_label)

    def get_actor_location(self):
        return Vector(*self._location)

    def get_actor_rotation(self):
        return Rotator(roll=self._rotation[2], pitch=self._rotation[0], yaw=self._rotation[1])

    def get_actor_scale3d(self):
        return Vector(*self._scale)

    def set_actor_scale3d(self, new_scale3d):
        self._scale = [float(new_scale3d.x), float(new_scale3d.y), float(new_scale3d.z)]

    def get_actor_bounds(self, only_colliding_components, include_from_child_actors=False):
        if self._mesh is None:
            return Vector(*self._location), Vector(0.0, 0.0, 0.0)
        lo, hi = self._mesh._box
        rows = _rotation_rows(*self._rotation)
        corners = []
        for cx in (lo[0], hi[0]):
            for cy in (lo[1], hi[1]):
                for cz in (lo[2], hi[2]):
                    v = (cx * self._scale[0], cy * self._scale[1], cz * self._scale[2])
                    corners.append([sum(v[i] * rows[i][j] for i in range(3)) + self._location[j] for j in range(3)])
        mn = [min(c[j] for c in corners) for j in range(3)]
        mx = [max(c[j] for c in corners) for j in range(3)]
        return Vector(*[(mn[j] + mx[j]) / 2 for j in range(3)]), Vector(*[(mx[j] - mn[j]) / 2 for j in range(3)])

    def get_editor_property(self, name):
        if name == "static_mesh_component":
            return _Component(self)
        raise Exception("Failed to find property '%s' on 'StaticMeshActor' (stand-in unreal)" % name)


class _World(object):
    def __init__(self, asset):
        self._asset = asset

    def get_name(self):
        return self._asset.rsplit("/", 1)[-1] if self._asset else "Untitled_1"

    def get_path_name(self):
        return "%s.%s" % (self._asset, self.get_name()) if self._asset else "/Temp/Untitled_1.Untitled_1"


_state = {"asset": None, "actors": []}


def _project():
    project = os.environ.get("UNREAL_STUB_PROJECT")
    if not project:
        raise RuntimeError("stand-in unreal: UNREAL_STUB_PROJECT names no .uproject (the FAKE UnrealEditor-Cmd sets it)")
    return project


def _level_file(asset):
    if not isinstance(asset, str) or not asset.startswith("/Game/"):
        return None
    return os.path.join(os.path.dirname(_project()), "Content", *asset[len("/Game/"):].split("/")) + ".umap"


def _seen(actors):
    """Each class's next number: one past the highest <Class>_<n> among these actors (a name is not reused in a session)."""
    out = {}
    for a in actors:
        head, _, tail = a._name.rpartition("_")
        if head and tail.isdigit():
            out[head] = max(out.get(head, 0), int(tail) + 1)
    return out


def _next_name(class_name):
    counters = _state.setdefault("next", {})
    n = counters.get(class_name, 0)
    counters[class_name] = n + 1
    return "%s_%d" % (class_name, n)


def _write_level(path):
    doc = {"stand_in": _STAND_IN, "asset": _state["asset"], "actors": [
        {"name": a._name, "label": a._label, "class": a._CLASS.get_path_name(), "mesh": a._mesh.get_path_name() if a._mesh is not None else None,
         "location": a._location, "rotation": a._rotation, "scale": a._scale}
        for a in sorted(_state["actors"], key=lambda a: a._name)]}
    folder = os.path.dirname(path)
    if not os.path.isdir(folder):
        os.makedirs(folder)
    with open(path, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
        f.write("\n")


class LevelEditorSubsystem(object):
    def new_level(self, asset_path, is_partitioned_world=False):
        path = _level_file(asset_path)
        if path is None or is_partitioned_world:
            log_error("NewLevel: %s is not a level path this stand-in makes" % asset_path)
            return False
        if os.path.exists(path):
            log_error("NewLevel: an asset already exists at %s" % asset_path)
            return False
        _state.update({"asset": asset_path, "actors": [], "next": {}})
        _write_level(path)
        return True

    def load_level(self, asset_path):
        path = _level_file(asset_path)
        try:
            with open(path) as f:
                doc = json.load(f)
        except Exception:
            log_error("LoadLevel: no level at %s" % asset_path)
            return False
        if not isinstance(doc, dict) or doc.get("stand_in") != _STAND_IN:
            log_error("LoadLevel: %s is not a level this stand-in reads" % asset_path)
            return False
        actors = []
        for a in doc.get("actors", []):
            mesh = load_asset(a["mesh"]) if a.get("mesh") else None
            actors.append(StaticMeshActor(a["name"], mesh, a["location"], a["rotation"], a["scale"], a["label"]))
        actors.sort(key=lambda a: a._name)
        shift = float(os.environ.get("UNREAL_STUB_LOAD_SHIFT_CM") or 0)
        if shift and actors:
            actors[0]._location[0] += shift
        if os.environ.get("UNREAL_STUB_LOAD_DROP") and actors:
            actors.pop()
        _state.update({"asset": asset_path, "actors": actors, "next": _seen(actors)})
        return True

    def save_current_level(self):
        if os.environ.get("UNREAL_STUB_SAVE_FAIL"):
            log_error("SaveCurrentLevel: failed (stand-in fault UNREAL_STUB_SAVE_FAIL)")
            return False
        path = _level_file(_state["asset"])
        if path is None:
            log_error("SaveCurrentLevel: the open level has no package path")
            return False
        _write_level(path)
        return True


class EditorActorSubsystem(object):
    def spawn_actor_from_object(self, object_to_use, location, rotation=None, transient=False):
        if _state["asset"] is None:
            raise RuntimeError("stand-in unreal: no level is open")
        if not isinstance(object_to_use, StaticMesh):
            raise TypeError("stand-in unreal: spawn_actor_from_object takes a StaticMesh here")
        if os.environ.get("UNREAL_STUB_COMMANDLET"):
            # what Unreal Engine 5.8.2's pythonscript commandlet did on the operator's Mac (r21; H72's first Mac run)
            _say("LogUtils: Warning", "SpawnActorFromObject. No actor was spawned.")
            return None
        rot = rotation if rotation is not None else Rotator()
        actor = StaticMeshActor(_next_name("StaticMeshActor"), object_to_use, (location.x, location.y, location.z),
                                (rot.pitch, rot.yaw, rot.roll), (1.0, 1.0, 1.0), object_to_use.get_name())
        _state["actors"].append(actor)
        return actor

    def spawn_actor_from_class(self, actor_class, location, rotation=None, transient=False):
        """As Epic documents EditorActorSubsystem.spawn_actor_from_class: an actor of the class, in the open level. Here
        only StaticMeshActor, with no mesh until its component's set_static_mesh; labelled with its class's name."""
        if _state["asset"] is None:
            raise RuntimeError("stand-in unreal: no level is open")
        if actor_class is not StaticMeshActor:
            raise TypeError("stand-in unreal: spawn_actor_from_class takes StaticMeshActor here")
        rot = rotation if rotation is not None else Rotator()
        actor = StaticMeshActor(_next_name("StaticMeshActor"), None, (location.x, location.y, location.z),
                                (rot.pitch, rot.yaw, rot.roll), (1.0, 1.0, 1.0), "StaticMeshActor")
        _state["actors"].append(actor)
        return actor

    def get_all_level_actors(self):
        return list(_state["actors"])

    def destroy_actor(self, actor_to_destroy):
        if actor_to_destroy not in _state["actors"]:
            return False
        _state["actors"].remove(actor_to_destroy)
        return True


class UnrealEditorSubsystem(object):
    def get_editor_world(self):
        return _World(_state["asset"])


_SUBSYSTEMS = {}


def get_editor_subsystem(subsystem):
    if subsystem not in (LevelEditorSubsystem, EditorActorSubsystem, UnrealEditorSubsystem):
        raise TypeError("stand-in unreal: no editor subsystem %r" % subsystem)
    if subsystem not in _SUBSYSTEMS:
        _SUBSYSTEMS[subsystem] = subsystem()
    return _SUBSYSTEMS[subsystem]


def load_asset(name, type=None, follow_redirectors=True):  # noqa: A002 (Epic's own parameter name)
    box = _MESHES.get(name)
    if box is None:
        log_warning("load_asset: nothing at %s" % name)
        return None
    return StaticMesh(name, box)


class EditorAssetLibrary(object):
    @staticmethod
    def does_asset_exist(asset_path):
        if asset_path in _MESHES:
            return True
        path = _level_file(asset_path)
        return bool(path and os.path.isfile(path))


class SystemLibrary(object):
    @staticmethod
    def get_engine_version():
        return os.environ.get("UNREAL_STUB_VERSION") or _VERSION
