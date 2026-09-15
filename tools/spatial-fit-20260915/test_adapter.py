import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np

SCRIPT = Path(__file__).with_name("adapter.py")
spec = importlib.util.spec_from_file_location("camera_fit_adapter", SCRIPT)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def fixture():
    # Expected pixels are generated independently with elementary matrix algebra.
    angle = 0.19
    rotation = np.array([[np.cos(angle), 0, np.sin(angle)], [0, 1, 0],
                         [-np.sin(angle), 0, np.cos(angle)]])
    translation = np.array([0.2, -0.15, 6.0])
    training = [[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-0.7, 0.7)]
    validation = [[0.2, 0.3, 0.4], [-0.4, 0.1, 0.2], [0.3, -0.2, -0.4]]

    def pair(point, identity):
        camera = rotation @ point + translation
        return {"id": identity, "world": point,
                "pixel": [float(800*camera[0]/camera[2] + 640), float(810*camera[1]/camera[2] + 360)]}

    request = {"capability": "camera-fit", "operation": "fit", "object_id": "object-1",
               "source_revision": "a"*64, "frame_id": "world", "units": "m",
               "image_size": [1280, 720], "camera_matrix": [[800, 0, 640], [0, 810, 360], [0, 0, 1]],
               "distortion": [], "correspondences": [pair(p, f"fit-{i}") for i, p in enumerate(training)],
               "validation_correspondences": [pair(p, f"validation-{i}") for i, p in enumerate(validation)]}
    return request, rotation, translation


