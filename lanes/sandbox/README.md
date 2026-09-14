# Sandbox lane — OpenHands SDK containers

`timmy sandbox …` runs one task against one repo snapshot inside an OpenHands
agent-server container and seals one `sandbox.run` receipt. shelf-w6d3 step 1.

```
timmy sandbox doctor                          docker + image + sdk + key preflight
timmy sandbox run --repo <dir> --task "…" [--image i | --base-image b] [--model m] [--wall s] [--collect a,b] [--no-seal] [--keep]
timmy sandbox seed timmy-suite | sun-10k | cards-200 | sim
timmy sandbox list
```

## How a run works

1. **Preflight.** Docker must answer, the image must be pulled, the OpenHands
   SDK must import in its uv venv, and `OPENROUTER_API_KEY` must be set. Any
   miss seals `sandbox.refuse` with the reason and exits 3. Real sandbox or
   nothing.
2. **Snapshot.** The repo is copied (without `node_modules`, `.git`, `dist`,
   `renders`, `.claude`) into `~/.timmy-sandbox/<id>/workspace`, every file
   hashed into `snapshot.manifest`; the manifest's sha256 is the snapshot id
   on the receipt. The live checkout is never mounted.
3. **Container.** `driver.py` (run with the venv's python) builds
   `LLM(model, api_key, base_url)`, `Agent(tools=[TerminalTool, FileEditorTool])`
   and a `DockerWorkspace(server_image, volumes=[snapshot:/workspace],
   platform)` or a `DockerDevWorkspace(base_image=…)` when a seed needs Node,
   then `Conversation(agent, workspace, callbacks).send_message(task).run()`.
   Every event lands in `out/events.jsonl`; `out/result.json` carries the
   final message, event and tool-call counts, status, cost.
4. **Diff + collect.** The workspace is re-hashed against the manifest
   (changed / added / removed); `--collect` copies named outputs beside the
   run record (`lanes/sandbox/runs/<id>.json`).
5. **Receipt.** `sandbox.run`: snapshot sha, task sha + preview, image, model,
   container id, events, tool calls, files changed, collected outputs with
   hashes, cost, error.

Docker on this Mac is Docker Desktop; its credential helper is not on PATH,
so the lane talks to the socket that answers (`~/.docker/run/docker.sock`,
then OrbStack, then `/var/run`) with a scratch, helper-free `DOCKER_CONFIG`.
Nothing under `~/.docker` is modified.

## Seeds

| seed | what runs inside | collected |
|---|---|---|
| `timmy-suite` | `npm ci` then `vitest run` on the snapshot of this checkout | `out/vitest.json` |
| `sun-10k` | `lanes/sandbox/seeds/sun-10k.mjs`: 10,000 synthetic NTAG 424 DNA taps (valid, replay, forged CMAC, wrong batch key, tamper loop open, unknown tag) through the real edge verifier → confusion matrix | `out/sun-10k.json` → sealed `sun.confusion` by the seed runner |
| `cards-200` | `lanes/sandbox/seeds/cards-200.mjs`: 200 synthetic trading-card PNGs from SVG with per-row provenance (generator version, seed, every parameter, svg + png sha) | `out/cards/` → auto-labelled by `timmy observer` → `dataset.synthetic-v0` |
| `sim` | `timmy sim run --dry` with a container-local `.timmy/store-pin`, so Timmy seals into a synthetic receipt store and bus inside the sandbox; the store is collected | `out/synthetic-receipts.jsonl` |

Both seed scripts also run on the host (`npx tsx lanes/sandbox/seeds/sun-10k.mjs --n 300`,
`node lanes/sandbox/seeds/cards-200.mjs --n 3`) for a fast check.
