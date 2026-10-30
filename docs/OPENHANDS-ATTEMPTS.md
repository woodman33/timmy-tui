# OpenHands durable attempts — development checkpoint, 2026-10-27

This extends Timmy's existing real OpenHands adapter and SDK bridge. It does
not replace OpenHands or import the proposed standalone mock SDK.

Authority: William's “ok do it” following the installed-SDK review. This is
mutable implementation under AGENTS §3/§5, DOCTRINE §§2/13/16 and the existing
release/spending holds. DESIGN's separation of actions and evidence is kept;
no visual changes. decisions.md's forge restrictions remain untouched.

## What changed

- `OpenHandsAttemptStore` uses file-backed SQLite WAL and immediate transactions.
  Principal, project and operation identify a publication head. Each attempt
  binds a source revision, issued UUID and monotonically increasing generation.
- The controller records workspace and approved plan hash before launch. It
  retains the patch and result together with the publication decision. Late
  results are `superseded` or `cancelled`, never the current artifact. Duplicate
  identical completion is idempotent; conflicting or unknown tokens fail.
- The real adapter wraps existing SDK, Docker and explicit CLI execution. Its
  trusted second argument supplies lifecycle identity/cancellation; ordinary
  MCP arguments cannot supply that context or self-approve with `preApproved`.
- Existing local dispatch uses the dispatch ID as operation identity, persists
  its attempt token and revokes publication before requesting stop. Hold also
  revokes: there is no implemented OpenHands suspend/resume primitive here.
  An old completion cannot move an archived/newer dispatch into judging.
- Work checks for Docker/SDK are read from the bridge, not executed again on
  the host. Worker failure, incomplete/mismatched checks, failed pristine checks
  or a different patch cannot publish. CLI remains explicitly local execution.
- The bridge uses the installed OpenHands APIs, task-specific corrective
  feedback, a bounded iteration budget and checker timeouts. It compares
  against the original source, including staged edits and agent-created commits.
  The updated Docker image tag is `timmy-oh-runner:1.21.0-attempts-1` so an old
  cached bridge cannot silently serve as the updated implementation.

## Controller API

`runOpenHandsTask(options, lifecycle)` retains its existing approval gate.
The trusted lifecycle can supply `scope: { principal, project, operation,
sourceRevision? }`, `signal`, and `onAttempt`. Source revision is read from
the seeded workspace and checked when a revision was requested. Reuse the
operation ID for retries; default standalone calls get a fresh operation.

`cancelOpenHandsAttempt(dir, token)` reopens the durable store and revokes an
issued attempt even after a controller restart. Results expose `attempt` and
`publication`. Read the current patch through `store.current(scope)`; inspect
retained attempts with `store.attempts(scope)`. Staging metadata permits
inspection of interrupted work; it does not automatically resume a worker.

Default store: `<controller dir>/.timmy/openhands/attempts.sqlite`. The Docker
worker mounts only its disposable workspace, not this database. The existing
dispatch path represents the local operator. A future multi-user controller
must supply its authenticated principal/project, never model-supplied labels.

## Development evidence

The retained logs in `openhands-attempts-evidence/` distinguish real controller
and filesystem work from mocked model/process boundaries. The focused suite
covers store restart, two concurrent process writers, scope/revision isolation,
forged/duplicate completion, cancellation-before-kill, late publication,
nonzero worker exit, spawn failure, MCP authority and dispatch cancellation.
Bridge tests run real disposable Git/checker commands with a fake conversation;
installed SDK 1.21.0 imports and signatures were inspected without a model call.

These tests are development evidence, not an immutable qualification or a
signed release seal. No launch/deploy/publish/tag/global install or paid call
was performed. Existing package.json/package-lock.json changes are unrelated
and preserved. No UI, Rive asset, existing receipt-chain code or private project
was changed. The Model Studio layout relay remains a separate queued task.

## Limits that remain

- This is a publication controller, not complete effect journaling, deterministic
  SDK replay, calibrated vision or voxel/geometry verification. Patch hashes
  identify bytes; they do not prove correctness.
- Cancellation revokes publication durably. Stopping containers and descendant
  processes is still best effort, not a guarantee that external effects cease.
- Execution receipts describe execution; `openhands.publication` separately
  states whether its result became current. Their writes are not one transaction;
  SQLite remains publication authority after an event/receipt delivery failure.
- The workspace can contain agent-modified tests. Pristine patch acceptance is
  a portability check, not an independently protected evaluator. Untracked new
  files are not captured by git diff and require a later artifact-manifest path.
- SDK/CLI host engines share the operator's OS authority. Tokens and SQLite
  are not a security sandbox; the default Docker boundary must be retained.
- Existing frontier spend configuration is not a provider-enforced reservation
  system. Release/spending holds remain; this checkpoint makes no paid-call claim.
