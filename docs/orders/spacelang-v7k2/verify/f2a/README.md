# F2a synthetic leaf fixtures

The governing [prospective acceptance](../F2a-ACCEPTANCE.md) states the qualified boundary and unresolved header/code/scale bindings. Nothing in this directory is a native candidate verdict, model evidence handle, physical observation or signed chain receipt.

Each of the two fixtures contains one 8³ leaf. `*.input.json` fixes declarations and all raw values; `*.raw-f64le.bin` fixes their exact binary64 input bytes; `*.expected-values.json` contains every expected quantized code; `*.leaf-preimage.bin` and `*.leaf-preimage.hex` are the exact canonical leaf hash preimage; `*.expected.json` names the SHA-256 result. `MANIFEST.json` commits to those twelve files and the generator's source digest. The acceptance and this README are separately bound by the published verifier commit/execution manifest.

The sigma-present fixture adds a u16 channel in 1σ micrometres. The sigma-absent fixture omits its declaration and all 1024 encoded bytes. Both are synthetic and include UNKNOWN/FREE/OCCUPIED states, half-even ties, declared clamp edges, negative signed values, multi-byte integer patterns and distinct coordinate-dependent values. Header hashes and metadata enum bytes are supplied fixture inputs, not a claim that ORDER defines their global serialization/mapping.

Read-only reproduction from the repository root:

```sh
python3 docs/orders/spacelang-v7k2/verify/f2a/reference.py check docs/orders/spacelang-v7k2/verify/f2a
python3 docs/orders/spacelang-v7k2/verify/f2a/reference.py self-test
```

The `emit` mode is authoring-only and refuses to overwrite existing files. Never emit or repair fixtures during candidate qualification. The Python reference is an independent documentation oracle, never a production quantization path. Actual raw values must be quantized in Rust; no F2b node/root/proof implementation is included here.
