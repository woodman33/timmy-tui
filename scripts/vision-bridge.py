#!/usr/bin/env python3
"""Timmy vision bridge: one bounded JSON operation, credentials from environment.

The parent process enforces execution/output limits. Probe uses package metadata
only, never imports an inference engine or makes network requests. No automatic
uploads, training, server creation, or fallback to a paid hosted endpoint.
"""
import contextlib
import importlib.metadata
import importlib.util
import json
import os
import re
import stat
import sys
from urllib.parse import urlsplit

MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_RESULT_BYTES = 8 * 1024 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024


def validate_image(path):
    """Validate a regular stored image without blocking on a FIFO or device."""
    if not isinstance(path, str) or not path or "\x00" in path:
        raise ValueError("image path")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_IMAGE_BYTES:
            raise ValueError("image file")
        header = os.read(fd, 12)
        if not (header.startswith(b"\x89PNG\r\n\x1a\n") or header.startswith(b"\xff\xd8\xff")
                or (header[:4] == b"RIFF" and header[8:12] == b"WEBP")):
            raise ValueError("image type")
    finally:
        os.close(fd)


def validate_server(raw):
    if not isinstance(raw, str) or not raw:
        raise ValueError("server address")
    parsed = urlsplit(raw)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("server address")


def package_info(module, distributions):
    try:
        installed = importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        installed = module in sys.modules
    version = None
    for name in distributions:
        try:
            version = importlib.metadata.version(name)
            break
        except importlib.metadata.PackageNotFoundError:
            continue
    return {"installed": installed, "version": version}


def probe():
    return {"ok": True, "state": "checked", "dependencies": {
        "inference_sdk": package_info("inference_sdk", ["inference-sdk"]),
        "inference": package_info("inference", ["inference", "inference-gpu", "inference-cpu"]),
        "roboflow": package_info("roboflow", ["roboflow", "roboflow-slim"]),
    }, "capabilities": {"imageInference": True, "libraryInference": True,
                         "workflows": False, "cloudEvents": True},
        "note": "Package metadata only. Model and explicitly requested cloud-event code paths are present, but not exercised by this probe. Workflow execution remains unavailable."}


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
        return value.tolist()
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError("The vision result contains unsupported non-JSON data")


def safe_output(value):
    secrets = [value for key, value in os.environ.items()
               if re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", key, re.I) and len(value) >= 4]
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, "[redacted]")
        value = re.sub(r"(api[_-]?key|(?:access|refresh|id)[_-]?token|client[_-]?secret|authorization|password)([\"'\s:=]+)[^\s&,\"'}]+",
                       r"\1\2[redacted]", value, flags=re.I)
        return re.sub(r"Bearer\s+[\w.-]+", "Bearer [redacted]", value, flags=re.I)
    if isinstance(value, dict):
        return {key: "[redacted]" if re.fullmatch(r"(?:[a-z0-9]+[._:-])*(?:api[_-]?key|token|(?:access|refresh|id)[_-]?token|authorization|password|(?:client[_-]?)?secret)", key, re.I)
                else safe_output(item) for key, item in value.items()}
    if isinstance(value, list):
        return [safe_output(item) for item in value]
    return value


