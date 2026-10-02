# Spatial workflow benchmark — draft for operator approval

Status: **DRAFT / NOT APPROVED / NOT RUN**. Governing scope: ORDER spacelang-v7k2 §10 as amended by A1. This document proposes the workflow and threshold-derivation rule; it records no benchmark result, physical capture, measured capability or default change. Approval must be the operator's exact `APPROVE bench <sha256-of-this-file>` line. After approval these bytes are frozen. Numeric M3b thresholds are a separate R10 acceptance freeze under the approved rule, after M1b and M3a are independently verified and before real capture.

Until approval, every result has `measured:false`, reason `benchmark not approved`. Approval of this document does not authorize physical capture, paid/cloud probes, deployment, defaults, collection, training or changes to retained HOLDs. Only the operator runs the physical capture session, under its separate approval. A qualification failure is retained and ends the affected lane in HOLD; expectations and labels are never repaired after the run.

## 1. Instruments and claim boundaries

| Instrument | Inputs and method | Permitted claim |
|---|---|---|
| PLANAR + MULTI-VIEW — planar sub-result | Full-resolution RGB stills, ChArUco intrinsics/distortion calibration, identified board pose and actual fiducial scale; card edge endpoints mapped through the board-plane homography | Calibrated observation of card in-plane edge lengths, with plane-offset uncertainty; not card thickness |
| PLANAR + MULTI-VIEW — multiview sub-result | Full-resolution RGB stills from frozen views; calibrated cameras/board poses; triangulation of cube corners with sufficient baseline | Calibrated observation of cube edges and height, with triangulation/pose uncertainty |
| SPACE | LiDAR RGB-D, intrinsics and poses; TSDF integration and voxel-ledger ingestion | Observed occupancy, free and unknown space; centimetre-class cube cross-check |

M3b runs and reports both instruments, with planar and multiview dimensions identified individually. Never pool the instruments into a single accuracy score, use one to fill the other's missing observation, or award `measured:true` to the physical-dimension loop from LiDAR TSDF alone. A **1 mm TSDF voxel is ledger resolution, never accuracy**, and 2 mm/5 mm evaluation grids are scoring discretizations, not instrument accuracy. Card thickness is outside the LiDAR claim. Generated/model depth and geometry remain inference/generated layers with their inherited provenance.

For each claim retain evidence kind, provenance tag, evidence state, frame, units, acquisition time, source revision, instrument, method and uncertainty. PLANAR + MULTI-VIEW uses `calibrated_observation`. Deterministic computation of a root establishes byte integrity, not physical truth. Optional voxel `sigma` is `u16`, 1σ in micrometres; absent means **not recorded**, never zero. Per-dimension intervals below are not automatically per-voxel sigma values.

Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.

## 2. Tiers and separate grades

Every tier reports each grading axis separately as PASS, FAIL or NOT RUN with a reason. Unavailable software/connection/harness is NOT RUN (or null in the harness probe contract), never implicit PASS. Retain raw output and refusal. A correct tool refusal can pass the tool grade while the controller's bad call fails model tool use.

| Tier | Frozen workflow | Required independent grading |
|---|---|---|
| LIGHT | One fast novice workflow: load one known synthetic fixture, inspect a slice, query a known feature, prove/verify one voxel, and ask whether an unobserved region is empty | Tool behavior; connection; software/runtime; model interpretation; model tool use; overall composition. With no authorized model, those model axes are NOT RUN |
| MEDIUM | LIGHT plus several steps: ingest two fixture observations, inspect coverage, compare a changed region, open native readback/recording, and check calibration/dimension output and uncertainty | Repeat the same six grades, with job identity, progress, cancellation/recovery and source revision retained through the workflow |
| HARD | Isolate every participating tool, connection, software component and authorized model on the same frozen fixture contract; exercise negative controls; compose them into the full workflow; grade each axis again | Preserve isolated and composed scores separately. Failure attribution must identify the first failing boundary, not average away a failed tool or connection |

Start shared-defect diagnosis with offline controls and, only when model use is authorized, one pinned local model. Stop roster expansion on a shared workflow failure. Never rerun a whole model roster to diagnose one defect. Freeze model/provider IDs, model revision, quantization, prompts, tool schemas, tool versions, budgets, tasks, splits, seeds and ordering before comparisons. Cloud-backed tags remain cloud; paid/cloud routes require separate approval. Existing defaults remain in place.

## 3. Ground truth, fixture isolation and preservation

Use synthetic scenes with exact known geometry and camera answers, generated through BlenderProc's **private CLI boundary**, plus the separately authorized real fiducial scene. Do not vendor GPL code or private generator scripts into the public tree. Freeze scene-generation versions/seeds, geometry, units, cameras, materials, masks, depth validity and scene bounds before fixture execution. Synthetic exactness tests computation; it does not establish a physical sensor's error floor.

