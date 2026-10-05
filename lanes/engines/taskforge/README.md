# TaskForge service lane (executor plane, local workflows)

TaskForge Labs is the local-first workflow OS: a plain-English task → workflow JSON →
confidence gate (Auto / Review / Clarify) → executors (shell, docker, tmux, ollama,
litellm, pinokio, gepeto, paperclip, minio, qdrant, redis, modal opt-in, agentpass,
openrouter, cloudflare). It is a harness that controls executors; Timmy is the harness
that controls it. The lane talks to TaskForge's HTTP API and seals one receipt per step
of the loop:

```
drop/*.taskforge.json ─► predict (steps, executors, gate) ─► POST /api/parse ─► workflow.json ─► report
drop/*.execute.json   ─► predict (workflow sha, minutes, failures) ─► POST /api/execute ─► SSE /api/logs/stream ─► result ─► report
drop/*.health.json    ─► GET /api/runtime/health (+ agentpass hook) ─► report
```

- `TASKFORGE_API_URL` (default `http://127.0.0.1:3001/api`). The API is the operator's;
  the lane never starts, stops or configures it.
- Approval semantics are TaskForge's: `autoAccept` never bypasses ALWAYS_REVIEW actions
  (`agentpass.issue_passport`, `agentpass.call_tool`); `userApproved` is the one signal
  that does, and the lane only forwards it when the operator wrote it into the drop.
- Honesty clause: API unreachable → `status=not_configured`; cap reached → `status=timed_out`
  (the execute step writes `{stem}.taskforge.json` itself before exiting, so the receipt carries
  it even though the lane stops before the report step; `result.json` keeps the task's own
  terminal state as `task_status`); a mock-parser answer is labelled `mock_parser:true`.
- The SSE log stream is opened with an `AbortController` and aborted the moment the status
  poll sees a terminal state or the cap expires — no fetch outlives the bridge.

## Where TaskForge lives

The monorepo (`apps/api`, `apps/web`, `packages/{shared,runtime,sdk}`) is on the operator's
machine and is not a public repository; this lane is the public, base-template side of the
integration. TaskForge's own AgentPass executor (`packages/runtime/src/executors/agentpass.ts`)
and the `agentpass` lane on this shelf wrap the same CLI, so a workflow step and a Timmy drop
produce comparable receipts.

## Async, both directions

- **Timmy → TaskForge:** a drop per parse or execute; the events JSONL and the receipt come back.
- **TaskForge → Timmy:** `/api/logs/stream/:taskId` is TaskForge's outbound stream; the lane
  records every event with a hash. A TaskForge `shell` step can also drop files into a Timmy
  project's `drop/`, which closes the loop the other way (TaskForge asking Timmy for a receipt).

## Routes

HTTP today. The TaskForge SDK (`@taskforge/sdk`, typed fetch client) covers the same routes
from TypeScript; for MCP clients wrap the bridge with `mcporter`, `cmcp` or `bindPuppet()`.
