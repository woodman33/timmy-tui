# CAD candidates for a host-operated provider

Recommendation: retain SolidCraft as the mechanical 3D pilot, consider Rust CADCraft as a drafting companion, and evaluate Materializr after identifying a supported external control path. None is established here as a universal CAD replacement.

| Candidate and pin | Practical AI control | Observed limit / next gate |
| --- | --- | --- |
| [SolidCraft](https://github.com/tangency-labs/solidcraft/tree/d9ccba01349e177bb7b2b428e8509edbef70bc27), source `d9ccba01349e177bb7b2b428e8509edbef70bc27`; stable CLI v0.24.0 | Prior local study exercised 19 native stdio MCP tools and browser control/inspection; a native editable sample was saved | Public browser produced native format 40; stable CLI only read through 39 and refused reopening. Retain that actual failure. Verify compatible application/CLI pair before integration |
| [Rust CADCraft](https://github.com/storytold/cadcraft/tree/d864a08b013353143086bd8bb568c26cb6256796), `d864a08b013353143086bd8bb568c26cb6256796`, latest release v0.13.0 at research time | [Pinned MCP guide](https://github.com/storytold/cadcraft/blob/d864a08b013353143086bd8bb568c26cb6256796/docs/mcp.md): `cadcraft-cli mcp`; visible app `cadcraft --control 7979` plus `cadcraft-cli mcp --connect 127.0.0.1:7979`; independent CLI info/convert/run | Documentation only, not exercised. Own roadmap calls it pre-alpha; README discloses loss of unmodelled entities on save. Test synthetic DXF save/reopen, entity counts, dimensions and render before real drawings |
| [Materializr](https://github.com/materializr-cad/materializr/tree/1ee4372f2d57999c2b0c03d2c597a042c60afc26), `1ee4372f2d57999c2b0c03d2c597a042c60afc26`, latest release v1.7.5 at research time | [Official product](https://materializr.com/) describes B-rep solids, native editable `.mzr` history and a built-in 17-tool assistant with compatible model endpoints | Likely the intended “Materializer”; identity remains provisional without a URL. External MCP/CLI control not established; no app execution here. Current GPLv3 plus exceptions: evaluate as an external app; no GPL CAD implementation read/copied for permissive contributions |

CADCraft also names a separate [getcadcraft](https://getcadcraft.com/) company/product. Its advertised loopback MCP/CLI contract is a separate candidate; the public `@getcadcraft/mcp` registry lookup returned 404 during this checkpoint. Do not conflate its package claims with the Rust project above.

Public documentation/metadata supplied these alternative-candidate findings. No CADCraft or Materializr runtime was installed or tested. Kernel migration plans in SolidCraft are not completed shipped capabilities. No upstream issue, PR or partnership was posted. A queued host worker can track synchronous CAD execution; it does not make the CAD kernel internally asynchronous. Preserve native projects beside interchange exports and property-specific verification.

## Next bounded support gate: compatibility before module reuse

The coordination direction is a Timmy-owned Model Studio using useful native-engine ingredients and supported control interfaces, while preserving Timmy's controller, data and receipts. Card Lab's silver/black/blue Rive/tldraw foundation remains binding under [UI-DIRECTION.md](UI-DIRECTION.md). This note adds no UI implementation, fork or adapter patch.

Use the retained SolidCraft source/probes above; do not repeat that investigation. Before proposing Rust module extraction:

1. Pin an application and CLI pair with explicitly compatible native-format readers/writers. Preserve the observed browser-format-40 versus CLI-max-39 refusal. Do not rewrite the file tag, silently upgrade a runtime or relabel that failure.
2. Through an agreed native control route, save a small editable part, reopen it in the same pinned tool pair, and inspect feature history, parameters, units and geometry. Keep the native project, raw responses and failure output. A successful screenshot or import alone does not prove an editable round trip.
3. Export a supported interchange format and verify the properties actually retained. Distinguish geometry exchange from native history/constraint preservation. Bind application/CLI versions, source/document revisions, output hashes and result to the host job; preserve cancellation and unknown outcomes.
4. Only after that gate, propose a small reuse boundary across the existing engine/document/sketch layers. Respect SolidCraft's current kernel migration and dependency/licensing boundaries. Do not strip app directories or assume future kernel work is shipped.

Mixar/Blender OSS and control interfaces are candidate ingredients for the same owner-controlled workflow, not established integrations in this packet. Blender's supported Python/API execution should preserve editable native artifacts. Mixar identity, revision, license and supported interface still require specific source verification before an adoption claim. No new Mixar or Blender probe ran for this update.

Any actual adapter patch must first coordinate scope with **timmy-new-1, Model Studio owner**, and **Claude, shared host integrator**. Keep ongoing app/UI/theme work undisturbed. This packet supplies research and reviewable support, not a competing Model Studio implementation.

## Episode retention is separate from training admission

Future retained OpenHands/Cloudroom episodes may be candidates for evaluation or training only after separate admission. Preserve raw episodes and provenance under their existing privacy/rights boundaries; retention alone supplies no permission to train and no native-output validation. The coordination notice reports that the current Cloudroom collection lacks native outputs; that gap was not reverified here and must be resolved before treating it as native-result data. No bulk collection, model run, training, deep fork, paid operation or new UI is authorized by this note.
