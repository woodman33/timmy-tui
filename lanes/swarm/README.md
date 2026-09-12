# lanes/swarm — the SWARM RUNTIME (ORDER swarm-b3k7)

One swarm = N **members** run under one **topology**, one **budget**, one **judge
tier** and one **network policy**. The spec is CUE (`schemas/swarm.cue`), its
TypeScript mirror is the worker's `swarm-core.ts`, and the same topology code
runs in two places:

| where | who runs the members | how to start it |
|---|---|---|
| **edge** — the durable commander (`POST /commander/:room/swarm`) | OpenRouter models; Timmys over Durable-Object MCP | `timmy swarm run <preset> "<task>"` when every member can run there (or `--edge`) |
| **local** — this lane | Ollama slots (mac / spark2), Ollama Cloud, OpenRouter, harnesses, Timmys over HTTPS | `timmy swarm run <preset> "<task>" --local` (automatic when a member is local) |

Every member call is its own receipt (`swarm.member`, root store; the edge
mirrors it on the room chain) and `swarm.run` cites all of them. A local run is
also recorded on the room (`swarm.run` on the commander chain, `recorded: true`).

## Files

| file | what |
|---|---|
| `schemas/swarm.cue` | the spec: `#Member` (model \| harness \| timmy; node, sandbox, role, weight), `#Topology`, `#Budget`, `#Judge`, `#Network`, the cross-field rules (closed = local + deny-all + local judge) |
| `presets.mjs` | the preset table → `presets/*.cue` (`write`) and `cue vet` of each (`vet`) |
| `presets/` | local-5, local-5-mac, kimi-5, timmy-x3, relay-3, tournament-4, council-3, crew-3, coordinator-3, closed-3, fanout-2, fusion-2 |
| `swarm.mjs` | `timmy swarm list\|vet\|show\|run\|kill\|swarms\|timmys\|fit\|slots\|airgap\|clean` |
| `fit.mjs` | Level 0 fit math: Ollama parallel slots = sessions, KV per slot, max N per node |
| `slots.mjs` | start / prove / stop / status a second Ollama server with `OLLAMA_NUM_PARALLEL=N` (mac, spark2 over Tailscale SSH) |
| `airgap.mjs` | the closed topology's enforcement: policy + hash, hands under `sbx` deny-all, the snooped MCP wire (mcpsnoop) that proves zero egress |
| `runs/` | one JSON per run (spec, task, every call, receipts) |

## Topologies (workers/ai-proxy/src/swarm-core.ts)

| topology | what happens | proof |
|---|---|---|
| fanout | every member answers; every answer kept | `fanout-2` |
| fusion | fanout, then one judge merges | `fusion-2`, `kimi-5`, `timmy-x3` |
| relay | a handoff chain: each member improves the previous answer; a broken link is skipped | `relay-3` |
| coordinator | the judge splits the task, members take a part, the judge composes | `coordinator-3` |
| tournament | N candidates, the judge picks ONE (JSON), the losers are recorded | `tournament-4` |
| council | round 1 positions, rounds 2..R weighted votes (no self-votes), ties → judge | `council-3` |
| crew | harness members with roles from `harness.abilities` (builder / operator / bridge / scout / editor / answerer); the judge plans and composes | `crew-3` |
| closed | fusion over local slots only, hands under sbx, wire snooped → `swarm.airgap` (policy hash + egress 0) | `closed-3` |

The **cost governor** (`Governor`) refuses the next call the moment the budget
(usd, calls, wall-time) is spent or the room's kill switch fires; members that
never ran are recorded as `killed` with the reason, and `swarm.run` lists them.

## Level 0 — parallel slots

`timmy swarm fit --node spark2 --ctx 8192` prints the table (weights + KV per
slot × N vs the node's memory). `timmy swarm slots start --node mac --parallel 5
--port 11435` starts a second server that never touches the user's :11434;
`prove` fires N concurrent chats and reports `work_overlap` (the runner's own
compute time ÷ wall), the honest measure — a queue also "overlaps". Finding:
Ollama 0.33.1's MLX runner serves one request at a time whatever
`OLLAMA_NUM_PARALLEL` says; the llama.cpp (GGUF) runner honours it, so the Mac
presets use the Unsloth GGUF (`hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL`).

## Level 2 — Timmy-of-Timmys

`Timmy` (workers/ai-proxy/src/timmy.ts) is a durable agent (McpAgent) per
project room — `project:ship`, `project:shelf`, `project:swarm` — with its own
mind, hands, memory, spend ledger (the project profile's budget) and receipt
chain (`timmy:<room>`, mirrored to KV). It exposes MCP: the root commander
connects over Durable-Object RPC (`addMcpServer(room, env.TIMMY)`) and calls
`think` as a swarm member of kind `timmy`; outside callers use
`/timmy/:room/{state,think,turns,receipts,profile,remember}` or the MCP
endpoint `/timmy/mcp` (tools name the room). `timmy swarm timmys ship,shelf,swarm`
pushes each project's `profile.cue` into its Timmy.

## Receipts

`swarm.member` (one per call: member, phase, round, model, provider_used,
generation_id, tokens, usd, content sha, external receipt when the member has
its own chain), `swarm.run` (task/answer/spec shas, every member receipt hash,
winner/losers/votes/roles, budget ledger, kills), `swarm.airgap` (closed runs:
policy + hash, egress count from the snooped wire, endpoints, hands runs),
`timmy.profile` (Level 2 profiles pushed).