The physical objects are the operator's trading card and a cube **at least 100 mm on every side and within the caliper's range**. No nominal card dimension substitutes for the operator's readings. Three caliper readings per edge arrive at R3. Keep raw readings, edge IDs, instrument resolution/calibration information and reference uncertainty in a **private verifier record**, indexed from `docs/orders/spacelang-v7k2/verify/` without publishing values or private filesystem paths. They never go into this benchmark, public fixtures, prompts, training scenes or episode-visible inputs. The evaluator can compare them only after the prediction and its interval are fixed. Capture frames and real-room/person data remain in the private overlay; public demos require PII review and operator approval.

Freeze source revision, dependency versions, input hashes, schema, exact commands and expected statuses, reference geometry, evaluator version, metric definitions, matching/masking rules, grading limits and preservation methods before a graded run. Retain complete original bytes and manifests privately where required, not just hashes. Keep qualification fixtures separate from training, validation and held-out corpora; no private answers or held-out geometry may repair generated scenes. A fixture result is not a corpus admission or collection authorization.

Use checkpoint-local journals and detached hashes. Only the authorized builder seals the shared chain; this verifier never appends it. Hashes must not be described as signed receipts. Preserve protected-file preimages and compare bytes after the run; for append-only journals compare the original prefix and validate any actual suffix separately. Stop on failure without rerunning or relabeling the frozen attempt.

## 4. Metric contract

All metric rows are required. A row outside the instrument's valid domain reports NOT RUN/unsupported with its reason and denominator, not zero. Freeze validity masks, scene bounds, correspondences, coordinate conventions and aggregation before evaluation. Show sample counts, failures/missing outputs and per-scene values alongside summaries.

| Metric | Frozen definition and reporting |
|---|---|
| Depth AbsRel | Mean `abs(predicted - reference) / reference` over the fixed valid positive-depth reference mask. Report invalid/missing prediction count separately; no favorable post-hoc mask selection |
| Depth δ1 | Fraction of that valid reference mask with `max(predicted/reference, reference/predicted) < 1.25`; missing/nonpositive predictions fail the indicator |
| Normal angle error | Degrees between matched unit normals after frozen frame/orientation treatment; mean, median and p95, with invalid normals counted |
| Mask IoU | Intersection/union of predicted and reference object masks with frozen labels/background handling; per object and macro summary; empty-union convention fixed before execution |
| Pose ATE / RPE | ATE translation RMSE in mm after the frozen alignment rule; RPE translation in mm and rotation in degrees at frozen temporal/frame deltas. No similarity rescaling that hides scale error |
| Chamfer | Symmetric mean nearest-neighbor **unsquared** distance in mm, one half of each directional mean; freeze sampling density, point selection and alignment; also report each direction |
| Voxel IoU, 2 mm / 5 mm | Occupied-set intersection/union independently on both grids in the same fixed frame, origin and scene bounds; reference occupancy fixed. UNKNOWN never becomes FREE; missed reference occupancy remains in the union |
| Coverage % | `100 × observed voxels / scene voxels` within frozen scene bounds at the declared grid size. Observed means observation weight > 0; unallocated/weight-zero voxels are unknown and remain in the denominator |
| Fiducial scale error | Absolute length error in mm on the independent printed 100 mm check span; also report signed error and relative error. Do not derive scale from that span and then claim its fitted residual is an independent test |
| Card edge error | Signed and absolute error in mm for each preregistered in-plane edge versus the private caliper reference; PLANAR output, interval and grade separately |
| Cube edge/height error | Same per-edge/per-height report for MULTI-VIEW and SPACE separately; no instrument pooling or best-edge selection |
| Merkle determinism | Exact root equality on the Mac and spark3 for identical canonical inputs, header, channel order and source revision; preserve input hashes and roots. Any mismatch fails, with the first differing header/leaf/byte reported |

Geometry metrics require physical reference data appropriate to that metric. A card and cube do not supply dense real-scene ground truth for every depth pixel, normal, pose or mask. Report unsupported real-scene metrics honestly and evaluate their synthetic counterparts separately. No aggregate grade can hide failed unknown-space semantics, invalid evidence or nondeterministic roots.

## 5. Fiducial board specification

The R1 generator must produce a combined ChArUco + AprilTag **tag36h11** board on **US Letter (215.9 × 279.4 mm), printed at 100% / actual size**, with **at least 10 mm margins** on every side and a labelled **100 mm scale bar**. Disable fit-to-page scaling. Commit the generator and a manifest containing the PDF's SHA-256; the generated PDF remains gitignored and its local path is printed for the operator.

