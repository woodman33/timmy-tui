"""Timmy's Blender starter: a ground plane, a cube, a sphere and a cylinder in two materials, a camera aimed
by a Track To constraint and a sun, saved as an editable .blend and rendered to a 640x400 PNG with the
Workbench engine (the safest headless). Run with Blender's own Python, headless:

    blender -b --factory-startup --python scene.py

Exercised once on a real Blender (5.2.2 LTS on macOS, round R3, as a Timmy job): it saved the .blend and
rendered the PNG, and a second, independent headless Blender read the .blend back with all 7 objects and
3 materials. That run's result file listed only 3 objects (the master collection's own); the list now
comes from scene.objects and that fix has run only against the stand-in `bpy` (tests/native-blender.test.ts).
Round R4: the result also reports the active camera, which /iterate blender's second pass compares with the
saved .blend; that too has run only against the stand-in.

What it writes (under TIMMY_OUT, default ./out):
  scene.blend        the editable scene (bpy.ops.wm.save_as_mainfile): open it in Blender
  render.png         the render (bpy.ops.render.render(write_still=True)), 640x400, Workbench
  timmy-result.json  the result file, when run by hand; a Timmy job sets TIMMY_RESULT to the run's own
                     file, .timmy/native/<run>/result.json

Every step is inside timmy_blender.run_script: an exception becomes ok: false with the error, never a
silent success. Blender's exit status is not the outcome; the result file is.

A Timmy job runs a read-only copy of this file, kept in the run's folder when the job is submitted
(.timmy/native/<run>/source/scene.py), so what runs is exactly what was submitted. __file__ is that copy;
TIMMY_SCRIPT_DIR is the folder the script was submitted from, for files and modules beside it.
"""
import os
import sys

# timmy_blender.py: in TIMMY_BLENDER_LIB (Timmy's Blender job sets it to its workers/blender), next to this
# script (TIMMY_SCRIPT_DIR when a Timmy job runs its copy), or already on sys.path. Blender's Python ignores
# PYTHONPATH by default, so the folders are added here.
try:
    _here = os.path.dirname(os.path.abspath(__file__))
except NameError:  # a host that runs the file without __file__
    _here = os.getcwd()
for _folder in (os.environ.get("TIMMY_BLENDER_LIB"), os.environ.get("TIMMY_SCRIPT_DIR"), _here):
    if _folder and _folder not in sys.path:
        sys.path.insert(0, _folder)

try:
    import timmy_blender  # noqa: E402
except ImportError as missing:
    # Without the helper the run still leaves a result that says what went wrong (never just an exit status).
    import json
    _root = os.environ.get("TIMMY_ROOT") or os.getcwd()
    _result = os.environ.get("TIMMY_RESULT") or os.path.join(os.environ.get("TIMMY_OUT") or os.path.join(_root, "out"), "timmy-result.json")
    if not os.path.isdir(os.path.dirname(_result)):
        os.makedirs(os.path.dirname(_result))
    with open(_result, "w") as _f:
        json.dump({"ok": False, "run": os.environ.get("TIMMY_RUN"), "script_sha256": os.environ.get("TIMMY_SCRIPT_SHA256"), "files": {},
                   "error": "ImportError: timmy_blender.py was not found (%s): set TIMMY_BLENDER_LIB to Timmy's workers/blender, or copy it next to scene.py" % missing}, _f)
    raise

WIDTH, HEIGHT = 640, 400
ENGINE = "BLENDER_WORKBENCH"
GREEN = (0.18, 0.80, 0.44, 1.0)
OFF_WHITE = (0.88, 0.87, 0.82, 1.0)


def material(bpy, name, rgba):
    """A material in one colour: diffuse_color for Workbench and the viewport, the Principled BSDF's base
    colour for Eevee and Cycles."""
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = rgba
    try:
        mat.use_nodes = True
    except (AttributeError, TypeError):
        pass  # a Blender whose materials always use nodes
    bsdf = mat.node_tree.nodes.get("Principled BSDF") if getattr(mat, "node_tree", None) is not None else None
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = rgba
    return mat


def add(bpy, op, mat, name, **kwargs):
    """A primitive by its operator, named and given a material."""
    op(**kwargs)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def main(run):
    import bpy

    scene = bpy.context.scene
    # --factory-startup opens the default scene (a cube, a camera, a light): start from nothing instead.
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    green = material(bpy, "Timmy Green", GREEN)
    white = material(bpy, "Off White", OFF_WHITE)

    add(bpy, bpy.ops.mesh.primitive_plane_add, white, "Ground", size=12.0, location=(0.0, 0.0, 0.0))
    add(bpy, bpy.ops.mesh.primitive_cube_add, green, "Cube", size=2.0, location=(-2.4, 0.0, 1.0))
    add(bpy, bpy.ops.mesh.primitive_uv_sphere_add, white, "Sphere", radius=1.0, location=(0.0, 0.6, 1.0))
    add(bpy, bpy.ops.mesh.primitive_cylinder_add, green, "Cylinder", radius=0.7, depth=2.4, location=(2.4, -0.4, 1.2))

    # An empty the camera aims at, so no angle is guessed.
    aim = bpy.data.objects.new("Aim", None)
    aim.location = (0.0, 0.0, 0.9)
    scene.collection.objects.link(aim)

    cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
    cam.location = (7.5, -7.5, 5.2)
    track = cam.constraints.new(type="TRACK_TO")
    track.target = aim
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    scene.collection.objects.link(cam)
    scene.camera = cam

    sun_data = bpy.data.lights.new("Sun", type="SUN")
    sun_data.energy = 3.0
    sun = bpy.data.objects.new("Sun", sun_data)
    sun.rotation_euler = (0.9, 0.2, 0.6)
    scene.collection.objects.link(sun)

    # Workbench at 640x400: studio light, each object in its material's colour (Workbench ignores the sun;
    # switch ENGINE to Eevee or Cycles and the sun and the Principled colours take over).
    scene.render.engine = ENGINE
    scene.render.resolution_x = WIDTH
    scene.render.resolution_y = HEIGHT
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"

    # The editable scene first: it is worth keeping even when the render fails.
    run.save_blend(run.out_path("scene.blend"))
    run.render_still(run.out_path("render.png"))

    return {
        "engine": ENGINE, "resolution": [WIDTH, HEIGHT],
        # scene.objects is every object in the scene; scene.collection.objects only the master collection's
        # own, which misses the primitives (the operators link them to the active collection).
        "objects": sorted(o.name for o in scene.objects), "materials": ["Timmy Green", "Off White"],
        # R4: the active camera, which /iterate blender's second pass compares with the saved .blend
        "camera": scene.camera.name if scene.camera else None,
        "args": timmy_blender.script_args(),
    }


if __name__ == "__main__":
    timmy_blender.run_script(main)
