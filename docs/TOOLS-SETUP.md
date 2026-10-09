# Tools setup

`timmy tools` (and `/tools` in the REPL) checks each capability on this machine without writing a file, starting a server or printing a key, and places it on the ladder: **reachable** (a live check answered just now), **installed** (what it needs is here; nothing was contacted), **needs setup** (the step below adds what is missing) or **not built** (planned, or a stub that cannot do its job here). The steps are for macOS with Homebrew; no check below prints a secret, and `timmy tools all` adds one row per lane and per vision adapter.

## The rows

| Row (as `timmy tools` shows it) | What it needs | Exact setup step | How to check |
|---|---|---|---|
| **WHERE YOU WORK** | | | |
| REPL (timmy) | An OpenRouter key, from the environment, Timmy's settings, `timmy-tui.config.json` or the providers file that `timmy init` writes. Needs setup without one. | `timmy init`, or `export OPENROUTER_API_KEY` | `timmy tools` (the row names where the key was found, never the key) |
| Timmy Canvas (/canvas) | Its page bundle, built, and a port no other program answers on. Installed when built; reachable while it runs. | `npm run build:canvas`; if another program answers on its port, set `TIMMY_STUDIO_PORT` to a free port. `/canvas` starts it. | `/canvas` in the REPL |
| Monitor (timmy watch) | Nothing beyond Timmy. | None: `timmy watch` (or `/watch`) opens it. | `timmy watch` |
| Cockpit (timmy center) | zellij or tmux on PATH. | `brew install zellij` (or `brew install tmux`) | `zellij --version` (or `tmux -V`) |
| Web views (/web) | Nothing for links. To draw a page inside the terminal: carbonyl on PATH, with Timmy running inside a zellij or tmux session. Pages must be on this machine unless you use `/web --allow-remote`. | `npm install --global carbonyl`, then start Timmy inside zellij or tmux | `command -v carbonyl` |
| Receipts (timmy receipts) | Nothing beyond Timmy; the row shows the receipt count and whether the chain verified. | None | `timmy receipts` |
| **MODELS** | | | |
| OpenRouter | An OpenRouter key. Reachable only when OpenRouter's key endpoint accepted it just now (a free check, made only when `OPENROUTER_API_KEY` is set where `timmy tools` runs). | `timmy init`, or `export OPENROUTER_API_KEY`; if the key was refused, `timmy init` with a working key | `timmy tools` |
| Ollama (local models) | `ollama` on PATH, its server answering, and at least one local model. | `brew install ollama; brew services start ollama; ollama pull <model>` | `ollama list` |
| **AGENT TOOLS** | | | |
| Built-in tools | Nothing beyond Timmy; `get_env` asks before each read. | None | `timmy tools` |
| Canvas tools | Timmy Canvas running with its page open. Reachable only when the page answered. | `/canvas`, then `/canvas open` | `/canvas` in the REPL |
| Workspace command | Nothing to run commands on this machine (it asks each time); `DAYTONA_API_KEY` to run them in Daytona instead. | None; for Daytona, set `DAYTONA_API_KEY` | `[ -n "$DAYTONA_API_KEY" ] && echo set` |
| Browser (agent-browser) | `agent-browser` on PATH and the Chrome it downloads. | `brew install agent-browser, then agent-browser install` | `agent-browser --version` |
| Load test (oha) | `oha` on PATH; the tool asks before each run. | `brew install oha` | `oha --version` |
| Trigger.dev jobs | A Trigger.dev secret key from the project's API keys page; `TRIGGER_API_URL` only for a self-hosted instance. Installed when the key is set; nothing is contacted. | set `TRIGGER_SECRET_KEY` | `[ -n "$TRIGGER_SECRET_KEY" ] && echo set` |
| Composio | A Composio API key. Only listing connections is built. **Known defect:** the code calls a Composio API version that Composio has removed, so calls fail even with a key until it is fixed. | set `COMPOSIO_API_KEY` | `[ -n "$COMPOSIO_API_KEY" ] && echo set` |
| Durable Object pulse | The edge host, from `TIMMY_EDGE_HOST` or the private overlay (`.timmy/private/config.json`, never committed). | set `TIMMY_EDGE_HOST` | `timmy tools` (it says whether a host is set, never the host) |
| Feature flags | A Cloudflare Worker with a Flagship binding; outside one it cannot read a flag. | None (not built) | None |
| Card listing | The listing service's address in `BREAK_MODE_API_BASE_URL` (or `API_BASE_URL`), and `TIMMY_USERNAME`. It asks before it posts. | set `BREAK_MODE_API_BASE_URL` and `TIMMY_USERNAME` | `[ -n "$BREAK_MODE_API_BASE_URL$API_BASE_URL" ] && [ -n "$TIMMY_USERNAME" ] && echo set` |
| Local spatial review | Ollama answering with at least one local model. | `ollama serve`, then `ollama pull <model>` | `ollama list` |
| **OTHER AGENTS** | | | |
| Claude Code | `claude` on PATH. It runs in a cockpit pane, not from the REPL yet. | `brew install --cask claude-code` | `claude --version` |
| Codex | `codex` on PATH. It runs in a cockpit pane, not from the REPL yet. | `brew install --cask codex` (or `npm install -g @openai/codex`) | `codex --version` |
| Qwen Code | `qwen` on PATH. It runs in a cockpit pane, not from the REPL yet. | `brew install qwen-code` (or `npm install -g @qwen-code/qwen-code`, which needs Node.js 22 or later) | `qwen --version` |
| Lanes (/lanes) | At least one lane's command on PATH; an API lane also needs its key (`WEBCONTAINERS_CLIENT_ID`, `RETOOL_API_KEY`, `ANYTHINGLLM_API_KEY`, `LANGSMITH_API_KEY` or `ABACUS_API_KEY_1`), and hyperframes needs its own command, not only `npx`. | `/lanes` lists how to install each | `timmy tools all` (one row per lane) |
| AgentPass | A checkout of the AgentPass service, which lives outside this repository; its lane runs `scripts/agentpass.py` from that checkout with `AGENTPASS_PYTHON` (default `python3`). Installed when the folder exists; nothing is contacted. | set `AGENTPASS_REPO_PATH` to its checkout | `[ -f "$AGENTPASS_REPO_PATH/scripts/agentpass.py" ] && echo found` |
| TaskForge | TaskForge's API, which runs outside this repository: its API base, ending in `/api`. Reachable when its `/runtime/health` answered just now; installed when the address is set but nothing answered. | set `TASKFORGE_API_URL` to its API | `curl -s -o /dev/null -w '%{http_code}\n' "$TASKFORGE_API_URL/runtime/health"` (200: it answered) |
| **SPATIAL AND VISION ADAPTERS** | | | |
| Mission Map (timmy map) | Nothing to install. Reachable while `timmy map` serves it, otherwise installed. | None: `timmy map` starts it. | `timmy tools` while `timmy map` runs |
| Vision adapters | At least one adapter whose Python interpreter and adapter script are both found; a probe run qualifies one. This checkout ships the camera-fit and telemetry (MCAP, PlotJuggler) adapter scripts; `docs/VISUAL-TOOLS.md` names their Python environments. | `timmy vision integrations list` (it lists; it installs nothing) | `timmy vision integrations list` |

