# Evidence admission controller

`src/evidence/admission.ts` supplies a controller-owned, single-run evidence boundary and an OpenRouter SDK `cite` tool factory. It is not a claim that application callers or legacy evidence fields have been migrated.

A trusted caller creates the controller with its current source revision, a fresh revision reader, and each evidence field's permitted kind, object and optional region. Completed trusted observation callbacks register the actual handles. Exporting the response schema or citation tool freezes that registry; the caller must deliver this exact schema and tool to the same model run.

The SDK tool's execute closure records each successful citation. Model-authored success flags and reconstructed tool transcripts cannot register citation success. Final admission consumes the exact raw model response, checks run/revision binding, handle membership, uniqueness, relevance and observed citations, then closes the run. Empty, stale, foreign, uncited, duplicate or invalid evidence is unknown/refused. Later citations cannot repair a refused answer. Duplicate JSON property names are refused without silently overwriting evidence.

The caller must privately retain `snapshot()` and the raw response through its authorized persistence path. This module does not write receipts, call providers or establish semantic truth. Admitted references remain subject to independent claim verification; native digital measurements do not establish physical properties. Existing vision evidence remains fail-closed until its actual tool path is migrated.

Development checks: `tests/evidence-admission.test.ts` exercises the installed SDK execute path and negative controls; `tests/forge-vision-feed.test.ts` protects the existing refusal boundary. No live-model or full application qualification is implied.
