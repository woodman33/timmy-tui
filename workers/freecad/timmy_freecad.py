"""timmy_freecad: the result file a FreeCAD script writes when Timmy runs it with freecadcmd.

NOT YET EXERCISED on a real FreeCAD: written against FreeCAD's documented Python API (FreeCAD.newDocument,
Document.recompute and saveAs, the Part shapes' isValid, Volume, BoundBox and optimalBoundingBox, Part.export,
FreeCAD.Version) and checked here only with Python 3 against stand-in FreeCAD and Part modules
(tests/native-freecad.test.ts, tests/fixtures/freecad-stub). The first real run is the operator's, on the Mac.

How freecadcmd runs a script (FreeCAD's command-line file handling, App::Application::processFiles, as its source
reads; not observed here): a .py file given to it has its folder appended to sys.path and is IMPORTED as a module
named after the file; only when that import raises is the file run again, in __main__. freecadcmd then exits 0,
whatever the script did. So:
  - call run_script(main) at the top level of the script, not under `if __name__ == "__main__":` (an import does not
    run that block);
  - run_script never lets an exception out of main (the import would fail and FreeCAD would run the whole file a
    second time), and runs main once per process: a second call is refused and leaves the first result as it is;
  - more words on freecadcmd's command line would be taken as more files to open, so Timmy passes the script's own
    arguments in TIMMY_SCRIPT_ARGS, a JSON list of strings: script_args() reads them.

Timmy's FreeCAD job (src/native/freecad.ts: freecadJob) runs, headless:
    freecadcmd <root>/.timmy/native/<run>/source/timmy_<run8>_<stem>.py
a read-only copy of the script kept at submission, under a module name no other file on FreeCAD's path has, and sets:
  TIMMY_RESULT         where to write the result file: the run's own, <root>/.timmy/native/<run>/result.json
                       (without it, <root>/out/timmy-result.json, as a run by hand writes)
  TIMMY_RUN            this run's token, written back so a result from an earlier run is never taken for this one
  TIMMY_SCRIPT_SHA256  the script's sha256 when the job was submitted, written back as script_sha256
  TIMMY_SCRIPT         the copy freecadcmd runs; its sha256 as this run reads it goes in as script_sha256_read
  TIMMY_SCRIPT_ORIGINAL, TIMMY_SCRIPT_DIR   the script and folder it was submitted from (for files beside it)
  TIMMY_ROOT           the project folder; file names in the result are relative to it
  TIMMY_OUT            the folder for outputs (default <root>/out). Timmy inventories it before the run: a file named
                       in the result counts as this run's only if the run created it or changed its bytes
  TIMMY_SCRIPT_ARGS    the script's own arguments, a JSON list of strings
  TIMMY_FREECAD_LIB    the folder holding this file (workers/freecad): the script puts it on sys.path itself

The result file is what Timmy judges a run by, not freecadcmd's exit status:
  {
    "ok": true | false,
    "run": "<TIMMY_RUN>",
    "script_sha256": "<TIMMY_SCRIPT_SHA256>",
    "script_sha256_read": "<sha256 of TIMMY_SCRIPT as read>",   (when TIMMY_SCRIPT names a file)
    "script_is_copy": true,               (the code that ran, main's own file, is TIMMY_SCRIPT; when TIMMY_SCRIPT is set)
    "script_ran": ".timmy/native/<run>/source/timmy_<run8>_plate.py",
    "freecad_version": "1.0.0", "freecad_build": "...",           (FreeCAD.Version(); null outside FreeCAD)
    "units": "mm",
    "documents": [{"name": "Plate", "label": "Plate", "file": "out/plate.FCStd", "objects": 7}],
    "objects": [{"document": "Plate", "name": "Plate", "label": "Plate", "type": "Part::Cut", "state": [],
                 "shape": {"type": "Solid", "valid": true, "solids": 1, "volume_mm3": 33215.8,
                           "bounds": {"min": [0, 0, 0], "max": [100, 60, 6], "size": [100, 60, 6], "method": "..."}}}],
    "exports": [{"path": "out/plate.step", "format": "STEP", "objects": ["Plate"], "shape": {...}}],
    "files": {"out/plate.FCStd": "<sha256>", "out/plate.step": "<sha256>"},
    "measured_by": "FreeCAD's own report of its own document, in the process that built it",
    "timing": {"started": "...Z", "ended": "...Z", "seconds": 1.23},
    "error": "<type: message>", "traceback": "..."     (when ok is false; the project folder written as ".", home as "~")
    ...                                                 (whatever the script's main returns, as extra fields)
  }
Every shape number is FreeCAD's own measurement of its own document (its internal length unit is the millimetre):
a claim about generated CAD, made in the process that built it. Timmy computes each file's sha256 itself after the
run, and can read an exported STEP back in a separate process (/freecad readback). Timmy can compute and verify
dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.

Use:
    import timmy_freecad
    def main(run):
        import FreeCAD, Part
        doc = run.new_document("Plate")
        ...add Part features...
        run.recompute(doc)                                       # raises when a feature is left in error
        run.save_document(doc, run.out_path("plate.FCStd"))       # Document.saveAs; its sha256 recorded
        run.export_step([doc.getObject("Plate")], run.out_path("plate.step"))   # Part.export; recorded, measured
        return {"parameters": {...}}                              # extra fields for the result
    timmy_freecad.run_script(main)                                # at the top level
"""
import datetime
import hashlib
import json
import math
import os
import sys
import traceback

