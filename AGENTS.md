# Timmy agent operating guide

MUST and MUST NOT are requirements; SHOULD is a recommendation; MAY permits work only within existing authority. Product goals describe direction, not completed capabilities or execution permission.

## 1. Purpose and product scope

Timmy is an AI-operable creative and technical workspace: intent → bounded execution → observation → independent checks → retained result → visible next action. Its scope includes fleet routing; durable jobs, anchoring, progress, cancellation, receipts and recovery; software transformations; spatial observation and authoring; page/document extraction; model/tool harnesses; Ink, Rive, companion-web, browser and terminal experiences; context continuity and durable identity. Agents MUST NOT reduce this scope to the latest verifier, voxel experiment, PR, TUI or benchmark.

The existing application is the developed seed. Microkernel/capability-DNS proposals mean a smaller control boundary and adapters around existing capabilities. Agents MUST preserve TIMMY, founder-terminal, commands, templates, projects, assets, identities, interfaces, evidence and receipts; extend additively. Dormancy or optimization MUST NOT imply deletion. Keep the incumbent during candidate evaluation; routing changes and removal are separate decisions, and removal requires explicit authority and proof of what remains under DOCTRINE §13.

## 2. Fast operating loop

1. Read this guide, [DOCTRINE](DOCTRINE.md), and the current governing order. Product intent and preservation requirements are summarized in §1; consult the optional local background in §12 when available. Reload ownership, source revision, next gate and HOLDs after context loss; do not restart historical work from a summary.
2. Classify the task using §3 and identify the exact authority permitting it.
3. Inspect the current repository and shared-worktree state, including `git status --short`. Record baseline changes without attributing them to this operation.
4. Declare allowed writes, protected paths, required evidence, stop conditions and a monotonic deadline. Scale preparation to the operation class; a trivial edit does not require a qualification ceremony.
5. When authorized, develop mutably and retain diagnostics. Follow attached plans as written and leave their files unchanged; continuation never overrides scope, failed gates or HOLDs.
6. Before claiming qualification, freeze all inputs, expected outcomes and preservation methods; capture the necessary preimages prospectively.
7. Qualify once against that freeze. On a genuine failure, preserve the result and stop without repair or automatic rerun.
8. Compare protected state, clean up owned resources and report exact results, limitations and remaining HOLDs.

## 3. Authority, operation classes and precedence

Within repository guidance, apply this order; it does not override platform system/developer instructions:

1. Explicit current operator instructions and approvals.
2. The current governing order, including its scope and HOLD conditions.
3. [DOCTRINE.md](DOCTRINE.md) and root governance contracts, including [DESIGN.md](DESIGN.md) and [decisions.md](decisions.md) in their declared domains.
4. This `AGENTS.md`.
5. Product maps, other design documents and implementation guides.
6. Historical reports, receipts and advisory research.

Lower-precedence material MUST NOT broaden higher-level authority. Historical evidence remains authoritative about what was actually observed, not permission to execute a next stage. Product maps and proposals MUST NOT restart orders or lift HOLDs. Apply an explicit operator override only within its stated scope; otherwise, when governing sources conflict, report the exact conflict and stop instead of choosing the more permissive reading.

| Operation class | Authorized behavior and boundary |
|---|---|
| Read-only inquiry | MAY inspect and answer without a qualification checkpoint unless the current order requires one. |
| Mutable implementation | MAY edit within explicitly authorized scope and test iteratively; development success is not qualification. |
| Immutable qualification | MUST freeze prospectively, preserve exact expectations and inputs, compare protected state, clean up and stop without repair on failure. |
| External or costly action | MUST have explicit authority and any action-specific confirmation for remote execution, training, paid labeling, deployment, publication, destructive changes and large downloads. Existing authorization remains valid within scope; do not ask for it again without a new decision. |
| Held operation | MUST NOT proceed until separately authorized. A component PASS does not lift the next stage's HOLD. |

## 4. Evidence and epistemic rules

