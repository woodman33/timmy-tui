"""Timmy's Cinema 4D starter: a cube with a simple material and a camera, saved as an editable .c4d and
rendered to a 640x360 PNG with the Standard renderer. Run with c4dpy (Cinema 4D's own Python, headless):

    c4dpy scene.py

NOT YET EXERCISED on a real Cinema 4D: written against the documented `c4d` Python API (c4d,
c4d.documents, c4d.bitmaps) and checked here only with Python 3 against a stand-in `c4d` module
(tests/native-python.test.ts). Its first real run is the operator's, on the Mac.

What it writes (under TIMMY_OUT, default ./out):
  scene.c4d          the editable document (c4d.documents.SaveDocument)
  still.png          the render (c4d.documents.RenderDocument into a c4d.bitmaps.BaseBitmap)
  timmy-result.json  the result file Timmy judges the run by (or where TIMMY_RESULT says)

Every step is inside timmy_c4d.run_script: an exception becomes ok: false with the error, never a silent
success. The c4dpy exit status is not the outcome; the result file is.
"""
import os
import sys

# timmy_c4d.py: next to this script, in TIMMY_C4D_LIB (Timmy's c4dpy job sets it to its workers/c4d), or on sys.path.
try:
    _here = os.path.dirname(os.path.abspath(__file__))
except NameError:  # a host that runs the file without __file__
    _here = os.getcwd()
for _folder in (os.environ.get("TIMMY_C4D_LIB"), _here):
    if _folder and _folder not in sys.path:
        sys.path.insert(0, _folder)

try:
    import timmy_c4d  # noqa: E402
except ImportError as missing:
    # Without the helper the run still leaves a result that says what went wrong (never just an exit status).
    import json
    _root = os.environ.get("TIMMY_ROOT") or os.getcwd()
    _result = os.environ.get("TIMMY_RESULT") or os.path.join(os.environ.get("TIMMY_OUT") or os.path.join(_root, "out"), "timmy-result.json")
    if not os.path.isdir(os.path.dirname(_result)):
        os.makedirs(os.path.dirname(_result))
    with open(_result, "w") as _f:
        json.dump({"ok": False, "run": os.environ.get("TIMMY_RUN"), "files": {},
                   "error": "ImportError: timmy_c4d.py was not found (%s): set TIMMY_C4D_LIB to Timmy's workers/c4d, or copy it next to scene.py" % missing}, _f)
    raise

WIDTH, HEIGHT = 640, 360


def main(run):
    import c4d
    from c4d import bitmaps, documents

    doc = documents.BaseDocument()
    doc.SetDocumentName("scene.c4d")

    # A simple material: a standard material with a green colour channel.
    mat = c4d.BaseMaterial(c4d.Mmaterial)
    mat.SetName("Timmy Green")
    mat[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(0.18, 0.80, 0.44)
    doc.InsertMaterial(mat)

    # A 200 cm cube at the origin, the material on it through a texture tag.
    cube = c4d.BaseObject(c4d.Ocube)
    cube.SetName("Cube")
    cube[c4d.PRIM_CUBE_LEN] = c4d.Vector(200, 200, 200)
    tex = cube.MakeTag(c4d.Ttexture)
    tex[c4d.TEXTURETAG_MATERIAL] = mat
    doc.InsertObject(cube)

    # A camera in front, above and to the side; a Target tag points it at the cube, so no angle is guessed.
    cam = c4d.CameraObject()
    cam.SetName("Camera")
    cam.SetAbsPos(c4d.Vector(400, 250, -600))
    target = cam.MakeTag(c4d.Ttargetexpression)
    target[c4d.TARGETEXPRESSIONTAG_LINK] = cube
    doc.InsertObject(cam)

    # Render from that camera when the document has a view to set it on; headless it may not.
    bd = doc.GetActiveBaseDraw()
    if bd is not None:
        bd.SetSceneCamera(cam)
    else:
        run.note("the document has no active view, so the render may come from the default camera, not Camera")

    # Standard renderer, 640x360.
    rd = doc.GetActiveRenderData()
    rd[c4d.RDATA_RENDERENGINE] = c4d.RDATA_RENDERENGINE_STANDARD
    rd[c4d.RDATA_XRES] = float(WIDTH)
    rd[c4d.RDATA_YRES] = float(HEIGHT)

    # Evaluate the scene once (the Target tag) before saving and rendering.
    doc.ExecutePasses(None, True, True, True, c4d.BUILDFLAGS_NONE)

    # The editable document first: it is worth keeping even when the render fails.
    scene_path = run.out_path("scene.c4d")
    if not documents.SaveDocument(doc, scene_path, c4d.SAVEDOCUMENTFLAGS_DONTADDTORECENTLIST, c4d.FORMAT_C4DEXPORT):
        raise RuntimeError("SaveDocument returned False for scene.c4d")
    run.add_file(scene_path)

    bmp = bitmaps.BaseBitmap()
    if bmp.Init(WIDTH, HEIGHT, 24) != c4d.IMAGERESULT_OK:
        raise RuntimeError("BaseBitmap.Init(%d, %d, 24) failed" % (WIDTH, HEIGHT))
    flags = c4d.RENDERFLAGS_EXTERNAL | c4d.RENDERFLAGS_NODOCUMENTCLONE
    rendered = documents.RenderDocument(doc, rd.GetDataInstance(), bmp, flags)
    if rendered != c4d.RENDERRESULT_OK:
        raise RuntimeError("RenderDocument returned %s (RENDERRESULT_OK is %s)" % (rendered, c4d.RENDERRESULT_OK))

    still_path = run.out_path("still.png")
    if bmp.Save(still_path, c4d.FILTER_PNG) != c4d.IMAGERESULT_OK:
        raise RuntimeError("BaseBitmap.Save did not write still.png")
    run.add_file(still_path)

    return {"renderer": "standard", "resolution": [WIDTH, HEIGHT], "objects": ["Cube", "Camera"], "material": "Timmy Green"}


if __name__ == "__main__":
    timmy_c4d.run_script(main)
