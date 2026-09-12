# lanes/abilities — measured harness abilities

What each of six locally installed agent harnesses can *actually* do, measured by running them
(not by reading their docs). Everything here is produced by one runner:

```
node lanes/abilities/probe.mjs                 # all harnesses, all probes, concurrently
node lanes/abilities/probe.mjs --harness pi     # one harness (comma-separate for several)
node lanes/abilities/probe.mjs --probe one_shot,file_edits --harness hermes
node lanes/abilities/probe.mjs --serial --timeout 90000
```

Requirements: Node 22+, `OPENROUTER_API_KEY` in the environment (fallback: an `OPENROUTER_API_KEY=`
line in the worktree `.env` or the repo-root `.env`), Ollama running on `localhost:11434` for `pi`,
and Timmy's worktree `node_modules` (the MCP probe launches `node_modules/.bin/tsx src/cli.ts mcp serve`).
The key is only ever placed in a child process environment; every string written to disk passes
through a redactor, and any `auth.json` / `.env` a harness copies into its isolated home is deleted
after the run.

## Files

| path | what |
|---|---|
| `probe.mjs` | the runner (ESM, no deps): spawns, times out, transcribes, evaluates, writes results |
| `harnesses.json` | the per-harness plan: binary, model route, isolation env, discovery commands, argv per probe, MCP setup |
| `transcripts/<harness>.jsonl` | one JSON object per spawned process: `{i, ts, probe, argv, cwd, exit, ms, stdout, stderr, timed_out}`; stdout/stderr truncated to 4000 chars (head 2400 + tail 1600) |
| `results/<harness>.json` | version, binary path + sha256, model route, isolation, and per-ability `{value, method, evidence:[transcript ids], note}` plus exact argv/exit/ms per probe |

`value` is `true` / `false` / `null` (= could not be measured; the note says why). Evidence ids are
`i` fields in the harness's transcript. Evaluation runs on the *full* untruncated output; the note
quotes the matching snippet so the truncated transcript can still be checked.

## Isolation

No probe touches a real user config directory. Each harness gets a fresh home under the scratch root
(`harnesses.json` -> `scratch_root`, override with `ABILITIES_SCRATCH`):

| harness | isolation |
|---|---|
| jcode | `JCODE_HOME=<scratch>/jcode/home` + `--socket <home>/jcode.sock` (private daemon, stopped at the end) |
| opencode | `OPENCODE_CONFIG_DIR=<scratch>/opencode/home`; MCP via a project `opencode.json` in the probe cwd; `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` |
| pi | `PI_CODING_AGENT_DIR=<scratch>/pi/home` with a runner-written `models.json` (Ollama provider) and `settings.json` |
| hermes | `HERMES_HOME=<scratch>/hermes/home`; MCP block written into that home's `config.yaml` |
| openhands | `HOME=<scratch>/openhands/fakehome` **and** `OPENHANDS_PERSISTENCE_DIR`; public-skills cache copied in from the user's cache so no clone is needed |
| minds | nothing written; only read-only diagnostics run |

## The probes

Each probe runs in a fresh empty temp dir with a hard 120 s timeout (SIGTERM, then SIGKILL of the
whole process group so MCP servers / daemons the CLI forked die too).

| ability | prompt | true iff |
|---|---|---|
| `one_shot` | `Reply with exactly the word PONG and nothing else` | the process exits by itself and stdout+stderr contains `PONG` **after every echo of the prompt text is removed** (JSON-streaming harnesses echo the user message, which contains PONG) |
| `file_edits` | `Create a file named PROBE.txt in the current directory containing exactly the text probe-ok, then stop.` | `<cwd>/PROBE.txt` exists afterwards and equals `probe-ok` (one trailing newline tolerated) |
| `tool_use` | ``Run the shell command `echo TOOL-OK-4471` and report its output verbatim.`` | output (prompt echoes removed) contains `TOOL-OK-4471`. The token is in the prompt, so the note also records tool-call event lines (per-harness `tool_call_regex`) and the `file_edits` verdict as corroboration |
| `browser` | `Fetch https://example.com and report the exact page title.` | output contains `Example Domain`; the note says whether browser-like or plain fetch/curl-like tool names were visible |
| `sandbox` | ``Run the shell commands `hostname` and `pwd` and report both verbatim.`` | **true** if a different hostname or a container-style path comes back; **false** if this machine's hostname comes back; **null** if neither (commands evidently not run). For openhands `docker ps --format {{.Names}}` is recorded before and after |
| `mcp_client` | `Call the MCP tool timmy_env_lock and paste its raw JSON result.` | surface detected by grepping `--help` / `mcp --help` for `mcp`; then Timmy's own stdio MCP server is registered in the isolated config and the reply must contain a value only the real `timmy_env_lock` result has (the runner first calls the server itself to learn the OS build id and tool sha256s), or the tool name + os/arch fields + a visible tool-call event. `false` when no surface exists; `null` when a surface exists but could not be configured without touching real config |

