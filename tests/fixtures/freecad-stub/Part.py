"""A STAND-IN for FreeCAD's `Part` module, for tests/native-freecad.test.ts. It is not FreeCAD and has no OpenCascade.
It models only what the FreeCAD starter (templates/freecad-starter/plate.py) and its helper
(workers/freecad/timmy_freecad.py) use, under the names FreeCAD's Python API documents: box and cylinder solids, a box
with vertical cylinders cut from it, compounds of those, and a shape's isNull, isValid, ShapeType, Solids, Volume,
BoundBox and optimalBoundingBox. Its volumes and bounding boxes come from those definitions by formula, not from a
kernel; any other shape or call raises (NotImplementedError, AttributeError), so a call the starter gets wrong fails
here. Passing against it says the starter, the helper and Timmy's judgement hold together, not that FreeCAD accepts the
calls or that a real kernel would measure the same.

Part.export writes a FAKE STEP file. It holds no geometry: only a comment with the stand-in's own measurement of the
exported compound (TIMMY-STUB-MEASURE), which the FAKE readback worker (tests/fixtures/fake-freecad-readback.mjs) copies.
Its bytes depend only on that measurement, so two runs with the same parameters write the same file.

FREECAD_STUB_NO_OPTIMAL=1 takes optimalBoundingBox away (as a FreeCAD before it had none); FREECAD_STUB_INVALID=1 makes
every shape say isValid() is False.
"""
import json
import math
import os


class BoundBox(object):
    """FreeCAD.BoundBox's corner and length names."""

    def __init__(self, lo, hi):
        self.XMin, self.YMin, self.ZMin = (float(v) for v in lo)
        self.XMax, self.YMax, self.ZMax = (float(v) for v in hi)

    @property
    def XLength(self):
        return self.XMax - self.XMin

    @property
    def YLength(self):
        return self.YMax - self.YMin

    @property
    def ZLength(self):
        return self.ZMax - self.ZMin


class _Cylinder(object):
    """A solid cylinder with its axis along +Z."""

    def __init__(self, cx, cy, z0, r, h):
        if not (r > 0 and h > 0):
            raise ValueError("stand-in Part: a cylinder needs a positive radius and height")
        self.cx, self.cy, self.z0, self.r, self.h = float(cx), float(cy), float(z0), float(r), float(h)

    def volume(self):
        return math.pi * self.r * self.r * self.h

    def bounds(self):
        return ([self.cx - self.r, self.cy - self.r, self.z0], [self.cx + self.r, self.cy + self.r, self.z0 + self.h])

    def moved(self, x, y, z):
        return _Cylinder(self.cx + x, self.cy + y, self.z0 + z, self.r, self.h)


class _Box(object):
    """An axis-aligned box, less any vertical cylinders cut through it (each inside it, none touching another)."""

    def __init__(self, lo, hi, holes=()):
        self.lo, self.hi = [float(v) for v in lo], [float(v) for v in hi]
        if not all(self.hi[i] > self.lo[i] for i in range(3)):
            raise ValueError("stand-in Part: a box needs a positive length, width and height")
        self.holes = list(holes)

    def volume(self):
        x, y, z = (self.hi[i] - self.lo[i] for i in range(3))
        removed = 0.0
        for c in self.holes:
            overlap = min(self.hi[2], c.z0 + c.h) - max(self.lo[2], c.z0)
            removed += math.pi * c.r * c.r * max(0.0, overlap)
        return x * y * z - removed

    def bounds(self):
        # the holes lie inside the outline, so they never reach the box's outer faces
        return (list(self.lo), list(self.hi))

    def moved(self, x, y, z):
        d = [x, y, z]
        return _Box([self.lo[i] + d[i] for i in range(3)], [self.hi[i] + d[i] for i in range(3)], [c.moved(x, y, z) for c in self.holes])

    def cut(self, cylinders):
        holes = list(self.holes)
        for c in cylinders:
            if not isinstance(c, _Cylinder):
                raise NotImplementedError("stand-in Part: a box is cut only by vertical cylinders")
            if not (c.cx - c.r > self.lo[0] and c.cx + c.r < self.hi[0] and c.cy - c.r > self.lo[1] and c.cy + c.r < self.hi[1]):
                raise NotImplementedError("stand-in Part: a cylinder must lie inside the box's outline")
            if c.z0 > self.lo[2] or c.z0 + c.h < self.hi[2]:
                raise NotImplementedError("stand-in Part: only cylinders through the box's whole height are modelled")
            for other in holes:
                if math.hypot(c.cx - other.cx, c.cy - other.cy) <= c.r + other.r:
                    raise NotImplementedError("stand-in Part: holes that touch are not modelled")
            holes.append(c)
        return _Box(self.lo, self.hi, holes)


