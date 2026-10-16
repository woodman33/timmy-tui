# Timmy review package · __REV__

The packed Timmy of one exact revision, a launcher that runs it in a sandbox beside itself, and (when this package carries
them) the notes and captures of a scripted rehearsal. Nothing is installed globally, nothing is published, and no model key
is read from your shell. This package is for your own review: implementation status is reported here; visual and usability
acceptance are yours.

## Exact revision

| | |
|---|---|
| Revision | `__REV__`, branch `r6/review-build` (its draft PR targets `feat/ui-workflow-r1`) |
| Package | `__TGZ__`; its sha256 and every other file's are in `SHA256SUMS` |
| Checks | in `REHEARSAL.md` when this package carries one: the full suite, the type checks, the packed-install check and the privacy scan of this revision, each with its counts, and what a script did with this package |
| Not in this package | merge, publish, tags, deployment (all on HOLD); any live fleet, paid model call or new account |

## Launch (Linux or macOS; Node 24 or later and npm; python3 for workflow runs, with OpenCV for VoxVision; tmux for `watch`)

```bash
shasum -a 256 -c timmy-review-__REV__.tar.gz.sha256      # Linux: sha256sum -c
tar -xzf timmy-review-__REV__.tar.gz
cd timmy-review-__REV__
./review.sh install      # npm installs the packed Timmy and its dependencies into ./sandbox/prefix (--ignore-scripts)
./review.sh demo         # a new Timmy home with three projects: first-light (from the setup), blank, then tray (active)
./review.sh check        # the shared workspace in words, after one free request to each service
./review.sh workbench    # the terminal Workbench: the main space
```

Then, in other terminal windows: `./review.sh repl` (the REPL), `./review.sh watch` (the monitor), `./review.sh timmy <args>`
(any command), `./review.sh shell` (a shell with `timmy` on its PATH), `./review.sh where` (folders and ports),
`./review.sh clean` (removes ./sandbox only, after you type yes).

- **Type `./review.sh timmy …` here.** Screens and setup lines name bare commands (`timmy doctor`, `timmy workspace check`,
  `timmy op <id>`). Beside this package there is no `timmy` on your PATH: type `./review.sh timmy doctor` and so on, or use
  them inside `./review.sh shell`.
- **The demo's content.** In tray, the demo also makes scripted review content, and says so as it makes it: the package's
  example image added as a reference and observed by VoxVision (OpenCV), and REPORT.md's `report` block run by upmd, which
  writes four files into `out/` and a 60-line log. Where python3 has no OpenCV (`cv2` and `numpy`), the observation is a
  sealed "needs setup" record: the demo says so and goes on.
- **Chat needs a route.** The demo's setup points chat at an Ollama at 127.0.0.1:11434, with no model chosen.
  `./review.sh ollama 127.0.0.1:11434 <a model your Ollama lists>` sets the address and the model (no key, no charge). Or,
  with your Ollama answering there, choose the model in the Workbench: Home's next step is "Choose the local model", and
  Enter on it lists what your Ollama has now. For OpenRouter, give the sandbox a key yourself:
  `./review.sh timmy init --chat openrouter` asks for it, typed hidden. The launcher runs Timmy with `env -i` and its own
  list, so no key in your shell reaches it.
- **Node:** `./review.sh install` records the node it ran on (in `sandbox/node.path`), and every later command runs Timmy on
  that node, whatever node a terminal or a tmux pane puts first on its PATH. `./review.sh where` names it, with the shell's
  own node beside it. If that node is gone, or older than Node 24, the launcher stops (exit 3) and says to install again.
- **Ports, 127.0.0.1 only:** Studio 4440, the log companion 4441, the browser companion 4442 (set `TIMMY_STUDIO_PORT`,
  `TIMMY_LOGS_PORT` or `TIMMY_COMPANION_PORT` before a command to change them). The Workbench names each address on screen
  when it serves that surface.
- **upmd** (workflows) is bundled for Linux x86_64 only when `bin/upmd` is here (MIT; licence in `bin/upmd-LICENSE.txt`).
  Elsewhere Timmy uses your own `upmd`, or says how to install it.
- **FAKE:** every lane program (`fake-lanes/`: opencode, hermes, pi, openhands, jcode, minds) is a stand-in that notes its
  call in `sandbox/fake-lanes.log` and waits, so no real lane starts.

## A short walkthrough (about 15 minutes; a terminal of at least 160×45)

1. **Install and set chat.** After the launch steps above: `./review.sh ollama 127.0.0.1:11434 <a model your Ollama lists>`
   (local, no charge), then `./review.sh workbench`.
