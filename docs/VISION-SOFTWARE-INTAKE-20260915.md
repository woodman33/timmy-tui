# Turning the supplied software into Timmy operations

This is an implementation intake, not a qualification result for every library. The current change adds an actual **Chafa CLI → asynchronous adapter → TUI image** path. The other rows below describe inspected upstream interfaces and proposed adapters; no dataset, model weights, historical CUDA stack or extra scheduler was installed or run. No model calls or training occurred. Existing research HOLDs and corpus counts are unchanged.

## Working increment: terminal images

In **4 LIBRARY → V → Terminal image**, load the bundled example with Ctrl+E, then Enter. The preview appears inside the TUI; Ctrl+P returns to details and Ctrl+O opens the retained report. Headless agents can run `timmy vision preview --image FILE.png --json`. Both surfaces call the same adapter.

The installed Chafa 1.18.2 executable was discovered locally. The adapter snapshots the source, executes a bounded child, retains output and rejects terminal control sequences other than color styling. Its report distinguishes successful display conversion from geometry verification. The native CLI and panel interaction are tested separately; this does not claim a new end-to-end interactive application recording.

[Chafa's documented CLI](https://hpjansson.org/chafa/man/) supports substantially more than this initial still-PNG route, including additional terminal graphics formats. Those formats and animation need their own panel integration. Chafa is an external LGPLv3+ executable here; no upstream C implementation is vendored.

## Multi-camera evidence: one scene, several representations

| Supplied technology | Practical Timmy control path | What the output can establish / remaining work |
| --- | --- | --- |
| [MVSNet / R-MVSNet](https://github.com/YoYo000/MVSNet#file-formats) | Import `images`, calibrated `cams/*_cam.txt`, `pair.txt` and depth/confidence PFM; later invoke an isolated existing `test.py` worker. | Reconstructed depth and confidence. No solid-fill or interior truth. Original Python 2.7 / TensorFlow / CUDA stack stays outside Timmy's runtime. Code is MIT. |
| [BlendedMVS](https://github.com/YoYo000/BlendedMVS) | Reuse the camera/PFM importer; retain scene IDs, RGB, depth and source hashes. | Rendered depth derived from reconstructed meshes, not a measured universal material reference. Preserve invalid-depth masks and source splits. Dataset declares CC BY 4.0. |
| [GL3D](https://github.com/lzx551402/GL3D/tree/v2) | Read its documented cameras, keypoints, correspondences, overlap and depth formats through a fixed import command. | Suitable for correspondence/reprojection evaluation. The current v2 tree differs from historical examples. Repository licensing does not automatically settle every source image's rights. |
| [UniScene / Occ-BEV](https://github.com/chaytonmin/UniScene) and BEV methods | Calibrated rig + timestamped observations → isolated config/checkpoint worker → spatial feature/occupancy export. | Learned priors and predictions. A top-down image alone loses vertical structure; retain height bins and camera transforms. No pretrained worker tested here. |
| [SurroundOcc](https://github.com/weiyithu/SurroundOcc#try-your-own-data) | Use the supplied own-data interface to export predicted NPY/PLY, independently from LiDAR/Poisson label construction. | Prediction, observed sensor samples and reconstructed labels remain distinct. Code declares Apache 2.0. |
| [Occ3D](https://github.com/Tsinghua-MARS-Lab/Occ3D) | Import semantics together with `mask_lidar`, `mask_camera` and visibility information; expose observed-only evaluation in Timmy. | Particularly useful for unknown-space handling. Label/code license does not replace underlying nuScenes/Waymo terms. |
| [VoxFormer](https://github.com/NVlabs/VoxFormer#license), MonoScene, TPVFormer, OccDepth and related index entries | Candidate isolated prediction workers, selected only after data/coordinate/dependency inventory. | Occluded-space completion is a model claim. VoxFormer's noncommercial code/weight terms exclude it from a default commercial bundle. The supplied “awesome” lists are discovery indexes, not callable SDKs. |
| [ORFD / OFF-Net](https://github.com/chaytonmin/Off-Road-Freespace-Detection) | Import RGB, LiDAR, calibration, sparse/dense depth and labels; later wrap the existing demo/test scripts. | Traversable, non-traversable and unreachable are navigation labels, not empty/occupied states. Source axes are x-left, y-forward, z-up. Preserve that transform. Code/dataset declare Apache 2.0. |
| [fusibile](https://github.com/YoYo000/fusibile) | Separate executable behind MVSNet's depth-fusion interface → fused PLY with camera/depth provenance. | Reconstructed surface points, not certified watertight volume. GPLv3 distribution implications need review before bundling. |
| [MVSDF](https://github.com/jzhangbs/MVSDF) | Calibrated images/stereo depths → isolated evaluation/export worker → SDF, mesh and rendered diagnostics. | Reconstructed geometry; SDF is distance, not mass density. Its [IBFS mesh-cut component](https://github.com/jzhangbs/MVSDF/blob/master/code/mesh_cut/IBFS/license.txt) is research-only and must not be silently included with the MIT core. |
| [NeILF++](https://github.com/apple-aiml-research/ml-neilfpp) | Potential isolated multiview geometry/material/lighting optimization worker; import/export explicit scene artifacts. | Estimated appearance parameters are not measured material truth. The pasted HTML is its project page, not an adapter. CUDA/runtime and license qualification remain undone. |

The shared spatial record should retain scene/object ID, source revision, units, axes, camera intrinsics/distortion/extrinsics, timestamps, observation IDs, visibility, uncertainty and provenance. Raw geometry, reconstructed surfaces and generated predictions must be independently addressable. A 2D detection becomes a grounded spatial reference only through calibrated depth/correspondence and checked transforms; its bounding box is not itself 3D evidence.

### Small next implementation, not a new model sweep

Use existing OpenCV [calibration operations](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html) before a heavyweight learned stack: A/B camera observations triangulate 16–32 synthetic landmarks at varied depths; reserve camera C for independent reprojection. Expose a fixed JSON input through CLI/MCP and the existing visual-tools service. Output PLY plus residuals, rejected matches and source observation IDs. The UI links camera observations, reconstructed points/BEV height bins and selected cell evidence.

Controls: zero baseline, points behind cameras, mismatched units/revisions and incorrect correspondences must fail or remain unknown. A point in a cell does not establish a fill percentage; a ray passing through part of a cell does not prove the entire cell empty. A 10×10×10 grid is a useful display address space, not sufficient shape information. This proposal does not generate corpus scenes or restart held benchmarks.

## Component examples that stay tied to production

[Fractal's API](https://fractal.build/api/) offers `create()`, asynchronous `load()`, `components.render(handle, context)`, and `web.builder().build()`; its [CLI](https://fractal.build/guide/cli/) offers start, build and custom commands. The upstream [repository](https://github.com/frctl/fractal) is archived. Fractal was not found on PATH or in the checked Timmy package/dependency tree; this is not an assertion about every file on the computer.

A later fixed-project adapter can expose list, render and static export for `timmy-receipt` and `timmy-report`, using the actual production templates and example contexts. Evidence-state variants are declared, constructed, checked, inferred and stale. Component readiness/WIP is a separate status. A “checked” visual variant must never upgrade the evidence it displays. A Fractal component handle is not a Timmy citation handle.

Do not execute arbitrary supplied Fractal configuration: JavaScript configuration and promise-valued context can execute code or fetch remotely. Prefer a fixed approved configuration and bounded context inputs. Timmy's existing preview/report system may supply the same useful component/variant pattern without taking on an archived dependency. Bootstrap 4.4.1, Purl and the supplied website CSS/JS are presentation assets, not vision capabilities; Purl is unmaintained, so use the platform URL parser instead.

## Async harnesses without competing owners

| Source | Actual useful interface | Timmy application and limit |
| --- | --- | --- |
| [unleashd](https://github.com/nbardy/unleashd) | Express/WebSocket commands for creating conversations, sending/queuing messages, stopping, interrupting and configuration. | A potential adapter to an explicitly owned existing endpoint can feed Timmy's job UI. OpenCode history support is read-only, not proof of an OpenCode spawn adapter. Starting its server also starts schedulers; do not introduce a competing scheduler as a harmless viewer. |
| [AI-OS](https://github.com/nbardy/AI-OS) | Python helpers for chat/vision/edit, spawn/join/gather and file/shell operations. | Reuse bounded orchestration ideas over Timmy's existing adapters. Chat/vision/spawn helpers are model-backed; file/shell macros alone do not imply model calls. The inspected v2 implementation does not establish an OpenRouter backend. A legacy `patch` example differs from its implementation and can execute edits immediately. |
| [Shader Benchmark](https://github.com/nbardy/shader_benchmark) | Rust `shader-bench --shader FILE --output PNG --size N --time SECONDS`. | A future fixed-time WGSL → PNG → Chafa path is model-free rendering. Inventory the executable/GPU support before use. Generation and judging are separate model operations. The [judge](https://github.com/nbardy/shader_benchmark/blob/main/llm_harness/judge.py) substitutes scores when parsing fails; that must not become Timmy's verifier. |
| Supplied SynesthesiaLisp | Embedded prompt chaining with logic and interpolation. | Borrow explicit dependency graphs, but avoid implicit model dispatch and fuzzy coercion at verification boundaries. No runtime installed or called here. |

Use the existing operation identity and results rather than adding a second ledger. Async child execution keeps the TUI responsive; it does not make a native application's internals asynchronous. This panel currently has transient progress/results, not durable cancellation or recovery. Those capabilities need explicit ownership and existing job-system integration before being advertised.

## Evidence and implementation boundaries

- Solid fill, opacity, occupancy probability, mass density and humidity remain different fields. A fill fraction cannot uniquely describe a cell's geometry.
- Reconstructed or generated texture/material references are not measured truth. Prediction confidence is not a sensor visibility mask.
- Every model-authored evidence field must select from actual observed current-run/current-revision handles and have a successful observed `cite(handle_id)` call. Empty handle sets require unknown/refusal. Preserve raw invalid output and refusal; never repair labels after the fact.
- Render, receipt hash, geometric check and benchmark success are different results. The Chafa report is explicitly unsealed and makes no model-evidence claim.
- No extra installation, dataset collection, training, capture, remote host access, admission controls or held qualification was performed for this intake. Research familiarity must not be shown as “installed”, “tested” or “integrated”.
