> Reference from frozen Study 03. Local source links remapped; historical capability claims are not renewed.

# Study 03 · Part A — A small, testable spatial stack for Timmy

The next useful step is a complete materialize-and-inspect path with explicit evidence. Timmy should preserve the plan, route a bounded operation, inspect the actual result, and return a card whose claims can be checked. Adding every available SDK would make that path harder to qualify.

This document prioritizes 21 technologies in [the machine-readable map](technology.json). **First / Next / Later means integration priority, not readiness.** The catalog combines current primary documentation with the study team's local audit. No new dependency was installed and no paid generation or deployment was run for this research.

## What the status labels mean

| Status | Evidence it represents | What it does not establish |
|---|---|---|
| Candidate | A documented capability fits a proposed Timmy job. | Installation, authorization, or a working integration. |
| Source present | Relevant source or package is present in the audited scope. | A successful execution path. |
| Local study exercised | A bounded operation ran in this study. | Production integration or broad correctness. |
| MCP read responded | The current native surface answered a read. | Authoring, export, or automatic dispatch was tested. |
| Historical qualification | Earlier retained work exercised an integration. | Its current environment is ready. |

Current study checks distinguish several cases. Spline's 3D scene read and Hana's 2D canvas read responded; this turn did not retest authoring. CadQuery, Open3D, and the Three.js workbench were exercised in bounded local work. The canonical Viser/FiftyOne runtime path is absent despite historical results. The canonical root lacks the tldraw dependency, and the referenced mission-map assets are missing. The canonical OpenRouter client package is installed at version 0.12.35; the separate Agent SDK package was not found. These observations should travel with the status labels instead of being collapsed into a green “connected” badge.

## First: one source, one operation, one measurable result

Start with a parameterized object and a fixed camera. Record the requested dimensions and coordinate convention. Produce the native object and an exported preview, inspect both, then show the comparison.

