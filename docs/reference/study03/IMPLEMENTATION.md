> Reference from frozen Study 03. Local source links remapped; historical capability claims are not renewed.

# Study 03 · Part B · Implementation sequence

The next production increment is a shared, verifiable account of **which feature, in which frame, measured by which query, at which revision**. Timmy already has typed recipes, native measurement checks, signed receipts, retained spatial reports, and matching CLI/HTTP reads. Extend those seams.

This document is an implementation proposal based on read-only inspection of `<workspace>`. No production source was changed, no runtime was installed, and no native operation, inference, deployment, or test suite was run for this audit. Existing test names below are acceptance precedents, not fresh passing results.

The standalone Study 03 interaction uses `timmy.study03.report/1` for its frame, empty-space, and shared-report demonstration. Its calculated values are demonstration output. It is not a native observation, a production materialize lane, or a rewrite of the closed `timmy.spatial-run/1` contract.

## What is already available in source

- [SpatialRun](../../../src/vision/spatial/types.ts:16) distinguishes digest domains and records scene head, physical units, world-frame ID, handedness, up-axis, and sampled time. Activity, observation freshness, plan authority, native lease authority, measurement, held-out evaluation, independent replay, and physical validation stay separate.
- [The spatial service](../../../src/vision/spatial/adapter.ts:21) verifies projections and artifact bytes. [The store](../../../src/vision/spatial/store-adapter.ts:61) verifies retained source/manifest bytes and matching signed custody. [CLI](../../../src/vision/spatial/cli.ts:44) and [HTTP](../../../src/vision/spatial/routes.ts:17) use the same getter and display-age calculation.
- [The observer](../../../src/vision/spatial/observer.ts:55) handles explicit clears and original component times. It rejects incomplete history, conflicting duplicate identities, reversed clocks, and incompatible context; model-inferred data cannot become native observation merely by entering this reducer.
- [Recipe compilation](../../../src/vision/spatial/recipes.ts:27) normalizes physical units and binds fixed source to parameters. [Native verification](../../../src/vision/spatial/recipe-runner.ts:44) checks dimensions, placement, volume, topology, and material binding. [Outcome compilation](../../../src/vision/spatial/outcome.ts:100) and its runner keep prediction, required outcome, execution, and retained evidence distinct.
- [The visual integration runner](../../../src/vision/integrations/runner.ts:50) records intent before dispatch, uses a fixed adapter, bounds execution and output, retains failures, hashes artifacts, and signs results.

The bounded source search did not find a production semantic feature registry, general cross-surface frame graph, or `hana.frame` / `spline.scene` / `cadquery.part` action. A Blender foundation recipe must keep its actual engine identity; it is not a CadQuery integration.

## PR 1 · Feature, frame, and query coverage

Add proposed `src/materialize/types.ts`, `frames.ts`, and `coverage.ts`. Keep the existing spatial schema compatible. A semantic feature has its own identity, source document and revision, source shape identity, and mappings to native object identities. Renames and reparenting change attributes. Duplication, replacement, splitting, and merging record their own identity/lineage events.

Each coordinate must identify its frame. A frame mapping declares dimension, origin, basis, transform direction, units, handedness, and source identity. Existing [world helpers](../../../src/vision/spatial/world.ts:113) cover specific geographic and up-axis mappings; they are not a general canvas-to-camera frame graph.

**CSS pixels are not millimetres.** SpatialRun currently permits only mm/cm/m; its existing observer is narrower still, using metres and Z-up. A Hana frame or browser rectangle therefore belongs in an explicit 2D document/CSS frame contract. Conversion to physical dimensions requires declared scale or calibration. Camera projection also needs its declared camera model. Device pixel ratio alone does not supply physical scale.

Seal the query's expected coverage before execution: required subjects/components, checker and adapter versions, queried items, exclusions and reasons, unavailable items, and snapshot identity. Existing dependency-query validation checks the queries supplied in a report. It does not establish that every feature relevant to a user claim was queried. An empty or partial query inventory must not mean a complete pass.

