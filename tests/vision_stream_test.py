"""Network-free stream contract tests; no SDK imports or camera access."""
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import threading
import unittest
from types import SimpleNamespace


spec = importlib.util.spec_from_file_location("vision_stream", Path(__file__).parents[1] / "scripts/vision-stream.py")
stream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stream)


class Session:
    def __init__(self, hang=False):
        self.closed = threading.Event()
        self.frame = None
        self.data = None
        self.hang = hang
        self.data_field = None
    def on_frame(self, callback):
        self.frame = callback
        return callback
    def on_data(self, field):
        self.data_field = field
        def register(callback):
            self.data = callback
            return callback
        return register
    def on_error(self, callback):
        self.error = callback
        return callback
    def close(self):
        self.closed.set()
    def run(self):
        if self.hang:
            assert self.closed.wait(timeout=1)
        elif self.data:
            self.frame(None, SimpleNamespace(frame_id=7))
            self.data({"confidence": 0.8}, SimpleNamespace(frame_id=7))
        else:
            self.frame(None, None, SimpleNamespace(frame_id=6))
            self.frame(None, {"confidence": 0.9}, SimpleNamespace(frame_id=7))


class StreamTests(unittest.TestCase):
    def config(self, args=None, **env):
        parsed = stream.parser().parse_args(args or ["--camera", "0", "--model", "detector/1", "--task-type", "object-detection"])
        environment = {"ROBOFLOW_API_KEY": "test-secret", **env}
        return parsed, stream.settings(parsed, environment)
    def test_requires_explicit_source(self):
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                stream.parser().parse_args([])
    def test_model_requires_task_type_to_avoid_cloud_lookup(self):
        with self.assertRaises(ValueError):
            self.config(["--camera", "0", "--model", "detector/1"])
    def test_rejects_hosted_or_credential_bearing_inference_urls(self):
        for url in ["https://serverless.roboflow.com", "https://api.roboflow.com", "http://key:secret@localhost:9001"]:
            with self.assertRaises(ValueError):
                self.config(TIMMY_VISION_SERVER_URL=url)
    def test_rtsp_is_environment_only_and_preserves_source_for_server(self):
        _, cfg = self.config(["--rtsp", "--workflow", "inspect", "--allow-workflow-sinks"], ROBOFLOW_WORKSPACE="workspace", TIMMY_VISION_STREAM_URL="rtsp://user:password@camera.local/stream")
        self.assertEqual(cfg["source"], "rtsp")
        self.assertTrue(cfg["stream_url"].startswith("rtsp://"))
    def test_header_transport_and_model_options(self):
        args, cfg = self.config()
        seen = {}
        class Client:
            def __init__(self, **kwargs):
                seen["client"] = kwargs
                self.webrtc = self
            def configure(self, configuration):
                seen["configuration"] = configuration
                return self
            def stream(self, **kwargs):
                seen["stream"] = kwargs
                return Session()
        def record(**kwargs):
            return SimpleNamespace(**kwargs)
        sdk = (Client, record, record, record, record, record)
        session = stream.make_session(cfg, args, sdk=sdk)
        self.assertIsInstance(session, Session)
        self.assertEqual(seen["configuration"].api_key_transport, "header")
        self.assertEqual(seen["stream"]["task_type"], "object-detection")
        self.assertNotIn("workflow", seen["stream"])
        self.assertEqual(seen["stream"]["source"].device_id, 0)
    def test_model_callbacks_skip_missing_predictions_and_close(self):
        _, cfg = self.config()
        records = []
        session = Session()
        self.assertEqual(stream.consume(session, cfg, records.append), 0)
        predictions = [x for x in records if x["type"] == "predictions"]
        self.assertEqual(len(predictions), 1)
        self.assertEqual(predictions[0]["frameId"], 7)
        self.assertTrue(session.closed.is_set())
    def test_workflow_routes_named_data_output(self):
        _, cfg = self.config(["--camera", "0", "--workflow", "inspect", "--data-output", "detections", "--allow-workflow-sinks"], ROBOFLOW_WORKSPACE="workspace")
        records = []
        session = Session()
        stream.consume(session, cfg, records.append)
        self.assertEqual(session.data_field, "detections")
        self.assertEqual(records[0]["data"], {"confidence": 0.8})
    def test_finite_duration_closes_even_with_no_frames(self):
        _, cfg = self.config()
        cfg["duration"] = 0.02
        records = []
        session = Session(hang=True)
        stream.consume(session, cfg, records.append)
        self.assertTrue(session.closed.is_set())
        self.assertEqual(records[-1]["reason"], "duration_reached")
    def test_saved_workflow_requires_sink_acknowledgement(self):
        with self.assertRaises(ValueError):
            self.config(["--camera", "0", "--workflow", "inspect"], ROBOFLOW_WORKSPACE="workspace")
    def test_prediction_secrets_redacted_and_record_size_bounded(self):
        clean = stream.clean({"token": "hidden", "message": "test-secret rtsp://user:pass@camera.local/stream"}, {"ROBOFLOW_API_KEY": "test-secret"})
        self.assertNotIn("test-secret", json.dumps(clean))
        self.assertNotIn("user:pass", json.dumps(clean))
        self.assertEqual(clean["token"], "[redacted]")
        sink = io.StringIO()
        stream.emit_record(sink, {"type": "predictions", "data": "x" * 70000})
        self.assertEqual(json.loads(sink.getvalue())["type"], "data_omitted")


if __name__ == "__main__":
    unittest.main()
