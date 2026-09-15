# Timmy transform cartridges

Five bounded local transform cartridges are adopted as executable utilities. These are local fixture results, not production integration certification. The governing references are [AGENTS.md](../AGENTS.md), [DOCTRINE.md](../DOCTRINE.md) §§2, 3, 12 and 14, [DESIGN.md](../DESIGN.md), and [decisions.md](../decisions.md). The current explicit work order applies the LIGHT ceiling of 300 seconds per cartridge; the older fifteen-minute default is not used.

Cartridge implementation write scope: this document and `studio/transforms-20260914/` only. Existing installed uv and ttyd are reused. Restish is a portable, checksummed binary inside the cartridge directory. Python packages are pinned and cached inside that same directory. The cartridge executables do not modify any global registry, shell profile, package.json, receipt chain, native app or production API. Separately, the root agent is authorized to append seals through Timmy's locked receipt writer and record their lookup in `receipt-index.json` and copies in `seals/` here. Preflight reading and shared documentation assembly are separate from the per-cartridge intervals below; a total task-under-five-minutes claim is not made.

## Cartridge contracts

| Cartridge — one-line contract | Pin / installed status | Verified boundary | Evidence |
|---|---|---|---|
| **Python JBang equivalent:** PEP 723 source + pinned dependencies → uv-managed execution → JSON result + Rich HTML artifact. | Existing uv **0.11.3**; script pins **rich==15.0.0**; scoped package cache populated. | Inline dependency resolution, import/version reporting, JSON result and HTML operation text passed. | [uv-evidence.json](../studio/transforms-20260914/uv-evidence.json), [HTML](../studio/transforms-20260914/python-inline.html) |
| **OpenAPI → CLI route 2:** explicit local OpenAPI → Restish named command/help → one typed fixture GET result. | **Restish 2.3.0** portable macOS arm64 binary installed under `studio/transforms-20260914/bin/`. | Generated `get-widget` appeared in help and returned `{"fixture":true,"id":"42"}`; config/cache were scoped; temporary server stopped. | [install pin/checksum](../studio/transforms-20260914/restish-install.json), [restish-evidence.json](../studio/transforms-20260914/restish-evidence.json) |
| **Legacy CLI → JSON:** explicitly selected supported jc parser → structured data, with unsupported parser errors preserved. | **jc==1.25.7** via scoped `uv tool run`. | A `date`-style text fixture parsed to year 2026; unknown parser exited **100**, returned no stdout and retained its error on stderr. | [jc-evidence.json](../studio/transforms-20260914/jc-evidence.json), [input](../studio/transforms-20260914/legacy-date.txt) |
| **Additional TUI ↔ web route:** a fixed terminal command → ttyd loopback HTTP/WebSocket transport. | Existing **ttyd 1.7.7-unknown**, `/opt/homebrew/bin/ttyd`; supplemental client pins **websockets==17.1**. | Initial read-only HTTP **200**. A separate writable acknowledgement fixture received `TIMMY_WS_PING` and returned `ACK:TIMMY_WS_PING` over the real `tty` WebSocket subprotocol. Servers stopped; browser rendering remains untested. | [initial HTTP evidence](../studio/transforms-20260914/ttyd-evidence.json), [WebSocket round trip](../studio/transforms-20260914/runs/20260914T091839.053231Z-ttyd-websocket-c4a13c08/ttyd-websocket-evidence.json) |
| **Textual → web route:** a tiny Textual app → pinned Textual Serve subprocess server → named loopback HTML page. | Scoped **textual==8.2.8**, **textual-serve==1.1.3** through uv PEP 723. | HTTP **200**, `text/html`, fixture title present, server stopped. The custom Textual WebSocket interaction and visual rendering remain untested. | [Textual Serve evidence](../studio/transforms-20260914/runs/20260914T091726.751165Z-textual-serve-038f0e7c/textual-evidence.json), [HTML](../studio/transforms-20260914/runs/20260914T091726.751165Z-textual-serve-038f0e7c/surface.html) |

