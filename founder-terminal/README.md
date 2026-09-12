# 🤖 Founder Terminal / AgentOps TUI Cockpit

Welcome to **Founder Terminal / AgentOps TUI**, a professional, local-first control plane for supervising, replaying, and auditing AI-agent software runs powered by the **OpenHands SDK**, **X-CMD portabilities**, and **tmux multiplexer grids**. 

---

## ⚡ Systems Architecture & Technical Components

This control plane decouples presentation, event orchestration, shell tools, and safety policies:

1. **Presentation Layer (Textual/Rich)**: 
   * **Dashboard**: System resource monitors, default sandbox profiles, and edge integrations status.
   * **Terminal Workspace**: Multiplexer controller detecting `tmux`, `x-cmd`, `abtop`, and `Starship`. Generates dry-run scripts and deploys AgentOps quadrant layouts.
   * **Runs & Cockpit**: Reactive event stream streaming OpenHands logs, tool calls, and safety gates live with sidebar integrations.

2. **Conversation Layer (OpenHands SDK)**:
   * Maps prompt executions into structured events via custom visualizer buses. Saves append-only JSONL files under `.runs/` dynamically.

3. **Runtime Layer (X-CMD Adapter)**:
   * **Shell Sourcing Adapter**: Differentiates between POSIX (Zsh/Bash) and non-POSIX (Fish/Nushell) environments, wrapping sourced library commands within safe POSIX sub-shells to prevent syntax conflicts.

---

## 🚀 Installation & Env Configurations

### 1. Bootstrap Virtual Environment
The terminal cockpit utilizes `uv` to build high-performance localized environments under the [founder-terminal/](file://<home>/Desktop/timmy-tui/founder-terminal) subdirectory:

```bash
cd founder-terminal
uv venv
source .venv/bin/activate
uv pip install -e .
```

### 2. Configure Environment Keys
Duplicate the environment template and load your OpenRouter / Github tokens:
```bash
cp .env.example .env
```

---

## 🛡️ Host Mutation & Safety Policies

To guarantee absolute filesystem safety across your developer machine, the console operates under **strict governance rules**:

1. **Zero Silent Mutating Rule**: The console **never** modifies terminal startup files (`~/.zshrc`, `~/.bashrc`), tmux configurations (`~/.tmux.conf`), or Claude settings (`~/.claude/settings.json`) silently. It always displays the exact diff and requires explicit user confirmation.
2. **Automatic Timestamped Backups**: Every host mutation duplicates the target config to a timestamped backup (e.g. `~/.tmux.conf.founder-terminal-backup-<timestamp>`) first and records the backup path inside the mutations store.
3. **Write Sandbox Policy**: Write-capable agent tasks run within an isolated temporary directory, generating a diff for manual review before any code is committed back to the source repository.

---

## 📊 Replayable Agent runs (.agentrun)

Every executed session is packaged as a transportable `.agentrun` bundle folder:
```
<run-name>.agentrun/
├── manifest.json            # Run metadata, sandbox kind, active model, and spent cost
├── normalized_events.jsonl  # Append-only JSONL event trees
├── final_summary.md         # Markdown report
└── replay.json              # Frame coordinates for terminal movies
```

---

## 🛡️ DOCTRINE: Self-Referencing Architecture-Governance

TIMMY implements a lightweight, local-first **Architecture-Governance Layer** governed by [DOCTRINE.md](file://<home>/Desktop/timmy-tui/founder-terminal/docs/architecture/DOCTRINE.md). 

Before letting an autonomous agent execute tasks or write code, TIMMY loads and validates our core structural contract, prepending safety contexts to LLM prompts. This ensures our AI coding agents remain strictly bound by our architectural rules.

### How DOCTRINE Governs the Stack

| Stack Piece | Governance Rule |
| :--- | :--- |
| **OpenHands** | Prepends architecture rules before autonomous runs; aligns with confirmation/security policy model. |
| **OpenRouter Agent SDK** | Injects system context into `callModel`; pairs naturally with stop conditions, tool approval, and state persistence. |
| **x-cmd** | Keeps Layer 0 as shell runtime/tool substrate, not a TUI framework; official x-cmd docs confirm POSIX Shell/AWK modularity and no-root package loading. |
| **Cloudflare Agents** | Later maps doctrine hash into Durable Object state, but not in V1.3; Cloudflare Agents are Durable Objects with SQL state, WebSockets, and scheduling. |
| **abtop/tmux** | Doctrine defines observation vs execution boundaries so monitoring never becomes mutation. |

---

## 🛠️ CLI Operations

* **Central Diagnostics Suite**: `PYTHONPATH=src .venv/bin/python src/founder_terminal/doctor.py` (comprehensive systems doctor check).
* **Doctrine Status Check**: `PYTHONPATH=src .venv/bin/python src/founder_terminal/doctrine/cli.py status` (audits path, SHA-256 hash, and heading completeness status).
* **Doctrine Content Display**: `PYTHONPATH=src .venv/bin/python src/founder_terminal/doctrine/cli.py show` (displays raw doctrine document).
* **OpenRouter System Context Preview**: `PYTHONPATH=src .venv/bin/python src/founder_terminal/doctrine/cli.py inject-preview --target openrouter` (prints exact compact instructions injected before `callModel` runs).
* **OpenHands Task Prefix Preview**: `PYTHONPATH=src .venv/bin/python src/founder_terminal/doctrine/cli.py inject-preview --target openhands` (prints exact prefix prepended before starting autonomous coding runs).
* **Tmux Layout Room Builder**: `/tmux layout agentops` (builds and dry-runs reproducible multi-pane workspaces).
* **Observability Snapshot**: `/abtop once` (grabs a read-only process monitor snapshot).
