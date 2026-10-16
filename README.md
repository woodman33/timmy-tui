# TIMMY — the Agent Trust OS

**Trust the receipt, not the model.**

AI agents edit files, run commands, call models, and change infrastructure.
TIMMY is a local-first flight recorder + control plane for agent work: runs,
chat turns, observations and tool calls are sealed as signed, hash-chained
receipts (what ran, where, in which environment, what it made), and a replay
refuses a machine or a source that drifted.

```
one command · every run receipted · replay from the receipt alone
```

## Quickstart (from source; Node 24 or later)

```bash
git clone https://github.com/woodman33/timmy-tui.git
cd timmy-tui
npm install
npm run timmy -- init         # first run: operator, identity, a chat route, a first project
npm run timmy                 # the REPL
npm run timmy -- workbench    # the terminal Workbench: one project, ten tabs
npm run timmy -- --help       # every command
```

From a checkout, type `npm run timmy -- <command>` where these docs say
`timmy <command>`. npm's `latest` is still an early 0.1.0 build, so run Timmy
from source for now; `npm install -g timmy-tui` waits for the v2 release.

Chat needs a route: a local Ollama (no key, no charge) or an OpenRouter key.
`timmy init` asks which; `timmy init --chat openrouter` asks for the key,
typed hidden (or put `OPENROUTER_API_KEY` in a `.env` copied from
`.env.example`).

First receipts:

```bash
timmy demo                                  # a sealed demo receipt: .timmy/receipts/demo-receipt.json
timmy proof "create a hello world worker"   # a proof receipt for a simulated task: .timmy/runs/<run>/ with replay.md
timmy receipts                              # verify the chain, then the latest receipts
```

To review one exact revision in a sandbox of its own, with a scripted demo
project, see [the review package](scripts/review/README.md).

## The workspace

- **`timmy`**, the REPL: chat in your scrollback; commands start with `/`
  (`/help` lists them). `timmy repl --demo` plays one scripted turn (no
  model, no key) and says so, first and last.
- **`timmy workbench`**, the main space: ten tabs (keys 1 to 9 and 0), each
  with its actions; `?` lists the keys; `p` switches the project; `x` stops
  the selected run; `c` opens the browser companion on the tab shown and `s`
  opens Studio; Ctrl+C quits.
- **The browser companion** (127.0.0.1:3001; `c` in the Workbench, or
  `timmy watch`): the same ten tabs, and what a terminal cannot draw: the
  newest images, a run's source, diffs, outputs and receipts verified now,
  VoxVision's observed images with what was measured over them, the
  project's own Studio board (tab 4: its artifacts, reference images and
  cards as Studio saved them, each image shown at size, each item opening its
  record, run or receipt), the MCP inspector.
- **Timmy Studio** (`timmy studio`, 127.0.0.1:4337): a tldraw canvas the
  agent draws on, as drafts you Accept or Discard; each project has its own
  board. Studio's side panel puts the project's artifacts (VoxVision records,
  runs, receipts) and its own images on it, and its Nodes palette adds the
  project's own cards as nodes bound to it: parameters (saved through the
  same path as the REPL's, refused while a flow runs), workflows, results,
  and an operation's cards in run order. Connect draws an arrow between two
  nodes: data flows only along an operation's own links; any other arrow is
  labelled "link only · no data flows".
- **`timmy watch`**, the full-screen monitor (the Command Post), and
  **`timmy workspace check`**, the frame every surface shares, in words.

## What is in this build

- **Receipts**: sha256 hash-chained, ed25519-signed records, each with the
  environment it ran in (`env_lock`: OS, architecture and the build hashes of
  the tools it used) and its status; a run's also lists what it made (paths
  with their sha256).
  `timmy receipts` verifies the chain; `timmy epoch` rotates the release
  epoch.
- **Replay**: `timmy clip list|run|replay` replays a clip from its cut-list
  alone and refuses a machine whose tool build hashes, or a source whose
  hash, drifted (the failure is sealed, saying which); `timmy export otio
  <run>` and `timmy export agentrun <job>` make an OTIO timeline or a portable
  `.agentrun` bundle.