class CameraFitTests(unittest.TestCase):
    def test_known_pose_recovery_and_repeatability(self):
        request, rotation, translation = fixture()
        result = adapter.compute(request)
        np.testing.assert_allclose(result["world_to_camera"]["rotation"], rotation, atol=1e-9)
        np.testing.assert_allclose(result["world_to_camera"]["translation"], translation, atol=1e-9)
        np.testing.assert_allclose(result["camera_center_world"], -rotation.T @ translation, atol=1e-9)
        self.assertLess(result["validation_residuals"]["rmse"], 1e-8)
        self.assertEqual(result, adapter.compute(request))
        self.assertEqual(result["provenance"], "reconstructed")
        self.assertFalse(result["limits"]["geometry_truth"])
        self.assertFalse(result["limits"]["geometry_source_authenticated"])
        for field in ("image_size", "camera_matrix", "distortion"):
            self.assertEqual(result[field], request[field])

    def test_validation_pixels_do_not_influence_pose(self):
        request, _, _ = fixture()
        first = adapter.compute(request)
        changed = copy.deepcopy(request)
        changed["validation_correspondences"][0]["pixel"][0] += 20
        second = adapter.compute(changed)
        self.assertEqual(first["world_to_camera"], second["world_to_camera"])
        self.assertEqual(first["fit_residuals"], second["fit_residuals"])
        self.assertGreater(second["validation_residuals"]["rmse"], 10)
        self.assertTrue(second["ok"])  # Completion is not a fabricated accuracy gate.

    def test_probe(self):
        result = adapter.compute({"capability": "camera-fit", "operation": "probe"})
        self.assertEqual(result["versions"]["opencv"], adapter.cv2.__version__)
        self.assertEqual(result["model_calls"], 0)

    def test_unknown_fields_and_bad_required_fields(self):
        request, _, _ = fixture()
        cases = [{**request, "anything": True}, {**request, "units": "pixels"},
                 {**request, "source_revision": "unknown"}, {**request, "frame_id": ""}]
        for key in ("units", "source_revision"):
            missing = copy.deepcopy(request)
            del missing[key]
            cases.append(missing)
        for case in cases:
            with self.subTest(case=list(case)), self.assertRaises(adapter.Refusal):
                adapter.compute(case)

    def test_bad_counts(self):
        request, _, _ = fixture()
        for key, count in (("correspondences", 5), ("validation_correspondences", 2), ("correspondences", 65)):
            changed = copy.deepcopy(request)
            changed[key] = (changed[key]*66)[:count]
            with self.subTest(key=key, count=count), self.assertRaisesRegex(adapter.Refusal, "count"):
                adapter.compute(changed)

    def test_duplicate_id_and_world_refusals(self):
        request, _, _ = fixture()
        for field in ("id", "world"):
            changed = copy.deepcopy(request)
            changed["validation_correspondences"][0][field] = changed["correspondences"][0][field]
            with self.subTest(field=field), self.assertRaisesRegex(adapter.Refusal, "overlap"):
                adapter.compute(changed)
        changed = copy.deepcopy(request)
        changed["correspondences"][1] = changed["correspondences"][0]
        with self.assertRaisesRegex(adapter.Refusal, "duplicate"):
            adapter.compute(changed)

    def test_coplanar_and_degenerate_refusals(self):
        request, _, _ = fixture()
        for points in ([[i, i*i, 0] for i in range(8)], [[i, 0, 0] for i in range(8)]):
            changed = copy.deepcopy(request)
            for item, point in zip(changed["correspondences"], points):
                item["world"] = point
            with self.assertRaisesRegex(adapter.Refusal, "degenerate_or_coplanar"):
                adapter.compute(changed)

    def test_numeric_and_camera_constraints(self):
        request, _, _ = fixture()
        for mutate in (
            lambda r: r["correspondences"][0]["world"].__setitem__(0, float("nan")),
            lambda r: r["correspondences"][0]["world"].__setitem__(0, True),
            lambda r: r["camera_matrix"][0].__setitem__(1, 0.1),
            lambda r: r.__setitem__("distortion", [0, 0]),
            lambda r: r["correspondences"][0]["pixel"].__setitem__(0, -1),
        ):
            changed = copy.deepcopy(request)
            mutate(changed)
            with self.assertRaises(adapter.Refusal):
                adapter.compute(changed)

    def test_collapsed_image_correspondences_refused(self):
        request, _, _ = fixture()
        for item in request["correspondences"]:
            item["pixel"] = [640, 360]
        with self.assertRaisesRegex(adapter.Refusal, "degenerate_image_correspondences"):
            adapter.compute(request)

    def test_nonpositive_depth_refused(self):
        with self.assertRaisesRegex(adapter.Refusal, "nonpositive_camera_depth"):
            adapter.project(np.array([[0.0, 0, -1]]), np.eye(3), np.zeros(3), np.eye(3), np.zeros(5))
        request, _, _ = fixture()
        request["validation_correspondences"][0]["world"] = [0, 0, -10]
        with self.assertRaisesRegex(adapter.Refusal, "nonpositive_camera_depth"):
            adapter.compute(request)

    def test_input_parser_bound_and_duplicate_keys(self):
        for raw in (b" "*65537, b'{"operation":"fit","operation":"probe"}', b'{"x":NaN}'):
            with self.assertRaises(adapter.Refusal):
                adapter.parse_request(raw)

    def test_exclusive_artifact_and_refusal_preservation(self):
        request, _, _ = fixture()
        with tempfile.TemporaryDirectory() as temporary:
            output = str(Path(temporary).resolve() / "artifacts")
            bad = {**request, "output_dir": output, "units": "wrong"}
            first = adapter.run(bad)
            self.assertFalse(first["ok"])
            self.assertEqual(first["error"], "invalid_units")
            artifact = Path(first["artifacts"][0])
            before = artifact.read_bytes()
            second = adapter.run({**request, "output_dir": output})
            self.assertEqual(second["error"], "output_dir_not_fresh")
            self.assertEqual(before, artifact.read_bytes())

    def test_json_subprocess_roundtrip(self):
        request, _, _ = fixture()
        with tempfile.TemporaryDirectory() as temporary:
            request["output_dir"] = str(Path(temporary).resolve() / "artifacts")
            request["admission_receipt_hash"] = "sha256_" + "b"*64
            completed = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(request),
                                       text=True, capture_output=True, timeout=20)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            response = json.loads(completed.stdout)
            self.assertTrue(response["ok"])
            content = Path(response["artifacts"][0]).read_bytes()
            self.assertEqual(response["artifact_sha256"], hashlib.sha256(content).hexdigest())
            self.assertEqual(json.loads(content)["source_revision"], request["source_revision"])


if __name__ == "__main__":
    unittest.main()
