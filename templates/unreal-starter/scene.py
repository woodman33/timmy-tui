"""Timmy's Unreal starter: a level holding a grid of cubes, built inside Unreal Editor's own Python, headless.

It reads scene.params.json beside it (the level's package path, how many cubes, how many per row, their spacing and
size in centimetres, and the mesh: the engine's basic cube, /Engine/BasicShapes/Cube.Cube, 100 cm on each side and
centred on its pivot), makes the level, places the cubes on the ground (z = half their size) and saves the level.
Run again, it opens the level it made, removes the cubes it placed before (labels TimmyCube_*), keeps every other actor
and places the grid again.

Timmy runs it through its harness, workers/unreal/timmy_unreal.py (/unreal TimmyStarter.uproject scene.py):
    UnrealEditor-Cmd TimmyStarter.uproject -run=pythonscript -script=<timmy_unreal.py> -unattended -nullrhi -nosplash
                     -nopause -stdout -FullStdOutLogOutput
The harness runs a read-only copy of this file kept when the job is submitted (so what runs is what was submitted),
calls main(run) and writes the run's result file: the level it saved, every actor in it with its class, label,
location, rotation, scale and bounds (Unreal's own numbers), the actors this script made, and every file written with
its sha256. Then a second, separate Unreal process opens the saved level and lists its actors again, and Timmy compares
the two: the first pass alone is never trusted.

NOT YET EXERCISED on a real Unreal Engine: checked only with python3 against the stand-in `unreal` module in Timmy's
tests (tests/fixtures/unreal-stub). The first real run is the operator's, on the Mac.
"""
import math

import timmy_unreal  # noqa: F401 (the harness that runs this file; `run` below is its run)

PREFIX = "TimmyCube_"
#: /Engine/BasicShapes/Cube is 100 Unreal units (centimetres) on each side, centred on its pivot
BASIC_CUBE_CM = 100.0
#: the script's own checks allow this much (centimetres) between Unreal's bounds and what was asked for
CHECK_CM = 0.01


def _number(params, key, default, low, high):
    value = float(params.get(key, default))
    if not (low <= value <= high):
        raise ValueError("%s is %s in scene.params.json; it must be from %s to %s" % (key, value, low, high))
    return value


def _cm(v):
    return ("%.3f" % v).rstrip("0").rstrip(".")


def main(run):
    params = run.read_json("scene.params.json")
    level = str(params.get("level", "/Game/Timmy/TimmyGrid"))
    count = int(_number(params, "count", 9, 1, 400))
    columns = int(_number(params, "columns", math.ceil(math.sqrt(count)), 1, 400))
    spacing = _number(params, "spacing_cm", 150.0, 0.001, 1.0e6)
    size = _number(params, "size_cm", 100.0, 0.001, 1.0e6)
    mesh_path = str(params.get("mesh", "/Engine/BasicShapes/Cube.Cube"))

    if run.level_exists(level):
        # This level is the starter's own: the cubes it placed before go, anything else in it stays.
        run.load_level(level)
        for actor in run.actors():
            if str(actor.get_actor_label()).startswith(PREFIX):
                run.remove_actor(actor)
        was = "opened"
    else:
        run.new_level(level)
        was = "created"

    cube = run.load_mesh(mesh_path)
    scale = size / BASIC_CUBE_CM
    placed = []
    for i in range(count):
        row, col = divmod(i, columns)
        at = (col * spacing, row * spacing, size / 2.0)
        label = "%s%d_%d" % (PREFIX, row, col)
        run.spawn_mesh(cube, at, scale=(scale, scale, scale), label=label)
        placed.append((label, at))

    saved = run.save_level()

    # The script's own checks: Unreal's bounds of each cube, as saved, against the size and place asked for. These are
    # Unreal's numbers checked against this script's expectations; the second pass is Timmy's check of the saved file.
    by_label = dict((a["label"], a) for a in saved["actors"])
    checks = []
    for label, at in placed:
        a = by_label.get(label)
        passed = a is not None and all(abs(s - size) <= CHECK_CM for s in a["bounds"]["size"]) \
            and all(abs(o - e) <= CHECK_CM for o, e in zip(a["bounds"]["origin"], at))
        checks.append({"label": "%s: a %s cm cube centred at (%s, %s, %s)" % (label, _cm(size), _cm(at[0]), _cm(at[1]), _cm(at[2])),
                       "passed": bool(passed)})
    return {"level": level, "level_was": was, "cubes": count, "columns": columns, "spacing_cm": spacing, "size_cm": size,
            "mesh": mesh_path, "checks": checks}
