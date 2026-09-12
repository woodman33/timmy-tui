# Cloudflare as first mate — the war-room pane feed and verbs

`lanes/cf/pane.mjs` produces the feed the war-room pane renders and runs the
six verbs. The TUI (src/tui, not this lane) renders `companion/boards/cf.pane.json`
or the NDJSON stream of `timmy cf pane --watch`. mindship-v5c2 step 3.

## The feed

```
timmy cf pane [--watch --every 30] [--tail-seconds 6] [--prod] [--no-seal]
```

| field | source | honest limit |
|---|---|---|
| `worker` | `GET /health` + `wrangler versions list` | version id, created_on |
| `tail` | `wrangler tail <name> --format json` for a short window | events, last 12 (method, path, status, logs, exceptions) |
| `do.rooms` | `GET /runs/slate:ledger` | events count, viewers |
| `do.commander` | `GET /commander/war-room/state` | mode, held_by, paused, killed, turns, head, spend, viewers, schedules |
| `queues` | `wrangler queues list` (table parsed) | wrangler reports no backlog depth; `depth` is null with a note, never a fake zero |
| `cron` | crons in `workers/ai-proxy/wrangler.jsonc` → next UTC run, plus the local anchor LaunchAgent at 09:30 | `last_head` from `GET /head` |
| `spend` | commander ledger + OpenRouter `/credits` and `/auth/key` | the key label is left out of the feed |
| `sources` | one row per source: ok, ms, note | a dead source shows as dead |

Each `pane` run seals `cf.pane` (feed sha, sources ok, tail events, commander
turns, next cron, head date).

## The verbs

```
timmy cf deploy [--prod --yes]        wrangler deploy (preview by default) → seals cf.deploy
timmy cf tail [--seconds N] [--prod]  live tail as NDJSON
timmy cf code --script f | --task "…" [--approval t]   POST /code (Code Mode)
timmy cf workflow                     wrangler workflows list
timmy cf kv [list [--prefix chain:]] | get <key>       CUSTODY_KV
timmy cf r2 [buckets | list <bucket>]  bucket list / info (wrangler has no object list)
```
