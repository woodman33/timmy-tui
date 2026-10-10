# F1 prospective acceptance freeze

Status: **prospective; acceptance not run; no CLEARED verdict**. Author: timmy-new-2. Builder: timmy-new-3. R0.2 freezes these expectations before F1; R2 verifies the delivered candidate. This file is not a receipt, a fabricated model citation, or a claim that the implementation exists.

Authority: private ORDER spacelang-v7k2 §§2–5, 7.1–7.4, 7.6, 8–10; operator amendment A1, especially item 5; AGENTS §§4–8; DOCTRINE “NEGATIVE CONTROL,” “KEEP ASSERTION,” and “GEOMETRY IS A LEDGER”; decisions D3. DESIGN §9 remains protected. ORDER SHA-256: `b810840d0236d4a8f67a75ccd29b2f2d79a0e3695ab230c9c4240d673968ab7d`. A1 SHA-256: `fd37d86224661fe5d2d69bc2b4fb1234a6cf91e9846bfe2711dc0d577e67452a`.

Inspected reference commit: `76d3e23fac9e82032535194e5739189cae4734ba`. This identifies the existing contracts used to author the freeze; it is not the future F1 candidate. At that revision no F1 proto tree or F1 acceptance runner was observed. No toolchain, generator, test, or runtime success is asserted by this document.

## 1. Candidate binding and permitted scope

Before the builder starts F1, retain and publish this file's SHA-256 and verifier commit. Before the one qualification run, freeze a separate execution manifest naming the full builder commit SHA, base SHA, source-tree digest, this freeze's digest, fixture and checker digests, dependency locks, executed tool versions, command argv, expected statuses, and protected-state preimages. The manifest completes concrete execution bindings; it must not weaken any expectation below. Missing bindings mean `INCOMPLETE / HOLD`.

Resolve `F1_HEAD` to the exact committed candidate, not a floating branch. Check `git rev-parse HEAD` equals it before and after acceptance. Reject a dirty candidate, a moved revision, or a fixture/checker changed after the execution freeze. Rebase or a new candidate requires a new prospectively bound run; an old PASS cannot transfer to a new head.

F1 builder outputs are limited to the native owner's authorized schema and generated-code paths, buf configuration and locks, a new `.github/workflows/native.yml`, and additive `.gitignore` build-output lines. Existing application source, governance, existing workflows, release gates, existing job implementation, and shared receipt stores remain protected. Any needed exception is declared before work under its actual authority; this freeze grants no exception.

## 2. Expected delivered artifacts

| ID | Required output and observable acceptance |
|---|---|
| F1-01 | Protobuf schema of record under `proto/timmy/space/v1/`, with no hand-maintained duplicate schema claiming authority. Buf configuration resolves all imports and pins generator/dependency identities. |
| F1-02 | Generation produces TypeScript in `proto/gen/ts`, Rust using prost, Go with Connect service bindings, and Python. The complete generated-file manifest is retained. An isolated clean regeneration matches committed output bytes; generation must not silently skip a language. |
| F1-03 | CUE definitions imported from the protos plus explicit semantic constraints, and an exercised `cue vet` step. Wire serialization accepting a value is not semantic acceptance. CUE validation precedes any downstream execution; no execution occurs in F1. |
| F1-04 | `native.yml` actually runs buf lint, buf breaking, code generation/drift detection, and CUE import/validation. Required failures cannot be hidden by `continue-on-error`, unconditional success, or a path filter omitting the changed schema. |
| F1-05 | `.gitignore` gains `target/` and `crates/*/pkg/`. All pre-existing lines remain byte-preserved in order; no removal or weakened pattern. |
| F1-06 | Cross-language fixture round trips retain typed values, explicit presence/absence, enum semantics, signed coordinates, source revision, hashes, and opaque canonical receipt bytes. No claim of cross-language byte-identical protobuf serialization is required. |
| F1-07 | A public handoff maps every requirement and negative control to actual retained results, including not-run controls, with exact candidate/freeze hashes. Only public node IDs appear; raw private details stay in the private overlay. |

## 3. Semantic contract

**SceneIR.** Represent Space, Frame, Datum, Region, Object, Part, Feature, Profile, Constraint, Relation, Observation, Judgment, Materialize, Proof, and HarnessPresence, plus Capability, Job, and SpatialReceipt. Identity and reference fields must bind objects/regions to source revisions. Frames retain declared units, origin and basis. Evidence states retain declared, constructed, checked, inferred and stale; failed/missing are distinct UI outcomes, not upgrades of evidence. Provenance retains measured, reconstructed with unchecked scale, and generated. A model-proposed relation remains a proposal; an established relation needs a geometric method, tolerance, scope and admitted voxel references. The schema must represent approval-bound materialization without manufacturing approval.

