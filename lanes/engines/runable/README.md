# Runable service lane (executor plane, artifacts)

Runable is a cloud agent that produces artifacts — sites, decks, reports, spreadsheets,
video — in an isolated sandbox per chat. Its only programmatic surface is a remote MCP
server (Streamable HTTP, OAuth 2.1); there is no REST API, SDK, CLI or webhook. So the
lane speaks MCP JSON-RPC directly and splits the job into three drops that each seal
their own receipt:

```
drop/*.runable.json  ─► predict (tools/list snapshot, expected deliverable) ─► start ─► task id
drop/*.poll.json     ─► progress every N s → progress.jsonl → final.json (done | failed | timed_out)
drop/*.collect.json  ─► files tool → download + sha256 every artifact → files.json
```

- Credentials: `RUNABLE_ACCESS_TOKEN`, or `RUNABLE_CLIENT_ID` + `RUNABLE_CLIENT_SECRET`
  (client_credentials against the server's OAuth metadata). Never written anywhere.
- Tool names are discovered, not pinned: `tools.json` records what the server offered and
  `chosen` records which tool the lane used for start / progress / files. A rename shows up
  as a changed `tools_sha256`, not a silent failure.
- Honesty clause: no credentials → `status=not_configured`; cap reached → `status=timed_out`.

## Async, both directions

- **App → CLI:** an agent (OpenRouter Agent SDK tool, Cloudflare Agent schedule, TaskForge
  step) drops a `*.runable.json`; the receipt is its callback.
- **CLI → app:** the task runs in Runable's sandbox; `task-poll` is the inbound leg, and the
  files land in the project with hashes, ready for Blender, the slicer or a FiftyOne dataset.
- **Chained drops:** `start` writes `{stem}.task.json`; copying `{task_id}` into a
  `*.poll.json` and later a `*.collect.json` is how an operator or an agent continues the
  job hours later — Z→A from the receipt alone.

## Other routes to the same server

`mcporter call runable <tool>` and `cmcp` (one call per command) for shell use;
`bindPuppet()` from `@mcpc-tech/cmcp` to bind the lane itself as an MCP tool; the MCP
Inspector `--cli` to list tools during setup. The Cloudflare Agents SDK can also add the
server with `addMcpServer()` and call it from a Durable Object.

## Sources

runable.com/docs/mcp (server URL, OAuth grants and scopes, tool list), runable.com/pricing.
Exact tool names and argument keys are read live; nothing about them is assumed here.
