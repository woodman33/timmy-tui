# Harness control plane — a harness that controls harnesses

*2026-10-04 · engine-shelf/v0 service lanes · receipts v2*

Timmy's job is not to be the best agent loop. It is to be the controller that gives every
loop, gateway and executor the same contract: a sealed prediction before the call, a
hash-chained receipt after it, and an environment lock in between. This note records
the combinations that give the operator the most control with the least new code, and
which fields each layer exposes for receipts. Sources are the vendors' docs as of
2026-10-04; anything marked *unverified* has not been exercised here.

## The stack

```
                      operator / drop folders / tldraw canvas
                                     │
           ┌─────────────────────────┴──────────────────────────┐
           │  CONTROL PLANE · Cloudflare Agents SDK (agents 0.26) │  one Durable Object per lane:
           │  schedule() · runFiber()+stash · queue() · McpAgent  │  state, timers, fibers, MCP in/out
           └───────────┬───────────────────────────┬────────────┘
                       │                           │
     ┌─────────────────┴──────────┐     ┌──────────┴──────────────────────────┐
     │ MODEL PLANE                │     │ EXECUTOR PLANE                      │
     │ OpenRouter Agent SDK       │     │ OpenHands SDK (sandboxed code)      │
     │  callModel · tools · hooks │     │ TaskForge (local workflow OS)       │
     │  ──► gateway: OpenRouter   │     │ Runable (artifacts over MCP)        │
     │       or RouteMux /v1      │     │ CLIs: pi · hermes · opencode · jcode│
     └─────────────────┬──────────┘     └──────────┬──────────────────────────┘
                       │                           │
           ┌───────────┴───────────────────────────┴────────────┐
           │  AUTHORITY · AgentPass broker (passports, approvals, │
           │  audit) wraps every paid or external call           │
           └───────────────────────────┬────────────────────────┘
                                       │
                         TIMMY receipts v2 · env-lock · replay
```

The engine shelf gives each box a lane (`lanes/engines/{routemux,runable,agentpass,taskforge}`),
so a Cloudflare Agent, an OpenRouter tool or a human can drive the same workflow by dropping
one JSON file, and the receipt is the callback in every direction.

## What each layer exposes for a receipt

| layer | best integration point | receipt fields it gives us |
|---|---|---|
| Cloudflare Agents SDK | one `Agent` DO per lane; `runFiber()` + `ctx.stash()` for durable steps; `schedule()` for polls; `PiHarness` / `@cloudflare/think` as sub-agents; `McpAgent` to expose Timmy | DO instance name, fiber name + stash, `diagnostics_channel` events (`agents:rpc/schedule/skills/workflow`) via Tail Worker, Think `onStart({requestId})` |
| OpenRouter Agent SDK (`@openrouter/agent` 0.11) | `callModel` loop; seal per call in `PostModelCall`, per run in `SessionEnd(totalUsage)`; `stopWhen: maxCost(...)` as the spend bound | `responseId` (generation id), model, `durationMs`, turn type/number, usage + cost, JCS/SHA-256 doom-loop fingerprints |
| RouteMux gateway | OpenAI/Anthropic SDK `baseURL` → `https://api.routemux.com/v1`; send `X-Idempotency-Key` = receipt request hash | `X-Request-ID`, `X-RouteMux-Billed`, usage tokens, exact charge via logs / `/v1/key/info`, per-key quotas |
| OpenHands SDK (1.51) | `Conversation(agent, workspace=DockerWorkspace(...))`, event callbacks → receipts; `LLM(base_url=...)` to route through RouteMux or OpenRouter | `persistence_dir/<id>/events/*.json`, `conversation_id`, `llm.metrics` (cost, tokens incl. cache/reasoning, latencies), OTel spans |
| TaskForge | `POST /api/parse` → `POST /api/execute` → SSE `/api/logs/stream/:taskId`; executors incl. `agentpass` | taskId, confidence gate decision, per-step status, event stream (hashed line by line in the lane) |
| Runable | remote MCP `api.runable.com/api/mcp` (client_credentials); start → poll → files | task id, progress snapshots, `x-request-id`, downloaded file hashes; no cost field documented |
| AgentPass | `agentpass.py taskforge passport issue|call-tool|audit` before any paid external call | passport (agent, tool, scope, ttl, budget), approval metadata, audit event count delta |
| CLIs | `pi -p --mode json`, `hermes -z … --format stream-json --usage-file`, `opencode run --format json`, `jcode run --json`; all take an OpenAI-compatible base URL | JSONL events, session files, hermes usage file (tokens + cost), exit codes |

## Recommended combinations

1. **Default — "controller of controllers".** Cloudflare Agent per lane owns time (schedules,
   fibers, retries) and never holds a model key; it drops JSON into a Timmy project and reads
   the receipt back. The OpenRouter Agent SDK runs the reasoning loop locally or on a Spark
   with `PostModelCall` → `receipt.seal`, and `maxCost` as the hard spend bound. Executors are
   TaskForge for anything on the operator's machines and OpenHands `DockerWorkspace` for
   anything that edits code. AgentPass passports gate GitHub, Notion, OpenRouter and
   Cloudflare writes. *Why:* every layer already emits the fields in the table, so the
   receipt chain is complete without new telemetry.
2. **Model-plane A/B — OpenRouter vs RouteMux.** Same OpenRouter Agent SDK code, two
   `serverURL`s. RouteMux adds idempotency and billed/pending state per request; OpenRouter
   adds the generations API Timmy already reconciles (`ledger-r4k2`). Run both through the
   `chat-receipted` template with the same drop and compare cost, latency and prediction
   error — that is the benchmark, not a leaderboard. Responses-API parity through RouteMux
   is unverified; use chat completions until it is.
3. **Artifact factory — Runable under Timmy.** Cloudflare `schedule()` drives
   `task-start` → `task-poll` → `task-collect`; files land hashed in the project, then flow
   to Blender / slicer / FiftyOne lanes. Runable has no webhooks, so the poll template is the
   inbound leg; keep `max_minutes` honest and let `timed_out` receipts show where the service
   stalls.
4. **Code executor — OpenHands first, CLIs second.** OpenHands gives a sandbox, an event
   log and `llm.metrics` for free; pi/hermes/opencode/jcode are faster to start but need
   their JSON output modes captured. Point all of them at the same gateway so model cost is
   one ledger.
5. **Authority everywhere.** TaskForge's `agentpass` executor and the shelf's `agentpass` lane
   wrap the same CLI, so a workflow step and a Timmy drop produce comparable passports and
   audit deltas. Nothing paid leaves the machine without a passport in the receipt.

## What this does not do

- It does not pick models. Model choice stays malleable through the gateway (`/v1/models`
  on RouteMux, `/models` on OpenRouter) and is recorded, not decided, by the receipt.
- It does not replace the vendors' own logs; it binds their request ids into ours.
- It does not store keys, tokens or passports in the repo, a receipt or a report.

## Next steps

- `timmy engine run` each service template once on the Mac with real credentials, so the
  four services move from *authored* to *proven* on the shelf (one receipt each).
- A ninth swarm topology, `controller-of-controllers`, in `lanes/swarm` that wires a
  Cloudflare Agent to a Timmy project drop folder.
- The Lab50 receipts module (`ext/receipts.py` on the lab node) and this shelf share one
  schema idea; fold the lab's env-lock fields (torch, CUDA, driver, GPU) into `engine.run`.
