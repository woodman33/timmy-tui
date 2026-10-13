# Tray workflow: change, inspect, result

One request carried through Timmy: a local code agent changes the tray recipe's parameters, the recipe
rebuilds as a durable job and a separate worker reads its STEP back, VoxVision inspects the STEP the
rebuild exported, and the operation's card says what happened, each part checked against its receipt.

Run it in the REPL with `/run WORKFLOW.md lesson` (the board's Run does the same), or `/run WORKFLOW.md result`
to stop before the lesson. Each block runs
`timmy act`, which joins the operation of that run (through `TIMMY_OPERATION`), so the flow, the agent's
run, the rebuild, the readback, the VoxVision record and every receipt carry one operation id, and
`/op` shows them together. The blocks that need this run's records ask `timmy evidence` for them, by that
same id: another run's files, however new, are never taken.

## The request

The instruction in the `change` block is the request: edit it here, in this document. The local agent
may change only `recipes/tray.params.json` (width, wall, supportOffset and bore, in millimetres, within
the recipe's ranges); if it changes anything else, the flow stops before the build and nothing is
reverted. It runs only a local, free agent route (Qwen Code, or Codex with a local model).

```bash [name:change]
timmy act '/iterate tray "make the tray 150 mm wide"' --wait
```

## Inspect the STEP the rebuild exported

Once its signed result verifies, the rebuild copies its exports into `out/recipes/<first 8 characters of
its job>/`, and the flow's record names the STEP it delivered, with its sha256. This block asks for that
STEP with `timmy evidence step`, which finds this run's flow by the run's operation id, never by a file's
time, and gives the STEP only while its bytes are the ones the flow recorded and a receipt seals the flow's
record. When the request made no change and the flow's check found the last build current, it gives that
build's STEP. When there is none, it says why and the block stops. VoxVision then inspects the STEP: OCP
reads it in its own process. It measures the CAD file, never a physical part.

```bash [name:inspect, deps:change]
step=$(timmy evidence step) || exit 1
timmy act "/inspect $step" --wait
```

## The result

The operation's card: the request, this workflow and its blocks, the flow with its verdict and its
steps, the STEP with its sha256, the VoxVision record about it, and the lessons that name them.

```bash [name:result, deps:inspect]
timmy act '/op' --wait
```

## Keep a lesson

A lesson is a sentence kept with the records that show it. This block adds a draft lesson whose evidence
is this run's flow record and the VoxVision record of its STEP, each found by the run's operation id with
`timmy evidence` (`vox --of` takes the record about that STEP's bytes). Its sentence says only what ran,
by how the flow ended (`timmy evidence flow --outcome`): when the flow changed the tray, that its STEP
readback and the VoxVision inspection confirm the change; when the request made no change, that nothing
was rebuilt or read back, and that the flow's check found the last build current. Edit the sentences to
say what you learned. `/lesson check <id>` (or Check on the board) checks it against those files and
their receipts; only a checked lesson is given to a later `/iterate tray` as context, and
`/lesson eval <id>` compares runs before and after it. No model is trained.

```bash [name:lesson, deps:result]
flow=$(timmy evidence flow) || exit 1
outcome=$(timmy evidence flow --outcome) || exit 1
step=$(timmy evidence step) || exit 1
vox=$(timmy evidence vox --of "$step") || exit 1
case "$outcome" in
  succeeded) lesson="A tray size change by /iterate tray is confirmed by its STEP readback and by a VoxVision inspection of the exported STEP." ;;
  "no change") lesson="This tray request made no change: nothing was rebuilt or read back. The check of flow $(basename "$flow" .json) found the last build current, and VoxVision inspected the STEP of that build." ;;
  *) echo "No lesson kept: flow $flow ended $outcome, and neither sentence here says what that run showed." >&2; exit 1 ;;
esac
timmy act "/lesson add \"$lesson\" --from $flow --from $vox --applies tray" --wait
```

Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.
