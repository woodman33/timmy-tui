"""Unit/child-process protocol tests, using SDK doubles. No real inference claim."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "scripts" / "vision-bridge.py"
SPEC = importlib.util.spec_from_file_location("candidate_vision_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class RecoveredBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fixture-", dir=ROOT / "tests")
        self.root = Path(self.temp.name)
        self.image = self.root / "source.png"
        self.image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
        self.request = {"action": "inspect", "runtime": "http", "imagePath": str(self.image),
                        "serverUrl": "http://127.0.0.1:9001", "modelId": "bounded-model/2"}

    def tearDown(self):
        self.temp.cleanup()

    def sdk(self, result=None):
        client = Mock()
        client.configure.return_value = client
        client.infer.return_value = result if result is not None else {"predictions": []}
        module = types.ModuleType("inference_sdk")
        module.InferenceHTTPClient = Mock(return_value=client)
        module.InferenceConfiguration = Mock(return_value="safe-configuration")
        return module, client

    def test_full_prediction_set_is_preserved_without_twenty_row_truncation(self):
        predictions = [{"class": "fixture", "confidence": .72, "x": i} for i in range(47)]
        module, client = self.sdk({"predictions": predictions, "image": {"width": 40, "height": 30}})
        with patch.dict("sys.modules", {"inference_sdk": module}), patch.dict(os.environ, {"ROBOFLOW_API_KEY": "synthetic-key"}):
            result = bridge.handle(self.request)
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["predictions"], predictions)
        self.assertEqual(result["result"]["image"], {"width": 40, "height": 30})
        module.InferenceConfiguration.assert_called_once_with(api_key_transport="header", disable_active_learning=True, workflow_run_retries_enabled=False)
        module.InferenceHTTPClient.assert_called_once_with(api_url="http://127.0.0.1:9001", api_key="synthetic-key")
        client.infer.assert_called_once_with(str(self.image), model_id="bounded-model/2")
        client.run_workflow.assert_not_called()

    def test_old_sdk_is_refused_without_query_auth_fallback(self):
        module, client = self.sdk()
        module.InferenceConfiguration.side_effect = TypeError("unsupported")
        with patch.dict("sys.modules", {"inference_sdk": module}), patch.dict(os.environ, {"ROBOFLOW_API_KEY": "synthetic-key"}):
            result = bridge.handle(self.request)
        self.assertEqual(result["state"], "not_configured")
        module.InferenceHTTPClient.assert_not_called()
        client.infer.assert_not_called()

    def test_probe_uses_metadata_and_does_not_import_or_run_a_runtime(self):
        with patch.object(bridge, "package_info", return_value={"installed": False, "version": None}) as info:
            result = bridge.handle({"action": "probe"})
        self.assertTrue(result["ok"])
        self.assertEqual(info.call_count, 3)

    def test_workflow_cannot_override_the_image_with_parameters(self):
        result = bridge.handle({**self.request, "workflowId": "fixture", "parameters": {"image": "other"}})
        self.assertEqual(result["state"], "invalid_request")

    def test_workflow_is_held_even_with_sdk_installed_until_server_sink_control_is_qualified(self):
        module, client = self.sdk()
        with patch.dict("sys.modules", {"inference_sdk": module}):
            result = bridge.handle({**self.request, "workflowId": "fixture", "workspace": "synthetic"})
        self.assertEqual(result["state"], "not_available")
        module.InferenceHTTPClient.assert_not_called()
        client.run_workflow.assert_not_called()

    def test_library_model_semantics_are_preserved_and_active_learning_is_disabled(self):
        module = types.ModuleType("inference")
        model = Mock()
        model.infer.return_value = [{"predictions": [{"class": "unit-only"}]}]
        module.get_model = Mock(return_value=model)
        with patch.dict("sys.modules", {"inference": module}), patch.dict(os.environ, {"ROBOFLOW_API_KEY": "synthetic-key"}):
            result = bridge.handle({**self.request, "runtime": "library"})
            self.assertEqual(os.environ["ACTIVE_LEARNING_ENABLED"], "false")
        self.assertTrue(result["ok"])
        module.get_model.assert_called_once_with(model_id="bounded-model/2", api_key="synthetic-key")
        model.infer.assert_called_once_with(str(self.image))

    def test_invalid_files_and_credential_bearing_urls_never_start_the_client(self):
        module, _ = self.sdk()
        self.image.write_bytes(b"not-an-image")
        with patch.dict("sys.modules", {"inference_sdk": module}):
            self.assertEqual(bridge.handle(self.request)["state"], "invalid_request")
            self.image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
            for url in ("file:///tmp/model", "http://user:secret@host/", "https://host/?api_key=private"):
                self.assertEqual(bridge.handle({**self.request, "serverUrl": url})["state"], "invalid_request")
        module.InferenceHTTPClient.assert_not_called()

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO creation unavailable")
    def test_fifo_is_refused_without_opening_it_as_a_blocking_stream(self):
        fifo = self.root / "image.png.pipe"
        os.mkfifo(fifo)
        self.assertEqual(bridge.handle({**self.request, "imagePath": str(fifo)})["state"], "invalid_request")

    def test_cloud_sync_and_query_are_explicitly_dispatched_unit_only(self):
        with patch.object(bridge, "cloud_operation", return_value={"ok": True, "state": "unit-only"}) as cloud:
            for action in ("sync_event", "query_events"):
                self.assertEqual(bridge.handle({"action": action})["state"], "unit-only")
        self.assertEqual(cloud.call_args_list, [unittest.mock.call({"action": "sync_event"}),
                                               unittest.mock.call({"action": "query_events"})])

    def test_unconfigured_cloud_request_stops_before_import_or_account_use(self):
        with patch.dict(os.environ, {}, clear=True):
            for action in ("sync_event", "query_events"):
                self.assertEqual(bridge.handle({"action": action})["state"], "not_configured")

    def test_credentials_are_redacted_without_altering_ordinary_result_fields(self):
        value = {"oauth": {"clientSecret": "unfamiliar", "refresh_token": "other"},
                 "note": "Bearer synthetic-key", "tokenCount": 47, "predictions": [{"class": "fixture"}]}
        with patch.dict(os.environ, {"ROBOFLOW_API_KEY": "synthetic-key"}):
            result = bridge.safe_output(value)
        self.assertEqual(result["oauth"], {"clientSecret": "[redacted]", "refresh_token": "[redacted]"})
        self.assertNotIn("synthetic-key", str(result))
        self.assertEqual(result["tokenCount"], 47)
        self.assertEqual(result["predictions"], value["predictions"])

    def test_upstream_error_text_is_not_exposed(self):
        module, client = self.sdk()
        client.infer.side_effect = RuntimeError("private endpoint https://host/?api_key=synthetic-key")
        with patch.dict("sys.modules", {"inference_sdk": module}), patch.dict(os.environ, {"ROBOFLOW_API_KEY": "synthetic-key"}):
            result = bridge.handle(self.request)
        self.assertEqual(result["state"], "execution_error")
        self.assertNotIn("synthetic-key", str(result))
        self.assertNotIn("private endpoint", str(result))

    def test_real_python_child_probe_and_bad_json_return_one_json_envelope(self):
        probe = subprocess.run([sys.executable, str(BRIDGE)], input='{"action":"probe"}', text=True,
                               capture_output=True, timeout=10)
        self.assertEqual(probe.returncode, 0)
        self.assertTrue(json.loads(probe.stdout)["ok"])
        self.assertEqual(probe.stderr, "")
        invalid = subprocess.run([sys.executable, str(BRIDGE)], input="not json", text=True,
                                 capture_output=True, timeout=10)
        self.assertEqual(invalid.returncode, 1)
        self.assertEqual(json.loads(invalid.stdout)["state"], "invalid_request")
        self.assertEqual(invalid.stderr, "")

    def test_child_process_contains_sdk_logs_and_preserves_the_complete_mock_result(self):
        # This exercises the real child protocol, with an on-disk SDK DOUBLE.
        # It deliberately makes no network requests and does not run a model.
        sdk = self.root / "inference_sdk"
        sdk.mkdir()
        (sdk / "__init__.py").write_text('''import sys
class InferenceConfiguration:
    def __init__(self, *, api_key_transport, disable_active_learning, workflow_run_retries_enabled):
        assert api_key_transport == "header" and disable_active_learning is True
class InferenceHTTPClient:
    def __init__(self, *, api_url, api_key):
        print("synthetic-key on stdout")
        print("synthetic-key on stderr", file=sys.stderr)
    def configure(self, config): return self
    def infer(self, image, *, model_id): return {"predictions": [{"class": "unit-only", "x": i} for i in range(47)]}
''')
        env = {**os.environ, "PYTHONPATH": str(self.root), "ROBOFLOW_API_KEY": "synthetic-key"}
        result = subprocess.run([sys.executable, str(BRIDGE)], input=json.dumps(self.request), text=True,
                                capture_output=True, timeout=10, env=env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(json.loads(result.stdout)["result"]["predictions"]), 47)
        self.assertNotIn("synthetic-key", result.stdout)
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
