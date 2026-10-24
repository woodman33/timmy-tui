# Timmy's native Rive UI controls (the operator's asset; a proposed native UI, not a final design)

`timmy-ui.riv` is the compiled, self-contained Rive runtime asset the operator built with his Rive tooling (R11 round 5, received
from his package on 2026-10-24; sha256 `9fd9ae7c098187df4646f0ed581e6c7019173903078ac419ad7765ac7a1beac6`, 405,278 bytes): native
vector/text UI components with real state-machine inputs, pointer listeners and timelines — not CSS, not an HTML rendering. The
repo's `.gitignore` keeps `*.riv` out except under `src/companion/assets/rive/` (`!src/companion/assets/rive/**/*.riv`): a received
asset like this one is committed; nothing compiled here ever is (no Rive tooling runs in the build). The earlier commit f5d70969
said the asset was carried in; it was not — the ignore rule held it back — and the commit that adds it says so. Beside it, its editable source: `scene.rml` (the Rive source), `rive.yaml`, `create-controls.py` (the generator
that wrote the source; its one line that copied the font from a folder of the operator's computer is replaced by a comment: the
font is kept here), `Montserrat.ttf` with its license `OFL.txt` (SIL Open Font License, retained).

| What | Value |
|---|---|
| File | `timmy-ui.riv` · 405,278 bytes · sha256 `9fd9ae7c098187df4646f0ed581e6c7019173903078ac419ad7765ac7a1beac6` |
| Artboards | `AgentConsole` 640 × 380 (native text, status illustrations, a working ring, a preview-only action) · `ProviderCard` 400 × 260 (the connection-state panel) · `ActionButton` 240 × 72 (native text, hover outline, pressed wash, click) |
| State machine | `TimmyUI`, one on each artboard |
| Inputs | `State` Number: 0 Idle · 1 Working/Checking · 2 Approval · 3 Stopped · 4 Failed — `Hover` Bool — `Pressed` Bool — `ReducedMotion` Bool (zero-duration state transitions; the runtime settles each pose and stops moving) |
| API | the state-machine-inputs API of `@rive-app/canvas` 2.37.8 (the runtime the companion serves at `/vendor/rive/`) |
| Listeners | native pointer listeners set Hover / Pressed; the native inspect button sets State = 1 on a click |
| By design | "No green success state, fake receipt or model response is authored." The asset's states are interaction previews until a verified backend event sets them. |

## How the page's vocabularies map onto it (`src/companion/client/rive-bindings.js`, `TIMMY_UI`)

| Component | Artboard | This page's word → native input |
|---|---|---|
| Agent / tool activity (the chat turn's SSE, fed by chat-shell.js) | `AgentConsole` | idle → State 0 · working → 1 · awaiting (approval) → 2 · **stopping → 1** (no stopping pose: the turn still runs while Stop is asked; the backend's `cancelled` makes it) · stopped → 3 · failed → 4 |
| Provider connection (GET /api/connections) | `ProviderCard` | disconnected → State 0 · checking → 1 · **connected → 0** (no success pose is authored: the native card stays Idle and the HTML label beside it says "connected" — the Inspect view says so) · failed → 4 |
| Welcome / guide (the person's click, Enter or Space) | `ActionButton` | the press → Pressed true, released on the next frame; the pointer over it → Hover; Enter / Space held → Pressed |
| Canvas selection (tldraw) | any | selected → Hover (the native outline stands for the selection) · expanded → no native input (HTML only) |
| prefers-reduced-motion | any | ReducedMotion → true on load |

Every binding event records the word AND the native input it set (`State 1`, `Pressed true`): the Inspect animation view lists
them with the backend source that set each state. The three drafted folders beside this one (`welcome/`, `connection/`,
`activity/`) keep the earlier hand-written sources as drafts; the page draws this asset.
