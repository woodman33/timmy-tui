# Agent / tool activity (a Rive component; the editable source)

The agent-activity component (R11 round 5, H174): what the chat turn is doing now, DRIVEN by the backend — H169's SSE on
`POST /api/chat/turn` (`route` · `turn` · `delta` · `tool` · `needs-you` · `done` · `error`), Stop (`POST /api/chat/stop`), mapped
by `rive-bindings.js` `fromSse` / `stopping`: `turn` / `delta` / `tool` → working · `needs-you` → awaiting (approval) · Stop pressed
→ stopping · `done` status `cancelled` → stopped · `done` status `failed` or `error` → failed · `done` (answered) → idle. Never a
timer, never invented. The HTML label beside the component carries the exact word ("awaiting approval" for awaiting).

| What | Name |
|---|---|
| Artboard | `TimmyActivity` (128 × 128: a prompt bar, the cursor, a hand bar, a stop square, a cross, the frame) |
| State machine | `Activity` |
| Inputs | `activity` (Number: 0 idle · 1 working · 2 awaiting · 3 stopping · 4 stopped · 5 failed); `selected` (Bool); `expanded` (Bool; reserved) |
| Animations | `Idle`, `Working` (the cursor blinks), `Awaiting` (the amber hand bar breathes: NEEDS YOU), `Stopping` (the square draws in), `Stopped` (the square, still), `Failed` (the amber cross), `Selected` |

States and their meaning: **idle** — no turn runs on this page; **working** — the turn streams or a tool runs; **awaiting** — the
agent asked the person (NEEDS YOU) and waits; **stopping** — Stop was pressed, the companion was asked; **stopped** — the turn
ended cancelled; **failed** — the turn failed. No state draws a receipt or a progress number: the evidence line is the page's.

The compiled `activity.riv` is NOT here (see ../welcome/README.md).
