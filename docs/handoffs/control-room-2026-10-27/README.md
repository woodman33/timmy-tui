# Control Room research handoff — 2026-10-27

**Owner:** timmy-new-3 for this research packet; Claude for shared Timmy host implementation. **Status:** behavior contracts, integration research and historical fixture checks. The standalone preview is retired as visual direction.

**Approved UI foundation:** Card Lab's actual sleek silver, black and blue Rive/tldraw UI for main Timmy, its site and TUI. Other mini-apps remain related offshoots with their own identities; Animator may keep its brighter yellow identity. Preserve workflows and useful layouts. [The operator's exact visual direction](UI-DIRECTION.md) governs this handoff.

This packet is based on shared integration revision **37fa0cba217e89472d6c1475e6cfffbcc8438168** (`r13/integration`). It adds only this directory. The empty-panel and host-theme fixes already present at that revision are outside this handoff. Reconcile the current integration tip before implementation.

Start with [approved visual direction](UI-DIRECTION.md), [the behavior implementation slice](IMPLEMENTATION-SLICE.md), [source findings](SOURCE-FINDINGS.md), and [CAD candidates](CAD-CANDIDATES.md). The original [fixture reducer](room-model.mjs) is technical support material, not production UI code.

## Historical fixture material

The old HTML and screenshots are retained to preserve the completed research. Their amber/monospace presentation is not approved product design and is no longer promoted here as a preview. Use Card Lab's actual runtime and native components as the visual reference. Historical fixture results at commit `6d59be54853e9b902836fd970797843b503256f9` remain intact; this later direction update changes the handoff, not those recorded observations.

No private project, creative asset, financial record, credential, account identifier, provider response, raw session or private receipt is included. The fixture identities and amounts are synthetic. Private raw observations and failures remain outside the repository.

## Behavior checks

Run the deterministic scenarios from this directory:

```sh
node room-scenarios.mjs
```

The retained browser capture script documents the prior disconnected fixture checks. It is not a request to build another standalone demo. Apply the behavior contract through the existing shared host and approved Card Lab visual family.

[CHECKS.md](CHECKS.md) records commands, source hashes, expected/observed results and limits. The 11 reducer/file-replay scenarios and 16 browser controls are fixture checks. They do not establish production authorization, concurrent writers, durable crash safety, provider cancellation or billing guarantees.

## Scope and holds

The host integrator owns jobs, registry, frame, Files, canonical receipts and the single Treg connector. App owners retain their apps. Stream Studio remains unassigned/not built at the cited base. This research packet does not assign a new app owner or start its implementation.

The current operator authorized this side-branch handoff push. Merge, release, tags, deployment, purchases and new paid runs remain held. Agent Archive stays disabled. This packet does not append to a shared receipt chain.
