# Unreal starter

A minimal Blueprint-only Unreal Engine project (`TimmyStarter.uproject`: no C++, no binary assets) and a script,
`scene.py`, that builds a level from `scene.params.json`: a grid of cubes (the engine's basic cube,
`/Engine/BasicShapes/Cube.Cube`, 100 cm on each side), placed on the ground, saved as `/Game/Timmy/TimmyGrid`
(the file `Content/Timmy/TimmyGrid.umap`).

**Status: not run on a real Unreal Engine.** The script, Timmy's harness and the readback have run only against a
stand-in `unreal` module in Timmy's tests. The first real run is on the operator's Mac.

## What it needs

- Unreal Engine 5 (written for 5.8) with its Python Editor Script Plugin and Editor Scripting Utilities plugin. Both ship
  with the engine; `TimmyStarter.uproject` enables them.
- Timmy finds `UnrealEditor-Cmd` through `TIMMY_UNREAL` (the program's path), else on macOS where the Epic Games
  Launcher installs engines, `Epic Games/UE_<version>/Engine/Binaries/Mac/UnrealEditor-Cmd` in the Mac's Shared folder
  (in the Users folder), newest version first, else on `PATH`. `/tools` and `/unreal` say what was found. Found is not
  run: a judged run and its readback say whether it works.
- **The first run of a new project makes Unreal build its caches (shaders, derived data): slow, minutes, with nothing
  to see.** Later runs start faster. Unreal makes its own `Saved/`, `Intermediate/` and `DerivedDataCache/` folders
  beside the project file: its caches and logs, not outputs, and Timmy does not judge them.

## Run it

```
/project new grid --from unreal-starter
/unreal TimmyStarter.uproject scene.py
```

or, headless, `timmy act '/unreal TimmyStarter.uproject scene.py' --wait`.

Timmy runs `UnrealEditor-Cmd TimmyStarter.uproject -run=pythonscript -script=<Timmy's harness>
-unattended -nullrhi -nosplash -nopause -stdout -FullStdOutLogOutput`. The harness
(`workers/unreal/timmy_unreal.py` in Timmy) runs a read-only copy of `scene.py` that Timmy keeps when the job is
submitted, calls its `main(run)` and writes the run's result file, `.timmy/native/<run>/result.json`: the level the
script saved and every actor in it (class, label, location, rotation, scale and bounds, as Unreal reports them), the
actors the script made, `scene.params.json`'s sha256 as it read it, and every file created or changed under `Content/`
and `out/`, with its sha256. Timmy judges the run by that file, not by Unreal's exit status.

The first pass alone is never trusted. When it is judged ok, Timmy starts a second, separate Unreal process that opens
the saved level and lists its actors again (`workers/unreal/unreal_readback.py`), and compares the two, actor by actor:
it **agrees** or **differs**, with the numbers. Both passes are Unreal: agreement shows the saved file holds what the
first pass reported, not an independent engine's confirmation. The numbers are Unreal units (centimetres) of a
generated scene, never a measurement of a physical object. `/unreal readback <run>` reads a run's level back again.

Run it again and it opens its level, removes the cubes it placed before (labels `TimmyCube_*`), keeps any other actor
you added, and places the grid again.

## Parameters (`scene.params.json`)

| Name | What | Default |
|---|---|---|
| `level` | the level's package path, under `/Game/` | `/Game/Timmy/TimmyGrid` |
| `count` | how many cubes (1 to 400) | 9 |
| `columns` | cubes per row | the square root of `count`, rounded up |
| `spacing_cm` | the distance between neighbouring cubes' centres | 150 |
| `size_cm` | each cube's size (the basic cube scaled from 100 cm) | 100 |
| `mesh` | the mesh placed | `/Engine/BasicShapes/Cube.Cube` |

The script also checks Unreal's bounds of each cube against the size and place it asked for (its own checks, Unreal's
numbers); they appear with the run's result.

## Open the level

Open `TimmyStarter.uproject` in the Unreal Editor, then `Content/Timmy/TimmyGrid`. The project file names no engine
version (`EngineAssociation` is empty), so the Epic Games Launcher may ask which engine to open it with and write that
version into the file.