Checks of the form `[ -n "$NAME" ] && echo set` look only at the shell you run them in, and print `set` or nothing, never the value. `timmy tools` does not load a `.env` file in the working folder, while the REPL's `/tools` does, so a key kept only in `.env` reads differently in the two.

## MCP servers in `config/mcporter.json`

mcporter reads `config/mcporter.json` from the project it runs in, unless `--config` or `MCPORTER_CONFIG` names another file.

| Server | What it provides | How it starts | Environment variables it needs |
|---|---|---|---|
| `3minapi` | 3minapi's API builder: create, test and deploy data-capture endpoints | no command: mcporter reaches it over HTTP | `THREEMINAPI_KEY` |
| `roboflow` | Roboflow image upload, detection and video-frame sampling, each call sealed as a receipt | `tsx` | `ROBOFLOW_API_KEY`; optional `ROBOFLOW_WORKSPACE` and `TIMMY_VISION_SERVER_URL` |

- The `roboflow` entry names its program and script under a `<repo>` placeholder, so mcporter cannot start it from this file as committed. Keep a private copy with your checkout's path and point mcporter at it with `--config` or `MCPORTER_CONFIG`, so no path is committed. The server also needs a Python environment in `.timmy/venv-vision` or `.timmy/venv-roboflow` with the `roboflow` package (`inference-sdk` for detection), and `ffmpeg` for sampling.
- The file's `registries` section also names `@cult-ui-pro`, a component registry rather than an MCP server; it reads `CULT_PRO_TOKEN`.

Sources for the install steps: each tool's own README or Homebrew page, checked 2026-10-08 (agent-browser, oha, Ollama, Claude Code, Codex, Qwen Code, Trigger.dev, Composio, carbonyl, zellij, tmux, font-monaspace).