- Every model-authored evidence field MUST choose from a constrained enum of actual handles observed in the current run and current source revision. Each cited handle MUST have a successful, observed `cite(handle_id)` call in that run. Reject stale, foreign-run, foreign-revision, unobserved, uncited or fabricated handles and property labels such as `metric_depth` used as evidence IDs. With no valid handle, return `unknown` or refuse. Preserve raw output and the exact refusal; MUST NOT substitute citations or rewrite failed output to obtain a pass. This is mandatory policy, not a claim that every legacy field has been migrated.
- Evidence MUST have the kind and field-specific relevance required by the claim, including object/region and revision binding. Enforce unique cited handles at admission. A valid schema or verbatim quote alone does not prove factual correctness. Use the actual controller/tool path; MUST NOT invent a model tool call for an endpoint without tool support.
- Distinguish authoritative native geometry/readback, calibrated observation, deterministic computation within declared frame/units/tolerance, model prediction or interpretation, and generated hypothesis. A lower tier MUST NOT silently establish a higher-tier claim; native digital geometry alone does not establish a physical object's properties.
- Generated images, views, masks, estimated depth, forecasts, annotations and critic estimates remain generated/model claims until independently checked. A preview is not native readback. Unknown or missing evidence MUST NOT be synthesized into geometry, emptiness, visibility, occupancy or success. **Unknown space is never empty space.**
- Geometry, solid fill, occupancy probability, opacity, mass density, humidity and physical measurement MUST remain separate typed concepts. Known location or material labels do not establish these other properties.
- Geometric artifacts MUST retain inherited provenance (`measured`, `reconstructed:scale?`, `generated`) and evidence state (`declared`, `constructed`, `checked`, `inferred`, `stale`) under DOCTRINE §16. A model's opinion cannot upgrade them; a dimension without its tag is refused at seal.
- Generated CAD may be measured computationally within declared units, frame, tolerance and verifier scope. Every future Timmy store listing and every current listing offering measured 3D work MUST carry and display DOCTRINE §15's sentence verbatim: **Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.** Physical claims require identified observations and calibration.
- A hash commits to bytes, not their truth. Fix claims MUST cite the seal or verification receipt that proves them. Seals MUST cite existing artifacts/receipts, obey pinned-store preflight and preserve orphan history under DOCTRINE §§3–4 and 14. Native events, deterministic checks, independent reproduction and physical validation are distinct claims.

## 5. Mutable development versus immutable qualification

**Mutable development:** when explicitly authorized, compiler, type and unit failures MAY be repaired iteratively. MUST retain diagnostics and reach a green development state before freezing. MUST NOT weaken protected policy or intended expectations merely to obtain a pass; candidate code cannot control evaluator policy, budgets, authority or promotion criteria.

**Before immutable qualification:** MUST freeze source, dependencies, fixtures, policy, schema, commands, expected exit statuses, protected paths and preservation methods. Acceptance requirements and negative-control expectations precede execution; threshold fitting to desired outcomes is forbidden under DOCTRINE §12. Use the repository's pinned toolchain and record the executed version; no silent compiler/dependency substitution.

**After qualification starts:** MUST NOT repair source, fixtures, expectations, policy or schema, or automatically rerun failed behavioral or preservation controls. Stop, retain raw evidence, clean up and report `FAILED / HOLD` for a genuine failed gate or `INCOMPLETE / HOLD` for unfinished work without a failed gate. A later attempt requires a separately authorized new operation; MUST NOT relabel, overwrite or repair the historical result.

Expected nonzero exits are not generic failures: a frozen negative control passes only when its expected status and semantic checks match. `A-scan-negative` exit 1 was an expected passing negative control. Reports MUST distinguish passed, failed, deferred and not-run controls; an absent or unrun check is never a pass.

## 6. Prospective preservation and receipts

Evidence needed for direct comparison MUST be captured before execution. A digest is a commitment, not a substitute for an independently retained preimage. Required original bytes MUST NOT be reconstructed from the post-state merely because its prefix hash matches a recorded digest.

| Protected domain | Required preservation method |
|---|---|
| Immutable regular file | Retain complete precondition bytes, path, byte length, mode when relevant and cryptographic hash; directly compare post-run bytes against that independent preimage. |
| Symlink | Retain exact link text and its hash; compare link text directly, never substitute the dereferenced target. |
| Directory | Freeze the canonical membership/metadata manifest method before qualification; include empty directories and typed entries. |
| Special file | Classify without opening it as regular data. Use an explicitly scoped metadata method or stop; never block on a FIFO or silently omit it. |
| Live append-only journal | Retain complete precondition bytes, original length `N` and hash; treat concurrent append state separately from immutable whole-file dependencies. |

