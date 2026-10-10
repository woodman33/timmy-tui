# F2a prospective acceptance and leaf golden-vector freeze

**Prospective acceptance; no candidate run, no CLEARED verdict.** These two concrete leaf vectors are frozen before F2a building. Header canonicalization and global numeric bindings remain explicitly unresolved below; this file does not silently choose a wire standard. Author: timmy-new-2, R1. Builder: timmy-new-3. F2b Merkle nodes, roots, proofs, diff and tile densification are outside this freeze.

Authority: ORDER spacelang-v7k2 §§2–4, 7.2, 8–9; A1 item 5; A2 item 3; AGENTS §§4–8; DOCTRINE “NEGATIVE CONTROL,” “KEEP ASSERTION” and “GEOMETRY IS A LEDGER”; decisions D3. DESIGN §9 remains protected. ORDER SHA-256 `b810840d0236d4a8f67a75ccd29b2f2d79a0e3695ab230c9c4240d673968ab7d`; A1 `fd37d86224661fe5d2d69bc2b4fb1234a6cf91e9846bfe2711dc0d577e67452a`; A2 `ba0a764973fdab205fe99c63bf382b72a770f7d2ebe7e09fadb6a08e8c2356d1`. The canonical order files remain private and untouched. This contract builds on [F1 acceptance](F1-ACCEPTANCE.md), including sigma presence and the evidence-admission boundary.

Inspected verifier baseline: `628f308d9631ef56e636f080c2dd96371917cdd7`. No future builder revision is implied. The parent checkpoint must publish the verifier commit and this file's digest on origin before the builder starts, and the builder must cite that commit under A2. A local uncommitted freeze is not the origin sequencing gate.

## 1. Scope and binding

F2a delivers the Rust crate skeleton, validated header and channels, Rust-only raw-value quantization, canonical leaf encoding and hashing, unknown-semantics tests, and cargo test/clippy/fmt jobs in the new native workflow. Existing application behavior, JSON receipt signing bytes, jobs, v1 dense volume support, evidence admission, governing files and other workflows remain protected. This acceptance gives no permission to edit those paths. The verifier's current writes are this file, `verify/f2a/**`, and checkpoint-local ignored `.timmy/private/space/r1/f2a/**` only; there is no shared seal or receipt append.

Before qualification, retain a separate execution manifest with: exact candidate/base commits; source-tree digest; this acceptance digest and origin commit; every fixture/checker/lock digest; exact Rust/Cargo/Python and dependency identities; executable argv with exact expected statuses; isolated output/cache paths; all required preimages; monotonic start/deadline; and the finalized interface bindings. Missing bindings are `INCOMPLETE / HOLD`. A dirty or moved candidate, or changed frozen inputs, fails the binding gate. The manifest may complete concrete path/tool bindings but may not relax frozen semantics or replace these vectors.

The following are **unresolved in ORDER §7.2 and these vectors do not resolve them**:

| Binding | What remains unknown and the acceptance boundary |
|---|---|
| Header canonical bytes | Field framing/order, string encoding/lengths, unit codes, numeric representation of voxel size/basis, schema-hash bytes and revision framing. A self-consistent implementation is not by itself an independent golden answer. Freeze an authorized explicit encoding plus byte vectors before grading header hashes. |
| Channel-schema canonical bytes | Hash framing, numeric channel identifiers and declaration encoding are not stated. A schema change, including sigma presence/order, must change schema identity; the exact hash cannot yet be independently predicted. |
| Per-leaf enum bytes | State's codes are given; provenance and evidence-state numeric mappings are not. Fixture bytes below are explicitly chosen inputs, not a claim that generated=2 or constructed=1 is a globally authorized mapping. |
| Quantization policy beyond ORDER | Scales, truncation parameter representation, clamp ranges/ordering, normalization and categorical raw-value transport need declared bindings. The fixture declarations exercise a precise scale-1 case; they do not prescribe all future physical channel scales. |
| Vector scalar packing | rgb/normal are triples, but their within-channel component order is not spelled out. These vectors explicitly choose per-voxel r,g,b and nx,ny,nz interleaving. Global contract qualification requires that binding to be explicit. |
| Public adapter | No candidate F2a callable interface or test adapter was available at authoring. Bind it prospectively; do not infer success from the reference script. |

These unknowns do not prevent publication of the concrete leaf/quantization fixtures. They do prevent a claim that the complete header/schema/global encoding contract is qualified. Resolve them through a prospective addendum under the existing authority before the affected builder or qualification work; do not copy a candidate's output into expected answers afterward. A changed expectation requires a separately identified freeze and run.

