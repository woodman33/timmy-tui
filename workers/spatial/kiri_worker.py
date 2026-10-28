"""Timmy's KIRI 3DGS job worker: run ONLY inside Blender (5.1/5.2), started by Timmy's durable job.

    Blender -b --factory-startup --disable-autoexec -noaudio -t 1 --python-exit-code 11 \
        --python workers/spatial/kiri_worker.py -- REQUEST.json

Derived from the spatial-tools package's `kiri/worker.py` (2026-10-27) with one defect fixed: its `stage(name, **data)`
collided with the `name` that `inspect()` returns, so the first native run failed right after a successful KIRI import
(TypeError: stage() got multiple values for argument 'name'; that raw failure is kept with the run). The addon itself is
loaded from the package's extracted, hash-verified release: TIMMY_KIRI_ADDON names its directory (versions/5.1.0).

Operations:
  inspect              load the exact extracted addon and call its register()
  import-crop-export   KIRI's own Gaussian PLY importer → optional local-coordinate AABB crop (BMesh) → native .blend
                       save and reopen → raw Gaussian PLY export (bpy.ops.wm.ply_export, attributes kept, no
                       modifiers, no transforms) → KIRI reimport. After the crop, the reopen and the reimport, the
                       coordinates and every Gaussian field (f_dc_*, opacity, scale_*, rot_*) are compared with the
                       expected values at rtol 1e-5 / atol 1e-6, row order preserved. A mismatch fails the job.

Progress: one JSON object per line on stdout ({"event": <stage>, ...}); result.json in the output directory holds every
stage, the status and (on success) the artifacts. The bounded route never claims KIRI's full export (transforms,
animation, appearance, relighting, rendering): it uses the raw exporter. A Gaussian splat is an appearance
reconstruction: not measured geometry, a watertight mesh or verified CAD.
"""
import importlib.util
import json
import math
import os
import sys
import traceback
from pathlib import Path

import bmesh
import bpy
import numpy as np

REQ = json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_text())
OUT = Path(REQ['output_dir']).resolve()
ADDON = Path(os.environ.get('TIMMY_KIRI_ADDON', '')).resolve() if os.environ.get('TIMMY_KIRI_ADDON') else None
RESULT = {'schema': 'timmy.kiri.result.v1', 'fixture': bool(REQ.get('fixture', False)), 'operation': REQ.get('operation'), 'status': 'running', 'stages': [],
          'blender': bpy.app.version_string, 'python': sys.version.split()[0], 'addon_version': None}
