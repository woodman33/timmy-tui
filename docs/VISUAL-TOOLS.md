# Visual tools in Timmy

Open the real TUI, choose **4 LIBRARY**, then press **V**. Use arrow keys to choose a tool, Enter for its details, paste an input path, then Enter to run. Esc returns to the list; Esc again returns to Library. Ctrl+O opens the retained result. Starting a second operation is disabled while one is running. Opening a panel never starts a model, installs a dependency, or launches another agent.

| Action | Example input from the repository root | Result and limits |
| --- | --- | --- |
| Camera alignment | `examples/visual-tools/camera-fit.json` | OpenCV pose proposal, separate fitting/validation residuals, retained report and execution receipt. No native camera edit or geometry certification. |
| Gaussian inspection | `examples/visual-tools/parameters.ply` | JSON context, full row count and center bounds, up to four raw samples. Unknown units/interiors/fill remain unknown. ASCII only, ≤8 MiB, ≤100,000 rows. No model review. |
| Motion HTML | `examples/visual-tools/storyboard.json` | Editable, seekable HTML. No MP4 rendered, no receipt sealed. ≤32 beats and five minutes. |
| Telemetry | No input | Local metadata-only OTLP JSON from receipt streams. No network transmission, collector or viewer launched. |
| dmux | No run action | Installation observation only; integration not qualified. |

Examples are synthetic demonstration inputs, never measured material or scene truth. The camera example uses caller-declared source revision and units. It checks plumbing and numerical fitting, not source authenticity or unseen-scene accuracy.

Camera fitting needs an existing Python environment with NumPy and OpenCV. Timmy looks for `.timmy/venv-visual/bin/python` in the working directory; an absolute `TIMMY_VISUAL_PYTHON` selects an existing runtime elsewhere. Availability means files were detected, not that the runtime passed a probe. Nothing is installed automatically.

The same camera operation is AI-operable through the CLI:

```sh
timmy vision integrations list
timmy vision integrations run camera-fit --request examples/visual-tools/camera-fit.json
```

Run `timmy vision integrations --help` for the installed dispatcher grammar. Gaussian inspection is also available through `timmy vision spatial models context examples/visual-tools/parameters.ply --kind gaussian-splats --json`. The UI and CLI share the same implementation rather than translating a natural-language status back into an operation.

The camera runner creates an intent, runs the fixed adapter process asynchronously, retains output, and records its result. It has a 15-minute timeout. The UI exposes pending and terminal results. It does **not** offer cancellation or durable UI recovery yet. File export and bounded PLY inspection run locally; PLY parsing remains synchronous. There is no new scheduler or receipt ledger.

Hashes identify bytes. A successful process does not certify a camera pose, model annotation, or physical material. PLY properties are raw parameters: opacity is not occupancy probability, solid fill, humidity or mass density. Model claims still require observed current-revision handles and successful `cite(handle_id)` calls; this panel does not manufacture those calls. The Gaussian helper's source fact identifiers are not model citations.

## Applying dmux and the other references

The adopted dmux pattern is a selectable tool/task row, a detail view, an explicit action, and a visible result. Installation, execution, verification and merge status remain separate. Current upstream is [standardagents/dmux](https://github.com/standardagents/dmux). Its [hooks](https://github.com/standardagents/dmux/blob/main/src/utils/hooks.ts) can connect owned worktrees to Timmy later; `--remote-pane-action` requires a live tmux/dmux controller and is not an independent headless runner. No public MCP/SDK was qualified. Automatic merge/force-cleanup is not enabled on Timmy's shared checkout.

The motion HTML uses an explicit timeline compatible with the separately qualified HyperFrames path; the export button here makes HTML only. OpenDesign cloud generation, OpenSplat reconstruction/training, historical Chumpy/OpenDR/Chainer experiments, TermGL, Oryx and Process Compose are not installed or represented as operational by this change. Their useful controls can enter the same panel when an actual adapter and bounded qualification exist. In particular, a Linux eBPF viewer is not a Mac capture-readiness fix, and a splat renderer is not a solid-volume verifier.

## Why this small layer exists

The concrete failure was usable helpers hidden behind source files and status-only integration lists. One fixed operation service connects existing helpers to a TUI panel. Cost: four dispatch paths, transient UI state, and local output files. No extra persisted job state, authority heuristic or recovery ledger is introduced. Deleting the panel/service would return users to hand-assembled commands. Authority comes from the user's explicit action plus fixed tool contracts; the result reports observed execution and computed measurements, never an agent's assertion of success.