## 2. Two actual frozen synthetic grids

[f2a/MANIFEST.json](f2a/MANIFEST.json) commits to the concrete JSON inputs, raw binary64 inputs, all expected quantized values, exact leaf preimages (binary and hex), and expected hashes. Manifest SHA-256: `f8e2446ac7969e8cb8c4eb3865c82b68e9b64dd6d4c4ebce8a70dcd3836b67a5`. Each grid is exactly one 8×8×8 leaf, 512 values per declared channel. Both use all eight base channels. Sigma-present adds the ninth channel; sigma-absent has no sigma declaration, values, or encoded bytes. Absence is **not recorded**, never a numeric zero.

| Frozen artifact | Sigma present | Sigma absent |
|---|---|---|
| Input | [sigma-present.input.json](f2a/sigma-present.input.json) | [sigma-absent.input.json](f2a/sigma-absent.input.json) |
| Raw f64 little-endian input SHA-256 | `d5f4c437f8c090781235e906e5cec8c8beee5b691baf8125b3ffbc02fd519709` | `4805ce474de28ac52af289a51ed8745af979dfb94439c4d08b5b6f0554b9d965` |
| Leaf preimage bytes | 11875 | 10851 |
| SHA-256 of exact leaf preimage | `a5fe40b0da5c5cec3ee1e166908e5bb5d790445d0f6e82eee5d7ae7627dbed6c` | `8e263e12f15195de885e3093fa4418fc76b9ca7028f5d844d7cd2bff06197002` |

Hashes commit to bytes, not to physical truth. These are generated synthetic fixtures. The metadata code choices are explicitly provided fixture inputs only. Neither this document nor its JSON is a model-authored evidence claim; no handles have been observed/cited in this fixture-generation run, and evidence admission remains unknown/not exercised.

Every voxel index is `i = (x << 6) | (y << 3) | z`, with x,y,z in 0…7. Thus 1=(0,0,1), 8=(0,1,0), 64=(1,0,0), and 511=(7,7,7). Nonuniform coordinates and values expose axis transposition. Channel order is `state, tsdf, weight, rgb, instance, fill, normal, feature_ref[, sigma]`. Arrays are channel-major, with each triple stored per voxel; all integer scalars are little-endian.

The 99-byte fixed prefix is exactly: byte 0x00; 18 ASCII bytes `timmy.space.leaf/1` with no terminator; supplied 32-byte header digest; three signed i32 origin values (-8,16,-24); provenance byte 2; evidence-state byte 1; observation-count u16 513; 32 source-set bytes descending ff…e0. Its length is `1+18+32+12+1+1+2+32 = 99`. No level byte, channel count, length prefix, padding or channel tag is inserted into the ORDER leaf formula. Header digests are supplied opaque values 00…1f and 20…3f, respectively; they are **not** claimed to be hashes of a canonical header. The source-set digest likewise commits to supplied fixture bytes without asserting a source-set canonicalizer.

Each input JSON includes exact channel byte offsets and widths. State is u8, tsdf i16, weight u16, rgb 3×u8, instance u32, fill u16, normal 3×i8, feature_ref u32, optional sigma u16. Leaf hash is SHA-256 over precisely the retained preimage. Do not use protobuf serialization, JSON, native-endian memory, extra leaf-level bytes or producer floating bytes as the hash preimage.

## 3. Quantization and unknown acceptance

The raw input binary is IEEE-754 binary64 little-endian in the declared channel/component order. The JSON decimals use only exactly representable integers and halves, so no text-parser tolerance is needed. These are reference transport fixtures, not a mandate that the eventual external producer transport be f64le. The candidate adapter must deliver the same raw values to Rust, with no producer-side rounding.

The fixture declares a scale of 1 for all numeric examples. TSDF raw distance is micrometres with truncation 32767 micrometres, hence one micrometre/code. Sigma raw values are **1σ in micrometres**. Other raw numeric values are fixture code units, without an inferred physical normalization. Round nearest, ties to even, then clamp to the explicitly declared fixture bounds. NaN and ±Inf are refused before any round/clamp, with no leaf hash returned. These fixtures clamp tsdf to [-32767,32767], normal to [-127,127], and unsigned channels to their represented ranges; these symmetric signed ranges are declarations for these fixtures rather than deductions from i16/i8 width. Categorical state and instance/feature references must be exact in-range integers; rounding an identifier is forbidden by this fixture contract.