__all__ = ["Run", "Failed", "run_script", "freecad_version", "script_args", "measure_shape", "REPORTED_BY"]

REPORTED_BY = "FreeCAD's own report of its own document, in the process that built it"
MAX_OBJECTS = 500
MAX_DOCUMENTS = 20
# The runs this process has started: freecadcmd runs a file again, in __main__, when importing it raised.
_STARTED = []


class Failed(Exception):
    """Raise from main to end the run ok: false and still put fields in the result (the checks that failed, say)."""

    def __init__(self, message, extra=None):
        Exception.__init__(self, message)
        self.extra = dict(extra) if isinstance(extra, dict) else {}


def _iso(t):
    return datetime.datetime.fromtimestamp(t, tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def freecad_version():
    """FreeCAD.Version() as (version, build): ('1.0.0', '39109 (Git)'); (None, None) outside FreeCAD."""
    try:
        import FreeCAD  # noqa: F401 (only present inside FreeCAD)
        parts = [str(p) for p in FreeCAD.Version()]
    except Exception:
        return None, None
    version = ".".join(parts[:3]) if len(parts) >= 3 else (".".join(parts) or None)
    build = parts[3] if len(parts) > 3 and parts[3] else None
    return version, build


def script_args(environ=None):
    """The script's own arguments: TIMMY_SCRIPT_ARGS, a JSON list of strings ([] when it is not set).

    freecadcmd takes further words on its command line as more files to open, so Timmy passes them here."""
    raw = (os.environ if environ is None else environ).get("TIMMY_SCRIPT_ARGS")
    if not raw:
        return []
    value = json.loads(raw)
    if not isinstance(value, list) or not all(isinstance(a, str) for a in value):
        raise ValueError("TIMMY_SCRIPT_ARGS is not a JSON list of strings")
    return list(value)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _num(value):
    """A finite float, or None (NaN and infinity are not JSON Timmy reads)."""
    try:
        x = float(value)
    except Exception:
        return None
    return x if math.isfinite(x) else None


def _clean(value, seen):
    """The value with every NaN or infinity replaced by None (JSON has no such numbers); `seen` counts them."""
    if isinstance(value, float) and not math.isfinite(value):
        seen.append(1)
        return None
    if isinstance(value, dict):
        return {str(k): _clean(v, seen) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v, seen) for v in value]
    return value


