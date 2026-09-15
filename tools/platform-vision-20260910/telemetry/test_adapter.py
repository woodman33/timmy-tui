import importlib.util
import csv
import json
from unittest.mock import patch
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("telemetry_adapter", Path(__file__).with_name("adapter.py"))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class TelemetryTests(unittest.TestCase):
    def source(self, root, row):
        src = root / "source.json"
        src.write_text(json.dumps({"rows": [row]}))
        return src

    def row(self):
        return {"timeSeconds": 0, "positionMetres": [0, 0, 0], "contactCount": 0}

    def recording(self, path, rows, schema=None, name=None, topic=None, crcs=True):
        with path.open("xb") as stream:
            writer = a.Writer(stream, compression=a.CompressionType.ZSTD,
                              enable_crcs=crcs, enable_data_crcs=crcs)
            writer.start()
            sid = writer.register_schema(name=name or a.SCHEMA_NAME, encoding="jsonschema",
                                         data=json.dumps(schema if schema is not None else a.ROW_SCHEMA).encode())
            cid = writer.register_channel(topic=topic or a.TOPIC, message_encoding="json", schema_id=sid)
            for i, row in enumerate(rows):
                payload = row.encode() if isinstance(row, str) else json.dumps(row).encode()
                writer.add_message(cid, log_time=i, publish_time=0, sequence=i, data=payload)
            writer.finish()

    def test_duplicate_json_and_implicit_fixture_refused(self):
        with self.assertRaises(ValueError):
            a.decode_json('{"rows": [], "rows": []}')
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                a.execute({"operation": "fixture", "output_dir": str(Path(d) / "out")})

    def test_named_pipe_is_refused_without_a_writer(self):
        import os
        if not hasattr(os, "mkfifo"):
            self.skipTest("named pipes unavailable")
        with tempfile.TemporaryDirectory() as d:
            pipe = Path(d) / "pipe"
            os.mkfifo(pipe)
            with self.assertRaises(ValueError):
                a.read_bounded(pipe)

    def test_real_roundtrip_and_index(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            src = p / "source.json"
            src.write_text(json.dumps({"rows": [
                {"timeSeconds": i * .002, "positionMetres": [0, 0, 2 - i * .1], "contactCount": 0}
                for i in range(50)]}))
            result = a.execute({"operation": "export", "input": str(src), "output_dir": str(p / "out")})
            self.assertTrue(result["ok"])
            recording = p / "out/simulation.mcap"
            replay, summary, messages = a.read_mcap(recording)
            self.assertEqual(len(replay), 50)
            self.assertTrue(summary.chunk_indexes)
            self.assertEqual({m.publish_time for _, _, m in messages}, {0})
            # Native chunk CRC must reject a damaged payload.
            bytes_ = bytearray(recording.read_bytes())
            chunk = summary.chunk_indexes[0]
            bytes_[chunk.chunk_start_offset + chunk.chunk_length - 2] ^= 1
            damaged = p / "damaged.mcap"
            damaged.write_bytes(bytes_)
            with self.assertRaises(Exception):
                a.read_mcap(damaged)
            # Existing output must never be silently replaced.
            with self.assertRaises(FileExistsError):
                a.execute({"operation": "export", "input": str(src), "output_dir": str(p / "out")})

    def test_bad_schema_and_time(self):
        for row in [
            {"timeSeconds": -1, "positionMetres": [0, 0, 0], "contactCount": 0},
            {"timeSeconds": 0, "positionMetres": [0, 0], "contactCount": 0},
            {"timeSeconds": 0, "positionMetres": [0, 0, 0], "contactCount": -1},
        ]:
            with tempfile.TemporaryDirectory() as d:
                p = Path(d); src = p / "source.json"
                src.write_text(json.dumps({"rows": [row]}))
                with self.assertRaises(Exception):
                    a.execute({"operation": "export", "input": str(src), "output_dir": str(p / "out")})
                self.assertFalse((p / "out/simulation.mcap").exists())

    def test_overflow_numbers_refused_before_write(self):
        for field in ["timeSeconds", "positionMetres", "penetrationMetres", "extraMeasurement"]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as d:
                p = Path(d); row = self.row()
                row[field] = [1e309, 0, 0] if field == "positionMetres" else 1e309
                src = p / "source.json"
                src.write_text(json.dumps({"rows": [row]}).replace("Infinity", "1e309"))
                with self.assertRaises(ValueError):
                    a.execute({"operation": "export", "input": str(src), "output_dir": str(p / "out")})
                self.assertFalse((p / "out/simulation.mcap").exists())

    def test_optional_penetration_requires_finite_nonnegative_number(self):
        for value in [-1, None, "unknown", float("nan"), 10 ** 400]:
            with self.subTest(value=str(value)[:20]):
                row = {**self.row(), "penetrationMetres": value}
                with self.assertRaises(Exception):
                    a.validate_row(row)

    def test_absent_penetration_is_blank_not_zero(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d); src = self.source(p, self.row())
            a.execute({"operation": "export", "input": str(src), "output_dir": str(p / "out")})
            with (p / "out/simulation.csv").open() as stream:
                self.assertEqual(next(csv.DictReader(stream))["penetration_m"], "")

    def test_input_size_admitted_before_hashing_or_reading(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d); src = p / "oversize.json"
            with src.open("wb") as stream:
                stream.truncate(a.MAX_BYTES + 1)
            with patch.object(Path, "read_bytes", side_effect=AssertionError("unbounded read")):
                with self.assertRaises(ValueError):
                    a.execute({"operation": "export", "input": str(src), "output_dir": str(p / "out")})
            self.assertFalse((p / "out/simulation.mcap").exists())

    def test_row_byte_limit_before_write(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d); src = self.source(p, {**self.row(), "note": "x" * a.MAX_ROW_BYTES})
            with self.assertRaises(ValueError):
                a.execute({"operation": "export", "input": str(src), "output_dir": str(p / "out")})
            self.assertFalse((p / "out/simulation.mcap").exists())

    def test_replay_refuses_arbitrary_schema_or_topic(self):
        for kwargs in [{"schema": {}}, {"name": "arbitrary"}, {"topic": "/other"},
                       {"schema": {"$ref": "https://example.invalid/schema"}}]:
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as d:
                path = Path(d) / "input.mcap"; self.recording(path, [self.row()], **kwargs)
                with self.assertRaises(ValueError): a.read_mcap(path)

    def test_replay_refuses_overflow_and_bad_time(self):
        for rows in [[json.dumps({**self.row(), "penetrationMetres": "OVERFLOW"}).replace('"OVERFLOW"', '1e309')],
                     [{**self.row(), "timeSeconds": 1}, self.row()]]:
            with tempfile.TemporaryDirectory() as d:
                path = Path(d) / "input.mcap"; self.recording(path, rows)
                with self.assertRaises(ValueError): a.read_mcap(path)

    def test_replay_row_limit_is_streamed(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "input.mcap"; self.recording(path, [self.row()] * 3)
            with patch.object(a, "MAX_ROWS", 2):
                with self.assertRaises(ValueError): a.read_mcap(path)

    def test_replay_requires_crc_before_claiming_validated(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "input.mcap"; self.recording(path, [self.row()], crcs=False)
            with self.assertRaises(ValueError): a.read_mcap(path)

    def test_compressed_expansion_is_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "input.mcap"; self.recording(path, [{**self.row(), "note": "x" * 10000}])
            self.assertLess(path.stat().st_size, 5000)
            with patch.object(a, "MAX_BYTES", 5000):
                with self.assertRaises(ValueError): a.read_mcap(path)

    def test_legacy_schema_and_replay_input_custody(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d); source = p / "input.mcap"
            self.recording(source, [self.row()], schema=a.LEGACY_ROW_SCHEMA)
            result = a.execute({"operation": "replay", "input": str(source), "output_dir": str(p / "out")})
            self.assertTrue(result["ok"])
            retained = Path(result["source"]["retainedPath"])
            self.assertEqual(retained.read_bytes(), source.read_bytes())
            self.assertEqual(a.sha(retained), result["source"]["sha256"])


if __name__ == "__main__":
    unittest.main()
