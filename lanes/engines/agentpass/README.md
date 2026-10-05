# AgentPass service lane (authority plane)

AgentPass Labs is the passport / broker / approval / audit authority. TaskForge
already talks to it through a JSON-only CLI (`scripts/agentpass.py taskforge …`,
fake-first). This lane puts the same CLI on Timmy's shelf so every passport and
every brokered call gets an `engine.run` receipt with a prediction sealed first.

```
drop/*.passport.json ─► predict (expected passport) ─► agentpass.py taskforge passport issue ─► report: fields_as_predicted
drop/*.call.json     ─► predict (audit count, payload sha) ─► agentpass.py taskforge call-tool ─► status ─► report: audit_delta_ok
drop/*.health.json   ─► health + status ─► report: packs · tools · audit_events · pending_approvals
```

- Repo path: `AGENTPASS_REPO_PATH` (default `~/agent-cloud-lab/agentpass-lab`); interpreter `AGENTPASS_PYTHON` (default `python3`).
- Rules carried over from TaskForge's executor: spawn, never a shell; no secrets in argv or env; the broker owns every external API call; fake mode is never flipped from here.
- Honesty clause: missing repo or a CLI without the `taskforge` subcommand → `status=not_configured`.

## Where the pieces live

| piece | location | state |
|---|---|---|
| CLI bridge | `agentpass-lab/scripts/agentpass.py taskforge …`, `scripts/taskforge_bridge.py` | on the Mac copy (commit "Add TaskForge bridge commands and policy notes"); GitHub copy is one commit behind |
| TaskForge executor | `taskforge/packages/runtime/src/executors/agentpass.ts` | review-gated `issue_passport` / `call_tool`, auto `health` / `status` / `audit` |
| TaskForge API | `/api/runtime/agentpass/{health,status,audit}`, `POST …/passport/issue`, `POST …/call-tool` | the same five actions over HTTP (see the taskforge lane) |
| This lane | `lanes/engines/agentpass/` | predictions + receipts around the CLI |

## Async, both directions

- **Agent → AgentPass:** any hand drops a `*.call.json`; the lane runs it and the receipt is the callback.
- **AgentPass → Timmy:** `taskforge audit --limit N` is the broker's own event stream; a scheduled `broker-health`
  run turns the audit count into a time series of receipts, and a Cloudflare Agent `schedule()` or a
  cron can own that loop. Approval gates (`approvals list|approve|deny`) stay in AgentPass; Timmy only records.

## Routes

CLI today. For MCP clients: wrap the bridge with `mcporter` (generated CLI/typed client), call it through
`cmcp`, or bind it with `bindPuppet()` from `@mcpc-tech/cmcp`; AgentPass's own broker lanes
(OpenRouter, GitHub, Notion, Cloudflare, OpenHands) remain behind its passports.
