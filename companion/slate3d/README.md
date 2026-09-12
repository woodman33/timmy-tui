# Slate 3D

A tldraw mission board rendered as a Three.js scene. Frames are slabs, capsules
are capsules, harness nodes are lane pods, and the pods light from the Timmy
event bus. The viewer spawns nothing. Decisions and their alternatives:
`DESIGN.md` (sealed as `slate.design`).

## Run

```
npm --prefix companion/slate3d install     # three + esbuild, once
node lanes/slate/build.mjs                 # dist/: slate3d.js, index.html, lanes.json, manifest.json
node lanes/slate/render.mjs --board ledger # build, serve, capture still + clip, seal slate.render
```

The companion server (`src/companion/server.ts`) serves `dist/` at `/slate3d/`
and the boards at `/slate3d/boards/`, and pushes the bus over its WebSocket as
`{type: "bus.tail"}` on hello and `{type: "bus"}` for every new event. Run it
against the pinned repo root so the bus is the root bus:

```
TIMMY_REPO=/path/to/timmy-tui npx tsx -e "import('./src/companion/server.ts').then(m => m.startCompanionServer(3001))"
open http://127.0.0.1:3001/slate3d/?board=ledger
```

The companion page itself gets a SLATE 3D tab that embeds the same URL.

## The room (two browsers, one board)

```
node lanes/slate/bus-bridge.mjs --room slate:ledger --replay 200        # seed + forward the live bus (ctrl-c to stop)
node lanes/slate/room-check.mjs --room slate:ledger                     # two browsers, one live event, seals slate.room
open "http://127.0.0.1:3001/slate3d/?board=ledger&room=slate:ledger&worker=https://<hostname>"
```

The room is `SlateRoom` in `workers/ai-proxy` (SQLite Durable Object). Reads are
public; writes need the worker's caller token, which the bridge reads from
`workers/ai-proxy/.dev.vars`. The room stores and relays envelopes and never
spawns work.

## Parameters

| Query | Meaning |
|---|---|
| `board=<name>` | `companion/boards/<name>.mission.json` (default `ledger`) |
| `still=1` | reduced motion: no idle drift, deterministic for screenshots |
| `sse=<url>` | read the bus from an EventSource instead of the companion socket |
| `room=<id>&worker=<url>` | read a Durable Object room speaking the runs/events contract |

## Bus files

Two files are tailed under the repo root: `.timmy/receipts/runs.jsonl` (the one
bus: event envelopes appended beside the receipts by `src/bus`) and
`.timmy/runs/timmy-events.jsonl` (legacy writers). Receipt records are skipped;
only `{v, ts, kind, payload}` envelopes pass. A new client receives the last six
hours from both files, then live events.

## State from receipts

Frames list the orders that deliver them; capsules list evidence rules. The
companion server exposes `GET /slate3d/receipts` (receipt records from the
pinned root store with their sources) and the worker exposes the public daily
head of the edge chains at `/head`. The viewer derives:

- frame: done when every listed order has an `order.execute` receipt whose
  sources carry the id, blocked when one was sealed as blocked, active when
  some are sealed, next otherwise; a frame may name an attestation receipt
  that stands for orders sealed in a frozen fork store
- capsule: rules `{root: <subject>, min, sources?}` count root receipts,
  `{edge: <chain>, min}` read the daily head, `{blocked_by: <subject>}` marks
  the capsule blocked while its evidence is incomplete

Blueprint boards (`kind: blueprint`) cited by a mission render as reference
sheets beside the slabs: tokens, doctrine, architecture. Evidence boards
written by lanes render the same way: `observer.board.json` (kind observer)
carries one sheet and one shape per lane screenshot with the boxes, the OCR
lines, the CLIP label and the `observer.evidence` receipt id and hash. At most
four sheets per board stand on the floor; the rest stay in the file.

## Emitting to the controller

Click a capsule: the panel lists its acceptance lines with their evidence and
offers compile (a dry run through the controller's `/mission/compile`) and
send (stores one plan, returns its id and hash). Both go through
`POST /slate3d/emit` on the companion server, which forwards to the `timmy
logs` gateway on localhost and publishes `slate.emit.*` on the bus. Arming and
launch stay behind the operator token in the controller; the scene never
spawns. `node lanes/slate/emit-check.mjs --capsule p6.capsule` proves it and
seals `slate.emit`.

## The state table

`node lanes/slate/state-table.mjs` prints the ledger's state (frames from
orders, capsules from acceptance evidence), writes
`companion/boards/ledger.state.{json,md}`, and seals `slate.state`. It runs the
same `src/state.js` the viewer bundles.

## Lit rules

- lane: `payload.harness`, else the kind prefix when it names a lane, else the
  subject prefix of `receipt.sealed` (`defold.build` lights `defold`)
- colour: phosphor for chain events, orange for human acts (approval, arming),
  red only for refusal; failure is unlit with a muted label
- decay over twenty minutes to a floor glow; the label keeps "last seen"
- `slate.*` events pulse the slabs, never a pod