Restish is an additional route beside the existing OpenAPI/client-generation approach; this run does not certify the other route. ttyd is an additional route beside GoTTY; GoTTY was not exercised in this cartridge. The wording “TUI ↔ web” denotes terminal transport and input capabilities, not lossless conversion into semantic HTML controls. The first ttyd smoke used default read-only mode. Only the supplemental fixed acknowledgement fixture enabled writable input; it exposed no shell.

## Run the pinned utilities

Run from the Timmy repository root. These commands are the adopted local entry points; no root dependency manifest is required.

```sh
TRANSFORMS_DIR="$PWD/studio/transforms-20260914"
UV_CACHE_DIR="$TRANSFORMS_DIR/.cache/uv" UV_PYTHON_DOWNLOADS=never ~/.local/bin/uv run --no-project "$TRANSFORMS_DIR/python-inline.py"
python3 "$TRANSFORMS_DIR/smoke-jc.py"
python3 "$TRANSFORMS_DIR/smoke-restish.py"
python3 "$TRANSFORMS_DIR/smoke-ttyd.py"
UV_CACHE_DIR="$TRANSFORMS_DIR/.cache/uv" UV_PYTHON_DOWNLOADS=never ~/.local/bin/uv run --no-project "$TRANSFORMS_DIR/smoke-textual.py"
UV_CACHE_DIR="$TRANSFORMS_DIR/.cache/uv" UV_PYTHON_DOWNLOADS=never ~/.local/bin/uv run --no-project "$TRANSFORMS_DIR/smoke-ttyd-websocket.py"
```

The Restish, ttyd and Textual scripts start a fixture server on a fresh `127.0.0.1` port, perform their finite checks, then stop the server. Historical URLs in the evidence are not live services. Every rerun now allocates a unique timestamp/UUID directory under `studio/transforms-20260914/runs/` and leaves prior evidence untouched. An explicit Python HTML output path uses exclusive creation and refuses an existing file. A [preservation check](../studio/transforms-20260914/runs/20260914T091901.603208Z-preservation-c1762855/preservation-evidence.json) reran all four original entry points, preserved all eleven original JSON/HTML/log/text files byte-for-byte, and observed the expected `FileExistsError` for an attempted existing output. Original evidence must remain immutable after its seal.

For a supported legacy text stream, jc is also directly usable:

```sh
UV_CACHE_DIR="$TRANSFORMS_DIR/.cache/uv" UV_TOOL_DIR="$TRANSFORMS_DIR/.cache/uv-tools" ~/.local/bin/uv tool run --from jc==1.25.7 jc --date < "$TRANSFORMS_DIR/legacy-date.txt"
```

Use the source command's stable JSON output when it already exists. jc requires a known parser; neither an unknown parser nor unrecognized text should be silently promoted to successful structured extraction. The negative control exercises an unsupported parser, not every malformed-input case.

Restish's executable is pinned by its installed version and archive hash. The exact macOS arm64 archive is [restish-2.3.0-darwin-arm64.tar.gz](https://github.com/rest-sh/restish/releases/download/v2.3.0/restish-2.3.0-darwin-arm64.tar.gz), SHA-256 `5dc8d53c319e044fbef01954f90ea59b13ff1b570e8a1382102b0c62e7e702d2`; it matched the release's published `checksums.txt` before execution. The first Restish attempt correctly refused a group/world-readable configuration file. Its [failed attempt](../studio/transforms-20260914/restish-attempt-1.json) is retained; setting the fixture file to mode 0600 followed the tool's explicit hint and the next attempt passed. The initial failed attempt's broad boundary label describes the intended test, not a successful outcome; its `ok:false` and empty request list are authoritative.

The smoke uses `RSH_CONFIG` and `RSH_CACHE_DIR` to isolate state. For a real authorized service, the equivalent flow is `restish api connect NAME BASE_URL --spec SPEC_URL`, then the generated command. API operation availability comes from the supplied description; one successful fixture GET does not establish authenticated production access, complete pagination, retries or mutation semantics.

