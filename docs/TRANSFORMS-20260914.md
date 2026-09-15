# TRANSFORMS — 2026-09-14

Adopted transforms between Timmy's surfaces (CLI, API, TUI, web, MCP, receipts) and the
dependencies that carry them. Source: Codex's research in
`docs/brainstorms/2026-09-14-async-software-control-brainstorm.md` ("Reusable bridges and
dependencies", "Language matrix", "Additional translation and extraction dependencies"), accepted
by Will 2026-09-14 (LIGHT tier: adopt, record, no installs beyond what a lane needs).

Rules: every transform emits or consumes JSON so a receipt can cite it; a transform never reaches a
closed application's internals; a second route for the same transform is recorded only with the
criterion that picks it over the first.

## 1. Existing routes (the first choice for each transform)

| transform | first route | where |
|---|---|---|
| API → CLI | Timmy's OpenAPI adapter | `src/utils/oapi-adapter.ts` |
| TUI → web | companion web window | `companion/` |
| Java libraries → CLI | JBang | `lanes/factory/verifiers` (jsoup) |
| workflow orchestration | Cloudflare Workflows | `workers/` (see §3) |
| process execution | nonblocking spawn runner | `src/runtime/spawn-runtime.ts` |

## 2. Dependencies (one-line cartridges)

Each line: what it transforms · the one command that proves it · the caveat Codex recorded.

| dependency | transform | cartridge | caveat |
|---|---|---|---|
| **uv scripts (PEP 723)** | Python script with inline dependency metadata → runnable without a project; the Python JBang | `uv run script.py` (deps declared in the `# /// script` block) | run bpy and other thread-bound host code through the host-safe worker path, not inline |
| **Restish** | OpenAPI description → API-aware CLI commands with structured (JSON) responses and pagination | `restish api configure <name> <base-url>` then `restish <name> <operation>` | second API↔CLI route: use only where the existing OpenAPI adapter fails a measured spec (§3) |
| **jc** | any supported legacy CLI's text output → JSON, so an old tool can emit a receipt | `<tool> \| jc --<parser>` (then `jq`) | use a tool's native JSON mode first; jc parses known formats, it cannot infer an arbitrary screen |
| **Dasel** | JSON ↔ YAML ↔ TOML ↔ XML ↔ CSV selection and conversion | `dasel -f in.yaml -w json` | comments, whitespace, key order and type representations need explicit handling; yq for YAML-specific work |
| **MarkItDown** | Office, PDF and other documents → readable Markdown for ingestion | `markitdown file.docx > file.md` | extraction, not reconstruction of the original layout |
| **ttyd / Textual Serve** | a terminal program → an interactive browser terminal (ttyd); a Textual Python TUI → browser delivery (Textual Serve) | `ttyd -p 7681 timmy` · `textual serve app.py` | second TUI↔web route: a PTY/protocol relay, not a semantic DOM; share one owned PTY or tmux session between local and browser views |
| **PyO3 / NAPI-RS** | Rust ↔ Python bindings or embedding (PyO3); Rust → Node-API bindings (NAPI-RS) | `maturin develop` · `napi build` | shares native kernels; does not translate arbitrary programs; native memory ownership and worker/thread rules stay explicit |
| **WIT / jco** | typed WebAssembly components (Component Model interfaces) → JavaScript hosts | `jco transpile component.wasm -o out/` | portable transforms only; not a way into a closed GUI application's internals |

## 3. Routes and criteria

- **API ↔ CLI.** First route: the existing OpenAPI adapter. Second route: Restish — chosen only after
  the adapter is tested against the specific failing specification and the gap is measured (Codex:
  "a second implementation is justified by a measured compatibility gap, not by a different wrapper
  name"). ApiSnip may narrow a spec before either route reads it.
- **Legacy CLI → receipts.** jc turns a supported tool's output into JSON; a schema validates it; the
  job records the result; a receipt cites the hash. Prefer the tool's own `--json` when it has one.
- **Python lane.** uv scripts with inline dependencies are the unit of Python automation (the JBang
  equivalent): one file, declared deps, reproducible run. Thread-bound host code (bpy) runs in the
  host-safe worker path.
- **TUI ↔ web.** First route: the companion window. Second route: ttyd for any existing terminal
  program, Textual Serve for Python TUIs. Both mirror a terminal; neither turns terminal controls
  into components.
- **Documents and data.** MarkItDown for document ingestion, Dasel for structured-data conversion.
- **Native and portable code.** PyO3 and NAPI-RS when a Rust kernel must be shared with Python or
  Node; WIT + jco when a transform must be portable across hosts as a typed component.
- **Workflows.** Cloudflare Workflows first. Temporal or Dapr are considered only when a workflow
  needs signals Cloudflare Workflows cannot give — external signals into a running workflow,
  long-lived waits with human-in-the-loop resumption beyond the platform's limits, or cross-cluster
  activity routing — and the need is recorded here with the workflow that has it before anything is
  installed. Nothing is installed today (Will, 2026-09-14).
