# Wire lane — mcpsnoop, mcp-probe, apisnip, and the two evaluations

shelf-w6d3 step 3: "mcpsnoop on every MCP wire; mcp-probe on every bridge;
apisnip on OpenAPI lanes; evaluate cmcp + mcpc with one receipt each."

```
node lanes/wire/wire.mjs snoop|probe|snip|eval|all [--only <bridge>]
node lanes/wire/seal.mjs [--only <bridge>] [--dry]      the main session seals from results.json
```

`bridges.json` is the registry: every MCP wire Timmy touches on this Mac
(Timmy's own two servers, the stdio bridges registered in `~/.claude.json`, the
mcporter-managed ones, the remote HTTP servers), each with transport, command
or URL, and the env var NAMES it needs (never values). `wire.mjs` walks it:

| step | how | writes |
|---|---|---|
| snoop | the stdio server is started through `mcpsnoop --label <name> -- <cmd>` (HTTP servers through `mcpsnoop http`), driven with `mcpc` (connect, tools-list, one harmless tools-call, close); the captured session is exported | `sessions/<name>.json` (+ `.tools.json`), `transcripts/<name>.jsonl` |
| probe | `mcp-probe validate --report` and `mcp-probe test --report --output-dir` against the same server | `reports/<name>.validate.json`, `reports/<name>/…` |
| snip | `apisnip <spec url>` on each OpenAPI lane | `snips/…` when it can run |
| eval | `mcpc` against Timmy's MCP server (tools-list, tools-call timmy_env_lock); `cmcp` from source | `reports/eval-*.json`, `transcripts/eval-*.jsonl` |

`results.json` is the one file the receipts cite: per bridge `snoop {session
file, sha256, frames, tools, ok, note}` and `probe {validate report + sha, test
report dir, passed, failed, findings}`; per OpenAPI lane the apisnip outcome;
per evaluated tool `{verdict, reason, transcript + sha}`.

## What the sweep found (2026-09-07)

- 40 wires registered; 21 snooped and probed live. The rest are recorded as
  `not_configured` (key-gated: THREEMINAPI_KEY, ALLYSON_API_KEY, motion TOKEN),
  `OAuth; 401` (Notion, Cloudflare, Wix, ElevenLabs, Quiver, Krea, Apify),
  `unreachable` (forge :3141, rive :9791, paper :29979, novita), `missing_entrypoint`
  (computer-use registered with a relative path) or `not_registered` (unreal-mcp).
- **apisnip 1.4.60 is an interactive ratatui picker** with only `-h`/`-V`: without
  a TTY it dies on "Device not configured"; under a pty it draws the endpoint list
  and waits for keys. It ran on the OpenRouter spec (82 paths, 106 operations) and
  the Petstore spec, and the outcome is recorded as `apisnip_ok:false` with that
  reason. Driving it needs a pty driver or an upstream headless flag.
- **mcpc 0.6.0: ADOPT.** Connected to Timmy's server, listed 23 tools, called
  `timmy_env_lock` and got the real env-lock back. It is the shell MCP client the
  harness handoff and these probes use.
- **cmcp: REJECT.** A Go program (no Go toolchain here; its installer builds from
  source) that only manages `claude mcp add/remove` registrations; it speaks no
  MCP and overlaps Claude CLI's own registry and Timmy's fleet. Reason and the
  attempt are in `reports/eval-cmcp.json`.

## Receipts

`wire.snoop` and `bridge.probe` per bridge, `api.snip` per OpenAPI lane,
`tool.eval` per evaluated tool. Each cites the files above by sha256.
