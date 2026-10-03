#!/usr/bin/env python3
"""Offline F2a fixture reference; not a producer, native implementation or seal.

--emit is authoring only. --check never writes. Freeze this file with its outputs
before a candidate run. No Rust, node/root/proof algorithm or network is used.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct

CHANNELS = [
    ("state", "B", 1, 0, 2),
    ("tsdf", "h", 1, -32767, 32767),
    ("weight", "H", 1, 0, 65535),
    ("rgb", "B", 3, 0, 255),
    ("instance", "I", 1, 0, 4294967295),
    ("fill", "H", 1, 0, 65535),
    ("normal", "b", 3, -127, 127),
    ("feature_ref", "I", 1, 0, 4294967295),
    ("sigma", "H", 1, 0, 65535),
]


def packed_json(value):
    return (json.dumps(value, indent=2, ensure_ascii=True, allow_nan=False) + "\n").encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def quantize(value, minimum, maximum):
    if not math.isfinite(value):
        raise ValueError("nonfinite raw input")
    # Python integer round on binary64 implements ties-to-even. These fixtures
    # use only exactly representable integer/half-integer values and scale 1.
    return max(minimum, min(maximum, round(value)))


def encode(raw, with_sigma):
    active = CHANNELS if with_sigma else CHANNELS[:-1]
    if set(raw) != {row[0] for row in active}:
        raise ValueError("channel presence")
    encoded = {}
    for name, fmt, components, minimum, maximum in active:
        values = raw[name]
        if len(values) != 512:
            raise ValueError("cardinality")
        encoded[name] = []
        for value in values:
            parts = [value] if components == 1 else value
            if len(parts) != components:
                raise ValueError("component cardinality")
            if name in ("state", "instance", "feature_ref"):
                if any(not math.isfinite(p) or p != int(p) or not minimum <= p <= maximum for p in parts):
                    raise ValueError("categorical or reference range")
            quantized = [quantize(p, minimum, maximum) for p in parts]
            encoded[name].append(quantized[0] if components == 1 else quantized)
    for i in range(512):
        state, weight, tsdf = (encoded[n][i] for n in ("state", "weight", "tsdf"))
        if weight == 0 and state != 0:
            raise ValueError("zero weight implies UNKNOWN")
        if state == 1 and not (weight > 0 and tsdf > 0):
            raise ValueError("FREE needs positive observed weight and distance")
    return encoded


def build(with_sigma):
    active = CHANNELS if with_sigma else CHANNELS[:-1]
    name = "sigma-present" if with_sigma else "sigma-absent"
    raw = {row[0]: [] for row in active}
    for i in range(512):
        x, y, z = i >> 6, (i >> 3) & 7, i & 7
        state = (0, 1, 2, 0)[i % 4]
        raw["state"].append(float(state))
        raw["tsdf"].append((1.5 + i % 7) if state == 1 else (-1.5 - i % 7) if state == 2 else (i % 9 - 4.5))
        raw["weight"].append(0.0 if state == 0 else (1.5, 2.5, 65534.5, 65535.5)[(i // 4) % 4])
        raw["rgb"].append([float(32 * x), y * 32 + 0.5, z * 32 + 1.5])
        raw["instance"].append(float(i * 65537))
        raw["fill"].append((0.5, 1.5, 2.5, 65535.5)[i % 4])
        raw["normal"].append([x - 3.5, y - 3.5, z - 3.5])
        raw["feature_ref"].append(float(4294967295 - i))
        if with_sigma:
            raw["sigma"].append((-0.5, 0.5, 1.5, 2.5, 65534.5, 65535.5, 250.5, 251.5)[i % 8])
    raw["tsdf"][2] = -32768.5
    raw["tsdf"][3] = 32768.5
    raw["weight"][0] = -0.5
    raw["weight"][3] = 0.5
    raw["rgb"][0] = [-0.5, 254.5, 255.5]
    raw["normal"][0] = [-128.5, -126.5, 127.5]
    raw["instance"][0] = 4294967295.0
    encoded = encode(raw, with_sigma)
    # Different opaque commitments are supplied, not computed header hashes.
    header_hash = bytes(range(32)) if with_sigma else bytes(range(32, 64))
    source_set_hash = bytes(range(255, 223, -1))
    prefix = b"\x00timmy.space.leaf/1" + header_hash + struct.pack("<iiiBBH", -8, 16, -24, 2, 1, 513) + source_set_hash
    blocks, raw_blocks, offsets = [], [], []
    position = len(prefix)
    for channel, fmt, components, minimum, maximum in active:
        values = encoded[channel]
        flat = values if components == 1 else [p for value in values for p in value]
        raw_flat = raw[channel] if components == 1 else [p for value in raw[channel] for p in value]
        block = struct.pack("<" + fmt * len(flat), *flat)
        blocks.append(block)
        raw_blocks.append(struct.pack("<" + "d" * len(raw_flat), *raw_flat))
        offsets.append({"channel": channel, "offset": position, "length": len(block), "scalar_format": fmt, "values": 512, "components_per_value": components})
        position += len(block)
    preimage = prefix + b"".join(blocks)
    descriptor = {
        "fixture": name,
        "status": "prospective synthetic fixture; no candidate qualification",
        "shape": [8, 8, 8], "offset": "64*x + 8*y + z",
        "origin_i32": [-8, 16, -24],
        "supplied_header_hash_hex": header_hash.hex(),
        "header_canonicalization": "UNRESOLVED; supplied digest is opaque and not a header-validation vector",
        "source_set_hash_hex": source_set_hash.hex(),
        "fixture_only_code_mapping": {"provenance": {"generated": 2}, "evidence_state": {"constructed": 1}},
        "observation_count_u16": 513,
        "channel_order": [row[0] for row in active],
        "quantization_fixture_declarations": {
            "raw_format": "IEEE-754 binary64 little-endian, channel-major; vector components interleaved per voxel",
            "raw_file": name + ".raw-f64le.bin", "scale": 1,
            "rounding": "nearest, ties to even, then clamp; refuse NaN and either infinity before rounding",
            "tsdf_raw_units": "micrometres; declared truncation 32767 micrometres gives 1 micrometre/code",
            "sigma_raw_units": "1sigma micrometres" if with_sigma else None,
            "sigma_presence": "present" if with_sigma else "absent: not recorded, no values and no encoded bytes",
            "other_raw_units": "fixture code units only; no universal physical scale or normalization is claimed",
            "categorical_reference_inputs": "state, instance and feature_ref must be exact integral values in range",
            "ranges": {row[0]: [row[3], row[4]] for row in active},
            "unresolved_global_bindings": "header/schema hash encoding; code maps; general raw transport; non-TSDF scales and clamps; vector layout authority",
        },
        "prefix_length": len(prefix), "channel_byte_ranges": offsets,
        "raw_values": raw,
    }
    return {
        name + ".input.json": packed_json(descriptor),
        name + ".raw-f64le.bin": b"".join(raw_blocks),
        name + ".expected-values.json": packed_json(encoded),
        name + ".leaf-preimage.bin": preimage,
        name + ".leaf-preimage.hex": (preimage.hex() + "\n").encode(),
        name + ".expected.json": packed_json({"fixture": name, "preimage_length": len(preimage), "leaf_sha256": digest(preimage), "raw_input_sha256": digest(b"".join(raw_blocks)), "sigma_present": with_sigma}),
    }


def artifacts():
    output = {**build(True), **build(False)}
    output["MANIFEST.json"] = packed_json({
        "format": "timmy.f2a.synthetic-fixtures/1", "candidate_qualification": "not-run",
        "files": [{"path": name, "bytes": len(data), "sha256": digest(data)} for name, data in sorted(output.items())],
        "reference_sha256": digest(Path(__file__).read_bytes()),
    })
    return output


def controls():
    # Authoring checks only. None of these executes the future Rust candidate.
    for value in (math.nan, math.inf, -math.inf):
        try:
            quantize(value, 0, 65535)
        except ValueError as error:
            assert str(error) == "nonfinite raw input"
        else:
            raise AssertionError("nonfinite accepted")
    assert [quantize(v, -32767, 32767) for v in (-2.5, -1.5, -.5, .5, 1.5, 2.5)] == [-2, -2, 0, 0, 2, 2]
    assert quantize(65535.5, 0, 65535) == 65535
    valid = json.loads(build(False)["sigma-absent.input.json"])["raw_values"]
    for field, value, message in (("state", 1.0, "zero weight implies UNKNOWN"), ("state", 2.0, "zero weight implies UNKNOWN")):
        changed = {k: list(v) for k, v in valid.items()}
        changed[field][0] = value
        try:
            encode(changed, False)
        except ValueError as error:
            assert str(error) == message
        else:
            raise AssertionError("unknown semantics accepted defective input")
    assert len(build(True)["sigma-present.leaf-preimage.bin"]) - len(build(False)["sigma-absent.leaf-preimage.bin"]) == 1024
    print("authoring controls: nonfinite(3), ties(6), saturation(1), zero-weight(2), sigma byte-presence(1): passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("emit", "check", "self-test"))
    parser.add_argument("directory", nargs="?", type=Path)
    args = parser.parse_args()
    if args.mode == "self-test":
        controls()
        return
    if args.directory is None:
        parser.error("directory required")
    expected = artifacts()
    for name, data in expected.items():
        path = args.directory / name
        if args.mode == "emit":
            # Never overwrite a retained fixture.
            with path.open("xb") as stream:
                stream.write(data)
        elif path.read_bytes() != data:
            raise SystemExit("fixture mismatch: " + name)
    print(json.dumps({"mode": args.mode, "files": len(expected), "manifest_sha256": digest(expected["MANIFEST.json"])}))


if __name__ == "__main__":
    main()
