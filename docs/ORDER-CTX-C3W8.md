# ORDER ctx-c3w8: sealed spatial context and local model calibration

Timmy can now retain a bounded spatial context pack, give that evidence to an installed local Ollama model, anchor its admitted annotations to an object/revision/camera, and retain suggested construction changes as proposals. The document is never edited by a proposal. The order branches from post-train main `ca04b1d75631d4ffe946f25869493c69e97204f1`.

The proof uses one deterministic generated OpenVDB fixture: 1,000 addressed cells, with sampled fill, a reconstructed mesh, and unknown physical material and density. Its camera is explicitly constructed. It is not a perception benchmark or a live Spline/Hana editor integration.

## Checkpoints

| Checkpoint | Contract | Evidence |
| --- | --- | --- |
| C1 | Seal the existing local guard as a negative control; observe the fallback path | `studio/ctx-c3w8/C1/` |
| C2 | Immutable `context.pack`; object + source revision + camera anchors; reject Granite's ungrounded citation | `studio/ctx-c3w8/checkpoints/C2/` |
| C3 | Predictions before 24 local trials; frozen rubric; per-model context lift | `studio/ctx-c3w8/checkpoints/C3/` |
| C4 | Fresh authoritative byte read, typed dry-run diff, sealed stale refusal | `studio/ctx-c3w8/checkpoints/C4/` |
| C5 | Actual Rerun `.rrd` and Viser `.viser` files, native readback checks, hashes in the seal | `studio/ctx-c3w8/checkpoints/C5/` |

The user released HOLD. Checkpoint predictions and outcomes remain retained. C3's separately timed model blocks each met 15 minutes, but its aggregate checkpoint took 16m 1.286s: a **61.286-second budget overrun**, retained in a failed checkpoint receipt. Existing unrelated UI/template failures and CI policy remain outside this order. Omma has no confirmed MCP contract; its exports-only path remains with CC2.

## Use the connection

From the repository root after `npm ci` and `npm run build`:

```sh
node dist/timmy.js vision spatial volume inspect studio/spatial-volume-20260912/grid10/manifest.json --cell 5,5,5
node dist/timmy.js vision spatial models list --json
node dist/timmy.js vision spatial pack studio/spatial-volume-20260912/grid10/manifest.json --camera docs/examples/ctx-c3w8/camera.json --out studio/my-context
```

The last command returns `descriptorPath`, a separate file containing the artifact descriptor and its signed receipt. Use that value in place of `PACK_DESCRIPTOR` below. Choose an exact installed local tag from the catalog; no model download is performed.

```sh
node dist/timmy.js vision spatial models review-pack PACK_DESCRIPTOR --model ornith:latest --question "Describe the selected cell's location and fill. Preserve unknown physical properties." --out studio/my-review
node dist/timmy.js vision spatial propose PACK_DESCRIPTOR --request docs/examples/ctx-c3w8/edit-request.json --out studio/my-proposals
```

The example proposes changing the declared box side from 80 to 82 mm. It retains the diff and a proposed document hash. Rebuilding geometry and applying the edit would require a separate operation with another revision check. There is no apply command in this order.

Retained Spline/Hana MCP envelopes can be inspected with `spatial models context SOURCE --kind spline|hana --object ID`. This preserves their own units and parent coordinates; it does not claim a live document revision or native camera capture. The sealed pack factory currently admits the generated analytic volume fixture family only. The provenance vocabulary is `measured|reconstructed|generated`; this factory does not upgrade source declarations into measured evidence.

Three SDK tools expose local model discovery, bounded context reading and local review to Timmy's existing agent. The direct spatial CLI calls Ollama locally. Timmy's general agent still has OpenRouter as its primary provider; registering local tools does not make that outer agent or the whole machine airgapped.

## What the receipts establish

Pack measurements and unknowns reproduce source-bound facts. Geometry identity includes the native volume and reconstructed surface hashes. Every admitted annotation carries object ID, source revision, camera pose and fact IDs. A wrong-object citation, changed camera, wrong revision or promotion of an explicit unknown produces a rejected annotation receipt. Source references are checked; arbitrary model prose is not thereby proven true.

C1 observes this Node process's fetch admission and Undici request creation. The actual fallback method is exercised against a controlled loopback responder; live Ollama discovery reads only catalog and metadata. The cloud-tag negative control is refused before any fetch or inference. Ollama daemon egress and whole-machine isolation are **unmeasured**, recorded as a signed finding. The general agent's earlier OpenRouter path is outside this fallback-only check.

