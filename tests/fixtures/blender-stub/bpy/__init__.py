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
"""
import json
import os


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


class _Mesh(object):
    def __init__(self, name):
        self.name = name
        self.materials = []


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


class Object(_Strict):
    _fields = ("name", "data", "location", "rotation_euler", "scale", "constraints")

    def __init__(self, name, data):
        self.name = name
        self.data = data
        self.location = (0.0, 0.0, 0.0)
        self.rotation_euler = (0.0, 0.0, 0.0)
        self.scale = (1.0, 1.0, 1.0)
        self.constraints = _Constraints()


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


class _Scene(_Strict):
    _fields = ("name", "collection", "camera", "render", "display", "frame_start", "frame_end")

    def __init__(self):
        self.name = "Scene"
        self.collection = _Collection("Scene Collection")
        self.collection.children.append(_Collection("Collection"))
        self.camera = None
        self.render = _Render()
        self.display = _Display()
        self.frame_start = 1
        self.frame_end = 250

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


class _Context(object):
    def __init__(self):
        self.scene = _Scene()
        self.view_layer = _ViewLayer()

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


def _add_mesh(kind, location, **dims):
    """A mesh object at `location`, linked to the active collection and made active, as the primitive
    operators do."""
    mesh = data.meshes.new(kind)
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


class _WmOps(object):
    @staticmethod
    def save_as_mainfile(filepath="", check_existing=False):
        if not filepath.endswith(".blend"):
            return {"CANCELLED"}
        with open(filepath, "w") as f:
            json.dump({
                "stand-in blend": True,
                "objects": sorted(o.name for o in context.scene.objects),
                "materials": [m.name for m in data.materials],
                "camera": context.scene.camera.name if context.scene.camera else None,
            }, f, sort_keys=True)
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
                f.write(b"\x89PNG\r\n\x1a\n stand-in %dx%d %s" % (r.resolution_x, r.resolution_y, r.engine.encode()))
        return {"FINISHED"}


class _Ops(object):
    mesh = _MeshOps()
    wm = _WmOps()
    render = _RenderOps()


ops = _Ops()
