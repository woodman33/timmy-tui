# RouteMux service lane (model plane)

RouteMux is a reliability-first model gateway: one key, protocol passthrough
(OpenAI `/v1/chat/completions` + `/v1/responses`, Anthropic `/anthropic/v1/messages`,
Vertex), a public pricing feed and per-request headers that are made for receipts.
This lane treats it exactly like an engine on the shelf: pinned by env-lock, reached
through a project's drop folder, one `engine.run` per workflow.

## Bridge

```
drop/*.routemux.json ─► predict ─► POST api.routemux.com/v1/… ─► report ─► engine.run receipt
                        (sealed       X-Idempotency-Key = timmy-<sha256(request)>  prediction vs actual
                         first)       X-Request-ID, X-RouteMux-Billed ◄──┘
```

- Auth: `ROUTEMUX_API_KEY` in the environment (`Authorization: Bearer` for OpenAI
  routes, `x-api-key` for the Anthropic route). Never in argv, files or receipts.
- Idempotency: the key is `timmy-` + the full sha256 of the canonical request body
  (the `timmy-` prefix namespaces Timmy's keys on a shared gateway key; the hash is
  never truncated), so a re-run of the same drop cannot bill twice; a `409` is
  recorded as `status=replayed`.
- `balance-reconcile` reads `expected_spend_usd` from the dropped `*.reconcile.json`
  (`spend_predicted_source=drop`); `TIMMY_EXPECTED_SPEND_USD` is only the fallback
  (`source=env`). No expectation → `reconciled: null`, never a guess.
- Honesty clause: no key → `status=not_configured`, run seals `ok:false`.

## Templates

| template | what it proves | key needed |
|---|---|---|
| `model-feed-snapshot` | which models and prices existed, by hash, with a diff against the last snapshot | no |
| `chat-receipted` | one call, predicted first (tokens, cost, latency, outcome) and scored after | yes |
| `balance-reconcile` | the wallet and key spend agree with what the receipts predicted | yes |

Run order for a clean day: snapshot the feed, run the calls, reconcile the balance.

## Async, both directions

- **App → CLI:** any agent drops a `*.routemux.json` into `<project>/drop/`; the lane
  runs it (`timmy engine drop routemux --project <p>`), the receipt comes back as a
  file the agent can read. No webhook is needed, and RouteMux documents none.
- **CLI → app:** `timmy engine run routemux chat-receipted --project <p> --input req.json`
  from a terminal, a cron, a Cloudflare Agent schedule, or an OpenRouter Agent SDK
  tool whose `execute` spawns the lane.
- **Model-plane swap:** the OpenRouter Agent SDK client takes `serverURL`
  (`OPENROUTER_BASE_URL`), the OpenHands SDK takes `LLM(base_url=…)`, pi takes
  `~/.pi/agent/models.json`, hermes `providers.<name>.base_url`, opencode
  `provider.<name>.options.baseURL`. Point any of them at
  `https://api.routemux.com/v1` and keep this lane's receipts as the ledger.
  Responses-API parity through RouteMux is not verified yet; the chat route is.

## Routes to the same calls (MCP ↔ CLI)

The bridge is plain Node. To expose it to MCP clients or call MCP from it:
`mcporter` (MCP → CLI, typed clients), `cmcp` (one tool call per command) and
`bindPuppet()` from `@mcpc-tech/cmcp` (CLI → MCP), the MCP Inspector `--cli`,
and `mcp2cli`. `apisnip` captures the HTTPS calls for the API-side of a receipt.

## Sources

routemux.com/docs (chat, authentication, rate-limits, observability, balance),
`GET https://api.routemux.com/public/pricing` (53 rows on 2026-10-02). Anything the
docs do not state (webhooks, BYOK, fallback policy) is treated as absent.