2. **The ten tabs.** Press 1 to 9 and 0; `?` lists the keys (↑ ↓, PgUp PgDn and Home End scroll it). Each tab has an
   actions bar. Its amber step is the one next step: always on 1 Home, 2 Chat & Intent, 4 Studio and 5 VoxVision; on 3
   Workflows (run the selected block, answer what waits, or Stop current while a job runs) and 7 Control Room (decide what
   waits, or Stop current while a job runs) when there is one; never on 6, 8, 9 and 0.
3. **A workflow run to its receipt.** 3 (Workflows) → select APPROVAL.md › tidy → Enter → Enter → the NEEDS YOU box → `y`.
   The plan (.intent, .predict), where it ran and the sealed receipt fill the three columns. It runs on this computer, in
   the project folder, by upmd: no container or sandbox is recorded, and the run says so ("sandbox: none recorded; upmd ran
   it on this computer"). Tab 3 then says the run inspected: its source as it ran, the files it changed, its receipts.
   7 (Control Room) shows the run, and 0 (Logs & Receipts) shows the chain verified.
4. **A chat turn, stopped where it was sent.** 2 (Chat & Intent) → Enter → `Count from 1 to 200, one number per line.` →
   Enter; while it streams, Esc. The conversation says "■ stopped by you"; the log says "turn stopped (asked from the
   Workbench) in the Workbench", with its receipt.
5. **The browser companion.** `c` opens it on the same project and the same tab (from tab 5, on the record selected
   there): the same ten tabs, actions and log, and the pictures a terminal cannot draw. With the demo's tray: Home's
   Preview leads with the newest images (the report run's
   `out/preview.png` and the VoxVision record's annotated copy of the example image), each shown at size when you click it;
   tab 5 draws that record; tab 3's run detail draws the report run; tab 9 lists and calls the FAKE fixture server.
6. **A REPL turn, stopped from the page.** In a second terminal, `./review.sh repl`, send the same counting request; on the
   companion page press Stop the turn. The REPL's turn stops there ("Stopped, asked from the companion.", then its
   receipt), and the Workbench's Chat log and the page say "turn stopped (asked from the companion) in the REPL", as its
   receipt records.
7. **Studio.** In the REPL, `/canvas open`, then `Put the intent and the prediction on the board.`; answer `y` in its NEEDS
   YOU box; in Studio, Accept the amber draft: the save line says saved. While the draft waits, every surface counts it as
   one thing waiting on you. `/canvas open` again reopens the saved board.
8. **Project switching.** `p` in the Workbench → blank → Enter: the companion page follows, and Studio covers its board
   ("TIMMY · switching to blank…": tray's board, drafts and canvas jobs are saved and put away; editing, Accept and Discard
   wait), then shows blank's own board, drafts and canvas jobs. `p` → tray: tray's board and its waiting draft come back.
9. **A long run, stopped.** `./review.sh shell` opens a shell in the active project's folder (tray); there, make the
   rehearsal's long block, then `exit`:

   ````bash
   printf '# Long\n\n```bash [name:wait]\nfor i in 1 2 3 4 5; do echo "tick $i"; sleep 5; done\n```\n' > LONG.md
   ````

   Then run LONG.md › wait from 3, open 7, and press `x`: it is cancelled at once, with its receipt.
10. **Quit.** Ctrl+C in the Workbench with nothing running: it quits (exit 0), and the companion and Studio it started
    stop. `./review.sh clean` removes the sandbox when you are done.

## What you can test today (the Workbench's keys: `?`)

1. **One workspace, ten tabs.** Keys 1 to 9 and 0: Home, Chat & Intent, Workflows, Studio, VoxVision, 3D & Motion, Control
   Room, Fleet & Clef, Tools & MCP, Logs & Receipts, each with a numbered actions bar (which tabs mark a next step: step 2
   above). The browser companion (`c`) shows the same tabs, actions and log, and `./review.sh check` prints the same frame
   in words, with the chat turns (how each ended and who asked, its model, receipt and time). Tabs 3, 5, 7, 8, 9 and 0 draw
   their own columns across the whole width; there, Context (Tools, Inspector, Files) is the `i` drawer. The Control Room
   (7) draws up to four runs as a 2×2 grid of panes at 160 columns and wider (stacked below that); its panes read their logs
   once a second and say so. `p` switches the project: the choice is the shared active project, which `./review.sh check`
   then names (a companion page follows it unless you pin the page). `/` finds a workspace, such as Files; Enter on a file
   shows it in the Inspector, and `/open <file>` in the REPL shows its content.