1. **Plan:** retain shape properties and actual arrow bindings. tldraw's binding records preserve relationships as shapes move; Timmy must assign execution meaning and validity rules. An arrow's visual proximity is insufficient. [tldraw bindings](https://tldraw.dev/sdk-features/bindings)
2. **Construct:** use the qualified local CadQuery path for dimensional fixtures; separately qualify a narrow Spline mutation against a bound document. Keep STEP/CAD and scene-native measurements distinct from tessellated previews. STEP export exposes explicit internal and output units. [CadQuery API](https://cadquery.readthedocs.io/en/latest/classreference.html)
3. **Inspect the export:** add glTF Transform for validation and inventory before optimizing anything. Keep the original artifact; a preview with simplified geometry is a new derivative. [glTF Transform CLI](https://gltf-transform.dev/cli)
4. **Inspect the view:** use the existing Three.js workbench and add bounded BVH queries if ordinary queries become insufficient. Record the camera and queried frame. A ray hit can establish a geometric obstruction, while transparency and perceived legibility require different checks. [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
5. **Return evidence:** attach measurements and their tolerances to the source revision. Hana can present that evidence; a polished frame does not establish correctness of the object it describes.

Spline's MCP is a desktop bridge serving 3D and Hana surfaces. It routes to the most recently focused matching tab, making document binding and serialized mutations a practical integration requirement. Keep the bridge local and expose a narrow Timmy operation if remote coordination is later needed. [Spline MCP documentation](https://docs.spline.design/generate/spline-mcp-server)

The first fixture should fail visibly when a dimension changes, a camera is wrong, or a stale artifact is returned. A useful acceptance condition is: the inspector can identify which source revision, native object, export, camera, and measurement produced every displayed claim. This is a proposed Timmy acceptance condition, not a vendor guarantee.

## A dependency budget

This is a proposed implementation budget for the first integration slice, not an assertion about the current dependency tree.

| Area | First-slice budget | Why |
|---|---|---|
| Browser viewer | Reuse the exercised Three.js workbench; at most one geometry-query addition. | One camera/selection model is easier to test than several competing viewers. |
| Export handling | At most one new artifact-processing package: glTF Transform. | It answers concrete validation and inventory questions. |
| Native construction | Reuse the qualified study runtime, pin its versions, and expose one bounded worker. | Keep environment failures separate from geometry failures. |
| Agent orchestration | No new agent framework required for the first deterministic operation. | The existing Timmy boundary should remain responsible for dispatch and receipts. |
| Hosted services | None required for the local fixture. | Establish semantics before introducing distributed recovery. |
| Observation storage | Existing receipts plus a small typed projection. | Avoid building a database platform before queries demand it. |
| Viewer integrations | Qualify one additional inspector at a time. | Display bugs must not silently change the meaning of evidence. |

Rerun is useful for aligning retained data and view configuration; its recording and blueprint have separate roles. Address the retained clear/forward-fill discrepancy before presenting its display as authoritative. Replaying a recording should be labeled as inspection of recorded data. [Rerun blueprints](https://rerun.io/docs/concepts/visualization/blueprints)

Viser can become the specialist inspection surface when transform controls or spatial interaction justify restoring its runtime. FiftyOne can become the review library when there are enough captures to curate. Neither needs to be a prerequisite for the first returned card. Embedding choice matters for FiftyOne similarity; the historical Timmy adapter's pixel descriptors should not be called semantic search. [Viser](https://viser.studio/main/), [FiftyOne Brain](https://docs.voxel51.com/brain/index.html)

## Next: add capabilities in response to a measured need

**Geometry operations:** Manifold is a useful mesh-Boolean option when a task needs it. It expects manifold input and can reject invalid meshes. Use CadQuery for parameterized CAD solids and Manifold for solid mesh operations; retain provenance across their boundary. [Manifold documentation](https://manifoldcad.org/docs/html/)

**Physical observations:** begin with a calibrated camera and a measured AprilTag. Calibration supplies camera intrinsics and distortion; the tag gives a known reference for pose estimation. Retain reprojection error, tag size, calibration identity, and coordinate conversions. This provides a controlled first physical experiment without claiming a reconstructed room. [OpenCV calibration](https://docs.opencv.org/4.13.0/dc/dbb/tutorial_py_calibration.html), [AprilTag pose estimation](https://github.com/AprilRobotics/apriltag#pose-estimation)

**Point-cloud comparison:** extend the exercised Open3D study only when there are relevant measured point clouds. ICP refines a rough alignment and produces fitness/error measures. Report the initialization, thresholds, and residuals; a plausible overlay alone is not enough. [Open3D ICP](https://www.open3d.org/docs/release/tutorial/pipelines/icp_registration.html)

**Multi-run analysis:** export typed observations for DuckDB queries, use Arrow for interchange, and Parquet for analytical batches. Keep this dataset rebuildable from original receipts and artifacts. It can answer failure-rate and regression questions without replacing FiftyOne's visual review interface. [DuckDB and Arrow](https://duckdb.org/docs/current/guides/python/sql_on_arrow), [Parquet support](https://duckdb.org/docs/stable/data/parquet/overview)

**Execution diagnosis:** add a few OpenTelemetry spans around intent compilation, dispatch, native execution, capture, and inspection. Use operation IDs and artifact references to connect those spans to the receipt. OTel carries causal context across processes; it is not the receipt authority. Keep private payloads out of propagated baggage. [OpenTelemetry context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)

**Agent work:** use the installed OpenRouter client for qualified model requests before adding another loop. The documented Agent SDK is a separate package with tool execution and conversation-loop primitives. If adopted, it should propose or call bounded Timmy operations rather than bypassing the executor. Provider charges and downstream tool charges need separate accounting. [OpenRouter Agent SDK](https://openrouter.ai/docs/agent-sdk/overview)

OpenHands becomes useful when a repair task needs its workspace and execution model. Its core SDK, common tools, extended workspaces, and remote server are separate packages. Give it one failing fixture and an isolated repair scope; do not give two frameworks competing responsibility for the same retry or conversation loop. [OpenHands architecture](https://docs.openhands.dev/sdk/arch/overview)

**Delivery surfaces:** Hana is an editable interaction layer with states and events; its native AI uses workspace credits. Instatic offers semantic HTML/CSS edits and a mix of server reads and browser-bridged operations. Keep their document assertions separate from browser-rendered assertions, and qualify export/render behavior before making either a universal delivery target. [Hana AI](https://docs.spline.design/hana-a-canvas-for-interactivity/ai-in-hana), [Instatic agent interface](https://github.com/CoreBunch/Instatic/blob/main/docs/features/agent.md)

## Later: three deliberate deferrals

1. **A universal OpenUSD migration.** Introduce a USD lane when Houdini/Unreal composition needs layers or variants. USD uses namespace paths, so it will not automatically solve persistent object identity. Keep Timmy's canvas and receipt contract independent. [OpenUSD introduction and limitations](https://openusd.org/release/intro.html)
2. **Full reconstruction or SLAM.** The next physical pilot needs controlled calibration and observations. Broader reconstruction should follow a defined dataset and measurable registration task, not precede them.
3. **Blanket ONNX conversion.** Select one frequent vision model with a demonstrated latency or deployment problem. Qualify its model conversion, preprocessing, execution provider, accuracy, and cost individually. Runtime support across several accelerators does not guarantee every model runs equivalently. [ONNX Runtime providers](https://onnxruntime.ai/docs/execution-providers/)

Cloudflare Agents and Durable Objects fit a later need for durable sessions, queued work, and reconnecting clients. Define one authority for job transitions before deployment. Desktop authoring and GPU inference still belong on qualified execution hosts. [Cloudflare Agents](https://developers.cloudflare.com/agents/)

## Costs and operational boundaries

Most proposed geometry, query, and inspection components can run locally without a hosted service. Their cost is integration effort, package compatibility, CPU/GPU time, memory, disk, and maintenance. Optional acceleration adds device-specific qualification. Camera work also needs a real capture setup and calibration effort.

Hosted agents, model calls, and native AI generation have separate billing surfaces. Cloudflare Durable Objects meter compute and storage; connection behavior can affect duration charges, and hibernation helps occasional updates. Do not assume an idle-looking dashboard is cost-free. No price estimate is needed before there is a measured workload. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

For every adapter, agree on these boundaries before adding autonomy:

- **Identity:** source document, source revision, native object IDs, and an explicit mapping to exported objects.
- **Geometry:** units, axes, handedness, transforms, camera intrinsics/projection, and tolerance.
- **Evidence:** original bytes, derivative relationships, timestamps and source clocks, algorithm/model versions, and measurement scope.
- **Execution:** one owner for retries, idempotency, cancellation, and terminal job state.
- **Presentation:** distinguish measured results, model judgments, predictions, and human review. Mark stale evidence when its source changes.

The practical milestone is one card that can show its source, reproduce its inspection from retained inputs, explain a failure, and remain honest when a native surface or runtime is unavailable.