def _bounds(shape):
    """The shape's bounding box in mm, and how FreeCAD computed it."""
    box, method = None, None
    try:
        box = shape.optimalBoundingBox(False, False)
        method = "FreeCAD Shape.optimalBoundingBox(useTriangulation=False, useShapeTolerance=False)"
    except Exception:
        box, method = shape.BoundBox, "FreeCAD Shape.BoundBox"
    lo = [_num(box.XMin), _num(box.YMin), _num(box.ZMin)]
    hi = [_num(box.XMax), _num(box.YMax), _num(box.ZMax)]
    if any(v is None for v in lo + hi):
        return None
    return {"min": lo, "max": hi, "size": [hi[i] - lo[i] for i in range(3)], "method": method}


def measure_shape(shape):
    """FreeCAD's own measurement of a Part shape: its type, validity, solids, volume (mm3) and bounding box (mm).

    None for no shape; {"null": true} for a null one. A property FreeCAD cannot give is None, never guessed."""
    if shape is None:
        return None
    try:
        if shape.isNull():
            return {"null": True}
    except Exception:
        pass
    out = {"type": None, "valid": None, "solids": None, "volume_mm3": None, "bounds": None}
    try:
        out["type"] = str(shape.ShapeType)
    except Exception:
        pass
    try:
        out["valid"] = bool(shape.isValid())
    except Exception:
        pass
    try:
        out["solids"] = len(shape.Solids)
    except Exception:
        pass
    try:
        out["volume_mm3"] = _num(shape.Volume)
    except Exception:
        pass
    try:
        out["bounds"] = _bounds(shape)
    except Exception:
        pass
    return out


def _shape_of(obj):
    """An object's Part shape, or None (an object without one, or not a Part shape)."""
    shape = getattr(obj, "Shape", None)
    if shape is None or not hasattr(shape, "isNull"):
        return None
    return shape


def _caller_file(main):
    code = getattr(main, "__code__", None)
    return getattr(code, "co_filename", None)