Freeze board geometry, ChArUco dictionary, square/marker lengths, IDs, AprilTag IDs/detected-border sizes, quiet zones, coordinate origin/handedness, layout coordinates, font/asset versions and generator/library versions with the generator. Confirm the complete content bounding box stays inside the allowed page area. Use a flat, rigid backing; record print-scale checks in both axes and uncertainty, and refuse a scaled, mirrored or wrong-dictionary print. The printed bar is an independent print check, not assumed ground truth from the printer's settings. Do not put objects over required calibration corners.

OpenCV documents ChArUco camera calibration and reprojection error; its examples are method guidance, not a physical millimetre accuracy guarantee. AprilTag's upstream implementation documents tag-size conventions and supports tag36h11. Pin the actually installed API and board-coordinate convention; do not silently adopt a newer example. [OpenCV calibration](https://docs.opencv.org/4.x/da/d13/tutorial_aruco_calibration.html), [AprilTag upstream](https://github.com/AprilRobotics/apriltag).

## 6. Per-dimension uncertainty and the measured rule

Every dimension reports `estimate_mm ± U_mm`, the complete budget, coverage interpretation and applicability limits. An unknown contribution remains unknown and prevents a measured claim. The reference is the mean of the three private readings for the identified edge; retain all three readings and caliper resolution, calibration/systematic allowance and repeatability in the evaluator's reference uncertainty. Never expose that answer to the estimator.

| Required contribution | How it enters the dimension budget |
|---|---|
| Fiducial scale | Print/board dimensional uncertainty propagated to the measured length; include anisotropic print scaling and the independent scale check |
| Calibration reprojection residual | Intrinsic/distortion and board-pose residuals in pixels propagated to mm using the frozen camera model and geometry; pixel RMS alone is not mm accuracy |
| Edge localization | Endpoint/corner localization uncertainty propagated through the homography or triangulation; include card offset/flatness and corner ambiguity |
| Sensor floor | Instrument- and mode-specific published accuracy/noise allowance, with source and conditions; propagate to the dimension, not merely copy a single-point number |
| Additional required terms | Pose/baseline/triangulation conditioning, synchronization, TSDF discretization/truncation where applicable, reference/caliper uncertainty for comparisons, and any identified systematic term |

Use a conservative absolute allowance budget: `U = B_scale + B_calibration + B_edge + B_sensor + B_other`, in mm, with each term a nonnegative propagated bound/allowance under its documented conditions. Freeze the propagation method and allowable input ranges before the fixture. This sum is an engineering interval, **not a claimed 95% confidence interval or 1σ**. If a probabilistic budget is later proposed, its distributions, correlations and coverage rule require a new prospective freeze; never infer sigma from a paper's unspecified “± accuracy.” Do not shrink systematic terms by averaging frames. Reject dimensions whose geometry lies outside the frozen calibration/conditioning domain.

For dimension `d`, with private reference `c_d`, prediction `x_d`, frozen threshold `T_d` and independently computed interval half-width `U_d`:

`dimension_pass = abs(x_d - c_d) <= T_d AND (x_d - U_d <= c_d <= x_d + U_d)`.

Both tests are mandatory; a wide interval cannot excuse exceeding the threshold, and a small absolute error cannot excuse excluding the caliper value. `measured:true` additionally requires benchmark approval, verified fiducial scale and calibration, applicable published floor, valid current-run evidence, the preregistered dimension set, and all relevant controls. SPACE alone cannot certify the physical-dimension loop. Missing/failed requirements produce `measured:false` and the exact reason; no post-result interval inflation, label repair or selective dimension omission.

## 7. Published basis and deterministic threshold derivation

