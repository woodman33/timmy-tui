"""A STAND-IN for Blender's `bpy` module, for tests/native-blender.test.ts. It is not Blender: it renders
nothing and saves no real .blend. It defines only the names the Blender starter
(templates/blender-starter/scene.py) and its helper (workers/blender/timmy_blender.py) use, as the Blender
Python API documents them; attributes and enum values outside that set raise (AttributeError, TypeError),
so a name the starter gets wrong fails here. Passing against it says the starter's own logic and its
result file hold together, not that Blender accepts the calls.

BPY_STUB_RENDER_FAIL=1 makes bpy.ops.render.render return {'CANCELLED'}; BPY_STUB_VERSION sets the version.

As in Blender's factory startup, the scene's master collection has one child collection, "Collection", the
active one: the primitive operators link their objects there (bpy.context.collection), not to
scene.collection, so scene.collection.objects misses them and scene.objects (every object in the scene's
collections) has them all. Round R3 found this on the Mac: the first real run listed 3 of 7 objects.

Round R4 (/iterate blender, H26): the stand-in .blend that save_as_mainfile writes is JSON, and from R4 it also
keeps a "data" section (each object's type, location, dimensions and materials, the camera, the frame range and
the resolution). BPY_STUB_OPEN=<file> stands in for `blender -b <file>`: the module opens that stand-in .blend
when it is imported (tests/fixtures/fake-blender.mjs sets it for /iterate's second pass, which runs
workers/readback/blend_readback.py). A file that is not a stand-in .blend leaves no file open (bpy.data.filepath
''), as Blender keeps its startup scene when it cannot read a file. Dimensions here come from the primitives'
arguments (a plane has no depth), not from any geometry.

Round R4 (H37, object dimensions): a mesh object's geometry is its primitive's local bounding box, from the
operator's arguments (a cube of size s spans -s/2..s/2; a UV sphere of radius r, -r..r; a cylinder of radius r and
depth d, -r..r and -d/2..d/2; a plane of size s, -s/2..s/2 with no depth), never measured from vertices. From it, as
the Blender Python API documents them:
  Object.bound_box      its 8 corners in object space, in Blender's corner order; all -1.0 for an object without
                        geometry (an empty, a camera, a light), as Blender gives when no bounding box is available
  Object.matrix_world   location, rotation_euler (XYZ) and scale as a 4x4 matrix (rows, indexed m[row][col]);
                        constraints (the starter camera's Track To) and parents are NOT applied here
  Object.dimensions     the bounding box's extent times the absolute scale; setting it sets the scale, as in Blender
  Object.evaluated_get  the object itself: the stand-in has no modifiers, so the evaluated object is the original
  Context.evaluated_depsgraph_get   a depsgraph that only names the scene and its view layer
  Scene.unit_settings   system METRIC, scale_length 1.0, length_unit METERS (Blender's factory settings)
The stand-in .blend keeps each object's local bounds, location, rotation and scale, and the unit settings, so the
second pass rebuilds the same transforms. The stand-in render's bytes now depend on the scene (its objects' names,
transforms and bounds, after the PNG signature), so a changed scene renders other bytes, as a real render would.
"""
import hashlib
import json
import math
import os
import sys


class _Strict(object):
    """Attributes limited to a declared set, as bpy's RNA properties are."""
    _fields = ()
    _enums = {}

    def __setattr__(self, key, value):
        if key not in self._fields:
            raise AttributeError("'%s' object has no attribute '%s' (stand-in bpy)" % (type(self).__name__, key))
        allowed = self._enums.get(key)
        if allowed is not None and value not in allowed:
            raise TypeError("enum \"%s\" not found in %s (stand-in bpy)" % (value, sorted(allowed)))
        object.__setattr__(self, key, value)


class _Socket(_Strict):
    _fields = ("default_value",)

    def __init__(self, value):
        self.default_value = value


class _Node(object):
    def __init__(self, name):
        self.name = name
        self.inputs = {"Base Color": _Socket((0.8, 0.8, 0.8, 1.0)), "Roughness": _Socket(0.5)}


class _Nodes(object):
    def __init__(self):
        self._nodes = {"Principled BSDF": _Node("Principled BSDF")}

    def get(self, name, default=None):
        return self._nodes.get(name, default)