2. **Connections, honestly.** Ollama and OpenRouter are green and "live" only when a free request they answered was seen
   in the last 30 minutes; the companion and Studio only when one answered within the last 60 s, by a process that still
   runs (just started, a server is "listening"; one whose process ended is "not running" at once). While a companion page
   cannot read its frame, its companion card says "✕ unreachable" and no card on it stays green. A setting alone is
   "configured"; Studio or the companion not started is "not running", with the key that starts it; an optional service
   nobody chose is "not set up", with its step. Ollama's "needs setup" follows its HTTP route at the address the chat asks,
   not an `ollama` program on the PATH. The two MCP-to-CLI route cards say "? unknown" even after calls through them; tab 9
   lists those calls.
3. **Chat, one conversation.** With a route, Chat & Intent (2) → Enter → type → Enter sends; the REPL continues the same
   conversation, one turn at a time (a message sent while another surface's turn runs is not sent, and says so). `/model`
   in the REPL: on OpenRouter, the model's price, context and tool calling from OpenRouter's catalog with its date; on a
   local Ollama, the models it has. `/model free` lists the catalog's free models; `/model free-only on` refuses any
   OpenRouter model not known to be free, on every surface (an unknown price is refused); it is off by default. When chat
   cannot answer, Home and Chat name the one fix for that problem (no route, no local model chosen, an Ollama address Timmy
   does not use, Ollama not answering, a model free-only refuses, a key OpenRouter refused), and Enter on it does it where
   the Workbench can. A turn being answered shows as running on every surface. It stops from where it was sent (Esc in the
   Workbench's composer, Ctrl+C in the REPL), from the companion page (Stop the turn, or Stop this turn beside the running
   turn), or from the Workbench for a turn the REPL is answering (`x`, or Enter on Stop the turn). Its receipt records the
   stop and who asked, and the surfaces say it alike ("turn stopped (asked from the companion) in the REPL"; the REPL
   itself: "Stopped, asked from the companion."). Every surface lists the project's sealed turns, whichever surface sent
   them (a receipt keeps hashes, so a turn's words stay where it was sent).
4. **One workflow to its receipt (no spend).** In tray: Workflows → APPROVAL.md › tidy → its confirm → the NEEDS YOU box →
   `y`. The prediction is sealed before the run and never shown as an observed result. The same operation is in the
   Control Room, Logs & Receipts, `./review.sh timmy op <id>`, and the companion's run detail (its Workflows tab, or
   `/run/<op>` on the page): the run's source as it ran (both hashes and a diff when the document changed since), the files
   it changed or wrote (a line diff against the version Timmy kept, `+` green and `−` red; an image drawn; JSON laid out; a
   binary's size and sha256), its log and outputs, and its receipts, intent → predict → run → receipt, each ✓ only where
   Timmy's verifier verified it now. A file a block wrote with no earlier version kept has no line diff and no Restore, and
   the page says why. The Workbench's tab 3 says the same in words (SOURCE, CHANGES, the receipt card).
5. **VoxVision (5).** The companion draws a record: its observed image with what was measured over it (QR and ArUco
   corners, a colour region's box and centroid, a model's boxes), each labelled with its provenance and evidence; its
   entity tree (choose an entity and it is highlighted); a video's frames on a timeline; an STL mesh's front, top and side
   views; the pipeline as it ran, naming what this computer does not have (SAM 3 and Depth Anything 3 not installed, no
   operator verdict or learning queue); and its receipt, green only when it verifies now. The demo's record is OpenCV's
   reading of the example image: a colour region with its box and centroid, no QR code or ArUco marker found. The
   Workbench's tab 5 says the same record in words, and `/vox view <id>` opens Rerun's own viewer where Rerun is installed.
6. **Tools & MCP (9).** The companion lists servers and their tools with each tool's input schema; makes a request form
   from the schema and checks the request against it before anything is sent; shows the exact JSON-RPC request and the
   command lines that make the same call (the REPL's `/mcp call`, MCPorter's, the MCP SDK's); and calls through both
   MCP-to-CLI routes (the MCP SDK and MCPorter), with the answer, the JSON-RPC requests as Timmy's wire tap measured them,
   and the call's record and receipt, verified now. Calls made on the page run only on Timmy's FAKE fixture server (every
   tool says FAKE; offered with no setup), and only for a tool its own list calls read-only and closed-world. Any other
   call, and any command line typed on the page, answers NEEDS YOU with the exact line to run in Timmy's terminal. The
   Workbench's tab 9 lists the calls, the page's among them, each with its wire trace in text.
7. **Studio (`s`).** Each project has its own board, drafts and canvas jobs (in `<Timmy home>/canvas/projects/<project
   id>/`). In the REPL, `/canvas open` gives that REPL the canvas and names the page to open. Ask Timmy to draw: its canvas
   tool asks in a NEEDS YOU box first, and what it draws arrives as a draft outlined in amber ("DRAFT · proposed by Timmy"):
   Accept keeps it, Discard removes it, and neither runs a tool or a job. The save line says saved, saving, not saved yet,
   failed (Retry), refused, or that a newer version is on disk (Reload it, or Keep a copy); it never saves over a newer
   version. A page's grant is one-time, so a browser reload loads nothing and says so: `/canvas open` again reopens the
   saved board. New board lists three guided blank templates first. While Studio switches projects (step 8 above), a call
   of Timmy's already drawing finishes on its own project's board; anything that comes back for the other project
   afterwards is not drawn, and the side panel's "Kept apart" list says so. A Timmy home from before this build, with one
   canvas for all its projects, gives that canvas once to the project it belonged to (the active project, else the one
   project its cards name; `<Timmy home>/canvas/legacy-adopted.json` says what went where); its old files are left as they
   were.
8. **Settings that follow you.** "Open the companion / Studio when the workspace starts" (Quick settings `,` in the
   Workbench, or the companion's settings): one file, checked against the workspace's revision, with a "changed elsewhere"
   path when two surfaces disagree.
9. **Stop, quit, reconnect.** `x` stops the selected run at once and its record says so (a job "cancelled", a chat turn
   "stopped"). Ctrl+C quits the Workbench, and the companion and Studio it started stop with it (Stop, below). A companion
   page left open says it is reconnecting, then that it needs its token after the Workbench starts again (each start makes
   a new one); `c` opens a connected page. An answer older than 30 minutes is said with its age ("answered 45 min ago …
   check again to see it now"), never live; a newer chat turn that answered is weighed over an older check that saw no
   answer.

## What is simulated, and what needs you

- **Simulated:** the FAKE lanes above; the fleet's FAKE backend and Cloudroom's FAKE Core (every line says so); the Tools &
  MCP FAKE fixture server (every tool says FAKE); a model in a rehearsal, when one ran (the notes say FAKE). The demo's
  content in tray is scripted for the review; what it measured and ran is real (OpenCV on the example image, upmd running
  the report block).
- **Off by default:** Clef routing (uncalibrated thresholds); free-only chat; Cloudflare (optional, not the chat provider).
- **Needs a key, a licence, a program or a device:** a real model (your Ollama or your OpenRouter key); a Cloudroom Core;
  OpenCV for VoxVision's Look (python3 with `cv2` and `numpy`); Rerun for `/vox view`; Blender, FreeCAD, After Effects,
  Unreal and the other native tools (each tab says what it needs); tldraw's licence for production use. SAM 3 and Depth
  Anything 3 are not installed, and tab 5 says so.

## What a terminal shows instead of a picture

A terminal draws text. Where the references show an image, a 3D view, a canvas or a browser preview, the Workbench says
what is there in words (the board, the files, the run, the record, its state), and `c` or `s` shows it drawn in your
browser: the companion draws Home's newest images, a run's images and diffs, VoxVision's images with what was measured over
them and a mesh's views, and Tools & MCP's calls; Studio draws the canvas. No surface draws a 3D scene you can turn, depth
or voxels, or replays a run. The Workbench's Home and tab 6 still say that no Timmy surface draws images yet: that sentence
is older than the companion's previews in this build.

Colors are the terminal's 16 slots as the Timmy Homebrew profile sets them; every state also carries its word and glyph. The
REPL colors a role only when your terminal answered its color question, so inside tmux (which may not answer) it can draw
without color: `TIMMY_PALETTE=homebrew ./review.sh repl` says the Timmy Homebrew profile is installed (the launcher passes
that one setting through).

## Stop

- **The Workbench:** Ctrl+C quits it, and the companion and Studio it started stop with it. When a job it started is still
  running, Ctrl+C asks first ("Quit the Workbench? 1 job this Workbench started will stop with it"): Ctrl+C again quits and
  cancels that job (the Workbench says it "was cancelled as the Workbench ended", and its record says cancelled), Esc
  stays. A job another session started keeps running, and the box says so. The exit code says whether the quit cut
  anything short: 0 when it stopped nothing, 130 when it stopped a job or a chat turn this Workbench started. To stop a
  run and stay: `x` (a chat turn: Esc in its composer).
- **The REPL:** `/exit`, or Ctrl+C with no turn running (Ctrl+C during a turn stops the turn).
- **A chat turn, from anywhere:** the companion page's Stop the turn (or Stop this turn beside it) stops the turn being
  answered in the Workbench or the REPL; what its tools had already done stays done (nothing is rolled back), and its
  receipt says it was stopped and who asked. A job (a workflow run) stops only from the Workbench or REPL that started it
  (`x`, `/stop <job>`); the page shows it running and has no Stop for it (not in this build).
- **A browser page:** close it; nothing runs in the page itself.
- **Everything:** close the windows above, then `./review.sh clean` removes the sandbox, after you type yes. Nothing outside
  this folder was installed or started.
