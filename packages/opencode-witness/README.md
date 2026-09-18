# @timmy/opencode-witness

OpenCode plugin (ORDER witness-o7c2 C1) that turns a hand's tool calls into receipt evidence.

Two versions, recorded separately because they do not have to match:

| what | version | evidence |
| --- | --- | --- |
| OpenCode CLI | **1.18.31** | `opencode --version`; `/opt/homebrew/bin/opencode` → `Cellar/opencode/1.18.31` |
| `@opencode-ai/plugin` (installed) | **1.4.7** | `~/.opencode/node_modules` **and** `~/.config/opencode/node_modules`, both 1.4.7, with `@opencode-ai/sdk` 1.4.7 alongside |

The hook shapes were read from the installed **1.4.7** `dist/index.d.ts`: `Hooks` at line 170,
`"tool.execute.before"` 231-237, `"shell.env"` 238-244, `"tool.execute.after"` 245-254, `Plugin` 51,
`PluginModule {id?, server, tui?: never}` 52-54. The registry's 1.18.31 tarball happens to carry identical
shapes for these three hooks, but a registry version is not evidence about a local install — the installed
1.4.7 is the authority. This package types them structurally and does **not** depend on
`@opencode-ai/plugin`, so it installs, type-checks and tests offline.

## What it seals

| hook | subject | binds |
| --- | --- | --- |
| `tool.execute.before` | `witness.intent` | tool, `args_sha256` (canonical: keys sorted at every depth), order id, head hash, sessionID, callID |
| `tool.execute.after` | `witness.result` | tool, `args_sha256` **from the intent**, `args_drift` (false, or the after-hash when the args changed), `intent_receipt` + `intent_hash`, `output_sha256`, `output_bytes`, `managed_output`, order, head, callID |
| `shell.env` | `witness.shell.env` | order, head, `cwd_sha256` — and injects `TIMMY_ORDER` / `TIMMY_HEAD` into the shell env |
| any refusal | `witness.denial` | reason (`guarded_path`, `managed_output_redirect`, `orphan_result`, `intent_mismatch`, `context_changed`), `guarded_id`, `path_sha256` or `detail_sha256`, status `denied`, tool, callID, order, head |

Seals go through the repo's `appendReceipt('runs', …)`: single-writer locked, hash-chained, and
`TIMMY_STORE`-honouring so tests never contend. No argument value, path or output text is written to the
chain — only hashes. A denial is sealed *before* it throws, so a blocked call still leaves evidence.

## Refusals (fail closed)

- **Outside an order.** `TIMMY_ORDER` and `TIMMY_HEAD` must both be bound and non-empty. All three hooks
  throw `WitnessRefusal('no_order')` and seal nothing — there is no order to bind. A half-bound order
  (id without head) is refused the same way.
- **Guarded paths, including aliases.** Any string anywhere in the arguments matching `.env` / `.env.*`,
  `.timmy/private/`, or `lanes/privacy/overlay.*` throws `WitnessRefusal('guarded_path')`. Matching runs
  on the raw string **and** on `normalizePathish()`, a lexical normalization (collapses `.`/`..`, expands
  a leading `~`, drops duplicate and trailing separators, clamps a `..` that would escape the root) used
  for guard decisions only — never to open a file. Patterns are case-insensitive because the host
  filesystem is. So `/x/.timmy/pub/../private/y`, `~/work/.timmy/pub/../private/orders.log` and `.ENV`
  are all refused. This is deliberately blunt: `.env.example` is refused too, because a witness does not
  parse intent. Narrow `GUARDED_PATHS` in `src/witness.ts` if that ever blocks real work.
- **Identity is the `(sessionID, callID)` pair** — `intentKey()`, a JSON pair, so `callID` alone (which is
  not unique across sessions) is never the key and no value can forge the separator.
- **A duplicate pending intent is refused**, not overwritten: a second `tool.execute.before` for the same
  identity throws `WitnessRefusal('duplicate_intent')` *before* any replacement is sealed, and the denial
  cites the original intent's receipt id and hash. The original stays authoritative and still binds its
  own result.
- **A result must present its matching intent.** `tool.execute.after` is refused unless that identity was
  sealed by `tool.execute.before` in this witness instance:
  - `orphan_result` — no pending intent for that identity (a replayed after-hook, since an intent is
    single-use and dropped once its result is sealed; or an after-hook from a different session);
  - `intent_mismatch` — the after-hook names a different tool than the intent (session is already bound
    by the identity key);
  - `context_changed` — `TIMMY_ORDER` / `TIMMY_HEAD` moved between the two hooks.
  Each refusal seals `witness.denial` first, then throws. The original intent seal is never edited or
  rebound, and the result always carries the *intent's* `args_sha256` plus `intent_receipt` /
  `intent_hash`; when the after-hook's args differ, that is flagged as `args_drift` rather than
  substituted. A nonempty `TIMMY_ORDER` / `TIMMY_HEAD` is context — not authorization, and not evidence
  of who is acting.

## Managed Tool Output File