Required tie observations include -2.5→-2, -1.5→-2, -0.5→0, 0.5→0, 1.5→2, 2.5→2. Declared saturation includes weight/sigma 65535.5→65535, TSDF -32768.5→-32767 and 32768.5→32767. Sigma-present includes explicit zero codes and nonzero/boundary codes; sigma-absent has no 1024-byte sigma block. Adding a zero-filled sigma block is a different input declaration and is not a valid absence normalization.

After quantization, weight=0 implies state UNKNOWN (including weights 0.5→0). FREE requires observed weight>0 and positive TSDF distance; positive distance alone does not prove FREE. A supplied FREE or OCCUPIED claim at zero weight is rejected, never hashed as known space. An unallocated leaf reports UNKNOWN and a region can report empty only when all its voxels are FREE. An absent state/weight/distance channel cannot furnish the missing observation. Sigma changes neither occupancy nor an accuracy claim; 1 mm voxel spacing is not physical accuracy. Unallocated-region semantics may be unit-tested here, but F2a must not claim that it generated or verified an unknown Merkle proof.

Header validation additionally requires declared frame/revision/units, positive finite voxel size, signed origin range, finite orthonormal right-handed basis, valid 32-byte digests, unique known ordered channel declarations and exact 512-value cardinalities. Apply the F1 representation contract; do not add silent defaults. Any numeric tolerances for basis validation must be explicit and prospectively bound, not fitted after a candidate run.

## 4. Prospective command and receipt contract

No following candidate command was run in this authoring operation. `F2A_MANIFEST` must expand every argument and bind the package/adapter names before qualification; placeholders are not runnable evidence. Use the repository's pinned toolchain. If a tool/interface is unavailable, mark not-run and HOLD rather than installing or substituting implicitly.

| Command | Expected exit / semantic result |
|---|---|
| `git rev-parse HEAD`; `git status --porcelain=v1` before/after | 0; exact bound candidate, no unaccounted modifications. |
| `python3 docs/orders/spacelang-v7k2/verify/f2a/reference.py check docs/orders/spacelang-v7k2/verify/f2a` | 0; all 13 retained fixture/manifest files match exactly. Read-only; never call `emit` during qualification. |
| `cargo test --locked -p <bound-core-package>` | 0; golden-vector and semantic test names/counts retained. No ignored required test. |
| `cargo clippy --locked -p <bound-core-package> --all-targets -- -D warnings` | 0; diagnostics retained. |
| `cargo fmt --all -- --check` | 0; formatting checks without source edits. |
| `<bound-candidate-adapter> <frozen-raw-input> <frozen-declarations> <isolated-output>` for each golden | 0; every quantized value, preimage byte and SHA-256 matches frozen files. Exact argv/API binding must precede execution. |
| `<bound-independent-checker> <positive-case>` | 0; exact rule checks succeed. |
| `<bound-independent-checker> <one-variable-negative-copy>` | 1 with the named intended mismatch/refusal; a wrapper test may exit 0 only after retaining both expected rejection and semantic diagnosis. Bind native candidate refusal codes separately before running. |
| native.yml contract inspection/check | 0; actual cargo test, clippy and fmt jobs execute for relevant changes; no suppression/continue-on-error/bypass. |
| `git diff --check` | 0. |

Use a checkpoint-local detached journal, not the shared chain. Each command record includes candidate/source revision, acceptance/origin commit, fixture/checker/lock hashes, exact argv, expected/actual status, start/end, stdout/stderr artifact hashes, observed values or refusal, semantic outcome, and preservation result. It is an execution record, not a signed chain receipt. If a later case involves model evidence, only actual run/revision-bound observed handles with successful observed cite calls may populate its constrained evidence enum; preserve raw output/refusal. This freeze invents no citations.

## 5. Required case and negative-control matrix

Each defect is injected into an isolated copy of a retained preimage. Record all rows, including not-run. A candidate crash, missing dependency or unrelated parse failure does not pass a semantic rejection case. Refusal must return no successful hash/result and preserve the failed input and diagnostic.

