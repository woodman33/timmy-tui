# THE SHIP v0 — story simulator

A story board (`kind: story`) holds locations, characters with role cards,
stakes and branches, and a seed. The simulator runs it turn by turn: one
character acts (an ACTOR model, first person, from its role card and what it
knows), and the SIMULATOR model, a different model, resolves the action into
what actually happens, who saw it, what someone learned privately, and how the
stakes moved. mindship-v5c2 step 6.

```
timmy sim run [--board companion/boards/ship.story.json] [--turns 4] [--sim-model m] [--actor-model m] [--project ship] [--dry]
timmy sim replay <run-id | path>
timmy sim export           # dataset behavior-v0
timmy sim list
```

## Receipts

Every turn seals one `sim.turn` in the root store with **asked** (the actor's
prompt, sha256), **known** (the filtered world the character saw, sha256),
**did** (sha256 + a 160-char preview), **stakes** (after and before, compact
JSON), **model** (`model_actor`, `model_sim`), plus `parent_turn`,
`parent_run`, `outcome_sha256`, `board_sha256`, `usd`. The texts live in
`lanes/sim/runs/<run>.jsonl` (and in the project's `out/` when `--project` is
given). `sim.run` closes the run.

The simulator model must differ from the actor model; the lane refuses
otherwise.

## Layers and nesting

Layer L1 is the crew on the bridge. At the seed's `nested.at_turn`, the
captain orders a rehearsal: layer L2 runs as a nested simulation on the chart
table. The first L2 turn's `parent_turn` is the L1 receipt that started it,
and `parent_run` is the L1 run id; later L2 turns chain to each other. Replay
walks that chain.

## Replay

`replay` reads the run's JSONL alone, finds each receipt in the root store,
re-hashes asked / known / did against the receipt, compares the stakes and
the models, checks the simulator differs from the actor, and checks every
parent citation. It prints the transcript (nested turns indented) and exits
1 on any mismatch.

## Dataset

`export` writes `lanes/sim/datasets/behavior-v0.jsonl`: one row per turn
(asked, known, did, outcome, stakes before/after, models, receipt,
parent_turn) across every non-dry run, and seals `dataset.behavior-v0` with the
row count and the file sha.

## Seed

`companion/boards/ship.story.json`: *The Handoff*. Four characters (captain,
quartermaster, pilot, stowaway), four stakes, three branches, two layers
(bridge, rehearsal). Tripo is in the fleet as detect-only for a future asset
lane; no lane calls it yet.