Not an OpenCode term — the after-hook exposes only `{title, output, metadata}`. It is the harness-persisted
file a large tool result spills to (the truncated-output / `<persisted-output>` case). The witness finds it
by a metadata key matching `/managed|persisted|output_?file|outfile|truncated_?to/i`, otherwise by a
`*.output` path in the output text, and binds `{path, sha256, size}` — plus `realpath` when the resolved
path differs (on macOS a temp dir under `/var` resolves to `/private/var`, so that is common and benign).
A referenced path that does not exist is bound as `{path, missing: true}`; nothing referenced means
`managed_output: "none"`. It never fabricates a file and never copies the spilled content into the chain.

**The candidate is untrusted input.** Metadata and output text are tool-controlled, so a tool could try to
redirect the witness into hashing `.env` or the private overlay. Two layers run *before* any `exists` /
`stat` / `read`:

1. the lexical guard — raw string and `normalizePathish()`, case-insensitive;
2. an **alias guard** — the candidate is resolved with `realpath` and the real path is guarded again, so a
   symlink (or a file under a symlinked directory) whose target is guarded is caught even when the
   presented name looks innocent. Resolution reads no content; an unresolvable path falls through to the
   `missing` branch.

A refused candidate is bound as `{refused: 'guarded_path', guarded_id, path_sha256, alias_of_sha256?}` and
seals a `witness.denial` with reason `managed_output_redirect`; the result seal still lands, so the call is
witnessed rather than silently dropped.

**Visibility, stated plainly.** A *refused* path is hash-only — no literal path enters the chain. A
*permitted* managed-output path is currently bound **literally** (`path`, plus `realpath` when it
differs), so allowed output paths remain visible in the receipt. Only file *content* is always hash-only.

## Loading

Repo-resident by design — it seals into this repo's chain and imports `src/utils/receipts.ts`:

```json
{ "plugin": ["./packages/opencode-witness/src/index.ts"] }
```

The order context arrives by env, so pair it with whatever binds `TIMMY_ORDER` / `TIMMY_HEAD` for the hand
(`shell.env` re-injects both into every shell the harness spawns).

## Limits and follow-ups

- **Runtime integration is NOT verified.** No `opencode` process has loaded this plugin, so "the harness
  calls these hooks" rests on the installed 1.4.7 type contract and the module-shape test, not on an
  observed run. Proving it in-harness belongs to witness-o7c2 C2.
- No `dist` build; loaded as TypeScript by Bun/tsx. Publishing the package needs a build step.
- The pending-intent registry is per witness instance and in memory. A harness restart between the two
  hooks leaves the after-hook an orphan, which is refused — fail-closed, at the cost of an unwitnessed
  result. Persisting intents is a follow-up if that proves common.
- Actor attribution is **not** sealed here. `detectSession()` (`src/utils/session.ts:40-46`) tested
  `CLAUDECODE` before `QWEN_CODE` and produced three different actor stamps across three calls in one
  session, so binding it would seal a wrong attribution. The witness binds order + head instead.
- Root `tsc` covers `src/**` only; this package carries its own `tsconfig.json` and is also added to the
  root `include` so the shared gate still checks it.

## Tests

`tests/opencode-witness.test.ts` — **37 tests**, run only in isolated per-test `TIMMY_STORE` dirs
(`tests/isolation-setup.ts`); no model calls, no real secret reads, no installs, no writes to the shared
chain.

- intent sealing: binding, canonical hashing (key order cannot change a seal, different args must), and
  no argument value in the seal;
- result sealing: output hash, `managed_output: "none"`, a real Managed Tool Output File bound by
  path+sha256+size with the safe path read and measured exactly once, and a missing file recorded as
  `missing: true` rather than invented;
- `shell.env` injection with pre-existing keys preserved;
- guarded-path refusals (`.env`, `.env.local`, a shell command cat-ing the private config, the private
  overlay, the private ledger, the overlay module, and a guarded path nested in the arguments), each
  sealing `witness.denial` and never an intent;
- managed-output redirect refusals via metadata and via output text, with adversarial `exists` /
  `readFile` / `sizeOf` spies on synthetic paths proving a forbidden path is never stat-ed, read or
  measured, and that no literal path or secret material reaches a seal;
- lexical aliases: `normalizePathish` unit cases, a `..` traversal that genuinely evades the raw pattern
  (asserted with `not.toMatch` before the refusal), `~` plus traversal, and case aliases (`.ENV`,
  `.Env.Local`);
- **symlink aliases against real synthetic temporary files**: a link named `innocent.output` pointing at a
  real `.env`, and a symlinked *directory* aliasing `.timmy/private`. In both, the presented name carries
  no guarded token, the spies record nothing (never stat-ed, read, measured), the seal contains neither
  the secret nor its hash, and a safe symlink still binds `path` + `realpath` + `sha256` + `size`;
- identity and duplicates: `intentKey` injectivity, a duplicate `before` refused before any replacement is
  sealed (one intent only, denial citing the original receipt, original still binds its result), the same
  `callID` in two sessions as two identities each binding its own after-hook, and a third session's
  after-hook as an orphan that leaves the pending intent intact;
- intent/result binding: orphan result, changed order, changed head, tool mismatch, replayed after-hook,
  argument drift flagged rather than substituted, and the no-drift positive control;
- one test writes a real hash-chained receipt into a temp store and asserts the two-row shape — one
  hash-bearing receipt plus one `receipt.sealed` bus notification whose `payload.id` / `payload.hash`
  match it — comparing hash-bearing raw rows against `readChain`;
- the module OpenCode loads exports a plugin function returning the three hooks.
