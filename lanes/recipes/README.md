# Timmy recipes

The `enclosure.tray/1` recipe exposes `list`, `plan --request FILE`,
`build --request FILE`, and `jobs` through `timmy recipe`. The normal TypeScript
build emits the recipe CLI, worker and runtime modules into `dist`; the asset
copy step delivers only the reviewed recipe card and native build script.
Compiled commands use Node directly, without `npx` or the `tsx` development
loader. Relative request paths and `.timmy` job state belong to the caller's
workspace. Source development still supports
`node --import tsx lanes/recipes/cli.ts` with development dependencies installed.
The existing unmerged spatial foundation prototype is left intact.

Offline package controls exercise the actual compiled bin and dispatcher,
planning, zero-wall refusal, queued lifecycle, source drift, and a signed
missing-native-runtime failure. An optional `TIMMY_RECIPE_PACKAGE_INSTALL`
fixture lets the same controls inspect a separately unpacked artifact with
production dependencies. These controls establish recipe runtime delivery;
they do not qualify native geometry or establish a complete release. Native
qualification, other prototype commands, and general release validation remain
separate gates.

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
CadQuery itself remains synchronous. Commands preserve the caller workspace:

```
timmy recipe jobs enqueue --request request.json
timmy recipe jobs start JOB_UUID
timmy recipe jobs status JOB_UUID
timmy recipe jobs cancel JOB_UUID
timmy recipe jobs recover JOB_UUID
```

Enqueue persists a validated request, request/source hashes and a private signing
identity under `.timmy/recipe-jobs/JOB_UUID`. Start returns after launching a
detached supervisor; status reports queued/running/succeeded/failed/cancelled/
interrupted plus progress and the result receipt pointer. Every job has its own
workspace and receipt stream; these are not shared root seals. No installation
or model/provider call is involved. POSIX process groups are currently required. Compiled workers need no
`tsx`; source development workers and TypeScript fixture executors use it.

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
and private synthetic receipts. `tests/recipe-package.test.ts` compiles the real
bin and dispatcher into an isolated runtime without development dependencies,
checks caller ownership and installed source hashes, observes actual worker
closure, and verifies the missing-runtime failure receipts. The fixture blocks
non-Node subprocesses; network denial is supplied separately by the smoke-run
harness. Neither suite runs CadQuery or qualifies geometry.

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

Status and recovery freshly verify every retained result receipt/hash, including
cancelled and failed jobs. If an artifact or recorded reference changes, they
return interrupted without a result pointer and retain the original metadata;
an intact cancelled result keeps its cancelled lifecycle. Job reads also compare
the embedded signer with the existing workspace key without creating or caching
an identity. These are custody consistency checks, not protection against a host
that can replace the entire workspace and its keys.

## Retained Study 03 inspection

`timmy inspect <question>` reads the caller workspace's retained Study 03 scene,
or the receipt selected with `--receipt ID`. Supported questions are `clearance`,
`frame`, `empty spaces`, `arrows`, `bore A`, and `coverage`. The compiled inspector
and its scene/store modules are delivered by the normal build and use Node plus
the existing production `zod` dependency. Source execution resolves its optional
development loader from the repository while preserving caller paths.

Inspection does not run the observer, rebuild geometry, or execute an arrow.
Frame and unit options change the display transform only; the original observed
timestamp is retained. The 2 mm wall-gap calculation is analytical, and neither
that gap nor the four empty-space envelopes establishes a complete tool path or
physical validation. Missing or changed retained sources return unavailable.

`tests/inspect-package.test.ts` exercises the actual compiled bin with private,
explicitly synthetic signed contract fixtures, including missing/tampered
sources and the under-2 mm refusal. It compares installed and caller evidence
bytes after reads. Those signatures and 72 fixture checks test the reader; they
are not new native observations. The existing reader's individual signature and
source-hash checks do not establish full-chain custody or an independently
trusted signer, and this delivery change does not expand that evidence boundary.
