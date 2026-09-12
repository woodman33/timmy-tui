"""Source-binding refusals and native-format export/readback; no model calls."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("export_context_evidence", Path(__file__).with_name("export_context_evidence.py"))
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class ContextExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="timmy-context-export-test-")
        self.root = Path(self.temp.name)
        self.manifest_path = self.root / "manifest.json"
        self.context_path = self.root / "context.json"
        self.ablation_path = self.root / "ablation.json"
        self.grid = {"frameId": "fixture", "units": "mm", "origin": [0, 0, 0], "basis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "dimensions": [2, 2, 2], "cellSize": [1, 1, 1]}
        artifacts = {}
        for key, name, value in [
            ("cells", "cells.json", {"schema": "timmy.spatial-volume.cells/1", "order": "x-fastest", "fractions": [0, 0, .5, .5, 1, 1, 1, None]}),
            ("mesh", "surface.json", {"schema": "timmy.spatial-volume.mesh/1", "units": "mm", "positions": [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2], "triangles": [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]}),
        ]:
            data = self.write(name, value)
            artifacts[key] = {"path": name, "sha256": exporter.sha(data), "bytes": len(data)}
        self.manifest = {"schema": "timmy.spatial-volume/1", "id": "test-fixture", "grid": self.grid, "fill": {"status": "sampled"}, "material": {"status": "unknown"}, "density": {"status": "unknown"}, "artifacts": artifacts}
        source_hash = exporter.sha(self.write("manifest.json", self.manifest))
        self.context = {"schema": "timmy.spatial-model-context/1", "source": {"kind": "volume", "id": "test-fixture", "sha256": source_hash}, "frame": {"id": "fixture", **{k: v for k, v in self.grid.items() if k != "frameId"}}, "entities": [{"id": "volume", "kind": "volume"}, {"id": "cell-center", "kind": "voxel", "ijk": [1, 1, 1]}], "facts": [], "limitations": ["Synthetic fixture; physical properties unknown."]}
        for identity, value in [
            ("cell-center.location", [1.5, 1.5, 1.5]), ("cell-center.fill", None), ("volume.total-cells", 8), ("volume.location-count", 8),
            ("volume.fill-coverage", {"unknown": 1, "sampled": 7, "declared": 0, "empty": 2, "partial": 2, "full": 3}),
            ("volume.material", None), ("volume.density", None), ("cell-center.material", None), ("cell-center.density", None),
        ]:
            entity, key = identity.split(".", 1)
            self.context["facts"].append({"id": identity, "entityId": entity, "key": key, "value": value, "epistemic": "unknown" if value is None else "computed", "source": {"sha256": source_hash, "artifact": "test-fixture", "method": "fixture"}})
        self.write("context.json", self.context)
        self.ablation = {"schema": "timmy.spatial-context-ablation/1", "sourceSha256": source_hash, "contextSha256": exporter.sha(self.context_path.read_bytes()), "rows": [{"model": "test-local", "condition": "pack", "answer": {"material": None}, "score": {"unknownPreserved": True}}, {"model": "test-local", "condition": "no-pack", "answer": {"material": "mistaken metal"}, "score": {"unknownPreserved": False}}]}
        self.write("ablation.json", self.ablation)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, obj):
        data = (json.dumps(obj, allow_nan=False) + "\n").encode()
        (self.root / name).write_bytes(data)
        return data

    def load(self):
        return exporter.load_inputs(self.manifest_path, self.context_path, self.ablation_path)

    def test_rejects_stale_context_and_changed_geometry(self):
        self.context["source"]["sha256"] = "0" * 64
        self.write("context.json", self.context)
        with self.assertRaisesRegex(ValueError, "Context is not bound"):
            self.load()
        self.context["source"]["sha256"] = exporter.sha(self.manifest_path.read_bytes())
        self.write("context.json", self.context)
        (self.root / "surface.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "Artifact hash"):
            self.load()

    def test_rejects_unbound_ablation(self):
        self.ablation["contextSha256"] = "1" * 64
        self.write("ablation.json", self.ablation)
        with self.assertRaisesRegex(ValueError, "Ablation is not bound"):
            self.load()

    def test_rechecks_geometry_and_unknown_semantics(self):
        original = copy.deepcopy(self.context)
        for identity, value in [("cell-center.location", [7, 7, 7]), ("cell-center.fill", .8), ("volume.total-cells", 999), ("volume.density", 7800)]:
            with self.subTest(identity=identity):
                self.context = copy.deepcopy(original)
                next(f for f in self.context["facts"] if f["id"] == identity)["value"] = value
                self.write("context.json", self.context)
                with self.assertRaises(ValueError):
                    self.load()

    def test_exports_real_files_and_preserves_failed_model_answers(self):
        report = exporter.export(self.manifest_path, self.context_path, self.ablation_path, self.root / "exports")
        self.assertEqual(report["geometry"]["gridLocations"], 8)
        self.assertEqual(report["geometry"]["vertices"], 4)
        self.assertEqual(report["rerun"]["exitCode"], 0)
        self.assertEqual(report["viser"]["annotationRows"], 2)
        self.assertTrue(report["viser"]["temporaryServerStopped"])
        for name in ["context.rrd", "context.viser"]:
            data = (self.root / "exports" / name).read_bytes()
            self.assertGreater(len(data), 100)
            self.assertEqual(report["files"][name]["sha256"], exporter.sha(data))
        metadata, _ = exporter.decode_viser((self.root / "exports/context.viser").read_bytes())
        message_text = json.dumps(metadata, default=str)
        self.assertIn("mistaken metal", message_text)
        self.assertIn("unknownPreserved", message_text)
        self.assertFalse(report["scope"]["semanticCorrectnessChecked"])
        with self.assertRaises(FileExistsError):
            exporter.export(self.manifest_path, self.context_path, self.ablation_path, self.root / "exports")


if __name__ == "__main__":
    unittest.main()
