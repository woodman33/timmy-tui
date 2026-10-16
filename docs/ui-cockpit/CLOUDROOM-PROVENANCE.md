# Cloudroom Core adapter: provenance and what it can claim

Round R4, helper H121, 2026-10-15. Timmy's fleet adapter for one self-hosted Cloudroom Core lives in
`src/fleet/cloudroom/`; its tests are `tests/fleet-cloudroom.test.ts`. This page lists every upstream file that was
read to write it, what was copied, adapted or only read, what was deliberately left out, and what the adapter can and
cannot claim.

Status on the ladder (AGENTS.md §8): proposed, implemented, **exercised offline against a FAKE Core only**. Not
installed in any running Timmy, not wired in (`KNOWN_PROVIDERS` in `src/fleet/service.ts` still says Cloudroom is
unavailable; the lead wires it), never run against a real Cloudroom Core, and **not live-qualified**.

## Upstream sources, at the pinned revisions

Two repositories, read on this machine at fixed commits. Nothing in either was executed: no build, no test, no script.

| Repository | Revision | License |
| --- | --- | --- |
| Cloudroom Core (`cloudroom-core`) | `3949daaea3c7613458e9ad14afddbd267a0a56bc` | Apache-2.0 (`LICENSE`; the repository has no `NOTICE`) |
| Cloudroom GUI (`cloudroom-gui`) | `f939f4103c5a2946f03d85de37af94d1a58053fb` | Apache-2.0, plus a `NOTICE`: based on BB (get-bb/bb), MIT, whose notice it retains |

### Cloudroom Core (Apache-2.0)