def inspect_image(request):
    runtime = request.get("runtime", "http")
    key = os.environ.get("ROBOFLOW_API_KEY")
    image_path = request.get("imagePath")
    try:
        validate_image(image_path)
        if runtime not in ("http", "library"):
            raise ValueError("runtime")
        if runtime == "http":
            validate_server(request.get("serverUrl"))
    except (ValueError, OSError):
        return {"ok": False, "state": "invalid_request", "note": "Inspection requires a regular PNG, JPEG or WebP image and a supported runtime/server address."}
    workflow = request.get("specification") is not None or bool(request.get("workflowId"))
    if workflow:
        parameters = request.get("parameters") or {}
        if not isinstance(parameters, dict) or request.get("imageInput", "image") in parameters:
            return {"ok": False, "state": "invalid_request", "note": "Workflow parameters must not replace the inspection image input."}
        # The original bridge calls run_workflow(disable_sinks=True), but installed
        # historical SDK/server combinations do not support that request field.
        # Until both sides are qualified, never downgrade or infer sink safety.
        return {"ok": False, "state": "not_available", "note": "Workflow inference is held until the configured SDK and server are both qualified to enforce disable_sinks. No Workflow was sent; use a single model meanwhile."}
    model_id = request.get("modelId")
    if not isinstance(model_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}", model_id):
        return {"ok": False, "state": "invalid_request", "note": "Choose a model ID before inspection."}
    if runtime == "http" and not key:
        return {"ok": False, "state": "not_configured", "note": "ROBOFLOW_API_KEY is missing on the Timmy server."}
    if runtime == "library":
        # This adapter intentionally runs one model; use the server for Workflows.
        if request.get("specification") or request.get("workflowId"):
            return {"ok": False, "state": "not_configured", "note": "Workflows require the HTTP runtime."}
        os.environ["ACTIVE_LEARNING_ENABLED"] = "false"
        from inference import get_model
        model = get_model(model_id=request["modelId"], api_key=key)
        result = model.infer(image_path)
        version = package_info("inference", ["inference", "inference-gpu", "inference-cpu"])["version"]
    else:
        from inference_sdk import InferenceHTTPClient, InferenceConfiguration
        # Never downgrade header transport for an older server or SDK.
        try:
            configuration = InferenceConfiguration(
                api_key_transport="header", disable_active_learning=True,
                workflow_run_retries_enabled=False,
            )
        except TypeError:
            return {"ok": False, "state": "not_configured",
                    "note": "Update inference-sdk and use Inference Server 1.5.0+ for header-only authentication."}
        client = InferenceHTTPClient(api_url=request["serverUrl"], api_key=key).configure(configuration)
        if request.get("specification") is not None or request.get("workflowId"):
            arguments = {
                "images": {request.get("imageInput", "image"): image_path},
                "parameters": request.get("parameters") or {},
                "use_cache": False,
                # Capturing/forwarding evidence is a separate explicit Timmy action.
                "disable_sinks": True,
            }
            if request.get("specification") is not None:
                arguments["specification"] = request["specification"]
            else:
                arguments.update(workspace_name=request["workspace"], workflow_id=request["workflowId"])
            result = client.run_workflow(**arguments)
        else:
            result = client.infer(image_path, model_id=request["modelId"])
        version = package_info("inference_sdk", ["inference-sdk"])["version"]
    return {"ok": True, "state": "observed", "result": json_value(result), "sdkVersion": version}


def scalar_metadata(event):
    metadata = {key: value for key, value in event.get("metadata", {}).items()
                if re.fullmatch(r"[a-zA-Z0-9_ -]{1,100}", key)
                and isinstance(value, (str, int, float, bool))}
    metadata = {key: value[:1000] if isinstance(value, str) else value for key, value in list(metadata.items())[:80]}
    provenance = event.get("provenance", {})
    metadata.update({"timmy_event_id": event["id"], "image_sha256": event["image"]["sha256"],
                     "result_sha256": event["resultHash"], "timmy_receipt": event["receiptHash"],
                     "runtime": provenance["runtime"], "needs_review": event["needsReview"]})
    for key in ("modelId", "workflowId", "specificationHash", "parametersHash", "sdkVersion"):
        if provenance.get(key):
            metadata[key] = str(provenance[key])[:1000]
    return metadata


def annotation_data(result):
    """Map detection/classification arrays to documented Vision Events image fields."""
    detections, classifications = [], []
    def visit(value, depth=0):
        if depth > 30:
            return
        if isinstance(value, list):
            for child in value:
                visit(child, depth + 1)
        elif isinstance(value, dict):
            confidence = value.get("confidence")
            if isinstance(value.get("class"), str) and isinstance(confidence, (int, float)) and 0 <= confidence <= 1:
                if all(isinstance(value.get(k), (int, float)) for k in ("x", "y", "width", "height")):
                    detections.append({k: value[k] for k in ("class", "confidence", "x", "y", "width", "height")})
                else:
                    classifications.append({"class": value["class"], "confidence": confidence})
            for child in value.values():
                if isinstance(child, (dict, list)):
                    visit(child, depth + 1)
    visit(result)
    image = {"label": "Timmy inspection"}
    if detections:
        image["objectDetections"] = detections[:1000]
    if classifications:
        image["classifications"] = classifications[:1000]
    return image


