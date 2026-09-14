# Observer lane

A second pair of eyes on what the other lanes rendered. It reads the PNGs the
Defold, badge and Slate lanes leave behind, asks Roboflow's serverless models
what is in them, and seals the answer as a receipt. The images stay out of git
(`*.png` is ignored); the evidence does not.

## Run

```
node lanes/observer/observe.mjs                       # every image under renders/ and vault-custody/renders/
node lanes/observer/observe.mjs --dir renders/walkthrough/shots
node lanes/observer/observe.mjs --detect yolo_world --boxes banner,sign,text,rectangle,badge
```

Flags: `--detect <model>` (`yolo_world` by default; `grounding_dino` answers 500
on interface prompts), `--boxes <a,b,c>` text prompts for the detector,
`--box-threshold <n>` (0.02), `--dir <a,b>` to narrow the sweep, `--limit <n>`,
`--no-seal` to look without sealing, `--host <url>`.

## The key

`ROBOFLOW_API_KEY` comes from the environment, else from the worktree's `.env`,
which is gitignored and never printed. The publishable key, the OAuth client id
and secret and the workspace id live in the same file. Only the private API key
is used here; the serverless endpoints take it as a query parameter.

## What it calls

| Endpoint | Answers |
|---|---|
| `POST /doctr/ocr` | the text in the frame, line by line |
| `POST /clip/compare` | which of the candidate labels the frame looks like |
| `POST /yolo_world/infer` | boxes for the prompted objects, with confidence |

All three are `https://serverless.roboflow.com`. On a free plan the detector
answers `402 credit_cap_exceeded`; the lane then seals a single
`observer.blocked` receipt carrying the API's own message and stops, so the
ledger can show p4 blocked rather than silently empty. 401 and 403 behave the
same way.

## What it writes

- `<image>.observer.json` beside each PNG: the OCR lines, the CLIP verdict, the
  boxes, the image `detection_sha256`, and the receipt the run sealed.
- one `observer.evidence` receipt per image in the root store, with
  `ocr_sha256`, `boxes`, `box_labels` and `detection_sha256` in its sources.
- `companion/boards/observer.board.json`: one sheet per screenshot and one shape
  per detection, each shape carrying the receipt id and hash. Slate 3D renders
  it beside the ledger's slabs (four sheets stand, the rest stay in the file).

Seals run the canonical CLI (`npx tsx src/cli.ts seal <subject> --meta k=v`)
with this checkout as cwd. The committed `.timmy/store-pin` resolves the root
store from any cwd, worktrees included, so the chain stays pinned.

## Local inference + the bus subscriber (shelf-w6d3 step 2)

`lanes/observer/subscriber.mjs` moves the observer off the serverless plan and
onto Roboflow Inference running locally in Docker, and makes it a subscriber:

```
docker run -d --name timmy-inference -p 9001:9001 --env-file <file with ROBOFLOW_API_KEY> roboflow/roboflow-inference-server-cpu:latest
timmy observer doctor                            # is the server up, do doctr and yolo_world answer
timmy observer subscribe [--once] [--every 15]   # tail the root store; any receipt naming an image/video artifact → observer.evidence
timmy observer backfill --dir renders/observer/trailer-v17 --source "…"   # every frame in a folder → evidence + observer.coverage
timmy observer frames <video> --out <dir> [--fps 1]                       # ffmpeg frames for a video
timmy observer coverage                          # artifacts named by receipts vs observed → observer.coverage
```

The subscriber keeps a cursor and an observed-set in `.timmy/cache/observer-subscriber.json`;
a video artifact is split into 1 fps frames (capped at 90) and each frame is
observed. On the CPU server doctr OCR takes ~18 s and yolo_world ~16 s per
frame, and a dropped connection is retried three times. A backfill is
resumable: a frame whose receipt is already in the store (cursor or store
scan) is not observed twice. The API key is only used to download model
weights into the container; the images never leave the machine.

Backfilled on 2026-09-07: trailer v17 (63 frames) and the 30 s deck cut (30
frames), each closed by an `observer.coverage` receipt.
