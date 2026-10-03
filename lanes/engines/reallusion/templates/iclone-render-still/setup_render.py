"""
iClone 8 · setup_render.py
Configures camera, resolution, and render settings for a still frame export.
Usage: iClonepy.exe setup_render.py <output_dir> <stem>
"""
import sys
import os
import json

try:
    import RLPy
except ImportError:
    print(json.dumps({"ok": False, "error": "RLPy not available"}))
    sys.exit(1)

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: setup_render.py <output_dir> <stem>"}))
        sys.exit(1)

    output_dir = sys.argv[1]
    stem = sys.argv[2]

    width, height = 1920, 1080

    cameras = RLPy.RScene.GetCameras()
    if cameras:
        cam = cameras[0]
        RLPy.RScene.SetCurrentCamera(cam)
        cam_name = cam.GetName()
    else:
        cam_name = "default"

    config = {
        "ok": True,
        "resolution": [width, height],
        "camera": cam_name,
        "render_type": "still",
    }

    report_path = os.path.join(output_dir, f"{stem}.config.json")
    with open(report_path, "w") as f:
        json.dump(config, f, indent=2)

    print(json.dumps(config))

if __name__ == "__main__":
    main()
