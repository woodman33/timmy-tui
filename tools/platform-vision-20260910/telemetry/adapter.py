"""Bounded MCAP interchange and PlotJuggler entry point for Timmy.

The source simulation time stays in the payload. MCAP log_time is conversion
time, publish_time=0 means unavailable. No historical acquisition time invented.
"""
from __future__ import annotations
import csv
import hashlib
import importlib.metadata
import io
import json
import math
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

from jsonschema import validate
from mcap.reader import NonSeekingReader, SeekingReader
from mcap.records import Chunk, DataEnd
from mcap.stream_reader import StreamReader
from mcap.writer import Writer, CompressionType
import zstandard

MAX_BYTES = 16 * 1024 * 1024
MAX_ROWS = 10000
MAX_ROW_BYTES = 64 * 1024
SCHEMA_NAME = "timmy.mujoco-sample/1"
TOPIC = "/timmy/simulation/sample"
LEGACY_ROW_SCHEMA = {
    "type": "object", "required": ["timeSeconds", "positionMetres", "contactCount"],
    "properties": {
        "timeSeconds": {"type": "number", "minimum": 0},
        "positionMetres": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
        "contactCount": {"type": "integer", "minimum": 0},
    },
}
ROW_SCHEMA = {**LEGACY_ROW_SCHEMA, "properties": {
    **LEGACY_ROW_SCHEMA["properties"],
    "penetrationMetres": {"type": "number", "minimum": 0},
}}