For a live journal, MUST directly compare the first exactly `N` current bytes with the retained preimage; fail preservation on truncation or any historical-prefix change. Isolate any suffix and validate complete boundaries, parsing, identifiers, ordering and applicable chain/signature requirements under the frozen format. Prefix preservation and writer attribution are separate: claim external attribution only with independent evidence. If unchanged, report that no suffix existed; MUST NOT claim suffix validation was exercised.

Isolated qualification SHOULD use checkpoint-local journals and detached seals. The shared `.timmy/receipts/runs.jsonl` and other shared receipt streams MUST be written only through the authorized, single-writer-locked `appendReceipt` path; MUST NOT hand-edit, rewrite or erase them. Detached hashes MUST NOT be represented as signed chain receipts. If a final append is authorized, perform it after preservation comparisons and document that ordering explicitly. Do not append a shared receipt merely to document a routine edit without governing authority.

Before any seal, MUST print the resolved store path and stop if it does not match the root store pin under DOCTRINE §4. Render anchoring and cut-specific gates remain governed by DOCTRINE; this guide does not weaken or duplicate them. New contracts and views MUST preserve historical observation times, outcomes, provider identities, artifacts and seals. A later authorized governance edit does not rewrite a sealed checkpoint's retained source revision.

## 7. Shared-worktree and Git safety

- MUST operate in the current canonical checkout of the one intended repository. Resolve its root with `git rev-parse --show-toplevel` and verify the expected repository via `git remote get-url origin` before mutation; do not assume a username, home directory or fixed absolute checkout path, or invent a second “advanced” checkout. In commands and examples, use `<repo-root>`, `$REPO_ROOT` or repository-relative paths. Read current branch, commit, receipt state and runtime metadata when needed; do not reuse stale “newest commit” or receipt-count prose as live status.
- MUST inspect `git status --short` before editing and before committing. Each mutable surface MUST have one owner; reviewers do not start competing writers. Record pre-existing/concurrent changes as context without assigning authorship or including them in this operation's changed paths.
- MUST NOT use `git add -A` or `git add .`. Stage only intentionally touched paths; verify every staged path belongs to the current operation. MUST NOT commit without explicit operator authorization.
- MUST NOT use `git reset --hard`, `git checkout --`, `git clean` or a stash to remove work not created by this agent. MUST NOT overwrite, revert, attribute, delete or otherwise absorb another agent's uncommitted/untracked work. Recheck the target before writing if concurrent edits are possible.
- MUST NOT use `--no-verify`, force-push or amend commits not authored by the current operation.
- Approvals MUST be operator-minted tokens such as `timmy approve <planHash>` where required, never an agent-authored approval boolean. Receipt write discipline is defined in §6.

## 8. Jobs, software and integration boundaries

- Software shared for Timmy MUST receive a practical AI-operable path: supported API, MCP, CLI, scripting adapter, computer-use control or another exercised automation route. Investigate supported interfaces first; a summary, static viewer or manual-only UI is insufficient. Preserve native editable source and state actual capability limits.
- Spline is intended for parametric/procedural creation and editing. Blender MUST also be operated through Python APIs and executable scripts, alongside Unreal and Houdini integrations. These goals do not certify every application's adapter as ready.
- MUST maintain reusable bridges among MCP, CLI, HTTP, TUI, HTML, WebSocket, structured data and language runtimes, including at least two independently usable MCP-to-CLI routes. Shared native backends do not count as independent geometry routes. MUST report unavailable paths, dependencies, preserved properties and property-specific losses; translation MUST NOT upgrade provenance.
- Design async boundaries around synchronous/native-thread-bound workers. Durable jobs MUST retain operation ID and source/document revision across progress, results/receipts, cancellation and recovery, including visible interfaces. A wrapper does not make native internals asynchronous. Recovery MUST verify fresh readback and avoid repeating an already-completed native edit.
- MUST distinguish proposed, installed, reachable, exercised, behaviorally qualified and deployed. Package presence, a configured URL, a viewer or green component tests alone establishes no integration or deployment claim.
- The recorded root stack uses `@openrouter/sdk` 0.12.35 and its `client.callModel` agent/tool loop; MUST NOT describe it as HTTP-only. `@openrouter/agent` is not established as installed without current dependency, lockfile and package evidence. Preserve native SDK events and normalized counterparts; unavailable metadata remains unknown. See the SDK guide for isolated runtimes and their separate qualification boundaries.
- Before adopting/replacing tools, MUST inventory current tools, versions, licenses, update behavior, privacy/network boundaries and control surfaces. Advisory recommendations alone authorize no install or orchestration replacement. Pending third-party additions MUST remain in a private overlay unless explicitly authorized for the public repository.
- MUST preserve isolated runtimes and sealed house-study environments; check the installed API before following newer examples. Source timestamps, explicit clears, static/temporal distinctions and asset coverage matter in Rerun; its documented filled-table uncertainty and viewer availability do not establish authoritative scene queries or a running observer.
- MUST NOT send private financial data, account sessions, private HTML, verifier answers or protected payloads to new providers merely for convenience or price. Respect the current order's privacy, local-model and egress boundaries; a cloud-backed model tag remains cloud.