**Voxel.** Represent `timmy.space.voxel/1`, 5–4–3 topology and 512-value leaves; signed int32 coordinates/origins; frame, units (`mm`, `cm`, `m`), positive finite voxel size, orthonormal right-handed basis, channel schema identity and source revision. Record channel declarations in order. State has UNKNOWN=0, FREE=1 and OCCUPIED=2. An unallocated region or absent channel is not evidence of free space. Weight zero implies UNKNOWN; FREE needs observed positive weight and positive distance. Keep occupancy, fill, uncertainty and physical density as distinct concepts.

Channel semantic widths are state u8, tsdf i16, weight u16, rgb u8×3, instance label u32, fill u16, normal i8×3, feature_ref u32, and optional sigma u16. Proto's wider storage types do not relax these ranges; CUE checks them. Per-leaf metadata represents provenance, evidence state, observation count u16 and 32-byte source-set hash. Header and source-set digest lengths and declared channel cardinality/order are validated. Raw producer values remain distinct from Rust-quantized ledger values; quantization is Rust-only, round-half-even, with declared scales/clamps and nonfinite inputs refused. F1 declares this contract; canonical hash vectors and Rust arithmetic qualification belong to F2a/F2b.

**A1 uncertainty.** Sigma is optional, unsigned 16-bit, **1σ in micrometres**. Absence means **not recorded**. Preserve the distinction between absent sigma and a present channel containing zero values in every generated language and the JSON mapping. Producers supply raw per-voxel σ for Rust quantization; a producer must not silently pre-quantize. The sigma declaration participates in channel-schema identity/order. F2a must freeze a vector with sigma and one without it. Neither a zero code nor a 1 mm voxel size establishes physical accuracy. Dimensions represent ± uncertainty and its fiducial-scale, calibration-residual, edge-localization and sensor-floor budget; no physical measured:true assignment is permitted while the benchmark is unapproved.

**Evidence.** Use exactly native_readback, calibrated_observation, deterministic_computation, source_declaration, machine_inference and generated_hypothesis as evidence kinds. Provenance and evidence state are inherited, never promoted by a model. Schema carries run identity, source revision, object/region scope, raw model response and refusal without loss. Admission must continue through the existing `createEvidenceAdmission` controller: a static protobuf string field or model-supplied `cited:true` does not authorize a reference. Every model-authored evidence field draws from the constrained enum of handles actually observed for that run/revision and requires a successful observed `cite(handle_id)` execution. Empty observations yield unknown/refusal. This document records no observed evidence handles and invents none.

**Jobs.** Declare `timmy.job/2` and Submit, Status, Cancel, Recover and a streaming Progress API. Preserve durable job/operation ID, source/document revision, request identity, lifecycle state, progress, result/receipt references, timestamps and failure/cancellation/recovery information. States are queued, running, succeeded, failed, cancelled and interrupted. Recovery must represent verified completion versus an unknown interrupted outcome without requesting automatic replay of a completed native edit. F1 proves transport/schema representation, not a running durable service or cancellation behavior. Existing `timmy.recipe-job/1` and `enclosure.tray/1` remain supported and untouched; adoption happens in F4b-ts.

**Capabilities.** Represent each rung from declared through configured, files-present, interpreter-runs, sdk-imports, smoke-run, observed-operation, qualified and deployed, with timestamp and supporting reference identity. Higher rungs remain untested without observed evidence. License tier is commercial, research-only, needs-license or verify, with sources. Public eligibility must not default an absent/unknown tier to commercial. F1 does not install or qualify the registry or license gate.

## 4. SpatialReceipt and detached run journal

The envelope maps to the existing JSON receipt contract in `src/utils/receipts.ts`; signature input remains the existing recursive canonical JSON body defined by `canonicalBody` in `src/utils/signing.ts`. That function excludes `hash`, `prev_hash` and `signature`, while retaining signer; do not confuse its recursive signing bytes with the separate receipt hash calculation. Protobuf transport must preserve the original canonical JSON bytes, original receipt identity/hash/signature, inherited evidence/provenance and source revision. A reserialized proto object must not become a new signed authority form.

Every space action can retain harness and model separately, approved public node ID, room, job ID, and source revision. Root-bearing envelopes additionally retain root, header/hash, leaf count, changed-leaf count and producer versions. Optional fields remain optional; absent data cannot be replaced with a successful outcome. Canonical receipt bytes must round-trip unchanged through all four bindings, including optional fields, Unicode and nested objects.

