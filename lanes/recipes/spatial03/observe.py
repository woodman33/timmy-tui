"""Read retained STEP geometry; emit unsigned, artifact-bound feature observations."""
from pathlib import Path
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import cadquery as cq
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Cylinder
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib

parser=argparse.ArgumentParser()
parser.add_argument('--model',required=True)
parser.add_argument('--output',required=True)
args=parser.parse_args()
MODEL=Path(args.model)
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
manifest = json.loads((MODEL / 'manifest.json').read_text())
if sorted(v['width'] for v in manifest['variants']) != [100,140,180]: raise ValueError('Exact three-width coverage required')
observations = []
for variant in manifest['variants']:
    step = MODEL / variant['files']['step']['file']
    assert digest(step) == variant['files']['step']['sha256']
    shape = cq.importers.importStep(str(step)).val()
    features = []
    for face in shape.Faces():
        surface = BRepAdaptor_Surface(face.wrapped)
        if surface.GetType() != GeomAbs_Cylinder:
            continue
        cylinder = surface.Cylinder()
        if abs(cylinder.Radius() - 1.5) > 1e-6:
            continue
        location, direction = cylinder.Location(), cylinder.Axis().Direction()
        x, y = location.X(), location.Y()
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(face.wrapped, box, False, False)
        bounds = cq.BoundBox(box)
        feature_id = ('A' if x < 0 else 'B') if y > 0 else ('C' if x < 0 else 'D')
        full_cylinder = abs(face.Area() - 2 * math.pi * cylinder.Radius() * bounds.zlen) < 1e-5
        checks = {
            'radius': abs(cylinder.Radius() - 1.5) <= 1e-6,
            'axisParallelZ': abs(abs(direction.Z()) - 1) <= 1e-6,
            'xEdgeOffset': abs(variant['width'] / 2 - abs(x) - 10) <= 1e-6,
            'yEdgeOffset': abs(variant['depth'] / 2 - abs(y) - 10) <= 1e-6,
            'zSpan': abs(bounds.zmin) <= 1e-6 and abs(bounds.zmax - 11) <= 1e-6,
            'completeCylindricalFace': full_cylinder,
        }
        features.append({'id': feature_id, 'axisAtBase': [x, y, 0], 'radius': cylinder.Radius(),
                         'zSpan': [bounds.zmin, bounds.zmax], 'checks': checks})
    assert sorted(f['id'] for f in features) == ['A', 'B', 'C', 'D']
    assert all(all(f['checks'].values()) for f in features)
    observations.append({'variant': variant['id'], 'stepSha256': digest(step),
                         'stlSha256': variant['files']['stl']['sha256'],
                         'features': sorted(features, key=lambda f: f['id'])})
result = {'schema': 'timmy.spatial-study.feature-observations/1',
          'measuredAt': datetime.now(timezone.utc).isoformat(),
          'engine': f'CadQuery {cq.__version__} / OpenCascade', 'units': 'mm',
          'manifestSha256': digest(MODEL / 'manifest.json'),
          'observerSha256': digest(Path(__file__)), 'toleranceMm': 1e-6,
          'identityRule': 'Match radius 1.5 mm cylindrical faces by signed X/Y quadrant. Valid only for this recipe family; not general topology tracking.',
          'scope': 'Native STEP readback. Result must be bound by a Timmy result receipt; physical validation not performed.',
          'variants': observations}
Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'variants': len(observations), 'features': sum(len(v['features']) for v in observations),
                  'featureChecks': sum(len(f['checks']) for v in observations for f in v['features']), 'passed': True}))
