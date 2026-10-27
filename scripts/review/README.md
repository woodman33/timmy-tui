# Timmy review package · __REV__

**Open the Timmy app:** double-click **`Timmy App.command`** (macOS), or run **`./timmy-app`** in this folder once it is
unpacked. The app opens in your browser: Chat, Models & accounts, the licensed Canvas with Timmy's Rive components, and the
**APPS** rail (Card Lab, Film Room, Model Studio, Stream Studio) with Timmy Animate under CREATE. Its first run checks the
files against `SHA256SUMS`, installs the packed Timmy into `./sandbox` with `npm ci` from the package's lock, builds the
owners' apps inside the package and seeds the demo projects; later runs skip what is done and say so.

```bash
shasum -a 256 -c timmy-review-__REV__.tar.gz.sha256      # Linux: sha256sum -c
tar -xzf timmy-review-__REV__.tar.gz
cd timmy-review-__REV__
./timmy-app                 # or double-click "Timmy App.command"; the first run installs (a few minutes: npm, the apps' builds)
```

- **Stop:** press **q** (or Ctrl+C) in the app's Terminal window. That stops the companion and every app it hosted for this
  run (each app's own stop path ends its native jobs). Closing the browser tab alone leaves it running. `./timmy-app` opens
  it again on the same sandbox and the same projects.
- **The apps:** each opens inside Timmy's page and keeps its work in the project's own folder, separate for each person
  signed in. Their own ports answer only Timmy. Paid model calls stay held: no provider key or paid switch reaches an app.
  Card Lab's vision stage runs only on a model on this computer (`CARDLAB_VISION_ENDPOINT` naming a loopback endpoint, such
  as a local Ollama's `http://127.0.0.1:11434/v1/chat/completions`, and `CARDLAB_VISION_MODEL` a local model); otherwise it
  is held and says so. Stream Studio has no owner and is not built: its page says so.
- **tldraw licence:** the key is never in this package. Set `TLDRAW_LICENSE_KEY`, or `TLDRAW_LICENSE_FILE` to a file with a
  `TLDRAW_LICENSE_KEY=…` line, or write that file's path on the one line of `tldraw-license.path` beside this README; it is
  read into the app's environment and never printed.
- **Treg (Tools & integrations):** the review never reads your home's Treg sign-in on its own. Set `TREG_CONFIG` to the
  absolute path of the file `treg login` wrote, or write that path on the one line of `treg-config.path` beside this README.
  Timmy's own bridge reads it for each request; its token never reaches a page, record or receipt. Catalog lookups and the
  balance are free; a paid call runs only after you approve its quoted price, once, without retry.
- **The terminal is still here:** `./timmy-review` opens the terminal Workbench on the active project (the same sandbox);
  `./review.sh repl` the REPL; `./review.sh timmy video …` and `./review.sh timmy animate …` drive Film Room and Timmy
  Animate from the terminal through the same host, each job receipted. `timmy` alone is your installed timmy, not this
  candidate: nothing here runs or changes it.
- **Which revision:** `./timmy-review --version` prints the candidate's version and revision and opens nothing;
  `./timmy-review about` adds what the installed build says of itself (its `timmy --version`, which names its revision)
  and where your own timmy is.
- **Node:** it finds a Node 24 or later by itself and says which one it uses: `TIMMY_NODE` when you set it, else the first
  Node 24 or later on your PATH (an older one first on PATH is passed over, and named), else `/opt/homebrew/bin/node` or
  `/usr/local/bin/node`, else the newest under `~/.nvm/versions/node`. With none, it says so in one line and stops.

The packed Timmy of one exact revision, the launchers that run it in a sandbox beside them, and (when this package carries
them) the notes and captures of a scripted rehearsal. Nothing is installed globally, nothing is published, and no model key
is read from your shell. This package is for your own review: implementation status is reported here; visual and usability
acceptance are yours.

## Exact revision

| | |
|---|---|
| Revision | `__REV__`, branch `__BRANCH__` (its draft PR #109 targets `r12/rive-tldraw-app`) |
| Package | `__TGZ__`; its sha256 and every other file's are in `SHA256SUMS` |
| Checks | in `REHEARSAL.md` when this package carries one: the full suite, the type checks, the packed-install check and the privacy scan of this revision, each with its counts, and what a script did with this package |
| Not in this package | merge, publish, tags, deployment (all on HOLD); any live fleet, paid model call or new account |

## The terminal, step by step (Linux or macOS; Node 24 or later and npm; python3 for workflow runs, with OpenCV for VoxVision; tmux for `watch`)

The app (above) is the review's entry point. The terminal surfaces stay available: `./timmy-review` does the first three of
these steps itself, then opens the Workbench; they also run one by one, as before:

```bash
./review.sh install      # npm installs the packed Timmy and its dependencies into ./sandbox/prefix (--ignore-scripts)
./review.sh demo         # a new Timmy home with three projects: first-light (from the setup), blank, then tray (active)
./review.sh check        # the shared workspace in words, after one free request to each service
./review.sh workbench    # the terminal Workbench: the main space (what ./timmy-review opens)
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
- **Time zone:** when your shell sets `TZ`, the launcher passes it on (it passes nothing else it does not list), so the
  terminals and the pages say times in that zone; without it, the computer's own zone.
- **upmd** (workflows) is bundled for Linux x86_64 only when `bin/upmd` is here (MIT; licence in `bin/upmd-LICENSE.txt`).
  Elsewhere Timmy uses your own `upmd`, or says how to install it.
- **FAKE:** every lane program (`fake-lanes/`: opencode, hermes, pi, openhands, jcode, minds) is a stand-in that notes its
  call in `sandbox/fake-lanes.log` and waits, so no real lane starts.

## A short walkthrough of the terminal Workbench (about 15 minutes; a terminal of at least 160×45)

1. **Install and set chat.** `./timmy-review` once (it installs, seeds the demo and opens the Workbench; Ctrl+C quits it),
   then `./review.sh ollama 127.0.0.1:11434 <a model your Ollama lists>` (local, no charge), then `./timmy-review` again.
2. **The ten tabs.** Press 1 to 9 and 0; `?` lists the keys (↑ ↓, PgUp PgDn and Home End scroll it). Each tab has an
   actions bar. Its amber step is the one next step: always on 1 Home, 2 Chat & Intent, 4 Studio and 5 VoxVision; on 3
   Workflows (run the selected block, answer what waits, or Stop current while a job runs) and 7 Control Room (decide what
   waits, or Stop current while a job runs) when there is one; never on 6, 8, 9 and 0. Tabs 6, 7, 8 and 0 are marked
   unfinished (◌ on the tab; a dashed edge in the companion and Studio), and each opens with what works on it now and what
   it does not do yet.
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
   Preview leads with the newest images the project's records hold, each shown at size when you click it: the newest
   run that has an image (right after the demo, the report run's `out/preview.png`) and the newest VoxVision record's
   annotated copy of the example image. Each names its run or record and says what ran after it: after step 3's run,
   which writes no image, the report run's image stays, with "1 newer run holds none". Tab 5 draws the record, the image
   at its own aspect with its labels outside it, never over it; tab 3's run detail opens the newest run, and choosing the
   report run in its list of runs draws that run's image; tab 6 draws the demo's mesh in a view you can turn (item 6
   below); tab 9 lists and calls the FAKE fixture server.
6. **A REPL turn, stopped from the page.** In a second terminal, `./review.sh repl`, send the same counting request; on the
   companion page press Stop the turn. The REPL's turn stops there ("Stopped, asked from the companion.", then its
   receipt), and the Workbench's Chat log and the page say "turn stopped (asked from the companion) in the REPL", as its
   receipt records.
7. **Studio.** In the REPL, `/canvas open`, then `Put the intent and the prediction on the board.`; answer `y` in its NEEDS
   YOU box. While the draft waits, Studio's one amber step is "Accept or discard the draft Timmy proposed" (every surface
   names the same step and counts the draft as one thing waiting on you); Go to the draft brings the draft into view and
   puts the focus on its Accept, the amber control (Discard is neutral). Accept: the count drops at once and the save line
   says saved. In Studio's side panel, Artifacts → Place on the board puts the demo's VoxVision record on
   the board as a card that shows its image. Nodes → Add node puts one of the project's own cards on the board (a
   parameter card: change a value and Save; its answer names the file, the kept previous version and the edit receipt);
   select two nodes and Connect. `/canvas open` again reopens the saved board. The companion's tab 4 lists what the
   board holds.
8. **Project switching.** `p` in the Workbench → blank → Enter: the companion page follows, and Studio covers its board
   from the moment the switch is chosen ("switching to blank…", and why: tray's board, drafts and canvas jobs are saved
   and put away; the board takes no edit, and Accept and Discard wait), then shows blank's own board, drafts and canvas
   jobs. The REPL follows within about a second and says so ("Now
   in blank: the active project changed (chosen in the Workbench), and this REPL follows it"). A REPL answering a turn
   finishes it where it started and follows after ("this REPL follows blank once this turn ends; the turn finishes in
   tray"); jobs, runs and receipts keep the project they started in. `p` → tray: tray's board and its waiting draft come
   back, and the REPL that opened the canvas still holds it, so what it draws next arrives with no second `/canvas open`.
9. **A long run, stopped.** `./review.sh shell` opens a shell in the active project's folder (tray); there, make the
   rehearsal's long block, then `exit`:

   ````bash
   printf '# Long\n\n```bash [name:wait]\nfor i in 1 2 3 4 5; do echo "tick $i"; sleep 5; done\n```\n' > LONG.md
   ````

   Then run LONG.md › wait from 3, open 7, and press `x`: it is cancelled at once, with its receipt.
10. **Quit.** Ctrl+C in the Workbench with nothing running: it quits (exit 0), and the companion and Studio it started
    stop. `./review.sh clean` removes the sandbox when you are done.

## What you can test today (the Workbench's keys: `?`)

1. **One workspace, ten tabs.** Keys 1 to 9 and 0: Home, Chat & Intent, Workflows, Studio, VoxVision, 3D & Motion,
   Control Room, Fleet & Clef, Tools & MCP, Logs & Receipts, each with a numbered actions bar (which tabs mark a next
   step: step 2 above). The browser companion (`c`) shows the same tabs, actions and log, and `./review.sh check` prints
   the same frame in words, with the chat turns (how each ended and who asked, its model, receipt and time). Tabs 3, 5,
   7, 8, 9 and 0 draw their own columns across the whole width; there, Context (Tools, Inspector, Files) is the `i`
   drawer. The Control Room (7) draws up to four runs as a 2×2 grid of panes at 160 columns and wider (stacked below
   that); its panes read their logs once a second and say so, and the companion's tab 7 shows the same panes, read-only
   (a pane with a run opens its run detail). `p` switches the project: the choice is the shared active
   project, which `./review.sh check` then names (a companion page follows it unless you pin the page; Studio and a REPL
   at a terminal follow it, and what a REPL is running finishes where it started: step 8 above). `/` finds a workspace,
   such as Files; Enter on a file shows it in the Inspector, and `/open <file>` in the REPL shows its content.
2. **Connections, honestly.** Ollama and OpenRouter are green and "live" only when a free request they answered was seen
   in the last 30 minutes; the companion and Studio only when one answered within the last 60 s, by a process that still
   runs (just started, a server is "listening"; one whose process ended is "not running" at once). While a companion page
   cannot read its frame, its companion card says "✕ unreachable" and no card on it stays green. A setting alone is
   "configured"; Studio or the companion not started is "not running", with the key that starts it; an optional service
   nobody chose is "not set up", with its step; so is an Ollama that answers but holds no model Timmy can use, with the
   step to pull a local one. Ollama's "needs setup" follows its HTTP route at the address the chat asks, not an `ollama`
   program on the PATH. Each MCP-to-CLI route card says what the project's newest call through that route
   did ("a call through it answered …"; live while it is recent), and "? unknown" until a call is recorded.
3. **Chat, one conversation.** With a route, Chat & Intent (2) → Enter → type → Enter sends; the REPL continues the same
   conversation, one turn at a time (a message sent while another surface's turn runs is not sent yet: it stays in the
   composer, which says so, and Enter sends it once RUNNING NOW is 0). `/model`
   in the REPL: on OpenRouter, the model's price, context and tool calling from OpenRouter's catalog with its date; on a
   local Ollama, the models it has. `/model free` lists the catalog's free models; `/model free-only on` refuses any
   OpenRouter model not known to be free, on every surface (an unknown price is refused); it is off by default. When chat
   cannot answer, Home and Chat name the one fix for that problem (no route, no local model chosen, an Ollama address Timmy
   does not use, Ollama not answering, an Ollama with no model Timmy can use, a model free-only refuses, a key OpenRouter
   refused), and Enter on it does it where the Workbench can. A turn being answered shows as running on every surface. It
   stops from where it was sent (Esc in the Workbench's composer, Ctrl+C in the REPL), from the companion page (Stop the
   turn, or Stop this turn beside the running turn), or from the Workbench for a turn the REPL is answering (`x`, then `y`
   in the box that names the REPL; Enter on Stop the turn stops nothing and says where it is done). Its receipt records the
   stop and who asked, and the surfaces say it alike ("turn stopped (asked from the companion) in the REPL"; the REPL
   itself: "Stopped, asked from the companion."). Every surface lists the project's sealed turns, whichever surface sent
   them (a receipt keeps hashes, so a turn's words stay where it was sent).
4. **One workflow to its receipt (no spend).** In tray: Workflows → APPROVAL.md › tidy → its confirm → the NEEDS YOU box
   → `y`. The prediction is sealed before the run and never shown as an observed result. The same operation is in the
   Control Room, Logs & Receipts, `./review.sh timmy op <id>`, and the companion's run detail (its Workflows tab: a run
   in its list of runs, or the run's id in its Operation id box; the page's address then reads `/run/<op>`, but that
   address typed by hand opens a page without the companion's token, which can read nothing: it says why, and names the
   Workbench's `c` on the run, `timmy watch`'s `q` on HOME and the page's own Operation id box, each of which opens it with
   the token): the run's source as it ran (both hashes and a diff when
   the document changed since), the files it changed or wrote (a line diff against the version Timmy kept, `+` green and
   `−` red; an image drawn; JSON laid out; a binary's size and sha256), its log and outputs, and its receipts, intent →
   predict → run → receipt, each ✓ only where Timmy's verifier verified it now. A file a block wrote with no earlier
   version kept has no line diff and no Restore, and the page says why. The Workbench's tab 3 says the same in words
   (SOURCE, CHANGES, the receipt card).
5. **VoxVision (5).** The companion draws a record: its observed image, at its own aspect and the larger share of the
   panel, with what was measured over it (QR and ArUco corners, a colour region's box and centroid, a model's boxes), each
   labelled with its provenance and evidence on a band outside the image (below or beside it, tied to its mark by a
   line), never over its content; its
   entity tree (choose an entity and it is highlighted); a video's frames on a timeline; an STL mesh's front, top and side
   views; the pipeline as it ran, naming what this computer does not have (SAM 3 and Depth Anything 3 not installed, no
   operator verdict or learning queue); and its receipt, green only when it verifies now. The demo's record is OpenCV's
   reading of the example image: a colour region with its box and centroid, no QR code or ArUco marker found. The
   Workbench's tab 5 says the same record in words, and `/vox view <id>` opens Rerun's own viewer where Rerun is installed.
6. **3D & Motion (6), unfinished.** The companion's tab 6 lists the project's meshes (STL, OBJ and PLY files) with what
   Timmy's own reader for each kind measured from the whole file (triangles, bounding box, topology, volume, and DOCTRINE
   §15's sentence on what that cannot establish) and draws the chosen one in a view you can turn: drag, the wheel or
   `+`/`−`, `F`, `T`, `S` and `I` for front, top, side and isometric, `R` to start again. It is Timmy's own drawing of the
   file's triangles, not a render by Blender or any native tool, and it says so; above its cap it draws an even pick of the
   triangles and says "showing N of M". A PLY file with no faces (a point cloud), a big-endian PLY, or an OBJ or PLY it
   cannot read is listed as not measured, with why. The demo puts one generated tray in tray three times
   (`refs/demo-tray.stl`, `.obj` and `.ply`, made by a script from the same triangles and labelled generated): the three
   measure the same. Recordings (`.rrd`) are listed with their header facts and, where the Rerun CLI is installed
   (`rerun`; rerun-cli 0.38.1 is the version read, another is refused, said so), what it read of their entities,
   timelines and time ranges (`rrd verify`, `rrd stats` and `rrd print`, each bounded to 10 s); without it, each of those
   is unknown and the tab says why. The demo adds one generated recording (`refs/demo-tray.rrd`). The Workbench's tab 6
   lists the same meshes and recordings as items: it opens on the first mesh, `j`/`k` move, Enter shows the item whole in
   Context, and `c` opens the companion's view on the selected mesh. A recording's reading reaches the Workbench once the
   companion has listed tab 6. Not in this build: a native tool's render, a motion timeline, scene editing, and a
   recording's frames drawn or replayed.
7. **Tools & MCP (9).** The companion lists servers and their tools with each tool's input schema; makes a request form
   from the schema and checks the request against it before anything is sent; shows the exact JSON-RPC request and the
   command lines that make the same call (the REPL's `/mcp call`, MCPorter's, the MCP SDK's); and calls through both
   MCP-to-CLI routes (the MCP SDK and MCPorter), with the answer, the JSON-RPC requests as Timmy's wire tap measured them,
   and the call's record and receipt, verified now. Calls made on the page run only on Timmy's FAKE fixture server (every
   tool says FAKE; offered with no setup), and only for a tool its own list calls read-only and closed-world. Any other
   call, and any command line typed on the page, answers NEEDS YOU with the exact line to run in Timmy's terminal. The
   Workbench's tab 9 lists the calls, the page's among them, each with its wire trace in text.
8. **Studio (`s`).** Each project has its own board, drafts and canvas jobs (in `<Timmy home>/canvas/projects/<project
   id>/`). In the REPL, `/canvas open` gives that REPL the canvas and names the page to open. Ask Timmy to draw: its
   canvas tool asks in a NEEDS YOU box first, and what it draws arrives as a draft outlined in silver, the color of what
   a model made ("DRAFT · proposed by Timmy"): Accept (amber) keeps it, Discard removes it, and neither runs a tool or a
   job. What Timmy places on the board itself (a card, an image, a node) never covers a shape already there. A model's
   draft is drawn where the model put it: when it lands on shapes already on the board, its card and its label on the
   board say so, with how many, and the card has one button, Move it to free space (nothing moves by itself; the move is
   one undo step, the draft stays a draft, and its words then say from where it was moved). Below
   1100 px wide the side panel's lists fold behind a control at its foot and tldraw's style panel shows only while there
   is something to style, so the board keeps the larger share of a small window. The save line says saved, saving,
   not saved yet, failed (Retry), refused, or that a newer version is on disk (Reload it, or Keep a copy); it never
   saves over a newer version. A page's grant is one-time, so a browser reload loads nothing and says so: `/canvas open`
   again reopens the saved board. New board lists three guided blank templates first. The side panel lists the project's
   artifacts (its VoxVision records, runs and receipts) and its images: "Place on the board" puts an artifact on the
   board as a card that shows it (a record's image with what was measured over it, a run's outputs and receipts, a
   receipt's state, ✓ only when it verifies now), with one button that opens it: Open preview (a record) or Open run
   detail (a run), both in Studio's side panel, or Open receipt page (a receipt). Placing a card opens nothing by
   itself. "Add to the board" copies one of the project's images into the board's own folder and shows it, captioned
   with its file name and where it came from. Either shows only on its own project's board. The Nodes palette lists the
   project's own cards by the node each makes (parameters, workflows, results, and an operation's cards in the order
   they ran, linked by arrows) and adds one bound to the project; a parameter node saves through the same path as the
   REPL's (the rules, the previous version kept, an edit receipt) and is refused in the REPL's words while a flow runs
   in the project. Connect draws an arrow from the first selected node to the second: data flows only along an
   operation's own links; any other arrow, drawn there or by hand, is labelled "link only · no data flows" (a person's
   own words on an arrow are kept). The companion's tab 4 lists what the shown project's board holds (artifacts,
   reference images, cards, notes), each image shown at size and each opening its record, run or receipt. While Studio
   switches projects (step 8 above), a call of Timmy's already drawing finishes on its own project's board; anything
   that comes back for the other project afterwards is not drawn, and the side panel's "Kept apart" list says so. A
   Timmy home from before this build, with one canvas for all its projects, gives that canvas once to the project it
   belonged to (the active project, else the one project its cards name; `<Timmy home>/canvas/legacy-adopted.json` says
   what went where); its old files are left as they were.
9. **Settings that follow you.** "Open the companion / Studio when the workspace starts" (Quick settings `,` in the
   Workbench, or the companion's settings): one file, checked against the workspace's revision, with a "changed elsewhere"
   path when two surfaces disagree.
10. **Stop, quit, reconnect.** `x` stops the selected run at once and its record says so. Each kind keeps one word on
   every surface: a job a stop cut off is "cancelled" (`timmy op`'s header, verdict, checks and next lines, the REPL's
   `/jobs`, Studio's Artifacts list, the Workbench's tab 0), and a chat turn "stopped", with who asked ("stopped (asked
   from the companion)"); a receipt keeps the words it was sealed with. Ctrl+C quits the Workbench, and the
   companion and Studio it started stop with it (Stop, below). A companion page left open says it is reconnecting, then
   that it needs its token after the Workbench starts again (each start makes a new one); `c` opens a connected page. An
   answer older than 30 minutes is said with its age ("answered 45 min ago … check again to see it now"), never live; a
   newer chat turn that answered is weighed over an older check that saw no answer.

## What is simulated, and what needs you

- **Simulated:** the FAKE lanes above; the fleet's FAKE backend and Cloudroom's FAKE Core (every line says so); the Tools &
  MCP FAKE fixture server (every tool says FAKE); a model in a rehearsal, when one ran (the notes say FAKE). The demo's
  content in tray is scripted for the review; what it measured and ran is real (OpenCV on the example image, upmd running
  the report block).
- **Off by default:** decision-model routing (saved as `useClef`; its thresholds uncalibrated); free-only chat; Cloudflare
  (optional, not the chat provider).
- **Seeing a decision answered:** A decision binds to its project's git revision, and the demo's tray is not a git
  repository, so in tray every decision falls back before anything is sent, and says why. Decide in a git project with a
  commit: a project of your own, or tray after `git init` and a commit inside `./review.sh shell`. Declare the decision
  model in the review's own Timmy home (`decision/clef.json`; `./review.sh where` names the folder, and
  `timmy decide --help` says its fields, pricing among them), and turn routing on for one process:
  `TIMMY_CLEF=1 ./review.sh timmy decide …`. Point it only at a FAKE of your own or a model you run yourself. Of your
  shell's settings, TIMMY_CLEF and TIMMY_RERUN reach Timmy when you set them, as do TIMMY_CHAT_FREE_ONLY, TIMMY_PALETTE
  and TZ; nothing else does.
- **Needs a key, a licence, a program or a device:** a real model (your Ollama or your OpenRouter key); a Cloudroom Core;
  OpenCV for VoxVision's Look (python3 with `cv2` and `numpy`); Rerun for `/vox view`; Blender, FreeCAD, After Effects,
  Unreal and the other native tools (each tab says what it needs); tldraw's licence for production use. SAM 3 and Depth
  Anything 3 are not installed, and tab 5 says so.

## What a terminal shows instead of a picture

A terminal draws text. Where the references show an image, a 3D view, a canvas or a browser preview, the Workbench says
what is there in words (the board, the files, the run, the record, its state), and `c` or `s` shows it drawn in your
browser: the companion draws Home's newest images, a run's images and diffs, VoxVision's images with what was measured over
them and a mesh's views, tab 6's mesh in a view you can turn (Timmy's own drawing of an STL, OBJ or PLY file's
triangles), and Tools &
MCP's calls; Studio draws the canvas. No surface draws a scene with materials, depth or voxels, or replays a run.

Every state carries its word and glyph as well as its color. The Workbench writes the system's own colors exactly
(#F2EFE9 text, #8E8E93 secondary text, #FFB000 amber) when the terminal says it draws 24-bit color (`COLORTERM=truecolor`
or `24bit`, which the launcher passes through). Otherwise, when it knows your terminal uses the Timmy Homebrew profile
(`TIMMY_PALETTE=homebrew`, which the launcher passes through too, or the terminal's own answer to its color question
matching the profile), it colors by the profile's 16 slots, as the REPL and the monitor (`watch`) do: text in your
terminal's own foreground, secondary text slot 8, amber slot 3, green slot 2, with structure and the selection in the 256
colors' greys. Any other terminal gets the nearest of the 256 colors by perceived difference (#F2EFE9 → 255, #8E8E93 →
245, #FFB000 → 214). The REPL colors a role only when your terminal answered its color question, so inside tmux (which may
not answer) it can draw without color: `TIMMY_PALETTE=homebrew ./review.sh repl` says the Timmy Homebrew profile is
installed.

## Stop

- **The Timmy app:** q (or Ctrl+C) in its Terminal window stops the companion and every owner's app it hosted for this run;
  each app's own stop path ends its native jobs (a Blender or ffmpeg job still running is stopped with it, and its record and
  receipt say so). `./review.sh census` (below) then lists nothing of this sandbox.
- **A `timmy video` or `timmy animate` job:** Ctrl+C asks the app to cancel the job; its outcome is sealed as the app reports
  it (cancelled, or the end it had already reached).
- **The Workbench:** Ctrl+C quits it, and the companion and Studio it started stop with it. When a job it started is
  still running, Ctrl+C asks first ("Quit the Workbench? 1 job this Workbench started will stop with it"): Ctrl+C again
  quits and cancels that job (the Workbench says it "was cancelled as the Workbench ended", and its record says
  cancelled), Esc stays. A job another session started keeps running: the box lists it when the box opens; when only
  such jobs run, no box opens, and the Workbench quits at once (exit 0), saying it stopped nothing ("The Workbench quit at
  once: no job it started was running, so it stopped nothing and asked nothing.") and naming each one ("… keeps running:
  started by another Timmy session (pid …), which is still running"). The exit code says whether the quit cut anything
  short: 0 when it stopped nothing, 130 when it stopped a job or a chat turn this Workbench started. To stop a run and
  stay: `x` (a chat turn: Esc in its composer; a turn the REPL is answering: `x`, then `y`).
- **The REPL:** `/exit`, or Ctrl+C with no turn running (Ctrl+C during a turn stops the turn).
- **A chat turn, from anywhere:** the companion page's Stop the turn (or Stop this turn beside it) stops the turn being
  answered in the Workbench or the REPL; what its tools had already done stays done (nothing is rolled back), and its
  receipt says it was stopped and who asked. A job (a workflow run) stops only from the Workbench or REPL that started it
  (`x`, `/stop <job>`); the page shows it running and has no Stop for it (not in this build).
- **A browser page:** close it; nothing runs in the page itself.
- **Everything:** close the windows above, then `./review.sh clean` removes the sandbox, after you type yes. Nothing outside
  this folder was installed or started.
- **What is still running:** `./review.sh census` lists every process whose command line names the sandbox or whose working
  folder is inside it (itself and the shell it runs under are not counted), each with its parent; once every Timmy window
  here has quit, it says none runs (exit 0). The Workbench leaves none when it quits (tested on Linux; on macOS the census
  asks `ps` and `lsof`, which this package's tests did not run).
