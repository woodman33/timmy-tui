# S1 checkpoint — failed, execution stopped

The single pinned local Granite workflow remained **0/1 → 0/1**. The model completed one actual inspection and its reserved final response, then cited `metric_depth` rather than `ev-b58e270067-1-96f0ce58fc`. The strict verifier correctly rejected that citation. The adapter now presents an explicit catalog of handles from successful observations, but that change did not repair the observed binding failure. Original observations and model output were not rewritten.

There were two inference requests, one tool call, no model substitutions and no retries. The focused adapter tests passed 21/21; the benchmark tests passed 15/15, including actual-handle/property-name and renamed-case/old-handle controls. These offline controls establish verifier behavior, not model success. The required live 1/1 gate was not met.

S2 through S6 did not start. There is no new `view.ground`, `route.graph`, `job.recover` or `demo.loop` seal, and no FILM-PLAN v3 capture claim. The box-with-bore remains the intended demo object.

`evidence-binding-attempt.patch` records only this checkpoint’s edits over the developed working-tree seed. That seed’s workflow files are not tracked in the shared integration branch; the review PR therefore carries a reproducible patch and frozen source/evidence rather than pretending this incomplete repair is ready to merge. Shared work was not staged, reset or replaced.

The scope was authorized LIGHT with a 15-minute cap. Doctrine references: DOCTRINE §§2–4,12,14; DESIGN.md; decisions.md. Sealing records the failure; it does not admit this implementation as a successful driver or model workflow.