The published iPhone 12 Pro/iPad evaluation reports approximately ±10 mm absolute object accuracy for sides over 100 mm, reduced precision below that scale, approximately 50 mm detection limit and 576 projected points. It tested specific devices and capture software. This supports a **centimetre-class SPACE allowance**, not a universal guarantee for another device/mode and not 1σ. Record device, capture app/version, range, geometry and the applicability decision before freezing. [Luetzenburg, Kroon and Bjørk, Scientific Reports (2021)](https://www.nature.com/articles/s41598-021-01763-9).

There is **no established universal absolute mm floor for PLANAR + MULTI-VIEW in this draft**. OpenCV's reprojection residual is calibration diagnostics, not such a floor. Before the M1b fixture, select and retain primary published camera/instrument accuracy or noise specifications for the actual sensor, still mode, lens and operating range; define how they propagate through the calibrated planar and triangulation geometry. Record the source, units, conditions, conversions and applicability. If a suitable basis cannot be established, that instrument's numeric threshold and M3b measured claim remain **HOLD**; neither a synthetic zero residual nor the LiDAR paper fills this gap.

The following is the proposed derivation rule for approval now. Numeric values are computed only at R10; they are not selected to make the actual capture pass.

1. Before each authorized fixture, freeze the published-floor source and applicability, instrument/mode, dimension classes, one predetermined fixture dataset/run per instrument, exact input hashes, source/dependencies, evaluator, uncertainty propagation, reference uncertainty, and a positive numeric reporting increment `q_d` justified by representation precision. M1b supplies PLANAR + MULTI-VIEW fixture output; M3a supplies SPACE fixture output. Include all preregistered comparable dimensions, not a favorable subset. Fixture execution is a separately authorized checkpoint, not authorized by this draft.
2. For each dimension class `d`, derive `F_d` in mm from that instrument's published floor via the frozen propagation rule. A point-position bound must account for both endpoints when used for a length; a depth bound must account for triangulation/pose geometry. Do not treat ±10 mm point/surface accuracy as automatically ±10 mm edge accuracy. Missing or inapplicable basis → HOLD.
3. From the single frozen fixture run compute `E_d = max_j(abs(x_fixture,j - c_fixture,j) + U_reference,j)` over **all** preregistered comparable fixture dimensions in that class. Missing required outputs, failed controls, invalid evidence or unsupported geometry → HOLD, not a large permissive threshold. The fixture allowance characterizes that fixed setup only.
4. After independent verification of **both M1b and M3a**, R10 computes `T_d = q_d × ceil((F_d + E_d) / q_d)`. This is a deliberately conservative published-floor-plus-fixture allowance, not a fitted percentile or a claim of general sensor accuracy. No multiplier, quantile, fixture substitution or rounding adjustment may be selected after seeing results.
5. R10 freezes a separate table in `docs/orders/spacelang-v7k2/verify/` recording every dimension class and instrument, source/applicability, propagation version, fixture run and input hashes, `F_d`, `E_d`, `q_d`, `T_d`, uncertainty-budget rules, accepted operating range and preregistered dimensions. Publish only nonprivate values. Hash the exact freeze and print its SHA-256 **before any real capture**. R11 witnesses the same hash; R12 verifies M3b against it, each instrument separately.
6. The real capture, caliper answers and any desired release outcome must not influence `F_d`, fixture selection, `E_d`, `q_d`, `T_d` or interval rules. Out-of-domain capture or failed measured tests → preserve `measured:false` / HOLD. A later different instrument, fixture or threshold is a new separately authorized operation that retains the earlier failure.

Other graded metrics require their own preregistered numerical limits and justification in the applicable acceptance freeze. Their definitions are fixed above, but no unsupported PASS limits are invented here. If a metric's limit or reference is missing, report NOT RUN/ungraded and HOLD its dependent claim. Structural controls (unknown semantics, proof verification and exact determinism) use their exact expectations, not sensor tolerances.

## 8. Mandatory negative controls and result record

Freeze expected outputs/statuses before executing these controls: scaled print; wrong fiducial dictionary; mirrored board; missing/invalid calibration; missing published floor; ill-conditioned triangulation; caliper outside the reported interval despite error within threshold; error beyond threshold despite caliper inside a wide interval; LiDAR-only attempt at `measured:true`; 1 mm voxel advertised as accuracy; absent sigma interpreted as zero; UNKNOWN presented as FREE/empty; zero-weight FREE; stale/foreign/uncited/property-name evidence handle; forged proof; tampered leaf; reordered channel/child encoding; NaN/Inf; nondeterministic root; private value emitted into a card or receipt; noncommercial/unverified dependency admitted to a public build.

Every model-authored evidence field chooses only from the constrained enum of handles actually observed for the current run and source revision, and each selected handle requires an observed successful `cite(handle_id)` call. No handle set means unknown/refusal. Preserve raw model output and exact refusals; never substitute handles or edit labels afterward to obtain PASS. Published literature links in this protocol are reference sources, not populated run-evidence handles.

A new gate must demonstrate the expected failure on its frozen defective artifact before admission; only the authorized builder performs shared `gate.control` seals. Reports retain run/revision, input/evaluator/freeze hashes, instrument, all metric rows, separate axis grades, control results, uncertainty budgets, private-reference identifier, raw result locations under private storage, actual receipts where present, preservation outcome, elapsed time and limitations. Missing authority/evidence, stale revisions, failed qualification, exhausted checkpoint time or missing preimages ends the affected lane in HOLD. UI readiness requires its separately approved sandbox validation; otherwise state “UI readiness not claimed.”

This R0.2 document remains a proposal pending `APPROVE bench <sha256>`; no thresholds, measurement results or benchmark passes are claimed.
