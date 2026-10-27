# Fixture check protocol

Base revision: **37fa0cba217e89472d6c1475e6cfffbcc8438168**. Runtime requirement: repository `engines.node >=24`; local execution uses Node **v26.6.0**. No dependency was installed or changed for this packet. The browser runner uses the existing Playwright dependency and an explicitly selected installed Chrome. Its observed browser version is in `browser-results.json`.

## Frozen expectations

| Check | Command | Expected result |
| --- | --- | --- |
| Model and file replay | `node room-scenarios.mjs` | Exit 0; 11 passed; no provider calls |
| Actual browser controls | `node capture-study.mjs <output-directory>` | Exit 0; B01–B16 passed; zero page errors/provider calls |
| Privacy negative control | `node lanes/privacy/scan.mjs fixture` from repository root | Exit 0 only after the planted control trips the scanner |
| Repository privacy rules on staged packet | `node lanes/privacy/scan.mjs scan --staged --no-base --fail-on medium --quiet` | Exit 0; no gated findings; packet files actually scanned |
| Local secret scan | `gitleaks dir docs/handoffs/control-room-2026-10-27 --redact --no-banner` | Exit 0; no leaks |
| Frozen source preservation | Direct byte comparison to retained private preimages | All source inputs unchanged after checks |
| Scope | Compare changed paths to base | Only this packet directory |

The local secret scanner is **gitleaks 8.30.1**. The repository's separate GitHub privacy workflow pins 8.24.3 and runs its own controls/history scan. A local result does not claim that remote workflow passed.

`RESULTS.json`, `scenario-results.json`, `browser-results.json`, `blank-preview.png` and `fixture-preview.png` contain the observed packet results and actual local renders. Source preimages and raw command diagnostics remain private; their retained hashes are diagnostic commitments, not signed/shared receipts.

## Scenario coverage

S01–S11 cover worker completion proposals, worker role spoofing, independent fixture checker/verifier closure, sequence gaps, duplicate settlement, conflicting event identity, unknown charge/reservation with retry held, cancellation followed by settlement, foreign attempt/revision refusal, replayed dispatch markers and reconstruction from a fresh journal-file read.

B01–B16 cover blank startup, disabled actions, absent loaded identity, explicit fixture loading, proposal/review separation, self-clearance refusal, retry hold, late charge, duplicate cost, consistent attention state, cancellation request, gap display, stale attempt refusal, replay, clear-to-blank and reload-to-blank.

## Limits

These are local fixture checks, not production authentication, provider or application operations. There is no provider transport or credential path. They do not qualify concurrent writers, fsync/crash recovery, quote expiration, provider-side idempotency, cancellation guarantees, monetary ceilings or an integrated Timmy UI. Model evidence stays unknown; no admitted handles or model `cite` calls are invented. No remote UI sandbox readiness claim is made.

No shared host, registry, app-owner source, dependency, workflow or receipt stream is changed. Merge, release, tags, deployment, credit purchases and new paid runs remain held.
