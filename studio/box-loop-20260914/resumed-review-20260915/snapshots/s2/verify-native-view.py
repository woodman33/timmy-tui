#!/usr/bin/env python3
"""Independent, read-only verification of the bounded box/bore native view."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
import zlib


PIXELS = [(84, 64), (44, 64), (64, 44), (64, 84), (64, 64)]
TOLERANCE_MM = 1e-3


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def subtract(a, b):
    return tuple(x - y for x, y in zip(a, b))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    return math.sqrt(dot(a, a))


def nearest_hit(origin, direction, vertices, triangles):
    """Two-sided Moller-Trumbore; normalized direction makes t a ray range in mm."""
    nearest = None
    for indices in triangles:
        a, b, c = (vertices[index] for index in indices)
        edge1, edge2 = subtract(b, a), subtract(c, a)
        p = cross(direction, edge2)
        determinant = dot(edge1, p)
        if abs(determinant) < 1e-12:
            continue
        inverse = 1.0 / determinant
        offset = subtract(origin, a)
        u = dot(offset, p) * inverse
        if u < -1e-10 or u > 1.0 + 1e-10:
            continue
        q = cross(offset, edge1)
        v = dot(direction, q) * inverse
        if v < -1e-10 or u + v > 1.0 + 1e-10:
            continue
        distance = dot(edge2, q) * inverse
        if distance > 1e-9 and (nearest is None or distance < nearest):
            nearest = distance
    if nearest is None:
        return None
    return {"rayRangeMm": nearest, "pointWorldMm": [o + nearest * d for o, d in zip(origin, direction)]}


def decode_png(path):
    """Decode only bounded, noninterlaced 8-bit RGB/RGBA PNG using stdlib."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Invalid PNG signature")
    offset, compressed, header = 8, bytearray(), None
    while offset < len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        crc = struct.unpack_from(">I", data, offset + 8 + length)[0]
        if zlib.crc32(kind + payload) & 0xffffffff != crc:
            raise ValueError("PNG CRC mismatch")
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            compressed.extend(payload)
        offset += length + 12
        if kind == b"IEND":
            break
    if header is None or header[:3] != (128, 128, 8) or header[3] not in (2, 6) or header[4:] != (0, 0, 0):
        raise ValueError("Expected 128x128 noninterlaced 8-bit RGB or RGBA PNG")
    channels = 4 if header[3] == 6 else 3
    stride = 128 * channels
    expected = 128 * (stride + 1)
    inflater = zlib.decompressobj()
    raw = inflater.decompress(bytes(compressed), expected + 1)
    if len(raw) != expected or not inflater.eof or inflater.unconsumed_tail:
        raise ValueError("PNG decoded length mismatch")
    rows, previous, cursor = [], bytearray(stride), 0
    for _ in range(128):
        filtering = raw[cursor]
        row = bytearray(raw[cursor + 1:cursor + stride + 1])
        cursor += stride + 1
        if filtering not in range(5):
            raise ValueError("Unsupported PNG filter")
        for i in range(stride):
            left = row[i - channels] if i >= channels else 0
            above = previous[i]
            upper_left = previous[i - channels] if i >= channels else 0
            predictor = 0
            if filtering == 1:
                predictor = left
            elif filtering == 2:
                predictor = above
            elif filtering == 3:
                predictor = (left + above) // 2
            elif filtering == 4:
                p = left + above - upper_left
                distances = [abs(p - left), abs(p - above), abs(p - upper_left)]
                predictor = [left, above, upper_left][distances.index(min(distances))]
            row[i] = (row[i] + predictor) & 255
        rows.append(row)
        previous = row
    return channels, rows


def read_json(path):
    def invalid(value):
        raise ValueError("Nonfinite JSON number: " + value)
    return json.loads(path.read_text(), parse_constant=invalid)