Acceptance:

- Rename/reparent preserves feature identity; duplication changes it; native delete/re-create cannot reuse old evidence accidentally.
- Known transforms round-trip with declared tolerances. Unit, up-axis, handedness, missing-frame, and singular-transform controls have independently specified expected results.
- Pixel-to-metre conversion without scale/calibration is unsupported. Changing mapping, source revision, coverage, or checker version changes the seal.
- Missing queries stay unknown; excluded regions are visible in the report. Existing SpatialRun fixtures remain unchanged and valid.
- Demonstration reports cannot enter the production evidence store as native observations.

## PR 2 · Read-only shared inspector

Add proposed `src/vision/spatial/presentation.ts` and a thin companion consumer such as `src/companion/spatial-inspector.ts`. Use the existing spatial service and currently admitted retained reports first. The same display view-model should power the canvas card, browser inspector, and terminal output: selected identity, original capture time, age, coverage, measurements, deltas, evidence, and independent result states.

An event announces that a result may have changed. The consumer fetches and verifies the result before displaying it. Preserve the existing sequence/digest conflict rules and original acquisition timestamp. A recent refresh is not a recent observation.

Do not expand artifact serving implicitly. [The current artifact route](../../../src/vision/spatial/routes.ts:24) treats active HTML/SVG as downloads. Start with admitted JSON and image evidence. If a live Hana/Instatic preview is later needed, use a separate isolated preview surface with a bounded interface; its runtime display does not replace the retained output hash.

Acceptance follows [service parity](../../../tests/spatial-service.test.ts:121) and [eleven presentation states](../../../tests/spatial-presentation.test.ts:12):

- CLI, HTTP, canvas, and inspector agree on digest and each independent status.
- Repeated reads do not append receipts, alter timestamps/files, or launch tools.
- Stale evidence stays stale. Older hints do not roll state back. Equal sequence with different digest is a conflict.
- Missing, changed, linked, or cross-run artifacts fail consistently; projection validity alone does not imply verified evidence.
- Unknown measurements stay unknown. A refused action preserves the previous scene.

## PR 3 · One bounded native materialize lane

Add proposed `src/materialize/runner.ts` and `src/materialize/adapters/hana.ts`. Hana is the first new external lane because one frame gives a bounded document, object inventory, and export to inspect. Follow with `adapters/spline.ts` after the same identity, failure, and retention contract is demonstrated. Preserve the deterministic geometry recipe path throughout.

The typed action binds actual source shape properties and arrow bindings, source revision, destination document, lane/checker version, frame mappings, prediction, required query coverage, and effect. It records intent before dispatch. The adapter creates one new native result, reads actual native state back, measures it against the declared prediction, retains exports/previews, and returns feature mappings and receipt references.

Use native revision/head checks where the surface provides them. A document ID alone does not establish atomic compare-and-edit. Where the native surface lacks that guarantee, record the limitation, serialize the admitted writer, and verify before/after identity. Preserve existing [dispatch authority](../../../src/utils/dispatch.ts:141) and any native lease boundary; agents do not mint approval tokens.

Acceptance follows [outcome admission tests](../../../tests/spatial-outcome-runner.test.ts:128):

- Changed bounds, element count, arrow binding, source revision, destination, or checker invalidates the seal.
- Wrong document or stale expected head is refused when the native surface supports checking; unavailable atomicity is not advertised as passed.
- Tested retries/concurrent requests create at most one result per admitted intent. An uncertain response is reconciled against retained/native operation identity before another create attempt.
- Native readback, not predicted values copied into the result, determines the outcome. Missing objects, incomplete coverage, and failed exports remain failed or inconclusive.
- Artifact tampering invalidates inspection. Evidence reuse is labeled reuse. Existing recipe/outcome behavior and tests remain intact.

No ready CLI commands are specified here because these new lane interfaces do not yet exist in the canonical source. Discover the current native surface before writing its concrete adapter; do not invent endpoint or tool names.

