# Source findings, live observations and fixtures

These categories are distinct. Public source traces are not proof of every deployed behavior; marketing-page inspection is not an authenticated dashboard session; local fixtures are not production qualification.

## Pinned source traces

| Source | Pin | Useful pattern | Limit observed in source |
| --- | --- | --- | --- |
| [Paperclip](https://github.com/paperclipai/paperclip/tree/0cb3fc7db591ba23e21fbbc70042bc44ec7d6f20) | `0cb3fc7db591ba23e21fbbc70042bc44ec7d6f20` | Conditional task/run ownership, adapter lifecycle, pre-dispatch budget reservations, durable per-run sequence/deduplication | Company live events use an in-process emitter; the inspected client refetches canonical state after reconnect rather than replaying historical events |
| [Canonical Herdr](https://github.com/herdrdev/herdr/tree/2713feb56e9c9db33992db0a262c68f7426d46dd) | `2713feb56e9c9db33992db0a262c68f7426d46dd` | Terminal server survives client detach; hook lifecycle signals, attention priority, revision-checked display patches and explicit lost history | Client detach differs from server death. Idle/unseen display state does not prove correctness or independent review |
| Timmy shared host | `37fa0cba217e89472d6c1475e6cfffbcc8438168` | Existing durable jobs, agent runs, operation/receipt readback and app host | These records alone do not establish a durable UI replay cursor or exactly-once remote execution |

Paperclip trace entry points: `server/src/services/heartbeat.ts`, `server/src/services/issues.ts`, `server/src/services/live-events.ts`, and `ui/src/context/LiveUpdatesProvider.tsx`. Herdr trace entry points: `src/app/api_helpers.rs`, `src/workspace/aggregate.rs`, `src/client/shell/agent_sidebar.rs` and its event/display protocol. No upstream implementation is copied into the fixture.

## Observed runtime routes

The installed older Timmy `2.0.0-rc.1` inspector command `timmy mcp status` failed because its packaged inspector script was missing. That finding is confined to that version and path; the private raw failure is retained separately.

The newer review runtime `2.0.0-rc.2`, source revision **8113d1a8fdf3d017d8a617800976cfc8ff3f0948**, has a working slash-command bridge. Four real `timmy act '/mcp …'` operations through its independent SDK route succeeded: target listing and REA inspection for each of the public Herdr and Paperclip sites. REA was version 6.4.0. No authenticated product dashboard was exercised. The records/receipts remain checkpoint-local and private; no shared chain was appended for this packet.

Development failures also remain retained privately: Timmy's bounded discovery summary omitted the desired tool from its first 100 entries despite 170 names being available; a later request used CLI argument names and was refused by MCP validation. The corrected MCP request used observed `cdp_endpoint`, `target_id`, `allowed_origins` and `observation_ms` fields. The old failures were not rewritten as successes.

The private Treg connector has separately observed discovery through MCPorter and independent SDK routes. Those observations establish specific operations only. Provider account, call, balance and financial records are deliberately absent from this shareable packet. Catalog discovery remains research rather than admitted model evidence.

## Fixture observations

`room-model.mjs` is an original disconnected reducer, not imported upstream code or a production host implementation. All identities and amounts are synthetic. The preview begins blank. Explicitly loading a fixture enables local replay/authority/cost controls; clearing or reloading returns to blank. See CHECKS.md for observed results and untested boundaries.
