# C1: guarded local fallback

Run from the order worktree:

```sh
node_modules/.bin/tsx tools/ctx-c3w8/c1-checkpoint.ts
```

The runner creates a new directory under `studio/ctx-c3w8/C1/` and seals its
prediction through `appendReceipt` before executing the controls. Artifact
writes use exclusive creation. Replays create new artifacts and receipts;
previous results are never rewritten. The worktree's store pin selects the
canonical receipt stream. Full signed receipts are also retained with the run,
with relative artifact paths, source SHA-256 hashes, and an environment lock
that records the actual OS and architecture without private tool paths.

The checkpoint checks:

- A cloud model tag is refused before any transport request or inference.
- The live daemon at `http://127.0.0.1:11434` advertises at least one model with
  local weight metadata. Only `/api/tags` and `/api/show` are called.
- The actual `Agent.tryOllamaLastResort` method selects a local candidate and
  returns a controlled response. A separate loopback HTTP fixture advertises
  a cloud tag, an alias with remote metadata, and a local candidate; only the
  last can reach its fixture chat route. This exercises the real fallback
  method, without sending an upstream request or loading a model.
- The focused provider tests pass.

The client guard accepts only loopback origins, rejects redirects, cloud tags,
and remote model metadata, checks installed completion weights, applies finite
deadlines, and rechecks the selected model before submitting the prompt. Its
existing probe, selection, and completion exports remain compatible. The core
change only adjusts preferred local model prefixes.

The retained transport observation covers this Node process's fetch admission
and Undici request creation. The test subprocess uses mocked transport. C1 does
not execute real model inference, exercise an MCP transport, trace the Ollama
daemon's network activity, or establish a whole-machine airgap. A separate
signed finding records those limits. Its `ok` receipt status means the finding
was recorded; it is not a passing daemon-egress test. The expected cloud-tag
refusal is retained with receipt status `denied`.

First successful run:
`studio/ctx-c3w8/C1/1789232710465-6a1c9dc3-7510-4c2f-8e26-9264cc6d93a8/`.
All six predeclared checks passed, including 17 provider tests, zero transport
calls for the cloud negative control, ten live local candidates, and the
controlled fallback's one tags / three show / one chat requests.
