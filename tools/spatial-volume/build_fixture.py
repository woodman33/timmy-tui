#!/usr/bin/env python3
"""Construct an explicitly analytic fixture and retain OpenVDB roundtrip evidence."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import platform
import sys
import numpy as np
import openvdb as vdb

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / 'studio/spatial-volume-20260912'
DOMAIN_MIN = -50.0
DOMAIN_MAX = 50.0
HALF_SIDE = 40.0
BORE_RADIUS = 12.0
SUPPORTED_RESOLUTIONS = (10, 40)


def finite_array(values, label):
    array = np.asarray(values)
    if not np.all(np.isfinite(array)):
        raise ValueError(f'{label} contains a nonfinite value')
    return array


def write_json(path, value):
    path.write_text(json.dumps(value, allow_nan=False, separators=(',', ':')) + '\n')


def artifact(path):
    blob = path.read_bytes()
    return {'path': path.name, 'sha256': hashlib.sha256(blob).hexdigest(), 'bytes': len(blob)}


def field_at(x, y, z):
    """Correct CSG sign/zero set; max is not generally exact Euclidean distance."""
    qx, qy, qz = np.abs(x)-HALF_SIDE, np.abs(y)-HALF_SIDE, np.abs(z)-HALF_SIDE
    outside = np.sqrt(np.maximum(qx, 0)**2 + np.maximum(qy, 0)**2 + np.maximum(qz, 0)**2)
    box = outside + np.minimum(np.maximum(np.maximum(qx, qy), qz), 0)
    return np.maximum(box, BORE_RADIUS - np.sqrt(x*x+y*y))


def arrays_for(n, samples):
    if type(n) is not int or n not in SUPPORTED_RESOLUTIONS:
        raise ValueError('this bounded fixture supports resolutions 10 and 40 only')
    if not isinstance(samples, int) or samples < 1 or samples > 16:
        raise ValueError('samples must be an integer in [1,16]')
    size = (DOMAIN_MAX-DOMAIN_MIN)/n
    centers = DOMAIN_MIN + (np.arange(n)+0.5)*size
    x, y, z = np.meshgrid(centers, centers, centers, indexing='ij')
    boundary = finite_array(field_at(x, y, z).astype(np.float32), 'boundary')
    # Analytic fixture is separable in XY and Z. These are exactly the same
    # midpoint samples as an 8^3 regular grid per cell, without a 32M-point array.
    offsets = ((np.arange(samples)+0.5)/samples-0.5)*size
    xy_count = np.zeros((n, n), dtype=np.uint16)
    xx, yy = np.meshgrid(centers, centers, indexing='ij')
    for dx in offsets:
        for dy in offsets:
            sx, sy = xx+dx, yy+dy
            xy_count += ((np.abs(sx) <= HALF_SIDE) & (np.abs(sy) <= HALF_SIDE) & (sx*sx+sy*sy >= BORE_RADIUS**2))
    z_count = np.sum(np.abs(centers[:, None]+offsets) <= HALF_SIDE, axis=1)
    fractions = (xy_count[:, :, None]*z_count[None, None, :]/samples**3).astype(np.float32)
    return finite_array(fractions, 'fractions'), boundary, size


def transform_for(size):
    transform = vdb.createLinearTransform(voxelSize=float(size))
    transform.postTranslate((DOMAIN_MIN+size/2,)*3)
    return transform


def grids_for(fractions, boundary, size):
    finite_array(fractions, 'fractions')
    finite_array(boundary, 'boundary')
    if fractions.shape != boundary.shape or fractions.ndim != 3 or min(fractions.shape) < 1:
        raise ValueError('fractions and boundary must have the same nonempty 3D shape')
    if np.any((fractions < 0) | (fractions > 1)):
        raise ValueError('fill fractions must be in [0,1]')
    if not math.isfinite(size) or size <= 0:
        raise ValueError('voxel size must be finite and positive')
    transform = transform_for(size)
    fill = vdb.FloatGrid(background=0.0)
    fill.copyFromArray(fractions)
    field = vdb.FloatGrid(background=10000.0)
    field.copyFromArray(boundary)
    known = vdb.BoolGrid(background=False)
    known.fill((0, 0, 0), tuple(int(s-1) for s in fractions.shape), True, active=True)
    material = vdb.BoolGrid(background=False)
    density = vdb.BoolGrid(background=False)
    grids = {'fill_fraction': fill, 'boundary_field_mm': field, 'fill_known': known,
             'material_known': material, 'density_known': density}
    for name, grid in grids.items():
        grid.name = name
        grid.transform = transform.deepCopy()
        grid['frame_id'] = 'fixture'
        grid['units'] = 'mm'
        grid['evidence_basis'] = 'analytic constructed fixture; not physical measurement'
        grid['unknown_rule'] = 'outside fill_known domain is unknown; numeric background is not evidence'
        grid['domain_min_mm'] = (DOMAIN_MIN,)*3
        grid['domain_max_mm'] = (DOMAIN_MAX,)*3
    field['representation'] = 'csg implicit field; not reinitialized exact signed distance'
    return grids


def read_roundtrip(path, original, shape):
    loaded, metadata = vdb.readAll(str(path))
    by_name = {grid.name:grid for grid in loaded}
    if set(by_name) != set(original):
        raise ValueError('OpenVDB roundtrip grid names changed')
    checks = []
    for name, before in original.items():
        after = by_name[name]
        dtype = bool if name.endswith('_known') else np.float32
        first, second = np.zeros(shape, dtype=dtype), np.zeros(shape, dtype=dtype)
        before.copyToArray(first)
        after.copyToArray(second)
        if not np.array_equal(first, second):
            raise ValueError(f'{name} voxel values did not roundtrip')
        if before.background != after.background:
            raise ValueError(f'{name} background changed')
        points = [(0,0,0), (1,0,0), (0,1,0), (0,0,1), tuple(s-1 for s in shape), (-1,0,0)]
        for point in points:
            if not np.allclose(before.transform.indexToWorld(point), after.transform.indexToWorld(point), atol=1e-12, rtol=0):
                raise ValueError(f'{name} transform changed')
        if any(after.metadata.get(key) != value for key,value in before.metadata.items()):
            raise ValueError(f'{name} metadata changed')
        checks.append({'grid':name, 'allDomainValuesEqual':True, 'transformEqual':True,
                       'backgroundEqual':True, 'sourceMetadataPreserved':True, 'background':after.background,
                       'activeVoxelCount':int(after.activeVoxelCount())})
    # Deliberately verify identical numerical zero with different epistemic state.
    empty = (0,0,0)
    unknown = (-1,0,0)
    fa, ka = by_name['fill_fraction'].getConstAccessor(), by_name['fill_known'].getConstAccessor()
    if fa.getValue(empty) != 0 or fa.getValue(unknown) != 0 or not ka.getValue(empty) or ka.getValue(unknown):
        raise ValueError('known empty / unknown outside distinction was lost')
    return by_name, {'status':'passed', 'grids':checks, 'knownEmptyVsUnknownPreserved':True,
                      'checkedDomainCellsPerGrid':int(np.prod(shape)), 'fileMetadata':metadata,
                      'transformProbes':points, 'transformAbsoluteToleranceMm':1e-12,
                      'transformRelativeTolerance':0}


def boundary_distance(points):
    """Independent Euclidean distance to exposed box faces and finite bore wall."""
    p = np.asarray(points, dtype=np.float64)
    x, y, z = p.T
    r = np.hypot(x, y)
    cylinder = np.sqrt((r-BORE_RADIUS)**2 + np.maximum(np.abs(z)-HALF_SIDE,0)**2)
    # Four rectangle side faces are fully exposed because bore radius < half-side.
    side_x = np.sqrt((np.abs(x)-HALF_SIDE)**2 + np.maximum(np.abs(y)-HALF_SIDE,0)**2 + np.maximum(np.abs(z)-HALF_SIDE,0)**2)
    side_y = np.sqrt((np.abs(y)-HALF_SIDE)**2 + np.maximum(np.abs(x)-HALF_SIDE,0)**2 + np.maximum(np.abs(z)-HALF_SIDE,0)**2)
    cx, cy = np.clip(x,-HALF_SIDE,HALF_SIDE), np.clip(y,-HALF_SIDE,HALF_SIDE)
    cr = np.hypot(cx,cy)
    inner = cr < BORE_RADIUS
    scale = np.divide(BORE_RADIUS, cr, out=np.zeros_like(cr), where=cr > 0)
    cx = np.where(inner, np.where(cr > 0, cx*scale, BORE_RADIUS), cx)
    cy = np.where(inner, np.where(cr > 0, cy*scale, 0), cy)
    cap = np.sqrt((x-cx)**2 + (y-cy)**2 + (np.abs(z)-HALF_SIDE)**2)
    return finite_array(np.minimum(np.minimum(cylinder, cap), np.minimum(side_x,side_y)), 'surface errors')


def mesh_metrics(points, triangles):
    p = finite_array(points.astype(np.float64), 'mesh points')
    tri = triangles.astype(np.int64)
    if len(p) == 0 or len(tri) == 0:
        raise ValueError('empty mesh')
    edge_counts = Counter()
    directed_counts = Counter()
    vertex_links = defaultdict(Counter)
    parent = list(range(len(p)))
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for a,b,c in tri:
        for vertex,u,w in [(a,b,c),(b,c,a),(c,a,b)]:
            vertex_links[int(vertex)][tuple(sorted((int(u),int(w))))] += 1
        for u,w in [(a,b),(b,c),(c,a)]:
            edge_counts[tuple(sorted((int(u),int(w))))] += 1
            directed_counts[(int(u),int(w))] += 1
            parent[find(int(u))] = find(int(w))
    used = set(int(x) for x in tri.flatten())
    components = len({find(a) for a in used})
    closed = all(count == 2 for count in edge_counts.values())
    oriented = closed and all(directed_counts[(a,b)] == 1 and directed_counts[(b,a)] == 1 for a,b in edge_counts)
    def single_cycle(link):
        # Edge-manifold checks alone permit two closed shells pinched at a
        # shared vertex. A surface vertex must have one connected cycle as its
        # link, not two disjoint cycles or repeated edges.
        adjacency = defaultdict(set)
        for (a,b),count in link.items():
            if a == b or count != 1:
                return False
            adjacency[a].add(b)
            adjacency[b].add(a)
        if len(adjacency) < 3 or any(len(neighbors) != 2 for neighbors in adjacency.values()):
            return False
        visited = set()
        pending = [next(iter(adjacency))]
        while pending:
            vertex = pending.pop()
            if vertex not in visited:
                visited.add(vertex)
                pending.extend(adjacency[vertex]-visited)
        return len(visited) == len(adjacency)
    invalid_links = sum(not single_cycle(vertex_links[vertex]) for vertex in used)
    vertex_manifold = invalid_links == 0
    euler = len(used)-len(edge_counts)+len(tri)
    genus_numerator = 2-euler
    genus = genus_numerator//2 if (closed and oriented and vertex_manifold and components == 1
                                  and genus_numerator >= 0 and genus_numerator % 2 == 0) else None
    volume = abs(float(np.einsum('ij,ij->i', p[tri[:,0]], np.cross(p[tri[:,1]],p[tri[:,2]])).sum()/6))
    samples = np.concatenate((p,np.mean(p[tri],axis=1)))
    distances = boundary_distance(samples)
    return {'status':'measured-from-native-reconstruction', 'vertices':len(p), 'triangles':len(tri),
            'connectedComponents':components, 'closedTwoManifoldEdges':closed, 'consistentEdgeOrientation':oriented,
            'vertexLinksSingleCycles':vertex_manifold, 'invalidVertexLinks':invalid_links,
            'eulerCharacteristic':euler, 'genus':genus,
            'volumeMm3':volume, 'surfaceError':{'method':'independent analytic boundary distance at mesh vertices and triangle centroids',
            'sampleCount':len(samples), 'meanMm':float(distances.mean()), 'rmsMm':float(np.sqrt(np.mean(distances**2))),
            'maxSampleMm':float(distances.max()), 'hausdorffMeasured':False}}


def export_mesh(grid, output):
    points, tris, quads = grid.convertToPolygons(isovalue=0.0, adaptivity=0.0)
    triangles = np.concatenate((tris, quads[:,[0,1,2]], quads[:,[0,2,3]])).astype(np.uint32)
    with (output/'surface.obj').open('w') as stream:
        stream.write('# OpenVDB reconstruction; mm; analytic constructed fixture\n')
        for x,y,z in points:
            stream.write(f'v {float(x):.9g} {float(y):.9g} {float(z):.9g}\n')
        for a,b,c in triangles:
            stream.write(f'f {int(a)+1} {int(b)+1} {int(c)+1}\n')
    write_json(output/'surface.json', {'schema':'timmy.spatial-volume.mesh/1','units':'mm',
                                     'positions':points.flatten().tolist(),'triangles':triangles.flatten().tolist()})
    return mesh_metrics(points, triangles)


def build(n, samples, output):
    output.mkdir(parents=True, exist_ok=True)
    fractions, boundary, size = arrays_for(n, samples)
    grids = grids_for(fractions,boundary,size)
    grids['fill_fraction']['samples_per_axis'] = samples
    vdb_path = output/'fixture.vdb'
    vdb.write(str(vdb_path), grids=list(grids.values()), metadata={'schema':'timmy.spatial-volume.native/1',
        'source':'analytic constructed fixture', 'physical_measurement':False})
    loaded, roundtrip = read_roundtrip(vdb_path,grids,fractions.shape)
    write_json(output/'roundtrip.json',roundtrip)
    cells_path = output/'cells.json'
    # OpenVDB/NumPy axes are XYZ. Fortran flatten makes X vary fastest.
    write_json(cells_path, {'schema':'timmy.spatial-volume.cells/1', 'order':'x-fastest',
               'fractions':fractions.flatten(order='F').tolist(), 'boundaryField':boundary.flatten(order='F').tolist(), 'overrides':[]})
    mesh = export_mesh(loaded['boundary_field_mm'],output)
    expected = (2*HALF_SIDE)**3 - math.pi*BORE_RADIUS**2*(2*HALF_SIDE)
    estimated = float(np.sum(fractions,dtype=np.float64)*size**3)
    mesh['volumeAbsErrorMm3'] = abs(mesh['volumeMm3']-expected)
    mesh['volumeRelError'] = abs(mesh['volumeMm3']-expected)/expected
    manifest = {'schema':'timmy.spatial-volume/1', 'id':f'analytic-box-bore-{n}',
      'grid':{'frameId':'fixture','units':'mm','origin':[DOMAIN_MIN]*3,
              'basis':[[1,0,0],[0,1,0],[0,0,1]],'dimensions':[n]*3,'cellSize':[size]*3},
      'fill':{'status':'sampled','method':'regular-subcell-centers','samplesPerAxis':samples},
      'material':{'status':'unknown'}, 'density':{'status':'unknown'},
      'boundary':{'representation':'csg-implicit','exactDistance':False,
                  'description':'max(box signed distance, radius minus XY distance): valid CSG sign and zero set; not an exact distance near all intersections'},
      'construction':{'source':'analytic','boxSideMm':2*HALF_SIDE,'boreRadiusMm':BORE_RADIUS,
                      'boreAxis':'Z','domainMinMm':[DOMAIN_MIN]*3,'domainMaxMm':[DOMAIN_MAX]*3,
                      'physicalMeasurement':False,'materialAssigned':False},
      'provenance':{'nativeLibrary':'OpenVDB','nativeVersion':'.'.join(map(str,vdb.LIBRARY_VERSION)),
                   'pythonVersion':platform.python_version(),'numpyVersion':np.__version__,
                   'producer':'tools/spatial-volume/build_fixture.py','basis':'analytic constructed fixture',
                   'authentication':'local SHA256 integrity only; unsigned; no production receipt'},
      'counts':{'knownFill':int(fractions.size),'unknownFill':0,'empty':int(np.count_nonzero(fractions==0)),
                'partial':int(np.count_nonzero((fractions>0)&(fractions<1))),'full':int(np.count_nonzero(fractions==1)),
                'knownMaterial':0,'knownDensity':0},
      'metrics':{'expectedVolumeMm3':expected,'expectedVolumeMethod':'80^3 - pi * 12^2 * 80',
                 'estimatedVolumeMm3':estimated,'volumeAbsErrorMm3':abs(estimated-expected),
                 'volumeRelError':abs(estimated-expected)/expected,'mesh':mesh,
                 'physicalValidation':{'status':'unmeasured'}},
      'artifacts':{'cells':artifact(cells_path),'native':artifact(vdb_path),'mesh':artifact(output/'surface.json'),
                   'obj':artifact(output/'surface.obj'),'roundtrip':artifact(output/'roundtrip.json')}}
    write_json(output/'manifest.json',manifest)
    # Detached digest avoids a self-referential manifest hash.
    (output/'manifest.sha256').write_text(artifact(output/'manifest.json')['sha256']+'  manifest.json\n')
    return {'resolution':n,'manifest':{'path':f'grid{n}/manifest.json', **{k:v for k,v in artifact(output/'manifest.json').items() if k!='path'}},
            'counts':manifest['counts'],'metrics':manifest['metrics']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,default=DEFAULT_OUT)
    parser.add_argument('--resolutions',type=int,nargs='+',choices=SUPPORTED_RESOLUTIONS,default=[10,40])
    parser.add_argument('--samples',type=int,default=8)
    args = parser.parse_args()
    records=[]
    for n in args.resolutions:
        record=build(n,args.samples,args.out/f'grid{n}')
        records.append(record)
        print(json.dumps(record,allow_nan=False),flush=True)
    write_json(args.out/'index.json',{'schema':'timmy.spatial-volume.index/1', 'fixtures':records})

if __name__ == '__main__':
    main()