class Run(object):
    """One script run: where to write, the documents and files it made, and its result file."""

    def __init__(self, root=None, result=None, out=None, script_file=None):
        import time
        self.started = time.time()
        self.root = os.path.abspath(root or os.environ.get("TIMMY_ROOT") or os.getcwd())
        self.out = os.path.abspath(out or os.environ.get("TIMMY_OUT") or os.path.join(self.root, "out"))
        self.result_path = os.path.abspath(result or os.environ.get("TIMMY_RESULT") or os.path.join(self.out, "timmy-result.json"))
        self.run = os.environ.get("TIMMY_RUN")
        self.script_sha256 = os.environ.get("TIMMY_SCRIPT_SHA256")
        script = os.environ.get("TIMMY_SCRIPT")
        self.script = script if script and os.path.isfile(script) else None
        self.script_sha256_read = _sha256(self.script) if self.script else None
        self.script_file = script_file
        self.files = {}
        self.exports = []
        self.saved = {}
        self.notes = []

    def out_path(self, *parts):
        """A path in the out folder, its folder made."""
        path = os.path.join(self.out, *parts)
        folder = os.path.dirname(path)
        if not os.path.isdir(folder):
            os.makedirs(folder)
        return path

    def name(self, path):
        """The path as the result names it: relative to the project folder when inside it; else "(outside the project) <name>"."""
        path = os.path.abspath(path)
        for root in sorted({self.root, os.path.realpath(self.root)}, key=len, reverse=True):
            rel = os.path.relpath(path, root)
            if not (rel == os.pardir or rel.startswith(os.pardir + os.sep) or os.path.isabs(rel)):
                return rel.replace(os.sep, "/")
        return "(outside the project) %s" % os.path.basename(path)

    def add_file(self, path):
        """Record a file this run made, by its sha256. A missing file raises: the run did not make it."""
        if not os.path.isfile(path):
            raise IOError("%s was not written" % self.name(path))
        self.files[self.name(path)] = _sha256(path)
        return path

    def new_document(self, name):
        """FreeCAD.newDocument(name): a new document; its objects are reported in the result."""
        import FreeCAD
        return FreeCAD.newDocument(name)

    def recompute(self, doc):
        """doc.recompute(), then raise naming every object left in error: FreeCAD marks a failed feature, it does not raise."""
        doc.recompute()
        bad = []
        for obj in list(doc.Objects):
            state = [str(s) for s in (getattr(obj, "State", None) or [])]
            invalid = "Invalid" in state
            try:
                if hasattr(obj, "isValid") and not obj.isValid():
                    invalid = True
            except Exception:
                pass
            if invalid:
                bad.append("%s (%s)" % (obj.Name, ", ".join(state) or "not valid"))
        if bad:
            raise RuntimeError("recompute left %d object%s in error: %s" % (len(bad), "" if len(bad) == 1 else "s", "; ".join(bad)))
        return doc

    def save_document(self, doc, path):
        """doc.saveAs(path): the editable .FCStd, recorded by its sha256."""
        path = os.path.abspath(path)
        if not path.lower().endswith(".fcstd"):
            raise ValueError("a FreeCAD document is saved as .FCStd, not %s" % os.path.basename(path))
        doc.saveAs(path)
        self.saved[doc.Name] = self.name(path)
        return self.add_file(path)

    def export_step(self, objects, path):
        """Part.export(objects, path): the objects' shapes in one STEP file, recorded by its sha256, with FreeCAD's own
        measurement of exactly those shapes (one compound of them, as Part.export writes them)."""
        import Part
        if not isinstance(objects, (list, tuple)):
            objects = [objects]
        objects = list(objects)
        if not objects:
            raise ValueError("export_step needs at least one object")
        path = os.path.abspath(path)
        if not (path.lower().endswith(".step") or path.lower().endswith(".stp")):
            raise ValueError("a STEP file ends in .step or .stp, not %s" % os.path.basename(path))
        shapes = []
        for obj in objects:
            shape = _shape_of(obj)
            if shape is None or shape.isNull():
                raise ValueError("%s has no shape to export" % getattr(obj, "Name", obj))
            shapes.append(shape)
        Part.export(objects, path)
        self.add_file(path)
        self.exports.append({
            "path": self.name(path), "format": "STEP", "objects": [str(getattr(o, "Name", o)) for o in objects],
            "shape": measure_shape(Part.makeCompound(shapes)), "measured_by": REPORTED_BY,
        })
        return path

    def note(self, text):
        """A sentence for the result's notes (what was not established, a fallback taken)."""
        self.notes.append(self.scrub(str(text)))

    def scrub(self, text):
        """Free text with the project folder written as "." and the home folder as "~"."""
        out = text
        for folder in sorted({self.root, os.path.realpath(self.root)}, key=len, reverse=True):
            if len(folder) > 1:
                out = out.replace(folder, ".")
        home = os.path.expanduser("~")
        if len(home) > 1:
            out = out.replace(home, "~")
        return out

    def _report(self):
        """FreeCAD's report of every open document: each object's name, type, state and shape (its own measurement)."""
        try:
            import FreeCAD
            docs = list(FreeCAD.listDocuments().values())
        except Exception:
            return [], [], 0
        documents, objects, total = [], [], 0
        for doc in docs[:MAX_DOCUMENTS]:
            members = list(getattr(doc, "Objects", []) or [])
            total += len(members)
            entry = {"name": str(doc.Name), "label": str(getattr(doc, "Label", doc.Name)), "objects": len(members)}
            saved = self.saved.get(doc.Name)
            if saved:
                entry["file"] = saved
            elif getattr(doc, "FileName", ""):
                entry["file"] = self.name(doc.FileName)
            documents.append(entry)
            for obj in members:
                if len(objects) >= MAX_OBJECTS:
                    break
                item = {"document": str(doc.Name), "name": str(obj.Name), "label": str(getattr(obj, "Label", obj.Name)),
                        "type": str(getattr(obj, "TypeId", "") or "") or None,
                        "state": [str(s) for s in (getattr(obj, "State", None) or [])]}
                try:
                    shape = _shape_of(obj)
                except Exception:
                    shape = None
                if shape is not None:
                    item["shape"] = measure_shape(shape)
                objects.append(item)
        return documents, objects, total

    def write(self, ok, error=None, extra=None):
        """Write the result file: to a temporary name, then renamed over the result, so it is never half there."""
        import time
        ended = time.time()
        body = {}
        if isinstance(extra, dict):
            body.update(extra)
        version, build = freecad_version()
        try:
            documents, objects, total = self._report()
        except Exception as e:  # noqa: BLE001 (the result is still written, with what went wrong)
            documents, objects, total = [], [], 0
            self.note("the documents could not be listed: %s: %s" % (type(e).__name__, e))
        body.update({
            "ok": bool(ok),
            "run": self.run,
            "script_sha256": self.script_sha256,
            "files": dict(self.files),
            "freecad_version": version,
            "freecad_build": build,
            "units": "mm",
            "documents": documents,
            "objects": objects,
            "exports": list(self.exports),
            "measured_by": REPORTED_BY,
            "timing": {"started": _iso(self.started), "ended": _iso(ended), "seconds": round(ended - self.started, 3)},
        })
        if total > len(objects):
            body["objects_total"] = total
        if self.script_sha256_read is not None:
            body["script_sha256_read"] = self.script_sha256_read
        if self.script is not None and self.script_file:
            body["script_is_copy"] = os.path.realpath(self.script_file) == os.path.realpath(self.script)
            body["script_ran"] = self.name(self.script_file)
        if self.notes:
            body["notes"] = list(self.notes)
        if error is not None:
            body["error"] = self.scrub(str(error))
        seen = []
        body = _clean(body, seen)
        if seen:
            body.setdefault("notes", []).append("%d number%s that JSON cannot hold (NaN or infinity) written as null" % (len(seen), "" if len(seen) == 1 else "s"))
        folder = os.path.dirname(self.result_path)
        if not os.path.isdir(folder):
            os.makedirs(folder)
        temp = "%s.%d.tmp" % (self.result_path, os.getpid())
        with open(temp, "w") as f:
            json.dump(body, f, indent=2, sort_keys=True, allow_nan=False, default=str)
            f.write("\n")
        os.replace(temp, self.result_path)
        return body


