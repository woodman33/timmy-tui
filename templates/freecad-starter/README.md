# FreeCAD starter

A parametric plate with four through holes, built by `plate.py` with FreeCAD's Part workbench features: a
`Part::Box` named `Blank`, four `Part::Cylinder` holes (`Hole1` to `Hole4`) fused by a `Part::MultiFuse` named
`Holes`, and a `Part::Cut` named `Plate` that cuts them from the box. It runs headless in FreeCAD's command-line
program, `freecadcmd`, saves the editable document as `out/plate.FCStd` (the feature tree: open it in FreeCAD and
change `Blank`'s Length or a hole's Radius) and exports the plate alone as `out/plate.step`.

The run's outcome is its result file, written by `workers/freecad/timmy_freecad.py`: `ok`, the run's token, the
script's sha256 (as submitted and as read), whether the code that ran came from the copy Timmy kept, the FreeCAD
version, every object in the document (name, type, state, and for a shape its validity, solids, volume and bounding
box in millimetres), what each STEP export holds, and the sha256 of each file it wrote. Timmy judges the run by that
file, not by `freecadcmd`'s exit status, and computes each file's sha256 again itself after the run.

**Status: implemented; not run with FreeCAD.** Timmy's tests run `plate.py` and its helper with Python 3 against
stand-in `FreeCAD` and `Part` modules and a fake `freecadcmd` (`tests/native-freecad.test.ts`,
`tests/fixtures/freecad-stub/`, `tests/fixtures/fake-freecadcmd.mjs`, each a labelled test double). That says the
script, the helper and Timmy's judgement agree with each other and with the names the stand-ins define from FreeCAD's
documented API, not that FreeCAD accepts the calls. The first real run is the operator's.

## Parameters

Millimetres (FreeCAD's internal length unit). Each is changed with `--name value`:

| Parameter | Default | What |
|---|---|---|
| `length` | 100 | the plate along X, from 0 |
| `width` | 60 | the plate along Y, from 0 |
| `thickness` | 6 | the plate along Z, from 0 |
| `hole_diameter` | 6.5 | each of the four through holes |
| `inset` | 8 | each hole's centre from the two nearest edges |

Values must be positive, leave at least 1 mm between each hole and the edges, and at least 1 mm between holes; a
value outside that ends the run `ok: false` with the reason, before anything is built.

## Run it

From the workspace: `/freecad plate.py`, or with parameters: `/freecad plate.py --length 120 --hole_diameter 5`.
From Timmy's agent: `run_native` with `app: freecad`, `script: plate.py` and `args` (asks first).

Timmy runs `freecadcmd <copy>`: the copy is `plate.py` byte for byte, kept read-only in the run's folder as
`.timmy/native/<run>/source/timmy_<run8>_plate.py`. Its arguments are in `TIMMY_SCRIPT_ARGS` (a JSON list), and
`TIMMY_RESULT`, `TIMMY_RUN`, `TIMMY_SCRIPT`, `TIMMY_SCRIPT_SHA256`, `TIMMY_ROOT`, `TIMMY_OUT` and `TIMMY_FREECAD_LIB`
tell the script where to write and what to echo back.

How `freecadcmd` takes a script, as FreeCAD's source reads (not yet observed here): each word on its command line is a
file to process, and a `.py` file is **imported as a module named after the file** (its folder appended to
`sys.path`); only when that import raises is the file run again, in `__main__`; then `freecadcmd` exits 0. So:

- `plate.py` calls `timmy_freecad.run_script(main)` at the top level, never under `if __name__ == "__main__":`
  (an import does not run that block). A script of your own must do the same, or it writes no result file.
- `run_script` never lets an exception out of `main` (FreeCAD would run the whole file a second time) and runs
  `main` once per process.
- More words on `freecadcmd`'s command line would be opened as more files, so the arguments travel in
  `TIMMY_SCRIPT_ARGS`. Run by hand (`freecadcmd plate.py`), the plate keeps its defaults.
- The copy's module name (`timmy_<run8>_plate`) is one no other file on FreeCAD's path has: under its own name a
  script called `test.py` would import Python's own `test` package instead, and never run.

FreeCAD's Python may ignore `PYTHONPATH`, so `plate.py` puts `TIMMY_FREECAD_LIB` (or its own folder) on `sys.path`
itself to find `timmy_freecad.py`. Without the helper it still writes a result that says so.

## What it writes

| File | What |
|---|---|
| `out/plate.FCStd` | the editable FreeCAD document (the feature tree): open it in FreeCAD |
| `out/plate.step` | the plate alone (`Part.export` of the `Plate` feature) |
| `.timmy/native/<run>/result.json` | the result (a Timmy job); run by hand, `out/timmy-result.json` |

## Its own checks, and the readback

`plate.py` compares FreeCAD's measurement of the plate with the plate's definition: the bounding box
(0, 0, 0) to (length, width, thickness) within 1e-6 mm, and the volume, length x width x thickness less four
cylinders of the hole's diameter through the thickness, within 1e-8 of itself (at least 1e-5 mm3): the CadQuery
recipe's own gates. A check that fails ends the run `ok: false` with the numbers, after the document and the STEP
are written.

Those numbers are FreeCAD's report of its own document, in the process that built it. After a run judged ok,
`/freecad readback` reads `out/plate.step` back in a separate process, with the readback worker `/iterate` uses
(`workers/readback/step_readback.py`, OCP's STEP reader, run with `TIMMY_CADQUERY_PYTHON`, a Python with CadQuery),
and compares its validity, solid count, bounding box and volume with FreeCAD's report, within the same tolerance. It
starts only when the file's bytes are still the ones the run recorded. Both are OpenCascade: a match shows the STEP
file holds the geometry FreeCAD reported, not an independent kernel's confirmation.

Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.

## Before the first run

- FreeCAD installed. Timmy looks for `TIMMY_FREECADCMD` first (a `freecadcmd` program, or a `FreeCAD.app`, which it
  opens to `Contents/Resources/bin/freecadcmd`), then on macOS `/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd`
  (or `FreeCAD <version>.app`, newest first), then `freecadcmd` on `PATH`. `/tools` says which it found; found is not
  run.
- For the readback: `TIMMY_CADQUERY_PYTHON` set to the absolute path of a Python with CadQuery.
