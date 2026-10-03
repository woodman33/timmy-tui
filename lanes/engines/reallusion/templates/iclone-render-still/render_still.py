"""
iClone 8 · render_still.py
Renders one still frame to PNG via RGlobal.RenderImage.
Usage: iClonepy.exe render_still.py <output_dir> <stem>
"""
import sys
import os
import json
import time

try:
    import RLPy
except ImportError:
    print(json.dumps({"ok": False, "error": "RLPy not available"}))
    sys.exit(1)

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: render_still.py <output_dir> <stem>"}))
        sys.exit(1)

    output_dir = sys.argv[1]
    stem = sys.argv[2]
    out_path = os.path.join(output_dir, f"{stem}.iclone.png")

    t0 = time.time()

    param = RLPy.RExportImageParameter()
    param.SetWidth(1920)
    param.SetHeight(1080)

    status = RLPy.RGlobal.RenderImage(out_path, param)
    elapsed_ms = int((time.time() - t0) * 1000)

    ok = (status == RLPy.RStatus.Success) if hasattr(RLPy.RStatus, 'Success') else os.path.exists(out_path)

    result = {
        "ok": ok,
        "output": out_path,
        "elapsed_ms": elapsed_ms,
        "resolution": [1920, 1080],
    }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
