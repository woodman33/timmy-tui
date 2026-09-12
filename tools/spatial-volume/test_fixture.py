"""Native OpenVDB tests, run with the dedicated Python interpreter."""
import hashlib
import json
import math
from pathlib import Path
import tempfile
import unittest
import numpy as np
import openvdb as vdb
import build_fixture as fixture


class NativeVolumeTests(unittest.TestCase):
    def test_numeric_zero_does_not_mean_known_empty(self):
        fractions, field, size = fixture.arrays_for(10,8)
        grids = fixture.grids_for(fractions,field,size)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'state.vdb'
            vdb.write(str(path), grids=list(grids.values()))
            read, result = fixture.read_roundtrip(path,grids,fractions.shape)
        fill, known = read['fill_fraction'].getConstAccessor(), read['fill_known'].getConstAccessor()
        self.assertEqual(fill.getValue((0,0,0)), fill.getValue((-1,0,0)))
        self.assertTrue(known.getValue((0,0,0)))
        self.assertFalse(known.getValue((-1,0,0)))
        self.assertTrue(result['knownEmptyVsUnknownPreserved'])
        self.assertFalse(read['material_known'].getConstAccessor().getValue((5,5,5)))
        self.assertFalse(read['density_known'].getConstAccessor().getValue((5,5,5)))

    def test_asymmetric_values_and_center_transform_roundtrip(self):
        fill = np.zeros((4,3,2),dtype=np.float32)
        fill[1,2,0] = 0.25
        fill[3,0,1] = 0.75
        boundary = np.arange(24,dtype=np.float32).reshape((4,3,2))
        grids = fixture.grids_for(fill,boundary,2.5)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'asymmetric.vdb'
            vdb.write(str(path),grids=list(grids.values()))
            read, _ = fixture.read_roundtrip(path,grids,fill.shape)
        self.assertEqual(read['fill_fraction'].getConstAccessor().getValue((1,2,0)),0.25)
        self.assertEqual(read['fill_fraction'].getConstAccessor().getValue((3,0,1)),0.75)
        self.assertEqual(read['fill_fraction'].transform.indexToWorld((1,2,0)),(-46.25,-43.75,-48.75))
        self.assertEqual(read['fill_fraction'].transform.worldToIndex((-46.25,-43.75,-48.75)),(1,2,0))
        flat = fill.flatten(order='F').tolist()
        self.assertEqual(flat[1+4*(2+3*0)],0.25)
        self.assertEqual(flat[3+4*(0+3*1)],0.75)

    def test_nonfinite_values_and_invalid_fill_rejected_before_native_write(self):
        fill, boundary, size = fixture.arrays_for(10,8)
        for invalid in [math.nan,math.inf,-math.inf,-0.1,1.1]:
            changed=fill.copy()
            changed[0,0,0]=invalid
            with self.assertRaises(ValueError):
                fixture.grids_for(changed,boundary,size)
        for invalid in [math.nan,math.inf,-math.inf]:
            changed=boundary.copy()
            changed[0,0,0]=invalid
            with self.assertRaises(ValueError):
                fixture.grids_for(fill,changed,size)
        for size in [math.nan,math.inf,0,-1]:
            with self.assertRaises(ValueError):
                fixture.grids_for(fill,boundary,size)

    def test_fixture_rejects_unsupported_resolutions(self):
        for resolution in [2,9,11,128,True,10.0]:
            with self.assertRaisesRegex(ValueError,'supports resolutions 10 and 40 only'):
                fixture.arrays_for(resolution,8)

    def test_roundtrip_detects_yz_basis_swap(self):
        fill, boundary, size = fixture.arrays_for(10,8)
        before = fixture.grids_for(fill,boundary,size)
        changed = {name:grid.deepCopy() for name,grid in before.items()}
        # This matrix preserves the origin, diagonal and negative-X probes;
        # the independent Y and Z probes must detect its swapped basis.
        changed['fill_fraction'].transform = vdb.createLinearTransform(matrix=[
            [10,0,0,0],[0,0,10,0],[0,10,0,0],[-45,-45,-45,1]])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'swapped.vdb'
            vdb.write(str(path),grids=list(changed.values()))
            with self.assertRaisesRegex(ValueError,'transform changed'):
                fixture.read_roundtrip(path,before,fill.shape)

    def test_constructed_boundary_and_independent_distance(self):
        # Filled body, bore void, outer void, bore wall, outer wall.
        self.assertLess(fixture.field_at(30.,0.,0.),0)
        self.assertGreater(fixture.field_at(0.,0.,0.),0)
        self.assertGreater(fixture.field_at(45.,0.,0.),0)
        self.assertEqual(fixture.field_at(12.,0.,0.),0)
        self.assertEqual(fixture.field_at(40.,0.,0.),0)
        points=np.array([[12,0,0],[40,10,10],[20,0,40],[0,0,40],[0,0,0],[45,0,0]])
        np.testing.assert_allclose(fixture.boundary_distance(points),[0,0,0,12,12,5],atol=1e-12)

    def test_samples_deterministic_and_refinement_reduces_fixture_volume_error(self):
        first = fixture.arrays_for(10,8)[0]
        second = fixture.arrays_for(10,8)[0]
        np.testing.assert_array_equal(first,second)
        expected=80**3-math.pi*12**2*80
        coarse_error=abs(float(first.sum(dtype=np.float64))*10**3-expected)
        fine = fixture.arrays_for(40,8)[0]
        fine_error=abs(float(fine.sum(dtype=np.float64))*2.5**3-expected)
        self.assertLess(fine_error,coarse_error)
        self.assertEqual(first.size,1000)
        self.assertEqual(fine.size,64000)

    def test_mesh_reconstruction_and_artifact_integrity(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            result=fixture.build(10,8,out)
            manifest=json.loads((out/'manifest.json').read_text())
            for item in manifest['artifacts'].values():
                blob=(out/item['path']).read_bytes()
                self.assertEqual(len(blob),item['bytes'])
                self.assertEqual(hashlib.sha256(blob).hexdigest(),item['sha256'])
            mesh=result['metrics']['mesh']
            self.assertTrue(mesh['closedTwoManifoldEdges'])
            self.assertTrue(mesh['consistentEdgeOrientation'])
            self.assertTrue(mesh['vertexLinksSingleCycles'])
            self.assertEqual(mesh['connectedComponents'],1)
            self.assertEqual(mesh['genus'],1)
            self.assertFalse(mesh['surfaceError']['hausdorffMeasured'])
            self.assertEqual(manifest['material'],{'status':'unknown'})
            self.assertEqual(manifest['density'],{'status':'unknown'})
            self.assertFalse(manifest['construction']['physicalMeasurement'])
            self.assertEqual(manifest['metrics']['physicalValidation'],{'status':'unmeasured'})
            cells=json.loads((out/'cells.json').read_text())
            self.assertEqual(len(cells['fractions']),1000)
            self.assertEqual(cells['order'],'x-fastest')

    def test_pinched_closed_shells_do_not_receive_a_genus(self):
        # Each tetrahedron is closed and oriented. Sharing only vertex 0 makes
        # a connected edge-manifold complex whose vertex link has two cycles.
        points=np.array([[0,0,0],[1,0,0],[0,1,0],[0,0,1],
                         [-1,0,0],[0,-1,0],[0,0,-1]],dtype=np.float64)
        one=np.array([[0,2,1],[0,1,3],[1,2,3],[2,0,3]],dtype=np.int64)
        mapping=np.array([0,4,5,6])
        triangles=np.concatenate((one,mapping[one]))
        result=fixture.mesh_metrics(points,triangles)
        self.assertEqual(result['connectedComponents'],1)
        self.assertTrue(result['closedTwoManifoldEdges'])
        self.assertTrue(result['consistentEdgeOrientation'])
        self.assertEqual(result['eulerCharacteristic'],3)
        self.assertFalse(result['vertexLinksSingleCycles'])
        self.assertEqual(result['invalidVertexLinks'],1)
        self.assertIsNone(result['genus'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
