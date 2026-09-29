# Camera alignment through Timmy

This is an original, bounded OpenCV adapter, not an installation of OpenDR or a generative model.
It uses Timmy's integration runner. The interpreter defaults to
`.timmy/venv-visual/bin/python` relative to the command's working directory. An operator can select an
existing runtime with `TIMMY_VISUAL_PYTHON=/absolute/path/to/python`. The adapter script is resolved
relative to the installed Timmy package, so it does not depend on the caller's working directory.
No runtime is installed, downloaded or inferred from the receipt store. NumPy and OpenCV must already
be available in that interpreter.

From the repository root, the current source entry supports:

```sh
node --import tsx src/cli.ts vision integrations list
node --import tsx src/cli.ts vision integrations run camera-fit --request tools/spatial-fit-20260915/probe.request.json
```

The second command performs a version probe and records a real intent/result through the configured
receipt store. This turn tested execution only in isolated test stores; no production probe receipt
was minted. The globally installed CLI has not been rebuilt.

For `operation: "fit"`, supply JSON fields:

- `object_id`, `source_revision` (SHA-256), `frame_id`, `units` (`m`, `cm`, `mm`, `scene-unit`).
- `image_size: [width,height]`, `camera_matrix` (3×3, positive focal lengths, zero skew).
- `distortion`: empty array or `[k1,k2,p1,p2,k3]` Brown–Conrady coefficients.
- `correspondences`: 6–64 objects `{id, world:[x,y,z], pixel:[u,v]}`.
- `validation_correspondences`: 3–64 separate objects of the same shape.

The fit set must be noncoplanar and nondegenerate. IDs and exact world positions cannot overlap
between the two sets. Input is at most 64 KiB, all values bounded and finite, pixels within the
declared image. No external files, network, model or arbitrary executable is accepted by this adapter.
Do not supply `capability`, `output_dir` or `admission_receipt_hash`; the Timmy runner supplies them.

Output is `X_camera = R @ X_world + t`, OpenCV axes +X right, +Y down, +Z forward; camera center in
the declared world frame; input calibration; and per-point fit/validation residuals in pixels.
Validation points do not enter the solver. `ok` means computation completed, including when validation
error is high. Pose is a **reconstructed proposal**. Source identity, units and correspondences are
caller declarations, not independently authenticated measurements. No native camera is changed.

The command uses an async child process, while OpenCV's solver itself is synchronous. Existing Timmy
retention records success/refusal and hashes output; it does not prove geometry correctness or provide
new cancellation/recovery semantics. Model commentary must use Timmy's current observed-handle/cite
protocol; these JSON labels do not themselves qualify as successful citations.

Qualification: run `tools/spatial-fit-20260915/test_adapter.py` with the existing visual Python runtime,
then the focused `tests/camera-fit-integration.test.ts` suite. These use synthetic arithmetic unit data,
temporary stores and both successful execution and retained refusal. No corpus scenes are collected.
The TypeScript native integration tests explicitly skip when the configured interpreter is absent;
skipped tests establish no native qualification. The Python unit tests are an explicit separate run.
