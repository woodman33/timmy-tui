# Tray workflow starter

A project that carries one request through Timmy as one operation: change the tray, rebuild it, read
it back, inspect its STEP, and see the result.

| File | What it is |
|---|---|
| `WORKFLOW.md` | the workflow (upmd): its prose says the request; its blocks are `change`, `inspect` (needs `change`), `result` (needs `inspect`) and `lesson` (needs `result`: a draft lesson with this run's records as its evidence) |
| `APPROVAL.md` | a guided approval example: one harmless block whose command deletes a file it made, so the REPL asks first in a NEEDS YOU box |
| `recipes/tray.params.json` | the CadQuery tray recipe's parameters (enclosure.tray/1, millimetres): the recipe card's defaults |

## Run it

```
/project new mytray --from tray-workflow
/workflows                      the two documents and their blocks
/workflows WORKFLOW.md          the document, its blocks and its last runs
/run WORKFLOW.md lesson         change, then inspect, then result, then a draft lesson
/lesson check <id>              the lesson checked against its records and receipts
/op                             the operation in full; /ops lists the recent ones
/board live                     the same on the board: the operation's card tops the Control Room
/run APPROVAL.md tidy           a NEEDS YOU box: y runs the block once; n, Esc or Enter deny it
```

`/run` predicts the order (change → inspect → result → lesson) and seals that prediction before upmd runs a
block. Each block runs `timmy act "<command>" --wait`, which waits for what the command started and
exits 0 when it succeeded, 1 when it failed or differs, 2 when it was refused (a missing tool, a busy
project) and 3 when it was stopped; a request that made no change exits 0 while the last build still
matches its recorded inputs, and 4 when that build is stale. A block that exits otherwise than 0 stops
the chain.

The `inspect` and `lesson` blocks find this run's own evidence by the run's operation id, with
`timmy evidence step`, `timmy evidence flow` and `timmy evidence vox --of <file>`: the STEP this run's flow
delivered, its flow record and the VoxVision record of that STEP, each only while its bytes are the ones
recorded and a receipt on the runs chain seals the record that names them. Another run's files are never
taken, however new they are; with no record of this run, the block says why and stops. The lesson's
sentence follows how the flow ended (`timmy evidence flow --outcome`): a readback is named only when one
ran; a request that made no change says so, with the flow whose check found the last build current.

`timmy op <operation id>` shows one run in full (its request, Timmy's verdict, each block's exit, the
prediction beside each check, its files, receipts and next step); `--summary` prints it as Markdown, and
`--save` keeps that summary beside the operation's record.

`APPROVAL.md` shows what Timmy asks before a risky block: its prose says what the NEEDS YOU box is, that
`y` allows the block once, and that the board will not run it (its Run is refused, with the line to type
in the REPL instead). None of `WORKFLOW.md`'s blocks needs a person.

## What it needs

- upmd on PATH (`brew install rezigned/tap/upmd`), and `timmy` on PATH for the blocks.
- A local agent route for `/iterate tray`: Qwen Code with a model your local endpoint serves
  (`TIMMY_AGENT_MODEL`), or `--agent codex` with a model your local Ollama already lists.
- `TIMMY_CADQUERY_PYTHON`: a Python with CadQuery and Open3D, for the rebuild, its readback and the
  STEP inspection.

What is missing is said as it is met, with the step that sets it up; nothing is installed for you.

## Edit it

- The request is the instruction in the `change` block of `WORKFLOW.md`.
- The parameters are yours to edit too: `/edit recipes/tray.params.json`, or the board's parameter
  card. The file is checked by the recipe's own rules; one it refuses is never replaced quietly.

Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.