class _NodeTree(object):
    def __init__(self):
        self.nodes = _Nodes()


class Material(_Strict):
    _fields = ("name", "diffuse_color", "use_nodes", "node_tree", "roughness")

    def __init__(self, name):
        self.name = name
        self.diffuse_color = (0.8, 0.8, 0.8, 1.0)
        self.node_tree = None
        self.use_nodes = False
        self.roughness = 0.4

    def __setattr__(self, key, value):
        _Strict.__setattr__(self, key, value)
        if key == "use_nodes" and value and self.node_tree is None:
            object.__setattr__(self, "node_tree", _NodeTree())

    @property
    def users(self):
        """How many meshes hold it (read-only, as in Blender; the stand-in counts meshes only)."""
        return sum(1 for mesh in data.meshes if self in mesh.materials)

    @property
    def use_fake_user(self):
        return False


class _Mesh(object):
    def __init__(self, name):
        self.name = name
        self.materials = []
        # R4 (H37): its local bounding box, (min, max) in object space; None until a primitive operator gives it one
        self.bounds_local = None


class Camera(_Strict):
    _fields = ("name", "lens", "clip_end")

    def __init__(self, name):
        self.name = name
        self.lens = 50.0
        self.clip_end = 100.0


class Light(_Strict):
    _fields = ("name", "type", "energy", "angle")
    _enums = {"type": {"POINT", "SUN", "SPOT", "AREA"}}

    def __init__(self, name, type):
        self.name = name
        self.type = type
        self.energy = 1.0
        self.angle = 0.0


class _Constraint(_Strict):
    _fields = ("type", "target", "track_axis", "up_axis")
    _enums = {
        "track_axis": {"TRACK_X", "TRACK_Y", "TRACK_Z", "TRACK_NEGATIVE_X", "TRACK_NEGATIVE_Y", "TRACK_NEGATIVE_Z"},
        "up_axis": {"UP_X", "UP_Y", "UP_Z"},
    }

    def __init__(self, type):
        self.type = type
        self.target = None
        self.track_axis = "TRACK_Y"
        self.up_axis = "UP_Z"


class _Constraints(object):
    def __init__(self):
        self.items = []

    def new(self, type):
        if type not in ("TRACK_TO", "DAMPED_TRACK", "LOCKED_TRACK"):
            raise TypeError("enum \"%s\" not found (stand-in bpy)" % type)
        c = _Constraint(type)
        self.items.append(c)
        return c


class _MaterialSlot(object):
    def __init__(self, material):
        self.material = material
        self.name = material.name if material is not None else ""


def _euler_xyz(rx, ry, rz):
    """Blender's eul_to_mat3 for the XYZ order (R = Rz Ry Rx), as rows."""
    ci, cj, ch = math.cos(rx), math.cos(ry), math.cos(rz)
    si, sj, sh = math.sin(rx), math.sin(ry), math.sin(rz)
    cc, cs, sc, ss = ci * ch, ci * sh, si * ch, si * sh
    return (
        (cj * ch, sj * sc - cs, sj * cc + ss),
        (cj * sh, sj * ss + cc, sj * cs - sc),
        (-sj, cj * si, cj * ci),
    )


