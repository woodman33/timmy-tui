"""Timmy's FreeCAD starter: a parametric plate with four through holes, built from Part workbench features (a
Part::Box, four Part::Cylinder holes fused by a Part::MultiFuse and cut from the box by a Part::Cut), saved as an
editable FreeCAD document and exported as STEP. Run headless with FreeCAD's command-line program:

    freecadcmd plate.py
    (macOS: /Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd plate.py)

NOT YET RUN on a real FreeCAD: Timmy's tests run it with Python 3 against stand-in FreeCAD and Part modules
(tests/native-freecad.test.ts), which say the script, its helper and Timmy's judgement agree with each other and
with the names the stand-ins define from FreeCAD's documented API, not that FreeCAD accepts the calls.

Parameters, in millimetres (FreeCAD's internal length unit), each changed with --name value:
    length 100, width 60, thickness 6     the plate, from (0, 0, 0) to (length, width, thickness)
    hole_diameter 6.5                     each of the four through holes
    inset 8                               each hole's centre from the two nearest edges
A Timmy job passes them in TIMMY_SCRIPT_ARGS (/freecad plate.py --length 120 --hole_diameter 5); freecadcmd itself
takes more words on its command line as more files to open, so run by hand the plate keeps its defaults.

What it writes (under TIMMY_OUT, default ./out):
  plate.FCStd        the editable document: open it in FreeCAD and change Blank's Length, a hole's Radius, ...
  plate.step         the plate alone (the Plate feature's shape), through Part.export
  timmy-result.json  the result file, when run by hand; a Timmy job sets TIMMY_RESULT to the run's own file,
                     .timmy/native/<run>/result.json

Its own checks compare FreeCAD's measurement of the plate with the plate's analytic size and volume
(length x width x thickness, less four cylinders of the hole's diameter through the thickness), within the CadQuery
recipe's gates: each bounding-box coordinate within 1e-6 mm, the volume within 1e-8 of itself (at least 1e-5 mm3).
Those numbers are FreeCAD's claims about generated CAD. Timmy can compute and verify dimensions of generated CAD.
Converting that CAD cannot establish the dimensions or density of a physical object.

freecadcmd imports a .py file as a module named after it, so this file does its work at the top level, with
timmy_freecad.run_script(main) below, and never under `if __name__ == "__main__":`. A Timmy job runs a read-only copy
of this file kept in the run's folder (.timmy/native/<run>/source/), named timmy_<run8>_plate.py; TIMMY_SCRIPT_DIR is
the folder it was submitted from, for files beside it.
"""
import json
import math
import os
import sys

# timmy_freecad.py: in TIMMY_FREECAD_LIB (Timmy's FreeCAD job sets it to its workers/freecad), or next to this script
# (TIMMY_SCRIPT_DIR when a Timmy job runs its copy). FreeCAD's Python may ignore PYTHONPATH, so the folders are added here.
try:
    _here = os.path.dirname(os.path.abspath(__file__))
except NameError:  # a host that runs the file without __file__
    _here = os.getcwd()
if os.environ.get("TIMMY_FREECAD_LIB") and os.environ["TIMMY_FREECAD_LIB"] not in sys.path:
    sys.path.insert(0, os.environ["TIMMY_FREECAD_LIB"])
for _folder in (os.environ.get("TIMMY_SCRIPT_DIR"), _here):
    if _folder and _folder not in sys.path:
        sys.path.append(_folder)

DEFAULTS = {"length": 100.0, "width": 60.0, "thickness": 6.0, "hole_diameter": 6.5, "inset": 8.0}
# Each hole's cylinder reaches this far past both faces, so the cut leaves no face lying on another.
OVERSHOOT = 1.0
# At least this much material between a hole and an edge, and between two holes.
WEB = 1.0
# The CadQuery recipe's gates (lanes/recipes/enclosure-tray/build.py), which OpenCascade's measurements met on the
# operator's Mac; FreeCAD measures with OpenCascade too. Not loosened.
BOUND_TOLERANCE = 1e-6
VOLUME_RELATIVE_TOLERANCE = 1e-8
VOLUME_FLOOR = 1e-5


def parameters(args):
    """The defaults with each --name value (or --name=value) from the arguments over them; every value a positive
    number of millimetres, with the holes inside the plate and apart from each other."""
    p = dict(DEFAULTS)
    i = 0
    while i < len(args):
        word = args[i]
        if not word.startswith("--"):
            raise ValueError("expected --name value, not %r" % word)
        key, eq, value = word[2:].partition("=")
        key = key.replace("-", "_")
        if not eq:
            if i + 1 >= len(args):
                raise ValueError("--%s needs a value" % key)
            value = args[i + 1]
            i += 1
        if key not in p:
            raise ValueError("no parameter %s: the plate takes %s" % (key, ", ".join(sorted(p))))
        try:
            p[key] = float(value)
        except ValueError:
            raise ValueError("--%s is not a number: %r" % (key, value))
        i += 1
    for key, value in p.items():
        if not (math.isfinite(value) and value > 0):
            raise ValueError("%s must be a positive number of millimetres, not %r" % (key, value))
    r = p["hole_diameter"] / 2.0
    if p["inset"] - r < WEB:
        raise ValueError("inset %g leaves less than %g mm between a hole of diameter %g and the edge" % (p["inset"], WEB, p["hole_diameter"]))
    for side in ("length", "width"):
        if p[side] - 2 * p["inset"] - 2 * r < WEB:
            raise ValueError("%s %g is too short for two holes of diameter %g inset %g with %g mm between them" % (side, p[side], p["hole_diameter"], p["inset"], WEB))
    return p