The verifier's checkpoint-local journal records command identity/argv, start/end, expected and actual exit, stdout/stderr artifact digests, semantic outcome, candidate/freeze/checker/fixture hashes, and preservation results. These are deterministic execution records, not model-admitted spatial claims. If a result includes such claims, the actual admission snapshot, actual successful cite transcript and raw response/refusal are mandatory. No fabricated handles, synthetic success bits or rewritten labels.

The verifier neither calls `appendReceipt` nor runs `timmy seal`. Detached hashes/journals are not signed chain receipts. Only the authorized single writer may later seal retained artifacts; F1 clearance does not claim that sealing occurred.

## 5. Prospective commands and expected exits

Commands below run in the isolated candidate checkout with `F1_HEAD`, `F1_RUN` and concrete fixture/schema paths bound by the execution manifest. They have **not** been executed by authoring this freeze. The manifest must provide executable argv for each semantic/round-trip case before qualification; an unavailable checker is `not-run`, not an inferred PASS. Command syntax references: [CUE proto import](https://cuelang.org/docs/reference/command/cue-help-import/) and [buf breaking against an image](https://buf.build/docs/reference/cli/buf/breaking/). These references do not establish an installed version or a completed run.

| Command or frozen command family | Expected exit and required observation |
|---|---|
| `git rev-parse HEAD` and `git status --porcelain=v1` | 0; exact F1_HEAD and no candidate modifications. Record before and after. |
| `buf lint` | 0; no lint diagnostics. |
| `buf build -o "$F1_RUN/candidate.binpb"` | 0; complete descriptor image retained and hashed. |
| `buf generate` | 0; all four language outputs exist and match the frozen manifest. Compare regenerated bytes against independent copies of committed outputs. |
| `cue import proto <frozen proto inputs/options>` | 0; the execution manifest expands all inputs/options, retaining complete generated CUE. |
| `cue vet <frozen CUE package/files> <positive JSON fixture> -c` | 0 for each positive case, including sigma present and absent. |
| `cue vet <same frozen CUE package/files> <invalid JSON fixture> -c` | 1 for each semantic negative, with the expected field/rule diagnostic. A different error, missing file or tool failure is not a passing rejection. |
| `buf breaking --against "$F1_RUN/base.binpb"` | 0 for candidate vs the actual frozen schema base, if a prior schema exists. No prior schema: record historical compatibility not applicable; exercise the deletion control below against the candidate descriptor as a prospective base. Never count candidate-against-itself as historical compatibility proof. |
| `buf breaking --against "$F1_RUN/candidate.binpb"` in a detached negative schema copy | 100 for a removed public field or RPC, and a named breaking-change diagnostic. Pin the buf version before execution; if its documented status differs, settle and freeze that exact expected status before the first run, never after observing a failure. |
| `git check-ignore target/f1-probe crates/timmy-space-wasm/pkg/f1-probe` | 0; both paths reported ignored. No output fixture needs to be written. |
| Frozen four-language codec and independent contract-checker argv | 0 on positive cases. The checker exits 1 for each intentionally defective semantic case and identifies the case/rule; its test driver exits 0 only after observing that intended failure. Preserve both exits. |
| `git diff --check` | 0; no whitespace errors. |

Missing dependencies, unbound argv or unresolved generator paths stop only qualification as `INCOMPLETE / HOLD`; they do not authorize a substitute compiler, a success claim, or a post-run expectation change. Runtime service tests, Rust golden vectors, WASM proofs and physical measurements are later checkpoints and reported outside F1 scope.

## 6. Frozen case matrix

Each row runs on an isolated synthetic fixture, never the primary schema or private capture. One-variable mutation from a retained valid preimage is required. A negative control passes only when the intended defect is rejected for the stated reason. All rows are required; a missing row is not-run and blocks clearance.

| Case | Defect or positive control | Expected semantic outcome |
|---|---|---|
| P01 | Minimal valid SceneIR, each noun/reference, valid right-handed frame | Accept and round-trip without lost identities, units or tags. |
| P02 | Valid 512-value leaf with sigma absent; same valid leaf with sigma present including boundary codes 0 and 65535 | Both accept; absent remains not recorded and cannot become numeric zero. |
| P03 | Each job request/response/state and two Progress messages | Schema round-trip retains job/revision binding and stream cardinality. No runtime lifecycle claim. |
| P04 | Existing synthetic canonical JSON receipt wrapped and unwrapped in every language | Exact signed-form bytes and receipt metadata retained. |
| N01 | FREE voxel with weight zero; unallocated region presented as observed-free | Reject each independently; no emptiness claim. |
| N02 | Encoded ledger sigma -1 or 65536; sigma unit other than micrometres or other than 1σ | Reject each independently at semantic validation. Raw producer values are a separate pre-quantization contract, never silently treated as already encoded u16 values. |
| N03 | Decoder/model treats absent sigma as zero or advertises voxel spacing as accuracy | Contract checker fails; absence/physical-accuracy distinction is mandatory. |
| N04 | Missing source revision/frame/units; nonpositive/nonfinite voxel size; nonorthonormal or left-handed basis | Reject each independently; diagnostic names the offending rule. |
| N05 | Channel width overflow, wrong 512-value cardinality, malformed digest length, unknown enum, inconsistent channel declaration/order | Reject each independently; do not truncate, clamp silently or coerce to defaults. |
| N06 | Missing provenance tag; model inference promoted to calibrated/native evidence; model-only relation treated as established | Reject; retain proposed/inferred status or explicit refusal. |
| N07 | Property label used as evidence handle; fabricated/unobserved handle; observed but uncited handle | Existing admission refuses each, preserving raw output and exact refusal. No static schema acceptance can override it. |
| N08 | Handle from another run/revision, current revision changes, wrong object/region/kind, duplicate handle, empty observations | Existing admission refuses each. Tests obtain any positive handles by actual observe/cite execution, never handwritten IDs. |
| N09 | Proto receipt round-trip alters signed bytes or changes result/job/source binding; invalid signature or tampered byte | Independent receipt contract check fails; no new signature or rehash repairs the fixture. |
| N10 | Job payload silently downgrades to legacy version, loses cancellation/interruption, changes job/revision identity, or claims recovery replay is safe without readback | Semantic/round-trip check fails. Existing legacy source remains unchanged. |
| N11 | Remove an existing field/RPC from the detached schema baseline; bypass a required CI step | Breaking check detects removal; workflow contract check fails bypass independently. |
| N12 | Generated output is missing one language, manually changed, or regeneration drops presence | Manifest/byte/round-trip check fails the exact affected path/value. |
| N13 | An absent/verify/research-only license is treated as commercial; unobserved capability advertised qualified | Contract check rejects the promotion. No gate deployment claim. |
| N14 | Shared-chain write, protected-file change, private machine value in public artifact, preimage missing, or source head moves | Preservation/privacy/binding gate fails; no clearance. |
| N15 | measured:true before benchmark approval, LiDAR-only precise card measurement, missing uncertainty budget, or caliper value outside the claimed ± interval | Reject each physical qualification claim. F1 may represent a failed/unknown observation without claiming it qualified. |

## 7. Preservation and verdict

Before qualification, retain complete independent preimages of the freeze, execution manifest, checker, fixtures, dependency locks, generated outputs, existing contracts, and every protected file the run can reach. Record path, typed entry, length, mode and SHA-256. For symlinks preserve and compare exact link text. For directories retain a canonical sorted typed membership/metadata manifest including empty directories. Classify special files without reading them as regular data; unsupported preservation stops the affected check. Prospective absence is recorded too. Hashes alone do not substitute for preimages.

Keep all run-generated material in the declared isolated run directory. Record protected source membership and compare retained bytes after the run; preserve pre-existing and concurrent work without absorbing it. For any reachable live receipt journal, retain complete pre-run bytes and original length N; compare the first exactly N bytes directly against that independent preimage. Truncation/prefix changes fail. Retain a concurrent suffix separately and validate complete boundaries/parsing/IDs/order/chain requirements; do not attribute its writer without independent evidence. No suffix means suffix validation was not exercised. Prefer not exposing the shared store to the run at all, and record that isolation.

Retain stdout, stderr, command statuses, descriptor images, all input/output bytes, admission snapshots and refusals, first differences, and preservation comparisons under a unique run identity. Private raw records stay private; public results carry relative paths, hashes and approved node IDs only. Never rewrite a failed result, repair a fixture, edit the expectation or automatically rerun after qualification begins. A subsequent attempt needs separate authority and a new retained run; it cannot erase the first.

**CLEARED** requires all in-scope artifacts, positive cases, negative controls, current-head bindings and preservation checks observed passing against this freeze. **FAILED / HOLD** follows any genuine semantic, preservation, privacy or binding failure. **INCOMPLETE / HOLD** covers unavailable tools/artifacts, unbound commands and unrun cases without a failed gate. The report names the exact case, expected/actual exit and first relevant difference. Missing evidence remains unknown. No outcome here lifts other historical HOLDs, approves the benchmark, establishes physical accuracy, deploys a service or authorizes a shared-chain write.
