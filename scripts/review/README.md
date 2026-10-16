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
  no charge). Or set only its address, `./review.sh timmy init --yes --chat local --ollama 127.0.0.1:11434`, and choose the
  model in the Workbench: Home's next step is then "Choose the local model", and Enter on it lists what your Ollama has
  now. For OpenRouter, give the sandbox a key yourself: `./review.sh timmy init` asks for it, hidden. The launcher runs
  Timmy with `env -i` and its own list, so no key in your shell reaches it.
- **Ports, 127.0.0.1 only:** Studio 4440, the log companion 4441, the browser companion 4442 (set `TIMMY_STUDIO_PORT`,
  `TIMMY_LOGS_PORT` or `TIMMY_COMPANION_PORT` before a command to change them). The Workbench prints each address when it
  starts that surface.
- **upmd** (workflows) is bundled for Linux x86_64 only when `bin/upmd` is here (MIT; licence in `bin/upmd-LICENSE.txt`).
  Elsewhere Timmy uses your own `upmd`, or says how to install it.
- **FAKE:** every lane program (`fake-lanes/`: opencode, hermes, pi, openhands, jcode, minds) is a stand-in that notes its
  call in `sandbox/fake-lanes.log` and waits, so no real lane starts.

## A short walkthrough (about 15 minutes; a terminal of at least 160×45)

1. **Install and set chat.** After the launch steps above: `./review.sh ollama 127.0.0.1:11434 <a model your Ollama lists>`
   (local, no charge), then `./review.sh workbench`.
2. **The ten tabs.** Press 1 to 9 and 0. Each tab has its actions bar with one amber next step; `?` lists the keys.
3. **A sandbox run to its receipt.** 3 (Workflows) → select APPROVAL.md › tidy → Enter → Enter → the NEEDS YOU box → `y`.
   The plan (.intent, .predict), the sandbox and the sealed receipt fill the three columns. Then 7 (Control Room) shows the
   run, and 0 (Logs & Receipts) shows the chain verified.
4. **A chat turn, stopped where it was sent.** 2 (Chat & Intent) → Enter → `Count from 1 to 200, one number per line.` →
   Enter; while it streams, Esc. It ends "turn stopped in the Workbench", with a receipt.
5. **The browser companion.** `c` opens it on the same project: the same ten tabs, actions and log.
6. **A REPL turn, stopped from the page.** In a second terminal, `./review.sh repl`, send the same counting request; on the
   companion page press Stop the turn. The REPL stops, and the REPL, the Workbench and the page all show "turn stopped
   (asked from the companion) in the REPL".
7. **Studio.** In the REPL, `/canvas open`, then `Put the intent and the prediction on the board.`; answer `y` in its NEEDS
   YOU box; in Studio, Accept the amber draft: the save line says saved. `/canvas open` again reopens the saved board.
8. **Project switching.** `p` in the Workbench → blank → Enter, then `p` → tray: the companion page and Studio follow.
9. **A long run, stopped.** `./review.sh shell` opens a shell in the active project's folder (tray); there, make the
   rehearsal's long block, then `exit`:

   ````bash
   printf '# Long\n\n```bash [name:wait]\nfor i in 1 2 3 4 5; do echo "tick $i"; sleep 5; done\n```\n' > LONG.md
   ````

   Then run LONG.md › wait from 3, open 7, and press `x`: it is cancelled at once, with its receipt.
10. **Quit.** Ctrl+C in the Workbench with nothing running: it quits, and the companion and Studio it started stop.
    `./review.sh clean` removes the sandbox when you are done.

## What you can test today (the Workbench's keys: `?`)

1. **One workspace, ten tabs.** Keys 1 to 9 and 0: Home, Chat & Intent, Workflows, Studio, VoxVision, 3D & Motion, Control
   Room, Fleet & Clef, Tools & MCP, Logs & Receipts. Each tab has a numbered actions bar with one amber next step; the
   browser companion (`c`) shows the same tabs, actions and log. `./review.sh check` prints the same frame in words.
   Tabs 3, 5, 7, 8, 9 and 0 draw their own columns across the whole width; there, Context (Tools, Inspector, Files) is
   the `i` drawer. The Control Room (7) draws up to four runs as a 2×2 grid of panes at 160 columns and wider (stacked
   below that); its panes read their logs once a second and say so. `p` switches the project: the choice is the shared
   active project, which `./review.sh check` then names (a companion page follows it unless you pin the page). `/` finds
   a workspace, such as Files; Enter on a file shows it in the Inspector, and `/open <file>` in the REPL shows its content.
2. **Connections, honestly.** A connection is green and "live" only when a free request it answered was seen in the last
   30 minutes; a setting alone is "configured"; Studio or the companion not started is "not running", with the key that
   starts it; an optional service nobody chose is "not set up", with its step.
