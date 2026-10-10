# Tray workflow starter

A project that carries one request through Timmy as one operation: change the tray, rebuild it, read
it back, inspect its STEP, and see the result.

| File | What it is |
|---|---|
| `WORKFLOW.md` | the workflow (upmd): its prose says the request; its blocks are `change`, `inspect` (needs `change`) and `result` (needs `inspect`) |
| `recipes/tray.params.json` | the CadQuery tray recipe's parameters (enclosure.tray/1, millimetres): the recipe card's defaults |

## Run it

```
/project new mytray --from tray-workflow
/workflows WORKFLOW.md          the document, its blocks and its last runs
/run WORKFLOW.md result         change, then inspect, then result
/op                             the operation in full; /ops lists the recent ones
/board live                     the same on the board: the operation's card tops the Control Room
```

`/run` predicts the order (change → inspect → result) and seals that prediction before upmd runs a
block. Each block runs `timmy act "<command>" --wait`, which waits for what the command started and
exits 0 when it succeeded, 1 when it failed or differs, 2 when it was refused (a missing tool, a busy
project) and 3 when it was stopped; a block that exits otherwise than 0 stops the chain.

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
