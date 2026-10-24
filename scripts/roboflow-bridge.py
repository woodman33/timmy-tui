#!/usr/bin/env python3
"""Legacy synchronous Roboflow operation. JSON stdin/stdout, keys from environment.

Detection uses Inference directly. Only explicit upload/sample actions resolve a
Roboflow workspace or upload data. No hosted fallback or automatic model install.
"""
import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlparse


def json_value(value):
    if hasattr(value, "model_dump"):
        return json_value(value.model_dump(mode="json"))
    if hasattr(value, "dict"):
        return json_value(value.dict())
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [json_value(item) for item in value]
    if hasattr(value, "tolist"):
        return json_value(value.tolist())
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError("Unsupported response data")


def redact(value):
    secrets = [item for key, item in os.environ.items()
               if re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", key, re.I) and len(item) >= 4]
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, "[redacted]")
        value = re.sub(r"(api[_-]?key|(?:access|refresh|id)[_-]?token|client[_-]?secret|authorization|password)([\"'\s:=]+)[^\s&,\"'}]+",
                       r"\1\2[redacted]", value, flags=re.I)
        return re.sub(r"Bearer\s+[\w.-]+", "Bearer [redacted]", value, flags=re.I)
    if isinstance(value, dict):
        return {key: "[redacted]" if re.fullmatch(r"(?:[a-z0-9]+[._:-])*(?:api[_-]?key|token|(?:access|refresh|id)[_-]?token|authorization|password|(?:client[_-]?)?secret)", key, re.I)
                else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def detect(request):
    from inference_sdk import InferenceHTTPClient, InferenceConfiguration
    server = os.environ.get("TIMMY_VISION_SERVER_URL") or "http://127.0.0.1:9001"
    parsed = urlparse(server)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return {"ok": False, "state": "invalid_request", "note": "Configure an HTTP Inference Server address without credentials or query parameters."}
    confidence = request.get("confidence", 40)
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 100:
        return {"ok": False, "state": "invalid_request", "note": "Confidence must be a number from 0 to 100."}
    try:
        config = InferenceConfiguration(api_key_transport="header", confidence_threshold=confidence / 100.0,
                                        disable_active_learning=True, workflow_run_retries_enabled=False)
    except TypeError:
        return {"ok": False, "state": "not_configured", "note": "Use an inference-sdk and Inference Server supporting header-only authentication (1.5.0 or newer)."}
    client = InferenceHTTPClient(api_url=server, api_key=os.environ.get("ROBOFLOW_API_KEY")).configure(config)
    result = json_value(client.infer(request["path"], model_id=f'{request["project"]}/{request.get("version", 1)}'))
    # Keep the complete response; the compatibility predictions field is not capped.
    predictions = result.get("predictions", []) if isinstance(result, dict) else [prediction for item in result if isinstance(item, dict) for prediction in item.get("predictions", [])] if isinstance(result, list) else []
    return {"ok": True, "state": "observed", "action": "detect", "predictions": predictions, "result": result}


def handle(request):
    action = request.get("action")
    try:
        if action == "detect":
            return detect(request)
        if action not in ("upload", "sample"):
            return {"ok": False, "state": "invalid_request", "note": "Unknown Roboflow action."}
        if not os.environ.get("ROBOFLOW_API_KEY"):
            return {"ok": False, "state": "not_configured", "note": "Configure a Roboflow workspace key before uploading."}
        from roboflow import Roboflow
        rf = Roboflow(api_key=os.environ["ROBOFLOW_API_KEY"])
        workspace = rf.workspace(request.get("workspace") or os.environ.get("ROBOFLOW_WORKSPACE", ""))
        project = workspace.project(request["project"])
        if action == "upload":
            result = project.upload(request["path"])
            return {"ok": True, "action": "upload", "id": str(result), "path": request["path"]}
        # Explicit legacy sample semantics: extract frames and upload each one.
        count = int(request.get("frames", 4))
        every = max(1, int(request.get("every", 30)))
        with tempfile.TemporaryDirectory(prefix="timmy-rf-") as directory:
            subprocess.run(["ffmpeg", "-y", "-i", request["video"], "-vf", f"select=not(mod(n\\,{every}))",
                            "-vsync", "vfr", "-frames:v", str(count), f"{directory}/f-%02d.png"],
                           check=True, capture_output=True)
            ids = [str(project.upload(os.path.join(directory, name))) for name in sorted(os.listdir(directory)) if name.endswith(".png")]
        return {"ok": True, "action": "sample", "evidence_ids": ids, "video": request["video"]}
    except (ImportError, ModuleNotFoundError):
        return {"ok": False, "state": "not_configured", "note": "A required Roboflow Python package is missing from this runtime."}
    except (KeyError, ValueError, TypeError):
        return {"ok": False, "state": "invalid_request", "note": "The Roboflow request or response is invalid."}
    except Exception as error:
        return {"ok": False, "state": "execution_error", "note": "Roboflow could not complete the operation.", "errorType": type(error).__name__}


def main():
    try:
        request = json.load(sys.stdin)
        # SDK banners/diagnostics cannot corrupt the JSON protocol.
        with contextlib.redirect_stdout(sys.stderr):
            result = handle(request)
        print(json.dumps(redact(result), allow_nan=False))
    except Exception:
        print(json.dumps({"ok": False, "state": "invalid_request", "note": "Invalid Roboflow request or response."}))


if __name__ == "__main__":
    main()
