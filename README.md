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

Or: `npm install -g timmy-tui` · `npx timmy-tui demo`

First receipt:

```bash
timmy demo        # sealed receipt at .timmy/receipts/demo-receipt.json
timmy proof "create a hello world worker"   # proof run folder + replay.md
```

Inside the TUI: `Tab` switches tabs, `?` shows the key grammar, `Ctrl+L`
opens the live log monitor, `Ctrl+K` the command palette. Local Ollama models
(`http://localhost:11434`) answer with $0 when OpenRouter is unreachable
(`FALLBACK 🟡`).

## What works today (v0.5.x)

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
- **MCP server**: 24 tools for any MCP-speaking agent (`timmy mcp serve`),
  composed `timmy-agent` server, client-exec bridge, OpenAPI invoker lane.
- **Companions**: browser companion on :3001 (chat mirror) and the receipt
  browser + dispatch survey on :4310 (`timmy logs`), Mission Map on :4321
  (`timmy map`).
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

Tools include receipt verify, env lock, judge loop, dispatch plan/arm/launch/
tail/cancel/collect, lanes list, OpenHands/roboflow/3minapi/oapi lanes — every
call receipted.

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

## Docs

- [ROADMAP.md](ROADMAP.md) — public now/next
- [docs/README.md](docs/README.md) — full doc index
- [docs/fal3d-provider.md](docs/fal3d-provider.md) — reference-driven P1/H3.1/TRELLIS.2 assets, offline plans and operator-gated fal jobs
- [docs/RECEIPT-SPEC-v2.md](docs/RECEIPT-SPEC-v2.md) — receipt schema
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

Open `timmy vision` (or `/vision` inside the TUI) for six editable tldraw templates, image inspection with a configured Roboflow model or saved Workflow, archived evidence, and operator review. `timmy vision status` checks setup; `timmy vision doctor` checks this computer without running inference. API keys stay in the server environment or private `.timmy/vision.env` file.

See [Timmy Vision setup and deployment](docs/ROBOFLOW-VISION.md) for Spark/NAS placement, local versus hosted inference, Vision Events, WebRTC, MCP tools, and the limits of the current integration. Visual canvas recipes describe a process; the selected model or saved Workflow executes the inspection.
