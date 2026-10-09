# Cinema 4D starter

A cube with a simple material and a camera (named for the render by a Stage object), built by `scene.py` inside Cinema 4D's own Python (`c4dpy`,
headless), saved as an editable `out/scene.c4d` and rendered to `out/still.png` (640x360, Standard
renderer). The run's outcome is `out/timmy-result.json`, written by `workers/c4d/timmy_c4d.py`: `ok`, the
sha256 of each file it made, `c4d_version` and timing. Timmy judges the run by that file, not by c4dpy's
exit status (a retained real run wrote `ok: true` while c4dpy exited 1).

**Status: not yet exercised.** `scene.py` follows the documented `c4d` API and has run here only against a
stand-in `c4d` module. Its first real run is on a Mac with Cinema 4D installed.

## Run it

From Timmy's agent: `run_native` with `app: c4dpy` and `script: scene.py` starts it as a job (asks first)
and sets `TIMMY_RESULT`, `TIMMY_RUN`, `TIMMY_ROOT`, `TIMMY_OUT` and `TIMMY_C4D_LIB` for the script.

From the workspace: `/run BUILD.md render` runs the block below through upmd. That route sets none of
those variables, so set two yourself first: `TIMMY_C4DPY` to the c4dpy executable (on macOS
`/Applications/Maxon Cinema 4D 2026/c4dpy.app/Contents/MacOS/c4dpy`) and `TIMMY_C4D_LIB` to Timmy's
`workers/c4d` folder (or copy `timmy_c4d.py` next to `scene.py`).

```bash [name:render]
rm -f out/timmy-result.json
"${TIMMY_C4DPY:-c4dpy}" "$PWD/scene.py"; status=$?
echo "c4dpy exited $status (recorded; out/timmy-result.json is the outcome)"
test -f out/timmy-result.json && cat out/timmy-result.json
```

The block removes the last result first, then exits 0 only when this run wrote a result file, whatever
c4dpy's status was. Read `ok` in it: a result that says `ok: false` still exits 0 here.

## What it writes

| File | What |
|---|---|
| `out/scene.c4d` | the editable document: open it in Cinema 4D |
| `out/still.png` | the render, 640x360, Standard renderer |
| `out/timmy-result.json` | the result: `ok`, `files` (sha256 each), `c4d_version`, `timing`, `notes` |

A Stage object names `Camera` for the render. If the document has no active view headless, that Stage
object is the only thing naming it; the result's `notes` say so when it happens, so look at the still.