class Object(_Strict):
    _fields = ("name", "data", "location", "rotation_euler", "scale", "constraints", "dimensions")

    def __init__(self, name, data):
        self.name = name
        self.data = data
        self.location = (0.0, 0.0, 0.0)
        self.rotation_euler = (0.0, 0.0, 0.0)
        self.scale = (1.0, 1.0, 1.0)
        self.constraints = _Constraints()

    def _bounds(self):
        """(min, max) in object space, or None: only a mesh with a primitive's bounds has geometry here."""
        return self.data.bounds_local if isinstance(self.data, _Mesh) else None

    @property
    def bound_box(self):
        """The 8 corners of its bounding box in object space, in Blender's order (BKE_boundbox_init_from_minmax);
        all -1.0 when it has none (Blender's "not available"), as for an empty, a camera or a light."""
        b = self._bounds()
        if b is None:
            return tuple((-1.0, -1.0, -1.0) for _ in range(8))
        lo, hi = b
        return (
            (lo[0], lo[1], lo[2]), (lo[0], lo[1], hi[2]), (lo[0], hi[1], hi[2]), (lo[0], hi[1], lo[2]),
            (hi[0], lo[1], lo[2]), (hi[0], lo[1], hi[2]), (hi[0], hi[1], hi[2]), (hi[0], hi[1], lo[2]),
        )

    @property
    def matrix_world(self):
        """Location, rotation (XYZ Euler) and scale as a 4x4 matrix, rows indexed m[row][col] as mathutils does.
        No parent and no constraint is applied (the stand-in has neither in its world matrix)."""
        r = _euler_xyz(*[float(a) for a in self.rotation_euler])
        s = [float(a) for a in self.scale]
        t = [float(a) for a in self.location]
        # (+ 0.0: no negative zero, which -sin(0) would give)
        return tuple(tuple(r[i][j] * s[j] + 0.0 for j in range(3)) + (t[i] + 0.0,) for i in range(3)) + ((0.0, 0.0, 0.0, 1.0),)

    @property
    def dimensions(self):
        """The bounding box's extent times the absolute scale (Blender: BKE_object_dimensions_get); (0, 0, 0)
        without geometry."""
        b = self._bounds()
        if b is None:
            return (0.0, 0.0, 0.0)
        return tuple(abs(float(self.scale[i])) * (b[1][i] - b[0][i]) for i in range(3))

    @dimensions.setter
    def dimensions(self, value):
        """Sets the scale so the extent times the scale is `value`, keeping each scale's sign (Blender:
        BKE_object_dimensions_set); nothing without geometry, nor on an axis of no extent."""
        b = self._bounds()
        if b is None:
            return
        scale = list(self.scale)
        for i in range(3):
            extent = b[1][i] - b[0][i]
            if extent:
                scale[i] = math.copysign(float(value[i]) / extent, scale[i] or 1.0)
        self.scale = tuple(scale)

    def evaluated_get(self, depsgraph):
        """The evaluated object: the object itself (the stand-in has no modifiers to evaluate)."""
        if not isinstance(depsgraph, _Depsgraph):
            raise TypeError("evaluated_get expects a Depsgraph (stand-in bpy)")
        return self

    @property
    def type(self):
        """From its data, read-only, as in Blender: MESH, CAMERA, LIGHT, or EMPTY with none."""
        if isinstance(self.data, _Mesh):
            return "MESH"
        if isinstance(self.data, Camera):
            return "CAMERA"
        if isinstance(self.data, Light):
            return "LIGHT"
        return "EMPTY"

    @property
    def material_slots(self):
        """A mesh object's slots, one per material its mesh holds."""
        return [_MaterialSlot(m) for m in self.data.materials] if isinstance(self.data, _Mesh) else []


class _IDs(object):
    def __init__(self):
        self._items = []

    def __iter__(self):
        return iter(list(self._items))

    def __len__(self):
        return len(self._items)

    def get(self, name, default=None):
        for item in self._items:
            if item.name == name:
                return item
        return default


class _Objects(_IDs):
    def new(self, name, object_data):
        obj = Object(name, object_data)
        self._items.append(obj)
        return obj

    def remove(self, obj, do_unlink=True):
        self._items.remove(obj)
        for coll in context.scene._collections():
            if obj in coll.objects._linked:
                coll.objects._linked.remove(obj)


class _Materials(_IDs):
    def new(self, name):
        mat = Material(name)
        self._items.append(mat)
        return mat


class _Cameras(_IDs):
    def new(self, name):
        cam = Camera(name)
        self._items.append(cam)
        return cam


class _Lights(_IDs):
    def new(self, name, type):
        light = Light(name, type)
        self._items.append(light)
        return light


class _Meshes(_IDs):
    def new(self, name):
        mesh = _Mesh(name)
        self._items.append(mesh)
        return mesh


class _Data(object):
    def __init__(self):
        self.objects = _Objects()
        self.materials = _Materials()
        self.cameras = _Cameras()
        self.lights = _Lights()
        self.meshes = _Meshes()
        # the open .blend's path: '' until one is saved or opened (as in Blender); the scenes, set below
        self.filepath = ""
        self.scenes = []


class _Linked(object):
    def __init__(self):
        self._linked = []

    def link(self, obj):
        if obj in self._linked:
            raise RuntimeError("Object '%s' already in collection (stand-in bpy)" % obj.name)
        self._linked.append(obj)

    def __iter__(self):
        return iter(list(self._linked))


