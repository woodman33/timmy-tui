"""Bounded, model-free pose reconstruction. No source geometry is changed."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

import cv2
import numpy as np

MAX_BYTES = 65536
HASH = re.compile(r"(?:sha256[:_])?[a-fA-F0-9]{64}\Z")
IDENTIFIER = re.compile(r"[a-zA-Z0-9_.:/-]{1,128}\Z")
BASE = {"capability", "operation", "output_dir", "admission_receipt_hash"}
FIT = {"object_id", "source_revision", "frame_id", "units", "image_size",
       "camera_matrix", "distortion", "correspondences", "validation_correspondences"}


class Refusal(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Refusal(code)


def number(value, maximum=1e6):
    require(type(value) in (int, float) and math.isfinite(value)
            and abs(value) <= maximum, "invalid_numeric_value")
    return float(value)


def vector(value, count, maximum=1e6):
    require(isinstance(value, list) and len(value) == count, "invalid_vector_shape")
    return [number(item, maximum) for item in value]


def identifier(value):
    require(isinstance(value, str) and IDENTIFIER.fullmatch(value), "invalid_identifier")


def pairs(value, minimum, width, height):
    require(isinstance(value, list) and minimum <= len(value) <= 64, "invalid_correspondence_count")
    points, pixels, ids = [], [], []
    for item in value:
        require(isinstance(item, dict) and set(item) == {"id", "world", "pixel"}, "invalid_correspondence_fields")
        identifier(item["id"])
        point = vector(item["world"], 3)
        pixel = vector(item["pixel"], 2)
        require(0 <= pixel[0] < width and 0 <= pixel[1] < height, "pixel_outside_image")
        ids.append(item["id"])
        points.append(point)
        pixels.append(pixel)
    require(len(set(ids)) == len(ids), "duplicate_correspondence_id")
    require(len(set(map(tuple, points))) == len(points), "duplicate_world_position")
    return ids, np.asarray(points, dtype=np.float64), np.asarray(pixels, dtype=np.float64)


def project(points, rotation, translation, camera, distortion):
    """Independent explicit pinhole + Brown-Conrady projection; no cv2.projectPoints."""
    camera_points = points @ rotation.T + translation.reshape(1, 3)
    require(np.isfinite(camera_points).all() and (camera_points[:, 2] > 0).all(), "nonpositive_camera_depth")
    xy = camera_points[:, :2] / camera_points[:, 2:3]
    x, y = xy[:, 0], xy[:, 1]
    k1, k2, p1, p2, k3 = distortion
    r2 = x*x + y*y
    radial = 1 + k1*r2 + k2*r2*r2 + k3*r2*r2*r2
    xd = x*radial + 2*p1*x*y + p2*(r2 + 2*x*x)
    yd = y*radial + p1*(r2 + 2*y*y) + 2*p2*x*y
    pixels = np.column_stack((camera[0, 0]*xd + camera[0, 2], camera[1, 1]*yd + camera[1, 2]))
    require(np.isfinite(pixels).all(), "nonfinite_projection")
    return pixels, camera_points[:, 2]


def residuals(ids, expected, observed, depths):
    delta = observed - expected
    distances = np.linalg.norm(delta, axis=1)
    require(np.isfinite(distances).all(), "nonfinite_residual")
    return {"unit": "px", "count": len(ids), "rmse": float(np.sqrt(np.mean(distances**2))),
            "mean": float(np.mean(distances)), "max": float(np.max(distances)),
            "samples": [{"id": identity, "projected_pixel": pixel.tolist(),
                         "residual_pixel": difference.tolist(), "distance": float(distance),
                         "camera_depth": float(depth)}
                        for identity, pixel, difference, distance, depth in zip(ids, observed, delta, distances, depths)]}


def compute(request):
    require(isinstance(request, dict), "request_must_be_object")
    require(request.get("capability") == "camera-fit", "unsupported_capability")
    operation = request.get("operation")
    require(operation in ("probe", "fit"), "unsupported_operation")
    require(not set(request) - (BASE | (FIT if operation == "fit" else set())), "unknown_fields")
    if "admission_receipt_hash" in request:
        require(isinstance(request["admission_receipt_hash"], str)
                and HASH.fullmatch(request["admission_receipt_hash"]), "invalid_admission_receipt_hash")
    versions = {"python": sys.version.split()[0], "opencv": cv2.__version__, "numpy": np.__version__}
    if operation == "probe":
        return {"ok": True, "operation": operation, "capability": "camera-fit", "versions": versions,
                "method": "solvePnP ITERATIVE; noncoplanar fit only", "model_calls": 0}
    require(FIT <= set(request), "missing_fit_fields")
    identifier(request["object_id"])
    identifier(request["frame_id"])
    require(isinstance(request["source_revision"], str) and HASH.fullmatch(request["source_revision"]), "invalid_source_revision")
    require(request["units"] in ("m", "cm", "mm", "scene-unit"), "invalid_units")
    size = request["image_size"]
    require(isinstance(size, list) and len(size) == 2
            and all(type(v) is int and 1 <= v <= 32768 for v in size), "invalid_image_size")
    matrix = request["camera_matrix"]
    require(isinstance(matrix, list) and len(matrix) == 3, "invalid_camera_matrix")
    camera = np.asarray([vector(row, 3, 1e7) for row in matrix])
    require(camera[0, 0] > 0 and camera[1, 1] > 0 and camera[0, 1] == 0
            and camera[1, 0] == 0 and np.array_equal(camera[2], [0, 0, 1])
            and 0 <= camera[0, 2] < size[0] and 0 <= camera[1, 2] < size[1], "nonstandard_camera_matrix")
    distortion = request["distortion"]
    require(isinstance(distortion, list) and len(distortion) in (0, 5), "invalid_distortion")
    distortion = np.asarray(vector(distortion, 5, 100) if distortion else [0.0]*5)
    ids, world, pixel = pairs(request["correspondences"], 6, *size)
    validation_ids, validation_world, validation_pixel = pairs(request["validation_correspondences"], 3, *size)
    require(not set(ids) & set(validation_ids), "fit_validation_id_overlap")
    require(not set(map(tuple, world)) & set(map(tuple, validation_world)), "fit_validation_world_overlap")
    singular = np.linalg.svd(world - world.mean(axis=0), compute_uv=False)
    require(singular[0] > 0 and singular[-1] > singular[0]*1e-8, "degenerate_or_coplanar_fit")
    image_singular = np.linalg.svd(pixel - pixel.mean(axis=0), compute_uv=False)
    require(image_singular[0] > 0 and image_singular[-1] > image_singular[0]*1e-8,
            "degenerate_image_correspondences")
    cv2.setNumThreads(1)
    cv2.setRNGSeed(0)
    try:
        solved, rvec, tvec = cv2.solvePnP(world, pixel, camera, distortion, flags=cv2.SOLVEPNP_ITERATIVE)
    except cv2.error as error:
        raise Refusal("pose_solver_failed") from error
    require(solved and np.isfinite(rvec).all() and np.isfinite(tvec).all(), "pose_solver_failed")
    rotation = cv2.Rodrigues(rvec)[0]
    translation = tvec.reshape(3)
    projected, depths = project(world, rotation, translation, camera, distortion)
    # Validation observations are used only after fitting, never as solver inputs.
    validation_projected, validation_depths = project(validation_world, rotation, translation, camera, distortion)
    return {"ok": True, "operation": operation, "capability": "camera-fit", "versions": versions,
            "method": "cv2.solvePnP SOLVEPNP_ITERATIVE", "provenance": "reconstructed",
            "object_id": request["object_id"], "source_revision": request["source_revision"],
            "frame_id": request["frame_id"], "units": request["units"],
            "image_size": request["image_size"], "camera_matrix": request["camera_matrix"],
            "distortion": request["distortion"],
            "camera_convention": "OpenCV +X right, +Y down, +Z forward; X_camera = R @ X_world + t",
            "world_to_camera": {"rotation": rotation.tolist(), "translation": translation.tolist()},
            "camera_center_world": (-rotation.T @ translation).tolist(),
            "fit_residuals": residuals(ids, pixel, projected, depths),
            "validation_residuals": residuals(validation_ids, validation_pixel, validation_projected, validation_depths),
            "limits": {"ok_means_computation_completed": True, "geometry_truth": False,
                       "uncertainty_calibrated": False, "source_edited": False,
                       "validation_used_for_fit": False, "model_calls": 0,
                       "source_revision_units_and_correspondences_are_caller_declared": True,
                       "geometry_source_authenticated": False}}


def reject_duplicates(items):
    result = {}
    for key, value in items:
        require(key not in result, "duplicate_json_key")
        result[key] = value
    return result


def parse_request(raw):
    require(len(raw) <= MAX_BYTES, "request_exceeds_64kib")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicates,
                          parse_constant=lambda _: (_ for _ in ()).throw(Refusal("nonfinite_json_number")))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise Refusal("invalid_json") from error


def run(request):
    output = None
    output_admitted = False
    try:
        require(isinstance(request, dict), "request_must_be_object")
        directory = request.get("output_dir")
        require(isinstance(directory, str) and len(directory) <= 4096 and Path(directory).is_absolute(), "invalid_output_dir")
        output = Path(directory)
        require(not any(parent.is_symlink() for parent in (output, *output.parents)), "linked_output_dir")
        if not output.exists():
            output.mkdir(mode=0o700)
        require(output.is_dir() and not any(output.iterdir()), "output_dir_not_fresh")
        output_admitted = True
        result = compute(request)
        if "admission_receipt_hash" in request:
            result["admission_receipt_hash"] = request["admission_receipt_hash"]
    except Refusal as error:
        result = {"ok": False, "capability": "camera-fit", "error": str(error), "artifacts": []}
    except (OSError, ValueError, TypeError, OverflowError, np.linalg.LinAlgError):
        result = {"ok": False, "capability": "camera-fit", "error": "adapter_input_or_runtime_error", "artifacts": []}
    if output_admitted:
        data = (json.dumps(result, sort_keys=True, allow_nan=False, indent=2) + "\n").encode()
        require(len(data) <= MAX_BYTES, "result_exceeds_64kib")
        path = output / "result.json"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        result = {**result, "artifacts": [str(path)], "artifact_sha256": hashlib.sha256(data).hexdigest()}
    return result


def main():
    try:
        request = parse_request(sys.stdin.buffer.read(MAX_BYTES + 1))
        result = run(request)
    except Refusal as error:
        result = {"ok": False, "error": str(error), "artifacts": []}
    except (OSError, ValueError, TypeError):
        result = {"ok": False, "error": "artifact_write_failed", "artifacts": []}
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
