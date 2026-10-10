"""A STAND-IN for FreeCAD's `FreeCAD` (App) module, for tests/native-freecad.test.ts. It is not FreeCAD: it models only
the names the FreeCAD starter (templates/freecad-starter/plate.py) and its helper (workers/freecad/timmy_freecad.py)
use, as FreeCAD's Python API documents them: Version, Vector, Rotation, Placement, newDocument, listDocuments,
getDocument, closeDocument; a Document's Name, Label, FileName, Objects, addObject, getObject, recompute and saveAs;
and the Part workbench features Part::Box, Part::Cylinder, Part::MultiFuse, Part::Cut and Part::Feature with their
properties. A property it does not define raises AttributeError, and a feature type it does not model raises, so a
name the starter gets wrong fails here. Shapes come from the stand-in Part module beside it (formulas, no kernel).

Document.saveAs writes a FAKE .FCStd: a zip holding a Document.xml that lists the objects and their properties and no
BRep shapes, with fixed times, so the same document writes the same bytes.

FREECAD_STUB_VERSION sets the version (default 1.0.0); FREECAD_STUB_FAIL=<object name> makes recompute leave that
object in error (State ["Invalid"]), as FreeCAD marks a failed feature instead of raising.
"""
import os
import zipfile
from xml.sax.saxutils import quoteattr

import Part


def Version():
    parts = (os.environ.get("FREECAD_STUB_VERSION") or "1.0.0").split(".")
    return parts[:3] + ["0 (stand-in)", "stand-in FreeCAD module", "", "stand-in", ""]


class Vector(object):
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)

    def __repr__(self):
        return "Vector (%r, %r, %r)" % (self.x, self.y, self.z)


class Rotation(object):
    """Only the identity is modelled: Rotation(), Rotation(0, 0, 0) or Rotation(Vector(...), 0)."""

    def __init__(self, *args):
        angles = [a for a in args if isinstance(a, (int, float))]
        if any(abs(a) > 1e-12 for a in angles):
            raise NotImplementedError("stand-in FreeCAD: only the identity rotation is modelled")

    def __repr__(self):
        return "Rotation (0, 0, 0, 1)"


class Placement(object):
    def __init__(self, base=None, rotation=None):
        if base is not None and not isinstance(base, Vector):
            raise TypeError("stand-in FreeCAD: Placement takes a Vector")
        if rotation is not None and not isinstance(rotation, Rotation):
            raise TypeError("stand-in FreeCAD: Placement takes a Rotation")
        self.Base = base if base is not None else Vector()
        self.Rotation = rotation if rotation is not None else Rotation()


