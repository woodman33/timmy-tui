## Learned User Preferences

- When implementing an attached plan: follow it as written; do not edit the plan file; complete linked todos without stopping midway.
- Extend the codebase additively—preserve existing TIMMY, founder-terminal, governance, and receipts behavior when adding TUI, Rive, or Cloudflare work.
- Ship a polished OpenRouter + Rive experience (companion/web window, terminal image protocols, ANSI text fallback); plain ASCII-only terminal UI is not the target.
- Integrate Cloudflare platform features (Workers, wrangler, Agents SDK, Sandboxes, MCP, Pages, email) when they materially improve the CLI/TUI.
- Use attached skills (`create-agent-tui`, `benchmark-sandbox`, Cloudflare build/MCP skills) when scaffolding agents, running remote evals, or extending Workers/MCP.
- Validate UI and agent flows in isolated sandboxes (Vercel Sandbox and/or Cloudflare Sandbox) with comparable prompts before claiming readiness.

## Learned Workspace Facts

- `<home>/Desktop/timmy-tui` is the primary repo for **TIMMY TUI** (terminal-first Agent Trust OS), not a greenfield scaffold.
- Git remote: `https://github.com/woodman33/timmy-ai-proxy.git`; common active branch: `antigravity/polish-tui-v2`.
- Antigravity is the IDE; all project source lives in this repo—no separate Antigravity-only codebase.
- Core stack: Ink TUI + `@openrouter/agent`, with Rive graphics, companion web UI, and headless-browser capture as major product axes.
- Monorepo includes `founder-terminal/`, Cloudflare wrangler companion worker, product doctrine docs, and `.runs/run_proof_*.agentrun/` proof manifests.
- Published CLIs: `timmy` and `timmy-tui` (see root `package.json`).

## Parallel-Agent Git Rules (v0.5, mandatory)

Multiple agents share this working tree. Violating these rules destroys other
agents' uncommitted work — treat them like lock discipline.

- NEVER `git add -A` / `git add .`. Stage ONLY the files you intentionally touched, by explicit path.
- NEVER `git reset --hard`, `git checkout --`, `git clean`, or `git stash` anything you did not create; other agents' uncommitted and untracked work is not yours to remove.
- Before committing, run `git status --short` and verify every staged path is yours; leave unrelated modifications and untracked files alone.
- No `--no-verify`, no force-push, no amend of commits you did not author.
- Receipts (`.timmy/`) are append-only shared state: append through `appendReceipt` (single-writer locked); never hand-edit or rewrite a stream.
- Approvals are operator-minted tokens (`timmy approve <planHash>`); an agent may never self-approve with a boolean.
