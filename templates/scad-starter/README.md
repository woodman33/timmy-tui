# OpenSCAD starter: a parametric box with a lid

A blank, reusable OpenSCAD model for Timmy's `/scad` route: an open box and a lid whose lip drops
into it with a clearance (`lid_gap`) on every side, laid out side by side for printing.

| File | What it is |
|---|---|
| `box.scad` | the model; every value at its top is a parameter |
| `box.params.json` | the parameters `/scad` uses for `box.scad` by default |

## Run it

```
/project new mybox --from scad-starter
/scad box.scad                              the values in box.params.json
/scad box.scad width=80 part="lid" --png    words override the file; --png adds a preview
```

A value is a number (`width=80`, `lid_gap=0.25`), `true` or `false`, or text in quotes
(`part="lid"`). Anything else is refused before OpenSCAD starts, with the reason: OpenSCAD reads
each `-D name=value` as code, so Timmy writes every value itself.

The parameter file sits beside the model and is named after it (`<model>.params.json`):

```json
{ "schema": "timmy.scad-params/1", "model": "box.scad", "parameters": { "width": 60, "part": "both" } }
```

It holds those three fields and nothing else. A file that does not check is refused with its
reason, never skipped quietly.

## What a run does

- OpenSCAD runs headless (no window) on a read-only copy of the model kept in the run's folder,
  `.timmy/native/<run>/source/box.scad`; its sha256 is checked when the copy is made and again when
  the run is judged.
- `use <…>` and `include <…>` files beside `box.scad` still resolve: Timmy puts the model's own
  folder first on `OPENSCADPATH`. OpenSCAD resolves files named by `import()` or `surface()` beside
  the file that calls them and never on `OPENSCADPATH`, so name such files by their absolute path,
  or call `import()` from a file the model includes.
- The STL (binary) goes to a new folder for each run: `out/scad/<run>/box.stl` (and `box.png` with
  `--png`).
- The run is judged by OpenSCAD's exit, the STL having been created by this run, and OpenSCAD's
  `ERROR` lines, which are kept word for word with its `WARNING` lines.
- Timmy then reads the STL back with its own reader (TypeScript, independent of OpenSCAD's
  engine): the triangle count, the bounding box, the signed volume, the surface area and whether
  every edge is shared by exactly two triangles (edge-manifold).

Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.

The STL records no unit; OpenSCAD models are millimetres by convention.

This starter has not been rendered by OpenSCAD in Timmy's automated tests: they run a stand-in
program in OpenSCAD's place. Its first real run is on a machine with OpenSCAD installed
(`openscad` on `PATH`, or `TIMMY_OPENSCAD` set to its program).