REQUIRED = ['f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
RTOL, ATOL = 1e-5, 1e-6


def stage(stage_name, **data):
    RESULT['stages'].append({'stage': stage_name, **data})
    (OUT / 'result.json').write_text(json.dumps(RESULT, indent=2))
    print(json.dumps({'event': stage_name, **data}), flush=True)


def inspect(obj):
    attrs = {a.name: {'type': a.data_type, 'domain': a.domain, 'length': len(a.data)} for a in obj.data.attributes}
    missing = [k for k in REQUIRED if k not in attrs]
    if missing:
        raise ValueError(f'Missing Gaussian fields: {missing}')
    for key in REQUIRED:
        if attrs[key]['domain'] != 'POINT' or attrs[key]['type'] != 'FLOAT':
            raise ValueError(f'Invalid Gaussian field {key}: {attrs[key]}')
        if not all(math.isfinite(v.value) for v in obj.data.attributes[key].data):
            raise ValueError(f'Non-finite Gaussian field {key}')
    return {'object': obj.name, 'vertices': len(obj.data.vertices), 'fields': {k: attrs[k] for k in REQUIRED},
            'kiri_type': obj.get('3DGS_Mesh_Type'), 'modifiers': [m.name for m in obj.modifiers]}


def gaussian_values(obj):
    count = len(obj.data.vertices)
    coordinates = np.empty(count * 3, dtype=np.float32)
    obj.data.vertices.foreach_get('co', coordinates)
    fields = {'coordinates': coordinates.reshape(count, 3)}
    for key in REQUIRED:
        data = np.empty(count, dtype=np.float32)
        obj.data.attributes[key].data.foreach_get('value', data)
        fields[key] = data
    return fields


def verify_values(expected, observed, stage_name):
    worst = {}
    for key in expected:
        a, b = expected[key], observed[key]
        if a.shape != b.shape or not np.allclose(a, b, rtol=RTOL, atol=ATOL, equal_nan=False):
            raise ValueError(f'{stage_name}: Gaussian field changed: {key}; expected shape {a.shape}, observed {b.shape}')
        worst[key] = float(np.max(np.abs(a - b))) if a.size else 0.0
    stage(stage_name, fields=list(expected), rows=int(next(iter(expected.values())).shape[0]), rtol=RTOL, atol=ATOL,
          row_order='preserved', max_abs_difference=worst)


def summary(values):
    """What the values were (for the record): per field min/max, and the coordinates' bounds."""
    c = values['coordinates']
    out = {'rows': int(c.shape[0]), 'bounds': [c.min(axis=0).tolist(), c.max(axis=0).tolist()] if c.size else None}
    out['ranges'] = {k: [float(v.min()), float(v.max())] for k, v in values.items() if k != 'coordinates' and v.size}
    return out


try:
    if ADDON is None or not (ADDON / '__init__.py').is_file():
        raise RuntimeError('TIMMY_KIRI_ADDON does not name the extracted KIRI 5.1.0 addon directory')
    spec = importlib.util.spec_from_file_location('dgs_render_by_kiri_engine', ADDON / '__init__.py', submodule_search_locations=[str(ADDON)])
    addon = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = addon
    spec.loader.exec_module(addon)
    addon.register()
    RESULT['addon_version'] = '.'.join(str(x) for x in addon.bl_info.get('version', ()))
    stage('registered', addon=addon.bl_info.get('name'), version=RESULT['addon_version'], import_operator='sna.dgs_render_import_ply_e0a3a')
    if REQ['operation'] == 'inspect':
        RESULT['status'] = 'success'
    elif REQ['operation'] == 'import-crop-export':
        src = Path(REQ['input_ply']).resolve(strict=True)
        if src.suffix.lower() != '.ply':
            raise ValueError('This route accepts Gaussian PLY only')
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        props = bpy.context.scene.sna_dgs_scene_properties
        props.import_face_vert = 'Verts'
        props.import_proxy = False
        props.import_uv = False
        status = bpy.ops.sna.dgs_render_import_ply_e0a3a(filepath=str(src))
        if status != {'FINISHED'}:
            raise RuntimeError(f'KIRI importer returned {status}')
        obj = bpy.context.view_layer.objects.active
        obj.name = 'Timmy_Gaussian_Edit'
        imported_values = gaussian_values(obj)
        stage('imported', **inspect(obj), values=summary(imported_values))
        expected_values = imported_values
        crop = REQ.get('crop_aabb')
        if crop is not None:
            lo, hi = crop
            if len(lo) != 3 or len(hi) != 3 or not all(math.isfinite(float(x)) for x in lo + hi) or not all(a <= b for a, b in zip(lo, hi)):
                raise ValueError('crop_aabb must be finite ordered [[xmin,ymin,zmin],[xmax,ymax,zmax]] in imported local coordinates')
            mask = np.all((imported_values['coordinates'] >= np.asarray(lo)) & (imported_values['coordinates'] <= np.asarray(hi)), axis=1)
            expected_values = {key: values[mask] for key, values in imported_values.items()}
            bm = bmesh.new()
            try:
                bm.from_mesh(obj.data)
                remove = [v for v in bm.verts if not all(lo[i] <= v.co[i] <= hi[i] for i in range(3))]
                bmesh.ops.delete(bm, geom=remove, context='VERTS')
                bm.to_mesh(obj.data)
                obj.data.update()
            finally:
                bm.free()
            if not len(obj.data.vertices):
                raise ValueError('Crop removed every Gaussian')
            stage('cropped', **inspect(obj), kept=int(mask.sum()), removed=int((~mask).sum()), crop_aabb=crop)
        verify_values(expected_values, gaussian_values(obj), 'crop_values_verified')
        for mod in obj.modifiers:  # keep the Gaussian attributes; bypass the viewport/render Geometry Nodes
            mod.show_viewport = False
            mod.show_render = False
        native = OUT / 'edited.blend'
        bpy.ops.wm.save_as_mainfile(filepath=str(native), compress=True)
        stage('native_saved', file='edited.blend')
        bpy.ops.wm.open_mainfile(filepath=str(native), load_ui=False)
        obj = bpy.data.objects['Timmy_Gaussian_Edit']
        after = inspect(obj)
        stage('native_reopened', **after)
        verify_values(expected_values, gaussian_values(obj), 'native_values_verified')
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        export = OUT / 'edited.ply'
        status = bpy.ops.wm.ply_export(filepath=str(export), export_selected_objects=True, export_attributes=True, apply_modifiers=False,
                                       ascii_format=True, forward_axis='Y', up_axis='Z')
        if status != {'FINISHED'}:
            raise RuntimeError(f'Native raw Gaussian export failed: {status}')
        stage('exported', file='edited.ply', export_route='bpy.ops.wm.ply_export, Gaussian attributes kept, no modifiers, no transforms')
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        status = bpy.ops.sna.dgs_render_import_ply_e0a3a(filepath=str(export))
        readback = inspect(bpy.context.view_layer.objects.active)
        if status != {'FINISHED'} or readback['vertices'] != after['vertices']:
            raise RuntimeError('Export reimport mismatch')
        stage('export_reimported', **readback)
        verify_values(expected_values, gaussian_values(bpy.context.view_layer.objects.active), 'export_values_verified')
        RESULT['status'] = 'success'
        RESULT['artifacts'] = ['edited.blend', 'edited.ply']
    else:
        raise ValueError('Unsupported operation')
except BaseException as exc:
    RESULT['status'] = 'failed'
    RESULT['error'] = repr(exc)
    RESULT['traceback'] = traceback.format_exc()
    raise
finally:
    (OUT / 'result.json').write_text(json.dumps(RESULT, indent=2))
