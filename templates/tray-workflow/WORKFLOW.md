# Tray workflow: change, inspect, result

One request carried through Timmy: a local code agent changes the tray recipe's parameters, the recipe
rebuilds as a durable job and a separate worker reads its STEP back, VoxVision inspects the STEP the
rebuild exported, and the operation's card says what happened, each part checked against its receipt.

Run it in the REPL with `/run WORKFLOW.md result` (the board's Run does the same). Each block runs
`timmy act`, which joins the operation of that run (through `TIMMY_OPERATION`), so the flow, the agent's
run, the rebuild, the readback, the VoxVision record and every receipt carry one operation id, and
`/op` shows them together.

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
its job>/`. This block inspects the newest `console-tray.step` there with VoxVision: OCP reads the STEP in
its own process. It measures the CAD file, never a physical part.

```bash [name:inspect, deps:change]
step=$(ls -t out/recipes/*/console-tray.step 2>/dev/null | head -n 1)
if [ -z "$step" ]; then echo "no console-tray.step in out/recipes/ yet: the change block delivered none"; exit 1; fi
timmy act "/inspect $step" --wait
```

## The result

The operation's card: the request, this workflow and its blocks, the flow with its verdict and its
steps, the STEP with its sha256, the VoxVision record about it, and the lessons that name them.

```bash [name:result, deps:inspect]
timmy act '/op' --wait
```

A lesson block comes here, after `result`, once Timmy Memory's lessons are merged.

Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.