## Timing and evidence

| Cartridge | Recorded bounded action interval, UTC | Successful command execution | Result |
|---|---|---:|---|
| uv / PEP 723 | 09:11:59–09:12:29.606 | 1.310 s | Passed |
| jc | 09:12:30–09:12:55.745 | 2.038 s | Positive parse and negative parser control passed |
| Restish | 09:13:11–09:13:49.704 | 0.735 s; initial refused attempt 0.521 s | Installed, checksum verified, fixture command passed |
| ttyd | 09:14:22–09:14:23.343 | 0.194 s | HTTP surface passed; interactive traffic unverified |
| Textual Serve supplemental burst | 09:16:37–09:17:32.875 | 6.123 s, plus scoped dependency setup | Named HTTP surface passed |
| ttyd WebSocket supplemental burst | 09:17:33–09:18:39.218 | 0.163 s, plus pinned client setup | Actual input/acknowledgement passed |
| Evidence-preservation check | 09:18:40–09:19:05.092 | 3.488 s | Four reruns passed; originals unchanged; overwrite refused |

Each recorded cartridge interval is under 300 seconds. These timings cover the bounded cartridge creation/execution bursts and include their observed setup or corrective work; shared preflight and final documentation are not attributed to an individual cartridge. Evidence includes exact argv, pins, stdout/stderr or HTTP fields and completion timestamps. Seal references and verification outcomes are recorded in the **cartridge seal files added by the root agent**, using Timmy's established locked writer; consult those files for receipt status. The smoke scripts do not mint receipts, and local fixture results do not establish production readiness.

The development machine's standalone Python HTTPS certificate configuration failed during an initial public package-metadata lookup. Public metadata/download retrieval subsequently used the system curl with normal TLS verification. No TLS verification bypass or certificate configuration change was made.

## Textual Serve scope

