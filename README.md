# TIMMY — the Agent Trust OS

**Trust the receipt, not the model.**

AI agents edit files, run commands, call models, and change infrastructure.
TIMMY is a local-first flight recorder + control plane for agent work: every
run gets a signed, hash-chained receipt (what ran, where, how long, what it
cost, which artifacts it produced) — and replays refuse to lie about drifted
environments. Live on Product Hunt.

```
one command · every run receipted · replay from the receipt alone
```

## Quickstart

```bash
git clone https://github.com/woodman33/timmy-tui.git
cd timmy-tui
npm install
cp .env.example .env        # optional: add OPENROUTER_API_KEY for frontier models
npm start                   # the TUI (local ollama models work with $0)
```

npm still serves an early 0.1.0 build, so install from source (above) for now.
Once the v2 release is published: `npm install -g timmy-tui` · `npx timmy-tui demo`

First receipt:

```bash
timmy demo        # sealed receipt at .timmy/receipts/demo-receipt.json
timmy proof "create a hello world worker"   # proof run folder + replay.md
```

Inside the TUI: `Tab` switches tabs, `?` shows the key grammar, `Ctrl+L`
opens the live log monitor, `Ctrl+K` the command palette. Local Ollama models
(`http://localhost:11434`) answer with $0 when OpenRouter is unreachable
(`FALLBACK 🟡`).

## What works today

- **Receipts v2**: sha256 hash-chained, ed25519-signed run records with
  prompt/response hashes, usage, cost, latency, error class; failed and
  denied runs seal too; release epochs keep old streams queryable.
- **Environment lock**: OS/arch/tool *build hashes* bound to every receipt;
  replay refuses drifted machines.
- **Replay**: EDL cut-lists replay clips from the manifest alone; portable
  `.agentrun` bundles (EDL + manifest + sources + hashes + receipts) with
  OTIO interchange (`timmy export otio|agentrun`).
- **Command Post**: typed DispatchPlan (CUE-validated) with lifecycle; six
  delegation tools; J-BANG dispatch rail; operator tokens bound to the
  complete immutable plan hash (single-use, expiring); paid routes
  default-deny without a spend bound.
- **Harness lanes**: OpenHands (disposable-sandbox-or-nothing), OpenCode, Pi,
  jcode, minds + 3D lanes (blender/godot/defold/cocos/unity/unreal-mcp/
  houdini-mcp) + key-gated API lanes; tmux/zellij/rmux multiplexing.
- **Judge loops**: local-first multi-model fan-out with confidence-gated
  frontier escalation; child + parent receipts per loop.
- **MCP server**: 37 tools for any MCP-speaking agent (`timmy mcp serve`),
  composed `timmy-agent` server, client-exec bridge, OpenAPI invoker lane.
- **Companions**: browser companion on :3001 (chat mirror) and the receipt
  browser + dispatch survey on :4310 (`timmy logs`), Mission Map on :4336
  (`timmy map`; `npm run mission-map` serves it on :4321).
- **CLI verbs**: demo · proof · clip · export · events (--otlp) · mcp serve ·
  logs · approve · epoch · map · q (dasel across json/yaml/toml/xml/csv) ·
  doctor · sceneforge (read-only Houdini advisory; key from macOS keychain).

## Use TIMMY from your agent

```jsonc
// your MCP client config
{ "mcpServers": { "timmy": {
  "command": "<repo>/node_modules/.bin/tsx",
  "args": ["<repo>/src/mcp/server.ts"]
}}}
```

Tools include receipt verify, env lock, judge loop, dispatch (plan, arm with
`timmy approve`, dispatch, tail, pause/cancel, collect), lanes list, the geo
voxel bench, vision inspection and the OpenHands/Roboflow/3minapi/oapi lanes —
every call receipted.

## Example receipt (v2, abridged)

