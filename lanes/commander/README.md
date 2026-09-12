# Commander — the durable commander loop

`workers/ai-proxy/src/commander.ts` is a Cloudflare Agents SDK durable agent
(one SQLite Durable Object per room) on timmy-ai-proxy. `lanes/commander/cli.mjs`
is the local client (`timmy commander …`). mindship-v5c2 step 2.

| part of the order | where it lives |
|---|---|
| persistent memory | SQL tables `turns`, `memory`, `receipts` in the DO + synced state |
| scheduled steps | `POST /schedule {task, in\|at\|cron}` → `this.schedule(...)` → `scheduledThink`; skipped and receipted as skipped while held or killed |
| WebSocket to TUI and companion | `GET /commander/:room/ws` — hello with state + last turns, then `{type:'commander.event', kind, receipt, state}` on every mutation; commands over the socket carry `token` |
| Code Mode as hands | when the mind answers with `async () => …`, the script runs in the Dynamic Worker isolate through `runCode`; the turn cites the `code.run` receipt |
| OpenRouter as mind | `chatOnce` with `usage:{include:true}`; models from `ALLOWED_MODELS` |
| modes | `generate` (one mind), `bodybuilder` (fan-out, every actor's answer kept), `fusion` (fan-out, then one judge sees every candidate) |
| handoff protocol | `POST /handoff {harness, holder}` → hold token (shown once, fingerprint stored) · `commander.handoff` receipt · OpenRouter paused (think → 423) · holder posts `POST /turn {hold_token, asked, known, did, model}` · `POST /release {hold_token}` (operator `--force` recorded) |
| live spend | `state.spend` (usd, calls, tokens, uncounted) from OpenRouter's reported cost; `GET /spend`; `POST /cap {cap_usd}`; cap reached → 402 |
| kill switch | `POST /kill` cancels schedules, refuses think and handoff (423); `POST /revive` |

Every mutation seals one receipt on the room's chain (subject `commander:<room>`),
kept in the DO and mirrored to `CUSTODY_KV` as `chain:commander:<room>`, so
the daily head lists the commander like every other chain. `GET
/receipts?verify=1` verifies the chain from genesis.

Auth: reads and the socket are public like the Slate rooms; commands need
`TIMMY_EDGE_TOKEN`; the holder's `/turn` and `/release` need the hold token
instead.

```
timmy commander state | spend | turns | receipts [--verify] | schedules | memory
timmy commander think "<task>" [--mode generate|bodybuilder|fusion] [--models a,b] [--judge m] [--no-hands]
timmy commander mode fusion
timmy commander hold --harness opencode --holder will      # prints the hold token once
timmy commander turn --token <hold> --did "…" [--asked "…"] [--known "…"] [--model m]
timmy commander release --token <hold> | --force
timmy commander kill [--reason "…"] · revive · cap 5
timmy commander schedule "<task>" --in 600 | --at <iso> | --cron "0 9 * * *"
timmy commander cancel <id> · remember <k> <v> · forget <k>
timmy commander watch                                       # the feed, one JSON event per line
```

Any MCP-capable harness holds the role by calling `/handoff`, `/turn`,
`/release` (through Timmy's MCP server or directly); nothing about the role is
harness-specific.

Tests: `workers/ai-proxy/test/commander.test.ts` (routes, handoff state
machine, kill, cap, spend ledger, the three modes with a fake OpenRouter,
hands through a fake executor, the room chain).
