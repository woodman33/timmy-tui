# Native spatial schema candidate

The protobuf file is the schema of record. `buf.gen.yaml` pins the TS, prost,
Go, Connect and Python generator versions. CUE imports the protobuf definitions;
`proto/gen/cue/semantics.cue` adds ledger range, basis, uncertainty and job rules.
Fixture JSON is standard protobuf JSON inside `input`; the CUE adapter decodes
base64 byte fields before applying the imported definitions.

Sigma is an optional message channel. Absence means not recorded. A present
512-value u16 channel can include zero; its declaration uses `unit: "um"` and
`statistic: "1sigma"`. Raw producer inputs remain separate. Rust alone will
quantize them under the declared scale, half-even rounding and clamp contract.
No voxel spacing or sigma code grants physical accuracy or benchmark approval.

Current checks are **development checks, not F1 qualification**. The full frozen
acceptance is at verifier commit
`628f308d9631ef56e636f080c2dd96371917cdd7`, file
`docs/orders/spacelang-v7k2/verify/F1-ACCEPTANCE.md` (SHA-256
`7199510e373c53bc04bce60de7a122eac8ecbd1445f05d32df1e69db5f5c450d`).
`development-cases.json` explicitly lists unimplemented control families.
The current receipt fixture is unsigned; its bytes are transport fixtures and
cannot demonstrate signature validity or become admitted spatial evidence.

Development commands:

```sh
buf lint
buf build -o /path/to/private-run/candidate.binpb
buf generate
python3 proto/checks/generated_manifest.py
cue import proto -I proto -p spacev1 --proto_enum json -o /path/to/private-run/space_proto_gen.cue proto/timmy/space/v1/space.proto
cmp proto/gen/cue/space_proto_gen.cue /path/to/private-run/space_proto_gen.cue
python3 proto/checks/cue_cases.py
python3 proto/checks/breaking_control.py
git check-ignore target/f1-probe crates/timmy-space-wasm/pkg/f1-probe
```

The TS codec runs in an isolated runtime beside an exact copy of the generated
`space_pb.ts` and pinned `@bufbuild/protobuf`/`tsx`. The Python codec runs with
`proto/gen/python` on `PYTHONPATH` and pinned protobuf. They retain absent/present
sigma, signed origins, six job states and opaque receipt bytes. Rust and Go
codec execution, all SceneIR nouns, all request/response/progress fixtures,
actual admission controls, signed receipt tampering, workflow bypass controls,
and complete preservation/execution bindings remain required before acceptance.
No existing receipt store or application runtime is invoked by these checks.
