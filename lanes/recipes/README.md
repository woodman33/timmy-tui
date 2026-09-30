# Timmy recipes

`timmy recipe list`, `plan --request FILE`, and `build --request FILE` admit
`enclosure.tray/1` as a bounded native recipe. The existing unmerged spatial
foundation prototype is left intact; this lane is available from the released
CLI without depending on that prototype's untracked files.

```json
{"schema":"timmy.recipe-request/1","recipe":"enclosure.tray/1","parameters":{"width":140,"wall":3,"supportOffset":10,"bore":3}}
```

Dimensions are millimetres. `bore` is diameter; `supportOffset` is the distance
from each exterior X/Y edge to its support and matching bore axis. Wall also
drives base thickness. Depth=80, height=30, support radius=6 and height=8 are
fixed. Input rejects unknown fields, nonfinite numbers, nonpositive wall/bore,
overlapping supports, support/wall conflicts and bores as large as supports.

Set `TIMMY_CADQUERY_PYTHON` to an installed Python executable containing
CadQuery and Open3D. No dependencies are installed automatically. Native runs
have a two-minute timeout. Each build gets a new private run directory beneath
`.timmy/recipe-runs`, a source snapshot, a signed prediction before native
execution, a signed success/failure receipt, four feature STLs and a final STEP.
The source, request, Python executable and recipe card are hash-bound; native
measurements name the CadQuery and Open3D versions. This is not a complete
hermetic dependency lock or a cross-run byte reproducibility claim.

Stable semantic feature IDs are `tray.outer` (box), `tray.cavity` (subtract),
`tray.bosses` (union) and `tray.bores` (subtract). Each records dependencies,
native bounds and, where relevant, measured cylinder axes. STEP/STL do not
preserve the parametric feature history: the request, recipe and feature report
do. No UI selection or external scene-edit authority is added.

For width 140→180, all four features rebuild; the outer/cavity X faces expand
±20 mm and supports plus bores move outward ±20 mm in X. Their Y positions,
wall and bore size remain constant. The analytical volume, bounds and expected
axis coordinates are sealed before each new native run, including rebuilds.

The original workbench's 30 aggregate checks covered three variants with ten
summary checks each. This admission strengthens that to **30 mandatory checks
per build**: 12 construction-stage checks, three final-solid checks, three STEP
reimport checks, three independent mesh checks, one stage aggregate, and eight
measured support/bore-axis checks. Missing Open3D or any check fails closed.
The runner independently compares native dimensions, analytical volume and axes
against the sealed forecast, and rehashes all five exports before success.

Run unit tests with `npm test -- --run tests/tray-recipe.test.ts`. Run the native
acceptance with `npx tsx lanes/recipes/qualify.ts` after configuring the runtime.
It builds 140 and 180, checks native motion, varies wall/offset/bore, refuses
wall=0 before native execution, and rejects a modified mesh and incomplete gate.
Each invocation adds real receipts; it is not part of the ordinary test suite.

## Queued recipe jobs

The existing synchronous `build` API is unchanged. `recipe jobs` places that
build behind a separate Node supervisor and a separate native-build process;
CadQuery itself remains synchronous. Commands work through the recipe CLI:

```
node --import tsx lanes/recipes/cli.ts jobs enqueue --request request.json
node --import tsx lanes/recipes/cli.ts jobs start JOB_UUID
node --import tsx lanes/recipes/cli.ts jobs status JOB_UUID
node --import tsx lanes/recipes/cli.ts jobs cancel JOB_UUID
node --import tsx lanes/recipes/cli.ts jobs recover JOB_UUID
```

Enqueue persists a validated request, request/source hashes and a private signing
identity under `.timmy/recipe-jobs/JOB_UUID`. Start returns after launching a
detached supervisor; status reports queued/running/succeeded/failed/cancelled/
interrupted plus progress and the result receipt pointer. Every job has its own
workspace and receipt stream; these are not shared root seals. No installation
or model/provider call is involved. POSIX process groups and installed `tsx`
are currently required.

Cancellation writes a request marker. Only the live supervisor can terminate
its own child group; a CLI never kills a PID read from disk. Partial native
artifacts remain available. A source change before execution refuses launch.
An exclusive execution marker prevents a second launch, even after a crash.
Recovery checks existing result/request bindings, the retained report, pinned
signer, prediction/result receipts and artifact hashes. A stale heartbeat or
unverifiable result becomes interrupted, with no automatic replay. A worker
lost during a native edit may leave an orphan process: inspect its artifacts;
recovery does not guess whether repeating that edit is safe. There is no
automatic global scheduler, cross-job concurrency limit or native progress
percentage; progress is the observed execution phase. This boundary does not
claim a hermetic dependency lock or new native qualification.

`tests/recipe-jobs.test.ts` exercises this lifecycle with a separate fake worker
and private synthetic receipts. It does not run CadQuery or qualify geometry.

The internal `execute` entry has its own independent exclusive marker before
any native or fixture executor runs. Direct invocation requires the existing
supervisor claim, refuses completed/cancelled/interrupted jobs, and cannot replay
a claimed execution after success, failure or a crash. The supervisor always
launches that common entry, including the offline fixture seam; cancellation
terminates its owned process group. Claim files remain as crash evidence.

Every new job workspace has its own checked store pin; a shared parent pin or
changed local pin cannot redirect its receipts. The result envelope is signed by
the workspace identity and binds the request, execution/source hashes and report
hash. Recovery verifies that envelope before the native receipt and artifact
checks, so editing a report and its unsigned hash cannot produce verified success.

Direct worker entry also establishes the private workspace and clears any Python
not bound at enqueue. Recovery rehashes the retained request, prediction and
frozen build source, and honors a pending cancellation even when native output
already exists. Cancellation does not undo completed work; partial or completed
artifacts remain retained. External installed dependencies are not a hermetic
runtime lock. Native qualification of this new worker boundary is still pending.

A cancel marker alone does not prove a lost worker stopped. Recovery with no
verified result keeps a live cancellation pending; a stale heartbeat becomes
interrupted with unknown outcome. A verified completed result can be retained
with cancelled lifecycle status, without implying that its native effects were
rolled back.
