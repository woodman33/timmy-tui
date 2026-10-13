# Blender starter

A ground plane, a cube, a sphere and a cylinder in two materials (Timmy Green and Off White), a camera
aimed by a Track To constraint at an empty, and a sun, built by `scene.py` inside Blender's own Python
(headless), saved as an editable `out/scene.blend` and rendered to `out/render.png` (640x400, Workbench).
The run's outcome is its result file, written by `workers/blender/timmy_blender.py`: `ok`, the run's token,
the script's sha256, the sha256 of each file it made, `blender_version` and timing. As a Timmy job each run
writes its own, `.timmy/native/<run>/result.json`, beside the run's record (`job.json`) and Timmy's
verdicts on it; run by hand it is `out/timmy-result.json`. Timmy judges the run by that file, not by
Blender's exit status.

**Status: exercised once** on a Mac with Blender 5.2.2 LTS, as a Timmy job (`/blender scene.py`): it
saved `out/scene.blend` and rendered `out/render.png` (640x400), Timmy judged the run by its result file,
and a second headless Blender read the `.blend` back independently (7 objects, 3 materials, Workbench,
640x400). That run's result listed 3 of the 7 objects; the listing was fixed afterwards and the fix has
run only against the stand-in `bpy` in Timmy's tests.

## Run it

From Timmy's agent: `run_native` with `app: blender` and `script: scene.py` starts it as a job (asks
first), as `blender -b --factory-startup --python-exit-code 1 --python scene.py -- <args>`, and sets
`TIMMY_RESULT`, `TIMMY_RUN`, `TIMMY_SCRIPT`, `TIMMY_SCRIPT_SHA256`, `TIMMY_ROOT`, `TIMMY_OUT` and
`TIMMY_BLENDER_LIB` for the script. Its result counts only when it echoes this run's token and the
script's sha256 as submitted, and every file it names is in the project with a matching sha256.

Blender's Python ignores `PYTHONPATH` unless Blender is started with `--python-use-system-env`, so
`scene.py` puts `TIMMY_BLENDER_LIB` (or its own folder) on `sys.path` itself to find `timmy_blender.py`.

From the workspace: `/run BUILD.md render` runs the block below through upmd. That route sets none of
those variables, so set two yourself first: `TIMMY_BLENDER` to the Blender executable (on macOS
`/Applications/Blender.app/Contents/MacOS/Blender`) and `TIMMY_BLENDER_LIB` to Timmy's `workers/blender`
folder (or copy `timmy_blender.py` next to `scene.py`).

```bash [name:render]
rm -f out/timmy-result.json
"${TIMMY_BLENDER:-blender}" -b --factory-startup --python-exit-code 1 --python "$PWD/scene.py"; status=$?
echo "blender exited $status (recorded; out/timmy-result.json is the outcome)"
test -f out/timmy-result.json && cat out/timmy-result.json
```

The block removes the last result first, then exits 0 only when this run wrote a result file, whatever
Blender's status was. Read `ok` in it: a result that says `ok: false` still exits 0 here.

## What it writes

| File | What |
|---|---|
| `out/scene.blend` | the editable scene: open it in Blender |
| `out/render.png` | the render, 640x400, Workbench (studio light, material colours) |
| `out/timmy-result.json` | the result, run by hand: `ok`, `files` (sha256 each), `blender_version`, `timing` (a Timmy job writes `.timmy/native/<run>/result.json` instead) |

Workbench ignores the sun and the Principled BSDF: it shows each material's viewport colour. Set `ENGINE`
in `scene.py` to Eevee or Cycles for lit renders; those engines are slower and need a GPU context headless.
