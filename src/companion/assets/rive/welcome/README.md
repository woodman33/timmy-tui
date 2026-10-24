# Welcome / guide (a Rive component; the editable source)

The branded welcome component of the companion page and the Canvas (R11 round 5, H174): the T mark at rest, and a guide ring
that plays ONCE when the person triggers it — a click, Enter or Space on the component (`rive-bindings.js` fires the trigger only
for a trusted user event; nothing fires it automatically).

| What | Name |
|---|---|
| Artboard | `TimmyWelcome` (128 × 128: black ground, amber T, a guide ring, the frame) |
| State machine | `Welcome` |
| Inputs | `welcome` (Trigger: the person's press → the `Guide` animation, one pass, then `Idle`); `selected` (Bool: tldraw's selection, the frame brightens); `expanded` (Bool: the shape resized wider; reserved, no visual yet) |
| Animations | `Idle` (ping-pong, 3 s), `Guide` (one shot, 1.5 s), `Selected` (a held pose) |

States and their meaning: **Idle** — nothing asked; **Guide** — the person asked for the guide (a preview of what the page can do,
drawn by the animation only; it runs nothing). The HTML label beside the component carries the word.

The compiled `welcome.riv` is NOT here: `scene.rml` is the source, in the format of `src/companion/assets/mark/scene.rml` (the
operator's preview transfer); the `.riv` is compiled by the Rive tooling from this source (the lead asks the operator), and placed
beside it as `welcome.riv` — never made up here. The state-machine input and condition elements (`StateMachineTrigger`,
`StateMachineBool`, `TransitionTriggerCondition`, `TransitionBoolCondition`) are drafted from the runtime's type names; the compile
is what verifies them.

> R11 round 5, 2026-10-24: the operator's compiled asset `../timmy-ui/timmy-ui.riv` (one state machine `TimmyUI` on three artboards) now carries this component; the page draws its artboard (see ../timmy-ui/README.md). This folder stays as the earlier hand-written draft, uncompiled.