- **Workflows**: a markdown document's `bash` blocks run by upmd (`/run <doc>
  <block>` in the REPL, or `timmy md`), with the prediction sealed before the
  run, a NEEDS YOU box before anything gated runs, and the run inspected after
  it (source, changes with diffs, outputs, receipts). A workflow runs on this
  computer, in the project folder.
- **Approvals and dispatch (the Command Post)**: a gated step waits for an
  operator token bound to its exact plan hash (`timmy approve <hash>`:
  single-use, 5 minutes); a bare boolean never approves. Dispatch plans are
  CUE-validated, launch only once armed with that token, and reach harness
  lanes through six MCP tools (plan, dispatch, tail, pause or cancel, collect,
  list lanes); paid work is refused without a spend bound.
- **Lanes**: the harness lanes (OpenHands, a disposable sandbox or nothing;
  OpenCode, Hermes, Pi, jcode and minds) run only where their programs are
  installed (`timmy tools` says which; `timmy watch --lanes` starts them in a
  tmux server of Timmy's own); the engine lanes (Blender, Godot, Defold,
  Cocos, Unity, Unreal, Houdini, USD, Reallusion) need their apps; API lanes
  need their keys.
- **VoxVision**: observations of images, video and meshes (`/observe`,
  `/detect`, `/measure`): OpenCV's measurements (QR codes, ArUco markers,
  colour regions) and an STL's own triangles, each labelled with its
  provenance and evidence, sealed with a receipt. Look needs python3 with
  OpenCV. Timmy can compute and verify dimensions of generated CAD.
  Converting that CAD cannot establish the dimensions or density of a
  physical object.
- **MCP**: `timmy mcp serve` serves 44 tools over stdio (receipt verify, env
  lock, judge loop, dispatch, lanes, the geo voxel bench, fleet, Clef, vision,
  and the OpenHands, Roboflow, 3minapi and oapi lanes). `/mcp tools` and
  `/mcp call` reach other MCP servers through two MCP-to-CLI routes, the MCP
  SDK and MCPorter (a server started from its command line through either; one
  MCPorter's config names, or an HTTP address, through MCPorter), each call
  kept with its record and receipt.
- **Judge loops**: local-first multi-model fan-out with confidence-gated
  frontier escalation, with a child and a parent receipt per loop.
- **Fleet and Clef**: `timmy fleet` plans and runs workers on a FAKE backend (a
  simulation) or one self-hosted Cloudroom Core (not verified live); `timmy
  decide` records Clef-Omni's recommendations, off by default and never
  applied.

## Use TIMMY from your agent

```jsonc
// your MCP client config (from a checkout)
{ "mcpServers": { "timmy": {
  "command": "<repo>/node_modules/.bin/tsx",
  "args": ["<repo>/src/mcp/server.ts"]
}}}
```

An installed Timmy serves the same tools with `timmy mcp serve`. Tools include
receipt verify, env lock, judge loop, dispatch (plan, arm with `timmy approve`,
dispatch, tail, pause or cancel, collect), the lanes list, the geo voxel bench,
vision inspection and the OpenHands, Roboflow, 3minapi and oapi lanes.

## Example receipt (abridged)

A workflow run's receipt, as `.timmy/receipts/runs.jsonl` holds it:

```json
{
  "v": 1, "stream": "runs", "epoch": 1,
  "kind": "workflow", "subject": "workflow · REPORT.md › report · completed",
  "status": "ok", "policy": "human-gated", "project": "tray",
  "env_lock": { "os": { "platform": "linux", "build": "…" }, "arch": "x64", "tools": { "…": { "sha256": "…" } } },
  "job": { "id": "j022325", "state": "completed", "exit_code": 0, "steps": [ { "name": "report", "receipt": "6ebeff7d" } ], "log_sha256": "…" },
  "outputs": [ { "path": "out/report.md", "sha256": "…", "bytes": 42 } ],
  "prediction": { "doc": "REPORT.md", "block": "report", "expect": "each block exits 0", "met": true, "receipt": "853f192b" },
  "operation_id": "of14ecbee",
  "prev_hash": "sha256_…", "hash": "sha256_…",
  "signer": "-----BEGIN PUBLIC KEY-----…", "signature": "…"
}
```

## Terminal colors

Timmy draws in your terminal's own 16 colors and never paints its background.
When it starts, it asks the terminal for its background and palette (OSC 11
and OSC 4: macOS Terminal answers, as do iTerm2, Ghostty, kitty, WezTerm and
Alacritty, and recent tmux and zellij pass the answer on) and measures a color
before it uses one:

- A meaning takes its color only when that color reads on your background:
  4.5:1 for text, 3:1 for rules, 6:1 for secondary text. A color that misses
  gives way to its bright twin (on macOS Terminal's "Clear Dark", red is 3.1:1
  and bright red 4.6:1); when both miss, the meaning goes without color.
- Every meaning also has a mark and a word, so no color carries a meaning
  alone: `✓ RECEIPT … signed and verified`, `✖ Denied`, `NEEDS YOU`, and `◉`
  for what a model made (`[OK]` and `[FAIL]` without Unicode).
- **When the terminal does not say its background** (some multiplexers, older
  terminals, a slow link), Timmy cannot measure, so meanings have no color and
  everything is in your terminal's own text color, which reads on your
  background. For color there, install Timmy's palette in your terminal
  (`timmy theme install`) and set `TIMMY_PALETTE=homebrew` (or `night`, `day`).
- Inside tmux, the background tmux reports is the one it read when your
  terminal attached. After you change your terminal's profile, detach and
  attach again so Timmy measures the new one.
- `/theme` in the REPL shows what was measured and the color each meaning
  takes. `NO_COLOR` turns color off.

### Timmy Homebrew and the font

Timmy's default look is Timmy Homebrew (DESIGN.md §10 B10): a black ground,
off-white text, amber for focus, the selection and the one next step, and
green only for a live connection, a passed check or a verified sealed receipt.
Every outcome keeps its word (`signed and verified`, `failed`, `needs setup`),
so color never carries a meaning alone. Timmy Night and Timmy Day are still
there.

- **The Workbench's colors.** `timmy workbench` writes these colors exactly
  only where the terminal says it draws 24-bit color (`COLORTERM=truecolor` or
  `24bit`). Otherwise it writes the nearest of the standard 256 colors, so its
  off-white text comes out white, and it does not use the 16 slots the Timmy
  Homebrew profile sets. The REPL and `timmy watch` color by those 16 slots.
- **Your terminal.** `timmy theme install` copies the palettes where your
  terminal looks for them and prints the lines that pick Timmy Homebrew. On
  macOS Terminal it gives you a profile to open,
  `assets/themes/terminal/Timmy Homebrew.terminal`, which also sets the font.
  Then make it the default in Terminal > Settings > Profiles.
- **The font.** Monaspace Argon is preferred
  (`brew install --cask font-monaspace`). A terminal draws Timmy in its own
  font, so the profile or the printed lines set it, at 14 points. Any
  monospace font works if you skip it.
- **zellij.** `timmy center` draws in Timmy Night by default. Set
  `TIMMY_PALETTE=homebrew` to pick the Timmy Homebrew theme (its selected tab
  is amber); `timmy theme install` puts the theme file where zellij reads it.
- **Review pictures.** `scripts/ui/render.ts` draws a capture on Timmy
  Homebrew in Monaspace Argon, read from your own machine and never copied
  into the repository. It says which font it used, and when Monaspace Argon is
  missing it draws in your system's monospace font and tells you.
- **The browser pages** (the companion, Timmy Canvas) read the same colors and
  type from `/timmy-theme.css`. They use Monaspace Argon when it is installed,
  else the copy Timmy serves from your own machine, else your system's
  monospace font. The colors you give your drawings on the canvas, and images
  and measured data, keep their own.

## Docs

- [ROADMAP.md](ROADMAP.md) — public now/next
- [docs/README.md](docs/README.md) — full doc index
- [docs/RECEIPT-SPEC-v2.md](docs/RECEIPT-SPEC-v2.md) — receipt schema
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md) — which benchmarks Timmy is judged against, what each needs, and the receipted numbers so far
- [lanes/geo/README.md](lanes/geo/README.md) — the geo lanes: metric scale from self-consistency, the voxel bench scorer (voxel F1 band + Chamfer + F-score@τ, metric unless fitted) and the public-set bench loader (Google Scanned Objects), each with a CLI (`timmy geo …`) and MCP route
- [docs/UI-REFERENCE-NOTES.md](docs/UI-REFERENCE-NOTES.md) — the UI north-star; [docs/ui-cockpit/REFERENCE-MATRIX.md](docs/ui-cockpit/REFERENCE-MATRIX.md) — where each of the 18 reference layouts lives, and what still differs
- [scripts/review/README.md](scripts/review/README.md) — the review package: one revision in a sandbox, and a walkthrough
- [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

## Trust notes

- **Local-first, no telemetry**: no analytics and no call home. Requests go
  where you point them (a model route, a fleet backend, a worker you name),
  and receipts stay on your machine unless you share them.
- **Honesty**: what is not set up says so (`needs setup`, `not set up`,
  `not_configured`) with the step that sets it up, and a check that did not
  run is never shown as passed.
- **Credentials**: a chat turn's receipt keeps its prompt and answer as
  hashes, but a task string or a command line is kept as written: never put a
  credential in one. Keys belong in your environment or Timmy's private
  settings (`timmy init` asks for them, typed hidden).

### Roboflow Vision Studio

`timmy vision serve` (127.0.0.1:4336) is for image inspection with a configured Roboflow model or saved Workflow, archived evidence and operator review; it is not checked in this build's review. `timmy vision status` checks the setup without loading a model or making a network request (with no key it says `not_configured` and why). `timmy vision doctor` runs `scripts/vision-doctor.py`, which this checkout does not carry, so it stops with python3's "can't open file". API keys stay in the server's environment or the private `.timmy/vision.env` file. Visual canvas recipes describe a process; the selected model or saved Workflow executes the inspection.