Discovery commands (`--help`, subcommand help, version) are always recorded first so the flag
choices are auditable in the transcript.

Model routing: OpenRouter `google/gemini-3.7-flash` for jcode / opencode / hermes / openhands
(OpenAI-compatible base URL, key from env); Ollama `glm-5.3-flash:cloud` for pi, matching how the
user runs pi. `mcp_client` runs on `anthropic/claude-haiku-4.5` for the OpenRouter harnesses —
see "Surprises" for why.

## Results

<!-- RESULTS_TABLE -->

## Surprises found while measuring

1. **Timmy's own MCP schema is rejected by Google.** `timmy_promo_apply` declares
   `beats: { type: 'array' }` with no `items` (`src/mcp/server.ts:32`). When jcode forwarded all 23
   Timmy tools to `google/gemini-3.7-flash` through OpenRouter, Google returned
   `function_declarations[35].parameters.properties[beats].items: missing field` and the whole request
   failed (first-pass transcript, kept in the note). The harness had done its job (server spawned,
   tools discovered and exposed); the provider refused the schema. `mcp_client` therefore runs on
   `anthropic/claude-haiku-4.5`, which accepts it. Fix in Timmy: add `items: { type: 'object' }`.
   opencode passed even on Gemini, so it must normalise tool schemas before sending them.
2. **`minds` is not an agent harness.** `@animocabrands/minds-cli` is a JSON client for hosted
   "Minds" conversations; it needs `MINDS_BUILDER_API_KEY` (set nowhere here) and any tool/file/browser
   work would happen remotely. Only `one_shot=false (not_configured)` and `mcp_client=false` are real
   measurements; the rest are `null` by construction.
3. **`/opt/homebrew/bin/pi` cannot start with the user's real config.** `~/.pi/agent/settings.json`
   lists `npm:@astrofoundry/pi-astro`, whose global npm install fails (`esbuild`/`protobufjs`
   postinstall), and pi aborts before argument parsing (`-ne` does not help). Also, the
   `qwen3-coder-next:cloud` model the user has in `models.json` was retired by Ollama Cloud on
   2026-07-15 (HTTP 410). And the installed `pi-mcp-adapter` targets `@earendil-works/pi-coding-agent`
   0.84.1 — a second pi at `~/.local/bin/pi -> ~/.hermes/node/bin/pi` — so with the pinned
   `@mariozechner` 0.73.1 build it fails to load (`Cannot find module '@earendil-works/pi-ai/compat'`).
4. **openhands could not finish a bare PONG in 120 s with the real HOME.** The SDK parses every entry
   of `~/.agents/skills` at startup — 1,632 symlinked skills, 34,572 files, 280 MB on this machine —
   with no env override, and it also writes `~/.openhands/cache/skills` regardless of
   `OPENHANDS_PERSISTENCE_DIR`. Three attempts were killed while still "Loading user skills". With a
   fake `HOME` it answers in ~30 s. Also: the headless Textual app swallows its own error prints, so a
   silent process is the only symptom.
5. **opencode injected ~159k input tokens for a bare PONG** ($0.12 in the smoke test) by loading the
   user's Claude-Code compat layer / external skill library; the probes disable that
   (`OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`) so the harness itself is
   measured. jcode sends ~13.8k tokens of system prompt for the same request.
6. **`hermes mcp add` is interactive-only.** It connected to Timmy, listed all 23 tools, then hit
   `input()` -> `EOFError` with no TTY and printed "Cancelled." without saving; `hermes mcp list`
   immediately after showed nothing. The runner writes the `mcp_servers` block into the isolated
   `config.yaml` instead.
7. **Prompt echoes are a trap for string checks.** pi, opencode, openhands and jcode echo the user
   message in their JSON streams, so `PONG` / `TOOL-OK-4471` matched the prompt on the first pass. The
   evaluator now strips every copy of the prompt before matching; `file_edits` (a file on disk) is the
   only probe that cannot be fooled this way.
8. **No harness sandboxes.** All five agents reported this machine's hostname and the real temp cwd;
   Docker (OrbStack) is not running, so `docker ps` fails before and after openhands.