## 9. Benchmarking, leakage and the bounded verifier

- New spatial work MUST begin through the novice/medium/hard workflow in the operator-provided `docs/WORKFLOW-BENCHMARK.md`, within current authorization. That workflow is not distributed in this checkout; if it is unavailable, stop the affected spatial operation rather than substitute this summary or bypass the entry gate. Diagnose shared defects with offline controls and one pinned local model first when model use is authorized. Stop roster expansion on shared workflow failure; do not repeat a whole roster to diagnose one defect.
- MUST grade tools, connections, model interpretation, tool use and composition separately. Freeze model/provider identity, quantization, tools, budgets, tasks and splits for the claim being tested; report remaining confounds. Correct refusal can be a tool success while a bad call remains a separate model/controller event.
- MUST NOT use validation/test/held-out geometry, lineage, identities, prompts or evidence to generate or repair training scenes. Require complete protected-registry coverage before an admission-safety claim. Episode processes MUST NOT read private verifier answers, protected payloads, held-out traces or registry-private geometry. Qualification fixtures and reservations are not corpus scenes. Component PASS authorizes no collection, inference, training or fine-tuning.
- The R2-qualified bounded verifier may establish structural reuse from **exact transformed connected-component equality** or **exact transformed complete object-subset equality**. Occupied containment without either exact equality MUST quarantine. Malformed, stale, foreign, wrong-version or tampered evidence MUST fail closed; unsupported or exhausted analysis MUST quarantine. Trusted lineage is separate immutable authority evidence.
- No universal boundary, void, cavity, bridge, contact or enclosing-solid equivalence is qualified. Ambiguous semantics remain deferred unless independently qualified within an authorized operation.

Historical boundary as of this refinement: **G2.3B-R2 `PASS / HOLD` qualifies only the bounded structural verifier. G2.3B-R1 remains historically `FAILED / HOLD`; its receipt adjudication remains `RECEIPT_INTEGRITY_UNRESOLVED / HOLD`. I1 and I2 remain held pending separate authorization. Corpus: 0/48 fresh scenes, 0/64 training episodes, 0/32 validation episodes.** Refer to the sealed reports below; do not copy or revise their case tables here.

## 10. UI and product quality

The target MUST remain a polished OpenRouter + Rive experience with visible Ink/TUI state, companion/web windows, browser views, terminal-image protocols where available and ANSI fallback. Plain ASCII-only output is a fallback, not the target. Native editable outputs remain part of the product.

Before claiming UI or agent-flow readiness, MUST validate in isolated Vercel and/or Cloudflare sandboxes with comparable prompts as applicable to the flow. One exception, approved by the operator on 2026-10-07 for the UI cockpit's replay check only (REPLAY-02 in `scripts/ui/qualify.ts`, first used by C-17): a GitHub-hosted runner, a fresh virtual machine provisioned for the one job, MAY serve as that isolated sandbox. Its record MUST name the platform as GitHub Actions, never as Vercel or Cloudflare, with the runner image and its version, the run's ID and attempt, and the commit replayed, and the replay keeps its negative controls. Every other operation keeps the Vercel and Cloudflare requirement. Component snapshots do not prove a live PTY/native-job loop; terminal claims require actual terminal observations. MUST use applicable attached `create-agent-tui`, `benchmark-sandbox` and Cloudflare build/MCP skills when scaffolding agents, running remote evaluations or extending Workers/MCP, within current authority.

