#!/usr/bin/env python3
"""timmy-step-readback: an independent readback of one STEP file, as one line of JSON on stdout.

Usage: step_readback.py <file.step> [--as <name to report>]

Round R4 (/iterate): after the CadQuery recipe delivers its STEP, this worker reads the file back in its own
process, with OpenCascade's own STEP importer (OCP's STEPControl_Reader), and none of the recipe's build code.
It reports whether the shape is valid, how many solids it holds, its bounding box and its volume, and the
sha256 of the bytes it read. Every value is a deterministic computation on the CAD file (tier "deterministic
computation"): it measures the file, never a physical part. Timmy can compute and verify dimensions of
generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.

The file is read once: its bytes are hashed and written to a private temporary copy, and that copy is what
OpenCascade parses, so the bytes hashed are the bytes measured. Lengths are in millimetres: OpenCascade's STEP
reader converts a file's own length unit to its working unit, and this worker sets that unit to MM
(xstep.cascade.unit) and reports the unit in effect.

Exit 0 with {"ok": true, ...}; 2 when the file cannot be read or holds no shape; 3 when OCP is missing;
64 on a usage error; each failure with {"ok": false, "error": {...}} on stdout.

Python 3.9 or later; OCP (CadQuery's OpenCascade bindings).
"""
import hashlib
import json
import os
import platform
import sys
import tempfile

WORKER = {"name": "timmy-step-readback", "version": "0.1.0"}
TIER = "deterministic computation"
SCOPE = "measured from the CAD file; not a measurement of a physical part"
MAX_BYTES = 256 * 1024 * 1024
BOUNDS_METHOD = "OpenCascade BRepBndLib.AddOptimal; useTriangulation=false; useShapeTolerance=false"
VOLUME_METHOD = "OpenCascade BRepGProp.VolumeProperties"


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), sort_keys=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(code, kind, message, extra=None):
    out = {"ok": False, "worker": WORKER, "python": platform.python_version(), "error": {"code": kind, "message": message}}
    if extra:
        out.update(extra)
    emit(out, code)


def parse_args(argv):
    path, name = None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--as" and i + 1 < len(argv):
            name = argv[i + 1]
            i += 2
            continue
        if a.startswith("-"):
            fail(64, "usage", "usage: step_readback.py <file.step> [--as <name>]")
        if path is not None:
            fail(64, "usage", "step_readback.py reads one STEP file")
        path = a
        i += 1
    if path is None:
        fail(64, "usage", "usage: step_readback.py <file.step> [--as <name>]")
    return path, name or os.path.basename(path)


def versions():
    """OCP's and CadQuery's versions as their packages report them; null when one does not say."""
    found = {"ocp": None, "cadquery": None}
    try:
        from importlib import metadata
        for key, dists in (("ocp", ("cadquery-ocp", "OCP", "cadquery_ocp")), ("cadquery", ("cadquery",))):
            for dist in dists:
                try:
                    found[key] = metadata.version(dist)
                    break
                except Exception:
                    continue
    except Exception:
        pass
    if found["ocp"] is None:
        try:
            import OCP
            found["ocp"] = getattr(OCP, "__version__", None)
        except Exception:
            pass
    return found


def main():
    path, name = parse_args(sys.argv[1:])
    # The file first, with Python alone: a missing or unreadable file is said as such, OCP or not.
    try:
        size = os.path.getsize(path)
        if size > MAX_BYTES:
            fail(2, "too-large", "the file is larger than %d MB" % (MAX_BYTES // (1024 * 1024)))
        with open(path, "rb") as f:
            data = f.read()
    except SystemExit:
        raise
    except Exception as e:
        fail(2, "unreadable", "the file cannot be read (%s)" % type(e).__name__)
    source = {"name": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

    try:
        import OCP.IFSelect
        from OCP.STEPControl import STEPControl_Reader
        from OCP.BRepCheck import BRepCheck_Analyzer
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib
        from OCP.GProp import GProp_GProps
        from OCP.BRepGProp import BRepGProp
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_ShapeEnum
    except Exception as e:
        fail(3, "no-ocp", "OCP (CadQuery's OpenCascade bindings) is not importable in this Python (%s): set TIMMY_CADQUERY_PYTHON to a Python with CadQuery" % type(e).__name__, {"source": source})

    tmp = None
    try:
        handle, tmp = tempfile.mkstemp(prefix="timmy-step-readback-", suffix=".step")
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        reader = STEPControl_Reader()
        unit = None
        try:
            from OCP.Interface import Interface_Static
            Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
            unit = Interface_Static.CVal_s("xstep.cascade.unit")
        except Exception:
            unit = None
        status = reader.ReadFile(tmp)
        if status != OCP.IFSelect.IFSelect_RetDone:
            fail(2, "not-step", "OpenCascade could not read the file as STEP (status %s)" % status, {"source": source})
        roots = reader.NbRootsForTransfer()
        for i in range(roots):
            reader.TransferRoot(i + 1)
        count = reader.NbShapes()
        if count < 1:
            fail(2, "no-shape", "the STEP file transferred no shape (%d roots)" % roots, {"source": source})
        shape = reader.OneShape()
    except SystemExit:
        raise
    except Exception as e:
        fail(2, "read-failed", "reading the STEP file failed (%s: %s)" % (type(e).__name__, str(e)[:200]), {"source": source})
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except Exception:
                pass

    try:
        valid = bool(BRepCheck_Analyzer(shape).IsValid())
        solids = 0
        explorer = TopExp_Explorer(shape, TopAbs_ShapeEnum.TopAbs_SOLID)
        while explorer.More():
            solids += 1
            explorer.Next()
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(shape, box, False, False)
        if box.IsVoid():
            fail(2, "empty", "the shape has no extent (an empty bounding box)", {"source": source})
        xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape, props)
        volume = props.Mass()
    except SystemExit:
        raise
    except Exception as e:
        fail(2, "measure-failed", "measuring the shape failed (%s: %s)" % (type(e).__name__, str(e)[:200]), {"source": source})

    emit({
        "ok": True,
        "worker": WORKER,
        "python": platform.python_version(),
        "engine": versions(),
        "source": source,
        "units": "mm",
        "unit_in_effect": unit,
        "read": {"roots": roots, "shapes": count, "importer": "OCP STEPControl_Reader (OneShape)"},
        "tier": TIER,
        "scope": SCOPE,
        "valid": valid,
        "solids": solids,
        "bounds": {"min": [xmin, ymin, zmin], "max": [xmax, ymax, zmax], "size": [xmax - xmin, ymax - ymin, zmax - zmin], "method": BOUNDS_METHOD},
        "volume_mm3": volume,
        "volume_method": VOLUME_METHOD,
    })


if __name__ == "__main__":
    main()
