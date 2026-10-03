"""
CC5 · export_avatar.py
Exports the loaded character to FBX.
Usage: CharacterCreatorpy.exe export_avatar.py <output_dir> <stem>
"""
import sys, os, json, time

try:
    import RLPy
except ImportError:
    print(json.dumps({"ok": False, "error": "RLPy not available"}))
    sys.exit(1)

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: export_avatar.py <output_dir> <stem>"}))
        sys.exit(1)

    output_dir = sys.argv[1]
    stem = sys.argv[2]
    out_path = os.path.join(output_dir, f"{stem}.cc5.fbx")

    t0 = time.time()

    setting = RLPy.RExportFbxSetting()
    status = RLPy.RFileIO.ExportFbxFile(out_path, setting)
    elapsed_ms = int((time.time() - t0) * 1000)

    ok = os.path.exists(out_path)
    file_size = os.path.getsize(out_path) if ok else 0

    result = {
        "ok": ok,
        "output": out_path,
        "format": "fbx",
        "file_size_bytes": file_size,
        "elapsed_ms": elapsed_ms,
    }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
