# Reallusion Engine Lane (iClone 8 + Character Creator 5 + Hub)

## Overview

This lane provides CLI/async workflow integration for the Reallusion creative suite:
- **iClone 8** — real-time 3D animation and rendering
- **Character Creator 5 (CC5)** — character design and morphing
- **Reallusion Hub** — content marketplace and library management

## Bridge Architecture

Reallusion apps expose a **Python API via RLPy**, a SWIG-generated binding to the native C++ SDK. Scripts run inside each app's embedded Python interpreter (`iClonepy.exe` / `CharacterCreatorpy.exe`).

### Key Constraints
- **Host app must be running** for live API access (RLPy imports fail standalone)
- **Windows only** — iClone 8 and CC5 are Windows-native applications
- **No headless mode** — unlike Houdini's `hython`, Reallusion's Python requires the GUI host
- **Async pattern**: scripts are dispatched to the running app via file-drop or socket; results written to `out/`

### Async Workflow Pattern
```
Timmy TUI → plan.cue dispatch → iClonepy.exe script.py → out/*.json + artifacts
                                        ↑
                              iClone 8 must be running
```

For true async/headless operation, consider:
1. Running iClone/CC5 in a persistent session on this machine or a Spark node
2. Using NVIDIA Sync tunnels to reach the host app remotely
3. Building a socket bridge that accepts JSON commands and returns results

## Templates

| Template | Purpose | Input | Output |
|----------|---------|-------|--------|
| `iclone-render-still` | Render one frame from an iClone project | `.iProject`, `.fbx`, `.obj` | PNG + report |
| `cc5-avatar-export` | Export a CC5 character to FBX/OBJ/GLB | `.ccAvatar`, `.fbx` | FBX + textures + report |
| `hub-content-sync` | Sync marketplace content to local libraries | JSON spec | manifest + report |

## Environment Lock

See `env-lock.json` for pinned binary paths and versions. The env-lock captures:
- `iClonepy.exe` path (iClone 8 embedded Python)
- `CharacterCreatorpy.exe` path (CC5 embedded Python)
- Main application executables

## MCP Integration Status

**Not yet implemented.** Future work:
- Build an MCP server that wraps RLPy calls (similar to `houdini-gen-mcp`)
- Expose tools like `reallusion_render`, `reallusion_export_avatar`, `reallusion_hub_sync`
- Register in Timmy's MCP server (`src/mcp/server.ts`) alongside existing vision/forge tools

## Comparison to Houdini/Unreal Lanes

| Aspect | Houdini | Unreal | Reallusion |
|--------|---------|--------|------------|
| Headless CLI | `hython`, `husk` | `UnrealEditor -batch` | Requires GUI host |
| Python API | Native `hou` module | `unreal` module (editor) | `RLPy` (SWIG, in-app) |
| MCP server | `houdini-gen-mcp` | `unreal-mcp` (mcporter) | Not yet built |
| Async-friendly | Yes | Partial | Needs socket bridge |

## Next Steps

1. **Test templates locally** with iClone 8 / CC5 running
2. **Build MCP adapter** following the houdini-gen-mcp pattern
3. **Add socket bridge** for true headless async workflows
4. **Discover Hub API** for content sync automation
5. **Qualify** with receipted runs through drop folders
