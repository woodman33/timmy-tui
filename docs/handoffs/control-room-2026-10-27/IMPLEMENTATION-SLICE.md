# One focused slice for the shared host integrator

**Operator UI amendment (2026-10-27):** Card Lab's actual Rive UI is the main Timmy baseline. Reuse and adapt its native/editable components and interaction design with the host integrator and app owners. This packet's standalone HTML explains state/authority behavior; it is technical reference, not an approved visual redesign or a replacement for Card Lab Rive. Keep the real Rive source alongside actual integrated previews.

Extend the existing Control Room's attempt inspector with a connector-call card backed by the current jobs, operation/MCP records and canonical receipt readback. Keep the existing bus and writer. Do not duplicate the landed empty-panel/theme fixes or edit app-owner files. Governing references: root AGENTS.md §§4–8, DESIGN.md, DOCTRINE §§2–4 and 17, and decisions.md; this isolated study proposes no forge operation, theme adoption or release change.

At base **37fa0cba217e89472d6c1475e6cfffbcc8438168**, the relevant seams already exist:

- `src/jobs/index.ts`: job/operation identity, lifecycle, owner, cancellation and recovery.
- `src/code-agents/index.ts`: agent/version/model, job/operation, transcript, nullable cost and outcome.
- `src/ops/panes.ts`: shared Workbench/companion readback.
- `companion/timmy-app/src/pages/control.jsx`: existing Control Room and AgentRuns.
- `src/companion/miniapps/host.ts` and `docs/integration/REGISTER.md`: shared app host, ownership and receipt boundaries.

Reconcile the current tip before choosing exact changed paths. The proposed card is a projection of those records, not a new job store or provider execution path.

## Data and authority

Bind project, task, durable job, attempt, source revision, operation and host call identity. Provider call ID is separate and optional: a request can leave the host without returning it. Show task owner, process state, work state, artifact check and independent review separately. Requested and observed model/effort may differ; absent metadata stays unknown.

Treg is a private authenticated **host connector**, not an agent harness. Mini-apps consume a host-mediated operation. One connector owner retains credentials and both independently usable MCPorter and SDK paths. No app-specific provider login, secret in frontend state, or provider description treated as policy.

For metered work, show endpoint/parameter-bound quote, currency, quote time/expiry/source, allowance/reservation, separately reported actual charge, settlement status and host/provider call IDs. Unknown charged cost is not zero. Keep integer monetary units with an explicit currency. A reservation or request header cannot establish a universal provider billing cap.

## Replay and recovery contract

1. The authenticated host validates explicit authorization against endpoint, parameters, quote and allowance. It durably consumes a one-shot dispatch marker before external execution. A crash after that marker and before response yields unknown; local deduplication does not promise remote exactly-once execution.
2. Reconnect loads a canonical snapshot/watermark and contiguous events scoped to stream/boot, job, attempt and revision. Deduplicate stable source event identity plus payload digest. Reject conflicting identity reuse; gaps require resync. Projection replay never invokes an adapter or repeats a native edit.
3. Timeout/unknown outcome retains the reservation and actual charge as unknown until reconciliation. Use host/provider call identity or provider history where available. No automatic paid retry or top-up. If reconciliation is unavailable, retain unknown; a new paid authorization requires an explicit operator decision.
4. Distinguish cancellation requested, local teardown acknowledged, provider cancellation and settlement. A late actual charge can be recorded after local cancellation. It grants no review authority and cannot revive an old attempt.
5. A worker proposes completion. An independently authorized verifier/operator clears only the current attempt against appropriate checked outputs. Trust the authenticated principal, never a role asserted by a model, event payload, terminal prose or provider response.
6. Model-authored evidence selects only actual current-run/current-source enum handles backed by observed successful `cite(handle_id)` calls. Empty sets mean unknown/refusal. Preserve raw output and refusal; do not repair labels afterward.

The fixture reducer models these distinctions but has no production authentication, provider adapter, quote expiry implementation or fsync/concurrent-writer guarantees. `fixture_complete` is a synthetic scenario state; its evidence remains unknown. Keep it out of production imports.

## Next host verification gate

Use a counted fake adapter, authenticated-principal tests and a persistent crash/restart harness. Assert zero extra dispatches on replay/reload; conflicting duplicates refuse; stale attempts/revisions cannot close current work; worker self-clearance refuses; empty/stale/uncited handles refuse; ambiguous settlement retains reservation; cancellation preserves later settlement. Then show an actual integrated-app preview with editable source and exact revision.

This branch carries review material only. It does not authorize merge, release, tags, deployment, new provider spending or changes to another owner's app.