def _number(name, value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("stand-in FreeCAD: %s takes a number of millimetres here, not %r" % (name, value))
    return float(value)


class _Feature(object):
    """A document object: its properties limited to a declared set, as FreeCAD's are."""
    TYPE = "App::DocumentObject"
    PROPERTIES = ()

    def __init__(self, doc, name):
        object.__setattr__(self, "Document", doc)
        object.__setattr__(self, "Name", name)
        object.__setattr__(self, "TypeId", self.TYPE)
        object.__setattr__(self, "State", [])
        object.__setattr__(self, "_shape", Part.Shape())
        self.Label = name
        self.Placement = Placement()

    def __setattr__(self, key, value):
        if key not in ("Label", "Placement") + tuple(self.PROPERTIES):
            raise AttributeError("'%s' object has no attribute '%s' (stand-in FreeCAD)" % (self.TYPE, key))
        if key == "Placement" and not isinstance(value, Placement):
            raise TypeError("stand-in FreeCAD: Placement takes a Placement")
        object.__setattr__(self, key, value)

    @property
    def Shape(self):
        return self._shape.copy()

    def isValid(self):
        return "Invalid" not in self.State

    def _build(self):
        raise NotImplementedError

    def _placed(self, shape):
        b = self.Placement.Base
        return shape.moved(b.x, b.y, b.z)


class Box(_Feature):
    TYPE = "Part::Box"
    PROPERTIES = ("Length", "Width", "Height")

    def __init__(self, doc, name):
        _Feature.__init__(self, doc, name)
        self.Length, self.Width, self.Height = 10.0, 10.0, 10.0

    def _build(self):
        return self._placed(Part.makeBox(_number("Length", self.Length), _number("Width", self.Width), _number("Height", self.Height)))


class Cylinder(_Feature):
    TYPE = "Part::Cylinder"
    PROPERTIES = ("Radius", "Height", "Angle")

    def __init__(self, doc, name):
        _Feature.__init__(self, doc, name)
        self.Radius, self.Height, self.Angle = 2.0, 10.0, 360.0

    def _build(self):
        return self._placed(Part.makeCylinder(_number("Radius", self.Radius), _number("Height", self.Height), None, None, _number("Angle", self.Angle)))


class MultiFuse(_Feature):
    TYPE = "Part::MultiFuse"
    PROPERTIES = ("Shapes", "Refine")

    def __init__(self, doc, name):
        _Feature.__init__(self, doc, name)
        self.Shapes = []
        self.Refine = False

    def _build(self):
        if len(self.Shapes) < 2:
            raise ValueError("stand-in FreeCAD: a MultiFuse needs at least two shapes")
        first, rest = self.Shapes[0], self.Shapes[1:]
        return self._placed(self.Document._shape_of(first).fuse([self.Document._shape_of(o) for o in rest]))


class Cut(_Feature):
    TYPE = "Part::Cut"
    PROPERTIES = ("Base", "Tool", "Refine")

    def __init__(self, doc, name):
        _Feature.__init__(self, doc, name)
        self.Base = None
        self.Tool = None
        self.Refine = False

    def _build(self):
        if self.Base is None or self.Tool is None:
            raise ValueError("stand-in FreeCAD: a Cut needs a Base and a Tool")
        return self._placed(self.Document._shape_of(self.Base).cut(self.Document._shape_of(self.Tool)))


class Feature(_Feature):
    TYPE = "Part::Feature"
    PROPERTIES = ("Shape",)

    def __setattr__(self, key, value):
        if key == "Shape":
            object.__setattr__(self, "_shape", value.copy())
            return
        _Feature.__setattr__(self, key, value)

    def _build(self):
        return self._shape


TYPES = {c.TYPE: c for c in (Box, Cylinder, MultiFuse, Cut, Feature)}
_documents = {}
ActiveDocument = None


class Document(object):
    def __init__(self, name):
        self.Name = name
        self.Label = name
        self.FileName = ""
        self.Objects = []

    def addObject(self, type_name, name=None):
        if type_name not in TYPES:
            raise TypeError("stand-in FreeCAD: no type %s here (it models %s)" % (type_name, ", ".join(sorted(TYPES))))
        base = name or type_name.split("::")[-1]
        unique, n = base, 1
        while self.getObject(unique) is not None:
            n += 1
            unique = "%s%03d" % (base, n)
        obj = TYPES[type_name](self, unique)
        self.Objects.append(obj)
        return obj

    def getObject(self, name):
        for obj in self.Objects:
            if obj.Name == name:
                return obj
        return None

    def _shape_of(self, obj):
        if obj not in self.Objects:
            raise ValueError("stand-in FreeCAD: %s is not in this document" % getattr(obj, "Name", obj))
        if "Invalid" in obj.State:
            # as in FreeCAD, a feature built on one left in error is in error too
            raise ValueError("stand-in FreeCAD: %s is in error" % obj.Name)
        return obj._shape

    def recompute(self):
        """Builds every object's shape in creation order; a failure leaves the object in error, it does not raise."""
        failing = os.environ.get("FREECAD_STUB_FAIL")
        for obj in self.Objects:
            try:
                if obj.Name == failing:
                    raise ValueError("stand-in FreeCAD: FREECAD_STUB_FAIL")
                object.__setattr__(obj, "_shape", obj._build())
                object.__setattr__(obj, "State", [])
            except (ValueError, TypeError, NotImplementedError):
                object.__setattr__(obj, "_shape", Part.Shape())
                object.__setattr__(obj, "State", ["Invalid"])
        return len(self.Objects)

    def saveAs(self, path):
        """A FAKE .FCStd: a zip with a Document.xml listing the objects and their properties (no shapes)."""
        rows = []
        for obj in self.Objects:
            props = []
            for key in ("Label",) + tuple(obj.PROPERTIES):
                value = getattr(obj, key, None)
                if isinstance(value, list):
                    value = [getattr(v, "Name", v) for v in value]
                elif isinstance(value, _Feature):
                    value = value.Name
                elif isinstance(value, Part.Shape):
                    value = "(a shape)"
                props.append('<Property name=%s value=%s/>' % (quoteattr(key), quoteattr(repr(value))))
            b = obj.Placement.Base
            props.append('<Property name="Placement" value=%s/>' % quoteattr("(%r, %r, %r)" % (b.x, b.y, b.z)))
            rows.append('  <Object type=%s name=%s>%s</Object>' % (quoteattr(obj.TYPE), quoteattr(obj.Name), "".join(props)))
        xml = "\n".join([
            "<?xml version='1.0' encoding='utf-8'?>",
            "<!-- FAKE: written by the stand-in FreeCAD module (tests/fixtures/freecad-stub/FreeCAD.py), a TEST DOUBLE; it holds no shapes. -->",
            '<Document SchemaVersion="4" Name=%s Label=%s>' % (quoteattr(self.Name), quoteattr(self.Label)),
        ] + rows + ["</Document>", ""])
        info = zipfile.ZipInfo("Document.xml", date_time=(1980, 1, 1, 0, 0, 0))
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
            z.writestr(info, xml)
        self.FileName = os.path.abspath(path)


def newDocument(name=None):
    global ActiveDocument
    base = name or "Unnamed"
    unique, n = base, 1
    while unique in _documents:
        n += 1
        unique = "%s%d" % (base, n)
    doc = Document(unique)
    _documents[unique] = doc
    ActiveDocument = doc
    return doc


def listDocuments():
    return dict(_documents)


def getDocument(name):
    if name not in _documents:
        raise NameError("stand-in FreeCAD: no document %s" % name)
    return _documents[name]


def closeDocument(name):
    global ActiveDocument
    doc = _documents.pop(name)
    if ActiveDocument is doc:
        ActiveDocument = None