class Shape(object):
    """A Part shape: one solid (ShapeType "Solid"), a compound of solids ("Compound"), or null."""

    def __init__(self, solids=()):
        self._solids = list(solids)

    def isNull(self):
        return not self._solids

    def isValid(self):
        return bool(self._solids) and os.environ.get("FREECAD_STUB_INVALID") != "1"

    @property
    def ShapeType(self):
        if not self._solids:
            raise ValueError("stand-in Part: a null shape has no type")
        return "Solid" if len(self._solids) == 1 else "Compound"

    @property
    def Solids(self):
        return [Shape([s]) for s in self._solids]

    @property
    def Volume(self):
        return sum(s.volume() for s in self._solids)

    def _box(self):
        if not self._solids:
            raise ValueError("stand-in Part: a null shape has no bounding box")
        corners = [s.bounds() for s in self._solids]
        return BoundBox([min(c[0][i] for c in corners) for i in range(3)], [max(c[1][i] for c in corners) for i in range(3)])

    @property
    def BoundBox(self):
        return self._box()

    def __getattr__(self, name):
        if name == "optimalBoundingBox" and os.environ.get("FREECAD_STUB_NO_OPTIMAL") != "1":
            return lambda useTriangulation=True, useShapeTolerance=False: self._box()
        raise AttributeError("'Shape' object has no attribute '%s' (stand-in Part)" % name)

    def copy(self):
        return Shape(self._solids)

    def moved(self, x, y, z):
        return Shape([s.moved(x, y, z) for s in self._solids])

    def cut(self, tool):
        if len(self._solids) != 1 or not isinstance(self._solids[0], _Box):
            raise NotImplementedError("stand-in Part: only a single box is cut")
        if tool.isNull():
            raise ValueError("stand-in Part: a cut needs a tool shape")
        return Shape([self._solids[0].cut(tool._solids)])

    def fuse(self, others):
        if not isinstance(others, (list, tuple)):
            others = [others]
        solids = list(self._solids)
        for o in others:
            for s in o._solids:
                if not isinstance(s, _Cylinder) or any(not isinstance(t, _Cylinder) or math.hypot(s.cx - t.cx, s.cy - t.cy) <= s.r + t.r for t in solids):
                    raise NotImplementedError("stand-in Part: only cylinders that do not touch are fused")
                solids.append(s)
        return Shape(solids)


def makeBox(length, width, height, pnt=None, dir=None):
    if dir is not None:
        raise NotImplementedError("stand-in Part: makeBox takes no direction here")
    x, y, z = (pnt.x, pnt.y, pnt.z) if pnt is not None else (0.0, 0.0, 0.0)
    return Shape([_Box([x, y, z], [x + length, y + width, z + height])])


def makeCylinder(radius, height, pnt=None, dir=None, angle=360):
    if angle != 360:
        raise NotImplementedError("stand-in Part: only whole cylinders")
    if dir is not None and (abs(dir.x) > 1e-12 or abs(dir.y) > 1e-12 or dir.z <= 0):
        raise NotImplementedError("stand-in Part: only cylinders along +Z")
    x, y, z = (pnt.x, pnt.y, pnt.z) if pnt is not None else (0.0, 0.0, 0.0)
    return Shape([_Cylinder(x, y, z, radius, height)])


def makeCompound(shapes):
    solids = []
    for s in shapes:
        solids.extend(s._solids)
    return Shape(solids)


def _measure(shape):
    box = shape.BoundBox
    return {
        "valid": shape.isValid(), "solids": len(shape.Solids), "volume_mm3": shape.Volume,
        "bounds": {"min": [box.XMin, box.YMin, box.ZMin], "max": [box.XMax, box.YMax, box.ZMax]},
    }


def export(objects, path):
    """Part.export(objects, path): a FAKE STEP file of the objects' shapes as one compound (it holds no geometry)."""
    lower = str(path).lower()
    if not (lower.endswith(".step") or lower.endswith(".stp")):
        raise NotImplementedError("stand-in Part: export writes only STEP here")
    shapes = []
    for obj in objects:
        shape = getattr(obj, "Shape", None)
        if shape is None or shape.isNull():
            raise ValueError("stand-in Part: %s has no shape" % getattr(obj, "Name", obj))
        shapes.append(shape)
    measure = json.dumps(_measure(makeCompound(shapes)), sort_keys=True)
    with open(path, "w") as f:
        f.write("ISO-10303-21;\nHEADER;\n")
        f.write("/* FAKE STEP written by the stand-in Part module (tests/fixtures/freecad-stub/Part.py), a TEST DOUBLE: it holds no geometry. */\n")
        f.write("ENDSEC;\nDATA;\n/* TIMMY-STUB-MEASURE %s */\nENDSEC;\nEND-ISO-10303-21;\n" % measure)