C4 binds a relative document path to the trusted local authority root, reads its current bytes directly, compares the revision, validates scalar construction parameters and reads again before sealing. A copied old file is not accepted as the bound authority. No lease is held after that read; a later apply must recheck. The negative control advances only a disposable copied fixture between calls; the proposal function performs zero document writes.

Each artifact remains separate from its receipt. The verifier checks file digests, complete Ed25519 signatures, receipt self-hashes, ordering and calibration arithmetic. Embedded public keys prove signature consistency, not an independently authenticated operator identity. External links into the private append-only receipt stream are counted without claiming this public export is a complete chain.

## Ablation protocol and limits

Three questions ask for cell counts, the selected cell center/fill, and physical material/density/mass. Each runs with and without the pack on four installed tags: `granite4.2:latest`, `ornith:latest`, `gemma4:12b-it-qat` (the installed tag for the requested “gemma4:12b”), and `qwen3.8:27b-mlx`. Model catalog digests are retained as metadata, not a cryptographic attestation of the executing weights.

Score is grounded-correct (0–1) plus unknowns preserved (0–1), averaged over all three questions. Schema failures and failed calls score zero and stay in the denominator. Numeric tolerance is `1e-6`; relevant fact IDs must belong to the correct object. No-pack numerical guesses earn no grounding credit; legitimate no-evidence abstention can preserve unknowns. All-null physical answers with no fabricated citations can receive full credit without a pack. Correctness, references, answer coverage and unknown preservation are also reported separately.

This measures source access and adherence to the response contract on one generated fixture. It does not isolate reasoning ability, establish statistical significance, or rank general vision. Fixed model/condition order and warmup confound latency comparisons. The prediction, prompts, schema and rubric were sealed before all runs; failures were not retried or removed. Unknown preservation requires explicitly retaining all three unknown physical quantities, even on the geometry questions.

## Reproduce and verify

The 24 attempts produced the following calibration on a 0–2 composite scale:

| Installed model | No pack | Pack | Context lift | Pack failures |
| --- | ---: | ---: | ---: | ---: |
| granite4.2:latest | 1.000 | 0.333 | −0.667 | 2 response-contract failures |
| ornith:latest | 1.333 | 1.667 | +0.333 | 0 |
| gemma4:12b-it-qat | 1.333 | 1.333 | 0.000 | 0 |
| qwen3.8:27b-mlx | 1.333 | 1.333 | 0.000 | 1 timeout |

The predicted +0.5 lift for every model was not observed. Granite's failures include a nonconforming center answer and the wrong density key despite retaining null physical values. Gemma retrieved the numeric facts correctly but omitted required unknowns on the geometry questions. Qwen's packed center request returned a timeout after 239.984 seconds despite a configured 150-second abort; the cause was not established. The failed row remains in calibration. No performance gain is claimed.

Validation: 102 focused TypeScript tests and 13 native/export Python tests passed; build and both TypeScript checks passed. The complete root test run had 95 passing suites, three skipped suites and only two failures already named in CI: `tests/vision-templates.test.ts` and `tests/receipt-hotfix.test.tsx`. Neither was changed or used to gate this order.

```sh
npx tsx scripts/ctx-c3w8-verify.mts
npx tsx tools/ctx-c3w8/c1-checkpoint.ts
npx tsx scripts/ctx-c3w8-checkpoints.mts C2 studio/another-C2
npx tsx scripts/ctx-c3w8-checkpoints.mts C4 studio/another-C4
```

C3 accepts the C2 checkpoint runner's newly sealed pack payload path (with its `.seal.json` sidecar) and a new output directory. C5 accepts a Python environment with Rerun 0.37.2 and Viser 1.1.0, the C3 directory and a new C5 directory:

```sh
npx tsx scripts/ctx-c3w8-ablation.mts CONTEXT_PACK_JSON studio/another-C3
npx tsx scripts/ctx-c3w8-export.mts VISUAL_PYTHON studio/another-C3 studio/another-C5
```

Replays create new artifacts and append receipts. Never overwrite the retained evidence. The OpenVDB producer and exact macOS arm64 dependency lock are documented in `tools/spatial-volume/README.md`; ordinary package inspection does not need OpenVDB installed. The viewer exporter checks native format and serialized geometry, while visual appearance remains a separate review.