```json
{
  "v": 1, "stream": "runs", "epoch": 2,
  "subject": "llm google/gemini-3.7-flash",
  "status": "ok",
  "prompt_hash": "…", "response_hash": "…",
  "model_requested": "google/gemini-3.7-flash", "model_resolved": "google/gemini-3.7-flash",
  "via": "openrouter", "ms": 1742, "tokens": 214, "cost_usd": 0.0004,
  "prev_hash": "sha256_…", "hash": "sha256_…",
  "signer": "ed25519:…", "signature": "…"
}
```

## Terminal colors

Timmy draws in your terminal's own 16 colors and never paints its background.
When it starts, it asks the terminal for its background and palette (OSC 11
and OSC 4: macOS Terminal answers, as do iTerm2, Ghostty, kitty, WezTerm and
Alacritty, and recent tmux and zellij pass the answer on) and measures a color
before it uses one:

- A meaning takes its color only when that color reads on your background:
  4.5:1 for text, 3:1 for rules, 7:1 for secondary text. A color that misses
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

Timmy's default look is Timmy Homebrew: a black ground, off-white text,
Homebrew green for the prompt, the selection and primary actions, and a few
quiet accents for status. Green is not proof: every outcome keeps its word
(`signed and verified`, `failed`, `needs setup`). Timmy Night and Timmy Day
are still there.

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
  is Homebrew green); `timmy theme install` puts the theme file where zellij
  reads it.
- **Review pictures.** `scripts/ui/render.ts` draws a capture on Timmy
  Homebrew in Monaspace Argon, read from your own machine and never copied
  into the repository. It says which font it used, and when Monaspace Argon is
  missing it draws in your system's monospace font and tells you.
- **The demo.** `timmy repl --demo` is a scripted recording of the screen: it
  says so, first and last, and no model answered and no tool ran.
- **The browser pages** (Timmy Canvas, the receipt pages) read the same
  colors and type from `/timmy-theme.css`. They use Monaspace Argon when it
  is installed, else the copy Timmy serves from your own machine, else your
  system's monospace font. The colors you give your drawings on the canvas
  stay yours.

## Docs

- [ROADMAP.md](ROADMAP.md) — public now/next
- [docs/README.md](docs/README.md) — full doc index
- [docs/fal3d-provider.md](docs/fal3d-provider.md) — reference-driven P1/H3.1/TRELLIS.2 assets, offline plans and operator-gated fal jobs
- [docs/RECEIPT-SPEC-v2.md](docs/RECEIPT-SPEC-v2.md) — receipt schema
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md) — which benchmarks Timmy is judged against, what each needs, and the receipted numbers so far
- [lanes/geo/README.md](lanes/geo/README.md) — the geo lanes: metric scale from self-consistency, the voxel bench scorer (voxel F1 band + Chamfer + F-score@τ, metric unless fitted) and the public-set bench loader (Google Scanned Objects), each with a CLI (`timmy geo …`) and MCP route
- [docs/UI-REFERENCE-NOTES.md](docs/UI-REFERENCE-NOTES.md) — the UI north-star
- [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

## Trust notes

- **Local-first, zero telemetry**: no call-home, no analytics; receipts never
  leave your machine unless you share them.
- **Honesty clause**: anything unavailable reports `not_configured | blocked`
  and seals a receipt saying so. No fabricated passes.
- **No secrets in receipts**: prompts are stored plaintext — never put
  credentials in task strings; keys live in env/keychain and are redacted on
  the way out.


### Roboflow Vision Studio

Open `timmy vision` (or `/vision` inside the TUI) for image inspection with a configured Roboflow model or saved Workflow, archived evidence, and operator review. The six editable tldraw templates are not in the public checkout yet. `timmy vision status` checks setup; `timmy vision doctor` checks this computer without running inference. API keys stay in the server environment or private `.timmy/vision.env` file.

See [Timmy Vision setup and deployment](docs/ROBOFLOW-VISION.md) for Spark/NAS placement, local versus hosted inference, Vision Events, WebRTC, MCP tools, and the limits of the current integration. Visual canvas recipes describe a process; the selected model or saved Workflow executes the inspection.
