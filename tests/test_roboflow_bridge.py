"""Offline legacy bridge unit controls. SDK doubles are not inference evidence."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("timmy_legacy_roboflow_bridge", Path(__file__).parents[1] / "scripts" / "roboflow-bridge.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class BridgeUnitControls(unittest.TestCase):
    def sdk_double(self, response=None, failure=None):
        observed = {}
        module = types.ModuleType("inference_sdk")
        def configuration(**kwargs):
            observed["configuration"] = kwargs
            return kwargs
        class Client:
            def __init__(self, **kwargs):
                observed["client"] = kwargs
            def configure(self, config):
                return self
            def infer(self, image, model_id):
                observed["infer"] = (image, model_id)
                if failure:
                    raise failure
                return response if response is not None else {"predictions": []}
        module.InferenceHTTPClient = Client
        module.InferenceConfiguration = configuration
        return module, observed

    def test_detect_uses_inference_without_initializing_workspace(self):
        sdk, observed = self.sdk_double()
        roboflow = types.ModuleType("roboflow")
        def forbidden_workspace(*args, **kwargs):
            self.fail("detect must not initialize Roboflow or access a workspace")
        roboflow.Roboflow = forbidden_workspace
        with patch.dict(sys.modules, {"inference_sdk": sdk, "roboflow": roboflow}), patch.dict(os.environ, {"ROBOFLOW_API_KEY": "unit-only-key"}, clear=True):
            result = bridge.handle({"action": "detect", "project": "unit-project", "path": "unit-fixture.png"})
        self.assertTrue(result["ok"])
        self.assertEqual(observed["client"]["api_url"], "http://127.0.0.1:9001")
        self.assertEqual(observed["configuration"]["api_key_transport"], "header")
        self.assertTrue(observed["configuration"]["disable_active_learning"])
        self.assertEqual(observed["infer"], ("unit-fixture.png", "unit-project/1"))

    def test_complete_prediction_response_is_retained(self):
        predictions = [{"class": str(index), "confidence": 0.5, "points": [{"x": index, "y": 1}]} for index in range(37)]
        response = {"predictions": predictions, "inference_id": "offline-unit-response", "image": {"width": 64, "height": 32}, "time": 0.1}
        sdk, _ = self.sdk_double(response)
        with patch.dict(sys.modules, {"inference_sdk": sdk}), patch.dict(os.environ, {}, clear=True):
            result = bridge.handle({"action": "detect", "project": "unit-project", "path": "unit-fixture.png"})
        self.assertEqual(result["result"], response)
        self.assertEqual(result["predictions"], predictions)
        self.assertEqual(len(result["predictions"]), 37)

    def test_explicit_hosted_address_is_not_replaced(self):
        sdk, observed = self.sdk_double()
        with patch.dict(sys.modules, {"inference_sdk": sdk}), patch.dict(os.environ, {"TIMMY_VISION_SERVER_URL": "https://serverless.roboflow.com"}, clear=True):
            result = bridge.handle({"action": "detect", "project": "unit-project", "path": "unit-fixture.png"})
        self.assertTrue(result["ok"])
        self.assertEqual(observed["client"]["api_url"], "https://serverless.roboflow.com")

    def test_failure_does_not_retry_or_expose_exception_credentials(self):
        sdk, observed = self.sdk_double(failure=RuntimeError("secret https://provider/?api_key=unit-only-key"))
        with patch.dict(sys.modules, {"inference_sdk": sdk}), patch.dict(os.environ, {}, clear=True):
            result = bridge.handle({"action": "detect", "project": "unit-project", "path": "unit-fixture.png"})
        self.assertEqual(result["state"], "execution_error")
        self.assertNotIn("unit-only-key", json.dumps(result))
        self.assertEqual(observed["client"]["api_url"], "http://127.0.0.1:9001")

    def test_unknown_action_never_loads_workspace(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(bridge.handle({"action": "unknown"})["state"], "invalid_request")

    def test_upload_remains_an_explicit_workspace_operation(self):
        calls = []
        module = types.ModuleType("roboflow")
        class Project:
            def upload(self, path):
                calls.append(("upload", path))
                return "unit-upload-id"
        class Workspace:
            def project(self, name):
                calls.append(("project", name))
                return Project()
        class Roboflow:
            def __init__(self, **kwargs):
                pass
            def workspace(self, name):
                calls.append(("workspace", name))
                return Workspace()
        module.Roboflow = Roboflow
        with patch.dict(sys.modules, {"roboflow": module}), patch.dict(os.environ, {"ROBOFLOW_API_KEY": "unit-only-key"}, clear=True):
            result = bridge.handle({"action": "upload", "workspace": "unit-workspace", "project": "unit-project", "path": "unit-fixture.png"})
        self.assertEqual(result, {"ok": True, "action": "upload", "id": "unit-upload-id", "path": "unit-fixture.png"})
        self.assertEqual(calls, [("workspace", "unit-workspace"), ("project", "unit-project"), ("upload", "unit-fixture.png")])

    def test_main_keeps_sdk_stdout_out_of_json_protocol(self):
        def noisy_handle(request):
            print("unit SDK diagnostic")
            return {"ok": True, "token": "unit-only-key", "note": "unit-only-key"}
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(bridge, "handle", noisy_handle), patch.object(sys, "stdin", io.StringIO('{"action":"detect"}')), patch.dict(os.environ, {"ROBOFLOW_API_KEY": "unit-only-key"}, clear=True), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            bridge.main()
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["token"], "[redacted]")
        self.assertEqual(payload["note"], "[redacted]")
        self.assertEqual(stderr.getvalue().strip(), "unit SDK diagnostic")


if __name__ == "__main__":
    unittest.main()