def hole_centres(p):
    """The four holes' centres, each `inset` from the two nearest edges."""
    a, b = p["inset"], p["length"] - p["inset"]
    c, d = p["inset"], p["width"] - p["inset"]
    return [(a, c), (b, c), (b, d), (a, d)]


def analytic(p):
    """The plate as defined: its bounding box and its volume (the box less four cylinders through the thickness)."""
    r = p["hole_diameter"] / 2.0
    return {
        "bounds": {"min": [0.0, 0.0, 0.0], "max": [p["length"], p["width"], p["thickness"]]},
        "volume_mm3": p["length"] * p["width"] * p["thickness"] - 4 * math.pi * r * r * p["thickness"],
    }


def checks(measured, expected):
    """FreeCAD's measurement of the plate against its analytic definition, each check with its numbers."""
    bounds = measured.get("bounds") or {}
    corners = [(w, i) for w in ("min", "max") for i in range(3)]
    have = all(isinstance((bounds.get(w) or [None] * 3)[i], float) for w, i in corners)
    worst = max(abs(bounds[w][i] - expected["bounds"][w][i]) for w, i in corners) if have else None
    volume = measured.get("volume_mm3")
    allowed = max(VOLUME_FLOOR, expected["volume_mm3"] * VOLUME_RELATIVE_TOLERANCE)
    return [
        {"label": "plate bounds", "passed": worst is not None and worst <= BOUND_TOLERANCE,
         "detail": {"expected": expected["bounds"], "measured": {"min": bounds.get("min"), "max": bounds.get("max")}, "largest_difference_mm": worst, "tolerance_mm": BOUND_TOLERANCE}},
        {"label": "plate analytic volume", "passed": isinstance(volume, float) and abs(volume - expected["volume_mm3"]) <= allowed,
         "detail": {"expected_mm3": expected["volume_mm3"], "measured_mm3": volume, "tolerance_mm3": allowed}},
        {"label": "plate is one valid solid", "passed": measured.get("valid") is True and measured.get("solids") == 1,
         "detail": {"valid": measured.get("valid"), "solids": measured.get("solids")}},
    ]


def main(run):
    import FreeCAD as App
    import Part  # noqa: F401 (loads the Part workbench, whose Part:: features are added below)

    args = timmy_freecad.script_args()
    p = parameters(args)
    doc = run.new_document("Plate")

    blank = doc.addObject("Part::Box", "Blank")
    blank.Length = p["length"]
    blank.Width = p["width"]
    blank.Height = p["thickness"]

    r = p["hole_diameter"] / 2.0
    holes = []
    for n, (x, y) in enumerate(hole_centres(p), start=1):
        hole = doc.addObject("Part::Cylinder", "Hole%d" % n)
        hole.Radius = r
        hole.Height = p["thickness"] + 2 * OVERSHOOT
        hole.Placement = App.Placement(App.Vector(x, y, -OVERSHOOT), App.Rotation())
        holes.append(hole)
    fused = doc.addObject("Part::MultiFuse", "Holes")
    fused.Shapes = holes

    plate = doc.addObject("Part::Cut", "Plate")
    plate.Base = blank
    plate.Tool = fused
    run.recompute(doc)

    # The editable document first: it is worth keeping even when a check below fails.
    run.save_document(doc, run.out_path("plate.FCStd"))
    run.export_step([plate], run.out_path("plate.step"))

    expected = analytic(p)
    found = checks(timmy_freecad.measure_shape(plate.Shape), expected)
    extra = {"parameters": p, "args": args, "analytic": expected, "checks": found}
    failed = [c["label"] for c in found if not c["passed"]]
    if failed:
        raise timmy_freecad.Failed("%d of %d checks failed: %s" % (len(failed), len(found), ", ".join(failed)), extra=extra)
    return extra


def _no_helper(missing):
    """Without the helper the run still leaves a result that says what went wrong (never just an exit status)."""
    root = os.environ.get("TIMMY_ROOT") or os.getcwd()
    result = os.environ.get("TIMMY_RESULT") or os.path.join(os.environ.get("TIMMY_OUT") or os.path.join(root, "out"), "timmy-result.json")
    try:
        if not os.path.isdir(os.path.dirname(result)):
            os.makedirs(os.path.dirname(result))
        with open(result, "w") as f:
            json.dump({"ok": False, "run": os.environ.get("TIMMY_RUN"), "script_sha256": os.environ.get("TIMMY_SCRIPT_SHA256"), "files": {},
                       "error": "ImportError: timmy_freecad.py was not found (%s): set TIMMY_FREECAD_LIB to Timmy's workers/freecad, or copy it next to plate.py" % missing}, f)
    except Exception as e:  # noqa: BLE001 (nothing may leave the import: freecadcmd would run this file again)
        sys.stderr.write("plate.py: no helper, and the result could not be written either (%s)\n" % e)


try:
    import timmy_freecad  # noqa: E402
except ImportError as _missing:
    timmy_freecad = None
    _no_helper(_missing)

# At the top level, not under `if __name__ == "__main__":`: freecadcmd imports this file as a module.
if timmy_freecad is not None:
    timmy_freecad.run_script(main)
