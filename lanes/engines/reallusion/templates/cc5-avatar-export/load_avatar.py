"""
CC5 · load_avatar.py
Loads a Character Creator avatar or imports a character mesh.
Usage: CharacterCreatorpy.exe load_avatar.py <input_path> <output_dir>
"""
import sys, os, json

try:
    import RLPy
except ImportError:
    print(json.dumps({"ok": False, "error": "RLPy not available - run inside CC5"}))
    sys.exit(1)

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: load_avatar.py <input_path> <output_dir>"}))
        sys.exit(1)

    input_path = sys.argv[1]
    output_dir = sys.argv[2]
    stem = os.path.splitext(os.path.basename(input_path))[0]
    os.makedirs(output_dir, exist_ok=True)

    ext = os.path.splitext(input_path)[1].lower()
    if ext == ".ccavatar":
        status = RLPy.RFileIO.LoadFile(input_path)
        action = "load_avatar"
    elif ext in (".fbx", ".obj"):
        status = RLPy.RFileIO.LoadFbxFile(input_path)
        action = "import_mesh"
    else:
        print(json.dumps({"ok": False, "error": f"Unsupported format: {ext}"}))
        sys.exit(1)

    result = {
        "ok": True,
        "action": action,
        "input": input_path,
        "stem": stem,
        "product": RLPy.RApplication.GetProductName(),
        "version": RLPy.RApplication.GetProductVersion(),
    }

    with open(os.path.join(output_dir, f"{stem}.loaded.json"), "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result))

if __name__ == "__main__":
    main()