## PR 4 · Trace and evaluation, then continuity where needed

Add proposed `src/materialize/observation-export.ts` and `cohort-export.ts`. Feed Rerun verified changes with original component times, explicit clears, source snapshots, query coverage, and receipt identities. Keep native sample time, capture time, ingestion time, and display cursor separate. The retained [Rerun audit](../../../docs/evidence/rerun-study-20260910/local-review.md:49) found an unresolved filled-query clear discrepancy; Timmy's clear-aware state remains the authority for this projection.

Use Viser only when interactive 3D review adds value to a selected admitted GLB. Use FiftyOne to review exact images and failure cohorts, including native outcome, feature/scene identity, model observation, and human review. The existing adapter's pixel descriptors are appearance comparisons; semantic embeddings or model training require separate work. Split held-out scenes or recipe families before choosing related frames.

Use Roboflow or Cosmos for declared perceptual questions and retain uncertainty. Native object/DOM queries and geometry/simulation tools retain their measurement roles. Cosmos3-Edge's existing adapter is a Reasoner; the separate Generator is not an enabled production operation.

Add remote continuity only if interruption/restart evidence establishes a need. Reuse Timmy's existing bus, companion, Cloudflare, storage, and receipt primitives. Durable job identity and checkpoints should coordinate local/native execution without pretending that a Worker is a desktop renderer or GPU runtime.

Acceptance:

- Clear/re-add, stale, missing, reordered, and dropped-event controls do not revive old values or invent fresh timestamps.
- Every frame/model observation resolves to exact bytes, scene/feature identity, query coverage, and a receipt. Screenshot similarity never becomes a geometry certificate.
- Duplicate images and scene families do not leak across held-out splits.
- Optional runtimes pass a bounded operation before use. Historical qualification remains separate from current readiness.
- If remote continuity is added, restart/reconnect/cancel/uncertain-response tests create no duplicate native edits; unchanged state triggers no repeated inference.

## Current installation and UI caveats

Read-only package-file inspection found root `@openrouter/sdk` 0.12.35, React 19.2.6, Ink 7.0.3, Zod 3.25.76, and OpenTUI 0.5.10. Root `@openrouter/agent`, `tldraw`, and `@rerun-io/web-viewer` installations were absent. The existing [agent tool seam](../../../src/agent/vision-integration-tools.ts:1) uses `@openrouter/sdk/lib/tool.js`; newer Agent SDK documentation is not that installed API.

The canonical `studio/tldraw-mission-map/index.html` references CDN tldraw 3.15.0 / React 18.3.1 and local `app.js` / `styles.css`; those two local files were absent during this audit. Do not describe this page as a ready production canvas. The separate interactive Study 03 artifact is not evidence that this canonical UI is implemented.

The configured analytics executable under `studio/platform-expansion-20260910/analytics/.venv/` was absent; the telemetry executable under `.timmy/venv-platform-telemetry/` existed. September 10 documentation describes historical Viser/FiftyOne/Cosmos qualification. Presence of source, an old successful run, or an executable path is not a current readiness pass. No fresh probe was run here.

## Branch and review sequence

Use four small, dependent PRs in the order above. Suggested branch labels, not branches created by this study: `study03-contract`, `study03-inspector`, `study03-hana-lane`, and `study03-observation-export`. Each PR should state the concrete behavior, the existing seam extended, the new limitations, and the exact checks actually run. A later Spline lane can be a separate PR after the Hana contract is accepted. Remote continuity should remain a separate PR if it becomes necessary.

Preserve the canonical repository's shared-tree rules: inspect current changes, stage only owned paths, never discard another agent's work, and append receipts only through the existing locked writer. Version new contracts explicitly; do not silently widen the current closed spatial schema. Run the appropriate existing contract/service/observer/outcome suites for the code changed, plus the milestone's new acceptance controls. Keep screenshots of demonstration UI distinct from receipts of actual native execution.
