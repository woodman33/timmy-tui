"""Stand-in for c4d.documents (see the package docstring): not Cinema 4D."""
import json
import os

import c4d


class _RenderData(c4d._Params):
    def GetDataInstance(self):
        return dict(self._params)


class _BaseDraw(object):
    def __init__(self):
        self.camera = None

    def SetSceneCamera(self, cam):
        self.camera = cam


class BaseDocument(object):
    def __init__(self):
        self.name = ""
        self.objects, self.materials = [], []
        self.rd = _RenderData()
        self.bd = None if os.environ.get("C4D_STUB_NO_VIEW") else _BaseDraw()

    def SetDocumentName(self, name):
        self.name = name

    def InsertMaterial(self, mat):
        self.materials.append(mat)

    def InsertObject(self, obj):
        self.objects.append(obj)

    def GetActiveBaseDraw(self):
        return self.bd

    def GetActiveRenderData(self):
        return self.rd

    def ExecutePasses(self, bt, animation, expressions, caches, flags):
        return True


def SaveDocument(doc, name, saveflags, format):
    if format != c4d.FORMAT_C4DEXPORT:
        return False
    with open(name, "w") as f:
        json.dump({"stand-in c4d document": doc.name, "objects": [o.GetName() for o in doc.objects]}, f)
    return True


def RenderDocument(doc, rdata, bmp, renderflags=0, th=None, prog=None, wprog=None):
    if os.environ.get("C4D_STUB_RENDER_FAIL"):
        return 1
    bmp._rendered = (rdata.get(c4d.RDATA_XRES), rdata.get(c4d.RDATA_YRES), rdata.get(c4d.RDATA_RENDERENGINE))
    return c4d.RENDERRESULT_OK
