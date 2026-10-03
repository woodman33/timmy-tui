"""
iClone 8 · load_scene.py
Loads an iClone project or imports a supported 3D asset into the current scene.
Requires iClone 8 running with Python API plugin active.
Usage: iClonepy.exe load_scene.py <input_path> <output_dir>
"""
import sys
import os
import json

try:
    import RLPy
except ImportError:
    print(json.dumps({"ok": False, "error": "RLPy not available - run inside iClone 8"}))
    sys.exit(1)

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: load_scene.py <input_path> <output_dir>"}))
        sys.exit(1)

    input_path = sys.argv[1]
    output_dir = sys.argv[2]
    stem = os.path.splitext(os.path.basename(input_path))[0]

    os.makedirs(output_dir, exist_ok=True)

    ext = os.path.splitext(input_path)[1].lower()

    if ext == ".iproject":
        status = RLPy.RFileIO.LoadProject(input_path)
        action = "load_project"
    elif ext in (".fbx", ".obj", ".3dx"):
        status = RLPy.RFileIO.LoadFile(input_path)
        action = "import_asset"
    else:
        print(json.dumps({"ok": False, "error": f"Unsupported format: {ext}"}))
        sys.exit(1)

    result = {
        "ok": status == RLPy.RStatus.Success if hasattr(RLPy.RStatus, 'Success') else True,
        "action": action,
        "input": input_path,
        "stem": stem,
        "product": RLPy.RApplication.GetProductName(),
        "version": RLPy.RApplication.GetProductVersion(),
    }

    report_path = os.path.join(output_dir, f"{stem}.scene.json")
    with open(report_path, "w") as f:
        json.dump(result, f, indent=2)

    print(json.dumps(result))

if __name__ == "__main__":
    main()
