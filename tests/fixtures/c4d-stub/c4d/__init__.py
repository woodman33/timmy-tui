"""A STAND-IN for Cinema 4D's `c4d` Python module, for tests/native-python.test.ts. It is not Cinema 4D:
it renders nothing and its constants' values are made up. It defines only the names the starter
(templates/c4d-starter/scene.py) uses, as the Cinema 4D Python SDK documents them, so a name the starter
gets wrong fails here with an AttributeError. Passing against it says the starter's own logic and its
result file hold together, not that Cinema 4D accepts the calls.
"""
import os

# made-up values; only their identity matters here
Mmaterial, Ocube, Ocamera, Ostage, Ttexture, Ttargetexpression = 5703, 5159, 5103, 5136, 5616, 5676
STAGEOBJECT_CLINK = 1000
MATERIAL_COLOR_COLOR, PRIM_CUBE_LEN, TEXTURETAG_MATERIAL, TARGETEXPRESSIONTAG_LINK = 2000, 1100, 1010, 1001
RDATA_RENDERENGINE, RDATA_RENDERENGINE_STANDARD, RDATA_XRES, RDATA_YRES = 5300, 0, 5301, 5302
BUILDFLAGS_NONE = 0
SAVEDOCUMENTFLAGS_DONTADDTORECENTLIST = 2
FORMAT_C4DEXPORT = 1001026
IMAGERESULT_OK = 1
RENDERFLAGS_EXTERNAL, RENDERFLAGS_NODOCUMENTCLONE = 2, 8
RENDERRESULT_OK = 0
FILTER_PNG = 1101


def GetC4DVersion():
    return int(os.environ.get("C4D_STUB_VERSION", "2026000"))


class Vector(object):
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)


class _Params(object):
    """Parameter access by id, as BaseList2D's obj[id] = value."""

    def __init__(self):
        self._params = {}
        self._name = ""

    def __setitem__(self, key, value):
        self._params[key] = value

    def __getitem__(self, key):
        return self._params[key]

    def SetName(self, name):
        self._name = name

    def GetName(self):
        return self._name


class BaseTag(_Params):
    def __init__(self, tag_type):
        _Params.__init__(self)
        self.type = tag_type


class BaseMaterial(_Params):
    def __init__(self, mat_type):
        _Params.__init__(self)
        self.type = mat_type


class BaseObject(_Params):
    def __init__(self, obj_type):
        _Params.__init__(self)
        self.type = obj_type
        self.tags = []
        self.pos = Vector()

    def MakeTag(self, tag_type):
        tag = BaseTag(tag_type)
        self.tags.append(tag)
        return tag

    def SetAbsPos(self, v):
        self.pos = v


class CameraObject(BaseObject):
    def __init__(self):
        BaseObject.__init__(self, Ocamera)
