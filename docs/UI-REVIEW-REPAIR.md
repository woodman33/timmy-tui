# Local UI review repairs

The default ShellV2 now shares its actual chat history and live agent deltas
with the browser companion through the existing synchronization hook. Its
first lazy chat send waits until the listeners attach. Disabled and NOOP
shells publish nothing; unmounting removes the listeners and the matching
browser command target.

Replacing the NOOP or an existing agent hydrates retained conversation and
resets transient UI state before the first mirror snapshot or send. The full
App owns synchronization and opts its nested ViewStage/ShellV2 out; a
standalone shell owns its own sync. This preserves the parent's active run
and receipt metadata and emits each delta/tool update once.

Live broadcasts use `{ type: 'sync', data: messages }`; reconnect snapshots
use `{ type: 'sync', history: messages }`. The browser accepts both, refuses
malformed message lists before changing its cached chat, and escapes tool
arguments, event labels and saved-chat previews as text. Saved prompt bytes
remain intact in browser storage. Saved-card action IDs are encoded for
their HTML/JavaScript context. HTTPS pages use secure WebSockets.

The companion connection label describes the observed socket state. A
socket connection or displayed assistant reply does not establish Durable
Object persistence. The mirror caches chat in the current browser.

The live-log page embeds the server palette values instead of referencing a
server-only `theme` object. It skips unreadable events, retains the latest
200 rows with an omission notice, and shows empty or unavailable receipt
history and verification request failures.

Regression coverage lives in `tests/logserver.test.ts`,
`tests/companion-client.test.ts`, `tests/companion-sync.test.tsx`, and
`tests/companion-owner.test.tsx`.
The page-script controls run the served JavaScript; ShellV2 controls use
synthetic agent events without provider calls. Existing real PTY controls
exercise navigation and text entry with integrations unavailable. These are
local development controls, not release, provider, native-job or remote
sandbox qualification.

These controls cover the normal source CLI review path and App/standalone
shell composition. The optional `src/tui/fast-entry.tsx` bundle uses a
different companion bootstrap; mirroring through that entry remains a
separate follow-up.

This repair follows DOCTRINE §§2, 3, 13 and 16, DESIGN §§3.7 and 5.4, and
preserves the forge boundary in decisions D1/D2/D4. It changes no forge
execution, dispatcher authority, shared receipt history or model routing.
