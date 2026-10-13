#!/usr/bin/env python3
"""timmy-step-tessellate: a mesh of one STEP file for a viewer, written as an STL, and one line of JSON on stdout.

Usage: step_tessellate.py <file.step> --out <file.stl> [--as <name>] [--linear <mm>] [--angular <rad>]

Round R4 (H70, /vox view): Rerun's viewer has no STEP loader, so Timmy gives it a tessellation of the STEP. This
worker reads the file with OpenCascade's own STEP importer (OCP's STEPControl_Reader, as the STEP readback does),
meshes every face with BRepMesh_IncrementalMesh at the deflections given (absolute: millimetres and radians; not in
parallel) and writes the triangles with StlAPI_Writer (binary). The mesh approximates the STEP's surfaces within that
tolerance: it is a tessellation of the STEP, not the STEP itself, and never a measurement of a physical part. Timmy
can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of
a physical object.

The file is read once: its bytes are hashed and written to a private temporary copy, and that copy is what OpenCascade
parses, so the bytes hashed are the bytes meshed. Lengths are in millimetres: the worker sets OpenCascade's working
unit to MM (xstep.cascade.unit) and reports the unit in effect. The STL is written beside --out under a temporary name
and then linked to --out only if nothing is there: an existing file is never replaced.

Exit 0 with {"ok": true, ...}; 2 when the file cannot be read, holds no shape, cannot be meshed whole, or the STL
cannot be written; 3 when OCP is missing; 64 on a usage error; each failure with {"ok": false, "error": {...}} on
stdout.

Python 3.9 or later; OCP (CadQuery's OpenCascade bindings).
"""
import hashlib
import json
import math
import os
import platform
import struct
import sys
import tempfile

WORKER = {"name": "timmy-step-tessellate", "version": "0.1.0"}
TIER = "a tessellation of the CAD file (an approximation within the stated deflection)"
SCOPE = "a mesh approximating the STEP's surfaces within the stated tolerance; not the STEP itself and not a measurement of a physical part"
MAX_BYTES = 256 * 1024 * 1024
MESH_METHOD = "OpenCascade BRepMesh_IncrementalMesh; absolute deflection; not in parallel"
WRITER = "OpenCascade StlAPI_Writer"
USAGE = "usage: step_tessellate.py <file.step> --out <file.stl> [--as <name>] [--linear <mm>] [--angular <rad>]"


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), sort_keys=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(code, kind, message, extra=None):
    out = {"ok": False, "worker": WORKER, "python": platform.python_version(), "error": {"code": kind, "message": message}}
    if extra:
        out.update(extra)
    emit(out, code)


def positive(text, name, top):
    try:
        v = float(text)
    except ValueError:
        fail(64, "usage", "%s takes a number" % name)
    if not math.isfinite(v) or v <= 0 or v > top:
        fail(64, "usage", "%s must be more than 0 and at most %s" % (name, top))
    return v


def parse_args(argv):
    path, name, out, linear, angular = None, None, None, 0.1, 0.5
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--as", "--out", "--linear", "--angular") and i + 1 < len(argv):
            v = argv[i + 1]
            if a == "--as":
                name = v
            elif a == "--out":
                out = v
            elif a == "--linear":
                linear = positive(v, "--linear", 1000.0)
            else:
                angular = positive(v, "--angular", math.pi)
            i += 2
            continue
        if a.startswith("-"):
            fail(64, "usage", USAGE)
        if path is not None:
            fail(64, "usage", "step_tessellate.py meshes one STEP file")
        path = a
        i += 1
    if path is None or out is None:
        fail(64, "usage", USAGE)
    return path, name or os.path.basename(path), out, linear, angular


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


def stl_count(data):
    """The STL's encoding and triangle count as its bytes say: binary when its size is 84 + 50 x its count."""
    if len(data) >= 84:
        n = struct.unpack_from("<I", data, 80)[0]
        if len(data) == 84 + 50 * n:
            return "stl-binary", n
    if data[:5] == b"solid":
        return "stl-ascii", data.count(b"endfacet")
    return None, 0