def cloud_operation(request):
    if not os.environ.get("ROBOFLOW_API_KEY") or not request.get("workspace") or not request.get("useCaseId"):
        return {"ok": False, "state": "not_configured", "note": "Cloud Vision Events require key, workspace, and use case ID."}
    from roboflow import Roboflow
    workspace = Roboflow(api_key=os.environ["ROBOFLOW_API_KEY"]).workspace(request["workspace"])
    if request["action"] == "query_events":
        page = workspace.query_vision_events(request["useCaseId"], limit=request.get("limit", 25), cursor=request.get("cursor"))
        return {"ok": True, "state": "cloud", "result": json_value(page)}
    event = request["event"]
    image = annotation_data(event["result"])
    if request.get("includeImage"):
        upload = workspace.upload_vision_event_image(event["image"]["path"])
        image["sourceId"] = upload["sourceId"]
    payload = {
        "eventId": event["id"], "eventType": "custom", "useCaseId": request["useCaseId"],
        "timestamp": event["timestamp"], "customMetadata": scalar_metadata(event),
        "images": [image],
        "eventData": {},
    }
    if event.get("sourceId"):
        payload["streamId"] = event["sourceId"]
    if event.get("provenance", {}).get("workflowId"):
        payload["workflowId"] = event["provenance"]["workflowId"]
    response = workspace.write_vision_event(payload)
    # Preserve ingestion warnings; accepted events may have dropped optional fields.
    return {"ok": True, "state": "synced", "result": json_value(response),
            "warnings": response.get("warnings", []) if isinstance(response, dict) else []}


def handle(request):
    try:
        if not isinstance(request, dict):
            return {"ok": False, "state": "invalid_request", "note": "The request must be a JSON object."}
        if request.get("action") == "probe":
            return probe()
        if request.get("action") == "inspect":
            return inspect_image(request)
        if request.get("action") in ("sync_event", "query_events"):
            return cloud_operation(request)
        return {"ok": False, "state": "invalid_request", "note": "Unknown vision operation."}
    except (ImportError, ModuleNotFoundError):
        return {"ok": False, "state": "not_configured", "note": "A required Python package is missing. Check Vision setup."}
    except Exception as error:
        name = type(error).__name__
        status = getattr(error, "status_code", None)
        if status is None:
            status = getattr(getattr(error, "response", None), "status_code", None)
        if status in (401, 403) or re.search(r"unauthori|forbidden|APIKeyNotProvided", name, re.I):
            return {"ok": False, "state": "not_configured", "note": "Roboflow authentication or permissions were rejected."}
        if re.search(r"connection|connecterror|timeout", name, re.I):
            return {"ok": False, "state": "not_configured", "note": "The Inference Server could not be reached. Check its address and service."}
        # Do not print upstream exception strings: they may contain an API key.
        return {"ok": False, "state": "execution_error", "note": "Roboflow could not complete the operation.", "errorType": name}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("request size")
        request = json.loads(raw)
        # SDK stdout and stderr can contain credential-bearing URLs. Neither is
        # part of the bridge protocol; runtime.ts receives one JSON envelope only.
        with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            result = handle(request)
        encoded = json.dumps(safe_output(result), allow_nan=False)
        if len(encoded.encode("utf-8")) > MAX_RESULT_BYTES:
            result = {"ok": False, "state": "output_limit", "note": "The complete vision result exceeded 8 MB; no truncated prediction set is reported as success."}
            encoded = json.dumps(result)
        print(encoded)
        return 0 if result.get("ok") else 1
    except Exception:
        print(json.dumps({"ok": False, "state": "invalid_request", "note": "Invalid vision request or response."}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
