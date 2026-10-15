# Timmy review package · __REV__

The packed Timmy of one exact revision, a launcher that runs it in a sandbox beside itself, and (when this package carries
them) the notes and captures of a scripted rehearsal. Nothing is installed globally, nothing is published, and no model key
is read from your shell. This package is for your own review: implementation status is reported here; visual and usability
acceptance are yours.

## Exact revision

| | |
|---|---|
| Revision | `__REV__`, branch `r5/review-build` (its draft PR targets `feat/ui-workflow-r1`) |
| Package | `__TGZ__`; its sha256 and every other file's are in `SHA256SUMS` |
| Checks | in `REHEARSAL.md` when this package carries one: the full suite, the type checks, the packed-install check and the privacy scan of this revision, each with its counts, and what a script did with this package |
| Not in this package | merge, publish, tags, deployment (all on HOLD); any live fleet, paid model call or new account |

## Launch (Linux or macOS; Node 24 or later and npm; python3 for workflow runs; tmux for `watch`)

```bash
shasum -a 256 -c timmy-review-__REV__.tar.gz.sha256      # Linux: sha256sum -c
tar -xzf timmy-review-__REV__.tar.gz
cd timmy-review-__REV__
./review.sh install      # npm installs the packed Timmy and its dependencies into ./sandbox/prefix (--ignore-scripts)
./review.sh demo         # a blank Timmy home with two projects: blank, then tray (the active one)
./review.sh check        # the shared workspace, after one free request to each service
./review.sh workbench    # the terminal Workbench: the main space
```

Then, in other terminal windows: `./review.sh repl` (the REPL), `./review.sh watch` (the monitor), `./review.sh timmy <args>`
(any command), `./review.sh where` (folders and ports), `./review.sh clean` (removes ./sandbox only, after you type yes).

- **Chat needs a route.** `./review.sh ollama 127.0.0.1:11434 <a model your Ollama lists>` sets your own local Ollama (no key,
  no charge). For OpenRouter, give the sandbox a key yourself: `./review.sh timmy init` asks for it, hidden. The launcher
  runs Timmy with `env -i` and its own list, so no key in your shell reaches it.
- **Ports, 127.0.0.1 only:** Studio 4440, the log companion 4441, the browser companion 4442 (set `TIMMY_STUDIO_PORT`,
  `TIMMY_LOGS_PORT` or `TIMMY_COMPANION_PORT` before a command to change them). The Workbench prints each address when it
  starts that surface.
- **upmd** (workflows) is bundled for Linux x86_64 only when `bin/upmd` is here (MIT; licence in `bin/upmd-LICENSE.txt`).
  Elsewhere Timmy uses your own `upmd`, or says how to install it.
- **FAKE:** every lane program (`fake-lanes/`: opencode, hermes, pi, openhands, jcode, minds) is a stand-in that notes its
  call in `sandbox/fake-lanes.log` and waits, so no real lane starts.

## What you can test today (the Workbench's keys: `?`)

1. **One workspace, ten tabs.** Keys 1 to 9 and 0: Home, Chat & Intent, Workflows, Studio, VoxVision, 3D & Motion, Control
   Room, Fleet & Clef, Tools & MCP, Logs & Receipts. Each tab has a numbered actions bar with one amber next step; the
   browser companion (`c`) shows the same tabs, actions and log. `./review.sh check` prints the same frame in words.
2. **Connections, honestly.** A connection is green and "live" only when a free request it answered was seen in the last
   30 minutes; a setting alone is "configured"; Studio or the companion not started is "not running", with the key that
   starts it; an optional service nobody chose is "not set up", with its step.
3. **Chat and its price.** `/model` (in the REPL) shows the model's price, context and tool calling from OpenRouter's catalog
   with its date; `/model free` lists the free ones; `/model free-only on` refuses any model not known to be free, on every
   surface, with its cause (an unknown price is refused, never passed). Off by default.
4. **One sandbox workflow to its receipt (no spend).** In the tray project: Workflows → APPROVAL.md › tidy → its confirm → the
   NEEDS YOU box → `y`. The prediction is sealed before the run and never shown as an observed result; then the same
   operation in the Control Room, Logs & Receipts, `./review.sh timmy op <id>`, and the companion's run detail.
5. **Studio (`s`).** Timmy's canvas edits arrive as drafts outlined in amber ("DRAFT · proposed by Timmy"): Accept keeps them,
   Discard removes them, and neither runs a tool or a job. The save line says saved, saving, not saved yet, failed (Retry),
   refused, or that a newer version is on disk (Reload it, or Keep a copy); it never saves over a newer version. New board
   lists three guided blank templates first.
6. **Settings that follow you.** "Open the companion / Studio when the workspace starts" (Quick settings `,` in the
   Workbench, or the companion's settings): one file, checked against the workspace's revision, with a "changed elsewhere"
   path when two surfaces disagree.

## What is simulated, and what needs you

- **Simulated:** the FAKE lanes above; the fleet's FAKE backend and Cloudroom's FAKE Core (every line says so); a model in a
  rehearsal, when one ran (the notes say FAKE).
- **Off by default:** Clef routing (uncalibrated thresholds); free-only chat; Cloudflare (optional, not the chat provider).
- **Needs a key, a licence or a device:** a real model (your Ollama or your OpenRouter key); a Cloudroom Core; Blender,
  FreeCAD, After Effects, Unreal and the other native tools (each tab says what it needs); tldraw's licence for production use.

## What a terminal shows instead of a picture

A terminal draws text. Where the references show a live 3D, canvas or browser preview, the Workbench draws what is there in
words (the board, the files, the last run, its state) and `c` or `s` opens it rendered in your browser. Colors are the
terminal's 16 slots as the Timmy Homebrew profile sets them; every state also carries its word and glyph.

## Stop

Ctrl+C in the Workbench quits it; the companion and Studio it started stop with it. A run still going on keeps its record,
and the Control Room (7) shows it with Stop next time. `./review.sh clean` removes the sandbox, after you type yes.
