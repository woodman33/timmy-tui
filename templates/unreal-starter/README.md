# Unreal starter

A minimal Blueprint-only Unreal Engine project (`TimmyStarter.uproject`: no C++, no binary assets) and a script,
`scene.py`, that builds a level from `scene.params.json`: a grid of cubes (the engine's basic cube,
`/Engine/BasicShapes/Cube.Cube`, 100 cm on each side), placed on the ground, saved as `/Game/Timmy/TimmyGrid`
(the file `Content/Timmy/TimmyGrid.umap`).

**Status: run on Unreal Engine 5.8.2 on the operator's Mac, by a driver giving Unreal Timmy's exact command line and
environment, not yet by Timmy itself.** There the script built the level with its 9 cubes in 15 seconds (its own checks 9
of 9), a second Unreal process read the saved level back with the same bytes and the same 9 actors (Timmy's comparison:
agrees), and run again it opened the level, replaced its cubes and saved it. Timmy's tests run the script, the harness and
the readback against a stand-in `unreal` module. The first run through Timmy (`/unreal`, its receipts) is the next one.

## What it needs

- Unreal Engine 5 (written for 5.8) with its Python Editor Script Plugin and Editor Scripting Utilities plugin. Both ship
  with the engine; `TimmyStarter.uproject` enables them.
- Timmy finds `UnrealEditor-Cmd` through `TIMMY_UNREAL` (the program's path), else on macOS where the Epic Games
  Launcher installs engines, `Epic Games/UE_<version>/Engine/Binaries/Mac/UnrealEditor-Cmd` in the Mac's Shared folder
  (in the Users folder), newest version first, else on `PATH`. `/tools` and `/unreal` say what was found. Found is not
  run: a judged run and its readback say whether it works.
- **The first run of a new project makes Unreal build its caches (shaders, derived data): it can be slow, with nothing
  to see.** On the Mac a first run took 15 to 30 seconds, using the engine's own shipped cache. Timmy tells Unreal to keep
  its derived-data cache in `Saved/DerivedDataCache` beside the project file and to start no Zen server
  (`-DDC=InstalledNoZenLocalFallback -LocalDataCachePath=…`), and to write its log to `Saved/Logs/Timmy-<run>.log`
  (`-abslog=…`). Unreal also makes `Intermediate/` and other `Saved/` folders there and may write `Config/DefaultEngine.ini`
  (it did on the Mac): its caches, logs and settings, not outputs, and Timmy does not judge them.
- **Unreal's own user folders.** On macOS Unreal keeps per-user files (its settings, UnrealBuildTool's, a log folder per
  project, its trace server's store) in `~/Library/Application Support/Epic`, `~/Library/Application Support/Unreal Engine`,
  `~/Library/Logs/Unreal Engine` and `~/UnrealEngine`. A sandboxed Timmy (`TIMMY_NATIVE_HOME`) sends them to its own
  home: it sets `HOME` and `CFFIXED_USER_HOME` (macOS's CoreFoundation, through which Unreal finds those folders, ignores
  `HOME`). After every Unreal job Timmy looks through those folders in your account's home for files changed during the
  job (names and times only) and says what it found: "Unreal wrote nothing outside the project and Timmy's native home",
  or how many files, by folder.

## Run it

```
/project new grid --from unreal-starter
/unreal TimmyStarter.uproject scene.py
```

or, headless, `timmy act '/unreal TimmyStarter.uproject scene.py' --wait`.

Timmy runs `UnrealEditor-Cmd TimmyStarter.uproject -run=pythonscript -script=<Timmy's harness>
-unattended -nullrhi -nosplash -nopause -stdout -FullStdOutLogOutput -DDC=InstalledNoZenLocalFallback
-LocalDataCachePath=<this folder>/Saved/DerivedDataCache -abslog=<this folder>/Saved/Logs/Timmy-<run>.log`: Unreal's
Python commandlet, headless, with no window. The harness
(`workers/unreal/timmy_unreal.py` in Timmy) runs a read-only copy of `scene.py` that Timmy keeps when the job is
submitted, calls its `main(run)` and writes the run's result file, `.timmy/native/<run>/result.json`: the level the
script saved and every actor in it (class, label, location, rotation, scale and bounds, as Unreal reports them), the
actors the script made, `scene.params.json`'s sha256 as it read it, and every file created or changed under `Content/`
and `out/`, with its sha256. Timmy judges the run by that file, not by Unreal's exit status: Unreal exits 0 and says
"Python script executed successfully" even when the script failed. A run that fails still names what it wrote, each
file checked against its sha256, as written by the failed run, never as its output.

`run.spawn_mesh` places a mesh by spawning a `StaticMeshActor` by class and giving it the mesh
(`EditorActorSubsystem.spawn_actor_from_class`, then `set_static_mesh`). In the commandlet of Unreal 5.8.2,
`EditorActorSubsystem.spawn_actor_from_object(mesh, …)` gives no actor ("SpawnActorFromObject. No actor was spawned."):
a script of your own should spawn the same way, or through `run.spawn_mesh`.

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