3. **Chat, one conversation.** With a route (`./review.sh ollama …`, or your OpenRouter key), Chat & Intent (2) → Enter →
   type → Enter sends; the REPL (`./review.sh repl`) continues the same conversation, one turn at a time (a message sent
   while another surface's turn runs is not sent, and says so). `/model` in the REPL: on OpenRouter, the model's price,
   context and tool calling from OpenRouter's catalog with its date; on a local Ollama, the models it has. `/model free`
   lists the catalog's free models; `/model free-only on` refuses any OpenRouter model not known to be free, on every
   surface, with its cause (an unknown price is refused, never passed). Off by default; a local model costs nothing.
   When chat cannot answer, Home and Chat name the one fix for that problem, and Enter on it does it where the Workbench
   can: no route (`timmy init --chat openrouter`, in a shell, asks for a key, typed hidden; or a local model); no local
   model chosen (`/model`: what your Ollama has now; Enter chooses one); an Ollama address Timmy does not use
   (`/setup chat`); Ollama not answering (start it; Enter checks again, free requests only); free-only on and a model not
   known to be free (`/model free`: the catalog's free models; free-only stays on, turning it off is never the fix); a key
   OpenRouter refused (`timmy init --openrouter -` reads a new one, hidden). A turn being answered shows as running on
   every surface (the Workbench, the companion, `./review.sh check`). It stops from where it was sent (Esc in the
   Workbench's composer, Ctrl+C in the REPL) or from the companion page (its Stop the turn, and Stop this turn beside the
   running turn): the page asks the process answering it, which stops it as its own key would, whichever surface that is.
   Its receipt records the stop and who asked ("turn stopped (asked from the companion) in the REPL"), and every surface
   shows that end. Every surface lists the project's sealed turns, whichever surface sent them (a receipt keeps hashes, so
   a turn's words stay where it was sent). A reading of a connection counts only for what it asked: after the setup moves
   Ollama, the companion or Studio to another address, or a new OpenRouter key replaces a refused one, the card says "not
   checked at this address (with this key) yet" until a check asks again.
4. **One sandbox workflow to its receipt (no spend).** In the tray project: Workflows → APPROVAL.md › tidy → its confirm → the
   NEEDS YOU box → `y`. The prediction is sealed before the run and never shown as an observed result; then the same
   operation in the Control Room, Logs & Receipts, `./review.sh timmy op <id>`, and the companion's run detail.
5. **Studio (`s`).** In the REPL, `/canvas open` gives that REPL the canvas and names the page to open. Ask Timmy to draw:
   its canvas tool asks in a NEEDS YOU box first, and what it draws arrives as a draft outlined in amber ("DRAFT · proposed
   by Timmy"): Accept keeps it, Discard removes it, and neither runs a tool or a job. The save line says saved, saving, not
   saved yet, failed (Retry), refused, or that a newer version is on disk (Reload it, or Keep a copy); it never saves over
   a newer version. A page's grant is one-time, so a browser reload loads nothing and says so: `/canvas open` again
   reopens the saved board. New board lists three guided blank templates first.
6. **Settings that follow you.** "Open the companion / Studio when the workspace starts" (Quick settings `,` in the
   Workbench, or the companion's settings): one file, checked against the workspace's revision, with a "changed elsewhere"
   path when two surfaces disagree.
7. **Stop, quit, reconnect.** `x` stops the selected run at once and its record says so; Ctrl+C with nothing running
   quits the Workbench, and the companion and Studio it started stop with it. A companion page left open says it is
   reconnecting, then that it needs its token after the Workbench starts again (each start makes a new one); `c` opens a
   connected page. An answer older than 30 minutes is said with its age ("answered 45 min ago … check again to see it
   now"), never live; a newer chat turn that answered is weighed over an older check that saw no answer.

## What is simulated, and what needs you

- **Simulated:** the FAKE lanes above; the fleet's FAKE backend and Cloudroom's FAKE Core (every line says so); a model in a
  rehearsal, when one ran (the notes say FAKE).
- **Off by default:** Clef routing (uncalibrated thresholds); free-only chat; Cloudflare (optional, not the chat provider).
- **Needs a key, a licence or a device:** a real model (your Ollama or your OpenRouter key); a Cloudroom Core; Blender,
  FreeCAD, After Effects, Unreal and the other native tools (each tab says what it needs); tldraw's licence for production use.

## What a terminal shows instead of a picture

A terminal draws text. Where the references show a live 3D, canvas or browser preview, the Workbench draws what is there in
words (the board, the files, the last run, its state) and `c` or `s` opens it rendered in your browser. Colors are the
terminal's 16 slots as the Timmy Homebrew profile sets them; every state also carries its word and glyph. The REPL colors
a role only when your terminal answered its color question, so inside tmux (which may not answer) it can draw without
color: `TIMMY_PALETTE=homebrew ./review.sh repl` says the Timmy Homebrew profile is installed (the launcher passes that
one setting through).

## Stop

- **The Workbench:** Ctrl+C with nothing running quits it, and the companion and Studio it started stop with it. With
  something running, `x` stops the selected run first (a chat turn: Esc in its composer). A run still going on keeps its
  record, and the Control Room (7) shows it with Stop next time.
- **The REPL:** `/exit`, or Ctrl+C with no turn running (Ctrl+C during a turn stops the turn).
- **A chat turn, from anywhere:** the companion page's Stop the turn (or Stop this turn beside it) stops the turn being
  answered in the Workbench or the REPL; what its tools had already done stays done (nothing is rolled back), and its
  receipt says it was stopped and who asked. A job (a workflow run) stops only from the Workbench or REPL that started it
  (`x`, `/stop <job>`); the page shows it running and has no Stop for it (not in this build).
- **A browser page:** close it; nothing runs in the page itself.
- **Everything:** close the windows above, then `./review.sh clean` removes the sandbox, after you type yes. Nothing outside
  this folder was installed or started.