Cloudflare Workers, wrangler, Agents SDK, Sandboxes, MCP, Pages and email SHOULD be integrated when they materially improve the product; their availability alone is not a mandate to adopt or deploy them. Root design contracts govern visual choices; product maps and historical palettes do not silently override them.

## 11. Timeboxes, stop conditions and handoff

DOCTRINE §17 requires checkpoints of **no more than 15 minutes through reporting/cleanup, ending in HOLD**. A longer run requires an explicit standing order and sealed cap. MUST establish a monotonic deadline before substantive work, reserve reporting/cleanup time before qualification, check between phases and avoid starting a phase that cannot reasonably finish with that reserve intact. At the reserve, stop ordinary work, preserve evidence, clean up and report `INCOMPLETE / HOLD` unless an actual failed gate requires `FAILED / HOLD`. MUST NOT continue past the deadline and retrospectively claim it was met. Do not invent universal phase allocations or a full qualification ceremony for routine work.

MUST stop affected work rather than improvise when authority is missing; governing conflict is unresolved; handles are absent/invalid; source revision is stale; registry coverage is insufficient; immutable qualification or preservation fails; required preimages are missing; the time reserve is reached; scope would expand; another agent's work would be overwritten; or remote, paid, destructive or corpus work lacks explicit approval. Return `unknown`/refuse unsupported claims or quarantine uncertain geometry as required above; do not turn uncertainty into success.

On stopping, MUST preserve raw evidence, state the exact blocker and what did/did not run, clean up owned resources, retain HOLDs and propose only the smallest next decision. No repair of a frozen failure is implicit.

For substantive operations, MUST hand off the applicable status/scope, authority/order, exact inputs/revisions, commands with expected/actual outcomes, changed paths, evidence/receipt/result IDs, preservation, cleanup and time results, limitations, explicit non-authorizations and next separately gated action. Do not demand irrelevant fields from a read-only answer or trivial local edit. Keep raw evidence private where required; a public handoff is not permission to expose it.

## 12. Canonical reference map

Read detailed guides only for the active scope. Linked files are distributed repository guidance. Paths marked **local reference** name background or retained evidence that is not distributed in this checkout; they are lookup hints for an authorized local workspace, not broken public links or instructions to publish private material. Optional background is not required for unrelated code work. When an operation requires a workflow, evidence, or instructions from an unavailable local reference, stop that affected operation; absence never lifts a gate or HOLD. These references retain context and evidence; they are not fresh execution authority.

| Need | Canonical reference |
|---|---|
| Complete product intent and existing seed | §1 of this guide; optional **local references**: `docs/TIMMY-PRODUCT-MAP.md`, `docs/TIMMY-EXISTING-SEED.md` |
| Governance, visual contracts and forge decisions | [DOCTRINE](DOCTRINE.md); [DESIGN](DESIGN.md); [decisions](decisions.md); current operator order |
| Async/software transformations | [TRANSFORMS](docs/TRANSFORMS-20260914.md) |
| Spatial benchmark entry and harness boundaries | §9 entry gate; **local references**: `docs/WORKFLOW-BENCHMARK.md`, `docs/WORKFLOW-SDK-LAYERS-20260913.md` |
| Bounded structural qualification | §9 retained HOLD; **local reference**: `studio/fleet-active-20260915/g23b-r2-structural-verifier-replay/CHECKPOINT.md` |
| Historical failed R1 and unresolved receipt review | §9 retained HOLDs; **local references**: `studio/fleet-active-20260915/g23b-r1/CHECKPOINT.md`, `studio/fleet-active-20260915/g23b-r1-receipt-adjudication/REPORT.md` |
| Platform/native adapter boundaries and separate generator gate | §8 integration boundaries; **local reference**: `docs/PLATFORM-EXPANSION-20260910.md` |
| Spatial observation, seed activation and retained house work | §§1, 8–9; **local references**: `docs/SPATIAL-OBSERVER.md`, `docs/SEED-ACTIVATION-20260910.md` |
| Rerun timing, visibility and known limitations | §8 limitations; **local reference**: `docs/RERUN-TIMMY-GUIDE.md` |
| OpenHands installed-API and isolated-runtime guidance | §8 runtime boundaries; **local reference**: `docs/OPENHANDS-TIMMY-GUIDE.md` |
| CLI names, package declarations and versions | [Root package manifest](package.json); current installed metadata and lockfile |
