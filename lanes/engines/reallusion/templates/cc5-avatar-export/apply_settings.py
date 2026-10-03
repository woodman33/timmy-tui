"""
CC5 · apply_settings.py
Applies morph/material presets to the loaded character (placeholder for custom presets).
Usage: CharacterCreatorpy.exe apply_settings.py <output_dir> <stem>
"""
import sys, os, json

try:
    import RLPy
except ImportError:
    print(json.dumps({"ok": False, "error": "RLPy not available"}))
    sys.exit(1)

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: apply_settings.py <output_dir> <stem>"}))
        sys.exit(1)

    output_dir = sys.argv[1]
    stem = sys.argv[2]

    avatars = RLPy.RScene.GetAvatars()
    avatar_count = len(avatars)

    result = {
        "ok": True,
        "avatar_count": avatar_count,
        "note": "Morph/material preset application is a placeholder; extend with specific RLPy morph API calls as needed.",
    }

    with open(os.path.join(output_dir, f"{stem}.settings.json"), "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result))

if __name__ == "__main__":
    main()
