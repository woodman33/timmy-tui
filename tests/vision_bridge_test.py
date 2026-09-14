"""Contract tests; fake SDK modules prohibit downloads, inference spend, or cloud writes."""
import importlib.util
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

SPEC = importlib.util.spec_from_file_location("vision_bridge", Path(__file__).parents[1] / "scripts/vision-bridge.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class VisionBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.image = str(Path(self.temp.name) / "image.png")
        Path(self.image).write_bytes(b"png")

    def tearDown(self):
        self.temp.cleanup()

    def sdk(self):
        client = Mock()
        client.configure.return_value = client
        client.infer.return_value = {"predictions": [{"confidence": 0.5}]}
        client.run_workflow.return_value = [{"output": True}]
        module = types.ModuleType("inference_sdk")
        module.InferenceHTTPClient = Mock(return_value=client)
        module.InferenceConfiguration = Mock(return_value="configured")
        return module, client

    def test_header_only_auth_and_disabled_auto_learning(self):
        module, client = self.sdk()
        with patch.dict("sys.modules", {"inference_sdk": module}), patch.dict(os.environ, {"ROBOFLOW_API_KEY": "rf_private"}):
            result = bridge.handle({"action": "inspect", "runtime": "http", "serverUrl": "http://spark:9001", "imagePath": self.image, "modelId": "cards/2"})
        self.assertTrue(result["ok"])
        module.InferenceConfiguration.assert_called_once_with(api_key_transport="header", disable_active_learning=True, workflow_run_retries_enabled=False)
        module.InferenceHTTPClient.assert_called_once_with(api_url="http://spark:9001", api_key="rf_private")
        client.infer.assert_called_once_with(self.image, model_id="cards/2")

    def test_workflow_bypasses_definition_cache_and_preserves_parameters(self):
        module, client = self.sdk()
        with patch.dict("sys.modules", {"inference_sdk": module}):
            result = bridge.handle({"action": "inspect", "runtime": "http", "serverUrl": "http://spark:9001", "imagePath": self.image,
                                    "workspace": "timmy", "workflowId": "inspect-box", "imageInput": "photo", "parameters": {"count": 37}})
        self.assertTrue(result["ok"])
        client.run_workflow.assert_called_once_with(images={"photo": self.image}, parameters={"count": 37}, use_cache=False, disable_sinks=True, workspace_name="timmy", workflow_id="inspect-box")

    def test_outdated_sdk_does_not_downgrade_to_query_auth(self):
        module, client = self.sdk()
        module.InferenceConfiguration.side_effect = TypeError("old sdk")
        with patch.dict("sys.modules", {"inference_sdk": module}):
            result = bridge.handle({"action": "inspect", "serverUrl": "http://spark:9001", "imagePath": self.image, "modelId": "cards/2"})
        self.assertEqual(result["state"], "not_configured")
        client.infer.assert_not_called()

    def test_probe_does_not_import_sdk_or_make_network_calls(self):
        with patch.object(bridge, "package_info", return_value={"installed": False, "version": None}) as info:
            result = bridge.handle({"action": "probe"})
        self.assertTrue(result["ok"])
        self.assertEqual(info.call_count, 3)

    def test_upstream_exception_never_echoes_api_key(self):
        module, client = self.sdk()
        client.infer.side_effect = ConnectionError("failed https://example.com/?api_key=private")
        with patch.dict("sys.modules", {"inference_sdk": module}):
            result = bridge.handle({"action": "inspect", "serverUrl": "http://spark:9001", "imagePath": self.image, "modelId": "cards/2"})
        self.assertEqual(result["state"], "not_configured")
        self.assertNotIn("private", str(result))

    def test_unfamiliar_oauth_credentials_are_redacted_by_field_name(self):
        fields = ["client_secret", "clientSecret", "refresh_token", "refreshToken", "id_token", "idToken",
                  "access_token", "accessToken", "ROBOFLOW_CLIENT_SECRET", "oauth.clientSecret", "oauth:refresh_token"]
        credentials = {field: f"synthetic-credential-{index}" for index, field in enumerate(fields)}
        with patch.dict(os.environ, {}, clear=True):
            result = bridge.safe_output({"oauth": credentials, "client_id": "public-client", "tokenCount": 23,
                                         "note": 'clientSecret=synthetic-client-secret refresh_token=synthetic-refresh-token "id_token": "synthetic-id-token"'})
        self.assertEqual(result["oauth"], {field: "[redacted]" for field in fields})
        self.assertEqual(result["client_id"], "public-client")
        self.assertEqual(result["tokenCount"], 23)
        self.assertNotIn("synthetic-", str(result))

    def test_cloud_upload_is_opt_in_and_pass_is_never_invented(self):
        workspace = Mock()
        workspace.write_vision_event.return_value = {"created": True}
        module = types.ModuleType("roboflow")
        module.Roboflow = Mock()
        module.Roboflow.return_value.workspace.return_value = workspace
        event = {"id": "123", "timestamp": "2026-09-07T00:00:00Z", "image": {"path": self.image, "sha256": "abc"},
                 "result": {"predictions": [{"class": "card", "confidence": 0.5, "x": 10, "y": 10, "width": 5, "height": 5}]},
                 "resultHash": "xyz", "receiptHash": "rc", "needsReview": True, "provenance": {"runtime": "http"}}
        with patch.dict("sys.modules", {"roboflow": module}), patch.dict(os.environ, {"ROBOFLOW_API_KEY": "private"}):
            result = bridge.handle({"action": "sync_event", "workspace": "timmy", "useCaseId": "inspection", "event": event, "includeImage": False})
        self.assertTrue(result["ok"])
        workspace.upload_vision_event_image.assert_not_called()
        payload = workspace.write_vision_event.call_args.args[0]
        self.assertEqual(payload["eventType"], "custom")
        self.assertEqual(payload["eventData"], {})
        self.assertEqual(payload["images"][0]["objectDetections"][0]["class"], "card")


if __name__ == "__main__":
    unittest.main()
