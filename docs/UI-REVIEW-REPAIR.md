# Local UI review repairs

The default ShellV2 now shares its actual chat history and live agent deltas
with the browser companion through the existing synchronization hook. Its
first lazy chat send waits until the listeners attach. Disabled and NOOP
shells publish nothing; unmounting removes the listeners and the matching
browser command target.

Live broadcasts use `{ type: 'sync', data: messages }`; reconnect snapshots
use `{ type: 'sync', history: messages }`. The browser accepts both, refuses
malformed message lists before changing its cached chat, and escapes tool
arguments and event labels as text. HTTPS pages use secure WebSockets.

The companion connection label describes the observed socket state. A
socket connection or displayed assistant reply does not establish Durable
Object persistence. The mirror caches chat in the current browser.

The live-log page embeds the server palette values instead of referencing a
server-only `theme` object. It skips unreadable events, retains the latest
200 rows with an omission notice, and shows empty or unavailable receipt
history and verification request failures.

Regression coverage lives in `tests/logserver.test.ts`,
`tests/companion-client.test.ts`, and `tests/companion-sync.test.tsx`.
The page-script controls run the served JavaScript; ShellV2 controls use
synthetic agent events without provider calls. Existing real PTY controls
exercise navigation and text entry with integrations unavailable. These are
local development controls, not release, provider, native-job or remote
sandbox qualification.

This repair follows DOCTRINE §§2, 3, 13 and 16, DESIGN §§3.7 and 5.4, and
preserves the forge boundary in decisions D1/D2/D4. It changes no forge
execution, dispatcher authority, shared receipt history or model routing.