| ID | Case | Required observation |
|---|---|---|
| P01/P02 | Exact present/absent golden grids | All 512 quantized values/channel, exact byte lengths/preimages and expected hashes match. |
| P03 | Declared ties and clamp boundaries above | Exact scalar expected results; no float drift or half-away-from-zero rounding. |
| P04 | State/weight/distance and unallocated-region queries | Unknown stays unknown; a mixed FREE/UNKNOWN region is not empty. |
| P05 | Valid header and schema | All fields retained and validated; hash-byte qualification remains not-run until unresolved header bindings are frozen. |
| N01 | Nine independent copies of sigma-present raw input: replace scalar index 0 in tsdf (byte offset 4096), weight (8192), or sigma (49152) with each of the little-endian eight-byte patterns `000000000000f87f` (quiet NaN), `000000000000f07f` (+Inf), `000000000000f0ff` (-Inf) | Rust rejects nonfinite inputs before clamping; no leaf output. Retain the exact mutated raw bytes and their hashes in the execution record. |
| N02 | Set state[0]=FREE with weight[0] quantizing to 0; repeat with OCCUPIED; set FREE positive weight and TSDF<=0 | Reject each inconsistent known/free claim. No conversion of an absent observation to FREE. |
| N03 | Replace absent sigma with a present all-zero channel, or normalize present zeros to absence | Independent declaration/byte comparator rejects each equivalence claim; hash/schema presence changes are preserved. |
| N04 | Swap tsdf/weight block order, transpose x/z, encode a multi-byte scalar big-endian, append a NUL domain terminator or a leaf level byte (separate cases) | Independent preimage/hash comparison fails for the intended byte mismatch. |
| N05 | Flip one preimage bit, change supplied header byte, origin byte, provenance byte, evidence-state byte, observation count or source-set byte | Exact retained preimage/hash comparison fails each mutation. This is a leaf integrity control, not a Merkle proof test. |
| N06 | Round a half away from even; hash raw floats; silently use a different clamp or scale | Scalar and exact-byte comparison fail. No replacement of frozen expected hashes. |
| N07 | 511/513 values, duplicate/unknown/missing/misordered channel declaration, bad triple width, bad digest length, out-of-range categorical/ledger value | Explicit validation rejects each; raw declared saturation is distinguished from malformed already-encoded integer input. |
| N08 | Invalid frame/units/revision, nonfinite/nonpositive voxel size, reflected/nonorthonormal basis | Header validator rejects each intended defect. Missing tolerance/hash bindings are not-run, not a pass. |
| N09 | Native CI bypass, missing required test, moved source, changed fixture/checker, protected-file mutation or missing preimage | Acceptance/preservation fails; no CLEARED verdict. |
| N10 | Missing provenance/evidence state; sigma treated as accuracy or inference promoted to physical measurement | Contract check refuses the upgrade; no measured:true is established. |

Reordered children, node/root hashes, inclusion/unknown proofs, diff and undensified tiles are F2b cases and remain **out of scope / not-run**, not waived or passed here. WASM, CLI ingestion, cloud, remote determinism, benchmarking, real capture, release and sealing are likewise not authorized by this freeze.

## 6. Preservation and verdict

Capture complete independent precondition bytes and SHA-256/length/mode for this freeze, all fixtures/checkers, candidate source/dependencies, existing contracts and reachable protected files before qualification. Symlinks preserve exact link text; directory manifests include sorted typed membership/metadata and empty directories; classify special files without reading as regular data. Record prospective absence. A hash alone is not a retained preimage. Writes stay in the bound isolated run directory, with candidate build outputs explicitly declared.

Before/after checks must prove protected source, governance, legacy voxel support, receipt signing/evidence admission/jobs, pre-existing work and shared journals remain intact. For any reachable live journal, retain full pre-run bytes and N, directly compare exactly the first N current bytes, then isolate and validate any suffix under its frozen journal grammar. Truncation/prefix change fails. Do not infer writer identity; unchanged journals mean suffix validation was not exercised. No appendReceipt or seal is performed by this verifier.

One immutable qualification attempt follows the freeze. Genuine failure preserves all raw input/output and returns `FAILED / HOLD`, without source/fixture/policy repair or automatic rerun. Missing candidate, checker, header binding, preimage or unfinished required case returns `INCOMPLETE / HOLD`. `CLEARED` requires every in-scope gate on the same committed candidate, including the separately resolved header bindings and direct preservation comparisons. A pass on leaf fixtures alone may be reported as that component result only; it cannot clear all F2a, F2b or any release gate.

Authoring observation: Python 3.14.5 generated and byte-compared both grids and exercised the reference's finite/tie/saturation/zero-weight/presence checks. A separate Decimal ROUND_HALF_EVEN calculation and integer `to_bytes` encoder, without importing the reference generator, independently reproduced every quantized value and preimage byte. This only verifies the fixture-authoring path. **Rust candidate acceptance, header qualification and every native workflow check remain not-run.**