def finite_json(value, depth=0):
    if depth > 32:
        raise ValueError("JSON nesting exceeds 32 levels")
    if type(value) in (float, int):
        try:
            finite = math.isfinite(value)
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError("Nonfinite or floating-point-overflow number")
    if isinstance(value, dict):
        for child in value.values():
            finite_json(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            finite_json(child, depth + 1)
    return value


def decode_json(data):
    # parse_constant covers NaN/Infinity, while the recursive check also catches
    # valid JSON exponents such as 1e309 that overflow Python's float parser.
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    return finite_json(json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite number"))))


def read_bounded(path: Path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_BYTES:
            raise ValueError("Input must be a nonempty regular file of at most 16 MiB")
        data = stream.read(MAX_BYTES + 1)
        after = os.fstat(stream.fileno())
    if len(data) != before.st_size or (before.st_mtime_ns, before.st_ctime_ns, before.st_size) != (after.st_mtime_ns, after.st_ctime_ns, after.st_size):
        raise ValueError("Input changed during capture")
    return data


def read_json(path: Path):
    return decode_json(read_bounded(path))


def save(path: Path, data):
    with path.open("x") as f:
        json.dump(data, f, indent=2, allow_nan=False)
        f.write("\n")


def sha(path: Path):
    return hashlib.sha256(read_bounded(path)).hexdigest()


def validate_row(row):
    finite_json(row)
    validate(row, ROW_SCHEMA)
    # All fields, including preserved MuJoCo extras, are bounded before output.
    if len(json.dumps(row, allow_nan=False, separators=(",", ":")).encode()) > MAX_ROW_BYTES:
        raise ValueError("Simulation row exceeds 64 KiB")


def validate_rows(rows):
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS:
        raise ValueError("Expected 1–10000 simulation rows")
    for row in rows:
        validate_row(row)
    if any(b["timeSeconds"] < a["timeSeconds"] for a, b in zip(rows, rows[1:])):
        raise ValueError("Simulation timestamps must be nondecreasing")


def read_mcap(path: Path, *, raw=None):
    raw = read_bounded(path) if raw is None else raw
    if not 0 < len(raw) <= MAX_BYTES:
        raise ValueError("Recording exceeds byte bounds")
    # Installed MCAP 1.4 defaults to a 4 GiB record limit and eagerly expands
    # chunks. Bound compressed and expanded sizes before native message replay.
    expanded, data_crc_present = 0, False
    for index, record in enumerate(StreamReader(io.BytesIO(raw), emit_chunks=True, validate_crcs=True, record_size_limit=MAX_BYTES).records):
        if index > 100000:
            raise ValueError("Recording exceeds record limit")
        if isinstance(record, Chunk):
            if record.uncompressed_crc == 0:
                raise ValueError("Timmy replay requires chunk CRCs")
            expanded += record.uncompressed_size
            if not 0 <= record.uncompressed_size <= MAX_BYTES or expanded > MAX_BYTES:
                raise ValueError("Expanded recording exceeds 16 MiB")
            if record.compression == "zstd":
                # Unknown-size/LZ4 frames are outside this bounded Timmy format.
                if zstandard.frame_content_size(record.data) != record.uncompressed_size:
                    raise ValueError("ZSTD frame size must match the bounded chunk size")
                decoded = zstandard.ZstdDecompressor().decompress(record.data, max_output_size=MAX_BYTES, allow_extra_data=False)
                if len(decoded) != record.uncompressed_size:
                    raise ValueError("Expanded chunk size mismatch")
            elif record.compression == "":
                if len(record.data) != record.uncompressed_size:
                    raise ValueError("Uncompressed chunk size mismatch")
            else:
                raise ValueError("Only bounded ZSTD or uncompressed Timmy chunks are supported")
        if isinstance(record, DataEnd):
            data_crc_present = record.data_section_crc != 0
    if not data_crc_present:
        raise ValueError("Timmy replay requires a data-section CRC")
    reader = NonSeekingReader(io.BytesIO(raw), validate_crcs=True, record_size_limit=MAX_BYTES)
    rows, items, channel_ids = [], [], set()
    for schema, channel, message in reader.iter_messages(log_time_order=False):
        if len(rows) >= MAX_ROWS:
            raise ValueError("Recording exceeds 10000 messages")
        if (not schema or schema.name != SCHEMA_NAME or schema.encoding != "jsonschema"
                or channel.message_encoding != "json" or channel.topic != TOPIC):
            raise ValueError("Expected the known Timmy simulation schema and topic")
        if len(schema.data) > 16 * 1024 or decode_json(schema.data) not in (ROW_SCHEMA, LEGACY_ROW_SCHEMA):
            raise ValueError("Unknown embedded simulation schema")
        channel_ids.add(channel.id)
        if len(channel_ids) != 1 or len(message.data) > MAX_ROW_BYTES:
            raise ValueError("Expected one bounded Timmy simulation channel")
        value = decode_json(message.data)
        validate_row(value)
        if rows and value["timeSeconds"] < rows[-1]["timeSeconds"]:
            raise ValueError("Simulation timestamps must be nondecreasing")
        rows.append(value)
        items.append((schema, channel, message))
    if not rows:
        raise ValueError("Expected 1–10000 simulation rows")
    summary = SeekingReader(io.BytesIO(raw), validate_crcs=True, record_size_limit=MAX_BYTES).get_summary()
    return rows, summary, items


def plot_binary():
    return Path.home() / "Applications/Timmy-PlotJuggler-3.17.2/bin/plotjuggler"


def execute(req):
    capability = req.get("capability", "mcap")
    operation = req.get("operation", "probe")
    out = Path(req["output_dir"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if operation == "probe":
        binary = plot_binary()
        return {"ok": capability == "mcap" or binary.exists(), "capability": capability,
                "operation": operation, "mcapVersion": importlib.metadata.version("mcap"),
                "plotjugglerExecutable": str(binary), "plotjugglerInstalled": binary.exists(),
                "qualification": "dependency-presence-only", "artifacts": []}
    if operation == "replay" and capability == "mcap":
        source = Path(req["input"]).absolute()
        raw = read_bounded(source)
        rows, summary, items = read_mcap(source, raw=raw)
        captured = out / "retained-input.mcap"
        with captured.open("xb") as stream:
            stream.write(raw)
        target = out / "replayed.json"
        save(target, {"rows": rows})
        return {"ok": True, "capability": capability, "operation": operation,
                "messages": len(rows), "crcValidated": True, "indexed": bool(summary and summary.chunk_indexes),
                "source": {"path": str(source), "sha256": hashlib.sha256(raw).hexdigest(), "retainedPath": str(captured)},
                "scope": "Known Timmy simulation payload only; bounded single-channel ZSTD/uncompressed MCAP, not arbitrary MCAP formats",
                "artifacts": [str(target), str(captured)]}
    if operation == "open" and capability == "plotjuggler":
        binary = plot_binary()
        if not binary.exists():
            raise ValueError("PlotJuggler native executable is unavailable")
        path = Path(req["input"]).resolve()
        if path.suffix != ".csv" or not path.is_file() or path.stat().st_size > MAX_BYTES:
            raise ValueError("Choose a local CSV of at most 16 MiB")
        cmd = [str(binary), "-n", "--datafile", str(path), "--window_title", "Timmy · Simulation telemetry"]
        if req.get("layout"):
            layout = Path(req["layout"]).resolve()
            if not layout.is_file() or layout.suffix != ".xml" or layout.stat().st_size > MAX_BYTES:
                raise ValueError("Invalid local layout")
            cmd.extend(["--layout", str(layout)])
        log = out / "plotjuggler.log"
        with log.open("x") as stream:
            p = subprocess.Popen(cmd, stdout=stream, stderr=stream, start_new_session=True)
        time.sleep(1)
        return {"ok": p.poll() is None, "capability": capability, "operation": operation,
                "state": "launched" if p.poll() is None else "exited", "pid": p.pid,
                "qualification": "launch-only; native viewer inspection is separate", "artifacts": []}
    if operation != "export":
        raise ValueError("Supported: probe, export, replay (MCAP), open (PlotJuggler)")
    source = Path(req["input"]).absolute()
    source_bytes = read_bounded(source)
    source_digest = hashlib.sha256(source_bytes).hexdigest()
    data = decode_json(source_bytes)
    rows = data.get("rows")
    validate_rows(rows)
    recording = out / "simulation.mcap"
    with recording.open("xb") as f:
        w = Writer(f, compression=CompressionType.ZSTD, enable_crcs=True, enable_data_crcs=True)
        w.start(profile="", library="timmy-mcap/1")
        sid = w.register_schema(name=SCHEMA_NAME, encoding="jsonschema", data=json.dumps(ROW_SCHEMA).encode())
        cid = w.register_channel(topic=TOPIC, message_encoding="json", schema_id=sid,
                                 metadata={"units": "m,s", "up_axis": "unknown", "log_time": "conversion_wall_time", "publish_time": "unavailable_zero"})
        w.add_metadata("source", {"sha256": source_digest, "path": str(source), "case": str(data.get("case", "unknown"))})
        for i, row in enumerate(rows):
            w.add_message(cid, log_time=time.time_ns(), publish_time=0, sequence=i,
                          data=json.dumps(row, allow_nan=False, separators=(",", ":")).encode())
        w.finish()
    replay, summary, messages = read_mcap(recording)
    csv_path = out / "simulation.csv"
    with csv_path.open("x", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["timeSeconds", "position_x_m", "position_y_m", "position_z_m", "contacts", "penetration_m"])
        for row in replay:
            writer.writerow([row["timeSeconds"], *row["positionMetres"], row["contactCount"], row.get("penetrationMetres", "")])
    checks = {"exactPayloadReplay": rows == replay,
              "schemaEmbedded": all(s and s.encoding == "jsonschema" for s, _, _ in messages),
              "sourceTimelineRetained": [r["timeSeconds"] for r in rows] == [r["timeSeconds"] for r in replay],
              "noInventedPublishTimes": all(m.publish_time == 0 for _, _, m in messages),
              "indexedChunks": bool(summary and summary.chunk_indexes),
              "sequencePreserved": [m.sequence for _, _, m in messages] == list(range(len(rows))),
              "sourceUnchanged": sha(source) == source_digest}
    report = {"ok": all(checks.values()), "capability": capability, "operation": operation,
              "source": {"path": str(source), "sha256": source_digest}, "messages": len(rows),
              "checks": checks, "mcapVersion": importlib.metadata.version("mcap"),
              "scope": "Native MCAP encode/decode of retained simulation; no new simulation or physics claim",
              "artifacts": [str(recording), str(csv_path)]}
    target = out / "report.json"
    save(target, report)
    return {**report, "artifacts": [*report["artifacts"], str(target)]}


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Request too large")
        result = execute(decode_json(raw))
        print(json.dumps(result, allow_nan=False))
        sys.exit(0 if result["ok"] else 1)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:600], "artifacts": []}))
        sys.exit(1)
