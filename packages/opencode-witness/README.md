# @timmy/opencode-witness

OpenCode plugin (ORDER witness-o7c2 C1) that turns a hand's tool calls into receipt evidence.

Hook contract verified against `@opencode-ai/plugin` **1.18.31** — the exact version of the installed
`opencode` binary — whose `Hooks` keys are `"tool.execute.before"`, `"tool.execute.after"` and
`"shell.env"`. This package types them structurally and does **not** depend on `@opencode-ai/plugin`,
so it installs, type-checks and tests offline.

## What it seals

| hook | subject | binds |
| --- | --- | --- |
| `tool.execute.before` | `witness.intent` | tool, `args_sha256` (canonical: keys sorted at every depth), order id, head hash, sessionID, callID |
| `tool.execute.after` | `witness.result` | tool, `args_sha256`, `output_sha256`, `output_bytes`, `managed_output`, order, head, callID |
| `shell.env` | `witness.shell.env` | order, head, `cwd_sha256` — and injects `TIMMY_ORDER` / `TIMMY_HEAD` into the shell env |
| any refusal | `witness.denial` | reason, `guarded_id`, `path_sha256`, status `denied`, tool, callID, order, head |

Seals go through the repo's `appendReceipt('runs', …)`: single-writer locked, hash-chained, and
`TIMMY_STORE`-honouring so tests never contend. No argument value, path or output text is written to the
chain — only hashes. A denial is sealed *before* it throws, so a blocked call still leaves evidence.

## Refusals (fail closed)

- **Outside an order.** `TIMMY_ORDER` and `TIMMY_HEAD` must both be bound and non-empty. All three hooks
  throw `WitnessRefusal('no_order')` and seal nothing — there is no order to bind. A half-bound order
  (id without head) is refused the same way.
- **Guarded paths.** Any string anywhere in the arguments matching `.env` / `.env.*`, `.timmy/private/`,
  or `lanes/privacy/overlay.*` throws `WitnessRefusal('guarded_path')`. This is deliberately blunt:
  `.env.example` is refused too, because a witness does not parse intent. Narrow `GUARDED_PATHS` in
  `src/witness.ts` if that ever blocks real work.

## Managed Tool Output File

Not an OpenCode term — the after-hook exposes only `{title, output, metadata}`. It is the harness-persisted
file a large tool result spills to (the truncated-output / `<persisted-output>` case). The witness finds it
by a metadata key matching `/managed|persisted|output_?file|outfile|truncated_?to/i`, otherwise by a
`*.output` path in the output text, and binds `{path, sha256, size}`. A referenced path that does not
exist is bound as `{path, missing: true}`; nothing referenced means `managed_output: "none"`. It never
fabricates a file and never copies the spilled content into the chain.

## Loading

Repo-resident by design — it seals into this repo's chain and imports `src/utils/receipts.ts`:

```json
{ "plugin": ["./packages/opencode-witness/src/index.ts"] }
```

The order context arrives by env, so pair it with whatever binds `TIMMY_ORDER` / `TIMMY_HEAD` for the hand
(`shell.env` re-injects both into every shell the harness spawns).

## Limits and follow-ups

- No `dist` build; loaded as TypeScript by Bun/tsx. Publishing the package needs a build step.
- Actor attribution is **not** sealed here. `detectSession()` (`src/utils/session.ts:40-46`) tested
  `CLAUDECODE` before `QWEN_CODE` and produced three different actor stamps across three calls in one
  session, so binding it would seal a wrong attribution. The witness binds order + head instead.
- Root `tsc` covers `src/**` only; this package carries its own `tsconfig.json` and is also added to the
  root `include` so the shared gate still checks it.

## Tests

`tests/opencode-witness.test.ts` — 15 tests. Fake tool calls shaped exactly like OpenCode's hook inputs,
a fake seal sink for the behavioural assertions, and one test that writes a real hash-chained receipt into
a temp `TIMMY_STORE` to prove events reach `runs.jsonl`.
