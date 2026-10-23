# Vision execution and honest checks

VoxVision includes local pixel processing and native-file readback. Roboflow is an
optional model provider. A mocked SDK test checks a contract; it does not prove a
model ran. A signed receipt commits to the saved result, not its accuracy.

## Local images without an account

Use a project-local Python environment so Timmy and its worker use the same
dependencies. Python 3.12 is suitable for both the local worker and the current
Roboflow client; some SDK releases exclude Python 3.14.

```sh
python3.12 -m venv .timmy/venv-vision
.timmy/venv-vision/bin/python -m pip install opencv-python-headless numpy
export TIMMY_VISION_PYTHON="$PWD/.timmy/venv-vision/bin/python"
timmy act '/detect refs/control.png color 255,0,0 --tolerance 0' --wait --json
```

Use an actual image path in the active project. This performs deterministic pixel
computation, not object recognition. Timmy retains the job log, observation,
annotated image when something is found, and receipt. The same action is available
as `/detect` in the REPL. It does not need OpenRouter, Ollama or a Roboflow account.

## Optional Roboflow model inference

Install a compatible `inference-sdk` in a separate Python environment if its
dependency constraints differ from the local worker. Keep the API key in the
existing server-side environment or private project configuration, never in a
command argument, screenshot, browser response or source file.

Configure an explicit model ID, Python executable and inference-server URL, then
use `timmy vision status` and `timmy vision run --image FILE.png --model MODEL_ID`.
The MCP entry is `timmy_vision_inspect`. Status is a configuration check; only a
completed real inspection establishes execution. Model/server identity, result
and image hashes belong to that particular run.

Header authentication and disabled active learning require a compatible SDK and
server. Workflow execution remains unavailable until both sides' sink controls
are verified. There is no automatic fallback to a hosted paid endpoint. Local
history, feedback and review queues remain readable without a Python bridge or
network. Cloud event upload is a separate explicit action; its annotations are a
box/classification subset of the full local response, and ingestion warnings
must be retained.

## Maintainer checks

```sh
npm run test:vision:real
python3 -m unittest discover -s tests -p '*bridge*.py' -v
npx vitest run tests/vision-assets.test.ts tests/vision-runtime.test.ts tests/vision-not-available.test.ts --maxWorkers=1
```

The real gate fails if Python/OpenCV is absent. Its colored-region, QR and image
difference checks run actual OpenCV on constructed control images. The separate
Python tests use SDK doubles and are labelled unit contracts. The `Real local
vision` CI job (`.github/workflows/vision-local.yml`) installs actual OpenCV and
runs the explicit gate; it runs by hand (`workflow_dispatch`) only, so no push
downloads anything by itself. Build asset validation refuses a missing
bridge/worker instead of silently omitting it from the package.

Roboflow model inference is unverified: no real authorized run has succeeded.
A bridge file in the package, a configuration probe, a doctor row or an SDK-double
test does not establish it. The one real run recorded so far (2026-10-23) was
VoxVision's `/detect` colour check through `timmy act`: the OpenCV look worker,
a vox record and a signed receipt, with no Roboflow and no semantic vision.

Neither these tests nor a configuration probe qualifies hosted/self-hosted
Roboflow inference, remote cancellation, UI interaction or physical measurements.
Those require distinct observed runs; never replace them with fabricated
predictions or an injected successful runner.