class _Collection(object):
    def __init__(self, name):
        self.name = name
        self.objects = _Linked()
        self.children = []


class _ImageSettings(_Strict):
    _fields = ("file_format", "color_mode")
    _enums = {"file_format": {"PNG", "JPEG", "OPEN_EXR", "TIFF"}, "color_mode": {"BW", "RGB", "RGBA"}}

    def __init__(self):
        self.file_format = "PNG"
        self.color_mode = "RGBA"


class _Render(_Strict):
    _fields = ("engine", "resolution_x", "resolution_y", "resolution_percentage", "filepath", "image_settings", "film_transparent")
    _enums = {"engine": {"BLENDER_WORKBENCH", "BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "CYCLES"}}

    def __init__(self):
        self.engine = "BLENDER_EEVEE"
        self.resolution_x = 1920
        self.resolution_y = 1080
        self.resolution_percentage = 100
        self.filepath = "/tmp/"
        self.image_settings = _ImageSettings()
        self.film_transparent = False


class _Shading(_Strict):
    _fields = ("light", "color_type", "show_shadows", "show_cavity")
    _enums = {"light": {"STUDIO", "MATCAP", "FLAT"}, "color_type": {"MATERIAL", "OBJECT", "SINGLE", "RANDOM", "TEXTURE", "VERTEX", "ATTRIBUTE"}}

    def __init__(self):
        self.light = "STUDIO"
        self.color_type = "MATERIAL"
        self.show_shadows = False
        self.show_cavity = False


class _Display(object):
    def __init__(self):
        self.shading = _Shading()


class _UnitSettings(_Strict):
    """Scene.unit_settings, with Blender's factory values (R4, H37)."""
    _fields = ("system", "scale_length", "length_unit")
    _enums = {"system": {"NONE", "METRIC", "IMPERIAL"}}

    def __init__(self):
        self.system = "METRIC"
        self.scale_length = 1.0
        self.length_unit = "METERS"


class _Scene(_Strict):
    _fields = ("name", "collection", "camera", "render", "display", "frame_start", "frame_end", "unit_settings")

    def __init__(self):
        self.name = "Scene"
        self.collection = _Collection("Scene Collection")
        self.collection.children.append(_Collection("Collection"))
        self.camera = None
        self.render = _Render()
        self.display = _Display()
        self.frame_start = 1
        self.frame_end = 250
        self.unit_settings = _UnitSettings()

    def _collections(self):
        out, todo = [], [self.collection]
        while todo:
            coll = todo.pop(0)
            out.append(coll)
            todo.extend(coll.children)
        return out

    @property
    def objects(self):
        """Every object in the scene's collections, each once (read-only, as in Blender)."""
        seen = []
        for coll in self._collections():
            for obj in coll.objects:
                if obj not in seen:
                    seen.append(obj)
        return seen


class _ViewLayerObjects(object):
    def __init__(self):
        self.active = None


class _ViewLayer(object):
    def __init__(self):
        self.objects = _ViewLayerObjects()


class _Depsgraph(object):
    """What Context.evaluated_depsgraph_get returns here: the scene and view layer it is for, nothing evaluated
    (the stand-in has no modifiers or drivers to evaluate)."""

    def __init__(self, scene, view_layer):
        self.scene = scene
        self.view_layer = view_layer


class _Context(object):
    def __init__(self):
        self.scene = _Scene()
        self.view_layer = _ViewLayer()

    def evaluated_depsgraph_get(self):
        """R4 (H37): the depsgraph of the context's scene and view layer."""
        return _Depsgraph(self.scene, self.view_layer)

    @property
    def active_object(self):
        return self.view_layer.objects.active

    @property
    def collection(self):
        """The active collection: the factory startup's "Collection"."""
        return self.scene.collection.children[0]

    @property
    def object(self):
        return self.view_layer.objects.active


class _App(object):
    @property
    def version_string(self):
        return os.environ.get("BPY_STUB_VERSION", "4.2.0 (stand-in)")

    version = (4, 2, 0)
    background = True


data = _Data()
context = _Context()
app = _App()
data.scenes.append(context.scene)


def _local_bounds(kind, dims):
    """A primitive's local bounding box, (min, max), from its operator's arguments, centred on its origin as
    Blender builds them (the stand-in has no vertices to measure)."""
    if kind == "plane":
        h = float(dims.get("size", 2.0)) / 2
        return ((-h, -h, 0.0), (h, h, 0.0))
    if kind == "cube":
        h = float(dims.get("size", 2.0)) / 2
        return ((-h, -h, -h), (h, h, h))
    if kind == "sphere":
        r = float(dims.get("radius", 1.0))
        return ((-r, -r, -r), (r, r, r))
    if kind == "cylinder":
        r = float(dims.get("radius", 1.0))
        h = float(dims.get("depth", 2.0)) / 2
        return ((-r, -r, -h), (r, r, h))
    return None


def _add_mesh(kind, location, **dims):
    """A mesh object at `location`, linked to the active collection and made active, as the primitive
    operators do; its mesh holds the primitive's local bounds (R4, H37)."""
    mesh = data.meshes.new(kind)
    mesh.bounds_local = _local_bounds(kind, dims)
    obj = data.objects.new(kind.capitalize(), mesh)
    obj.location = tuple(location)
    context.collection.objects.link(obj)
    context.view_layer.objects.active = obj
    return {"FINISHED"}


class _MeshOps(object):
    @staticmethod
    def primitive_plane_add(size=2.0, location=(0.0, 0.0, 0.0)):
        return _add_mesh("plane", location, size=size)

    @staticmethod
    def primitive_cube_add(size=2.0, location=(0.0, 0.0, 0.0)):
        return _add_mesh("cube", location, size=size)

    @staticmethod
    def primitive_uv_sphere_add(radius=1.0, location=(0.0, 0.0, 0.0), segments=32, ring_count=16):
        return _add_mesh("sphere", location, radius=radius)

    @staticmethod
    def primitive_cylinder_add(radius=1.0, depth=2.0, location=(0.0, 0.0, 0.0), vertices=32):
        return _add_mesh("cylinder", location, radius=radius, depth=depth)


def _saved_object(o):
    entry = {
        "name": o.name, "type": o.type, "data": o.data.name if o.data is not None else None,
        "location": list(o.location), "dimensions": list(o.dimensions), "materials": [s.material.name for s in o.material_slots],
        # R4 (H37): the transform and the geometry's local bounds, so the second pass rebuilds the same object
        "rotation_euler": list(o.rotation_euler), "scale": list(o.scale),
    }
    if isinstance(o.data, _Mesh) and o.data.bounds_local is not None:
        entry["bounds_local"] = [list(o.data.bounds_local[0]), list(o.data.bounds_local[1])]
    if isinstance(o.data, Camera):
        entry["lens"] = o.data.lens
    if isinstance(o.data, Light):
        entry["light_type"] = o.data.type
    return entry


def _scene_digest(scene):
    """What the stand-in render depends on: the scene's objects (names, types, transforms, bounds, materials) and
    its render settings, hashed. A real render changes when the scene does; so does this one."""
    r = scene.render
    objects = sorted(([o.name, o.type, list(o.location), list(o.rotation_euler), list(o.scale), list(o.dimensions),
                       [s.material.name for s in o.material_slots]] for o in scene.objects), key=lambda x: x[0])
    body = json.dumps({"objects": objects, "camera": scene.camera.name if scene.camera else None,
                       "resolution": [r.resolution_x, r.resolution_y], "engine": r.engine}, sort_keys=True)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


class _WmOps(object):
    @staticmethod
    def save_as_mainfile(filepath="", check_existing=False):
        if not filepath.endswith(".blend"):
            return {"CANCELLED"}
        scene = context.scene
        r = scene.render
        with open(filepath, "w") as f:
            json.dump({
                "stand-in blend": True,
                "objects": sorted(o.name for o in scene.objects),
                "materials": [m.name for m in data.materials],
                "camera": scene.camera.name if scene.camera else None,
                # R4 (H26): what /iterate's second pass reads back when this stand-in .blend is opened (BPY_STUB_OPEN)
                "data": {
                    "scene": {
                        "name": scene.name, "camera": scene.camera.name if scene.camera else None,
                        "frame_start": scene.frame_start, "frame_end": scene.frame_end,
                        "resolution": [r.resolution_x, r.resolution_y], "resolution_percentage": r.resolution_percentage, "engine": r.engine,
                        # R4 (H37)
                        "units": {"system": scene.unit_settings.system, "scale_length": scene.unit_settings.scale_length, "length_unit": scene.unit_settings.length_unit},
                    },
                    "materials": [m.name for m in data.materials],
                    "objects": [_saved_object(o) for o in scene.objects],
                },
            }, f, sort_keys=True)
        data.filepath = os.path.abspath(filepath)
        return {"FINISHED"}


class _RenderOps(object):
    @staticmethod
    def render(write_still=False, animation=False):
        if os.environ.get("BPY_STUB_RENDER_FAIL"):
            return {"CANCELLED"}
        scene = context.scene
        if scene.camera is None:
            raise RuntimeError("Error: No camera found in scene (stand-in bpy)")
        if write_still:
            r = scene.render
            with open(r.filepath, "wb") as f:
                # R4 (H37): the scene's digest after the signature, so another scene renders other bytes
                f.write(b"\x89PNG\r\n\x1a\n stand-in %dx%d %s %s" % (r.resolution_x, r.resolution_y, r.engine.encode(), _scene_digest(scene).encode()))
        return {"FINISHED"}


class _Ops(object):
    mesh = _MeshOps()
    wm = _WmOps()
    render = _RenderOps()


ops = _Ops()


def _open(path):
    """`blender -b <path>` for the stand-in: the stand-in .blend's "data" made the open scene. A file that is not
    one leaves nothing open (bpy.data.filepath stays ''), as Blender keeps its startup scene when a read fails."""
    try:
        with open(path) as f:
            saved = json.load(f)
        d = saved["data"]
        objects = d["objects"]
    except Exception as e:
        sys.stderr.write("stand-in bpy: %s is not a stand-in .blend (%s); no file is open\n" % (os.path.basename(path), type(e).__name__))
        return
    mats = dict((name, data.materials.new(name)) for name in d.get("materials", []))
    scene = context.scene
    s = d.get("scene", {})
    r = scene.render
    scene.name = s.get("name", "Scene")
    scene.frame_start = s.get("frame_start", 1)
    scene.frame_end = s.get("frame_end", 250)
    res = s.get("resolution") or [r.resolution_x, r.resolution_y]
    r.resolution_x, r.resolution_y = res[0], res[1]
    r.resolution_percentage = s.get("resolution_percentage", 100)
    r.engine = s.get("engine", r.engine)
    units = s.get("units") or {}
    for key in ("system", "scale_length", "length_unit"):
        if key in units:
            setattr(scene.unit_settings, key, units[key])
    for od in objects:
        kind = od.get("type")
        if kind == "MESH":
            obj_data = data.meshes.new(od.get("data") or od["name"])
            obj_data.materials.extend(mats[m] for m in od.get("materials", []) if m in mats)
            # R4 (H37): its local bounds as saved; a stand-in .blend from before keeps only its dimensions (centred)
            b = od.get("bounds_local")
            if b:
                obj_data.bounds_local = (tuple(b[0]), tuple(b[1]))
            elif od.get("dimensions"):
                d = [float(x) / 2 for x in od["dimensions"]]
                obj_data.bounds_local = ((-d[0], -d[1], -d[2]), (d[0], d[1], d[2]))
        elif kind == "CAMERA":
            obj_data = data.cameras.new(od.get("data") or od["name"])
            obj_data.lens = od.get("lens", 50.0)
        elif kind == "LIGHT":
            obj_data = data.lights.new(od.get("data") or od["name"], type=od.get("light_type", "SUN"))
        else:
            obj_data = None
        obj = data.objects.new(od["name"], obj_data)
        obj.location = tuple(od.get("location", (0.0, 0.0, 0.0)))
        obj.rotation_euler = tuple(od.get("rotation_euler", (0.0, 0.0, 0.0)))
        obj.scale = tuple(od.get("scale", (1.0, 1.0, 1.0)))
        context.collection.objects.link(obj)
    if s.get("camera"):
        scene.camera = data.objects.get(s["camera"])
    data.filepath = os.path.abspath(path)


if os.environ.get("BPY_STUB_OPEN"):
    _open(os.environ["BPY_STUB_OPEN"])