[Textual Serve](https://github.com/Textualize/textual-serve) is adopted for source applications actually written in Textual. Its documented mechanism launches a Textual application in a subprocess and communicates through a custom WebSocket protocol. The pinned fixture server's local HTTP page is verified here; the custom protocol interaction is not. This differs from ttyd's general terminal transport, whose acknowledgement round trip was separately demonstrated. No claim is made that Textual Serve converts arbitrary Ink, Rust or Go TUIs into Textual applications.

## Async workflow admission rule

**Cloudflare Workflows is the first workflow platform to use.** Current official docs already provide `step.waitForEvent`, `instance.sendEvent` and the REST events endpoint, conditional waits, buffering of events sent after instance creation but before the wait, and configurable timeouts. Event type names use letters, digits, hyphens and underscores with a maximum length of 100 characters; map dotted Timmy operation names explicitly instead of passing them unchanged. The documented event payload limit is 1 MiB. [Events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/), [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/), [limits](https://developers.cloudflare.com/workflows/reference/limits/)

Admit a Temporal or Dapr evaluation only after identifying a required signal semantic, reproducing its failure in a pinned minimal Cloudflare test, citing the current unsupported API or limit, and showing that a bounded external-worker callback plus state reconciliation cannot express the requirement. Human approvals, completion callbacks, conditional waits, timeouts and polyglot async workers are not sufficient reasons by themselves. An empty local example is not evidence that a platform lacks a feature. This is an admission criterion; no workflow runtime is installed or migrated by these cartridges.

## Sources

- Astral, [Running scripts](https://docs.astral.sh/uv/guides/scripts/): PEP 723 dependencies and isolated script environments.
- Restish, [Connect to an API](https://rest.sh/docs/getting-started/connect-to-an-api/), [environment variables](https://rest.sh/docs/reference/environment-variables/), [install](https://rest.sh/docs/getting-started/install/): generated commands, isolated config/cache and release installation.
- Kelly Brazil, [jc repository](https://github.com/kellyjonbrazil/jc): supported-parser transformation of legacy text to structured output.
- ttyd maintainers, [ttyd repository](https://github.com/tsl0922/ttyd): terminal transport over the web; installed `--help` supplied the exact local flags.
- Textualize, [Textual Serve repository](https://github.com/Textualize/textual-serve): Textual-specific subprocess/WebSocket serving.
- Cloudflare, [Events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/), [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/), [limits](https://developers.cloudflare.com/workflows/reference/limits/): workflow signal semantics and current limits.

## 9. Accepted route guarantees and the box-with-bore decision

These six corrections govern future integration; they do not promote the
fixture evidence above into a universal capability claim.

1. **Independent routes for critical operations.** Require two independently
   qualified backend routes only for declared critical operations where that
   requirement is feasible. State the independence level and shared backend,
   exporter, credentials and host dependencies. Two CLI/MCP wrappers around
   one implementation are interface alternatives, not independent converters.
   There is no two-routes-between-every-pair guarantee.
2. **Failover preserves operation semantics.** Define eligible failures and
   distinguish read-only calls, mutations and unknown outcomes. Keep a stable
   logical job/operation identity, separate attempt identities, deduplication
   and reconciliation. Before retrying a mutation or changing backend, inspect
   whether it already completed. A disconnected socket is not proof of failure
   or permission to repeat an edit.
3. **The contract is stable; each execution is recorded separately.** Preserve
   the required input/output semantics and logical job identity across routes.
   The actual vendor, implementation version, output bytes and execution
   receipts can differ. Each attempt records its actual inputs, outputs,
   backend/version, checks, losses and lineage. Qualification receipts describe
   a bounded adapter qualification; attempt receipts describe a particular run.
4. **OTLP needs causal context and actual timing.** A receipt projection alone
   is not a distributed execution trace. Propagate trace/parent context, record
   real attempt start/end times and correlate receipt identities. Retries and
   alternative routes need separate spans. Export, retention and redaction
   remain explicit integration work.
5. **Loopback is not a complete privacy boundary.** A loopback listener limits
   its bind address; it does not establish caller authorization, origin policy,
   process isolation or absence of outbound traffic. Qualify those controls
   and what data is retained or forwarded for each actual route.
6. **Wasm packages compatible computation, not native application hosts.**
   Portability depends on compatible runtimes, host imports and capabilities.
   A wrapper does not move a proprietary CAD application, its license, GPU
   dependencies or editor state into every Wasm host. Keep native workers on
   their supported hosts.

The first shared proof is the existing **box with a bore**, with one bounded
bore-radius revision into a separate candidate. Keep source revision, units,
frame and unknown properties; inspect native readback and declared geometry
checks before claiming the change succeeded. Computational measurements of
generated geometry are allowed within their actual evidence scope:

Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.

Current route admission remains bounded: the uv/Rich, Restish, jc, ttyd and
Textual Serve records qualify the specific fixtures above; MCPorter and mcpc
are interface alternatives without a demonstrated pair of independent native
geometry backends for this box revision. Plasticity's retained MCP protocol
probe leaves its native route unadmitted. An intended independent backend
stays pending until its own native execution and readback evidence exists.
These decisions add no new execution, durability or failover proof.

S1's live checkpoint failed **0/1** on the same property-citation defect.
Execution stopped at that result; **S2 and later checkpoints were not
executed**. The box-with-bore decision and these policy amendments do not
change that outcome or claim the later route, revision or recovery proofs.

The original sealed document is preserved byte-for-byte under
[`policy/baseline/docs/TRANSFORMS-20260914.md`](../studio/box-loop-20260914/policy/baseline/docs/TRANSFORMS-20260914.md).
Its SHA-256 is `973ce4259f8e029ad2b2d828d3d64d8994e4b93bf4ce66704c5800ebcbc04c6c`.
The original transform manifests and receipts remain unchanged. The separate
[`policy/supersession.json`](../studio/box-loop-20260914/policy/supersession.json)
maps the original and revised document hashes to immutable retained copies;
it does not rewrite historical receipts or present this revision as the bytes
covered by those receipts.
