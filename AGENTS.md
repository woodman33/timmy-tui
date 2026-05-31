# AGENTS.md

Guidance for coding agents working in this repository.

## Cursor Cloud specific instructions

This monorepo contains two products:

| Product | Path | Entry |
|---------|------|-------|
| **OpenRouter TUI (TIMMY Agent Ops Console)** | repo root | `npm start` |
| **Founder Terminal / AgentOps TUI** | `founder-terminal/` | `founder-terminal` (after Python venv install) |

### Dependency refresh (automatic)

The VM update script runs `npm install` at the root and `uv pip install -e .` inside `founder-terminal/.venv`. No service startup is included in the update script.

### Node / TypeScript (primary app)

- Install: `npm install`
- Typecheck/build: `npm run build` (`tsc`)
- Interactive TUI: `npm start` (uses `tsx cli.tsx`)
- Headless agent: `npm run start:headless` (requires `OPENROUTER_API_KEY`)
- Docs validation: `npm run docs:verify` (GitBook CLI/API checks fail without optional GitBook tooling and `GITBOOK_API_KEY`; other checks still run)

Without `OPENROUTER_API_KEY`, the Ink TUI starts in **`setup` mode** instead of chat. Full Ink keyboard input requires a real TTY; piped/non-interactive shells may show Ink "raw mode" errors even when startup succeeds.

### Python (Founder Terminal)

```bash
cd founder-terminal
uv venv          # creates .venv if missing
source .venv/bin/activate
uv pip install -e .
```

- Doctor: `PYTHONPATH=src python -m founder_terminal.cli doctor`
- Non-interactive governed demo: `printf 'y\n' | PYTHONPATH=src python -m founder_terminal.cli governed-demo`

`uv` is installed under `~/.local/bin` on Cloud Agent VMs if missing from the base image.

### Cloudflare Worker (local telemetry / receipts)

`npm run cf:dev` uses `npx wrangler` and can block on interactive prompts. For non-interactive local dev in Cloud Agents, start manually:

```bash
npx wrangler dev src/companion/cloudflare-worker.ts --local --install-skills --port 8787 --show-interactive-dev-session=false
```

Then run the receipt integration test:

```bash
TIMMY_TELEMETRY_URL=http://localhost:8787 npm run timmy:test-run
```

Default remote bindings may hang on "Establishing remote connection…"; prefer `--local` unless you intentionally need remote Cloudflare resources.

### Companion web server

The TUI auto-starts the companion on port **3001** when graphics fall back to browser mode (`http://localhost:3001`). Disable with `npm start -- --no-companion`.

### External tools

- **tmux** — required for `timmy:test-run` and workspace features (available at `/exec-daemon/tmux` on Cloud VMs)
- **OPENROUTER_API_KEY** — required for live LLM chat/headless; optional for setup mode, governed demo, and receipt tests
- **GitBook CLI + GITBOOK_API_KEY** — optional; only needed for docs publish/verify GitBook steps

### Lint / tests

There is no ESLint/Jest/Vitest/pytest suite in package scripts. Use:

- `npm run build` — TypeScript compile
- `npm run docs:verify` — docs structure checks
- `TIMMY_TELEMETRY_URL=http://localhost:8787 npm run timmy:test-run` — tmux + Worker receipt E2E
- `PYTHONPATH=src python -m founder_terminal.cli doctor` — Python environment diagnostics
- `printf 'y\n' | PYTHONPATH=src python -m founder_terminal.cli governed-demo` — governed execution sandbox (creates `.agentrun` bundle)
