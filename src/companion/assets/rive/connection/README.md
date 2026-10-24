# Provider connection (a Rive component; the editable source)

The connection feedback component (R11 round 5, H174), one per provider card (OpenRouter, Ollama · local, Ollama · cloud,
Cloudflare). Its state is DRIVEN by the backend: `GET /api/connections` (H170's providerStates words), mapped by
`rive-bindings.js` `fromProviderState`: `checked` → connected · `pending` → checking · `refused` / `unreachable` → failed ·
every other word (`not set up`, `saved, not checked`, `not installed`, `installed, stopped`, `installed, not checked`) →
disconnected. A selection is never a connection. The HTML label beside the component carries the exact word.

| What | Name |
|---|---|
| Artboard | `TimmyConnection` (128 × 128: a ring, a green dot, an amber cross, the frame) |
| State machine | `Connection` |
| Inputs | `connection` (Number: 0 disconnected · 1 checking · 2 connected · 3 failed); `selected` (Bool); `expanded` (Bool; reserved) |
| Animations | `Disconnected` (grey ring, still), `Checking` (the ring turns, amber, loops while the check is in flight), `Connected` (the ring settles, the green dot: green only for the observed fact), `Failed` (the amber cross), `Selected` |

States and their meaning: **disconnected** — nothing checked answered yet (a saved key is not a connection); **checking** — a
check or a sign-in is pending; **connected** — the provider answered the check (an observed fact, `checked`); **failed** — the
provider refused the key or did not answer.

The compiled `connection.riv` is NOT here (see ../welcome/README.md: the compile path is the Rive tooling's; the element names of
the inputs and conditions are drafted from the runtime's type names and verified only by that compile).
