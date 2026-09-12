# TIMMY simple judge loop — runbook (repo copy)

Moved into the repo 2026-08-15 (was a private ~/.qwen note; Git now shares it).
Owner directive: keep it SIMPLE — two transports (OpenRouter + ollama daemon),
one gate (`TIMMY_ALLOW_LOCAL_OLLAMA=1`), local-first judge chain. The daemon
routes `:cloud` tags itself; TIMMY never needs a separate cloud client.

## Local inventory (M5 Max, 128GB)

- `nemotron-3.5-lightning` — local, free, fast
- `qwen3.8:27b-mlx` — local, free, MLX-optimized (cold load ~116s; warm much faster)
- openrouter floor `google/gemini-3.7-flash` · frontier `x-ai/grok-4.6`
- spares: `minimax-m3:cloud`, `kimi-k3:cloud`, `glm-5.2:cloud`

## One-command judge loop (the hardened path)

```bash
cd <repo>
TX=node_modules/.bin/tsx

# Phase 1 — plan + hash (runs nothing, spends nothing)
TIMMY_ALLOW_LOCAL_OLLAMA=1 $TX scripts/timmy-mcp-call.ts timmy_judge_loop \
  '{"prompt":"<question>"}'
# → { planHash, plan, needs_approval }

# Operator approves (single-use, 5 min, bound to that exact hash)
$TX src/cli.ts approve <planHash>     # or: timmy approve <planHash>

# Phase 2 — executors (Promise.allSettled) + judge + child/parent receipts
TIMMY_ALLOW_LOCAL_OLLAMA=1 $TX scripts/timmy-mcp-call.ts timmy_judge_loop \
  '{"prompt":"<question>","approval":"<token>"}'
```

A bare boolean never approves; replays of a consumed token are denied and sealed
as denied receipts. Default-deny on unresolved models.

## The classic simple loop (still supported)

1. `timmy_fusion_plan '{}'` → which of JUDGE_CHAIN resolve right now.
2. Fan-out `timmy_llm_call` (parallel) with the approved subset.
3. Fuse with one cheap/local call; apply via `timmy_promo_apply` (human reviews first).
4. `timmy_receipt_verify '{"stream":"runs"}'` — the chain is the proof.

Client timeout: `TIMMY_MCP_TIMEOUT=600000` for cold local loads (default 180s).

## Promo iteration loop (v9→v10 proven)

`timmy_promo_judge` (locals score comp, conf-gated frontier arbitration) →
optionally generate tldraw-style image refs (`timmy_gen_run` nano-banana-2) →
bodybuilder fan-out drafts with tldraw vocab → local fusion → `timmy_promo_apply
{"from":"timmy-promo-vN"}` → hyperframes render → seal receipt + restic.
Baseline iterations cost $0; escalation budget is the only spend.

## Gotchas recorded

- Machine at load ~40+ starves the 5s receipt-lock timeout and ffmpeg spawns →
  parallel vitest files flake. Gates are sound; run
  `npx vitest run --no-file-parallelism` when the box is hot (CI is idle, unaffected).

- qwen MLX tag listed but "not found" → missing blob; `ollama pull <tag>` refetches delta.
- Repo ROOT has a wrangler.jsonc (owner's other CF project) — always
  `--config ./wrangler.toml` inside workers/ai-proxy.
- Live logs while headless: `timmy logs` (companion :4310, auto-pops once;
  TIMMY_LOGS_OPEN=0 opts out) or LOGS tab [6]/[w] inside the TUI.