def verify(source, directory):
    checks, samples = {}, []
    def check(name, condition):
        checks[name] = bool(condition)
    mesh = read_json(source)
    packet = read_json(directory / "grounding-input.json")
    native = read_json(directory / "ray-hit-points.json")
    metadata = read_json(directory / "capture-metadata.json")
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    positions, indices = mesh["positions"], mesh["triangles"]
    if mesh.get("units") != "mm" or len(positions) % 3 or len(indices) % 3 or not all(finite(v) for v in positions):
        raise ValueError("Invalid millimetre source mesh")
    vertices = [tuple(positions[i:i + 3]) for i in range(0, len(positions), 3)]
    if not vertices or not indices or not all(type(i) is int and 0 <= i < len(vertices) for i in indices):
        raise ValueError("Invalid source triangle indices")
    triangles = [indices[i:i + 3] for i in range(0, len(indices), 3)]
    revision = packet["sourceRevision"]
    check("source_revision_format", isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{64}", revision) is not None)
    check("source_surface_bytes", metadata.get("sourceSha256") == source_hash)
    check("source_size", metadata.get("sourceBytes") == source.stat().st_size)
    check("source_unchanged", metadata.get("sourceUnchanged") is True)
    check("source_world_alignment", metadata.get("objectTransform") == {
        "units": "mm", "matrixRows": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]})
    check("metadata_revision", metadata.get("sourceRevision") == revision)
    check("expected_revision", packet.get("expectedSourceRevision") == revision)
    check("generated_scope", packet.get("sourceProvenance") == "generated")
    check("selected_pixel", packet.get("detection") == {"pixel": [84, 64], "imageSize": [128, 128]})
    for name in ["rgb.png", "scene.blend", "grounding-input.json", "ray-hit-points.json", "rgb-alpha.json"]:
        artifact = (directory / name).read_bytes()
        binding = metadata.get("artifacts", {}).get(name, {})
        check("artifact_" + name, binding.get("sha256") == hashlib.sha256(artifact).hexdigest()
              and binding.get("bytes") == len(artifact) and len(artifact) > 0)
    camera, depth, ids = packet["camera"], packet["depth"], packet["objectIds"]
    check("camera_contract", camera.get("projection") == "rectified-pinhole" and camera.get("axes") == "x-right-y-down-z-forward"
          and camera.get("pixelConvention") == "integer-pixel-centers" and camera.get("units") == "mm")
    check("camera_intrinsics", camera.get("intrinsics") == {"fx": 128, "fy": 128, "cx": 63.5, "cy": 63.5})
    check("camera_extrinsics", camera.get("cameraToWorld") == {"rotationRows": [[1, 0, 0], [0, -1, 0], [0, 0, -1]], "translationMm": [0, 0, 200]})
    check("camera_size", camera.get("imageSize") == [128, 128])
    check("camera_revision", camera.get("sourceRevision") == revision)
    check("camera_generated", camera.get("provenance") == "generated")
    check("depth_quantity", depth.get("quantity") == "camera-z" and depth.get("units") == "mm" and depth.get("metricScale") == "known")
    for name, raster in [("depth", depth), ("object_ids", ids)]:
        check(name + "_alignment", raster.get("alignment") == "rectified-camera-grid" and raster.get("cameraId") == camera.get("id")
              and raster.get("imageSize") == [128, 128] and raster.get("sourceRevision") == revision)
        check(name + "_generated", raster.get("provenance") == "generated")
    check("object_mapping", ids.get("objects") == ["box-bore"])
    check("native_contract", native.get("schema") == "timmy.native-view.ray-hits/1" and native.get("sourceRevision") == revision
          and native.get("cameraId") == camera.get("id") and native.get("imageSize") == [128, 128]
          and native.get("units") == "mm" and native.get("order") == "row-major")
    depths, object_ids, hits = depth["values"], ids["values"], native["pixels"]
    if any(len(values) != 128 * 128 for values in [depths, object_ids, hits]):
        raise ValueError("Raster lengths must all equal 16384")
    check("depth_values", all(v is None or finite(v) and v > 0 for v in depths))
    check("object_id_values", all(v is None or type(v) is int and v == 0 for v in object_ids))
    check("raster_validity_masks", all((d is None) == (o is None) == (h is None) for d, o, h in zip(depths, object_ids, hits)))
    channels, rows = decode_png(directory / "rgb.png")
    check("rgb_png_128_square", True)
    alpha_raster = read_json(directory / "rgb-alpha.json")
    check("alpha_contract", alpha_raster.get("schema") == "timmy.native-view.alpha/1"
          and alpha_raster.get("sourceRevision") == revision and alpha_raster.get("cameraId") == camera.get("id")
          and alpha_raster.get("imageSize") == [128, 128] and alpha_raster.get("order") == "row-major")
    alpha_values = alpha_raster.get("values", [])
    check("alpha_values", len(alpha_values) == 16384 and all(finite(v) and 0 <= v <= 1 for v in alpha_values))
    check("png_has_alpha", channels == 4)
    silhouette = {"threshold": 0.5, "boundaryTolerancePixels": 1, "disagreements": 0, "interiorDisagreements": 0}
    if channels == 4 and len(alpha_values) == 16384:
        check("native_alpha_matches_png", all(finite(alpha_values[y * 128 + x])
              and abs(alpha_values[y * 128 + x] - rows[y][x * 4 + 3] / 255.0) <= 1e-6
              for y in range(128) for x in range(128)))
        mask = [value is not None for value in object_ids]
        for y in range(128):
            for x in range(128):
                expected_occupied = mask[y * 128 + x]
                if (rows[y][x * 4 + 3] / 255.0 >= 0.5) != expected_occupied:
                    silhouette["disagreements"] += 1
                    boundary = any(mask[ny * 128 + nx] != expected_occupied
                                   for ny in range(max(0, y - 1), min(128, y + 2))
                                   for nx in range(max(0, x - 1), min(128, x + 2)))
                    if not boundary:
                        silhouette["interiorDisagreements"] += 1
        check("full_silhouette_within_one_boundary_pixel", silhouette["interiorDisagreements"] == 0)
    origin = (0.0, 0.0, 200.0)
    for x, y in PIXELS:
        direction = ((x - 63.5) / 128, -(y - 63.5) / 128, -1.0)
        length = norm(direction)
        direction = tuple(v / length for v in direction)
        expected = nearest_hit(origin, direction, vertices, triangles)
        index = y * 128 + x
        actual = hits[index]
        prefix = "pixel_%d_%d_" % (x, y)
        hole = (x, y) == (64, 64)
        check(prefix + "expected_hit", (expected is None) == hole)
        sample = {"pixel": [x, y], "independent": expected, "native": actual, "cameraZMm": depths[index]}
        if expected is None:
            check(prefix + "empty", actual is None and depths[index] is None and object_ids[index] is None)
        elif actual is not None and isinstance(actual, dict):
            point = actual.get("pointWorldMm")
            valid_point = isinstance(point, list) and len(point) == 3 and all(finite(v) for v in point)
            point_error = norm(subtract(point, expected["pointWorldMm"])) if valid_point else None
            camera_z = 200.0 - expected["pointWorldMm"][2]
            check(prefix + "native_point", point_error is not None and point_error <= TOLERANCE_MM)
            check(prefix + "native_range", finite(actual.get("rayRangeMm")) and abs(actual["rayRangeMm"] - expected["rayRangeMm"]) <= TOLERANCE_MM)
            check(prefix + "camera_z", finite(depths[index]) and abs(depths[index] - camera_z) <= TOLERANCE_MM)
            check(prefix + "ray_is_not_z", abs(expected["rayRangeMm"] - camera_z) > TOLERANCE_MM)
            check(prefix + "object", actual.get("objectId") == "box-bore" and object_ids[index] == 0)
            sample.update({"pointErrorMm": point_error, "expectedCameraZMm": camera_z})
        else:
            check(prefix + "native_hit", False)
        if channels == 4:
            alpha = rows[y][x * channels + 3]
            check(prefix + "alpha", alpha == 0 if hole else alpha >= 250)
            sample["alpha"] = alpha
        samples.append(sample)
    failures = [name for name, passed in checks.items() if not passed]
    return {"schema": "timmy.native-view.independent-verification/1", "passed": not failures,
            "sourceSurfaceSha256": source_hash, "sourceRevision": revision, "checks": checks,
            "failures": failures, "samples": samples, "toleranceMm": TOLERANCE_MM,
            "depthDefinition": "Camera-axis Z in mm; ray range independently checked separately.",
            "scope": "Five sampled rays against original generated mesh; not physical measurement or a full raster correctness proof.",
            "alphaSilhouetteSampled": channels == 4, "silhouette": silhouette}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--view", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = verify(args.source, args.view)
    except Exception as error:
        report = {"schema": "timmy.native-view.independent-verification/1", "passed": False,
                  "failures": ["invalid_input_or_verifier_error"], "error": str(error)}
    print(json.dumps(report, indent=2, allow_nan=False))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    sys.exit(main())
