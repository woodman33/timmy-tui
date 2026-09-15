# Visual tools in Timmy

Open the real TUI, choose **4 LIBRARY**, then press **V**. Use arrow keys to choose a tool, Enter for its details, press **Ctrl+E** to load the bundled synthetic example (or paste an input path), then Enter to run. Loading an example never executes it. Results remain available per tool during this panel session; editing an input hides its old completion. Esc returns to the list; Esc again returns to Library. Ctrl+O opens the retained result. Starting a second operation is disabled while one is running. Opening a panel never starts a model, installs a dependency, or launches another agent.

| Action | Example input from the repository root | Result and limits |
| --- | --- | --- |
| Camera alignment | `examples/visual-tools/camera-fit.json` | OpenCV pose proposal, separate fitting/validation residuals, retained report and execution receipt. No native camera edit or geometry certification. |
| Gaussian inspection | `examples/visual-tools/parameters.ply` | JSON context, full row count and center bounds, up to four raw samples. Unknown units/interiors/fill remain unknown. ASCII only, ≤8 MiB, ≤100,000 rows. No model review. |
| Motion HTML | `examples/visual-tools/storyboard.json` | Editable, seekable HTML. No MP4 rendered, no receipt sealed. ≤32 beats and five minutes. |
| MCAP recording | `examples/visual-tools/simulation.json` | CRC-protected indexed MCAP + CSV; exact payload and simulation-time replay check, execution receipt. Missing penetration stays unknown. |
| Motion MP4 | `examples/visual-tools/storyboard.json` | Installed HyperFrames renders a local MP4; video stream metadata and execution receipt retained. No per-frame content verification. macOS only, ≤30 seconds and 1920×1080, even dimensions. |
| Telemetry | No input | Local metadata-only OTLP JSON from receipt streams. No network transmission, collector or viewer launched. |
| Terminal image | `examples/visual-tools/preview.png` | Installed Chafa converts a retained PNG into a color terminal preview. Ctrl+P switches between preview and details. Display approximation only; report is unsealed. |
| dmux | No run action | Installation observation only; integration not qualified. |

Examples are synthetic demonstration inputs, never measured material or scene truth. The camera example uses caller-declared source revision and units. It checks plumbing and numerical fitting, not source authenticity or unseen-scene accuracy.

Camera fitting needs an existing Python environment with NumPy and OpenCV. Timmy looks for `.timmy/venv-visual/bin/python` in the working directory; an absolute `TIMMY_VISUAL_PYTHON` selects an existing runtime elsewhere. Availability means files were detected, not that the runtime passed a probe. Nothing is installed automatically.

MCAP uses an existing `.timmy/venv-platform-telemetry/bin/python` or absolute `TIMMY_TELEMETRY_PYTHON` containing mcap, zstandard and jsonschema. Input is explicit; the shipped adapter never loads a private fixture by default. The CLI also supports replay and explicit PlotJuggler opening; native viewer launch has not been requalified here.

MP4 uses an existing HyperFrames CLI selected by absolute `TIMMY_HYPERFRAMES_CLI` or a detected command on PATH, existing Chrome, FFmpeg and FFprobe. Optional absolute `HYPERFRAMES_BROWSER_PATH`, `HYPERFRAMES_FFMPEG_PATH` and `HYPERFRAMES_FFPROBE_PATH` override those tools. It runs through macOS loopback confinement; other platforms or missing runtimes show an unavailable action with setup guidance. It never uses npx to fetch a renderer. The source is generated from a bounded storyboard, not arbitrary user HTML.

The same camera operation is AI-operable through the CLI:

```sh
timmy vision integrations list
timmy vision integrations run camera-fit --request examples/visual-tools/camera-fit.json
```

Terminal images use the same asynchronous implementation in the TUI and headless CLI:

```sh
timmy vision preview --image examples/visual-tools/preview.png --json
```

This action uses existing `chafa` on PATH or absolute `TIMMY_CHAFA_BIN`. PNG input is limited to 8 MiB, 4096 pixels per side and eight million pixels. The child has a five-second deadline and 256 KiB combined output limit. Raw output is retained, but only bounded SGR color output enters the panel: no cursor, title or clipboard commands. The report records source/output hashes and execution metadata; it is not a geometry or model-evidence receipt. This increment qualifies a still PNG via ANSI symbols; animated playback, Kitty/Sixel/iTerm2 pixels and the older Projects-panel preview remain outside this change.

See [the software intake](VISION-SOFTWARE-INTAKE-20260915.md) for the supplied multi-camera, occupancy, Fractal and agent-harness references, their actual control paths, and their remaining limits.

Run `timmy vision integrations --help` for the installed dispatcher grammar. Gaussian inspection is also available through `timmy vision spatial models context examples/visual-tools/parameters.ply --kind gaussian-splats --json`. The UI and CLI share the same implementation rather than translating a natural-language status back into an operation.

The camera runner creates an intent, runs the fixed adapter process asynchronously, retains output, and records its result. It has a 15-minute timeout. The UI exposes pending and terminal results. It does **not** offer cancellation or durable UI recovery yet. File export and bounded PLY inspection run locally; PLY parsing remains synchronous. There is no new scheduler or receipt ledger.

Hashes identify bytes. A successful process does not certify a camera pose, model annotation, or physical material. PLY properties are raw parameters: opacity is not occupancy probability, solid fill, humidity or mass density. Model claims still require observed current-revision handles and successful `cite(handle_id)` calls; this panel does not manufacture those calls. The Gaussian helper's source fact identifiers are not model citations.

## Applying dmux and the other references

The adopted dmux pattern is a selectable tool/task row, a detail view, an explicit action, and a visible result. Installation, execution, verification and merge status remain separate. Current upstream is [standardagents/dmux](https://github.com/standardagents/dmux). Its [hooks](https://github.com/standardagents/dmux/blob/main/src/utils/hooks.ts) can connect owned worktrees to Timmy later; `--remote-pane-action` requires a live tmux/dmux controller and is not an independent headless runner. No public MCP/SDK was qualified. Automatic merge/force-cleanup is not enabled on Timmy's shared checkout.

The motion HTML uses an explicit timeline. HTML preview and native MP4 render are separate actions with separate statuses. OpenDesign cloud generation, OpenSplat reconstruction/training, historical Chumpy/OpenDR/Chainer experiments, TermGL, Oryx and Process Compose are not installed or represented as operational by this change. Their useful controls can enter the same panel when an actual adapter and bounded qualification exist. In particular, a Linux eBPF viewer is not a Mac capture-readiness fix, and a splat renderer is not a solid-volume verifier.

## Why this small layer exists

The concrete failure was usable helpers hidden behind source files and status-only integration lists. One fixed operation service connects existing helpers to a TUI panel. Cost: seven dispatch paths, transient UI state, and local output files. No extra persisted job state, authority heuristic or recovery ledger is introduced. Deleting the panel/service would return users to hand-assembled commands. Authority comes from the user's explicit action plus fixed tool contracts; the result reports observed execution and computed measurements, never an agent's assertion of success.