def run_script(main, root=None, result=None):
    """Run main(run) and write the result file: ok when main returns, ok: false with the error when it raises.

    Call it at the top level of the script. It never lets an exception out of main: under freecadcmd the script is
    imported as a module, and an import that raises makes FreeCAD run the whole file again. It runs main once per
    process: a second call (that re-run) is refused, says so on stderr, and leaves the first result as it is. It does
    not exit the process: the result file, not freecadcmd's exit status, is the run's outcome. Returns the result written."""
    if _STARTED:
        sys.stderr.write("timmy_freecad: run_script was called again in this process (FreeCAD runs a script again when importing it raised); main was not run again, and the first result stands\n")
        return None
    _STARTED.append(os.environ.get("TIMMY_RUN"))
    try:
        run = Run(root=root, result=result, script_file=_caller_file(main))
    except Exception as e:  # noqa: BLE001 (nothing may leave the import: freecadcmd would run the file again)
        sys.stderr.write("timmy_freecad: the run could not start, no result was written (%s: %s)\n" % (type(e).__name__, e))
        return None
    try:
        extra = main(run)
        ok, error, more = True, None, (extra if isinstance(extra, dict) else None)
    except Failed as e:
        ok, error, more = False, "Failed: %s" % e, e.extra
    except Exception as e:  # noqa: BLE001 (every failure is written down, never lost)
        ok, error, more = False, "%s: %s" % (type(e).__name__, e), {"traceback": run.scrub(traceback.format_exc())[-4000:]}
    except SystemExit as e:
        ok, error, more = False, "SystemExit: the script called sys.exit(%r) inside main" % (e.code,), None
    try:
        return run.write(ok, error=error, extra=more)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("timmy_freecad: the result file could not be written (%s: %s)\n" % (type(e).__name__, run.scrub(str(e))))
        return None
