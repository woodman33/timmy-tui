# Timmy recipes

`timmy recipe list`, `plan --request FILE`, and `build --request FILE` admit
`enclosure.tray/1` as a bounded native recipe. The existing unmerged spatial
foundation prototype is left intact; this lane is available from the released
CLI without depending on that prototype's untracked files.

```json
{"schema":"timmy.recipe-request/1","recipe":"enclosure.tray/1","parameters":{"width":140,"wall":3,"supportOffset":10,"bore":3}}
```

Dimensions are millimetres. `bore` is diameter; `supportOffset` is the distance
from each exterior X/Y edge to its support and matching bore axis. Wall also
drives base thickness. Depth=80, height=30, support radius=6 and height=8 are
fixed. Input rejects unknown fields, nonfinite numbers, nonpositive wall/bore,
overlapping supports, support/wall conflicts and bores as large as supports.

Set `TIMMY_CADQUERY_PYTHON` to an installed Python executable containing
CadQuery and Open3D. No dependencies are installed automatically. Native runs
have a two-minute timeout. Each build gets a new private run directory beneath
`.timmy/recipe-runs`, a source snapshot, a signed prediction before native
execution, a signed success/failure receipt, four feature STLs and a final STEP.
The source, request, Python executable and recipe card are hash-bound; native
measurements name the CadQuery and Open3D versions. This is not a complete
hermetic dependency lock or a cross-run byte reproducibility claim.

Stable semantic feature IDs are `tray.outer` (box), `tray.cavity` (subtract),
`tray.bosses` (union) and `tray.bores` (subtract). Each records dependencies,
native bounds and, where relevant, measured cylinder axes. STEP/STL do not
preserve the parametric feature history: the request, recipe and feature report
do. No UI selection or external scene-edit authority is added.

For width 140→180, all four features rebuild; the outer/cavity X faces expand
±20 mm and supports plus bores move outward ±20 mm in X. Their Y positions,
wall and bore size remain constant. The analytical volume, bounds and expected
axis coordinates are sealed before each new native run, including rebuilds.

The original workbench's 30 aggregate checks covered three variants with ten
summary checks each. This admission strengthens that to **30 mandatory checks
per build**: 12 construction-stage checks, three final-solid checks, three STEP
reimport checks, three independent mesh checks, one stage aggregate, and eight
measured support/bore-axis checks. Missing Open3D or any check fails closed.
The runner independently compares native dimensions, analytical volume and axes
against the sealed forecast, and rehashes all five exports before success.

Run unit tests with `npm test -- --run tests/tray-recipe.test.ts`. Run the native
acceptance with `npx tsx lanes/recipes/qualify.ts` after configuring the runtime.
It builds 140 and 180, checks native motion, varies wall/offset/bore, refuses
wall=0 before native execution, and rejects a modified mesh and incomplete gate.
Each invocation adds real receipts; it is not part of the ordinary test suite.