def main():
    path, name, out, linear, angular = parse_args(sys.argv[1:])
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
    folder = os.path.dirname(os.path.abspath(out))
    if os.path.lexists(out):
        fail(2, "exists", "the output file is already there: it is never replaced", {"source": source})
    if not os.path.isdir(folder):
        fail(2, "no-folder", "the output file's folder does not exist", {"source": source})

    try:
        import OCP.IFSelect
        from OCP.STEPControl import STEPControl_Reader
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.StlAPI import StlAPI_Writer
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_ShapeEnum
        from OCP.TopoDS import TopoDS
        from OCP.TopLoc import TopLoc_Location
        from OCP.BRep import BRep_Tool
    except Exception as e:
        fail(3, "no-ocp", "OCP (CadQuery's OpenCascade bindings) is not importable in this Python (%s): set TIMMY_CADQUERY_PYTHON to a Python with CadQuery" % type(e).__name__, {"source": source})

    tmp = None
    try:
        handle, tmp = tempfile.mkstemp(prefix="timmy-step-tessellate-", suffix=".step")
        with os.fdopen(handle, "wb") as copy:
            copy.write(data)
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
        if reader.NbShapes() < 1:
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

    # Every face meshed, or nothing is written: a mesh missing a face would not show the STEP's surfaces.
    try:
        mesh = BRepMesh_IncrementalMesh(shape, linear, False, angular, False)
        done = bool(mesh.IsDone())
        faces, without, triangles = 0, 0, 0
        explorer = TopExp_Explorer(shape, TopAbs_ShapeEnum.TopAbs_FACE)
        while explorer.More():
            faces += 1
            poly = BRep_Tool.Triangulation_s(TopoDS.Face_s(explorer.Current()), TopLoc_Location())
            try:
                n = 0 if poly is None else int(poly.NbTriangles())
            except Exception:
                n = 0
            if n < 1:
                without += 1
            else:
                triangles += n
            explorer.Next()
    except SystemExit:
        raise
    except Exception as e:
        fail(2, "mesh-failed", "meshing the shape failed (%s: %s)" % (type(e).__name__, str(e)[:200]), {"source": source})
    if not done or faces == 0 or triangles == 0:
        fail(2, "mesh-failed", "BRepMesh made no mesh (done %s, %d faces, %d triangles)" % (done, faces, triangles), {"source": source})
    if without:
        fail(2, "mesh-incomplete", "%d of %d faces have no mesh: nothing was written" % (without, faces), {"source": source})

    # Written under a temporary name beside --out, then linked to --out only if nothing is there.
    part = os.path.join(folder, "." + os.path.basename(out) + ".part")
    try:
        writer = StlAPI_Writer()
        try:
            writer.ASCIIMode = False
        except Exception:
            pass
        if not writer.Write(shape, part):
            fail(2, "write-failed", "StlAPI_Writer did not write the STL", {"source": source})
        with open(part, "rb") as f:
            stl = f.read()
        encoding, count = stl_count(stl)
        if encoding is None or count != triangles:
            fail(2, "write-failed", "the STL written holds %d triangles (%s), not the %d meshed" % (count, encoding or "not an STL", triangles), {"source": source})
        try:
            os.link(part, out)
        except FileExistsError:
            fail(2, "exists", "the output file appeared while it was written: it is never replaced", {"source": source})
        except OSError:
            # A file system without hard links: renamed only if nothing is there now.
            if os.path.lexists(out):
                fail(2, "exists", "the output file appeared while it was written: it is never replaced", {"source": source})
            os.rename(part, out)
    except SystemExit:
        raise
    except Exception as e:
        fail(2, "write-failed", "writing the STL failed (%s: %s)" % (type(e).__name__, str(e)[:200]), {"source": source})
    finally:
        try:
            if os.path.lexists(part):
                os.unlink(part)
        except Exception:
            pass

    emit({
        "ok": True,
        "worker": WORKER,
        "python": platform.python_version(),
        "engine": versions(),
        "source": source,
        "units": "mm",
        "unit_in_effect": unit,
        "tier": TIER,
        "scope": SCOPE,
        "tessellation": {
            "method": MESH_METHOD, "linear_deflection_mm": linear, "angular_deflection_rad": angular, "relative": False, "parallel": False,
            "faces": faces, "faces_without_mesh": without, "triangles": triangles,
        },
        "output": {
            "file": os.path.basename(out), "format": encoding, "sha256": hashlib.sha256(stl).hexdigest(), "bytes": len(stl),
            "triangles": count, "writer": WRITER + (" (binary)" if encoding == "stl-binary" else " (ASCII)"),
        },
    })


if __name__ == "__main__":
    main()