| File | How it was used |
| --- | --- |
| `LICENSE` | **Copied verbatim** to `src/fleet/cloudroom/LICENSE-cloudroom-core.txt` (sha256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`). The privacy gate finds nothing in it. |
| `integrations/bb/client.ts` | **Adapted** into `src/fleet/cloudroom/client.ts`. The file's header names the source, revision and license and says "Modified by Timmy (R4 H121)", with what was kept, added, changed and dropped. |
| `integrations/bb/client.test.ts` | Read only. Its cases (401 bodies never read, redirects refused, a retried id, out-of-order records) shaped Timmy's tests; no test code was copied. |
| `docs/api.md` | Read only: the HTTP contract (auth, 202, request ids, receipts, records, pages, SSE, child requests, errors). |
| `docs/session-lifecycle.md` | Read only: close, sleep, restart, `unknown` / `unknown_after_restart`, the recovery check. |
| `src/session/thread.rs`, lines 1–425 | Read only: child requests (`APP_WAIT` 60 s, `APP_MISSED_FOR` 5 min, the `child_request` record, `answer_child`'s 202 / 404 / 409). |
| `src/session/children.rs`, lines 1–470 | Read only, for exact shapes: the `child` record (`{id, request_id, tool_call_id, state, result?}`) and `child_thread` (`{id, harness, title}`), and `spawn_child`. |
| `src/api/mod.rs` | Read only: routes, the bearer check (`Authorization` or `X-Cloudroom-Token`), the error body and code mapping, `request_status`, `recovery`, `session_workspace`, `events` (256 a page) and `stream` (SSE `record`, `Last-Event-ID`, never ends by itself). |
| `src/session/state.rs` | Read only: how `receipt` and `state` records change a session (`current_request` from each state record; which receipt states are final). |
| `src/session/mod.rs` | Read only, in parts: the `Record`, `Receipt` and `Session` structs; `command()` (its checks, in order: interrupt only the active request, close refused while `starting`, nothing on a closed, failed or `process_lost` session); `records()`; `recovery_check()`; the start, dispatch and turn-end records; restart rules. |
| `src/session/catalog.rs` | Read only: `list_sessions` and `capabilities` (flags, harness entries, `repository`). |
| `src/lib.rs` | Read only: the `FEATURES` flag names (the FAKE Core lists them as Core 3949daa's flags). |
| `src/runtime/mod.rs` | Read only: the harness ids (`Kind`) and per-harness capabilities. |
| `src/runtime/codex.rs`, `src/runtime/claude.rs`, `src/runtime/pi.rs` | Read only, short excerpts: how each harness fills `text_delta` and `item_completed` (the adapter finds the final assistant text in each). |
| `src/workspace/mod.rs` | Read only: `checkout()` answers `{path, branch, head}`. |
| `AGENTS.md` | Shown while reading; read only. |

### Cloudroom GUI (Apache-2.0; NOTICE: based on BB, MIT)

| File | How it was used |
| --- | --- |
| `gui/apps/server/src/services/cloudroom/client.ts` | Compared byte for byte with the core's `integrations/bb/client.ts`: identical. Timmy adapted the **core's** copy. |
| `gui/apps/server/src/services/cloudroom/events.ts` | Read only, for facts: a turn ends on a `prompt` or `auto` receipt in a final state; a `child` record is "started" until its state says otherwise; text fields differ by harness. |
| `gui/apps/server/src/services/cloudroom/commands.ts` | Read only, two parts: the capability schema (every missing flag defaults to false) and how the app answers a child request (before the record counts as read; 404 and 409 are final; a network error is retried briefly). |
| `NOTICE` | Read: the BB MIT notice. |
| `gui/AGENTS.md` | Shown while reading; read only. |

**Nothing was copied from the GUI**, so the BB MIT notice does not attach to any Timmy file. One open question for
the operator: the same `client.ts` sits in both repositories. Timmy took it from the core, under the core's
Apache-2.0. If the operator reads the GUI's NOTICE as covering that file too, the short BB MIT notice should travel
with `src/fleet/cloudroom/client.ts`.

## Deliberately not reused

| Upstream | Why not |
| --- | --- |
| GUI `sandboxes.ts` | It copies the Mac's sign-ins (Codex, Claude, gh, Cursor and the like) into sandboxes. Timmy copies no logins (the operator's rule), so it was not reused, and not opened. |
| `runOnVm` in the client (core `POST /v1/vm/run`) | A shell on the Core machine: a host-control bridge. Not wrapped; the adapter cannot reach it. The Mac and VM job routes (`/v1/mac/...`) are not wrapped either. |
| Teleport (`/v1/teleports...`) | Moving a local conversation and its files to the cloud is out of scope for a fleet worker. |
| Accounts and logins, Pi and Cursor setup, Claude version matching | Harness sign-ins are made on the Core machine itself; Timmy reads and copies none. |
| Attachments and upload parts, edit, cancel, reorder, steer, compact, goal, rewind, sleep, detach, secret answers, the dashboard, workspace mappings, the client's snapshot replay `events()` | Not needed by the fleet. `eventsPage` replaces the replay helper. |
| The `X-Cloudroom-Token` header copy and the gate cookie | One copy of the credential on the wire, in `Authorization` only. Timmy does not run behind the GUI's sandbox proxies. |

## What the adapter can claim

All of it **exercised offline** in `tests/fleet-cloudroom.test.ts`, against the FAKE Core
(`src/fleet/cloudroom/fake-core.ts`: an in-process server on 127.0.0.1 that keeps the contract above and says FAKE in
every response), with Timmy's real scheduler, ledger and event store:

- A command answered 202 is recorded as accepted, never as done. Each command carries its own id derived from Timmy's
  (`:` becomes `_`; at most 64 characters; a hash past that). An unconfirmed command (a connection error, a timeout, a
  503) goes again with the same id, a bounded number of times, never under a new one.
- An `unknown` or `unknown_after_restart` receipt fails the worker ("the runtime could not say whether the work ran
  (unknown); it is not resent") and nothing is resent, by the run or by a later reconcile.
- Core's records are kept beside Timmy's events (kind, data and native line), with the Core machine's folder paths left
  out. The prompt's `completed` receipt is delivered, never verified.
- A dropped stream resumes from the persisted cursor with nothing lost or repeated.
- Every child request is refused at once (well inside Core's wait), so Core's fallback into the parent's folder does not
  fire while Timmy reads the stream. The FAKE's negative control shows that fallback does fire when nobody answers.
- A child that starts in the parent's folder anyway (`--shared-sandbox`, a harness's managed child, a missed answer)
  is seen and fails its worker under a plan that wants one sandbox per worker; its turn is interrupted and its session
  closed. This was exercised with a FAKE stand-in provisioner that claims one Core per VM: no such provisioner exists.
- A cancel interrupts a running task and closes its session, each with its own id; a task still queued at cancel is
  paused (stop) and then failed by the close, so it never runs; queued workers never reach the Core.
- `collect` runs before close and returns the final assistant text, redacted, and the session's branch and commit.
- No token reaches a `.timmy` file, an error, an event or a receipt; the token file must be 0600 and is read only when a
  request is made; the config holds no credential.
- 100 workers on one FAKE Core never had more than the cap (8) open at once: 100 sessions, 100 starts, 100 prompts.

## What it cannot claim

- **Nothing here was run against a real Cloudroom Core.** The adapter is not live-qualified: no real harness, model,
  account, TLS endpoint, proxy, restart, sleep or storage failure was observed. The FAKE simplifies on purpose: no model
  catalog, no child sessions (only the parent's records), no database, no restart or sleep.
- **A worker is a session on a shared machine, not isolated**: it shares the Core's account, files and machine with every
  other session. The shared-Core provisioner offers only `shared-session`; a plan asking for a VM, a microVM or a
  provider sandbox is refused in words.
- **Child detection is not prevention.** A child can run in the folder until its record is read. A child request that
  arrives while Timmy is not reading the stream (between a drop and the resume, or with Timmy stopped) can miss Core's
  60 s wait; then the child runs in the parent's folder, and for 5 minutes every spawn on that Core shares its parent's
  folder without asking. Codex's own sub-agents run inside the harness and appear only in its native lines; the adapter
  does not count them as child sessions.
- **The work is not collected.** Core serves no file contents: the work stays on the Core machine in the session's
  branch and commit. Timmy keeps only the final assistant text, and finds it by harness-specific fields read at 3949daa;
  another revision may change them.
- **Throughput was not measured on a real Core**, which writes a record per text delta; every record becomes one stored
  event in Timmy.
